import { describe, expect, it, vi } from "vitest";
import { PairingFlow, PAIR_MAX_ATTEMPTS, PAIR_WINDOW_MS } from "../../src/services/bridge/PairingFlow";

/** A code guaranteed to differ from `code`, for wrong-guess tests. */
function wrongCode(code: string): string {
  return code === "000000" ? "111111" : "000000";
}

describe("PairingFlow", () => {
  it("opens with a 6-digit code", () => {
    const flow = new PairingFlow();
    const w = flow.open();
    expect(w.code).toMatch(/^\d{6}$/);
    expect(flow.isOpen()).toBe(true);
    flow.close("manual");
  });

  it("consume rejects wrong code, accepts the right code, then closes", () => {
    const flow = new PairingFlow();
    const w = flow.open();
    const wrong = w.code === "000000" ? "111111" : "000000";
    expect(flow.consume(wrong)).toBe(false);
    expect(flow.isOpen()).toBe(true);
    expect(flow.consume(w.code)).toBe(true);
    expect(flow.isOpen()).toBe(false);
  });

  it("emits open and close events", () => {
    const flow = new PairingFlow();
    const opens: PairingFlow extends EventTarget ? unknown[] : any[] = [];
    const closes: any[] = [];
    flow.on("open", (w) => opens.push(w));
    flow.on("close", (e) => closes.push(e));
    const w = flow.open();
    flow.consume(w.code);
    expect(opens).toHaveLength(1);
    expect(closes).toHaveLength(1);
    expect(closes[0].reason).toBe("consumed");
  });

  it("auto-closes on expiry with reason='expired'", () => {
    vi.useFakeTimers();
    const flow = new PairingFlow();
    const closes: any[] = [];
    flow.on("close", (e) => closes.push(e));
    flow.open();
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(flow.isOpen()).toBe(false);
    expect(closes[0].reason).toBe("expired");
    vi.useRealTimers();
  });

  it("re-opening while a window is live returns the same window", () => {
    const flow = new PairingFlow();
    const a = flow.open();
    const b = flow.open();
    expect(a.code).toBe(b.code);
    expect(a.expiresAt.getTime()).toBe(b.expiresAt.getTime());
    flow.close("manual");
  });

  // Regression: the code space is only 10^6 wide and the daemon listens on
  // 0.0.0.0 with a Bonjour advert. Unbounded guessing inside the five-minute
  // window is a feasible LAN attack, and a successful pair yields a durable
  // device token with pane-input rights.
  it("closes the window once the attempt budget is spent", () => {
    const flow = new PairingFlow();
    const closes: any[] = [];
    flow.on("close", (e) => closes.push(e));
    const w = flow.open();
    const wrong = wrongCode(w.code);

    for (let i = 1; i < PAIR_MAX_ATTEMPTS; i++) {
      expect(flow.consume(wrong)).toBe(false);
      expect(flow.isOpen()).toBe(true);
      expect(flow.attemptsRemaining()).toBe(PAIR_MAX_ATTEMPTS - i);
    }

    expect(flow.consume(wrong)).toBe(false);
    expect(flow.isOpen()).toBe(false);
    expect(closes.at(-1).reason).toBe("exhausted");
  });

  it("refuses even the correct code after the window is exhausted", () => {
    const flow = new PairingFlow();
    const w = flow.open();
    for (let i = 0; i < PAIR_MAX_ATTEMPTS; i++) flow.consume(wrongCode(w.code));

    expect(flow.consume(w.code)).toBe(false);
    expect(flow.isOpen()).toBe(false);
  });

  it("gives a fresh budget to a window opened after exhaustion", () => {
    const flow = new PairingFlow();
    const first = flow.open();
    for (let i = 0; i < PAIR_MAX_ATTEMPTS; i++) flow.consume(wrongCode(first.code));
    expect(flow.isOpen()).toBe(false);

    const second = flow.open();
    expect(flow.attemptsRemaining()).toBe(PAIR_MAX_ATTEMPTS);
    expect(flow.consume(second.code)).toBe(true);
  });

  it("does not spend budget on a correct code", () => {
    const flow = new PairingFlow();
    const w = flow.open();
    expect(flow.consume(w.code)).toBe(true);
    expect(flow.attemptsRemaining()).toBe(0); // no window open
  });

  it("reports no remaining attempts when no window is open", () => {
    const flow = new PairingFlow();
    expect(flow.attemptsRemaining()).toBe(0);
  });

  it("rejects non-string codes without throwing or spending the window", () => {
    const flow = new PairingFlow();
    flow.open();
    expect(flow.consume(undefined as unknown as string)).toBe(false);
    expect(flow.consume(123456 as unknown as string)).toBe(false);
    expect(flow.isOpen()).toBe(true);
    flow.close("manual");
  });

  it("rejects a code of the wrong length without throwing", () => {
    // timingSafeEqual throws on length mismatch if called unguarded.
    const flow = new PairingFlow();
    flow.open();
    expect(flow.consume("1")).toBe(false);
    expect(flow.consume("1234567890")).toBe(false);
    expect(flow.isOpen()).toBe(true);
    flow.close("manual");
  });

  // Regression: the daemon used to infer the rejection reason by comparing
  // isOpen() before and after consume(). Both "budget exhausted" and "already
  // expired" leave the window closed, so an expired window was reported as
  // too_many_attempts — telling a user who merely idled that someone was
  // guessing at their code.
  it("reports expiry as expiry, not as a spent attempt budget", () => {
    const flow = new PairingFlow();
    const w = flow.open();
    // Age the window out without firing its timer.
    (w as unknown as { expiresAt: Date }).expiresAt = new Date(Date.now() - 1000);

    expect(flow.attempt(w.code)).toBe("expired");
    expect(flow.isOpen()).toBe(false);
  });

  it("distinguishes every pairing outcome", () => {
    const flow = new PairingFlow();
    expect(flow.attempt("000000")).toBe("no_window_open");

    const w = flow.open();
    const wrong = wrongCode(w.code);
    for (let i = 0; i < PAIR_MAX_ATTEMPTS - 1; i++) {
      expect(flow.attempt(wrong)).toBe("invalid_code");
    }
    expect(flow.attempt(wrong)).toBe("too_many_attempts");
    expect(flow.attempt(w.code)).toBe("no_window_open");

    const second = flow.open();
    expect(flow.attempt(second.code)).toBe("accepted");
  });

  it("keeps consume() as a boolean view of attempt()", () => {
    const flow = new PairingFlow();
    const w = flow.open();
    expect(flow.consume(wrongCode(w.code))).toBe(false);
    expect(flow.consume(w.code)).toBe(true);
  });

  it("clears the stale expiry timer when opening after an expired window", () => {
    vi.useFakeTimers();
    try {
      const flow = new PairingFlow();
      const closes: any[] = [];
      flow.on("close", (e) => closes.push(e));

      const first = flow.open();
      vi.setSystemTime(first.expiresAt.getTime() + 1);
      const second = flow.open();

      expect(second.expiresAt.getTime()).toBeGreaterThan(first.expiresAt.getTime());
      expect(closes).toHaveLength(1);
      expect(closes[0].reason).toBe("expired");

      vi.advanceTimersByTime(1);
      expect(flow.isOpen()).toBe(true);

      vi.advanceTimersByTime(PAIR_WINDOW_MS);
      expect(flow.isOpen()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
