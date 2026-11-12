import https from "node:https";
import type { Socket } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import type { TLSMaterial } from "./TLSCertificate.js";
import { Session } from "./Session.js";
import { ClientMessage, decodeClientMessage } from "./wireProtocol.js";
import {
  CLOSE_MESSAGE_TOO_BIG,
  PRE_AUTH_ERRORS,
  PreAuthGate,
  TRANSPORT_MAX_FRAME_BYTES,
  normalizeRemoteAddress,
  resolvePreAuthLimits,
  type PreAuthConnection,
  type PreAuthLimits,
  type PreAuthRefusal,
  type PreAuthScheduler,
} from "./PreAuthGate.js";

export interface WSSListenerEvents {
  onConnection: (session: Session) => void;
  onClientMessage: (session: Session, msg: ClientMessage) => Promise<void> | void;
  onClose: (session: Session) => void;
  /** Transport-level failures. Optional: absent means "log nothing, but stay up". */
  onServerError?: (err: Error) => void;
  /**
   * A pre-authentication cap refused a connection. `refusedTotal` counts
   * refusals since the listener started. The peer's address is deliberately
   * not passed: the owner logs this, and a refusal is not worth recording a
   * network address for.
   */
  onAdmissionRefused?: (reason: PreAuthRefusal, refusedTotal: number) => void;
}

export interface WSSListenerOptions {
  /** Overrides for the pre-authentication limits. Production passes none. */
  preAuth?: Partial<PreAuthLimits>;
  /** Timer source for the pre-authentication deadlines; for tests. */
  scheduler?: PreAuthScheduler;
}

/**
 * Largest control frame accepted from a client.
 *
 * `ws` defaults to 100 MB, which any unauthenticated peer on the LAN can send
 * repeatedly to exhaust the host process's heap — and this daemon runs inside
 * the psyche TUI, so that is the user's whole session. Bridge frames are JSON
 * control messages plus base64 keystrokes; 1 MiB is far above a realistic
 * paste and far below a memory-pressure problem.
 *
 * A connection that has not authenticated is held to the much smaller
 * `PRE_AUTH_MAX_FRAME_BYTES`; see `PreAuthGate`.
 */
export const MAX_CLIENT_FRAME_BYTES = TRANSPORT_MAX_FRAME_BYTES;

/** Identifies one TCP connection for as long as it is open. */
function connectionKey(socket: Socket): string | null {
  const { remoteAddress, remotePort, localAddress, localPort } = socket;
  if (!remoteAddress || remotePort === undefined) return null;
  return `${remoteAddress}|${remotePort}|${localAddress ?? ""}|${localPort ?? ""}`;
}

function frameByteLength(raw: WebSocket.RawData): number {
  if (Array.isArray(raw)) return raw.reduce((total, chunk) => total + chunk.byteLength, 0);
  return raw.byteLength;
}

function frameText(raw: WebSocket.RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return raw.toString("utf8");
}

export class WSSListener {
  private https: https.Server;
  private wss: WebSocketServer;
  private sessions = new Set<Session>();
  private readonly limits: PreAuthLimits;
  private readonly gate: PreAuthGate;
  /** Admitted TCP connections by 4-tuple, until their socket closes. */
  private readonly admitted = new Map<string, PreAuthConnection>();

  constructor(
    tls: TLSMaterial,
    private events: WSSListenerEvents,
    options: WSSListenerOptions = {},
  ) {
    this.limits = resolvePreAuthLimits(options.preAuth);
    this.gate = new PreAuthGate(
      this.limits,
      options.scheduler,
      (reason, refusedTotal) => this.events.onAdmissionRefused?.(reason, refusedTotal),
    );
    this.https = https.createServer({ cert: tls.cert, key: tls.key });
    // Admission runs on the raw TCP connection, ahead of the TLS server's own
    // listener, so a refused peer costs no handshake and a peer that never
    // speaks is still counted and still expires.
    this.https.prependListener("connection", (socket: Socket) => this.admit(socket));
    this.wss = new WebSocketServer({ server: this.https, maxPayload: MAX_CLIENT_FRAME_BYTES });
    this.wss.on("connection", (socket, req) => this.handleConnection(socket, req));
    // An 'error' event with no listener is rethrown by EventEmitter and takes
    // the whole psyche process down. Both of these fire on ordinary network
    // conditions (a client vanishing mid-TLS-handshake, for instance).
    this.wss.on("error", (err) => this.events.onServerError?.(err));
    this.https.on("clientError", (_err, socket) => socket.destroy());
  }

  async start(): Promise<{ port: number }> {
    return await new Promise((resolve, reject) => {
      const onStartupError = (err: Error) => reject(err);
      this.https.once("error", onStartupError);
      this.https.listen(0, "0.0.0.0", () => {
        const addr = this.https.address();
        if (typeof addr !== "object" || !addr) return reject(new Error("no address"));
        // Hand post-listen errors to the owner instead of leaving the server
        // without an 'error' listener, which would crash the process.
        this.https.off("error", onStartupError);
        this.https.on("error", (err) => this.events.onServerError?.(err));
        resolve({ port: addr.port });
      });
    });
  }

  async stop(): Promise<void> {
    // Cancels every pre-auth timer and drops connections that never became a
    // WebSocket; without that, one idle TCP peer keeps close() from finishing.
    this.gate.dispose();
    for (const s of this.sessions) s.close("daemon shutting down");
    await new Promise<void>((r) => this.wss.close(() => r()));
    await new Promise<void>((r) => this.https.close(() => r()));
  }

  get activeSessions(): ReadonlySet<Session> {
    return this.sessions;
  }

  /** The pre-authentication limits this listener enforces. */
  get preAuthLimits(): Readonly<PreAuthLimits> {
    return this.limits;
  }

  /** Connections currently held that have not authenticated, in any phase. */
  get unauthenticatedConnectionCount(): number {
    return this.gate.unauthenticatedCount;
  }

  /** Connections a pre-authentication cap has refused since start. */
  get refusedConnectionCount(): number {
    return this.gate.refusedCount;
  }

  /**
   * Decide whether a newly accepted TCP connection may proceed.
   *
   * A refused connection is destroyed here, before TLS: the peer sees a reset
   * and learns nothing. Sessions already open are not involved.
   */
  private admit(socket: Socket): void {
    // Defensive: this listener destroys sockets the TLS layer is about to
    // wrap, and an 'error' event with no listener takes the process down.
    socket.on("error", () => {});
    const address = normalizeRemoteAddress(socket.remoteAddress);
    const key = connectionKey(socket);
    if (!address || !key) {
      socket.destroy();
      return;
    }
    const connection = this.gate.admit(address, { destroy: () => socket.destroy() });
    if (!connection) {
      socket.destroy();
      return;
    }
    this.admitted.set(key, connection);
    socket.once("close", () => {
      if (this.admitted.get(key) === connection) this.admitted.delete(key);
      this.gate.release(connection);
    });
  }

  private handleConnection(socket: WebSocket, req: import("http").IncomingMessage) {
    // A per-socket 'error' listener is mandatory: `ws` emits 'error' on an
    // abrupt peer reset, and an unhandled 'error' event throws out of the
    // EventEmitter and kills psyche. The 'close' that follows does the cleanup.
    socket.on("error", (err) => this.events.onServerError?.(err));
    const key = connectionKey(req.socket);
    const connection = key ? this.admitted.get(key) : undefined;
    if (!connection) {
      // Every WebSocket arrives on a connection `admit` accepted. One that
      // cannot be matched to its admission is unaccounted for, so it is
      // dropped rather than served outside the limits.
      socket.terminate();
      return;
    }
    const session = new Session({
      socket,
      remoteAddress: req.socket.remoteAddress ?? "?",
      remoteUserAgent: req.headers["user-agent"],
      onRejected: () => this.gate.rejected(connection),
    });
    this.gate.attach(connection, {
      isAuthenticated: () => session.state === "authenticated",
      reject: (error, closeCode) => session.reject(error, closeCode),
    });
    this.sessions.add(session);
    this.events.onConnection(session);
    let messageQueue = Promise.resolve();
    socket.on("message", (raw) => {
      messageQueue = messageQueue.then(
        () => this.handleMessage(session, raw),
        () => this.handleMessage(session, raw)
      );
    });
    socket.on("close", () => {
      this.sessions.delete(session);
      this.events.onClose(session);
    });
  }

  private async handleMessage(session: Session, raw: WebSocket.RawData): Promise<void> {
    // A refused peer gets nothing further handled, including frames that were
    // already queued behind the one that got it refused.
    if (session.rejected) return;
    // Measured here, when the frame is handled, rather than on receipt: a
    // frame queued behind the one that authenticates the session is judged
    // against the session's state once that frame has taken effect.
    if (
      session.state !== "authenticated"
      && frameByteLength(raw) > this.limits.maxFrameBytes
    ) {
      session.reject(PRE_AUTH_ERRORS.frameTooLarge, CLOSE_MESSAGE_TOO_BIG);
      return;
    }
    try {
      const msg = decodeClientMessage(frameText(raw));
      await this.events.onClientMessage(session, msg);
    } catch (err) {
      session.send({
        type: "error",
        // The decoder's message quotes the frame it could not read, and a
        // handler's can carry host detail. Neither goes to a peer that has
        // not authenticated.
        payload: session.state === "authenticated"
          ? { code: "parse_failed", message: String(err) }
          : PRE_AUTH_ERRORS.malformedFrame,
      });
    }
  }
}
