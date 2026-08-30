import { beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  INVITE_DEEP_LINK_PREFIX,
  INVITE_MAX_ATTEMPTS,
  INVITE_PROTOCOL_PROFILE,
  INVITE_SECRET_BYTES,
  INVITE_TTL_MS,
  InviteStore,
  MAX_STORED_INVITES,
  denialMessage,
  deriveHostId,
  encodeInvitePayload,
  inviteSecretVerifier,
  isCanonicalFingerprint,
  parseInvitePayload,
  type InviteEndpoint,
  type InvitePayload,
  type IssuedCredential,
  type RedemptionRequest,
} from "../../src/services/bridge/inviteAuth.js";
import selfsigned from "selfsigned";

// Deterministic test material only: every secret below is synthetic vector
// input, never a real credential (see AGENTS.md "Protected data").

let certPemA = "";
let certPemB = "";

beforeAll(async () => {
  const a = await selfsigned.generate([{ name: "commonName", value: "vector-a" }], { keySize: 2048 });
  const b = await selfsigned.generate([{ name: "commonName", value: "vector-b" }], { keySize: 2048 });
  certPemA = a.cert;
  certPemB = b.cert;
});

const T0 = Date.parse("2026-08-30T00:00:00.000Z");
const HOST_FINGERPRINT = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";

function fixedRandom(seed: number) {
  let counter = seed;
  return (bytes: number): Buffer => {
    const chunks: Buffer[] = [];
    let remaining = bytes;
    while (remaining > 0) {
      counter = (counter * 1103515245 + 12345) >>> 0;
      chunks.push(createHash("sha256").update(`seed-${counter}`).digest());
      remaining -= 32;
    }
    return Buffer.concat(chunks).subarray(0, bytes);
  };
}

interface Harness {
  store: InviteStore;
  setCurrentTime(ms: number): void;
  issued: IssuedCredential[];
  failCredentialWrites: boolean;
}

function makeStore(seed = 7): Harness {
  let currentTime = T0;
  const harness: Harness = {
    issued: [],
    failCredentialWrites: false,
    setCurrentTime(ms: number) {
      currentTime = ms;
    },
    store: null as unknown as InviteStore,
  };
  harness.store = new InviteStore({
    hostId: deriveHostId(certPemA),
    hostFingerprint: HOST_FINGERPRINT,
    now: () => currentTime,
    random: fixedRandom(seed),
    issueCredential: async (request) => {
      if (harness.failCredentialWrites) {
        throw new Error("simulated credential-store failure");
      }
      const credential: IssuedCredential = {
        token: `vector-token-${harness.issued.length}`,
        clientId: request.clientId,
        clientName: request.clientName,
        pairedAt: new Date(currentTime).toISOString(),
      };
      harness.issued.push(credential);
      return credential;
    },
  });
  return harness;
}

function issue(harness: Harness) {
  const endpoints: InviteEndpoint[] = [{ kind: "tcp", host: "192.168.1.10", port: 47123 }];
  const result = harness.store.issue({ hostName: "Vector Host", endpoints });
  if (!result.ok) throw new Error(`issue failed: ${result.code}`);
  return result.invite;
}

function redeemRequest(invite: InvitePayload, overrides: Partial<RedemptionRequest> = {}): RedemptionRequest {
  return {
    hostId: invite.hostId,
    inviteId: invite.inviteId,
    secret: invite.secret,
    clientId: "vector-client",
    clientName: "Vector iPhone",
    protocolProfile: INVITE_PROTOCOL_PROFILE,
    ...overrides,
  };
}

function wrongSecret(i: number): string {
  return Buffer.from(`wrong-secret-vector-${i}-padding-to-32-bytes!`, "utf8")
    .subarray(0, INVITE_SECRET_BYTES)
    .toString("base64url");
}

describe("deriveHostId", () => {
  it("is stable for the same certificate and distinct across certificates", () => {
    const a1 = deriveHostId(certPemA);
    const a2 = deriveHostId(certPemA);
    const b = deriveHostId(certPemB);
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).toMatch(/^h1-[0-9a-f]{32}$/);
  });
});

describe("invite payloads", () => {
  it("round-trip through the deep-link encoding", () => {
    const harness = makeStore();
    const { payload, deepLink } = issue(harness);
    expect(deepLink.startsWith(INVITE_DEEP_LINK_PREFIX)).toBe(true);
    const parsed = parseInvitePayload(deepLink, T0);
    expect(parsed).toEqual({ ok: true, payload });
  });

  it("bind the durable host identity and certificate fingerprint", () => {
    const harness = makeStore();
    const { payload, record } = issue(harness);
    expect(payload.hostId).toBe(record.hostId);
    expect(payload.hostFingerprint).toBe(record.hostFingerprint);
    expect(isCanonicalFingerprint(payload.hostFingerprint)).toBe(true);
  });

  it("reject malformed, oversized, foreign-version, and out-of-bound payloads", () => {
    const harness = makeStore();
    issue(harness);

    expect(parseInvitePayload("not-an-invite").ok).toBe(false);
    expect(parseInvitePayload(`${INVITE_DEEP_LINK_PREFIX}!!!not-base64url###`).ok).toBe(false);

    // 3000 base64url chars decode to ~2250 bytes of JSON: over the payload bound.
    const oversized = `${INVITE_DEEP_LINK_PREFIX}${"A".repeat(3000)}`;
    const oversizedResult = parseInvitePayload(oversized);
    expect(oversizedResult.ok).toBe(false);
    if (!oversizedResult.ok) expect(oversizedResult.code).toBe("invite_oversized");

    const forged = JSON.stringify({
      v: 2, hostId: "h1-0", inviteId: "i1-x", secret: "s",
      hostFingerprint: "AA", hostName: "h", expiresAt: new Date(T0 + 1000).toISOString(),
      protocolProfile: INVITE_PROTOCOL_PROFILE, endpoints: [],
    });
    const forgedLink = `${INVITE_DEEP_LINK_PREFIX}${Buffer.from(forged, "utf8").toString("base64url")}`;
    const forgedResult = parseInvitePayload(forgedLink);
    expect(forgedResult.ok).toBe(false);
    if (!forgedResult.ok) expect(forgedResult.code).toBe("unsupported_invite_version");

    const { payload } = issue(harness);
    const extraField = { ...payload, unexpected: 1 } as unknown as InvitePayload;
    expect(parseInvitePayload(encodeInvitePayload(extraField)).ok).toBe(false);

    const longLived = { ...payload, expiresAt: new Date(T0 + INVITE_TTL_MS + 10 * 60 * 1000).toISOString() };
    expect(parseInvitePayload(encodeInvitePayload(longLived), T0).ok).toBe(false);

    const badPort = { ...payload, endpoints: [{ kind: "tcp" as const, host: "192.168.1.10", port: 0 }] };
    expect(parseInvitePayload(encodeInvitePayload(badPort)).ok).toBe(false);

    const expired = parseInvitePayload(encodeInvitePayload(payload), T0 + INVITE_TTL_MS + 1);
    expect(expired.ok).toBe(false);
  });
});

describe("redemption", () => {
  it("commits exactly once; the replay receives a deterministic denial", async () => {
    const harness = makeStore();
    const { payload } = issue(harness);

    const first = await harness.store.redeem(redeemRequest(payload));
    expect(first.ok).toBe(true);
    expect(harness.issued).toHaveLength(1);

    const replay = await harness.store.redeem(redeemRequest(payload));
    expect(replay).toEqual({ ok: false, code: "invite_already_redeemed" });
    expect(harness.issued).toHaveLength(1);
  });

  it("serializes concurrent redemptions to a single commit", async () => {
    const harness = makeStore();
    const { payload } = issue(harness);

    const attempts = await Promise.all([
      harness.store.redeem(redeemRequest(payload)),
      harness.store.redeem(redeemRequest(payload)),
      harness.store.redeem(redeemRequest(payload)),
    ]);
    const accepted = attempts.filter((r) => r.ok);
    const denied = attempts.filter((r): r is Extract<typeof r, { ok: false }> => !r.ok);
    expect(accepted).toHaveLength(1);
    expect(denied.every((r) => r.code === "invite_already_redeemed")).toBe(true);
    expect(harness.issued).toHaveLength(1);
  });

  it("exhausts the attempt budget and denies the true secret afterwards", async () => {
    const harness = makeStore();
    const { payload } = issue(harness);

    for (let i = 0; i < INVITE_MAX_ATTEMPTS; i += 1) {
      const result = await harness.store.redeem(redeemRequest(payload, { secret: wrongSecret(i) }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(i === INVITE_MAX_ATTEMPTS - 1 ? "invite_attempts_exhausted" : "invite_secret_mismatch");
      }
    }
    const withTrueSecret = await harness.store.redeem(redeemRequest(payload));
    expect(withTrueSecret).toEqual({ ok: false, code: "invite_attempts_exhausted" });
    expect(harness.issued).toHaveLength(0);
    expect(harness.store.pendingInvite()).toBeNull();
    const tail = harness.store.list().find((r) => r.inviteId === payload.inviteId);
    expect(tail?.status).toBe("exhausted");
  });

  it("denies an expired invite without consuming attempts", async () => {
    const harness = makeStore();
    const { payload } = issue(harness);
    harness.setCurrentTime(T0 + INVITE_TTL_MS + 1);
    const result = await harness.store.redeem(redeemRequest(payload));
    expect(result).toEqual({ ok: false, code: "invite_expired" });
    expect(harness.issued).toHaveLength(0);
  });

  it("supersedes the previous pending invite on the next issuance", async () => {
    const harness = makeStore();
    const first = issue(harness);
    const second = issue(harness);

    const stale = await harness.store.redeem(redeemRequest(first.payload));
    expect(stale).toEqual({ ok: false, code: "invite_revoked" });

    const fresh = await harness.store.redeem(redeemRequest(second.payload));
    expect(fresh.ok).toBe(true);
    expect(harness.store.pendingInvite()).toBeNull();
  });

  it("honours explicit revocation", async () => {
    const harness = makeStore();
    const { payload, record } = issue(harness);
    expect(harness.store.revoke(record.inviteId)).toBe(true);
    const result = await harness.store.redeem(redeemRequest(payload));
    expect(result).toEqual({ ok: false, code: "invite_revoked" });
    expect(harness.issued).toHaveLength(0);
  });

  it("fails closed on a foreign host id with the same denial as an unknown invite", async () => {
    const harness = makeStore();
    const { payload } = issue(harness);
    const foreignResult = await harness.store.redeem(
      redeemRequest(payload, { hostId: "h1-00000000000000000000000000000000" }),
    );
    const unknownResult = await harness.store.redeem(
      redeemRequest(payload, { inviteId: "i1-aaaaaaaaaaaaaaaaaaaaaa" }),
    );
    expect(foreignResult).toEqual(unknownResult);
    expect(foreignResult).toEqual({ ok: false, code: "unknown_invite" });
  });

  it("refuses protocol downgrade", async () => {
    const harness = makeStore();
    const { payload } = issue(harness);
    const result = await harness.store.redeem(redeemRequest(payload, { protocolProfile: "bridge.v2" }));
    expect(result).toEqual({ ok: false, code: "profile_mismatch" });
    expect(harness.issued).toHaveLength(0);
  });

  it("fails closed when the credential store fails and never re-arms the invite", async () => {
    const harness = makeStore();
    const { payload } = issue(harness);
    harness.failCredentialWrites = true;

    const failed = await harness.store.redeem(redeemRequest(payload));
    expect(failed).toEqual({ ok: false, code: "credential_store_unavailable" });
    expect(harness.issued).toHaveLength(0);

    harness.failCredentialWrites = false;
    const retry = await harness.store.redeem(redeemRequest(payload));
    expect(retry).toEqual({ ok: false, code: "invite_already_redeemed" });
    expect(harness.issued).toHaveLength(0);
  });

  it("rejects malformed requests before touching records", async () => {
    const harness = makeStore();
    const { payload } = issue(harness);
    const badClientId = redeemRequest(payload, { clientId: "bad client id with spaces" });
    const controlChars = redeemRequest(payload, { clientName: "iPhone\nmalicious" });
    const badSecret = redeemRequest(payload, { secret: "short" });
    expect(await harness.store.redeem(badClientId)).toEqual({ ok: false, code: "malformed_request" });
    expect(await harness.store.redeem(controlChars)).toEqual({ ok: false, code: "malformed_request" });
    expect(await harness.store.redeem(badSecret)).toEqual({ ok: false, code: "malformed_request" });
    expect(harness.store.pendingInvite()?.inviteId).toBe(payload.inviteId);
  });
});

describe("secret hygiene", () => {
  it("never stores, logs, or echoes the secret", async () => {
    const harness = makeStore();
    const { payload, record, deepLink } = issue(harness);

    // The record is what the host retains: verifier only.
    const recordJson = JSON.stringify(harness.store.list());
    expect(recordJson).not.toContain(payload.secret);
    expect(record.secretVerifier).toBe(inviteSecretVerifier(payload.hostId, payload.inviteId, payload.secret));
    expect(recordJson).toContain(record.secretVerifier);

    // Denial messages are fixed strings with no interpolation.
    const codes = [
      "unknown_invite", "invite_expired", "invite_revoked", "invite_already_redeemed",
      "invite_attempts_exhausted", "invite_secret_mismatch", "profile_mismatch",
      "malformed_request", "credential_store_unavailable",
    ] as const;
    for (const code of codes) {
      expect(denialMessage(code)).not.toContain(payload.secret);
      expect(denialMessage(code)).toMatch(/^[^{}]*$/);
    }

    // Redemption results never carry the secret either.
    const result = await harness.store.redeem(redeemRequest(payload, { secret: wrongSecret(99) }));
    expect(JSON.stringify(result)).not.toContain(payload.secret);
    // The transfer object is the sole carrier of the secret: the deep link
    // decodes to JSON containing it, and nothing else in the module's outputs does.
    const decoded = Buffer.from(deepLink.slice(INVITE_DEEP_LINK_PREFIX.length), "base64url").toString("utf8");
    expect(JSON.parse(decoded).secret).toBe(payload.secret);
  });

  it("bounds retained records while every issuance supersedes the previous one", () => {
    const harness = makeStore();
    for (let i = 0; i < MAX_STORED_INVITES + 4; i += 1) {
      const result = harness.store.issue({ hostName: "h", endpoints: [{ kind: "tcp", host: "h", port: 1 }] });
      expect(result.ok).toBe(true);
    }
    expect(harness.store.list().length).toBeLessThanOrEqual(MAX_STORED_INVITES);
  });
});
