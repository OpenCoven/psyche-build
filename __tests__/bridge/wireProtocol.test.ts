import { describe, expect, it } from "vitest";
import {
  decodeClientMessage,
  encodeServerMessage,
  PROTOCOL_VERSION,
} from "../../src/services/bridge/wireProtocol";

describe("wireProtocol", () => {
  it("PROTOCOL_VERSION matches main's BridgeProtocol.version", () => {
    expect(PROTOCOL_VERSION).toBe(2);
  });

  it("decodes a hello with token", () => {
    const msg = decodeClientMessage(JSON.stringify({
      type: "hello",
      payload: { clientId: "ios-1", clientName: "iPad", protocolVersion: 2, token: "tk" },
    }));
    expect(msg.type).toBe("hello");
    if (msg.type === "hello") expect(msg.payload.token).toBe("tk");
  });

  it("decodes a subscribePane with sinceSeq", () => {
    const msg = decodeClientMessage(JSON.stringify({
      type: "subscribePane",
      payload: { paneId: "%3", sinceSeq: 42 },
    }));
    expect(msg.type).toBe("subscribePane");
    if (msg.type === "subscribePane") expect(msg.payload.sinceSeq).toBe(42);
  });

  it("encodes welcome with stable key order", () => {
    const out = encodeServerMessage({
      type: "welcome",
      payload: {
        serverId: "srv-1",
        serverName: "studio",
        protocolVersion: PROTOCOL_VERSION,
        projectName: "psyche",
      },
    });
    expect(out.indexOf('"serverId"')).toBeLessThan(out.indexOf('"serverName"'));
  });

  it("rejects malformed input", () => {
    expect(() => decodeClientMessage("not json")).toThrow();
    expect(() => decodeClientMessage(JSON.stringify({ foo: "bar" }))).toThrow();
  });
});
