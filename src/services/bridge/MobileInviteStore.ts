import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const MOBILE_INVITE_TTL_MS = 5 * 60 * 1000;
export const MAX_MOBILE_INVITES = 128;

export interface MobileInviteIssueInput {
  endpoint: string;
  ttlMs?: number;
}

export interface MobileInvite {
  token: string;
  expiresAt: Date;
}

export interface RedeemedMobileInvite {
  endpoint: string;
  inviteId: string;
}

/** A non-reversible identifier for matching an invite without exposing it. */
export function mobileInviteId(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

interface InviteRecord {
  endpoint: string;
  expiresAt: number;
}

/**
 * Ephemeral, single-use mobile invites.
 *
 * Tokens are HMAC-signed envelopes. Only a hash of the random nonce is kept
 * in memory, so neither raw invite values nor endpoint records survive a
 * process restart.
 */
export class MobileInviteStore {
  private readonly signingKey = randomBytes(32);
  private readonly invites = new Map<string, InviteRecord>();

  issue({ endpoint, ttlMs = MOBILE_INVITE_TTL_MS }: MobileInviteIssueInput): MobileInvite {
    const now = Date.now();
    this.removeExpired(now);
    const expiresAt = now + ttlMs;
    const nonce = randomBytes(32).toString("base64url");
    const token = `${nonce}.${expiresAt}.${this.signature(nonce, expiresAt)}`;

    this.invites.set(this.nonceHash(nonce), { endpoint, expiresAt });
    this.trimToCapacity();
    return { token, expiresAt: new Date(expiresAt) };
  }

  redeem(token: unknown): RedeemedMobileInvite | null {
    if (typeof token !== "string") return null;
    const parsed = this.parse(token);
    if (!parsed) return null;

    const now = Date.now();
    this.removeExpired(now);
    if (parsed.expiresAt <= now || !this.signaturesMatch(parsed)) return null;

    const nonceHash = this.nonceHash(parsed.nonce);
    const record = this.invites.get(nonceHash);
    if (!record || record.expiresAt !== parsed.expiresAt || record.expiresAt <= now) return null;

    this.invites.delete(nonceHash);
    return { endpoint: record.endpoint, inviteId: mobileInviteId(token) };
  }

  private parse(token: unknown): { nonce: string; expiresAt: number; signature: string } | null {
    if (typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [nonce, expiresAtText, signature] = parts;
    const expiresAt = Number(expiresAtText);
    if (!nonce || !signature || !Number.isSafeInteger(expiresAt) || expiresAt < 0) return null;
    return { nonce, expiresAt, signature };
  }

  private signaturesMatch({ nonce, expiresAt, signature }: { nonce: string; expiresAt: number; signature: string }): boolean {
    if (!/^[A-Za-z0-9_-]+$/.test(signature)) return false;
    const expected = Buffer.from(this.signature(nonce, expiresAt), "base64url");
    let supplied: Buffer;
    try {
      supplied = Buffer.from(signature, "base64url");
    } catch {
      return false;
    }
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  }

  private signature(nonce: string, expiresAt: number): string {
    return createHmac("sha256", this.signingKey)
      .update(`${nonce}.${expiresAt}`)
      .digest("base64url");
  }

  private nonceHash(nonce: string): string {
    return createHash("sha256").update(nonce).digest("hex");
  }

  private removeExpired(now: number): void {
    for (const [nonceHash, record] of this.invites) {
      if (record.expiresAt <= now) this.invites.delete(nonceHash);
    }
  }

  private trimToCapacity(): void {
    while (this.invites.size > MAX_MOBILE_INVITES) {
      const oldest = this.invites.keys().next().value;
      if (!oldest) return;
      this.invites.delete(oldest);
    }
  }
}
