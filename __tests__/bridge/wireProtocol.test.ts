import { describe, expect, it } from "vitest";
import {
  decodeClientMessage,
  encodeServerMessage,
  isSupportedProtocolVersion,
  LEGACY_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "../../src/services/bridge/wireProtocol";

describe("wireProtocol", () => {
  it("pins the legacy and current bridge protocol versions", () => {
    expect(LEGACY_PROTOCOL_VERSION).toBe(2);
    expect(PROTOCOL_VERSION).toBe(3);
  });

  it("accepts only supported bridge protocol versions", () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS.every(isSupportedProtocolVersion)).toBe(true);
    expect(isSupportedProtocolVersion(99)).toBe(false);
    expect(isSupportedProtocolVersion("2")).toBe(false);
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
