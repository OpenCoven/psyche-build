import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  ServerMessage,
  encodeMobileBinaryFrame,
  encodeServerMessage,
  type SupportedProtocolVersion,
} from "./wireProtocol.js";

export type SessionState = "unauthenticated" | "authenticated";

export interface SessionContext {
  socket: WebSocket;
  remoteAddress: string;
  remoteUserAgent?: string;
}

export class Session {
  readonly connectionId = randomUUID();
  state: SessionState = "unauthenticated";
  clientId: string | null = null;
  clientName: string | null = null;
  protocolVersion: SupportedProtocolVersion | null = null;
  token: string | null = null;
  subscribedPaneIds = new Set<string>();
  subscriptionTeardowns = new Map<string, () => void>();

  constructor(public readonly ctx: SessionContext) {}

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
    try {
      this.send({ type: "error", payload: { code: "closing", message: reason } });
    } catch {
      // ignore
    }
    this.ctx.socket.close(1000, reason);
  }
}
