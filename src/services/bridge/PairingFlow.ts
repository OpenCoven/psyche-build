import { randomInt, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";

export const PAIR_WINDOW_MS = 5 * 60 * 1000;
export const PAIR_CODE_LENGTH = 6;

/**
 * Wrong codes tolerated before the window is torn down.
 *
 * A pairing code is only 10^6 values wide, and the daemon listens on
 * 0.0.0.0 with a Bonjour advert pointing at it. Without a cap, anyone on the
 * LAN can enumerate the whole space inside the five-minute window — over many
 * parallel connections that is seconds, not hours — and a successful pair
 * yields a long-lived device token with pane-input rights, i.e. arbitrary
 * commands in the user's terminals.
 *
 * Five attempts keeps a mistyped code forgiving while cutting a brute force
 * to a 5-in-a-million chance per window. Exhaustion closes the window, so the
 * host has to consciously re-open it (`:pair`) for another attempt.
 */
export const PAIR_MAX_ATTEMPTS = 5;

export type PairCloseReason = "expired" | "consumed" | "manual" | "exhausted";

export interface PairWindow {
  code: string;
  expiresAt: Date;
}

/**
 * Pairing state machine. At most one window open at a time. `:pair` opens
 * the window; submitting the right code closes it. The daemon broadcasts
 * `pairChallenge` to every unauthenticated session whenever a window opens.
 *
 * Events:
 *   'open'  → (window: PairWindow)
 *   'close' → ({ window: PairWindow, reason: PairCloseReason })
 */
export class PairingFlow extends EventEmitter {
  private current: PairWindow | null = null;
  private timer: NodeJS.Timeout | null = null;
  private attempts = 0;

  open(): PairWindow {
    if (this.current && this.current.expiresAt > new Date()) {
      return this.current;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.current) {
      const expired = this.current;
      this.current = null;
      this.emit("close", { window: expired, reason: "expired" });
    }
    const code = randomInt(0, 1_000_000).toString().padStart(PAIR_CODE_LENGTH, "0");
    const expiresAt = new Date(Date.now() + PAIR_WINDOW_MS);
    this.current = { code, expiresAt };
    this.attempts = 0;
    this.timer = setTimeout(() => this.close("expired"), PAIR_WINDOW_MS);
    this.emit("open", this.current);
    return this.current;
  }

  /**
   * Returns true iff `code` matches the open window. Consumes the window on
   * success; closes it as "exhausted" once PAIR_MAX_ATTEMPTS codes have been
   * rejected.
   */
  consume(code: string): boolean {
    if (!this.current) return false;
    if (this.current.expiresAt <= new Date()) {
      this.close("expired");
      return false;
    }
    if (!codesMatch(this.current.code, code)) {
      this.attempts += 1;
      if (this.attempts >= PAIR_MAX_ATTEMPTS) this.close("exhausted");
      return false;
    }
    this.close("consumed");
    return true;
  }

  /** Wrong codes still tolerated on the open window; 0 when no window is open. */
  attemptsRemaining(): number {
    if (!this.current) return 0;
    return Math.max(0, PAIR_MAX_ATTEMPTS - this.attempts);
  }

  isOpen(): boolean {
    return !!this.current;
  }

  peek(): PairWindow | null {
    return this.current;
  }

  close(reason: PairCloseReason): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.attempts = 0;
    if (this.current) {
      const w = this.current;
      this.current = null;
      this.emit("close", { window: w, reason });
    }
  }
}

/**
 * Constant-time code comparison.
 *
 * Codes are short and the window is now attempt-capped, so a timing oracle is
 * not the primary risk — but comparing secrets with `!==` leaks a per-digit
 * signal for free, and `timingSafeEqual` costs nothing here.
 */
function codesMatch(expected: string, supplied: unknown): boolean {
  if (typeof supplied !== "string") return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(supplied, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
