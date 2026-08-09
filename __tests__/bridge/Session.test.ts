import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { Session } from "../../src/services/bridge/Session";

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  send(msg: string) {
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
});
