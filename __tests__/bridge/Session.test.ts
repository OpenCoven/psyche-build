import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { Session } from "../../src/services/bridge/Session";
import { encodeMobileBinaryFrame } from "../../src/services/bridge/wireProtocol";

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: Array<string | Buffer> = [];
  send(msg: string | Buffer) {
    this.sent.push(msg);
  }
  close() {
    this.readyState = 3;
  }
}

describe("Session", () => {
  it("starts unauthenticated", () => {
    const sock = new FakeSocket();
    const s = new Session({ socket: sock as any, remoteAddress: "127.0.0.1" });
    expect(s.state).toBe("unauthenticated");
    expect(s.protocolVersion).toBeNull();
    expect(s.subscribedPaneIds.size).toBe(0);
    expect(s.subscriptionTeardowns.size).toBe(0);
  });

  it("assigns a stable unique connection id per session", () => {
    const first = new Session({ socket: new FakeSocket() as any, remoteAddress: "127.0.0.1" });
    const second = new Session({ socket: new FakeSocket() as any, remoteAddress: "127.0.0.1" });

    expect(first.connectionId).toBe(first.connectionId);
    expect(second.connectionId).toBe(second.connectionId);
    expect(first.connectionId).not.toBe(second.connectionId);
  });

  it("send writes a serialized server frame", () => {
    const sock = new FakeSocket();
    const s = new Session({ socket: sock as any, remoteAddress: "127.0.0.1" });
    s.send({ type: "pong", payload: { token: "x" } });
    expect(sock.sent).toHaveLength(1);
    expect(sock.sent[0]).toContain('"type":"pong"');
  });

  it("send is a no-op when socket is closed", () => {
    const sock = new FakeSocket();
    sock.readyState = 3;
    const s = new Session({ socket: sock as any, remoteAddress: "127.0.0.1" });
    s.send({ type: "pong", payload: { token: "x" } });
    expect(sock.sent).toHaveLength(0);
  });

  it("sendBinary writes the mobile binary frame after control messages", () => {
    const sock = new FakeSocket();
    const s = new Session({ socket: sock as any, remoteAddress: "127.0.0.1" });

    s.send({ type: "pong", payload: { token: "x" } });
    s.sendBinary("pane-1", 258, Uint8Array.from([0xde, 0xad]));

    expect(sock.sent).toHaveLength(2);
    expect(sock.sent[0]).toContain('"type":"pong"');
    expect(sock.sent[1]).toEqual(
      encodeMobileBinaryFrame("pane-1", 258, Uint8Array.from([0xde, 0xad])),
    );
  });

  it("sendBinary is a no-op when socket is closed", () => {
    const sock = new FakeSocket();
    sock.readyState = 3;
    const s = new Session({ socket: sock as any, remoteAddress: "127.0.0.1" });

    s.sendBinary("pane-1", 1, Uint8Array.from([0x01]));

    expect(sock.sent).toHaveLength(0);
  });
});
