import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let tmpHome: string;

vi.mock("../../src/services/bridge/paths", async () => {
  // Lazy resolve — tmpHome is set in beforeEach below.
  return {
    get bridgeDir() { return path.join(tmpHome, ".psyche", "bridge"); },
    get tokensPath() { return path.join(tmpHome, ".psyche", "bridge", "devices.json"); },
    get certPath() { return path.join(tmpHome, ".psyche", "bridge", "cert.pem"); },
    get keyPath() { return path.join(tmpHome, ".psyche", "bridge", "key.pem"); },
  };
});

describe("TokenStore", () => {
  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "psyche-tokens-"));
  });
  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("issues a token and validates it", async () => {
    const { TokenStore } = await import("../../src/services/bridge/TokenStore");
    const store = new TokenStore();
    const rec = await store.issue("ios-1", "iPad");
    expect(rec.token).toMatch(/^[0-9a-f]{64}$/);
    const found = await store.validate(rec.token);
    expect(found?.clientName).toBe("iPad");
  });

  it("revokes a token", async () => {
    const { TokenStore } = await import("../../src/services/bridge/TokenStore");
    const store = new TokenStore();
    const rec = await store.issue("ios-1", "iPad");
    expect(await store.revoke(rec.token)).toBe(true);
    expect(await store.validate(rec.token)).toBeNull();
    expect(await store.revoke(rec.token)).toBe(false); // already gone
  });

  it("lists multiple devices and persists across instances", async () => {
    const { TokenStore } = await import("../../src/services/bridge/TokenStore");
    const a = new TokenStore();
    await a.issue("ios-1", "iPad");
    await a.issue("ios-2", "iPhone");
    expect((await a.list()).length).toBe(2);

    // Fresh instance reads the same file
    const b = new TokenStore();
    expect((await b.list()).length).toBe(2);
  });

  it("touch updates lastSeenAt without changing token", async () => {
    const { TokenStore } = await import("../../src/services/bridge/TokenStore");
    const store = new TokenStore();
    const rec = await store.issue("ios-1", "iPad");
    const before = rec.lastSeenAt;
    await new Promise(r => setTimeout(r, 10));
    await store.touch(rec.token);
    const after = await store.validate(rec.token);
    expect(after?.token).toBe(rec.token);
    expect(after?.lastSeenAt).not.toBe(before);
  });

  it("validate returns null for unknown token", async () => {
    const { TokenStore } = await import("../../src/services/bridge/TokenStore");
    const store = new TokenStore();
    expect(await store.validate("deadbeef")).toBeNull();
  });

  it("starts with an empty store when devices.json is corrupted", async () => {
    await fs.mkdir(path.join(tmpHome, ".psyche", "bridge"), { recursive: true });
    await fs.writeFile(path.join(tmpHome, ".psyche", "bridge", "devices.json"), "{bad json", "utf8");

    const { TokenStore } = await import("../../src/services/bridge/TokenStore");
    const store = new TokenStore();

    expect(await store.list()).toEqual([]);
  });

  it("serializes concurrent writes without dropping devices", async () => {
    const { TokenStore } = await import("../../src/services/bridge/TokenStore");
    const store = new TokenStore();

    const issued = await Promise.all([
      store.issue("ios-1", "iPad"),
      store.issue("ios-2", "iPhone"),
      store.issue("ios-3", "Mac"),
    ]);

    const fresh = new TokenStore();
    const devices = await fresh.list();
    expect(devices.map((d) => d.token).sort()).toEqual(issued.map((d) => d.token).sort());
  });
});
