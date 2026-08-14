import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PaneStreamHub } from "../../src/services/bridge/PaneStreamHub";

class FakeTmux extends EventEmitter {
  sentHex: Array<{ paneId: string; data: Buffer }> = [];
  startCalls = 0;
  stopCalls = 0;
  start() { this.startCalls++; }
  stop() { this.stopCalls++; }
  async sendKeysHex(paneId: string, data: Buffer) { this.sentHex.push({ paneId, data }); }
}

describe("PaneStreamHub", () => {
  it("routes %output to per-pane buffers", () => {
    const fake = new FakeTmux();
    const hub = new PaneStreamHub("test", fake as any);
    fake.emit("output", "%1", Buffer.from("hi"));
    fake.emit("output", "%2", Buffer.from("yo"));
    fake.emit("output", "%1", Buffer.from("!"));
    expect(hub.bufferFor("%1").snapshot().data.toString()).toBe("hi!");
    expect(hub.bufferFor("%2").snapshot().data.toString()).toBe("yo");
  });

  it("forwards sendInput to tmuxControl.sendKeysHex", async () => {
    const fake = new FakeTmux();
    const hub = new PaneStreamHub("test", fake as any);
    await hub.sendInput("%3", Buffer.from([0x03]));
    expect(fake.sentHex).toEqual([{ paneId: "%3", data: Buffer.from([0x03]) }]);
  });

  it("start/stop are idempotent", () => {
    const fake = new FakeTmux();
    const hub = new PaneStreamHub("test", fake as any);
    hub.start();
    hub.start();
    hub.stop();
    hub.stop();
    expect(fake.startCalls).toBe(1);
    expect(fake.stopCalls).toBe(1);
  });

  it("bufferFor returns the same buffer instance per paneId", () => {
    const fake = new FakeTmux();
    const hub = new PaneStreamHub("test", fake as any);
    const a = hub.bufferFor("%1");
    const b = hub.bufferFor("%1");
    expect(a).toBe(b);
  });

  it("forgetPane drops the buffer (next bufferFor creates fresh)", () => {
    const fake = new FakeTmux();
    const hub = new PaneStreamHub("test", fake as any);
    const first = hub.bufferFor("%1");
    first.write(Buffer.from("data"));
    hub.forgetPane("%1");
    const second = hub.bufferFor("%1");
    expect(second).not.toBe(first);
    expect(second.snapshot().data.length).toBe(0);
  });
});
