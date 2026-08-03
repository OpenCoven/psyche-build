import https from "node:https";
import { WebSocketServer, WebSocket } from "ws";
import type { TLSMaterial } from "./TLSCertificate.js";
import { Session } from "./Session.js";
import { ClientMessage, decodeClientMessage } from "./wireProtocol.js";

export interface WSSListenerEvents {
  onConnection: (session: Session) => void;
  onClientMessage: (session: Session, msg: ClientMessage) => Promise<void> | void;
  onClose: (session: Session) => void;
  /** Transport-level failures. Optional: absent means "log nothing, but stay up". */
  onServerError?: (err: Error) => void;
}

/**
 * Largest control frame accepted from a client.
 *
 * `ws` defaults to 100 MB, which any unauthenticated peer on the LAN can send
 * repeatedly to exhaust the host process's heap — and this daemon runs inside
 * the psyche TUI, so that is the user's whole session. Bridge frames are JSON
 * control messages plus base64 keystrokes; 1 MiB is far above a realistic
 * paste and far below a memory-pressure problem.
 */
export const MAX_CLIENT_FRAME_BYTES = 1024 * 1024;

export class WSSListener {
  private https: https.Server;
  private wss: WebSocketServer;
  private sessions = new Set<Session>();

  constructor(tls: TLSMaterial, private events: WSSListenerEvents) {
    this.https = https.createServer({ cert: tls.cert, key: tls.key });
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
    for (const s of this.sessions) s.close("daemon shutting down");
    await new Promise<void>((r) => this.wss.close(() => r()));
    await new Promise<void>((r) => this.https.close(() => r()));
  }

  get activeSessions(): ReadonlySet<Session> {
    return this.sessions;
  }

  private handleConnection(socket: WebSocket, req: import("http").IncomingMessage) {
    const session = new Session({
      socket,
      remoteAddress: req.socket.remoteAddress ?? "?",
      remoteUserAgent: req.headers["user-agent"],
    });
    this.sessions.add(session);
    // A per-socket 'error' listener is mandatory: `ws` emits 'error' on an
    // abrupt peer reset, and an unhandled 'error' event throws out of the
    // EventEmitter and kills psyche. The 'close' that follows does the cleanup.
    socket.on("error", (err) => this.events.onServerError?.(err));
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
    try {
      const msg = decodeClientMessage(raw.toString("utf8"));
      await this.events.onClientMessage(session, msg);
    } catch (err) {
      session.send({
        type: "error",
        payload: { code: "parse_failed", message: String(err) },
      });
    }
  }
}
