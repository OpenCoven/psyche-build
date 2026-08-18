import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { hostname } from "node:os";
import { loadOrCreateTLS, TLSMaterial } from "./TLSCertificate.js";
import { WSSListener } from "./WSSListener.js";
import { Session } from "./Session.js";
import {
  MobileControlGateway,
  MobileControlGatewayError,
  type MobileAttachedStream,
  type MobileControlGatewayContext,
} from "./MobileControlGateway.js";
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
import { MobileInviteStore } from "./MobileInviteStore.js";
import { BridgeBonjour } from "./BridgeBonjour.js";
import { isTmuxPaneId } from "../../utils/tmuxTarget.js";
import type { PaneSpawnResult } from "../../daemon/protocol.js";
import type { MobilePaneSpawnRequest } from "./wireProtocol.js";
import type { ActionResult, PaneAction } from "../../actions/types.js";

/**
 * Two visible terminals is what the mobile workspace renders; the extra
 * headroom covers a reattach landing before the old stream is detached.
 */
const MAX_CONTROL_STREAMS_PER_CONNECTION = 4;

/** Pane mutations the TUI performs on the daemon's behalf. */
export interface MobilePaneExecutors {
  spawn: (request: MobilePaneSpawnRequest) => Promise<PaneSpawnResult>;
  kill: (paneId: string) => Promise<void>;
  updateMeta: (paneId: string, meta: { title?: string; agent?: string }) => Promise<void>;
  launchRitual: (
    projectId: string,
    ritualId: string,
    params: Record<string, string>,
  ) => Promise<void>;
}

export interface MobileActionExecutorInput {
  paneId: string;
  actionId: PaneAction;
}

export type MobileActionExecutor = (input: MobileActionExecutorInput) => Promise<ActionResult>;
import { decodeBase64Payload } from "../../utils/base64.js";
import { LogService } from "../LogService.js";
import {
  hasPublishedTmuxBackedPane,
  type ReadonlyWorkspaceSnapshot,
} from "../../workspace/snapshot.js";

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
  mobileInviteStore?: MobileInviteStore; // for tests; ephemeral only
  bonjourFactory?: () => Pick<BridgeBonjour, "publish" | "stop">;
}

export class BridgeDaemon {
  /** Emits `redeemed` after a mobile invite completes authentication. */
  readonly mobileInviteEvents = new EventEmitter();
  private listener?: WSSListener;
  private tls?: TLSMaterial;
  private hub?: PaneStreamHub;
  private mobilePaneExecutors?: MobilePaneExecutors;
  private mobileActionExecutor?: MobileActionExecutor;
  private bonjour?: Pick<BridgeBonjour, "publish" | "stop">;
  private paneSubscribers = new Map<string, Set<Session>>();
  private tokens: TokenStore;
  private pairing: PairingFlow;
  private mobileInvites: MobileInviteStore;
  private mobileInviteEndpoint?: string;
  private ritualLauncher: ((projectId: string, ritualId: string, params: Record<string, string>) => Promise<void>) | null = null;
  private readonly mobileGateway?: MobileControlGateway;
  private workspaceSequence = 0;
  private lastBroadcastWorkspaceRevision: number | undefined;
  private workspaceOperationQueue: Promise<void> = Promise.resolve();
  private workspaceBroadcastInFlight = false;
  private workspaceBroadcastPending = false;
  readonly serverId: string;
  readonly serverName: string;

  constructor(private opts: BridgeDaemonOptions) {
    this.serverId = opts.serverId ?? randomUUID();
    this.serverName = opts.serverName ?? hostname();
    this.tokens = opts.tokenStore ?? new TokenStore();
    this.pairing = opts.pairingFlow ?? new PairingFlow();
    this.mobileInvites = opts.mobileInviteStore ?? new MobileInviteStore();
    this.mobileGateway = opts.workspaceProvider
      ? new MobileControlGateway({
        workspaceSnapshot: () => this.readWorkspaceSnapshot(),
        attachPane: (context, paneId, sinceSeq) => this.attachPaneStream(context, paneId, sinceSeq),
        detachPane: (connectionId, streamId) => this.detachPaneStream(connectionId, streamId),
        sendPaneInput: (connectionId, streamId, data) =>
          this.sendPaneStreamInput(connectionId, streamId, data),
        resizePane: (connectionId, streamId, cols, rows) =>
          this.resizePaneStream(connectionId, streamId, cols, rows),
        spawnPane: (request) => this.requireMobileExecutors().spawn(request),
        killPane: (paneId) => this.requireMobileExecutors().kill(paneId),
        updatePaneMeta: (paneId, meta) => this.requireMobileExecutors().updateMeta(paneId, meta),
        launchRitual: (projectId, ritualId, params) =>
          this.requireMobileExecutors().launchRitual(projectId, ritualId, params),
        executeAction: (input) => this.requireActionExecutor()(input),
        // Only reached for a mutation that actually changed state, so a
        // replayed idempotent spawn does not announce a change twice.
        onWorkspaceChanged: () => this.notifyWorkspaceChanged(),
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

  /** Register the current React-owned action context without rebuilding the gateway. */
  setActionExecutor(executor: MobileActionExecutor | null): void {
    this.mobileActionExecutor = executor ?? undefined;
    if (!executor) this.mobileGateway?.clearActions();
  }

  /**
   * Notify mobile clients after host workspace state changes. This fire-and-
   * forget hook coalesces bursts to one in-flight scan and one pending rescan.
   * Provider failures are logged, and a pending rescan still runs afterward.
   */
  notifyWorkspaceChanged(): void {
    if (this.workspaceBroadcastInFlight) {
      this.workspaceBroadcastPending = true;
      return;
    }

    this.workspaceBroadcastInFlight = true;
    void this.drainWorkspaceBroadcastNotifications().catch(() => {});
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
      onClose: (s) => this.onSessionClose(s),
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
    this.mobileInviteEndpoint = `wss://${this.serverName}:${port}`;
    try {
      this.bonjour = this.opts.bonjourFactory?.() ?? new BridgeBonjour();
      this.bonjour.publish({
        name: this.serverName,
        port,
        serverId: this.serverId,
        fingerprint: this.tls.fingerprint,
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

  /** Create a one-time Psyche invite for the active bridge listener. */
  openMobileInvite(): string {
    if (!this.mobileInviteEndpoint) {
      throw new Error("bridge must be started before opening a mobile invite");
    }
    const invite = this.mobileInvites.issue({ endpoint: this.mobileInviteEndpoint });
    const url = new URL("psyche://invite");
    url.searchParams.set("endpoint", this.mobileInviteEndpoint);
    url.searchParams.set("psyche_invite", invite.token);
    return url.toString();
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
        if (m.payload.token !== null && m.payload.token !== undefined && m.payload.invite !== undefined) {
          s.send({ type: "error", payload: { code: "invalid_invite", message: "token and invite cannot be used together" } });
          return;
        }
        if (m.payload.invite !== undefined) {
          const redeemed = this.mobileInvites.redeem(m.payload.invite);
          if (!redeemed) {
            s.send({ type: "error", payload: { code: "invalid_invite", message: "invite is invalid, expired, or already used" } });
            return;
          }
          const rec = await this.tokens.issue(m.payload.clientId, m.payload.clientName);
          s.state = "authenticated";
          s.token = rec.token;
          s.send({ type: "authAccepted", payload: { token: rec.token } });
          this.mobileInviteEvents.emit("redeemed", redeemed.inviteId);
          return;
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
        await this.hub!.sendInput(m.payload.paneId, bytes);
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
          this.notifyWorkspaceChanged();
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

  private broadcastWorkspaceChanged(): Promise<void> {
    return this.enqueueWorkspaceOperation(async () => {
      if (!this.listener || !this.opts.workspaceProvider) return;

      const workspace = await this.opts.workspaceProvider();
      if (workspace.revision === this.lastBroadcastWorkspaceRevision) return;

      this.workspaceSequence += 1;
      this.lastBroadcastWorkspaceRevision = workspace.revision;
      const message = {
        type: "workspaceChanged" as const,
        payload: {
          revision: workspace.revision,
          sequence: this.workspaceSequence,
          workspace,
        },
      };

      for (const session of this.listener.activeSessions) {
        if (
          session.state === "authenticated"
          && session.protocolVersion === PROTOCOL_VERSION
        ) {
          session.send(message);
        }
      }
    });
  }

  private async drainWorkspaceBroadcastNotifications(): Promise<void> {
    try {
      do {
        this.workspaceBroadcastPending = false;
        try {
          await this.broadcastWorkspaceChanged();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          LogService.getInstance().error(
            `bridge workspace change broadcast failed: ${message}`,
            "BridgeDaemon",
            undefined,
            error instanceof Error ? error : undefined,
          );
        }
      } while (this.workspaceBroadcastPending);
    } finally {
      this.workspaceBroadcastInFlight = false;
      if (this.workspaceBroadcastPending) {
        this.notifyWorkspaceChanged();
      }
    }
  }

  private readWorkspaceSnapshot(): Promise<{
    workspace: ReadonlyWorkspaceSnapshot;
    sequence: number;
  }> {
    return this.enqueueWorkspaceOperation(async () => {
      const provider = this.opts.workspaceProvider;
      if (!provider) {
        throw new Error("workspace provider is not available");
      }
      const workspace = await provider();
      return { workspace, sequence: this.workspaceSequence };
    });
  }

  private enqueueWorkspaceOperation<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.workspaceOperationQueue.then(operation);
    this.workspaceOperationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async readLegacyState(): Promise<{ panes: PaneSnapshot[]; projects: Project[] }> {
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

    // Attach metadata has to reach the client before any output frame, or the
    // client cannot tell which stream the bytes belong to. Frames raised while
    // the request is in flight queue here; once the response is on the wire
    // this same callback forwards directly, so a live chunk can never overtake
    // the replay that preceded it.
    const queuedBinaryFrames: Array<{ streamId: string; sequence: number; payload: Uint8Array }> = [];
    let responseFlushed = false;
    const sendBinary = (streamId: string, sequence: number, payload: Uint8Array) => {
      if (responseFlushed) {
        s.sendBinary(streamId, sequence, payload);
        return;
      }
      queuedBinaryFrames.push({ streamId, sequence, payload });
    };

    try {
      const response = await this.mobileGateway.handle(request, {
        ownerId: this.ownerIdForSession(s),
        connectionId: s.connectionId,
        sendBinary,
      });
      this.sendControl(s, response);
    } catch (error) {
      this.sendControl(s, this.controlErrorPayload(request, error));
    }

    // Drain before flipping the flag. Both steps are synchronous, so no frame
    // can arrive mid-drain and jump ahead of what is already queued.
    for (const frame of queuedBinaryFrames) {
      s.sendBinary(frame.streamId, frame.sequence, frame.payload);
    }
    queuedBinaryFrames.length = 0;
    responseFlushed = true;
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

  /**
   * Only an authenticated, still-live session owns streams. Looking a
   * connection up by id rather than trusting the caller keeps one client from
   * detaching or typing into another's stream.
   */
  /**
   * The TUI owns pane creation and lifecycle; the daemon only forwards. Until
   * it registers, a mutation is unsupported rather than a crash.
   */
  setMobilePaneExecutors(executors: MobilePaneExecutors | null): void {
    this.mobilePaneExecutors = executors ?? undefined;
  }

  private requireMobileExecutors(): MobilePaneExecutors {
    if (!this.mobilePaneExecutors) {
      throw new MobileControlGatewayError(
        "command_not_supported",
        "this host cannot create or change panes yet",
      );
    }
    return this.mobilePaneExecutors;
  }

  private requireActionExecutor(): MobileActionExecutor {
    if (!this.mobileActionExecutor) {
      throw new MobileControlGatewayError(
        "command_not_supported",
        "this host does not support remote actions yet",
      );
    }
    return this.mobileActionExecutor;
  }

  private sessionForConnection(connectionId: string): Session {
    for (const s of this.listener?.activeSessions ?? []) {
      if (s.connectionId === connectionId && s.state === "authenticated") return s;
    }
    throw new MobileControlGatewayError("no_connection", "connection is not authenticated");
  }

  private controlStream(connectionId: string, streamId: string) {
    const session = this.sessionForConnection(connectionId);
    const stream = session.controlStreams.get(streamId);
    if (!stream) {
      throw new MobileControlGatewayError("no_stream", "unknown terminal stream");
    }
    return { session, stream };
  }

  private async attachPaneStream(
    context: MobileControlGatewayContext,
    paneId: string,
    sinceSeq?: number,
  ): Promise<MobileAttachedStream> {
    // A pane id reaches tmux as command text, and attaching allocates a replay
    // buffer keyed by it, so an unchecked id both grows the hub without bound
    // and seeds a value that later runs as a command.
    if (!isTmuxPaneId(paneId)) {
      throw new MobileControlGatewayError("invalid_pane", "paneId must be a tmux pane id such as %3");
    }
    if (!await this.isPublishedPane(paneId)) {
      throw new MobileControlGatewayError("unknown_pane", "pane is not published by this host");
    }

    const session = this.sessionForConnection(context.connectionId);
    // The client caps itself at two live terminals, but the host must not
    // depend on it doing so: each stream holds a subscription on a pane
    // buffer, so an unbounded client could pin arbitrary output forever.
    if (session.controlStreams.size >= MAX_CONTROL_STREAMS_PER_CONNECTION) {
      throw new MobileControlGatewayError(
        "too_many_streams",
        `a connection may hold at most ${MAX_CONTROL_STREAMS_PER_CONNECTION} terminal streams`,
      );
    }
    const streamId = randomUUID().slice(0, 8);
    const buffer = this.hub!.bufferFor(paneId);

    // Subscribe before reading the replay window so a chunk written during the
    // handoff is held rather than lost, then released once the replay it would
    // have duplicated has been sent.
    let replaySent = false;
    const pendingLive: Array<{ data: Buffer; seq: number }> = [];
    let latestSentSeq = 0;
    const teardown = buffer.subscribe((chunk) => {
      if (!replaySent) {
        pendingLive.push(chunk);
        return;
      }
      if (chunk.seq <= latestSentSeq) return;
      latestSentSeq = chunk.seq;
      context.sendBinary(streamId, chunk.seq, chunk.data);
    });
    session.controlStreams.set(streamId, { paneId, teardown });

    const snapshot = buffer.snapshot(sinceSeq);
    if (snapshot.data.length > 0) {
      context.sendBinary(streamId, snapshot.latestSeq, snapshot.data);
    }
    latestSentSeq = snapshot.latestSeq;
    replaySent = true;
    for (const chunk of pendingLive) {
      if (chunk.seq <= latestSentSeq) continue;
      latestSentSeq = chunk.seq;
      context.sendBinary(streamId, chunk.seq, chunk.data);
    }

    return {
      streamId,
      latestSeq: snapshot.latestSeq,
      hasReplay: snapshot.data.length > 0,
      // Anything the client cannot append onto what it already holds has to be
      // replaced outright, or it would splice unrelated output together.
      replayMode:
        sinceSeq === undefined || snapshot.gap || sinceSeq > snapshot.latestSeq
          ? "replace"
          : "append",
    };
  }

  private async detachPaneStream(connectionId: string, streamId: string): Promise<void> {
    const { session, stream } = this.controlStream(connectionId, streamId);
    stream.teardown();
    session.controlStreams.delete(streamId);
  }

  private async sendPaneStreamInput(
    connectionId: string,
    streamId: string,
    data: Buffer,
  ): Promise<void> {
    const { stream } = this.controlStream(connectionId, streamId);
    await this.hub!.sendInput(stream.paneId, data);
  }

  private async resizePaneStream(
    connectionId: string,
    streamId: string,
    cols: number,
    rows: number,
  ): Promise<void> {
    const { stream } = this.controlStream(connectionId, streamId);
    this.hub!.resizePane(stream.paneId, cols, rows);
  }

  /** Streams are scoped to real tmux-backed panes the workspace publishes. */
  private async isPublishedPane(paneId: string): Promise<boolean> {
    const { workspace } = await this.readWorkspaceSnapshot();
    return hasPublishedTmuxBackedPane(workspace, paneId);
  }

  /**
   * A dropped socket must not leave a live tmux subscription behind writing
   * into a session nobody is reading.
   */
  private onSessionClose(s: Session): void {
    this.mobileGateway?.clearOwner(this.ownerIdForSession(s));
    for (const stream of s.controlStreams.values()) stream.teardown();
    s.controlStreams.clear();
    for (const teardown of s.subscriptionTeardowns.values()) teardown();
    s.subscriptionTeardowns.clear();
    for (const subs of this.paneSubscribers.values()) subs.delete(s);
  }

  private ownerIdForSession(s: Session): string {
    // connectionId is server-generated and cannot be spoofed by hello. It is
    // deliberately stricter than clientId ownership: a second socket using
    // the same device token cannot resume or clear the first socket's action.
    return s.connectionId;
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
