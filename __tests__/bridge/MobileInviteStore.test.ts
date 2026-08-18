import { describe, expect, it, vi } from "vitest";
import { MobileInviteStore } from "../../src/services/bridge/MobileInviteStore";

describe("MobileInviteStore", () => {
  it("redeems a signed invite exactly once for its endpoint", () => {
    const store = new MobileInviteStore();
    const issued = store.issue({ endpoint: "wss://psyche.local:43123" });

    expect(store.redeem(issued.token)).toEqual({ endpoint: "wss://psyche.local:43123" });
    expect(store.redeem(issued.token)).toBeNull();
  });

  it("rejects an altered invite without consuming the original", () => {
    const store = new MobileInviteStore();
    const issued = store.issue({ endpoint: "wss://psyche.local:43123" });
    const altered = `${issued.token}x`;

    expect(store.redeem(altered)).toBeNull();
    expect(store.redeem(issued.token)).toEqual({ endpoint: "wss://psyche.local:43123" });
  });

  it("rejects a non-canonical signature without consuming the original", () => {
    const store = new MobileInviteStore();
    const issued = store.issue({ endpoint: "wss://psyche.local:43123" });

    expect(store.redeem(`${issued.token}!`)).toBeNull();
    expect(store.redeem(issued.token)).toEqual({ endpoint: "wss://psyche.local:43123" });
  });

  it("rejects an expired invite", () => {
    vi.useFakeTimers();
    try {
      const store = new MobileInviteStore();
      const issued = store.issue({ endpoint: "wss://psyche.local:43123", ttlMs: 1000 });
      vi.advanceTimersByTime(1001);

      expect(store.redeem(issued.token)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
