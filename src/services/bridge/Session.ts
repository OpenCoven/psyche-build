import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  ServerMessage,
  encodeMobileBinaryFrame,
  encodeServerMessage,
  type BridgeError,
  type SupportedProtocolVersion,
} from "./wireProtocol.js";
import type { PreAuthDropReason } from "./PreAuthGate.js";

export type SessionState = "unauthenticated" | "authenticated";

export interface SessionContext {
  socket: WebSocket;
  remoteAddress: string;
  remoteUserAgent?: string;
  /**
   * The pre-authentication limits the listener holds this session to. Absent
   * when a session is built without a listener, as in a unit test.
   */
  preAuth?: {
    /** Most reply bytes that may sit unread before authentication. */
    maxBufferedBytes: number;
    /** Most bytes the peer may send, in total, before authentication. */
    maxInboundBytes: number;
    /**
     * `reject` has asked the peer to close; the listener drops it if it
     * never completes the close handshake.
     */
    onRejected: () => void;
    /** The peer is past one of the two bounds; the listener drops it now. */
    onDrop: (reason: PreAuthDropReason) => void;
  };
}

export class Session {
  readonly connectionId = randomUUID();
  state: SessionState = "unauthenticated";
  clientId: string | null = null;
  clientName: string | null = null;
  protocolVersion: SupportedProtocolVersion | null = null;
  token: string | null = null;
  /** True once a well-formed `hello` has been accepted; a second is refused. */
  helloReceived = false;
  /**
   * True once `reject` has run. Frames already queued behind the one that
   * caused the rejection must not be handled: the peer has been refused.
   */
  rejected = false;
  /**
   * True while the daemon is looking up the token this peer presented. The
   * inbound budget is not enforced meanwhile; the daemon calls
   * `noteInbound(0)` when a lookup ends without authenticating the session.
   */
  authenticating = false;
  /** True once the listener has been told to drop this peer. */
  private dropped = false;
  /** Bytes received from the peer since the connection became a WebSocket. */
  private inboundBytes = 0;
  subscribedPaneIds = new Set<string>();
  subscriptionTeardowns = new Map<string, () => void>();
  /**
   * Terminal streams this connection attached, keyed by stream id. Scoped to
   * the connection so one client cannot detach or type into another's stream,
   * and torn down on close so a dropped socket leaves no live subscription.
   */
  controlStreams = new Map<string, { paneId: string; teardown: () => void }>();

  constructor(public readonly ctx: SessionContext) {}

  /**
   * True only while the socket is OPEN. A socket in its closing handshake is
   * still registered with the listener until 'close' fires, but nothing sent
   * or started for it can be delivered or cleaned up.
   */
  isOpen(): boolean {
    return this.ctx.socket.readyState === 1; // 1 = OPEN
  }

  send(msg: ServerMessage): void {
    if (this.ctx.socket.readyState !== 1) return; // 1 = OPEN
    if (this.refusesUnreadBacklog()) return;
    try {
      this.ctx.socket.send(encodeServerMessage(msg));
    } catch {
      // The socket can fail between the readyState check and the write. A
      // send failure is never worth propagating — the 'close' handler tears
      // the session down either way.
    }
  }

  sendBinary(streamId: string, sequence: number, payload: Uint8Array): void {
    if (this.ctx.socket.readyState !== 1) return; // 1 = OPEN
    if (this.refusesUnreadBacklog()) return;
    try {
      this.ctx.socket.send(encodeMobileBinaryFrame(streamId, sequence, payload));
    } catch {
      // The socket can fail between the readyState check and the write.
    }
  }

  close(reason: string): void {
    // Sent before the session is demoted: what is queued for an authenticated
    // session was earned while it was authenticated, and the reason for
    // closing it must not be withheld under the pre-authentication bound.
    try {
      this.send({ type: "error", payload: { code: "closing", message: reason } });
    } catch {
      // ignore
    }
    this.state = "unauthenticated";
    this.token = null;
    this.ctx.socket.close(1000, reason);
  }

  /**
   * Refuse the peer: one fixed error frame, then a close with `closeCode`.
   *
   * `error` must be a constant. Its message is also the close reason, so
   * nothing the peer sent can be reflected back through either.
   */
  reject(error: BridgeError, closeCode: number): void {
    if (this.rejected) return;
    this.rejected = true;
    this.state = "unauthenticated";
    this.token = null;
    this.send({ type: "error", payload: error });
    try {
      this.ctx.socket.close(closeCode, error.message);
    } catch {
      // close() throws only for an invalid code or reason; the peer is
      // dropped by the listener's grace timer either way.
    }
    this.ctx.preAuth?.onRejected();
  }

  /**
   * True when this session has not authenticated and is not reading what it
   * has already been sent. Nothing more is queued for it, and the listener is
   * told once to drop it.
   *
   * An authenticated session is never subject to this: a paired device on a
   * slow link legitimately has terminal output waiting.
   */
  private refusesUnreadBacklog(): boolean {
    const preAuth = this.ctx.preAuth;
    if (!preAuth || this.state === "authenticated") return false;
    if (this.ctx.socket.bufferedAmount <= preAuth.maxBufferedBytes) return false;
    this.drop("unread_replies");
    return true;
  }

  /** Tell the listener, once, to drop this peer; nothing more is handled for it. */
  private drop(reason: PreAuthDropReason): void {
    if (this.dropped) return;
    this.dropped = true;
    this.rejected = true;
    this.token = null;
    this.ctx.preAuth?.onDrop(reason);
  }

  /**
   * The same check, for traffic arriving from the peer. Not every reply is
   * sent through this session: the WebSocket library answers a ping with a
   * pong by itself, so a peer that only pings would never reach `send`.
   *
   * A socket that is already closing is not judged. Nothing more is queued
   * for it, and a session demoted by `close` may still hold output it was
   * owed while it was authenticated.
   */
  dropIfUnresponsive(): boolean {
    return this.isOpen() && this.refusesUnreadBacklog();
  }

  /**
   * Count bytes received from the peer and drop it once it has sent more
   * than an unauthenticated peer may. Returns true if it has been dropped.
   *
   * Nothing an authenticated session sends is counted. Before that, bytes
   * are counted as they arrive but not judged while a token lookup is in
   * flight, and never on a socket that is already closing.
   */
  noteInbound(bytes: number): boolean {
    const preAuth = this.ctx.preAuth;
    if (!preAuth || this.state === "authenticated") return false;
    this.inboundBytes += bytes;
    if (this.authenticating || !this.isOpen()) return false;
    if (this.inboundBytes <= preAuth.maxInboundBytes) return this.dropped;
    this.drop("inbound_budget");
    return true;
  }
}
