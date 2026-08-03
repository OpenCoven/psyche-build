import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { loadOrCreateTLS, TLSMaterial } from "./TLSCertificate.js";
import { WSSListener } from "./WSSListener.js";
import { Session } from "./Session.js";
import {
  ClientMessage,
  PaneSnapshot,
  Project,
  Ritual,
  PROTOCOL_VERSION,
} from "./wireProtocol.js";
import { PaneStreamHub } from "./PaneStreamHub.js";
import { TokenStore, DeviceRecord } from "./TokenStore.js";
import { PairingFlow } from "./PairingFlow.js";
import { BridgeBonjour } from "./BridgeBonjour.js";
import { isTmuxPaneId } from "../../utils/tmuxTarget.js";
import { decodeBase64Payload } from "../../utils/base64.js";
import { LogService } from "../LogService.js";

export interface BridgeDaemonOptions {
  serverId?: string;
  serverName?: string;
  projectName?: string | null;
  paneProvider: () => PaneSnapshot[];
  projectProvider: () => Project[];
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
  readonly serverId: string;
  readonly serverName: string;

  constructor(private opts: BridgeDaemonOptions) {
    this.serverId = opts.serverId ?? randomUUID();
    this.serverName = opts.serverName ?? hostname();
    this.tokens = opts.tokenStore ?? new TokenStore();
    this.pairing = opts.pairingFlow ?? new PairingFlow();
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
    s.send({
      type: "welcome",
      payload: {
        serverId: this.serverId,
        serverName: this.serverName,
        protocolVersion: PROTOCOL_VERSION,
        projectName: this.opts.projectName ?? null,
      },
    });
    // If a pair window is already open, send pairChallenge to the new session
    if (this.pairing.isOpen()) {
      const w = this.pairing.peek()!;
      s.send({
        type: "pairChallenge",
        payload: { expiresAt: w.expiresAt.toISOString(), codeLength: w.code.length },
      });
    }
  }

  private async onMessage(s: Session, m: ClientMessage) {
    switch (m.type) {
      case "hello": {
        if (m.payload.protocolVersion !== PROTOCOL_VERSION) {
          s.close(`protocol mismatch: client=${m.payload.protocolVersion} server=${PROTOCOL_VERSION}`);
          return;
        }
        s.clientId = m.payload.clientId;
        s.clientName = m.payload.clientName;
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
        s.send({ type: "paneList", payload: this.opts.paneProvider() });
        return;
      case "listProjects":
        if (!this.requireAuthenticated(s)) return;
        s.send({ type: "projectList", payload: this.opts.projectProvider() });
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
          this.broadcastStateUpdates();
        } catch (err) {
          s.send({ type: "error", payload: { code: "state_update_failed", message: String(err) } });
        }
        return;
      }
      default:
        return;
    }
  }

  private requireAuthenticated(s: Session): boolean {
    if (s.state === "authenticated") return true;
    s.send({ type: "error", payload: { code: "not_authenticated", message: "pair first" } });
    return false;
  }

  private broadcastStateUpdates(): void {
    if (!this.listener) return;
    let panes: PaneSnapshot[] | undefined;
    let projects: Project[] | undefined;
    for (const session of this.listener.activeSessions) {
      if (session.state === "authenticated") {
        projects ??= this.opts.projectProvider();
        panes ??= this.opts.paneProvider();
        session.send({ type: "projectList", payload: projects });
        session.send({ type: "paneListChanged", payload: panes });
      }
    }
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
