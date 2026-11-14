import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  ServerMessage,
  encodeMobileBinaryFrame,
  encodeServerMessage,
  type BridgeError,
  type SupportedProtocolVersion,
} from "./wireProtocol.js";

export type SessionState = "unauthenticated" | "authenticated";

export interface SessionContext {
  socket: WebSocket;
  remoteAddress: string;
  remoteUserAgent?: string;
  /**
   * Called after `reject` has asked the peer to close, so the listener can
   * drop a peer that never completes the close handshake.
   */
  onRejected?: () => void;
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
    try {
      this.ctx.socket.send(encodeMobileBinaryFrame(streamId, sequence, payload));
    } catch {
      // The socket can fail between the readyState check and the write.
    }
  }

  close(reason: string): void {
    this.state = "unauthenticated";
    this.token = null;
    try {
      this.send({ type: "error", payload: { code: "closing", message: reason } });
    } catch {
      // ignore
    }
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
    this.ctx.onRejected?.();
  }
}
