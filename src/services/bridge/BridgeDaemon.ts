import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { loadOrCreateTLS, TLSMaterial } from "./TLSCertificate.js";
import { WSSListener } from "./WSSListener.js";
import { Session } from "./Session.js";
import { MobileControlGateway, MobileControlGatewayError } from "./MobileControlGateway.js";
import {
  ClientMessage,
  MobileControlRequest,
  MobileControlResponse,
  PaneSnapshot,
  Project,
  Ritual,
  LEGACY_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  isSupportedProtocolVersion,
} from "./wireProtocol.js";
import { PaneStreamHub } from "./PaneStreamHub.js";
import { TokenStore, DeviceRecord } from "./TokenStore.js";
import { PairingFlow } from "./PairingFlow.js";
import { BridgeBonjour } from "./BridgeBonjour.js";
import { isTmuxPaneId } from "../../utils/tmuxTarget.js";
import { decodeBase64Payload } from "../../utils/base64.js";
import { LogService } from "../LogService.js";
import type { ReadonlyWorkspaceSnapshot } from "../../workspace/snapshot.js";
import { workspaceToLegacyReadModel } from "../../workspace/legacyAdapters.js";

export interface BridgeDaemonOptions {
  serverId?: string;
  serverName?: string;
  projectName?: string | null;
  paneProvider: () => PaneSnapshot[];
  projectProvider: () => Project[];
  /** Canonical source for legacy list requests when the host exposes it. */
  workspaceProvider?: () => ReadonlyWorkspaceSnapshot | Promise<ReadonlyWorkspaceSnapshot>;
  sessionName: string;  // required
  hubFactory?: (sessionName: string) => PaneStreamHub;  // for tests
  ritualProvider: (projectId: string | null) => Ritual[];
  launchRitual: (projectId: string, ritualId: string, params: Record<string, string>) => Promise<void>;
  tokenStore?: TokenStore;       // for tests; production creates a fresh one
  pairingFlow?: PairingFlow;     // for tests; same
}

export class BridgeDaemon {
  private listener?: WSSListener;
  private tls?: TLSMaterial;
  private hub?: PaneStreamHub;
  private bonjour?: BridgeBonjour;
  private paneSubscribers = new Map<string, Set<Session>>();
  private tokens: TokenStore;
  private pairing: PairingFlow;
  private ritualLauncher: ((projectId: string, ritualId: string, params: Record<string, string>) => Promise<void>) | null = null;
  private readonly mobileGateway?: MobileControlGateway;
  private workspaceSequence = 0;
  readonly serverId: string;
  readonly serverName: string;

  constructor(private opts: BridgeDaemonOptions) {
    this.serverId = opts.serverId ?? randomUUID();
    this.serverName = opts.serverName ?? hostname();
    this.tokens = opts.tokenStore ?? new TokenStore();
    this.pairing = opts.pairingFlow ?? new PairingFlow();
    this.mobileGateway = opts.workspaceProvider
      ? new MobileControlGateway({
        workspaceProvider: opts.workspaceProvider,
        workspaceSequence: () => this.workspaceSequence,
      })
      : undefined;
    this.pairing.on("open", (w: { code: string; expiresAt: Date }) => this.broadcastPairChallenge(w));
  }

  /**
   * Register (or clear) a live ritual launcher from the React UI. The
   * launcher is set after React mounts — after openRitual is available — and
   * cleared on unmount. While null the daemon falls back to the boot-time stub
   * supplied via BridgeDaemonOptions.launchRitual.
   */
  setRitualLauncher(fn: ((projectId: string, ritualId: string, params: Record<string, string>) => Promise<void>) | null): void {
    this.ritualLauncher = fn;
  }

  async start(): Promise<{ port: number; fingerprint: string }> {
    this.tls = await loadOrCreateTLS();
    this.hub = this.opts.hubFactory
      ? this.opts.hubFactory(this.opts.sessionName)
      : new PaneStreamHub(this.opts.sessionName);
    this.hub.start();
    this.listener = new WSSListener(this.tls, {
      onConnection: (s) => this.onConnect(s),
      onClientMessage: (s, m) => this.onMessage(s, m),
      onClose: (s) => {
        for (const teardown of s.subscriptionTeardowns.values()) teardown();
        for (const subs of this.paneSubscribers.values()) subs.delete(s);
      },
      // Transport errors are expected on a LAN listener (peers vanish, wifi
      // drops). They must be observed so they do not crash psyche, but they
      // are not actionable, so they go to the log rather than stdout — this
      // daemon runs inside the Ink TUI, where console output corrupts the
      // rendered frame.
      onServerError: (err) => {
        LogService.getInstance().warn(`bridge transport error: ${err.message}`, 'bridge');
      },
    });
    const { port } = await this.listener.start();
    try {
      this.bonjour = new BridgeBonjour();
      this.bonjour.publish({
        name: this.serverName,
        port,
        serverId: this.serverId,
      });
    } catch {
      // Bonjour publication is best-effort — networks may be offline,
      // mDNS may be blocked. iOS hostname-resolver path still works.
      this.bonjour = undefined;
    }
    return { port, fingerprint: this.tls.fingerprint };
  }

  async stop() {
    await this.bonjour?.stop().catch(() => {});
    this.hub?.stop();
    await this.listener?.stop();
  }

  // ---------------------------------------------------------------------------
  // Public methods for TUI commands
  // ---------------------------------------------------------------------------

  async openPairWindow(): Promise<{ code: string; expiresAt: Date }> {
    return this.pairing.open();
  }

  async listDevices(): Promise<DeviceRecord[]> {
    return this.tokens.list();
  }

  async revokeDevice(token: string): Promise<boolean> {
    const ok = await this.tokens.revoke(token);
    if (!ok) return false;
    // Close any live session that authenticated with this token
    if (this.listener) {
      for (const s of this.listener.activeSessions) {
        if (s.token === token) s.close("revoked by host");
      }
    }
    return true;
  }

  get pairingEvents(): PairingFlow {
    return this.pairing;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private broadcastPairChallenge(w: { code: string; expiresAt: Date }) {
    if (!this.listener) return;
    for (const s of this.listener.activeSessions) {
      if (s.state === "unauthenticated") {
        s.send({
          type: "pairChallenge",
          payload: { expiresAt: w.expiresAt.toISOString(), codeLength: w.code.length },
        });
      }
    }
  }

  private onConnect(s: Session) {
    this.sendWelcome(s, LEGACY_PROTOCOL_VERSION);
    // If a pair window is already open, send pairChallenge to the new session
    if (this.pairing.isOpen()) {
      const w = this.pairing.peek()!;
      s.send({
        type: "pairChallenge",
        payload: { expiresAt: w.expiresAt.toISOString(), codeLength: w.code.length },
      });
    }
  }

  private sendWelcome(s: Session, protocolVersion: typeof LEGACY_PROTOCOL_VERSION | typeof PROTOCOL_VERSION) {
    s.send({
      type: "welcome",
      payload: {
        serverId: this.serverId,
        serverName: this.serverName,
        protocolVersion,
        projectName: this.opts.projectName ?? null,
        supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
      },
    });
  }

  private async onMessage(s: Session, m: ClientMessage) {
    switch (m.type) {
      case "hello": {
        if (!isSupportedProtocolVersion(m.payload.protocolVersion)) {
          s.close(
            `protocol mismatch: client=${String(m.payload.protocolVersion)} supported=${SUPPORTED_PROTOCOL_VERSIONS.join(",")}`
          );
          return;
        }
        s.clientId = m.payload.clientId;
        s.clientName = m.payload.clientName;
        s.protocolVersion = m.payload.protocolVersion;
        if (m.payload.protocolVersion === PROTOCOL_VERSION) {
          this.sendWelcome(s, PROTOCOL_VERSION);
        }
        if (m.payload.token) {
          const rec = await this.tokens.validate(m.payload.token);
          if (rec) {
            s.state = "authenticated";
            s.token = m.payload.token;
            await this.tokens.touch(m.payload.token);
          } else {
            s.send({ type: "error", payload: { code: "invalid_token", message: "token not recognized" } });
            // session stays unauthenticated; caller may then run :pair on the Mac and retry
          }
        }
        // No token + no pair window keeps the session unauthenticated; only ping/pair remain available.
        return;
      }
      case "pair": {
        // The flow reports the outcome directly. Inferring it from isOpen()
        // before and after cannot separate "budget exhausted" from "already
        // expired" — both end closed — and would tell a user who merely idled
        // that someone is guessing at their code.
        const outcome = this.pairing.attempt(m.payload.code);
        if (outcome !== "accepted") {
          s.send({ type: "pairRejected", payload: { reason: outcome } });
          return;
        }
        const rec = await this.tokens.issue(m.payload.clientId, m.payload.clientName);
        s.state = "authenticated";
        s.token = rec.token;
        s.clientId = m.payload.clientId;
        s.clientName = m.payload.clientName;
        s.send({ type: "pairAccepted", payload: { token: rec.token } });
        return;
      }
      case "listPanes":
        if (!this.requireAuthenticated(s)) return;
        s.send({ type: "paneList", payload: (await this.readLegacyState()).panes });
        return;
      case "listProjects":
        if (!this.requireAuthenticated(s)) return;
        s.send({ type: "projectList", payload: (await this.readLegacyState()).projects });
        return;
      case "ping":
        s.send({ type: "pong", payload: { token: m.payload.token } });
        return;
      case "subscribePane": {
        if (s.state !== "authenticated") {
          s.send({ type: "error", payload: { code: "not_authenticated", message: "pair first" } });
          return;
        }
        // Subscribing allocates a replay buffer keyed by pane id, so an
        // unchecked id both grows the hub without bound and seeds a value
        // that later reaches tmux as command text.
        if (!isTmuxPaneId(m.payload.paneId)) {
          s.send({ type: "error", payload: { code: "invalid_pane", message: "paneId must be a tmux pane id such as %3" } });
          return;
        }
        this.subscribePane(s, m.payload.paneId, m.payload.sinceSeq ?? null);
        return;
      }
      case "unsubscribePane": {
        this.unsubscribePane(s, m.payload.paneId);
        return;
      }
      case "sendInput": {
        if (s.state !== "authenticated") return;
        // Pane ids reach tmux control mode as command text, so a malformed one
        // is a protocol error to report, never something to forward.
        if (!isTmuxPaneId(m.payload.paneId)) {
          s.send({ type: "error", payload: { code: "invalid_pane", message: "paneId must be a tmux pane id such as %3" } });
          return;
        }
        // Buffer.from(..., 'base64') never throws — it drops characters
        // outside the alphabet — so malformed input would otherwise be typed
        // into the user's terminal as silently mangled bytes.
        const bytes = decodeBase64Payload(m.payload.data);
        if (!bytes) {
          s.send({ type: "error", payload: { code: "invalid_input", message: "data must be a base64 string" } });
          return;
        }
        this.hub!.sendInput(m.payload.paneId, bytes);
        return;
      }
      case "listRituals": {
        if (s.state !== "authenticated") {
          s.send({ type: "error", payload: { code: "not_authenticated", message: "pair first" } });
          return;
        }
        const projectId = m.payload.projectId;
        const rituals = this.opts.ritualProvider(projectId);
        s.send({ type: "ritualList", payload: { projectId, rituals } });
        return;
      }
      case "launchRitual": {
        if (s.state !== "authenticated") {
          s.send({ type: "error", payload: { code: "not_authenticated", message: "pair first" } });
          return;
        }
        try {
          const launcher = this.ritualLauncher ?? this.opts.launchRitual;
          await launcher(m.payload.projectId, m.payload.ritualId, m.payload.params);
        } catch (err) {
          s.send({ type: "error", payload: { code: "ritual_failed", message: String(err) } });
          return;
        }
        try {
          await this.broadcastStateUpdates();
        } catch (err) {
          s.send({ type: "error", payload: { code: "state_update_failed", message: String(err) } });
        }
        return;
      }
      case "control":
        await this.handleControl(s, m.payload);
        return;
      default:
        return;
    }
  }

  private requireAuthenticated(s: Session): boolean {
    if (s.state === "authenticated") return true;
    s.send({ type: "error", payload: { code: "not_authenticated", message: "pair first" } });
    return false;
  }

  private async broadcastStateUpdates(): Promise<void> {
    if (!this.listener) return;
    let legacy: { panes: PaneSnapshot[]; projects: Project[] } | undefined;
    for (const session of this.listener.activeSessions) {
      if (session.state === "authenticated") {
        legacy ??= await this.readLegacyState();
        session.send({ type: "projectList", payload: legacy.projects });
        session.send({ type: "paneListChanged", payload: legacy.panes });
      }
    }
  }

  private async readLegacyState(): Promise<{ panes: PaneSnapshot[]; projects: Project[] }> {
    if (this.opts.workspaceProvider) {
      return workspaceToLegacyReadModel(await this.opts.workspaceProvider());
    }
    return {
      panes: this.opts.paneProvider(),
      projects: this.opts.projectProvider(),
    };
  }

  private async handleControl(
    s: Session,
    request: MobileControlRequest | { type: string; requestId?: unknown },
  ): Promise<void> {
    if (s.state !== "authenticated") {
      this.sendControl(s, this.controlError(
        this.safeRequestId(request),
        "not_authenticated",
        "pair first",
      ));
      return;
    }

    if (s.protocolVersion !== PROTOCOL_VERSION) {
      this.sendControl(s, this.controlError(
        this.safeRequestId(request),
        "protocol_mismatch",
        "control requires negotiated protocol v3",
      ));
      return;
    }

    if (!this.mobileGateway) {
      this.sendControl(s, this.controlError(
        this.safeRequestId(request),
        "control_unavailable",
        "workspace control is not available",
      ));
      return;
    }

    const queuedBinaryFrames: Array<{ streamId: string; sequence: number; payload: Uint8Array }> = [];
    try {
      const response = await this.mobileGateway.handle(request, {
        ownerId: s.clientId ?? s.token ?? this.serverId,
        connectionId: s.connectionId,
        sendBinary: (streamId, sequence, payload) => {
          queuedBinaryFrames.push({ streamId, sequence, payload });
        },
      });
      this.sendControl(s, response);
    } catch (error) {
      this.sendControl(s, this.controlErrorPayload(request, error));
    }

    for (const frame of queuedBinaryFrames) {
      s.sendBinary(frame.streamId, frame.sequence, frame.payload);
    }
  }

  private sendControl(s: Session, payload: MobileControlResponse): void {
    s.send({ type: "control", payload });
  }

  private controlErrorPayload(
    request: { requestId?: unknown },
    error: unknown,
  ): Extract<MobileControlResponse, { type: "error" }> {
    const requestId = this.controlErrorRequestId(request, error);
    const message = this.controlErrorMessage(error);
    const code = this.controlErrorCode(error);

    return this.controlError(requestId, code, message);
  }

  private controlError(
    requestId: string | undefined,
    code: string,
    message: string,
  ): Extract<MobileControlResponse, { type: "error" }> {
    return requestId
      ? { type: "error", requestId, code, message }
      : { type: "error", code, message };
  }

  private controlErrorCode(error: unknown): string {
    if (error instanceof MobileControlGatewayError) return error.code;
    return "internal_error";
  }

  private controlErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message;
    }
    return "control request failed";
  }

  private controlErrorRequestId(
    request: { requestId?: unknown },
    error: unknown,
  ): string | undefined {
    if (error instanceof MobileControlGatewayError && error.requestId) {
      return error.requestId;
    }
    return this.safeRequestId(request);
  }

  private safeRequestId(request: { requestId?: unknown }): string | undefined {
    return typeof request.requestId === "string" && request.requestId.trim().length > 0
      ? request.requestId
      : undefined;
  }

  private subscribePane(s: Session, paneId: string, sinceSeq: number | null) {
    const buffer = this.hub!.bufferFor(paneId);
    this.unsubscribePane(s, paneId);

    let subs = this.paneSubscribers.get(paneId);
    if (!subs) { subs = new Set(); this.paneSubscribers.set(paneId, subs); }
    subs.add(s);
    s.subscribedPaneIds.add(paneId);

    const off = buffer.subscribe((chunk) => {
      s.send({
        type: "paneOutput",
        payload: {
          paneId,
          data: chunk.data.toString("base64"),
          seq: chunk.seq,
        },
      });
    });
    s.subscriptionTeardowns.set(paneId, off);

    // Subscribe before replay so data written during handoff is not lost.
    const snap = buffer.snapshot(sinceSeq ?? undefined);
    if (snap.data.length > 0) {
      s.send({
        type: "paneOutput",
        payload: {
          paneId,
          data: snap.data.toString("base64"),
          seq: snap.latestSeq,
        },
      });
    }
  }

  private unsubscribePane(s: Session, paneId: string) {
    s.subscriptionTeardowns.get(paneId)?.();
    s.subscriptionTeardowns.delete(paneId);
    this.paneSubscribers.get(paneId)?.delete(s);
    s.subscribedPaneIds.delete(paneId);
  }
}
