import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  INVITE_AUTH_CANONICAL_FIXTURE,
  INVITE_AUTH_DENIAL_FIXTURE,
  INVITE_AUTH_EXPIRY_FIXTURE,
  INVITE_AUTH_REPLAY_FIXTURE,
  type CanonicalInviteFixture,
  type InviteRedemptionFixture,
} from "../../protocol-fixtures/fixtures.js";
import { serialize } from "../../scripts/generate-protocol-fixtures.js";
import {
  INVITE_DEEP_LINK_PREFIX,
  INVITE_MAX_ATTEMPTS,
  INVITE_PROTOCOL_PROFILE,
  INVITE_SECRET_BYTES,
  INVITE_TTL_MS,
  InviteStore,
  MAX_INVITE_PAYLOAD_BYTES,
  MAX_STORED_INVITES,
  denialMessage,
  encodeInvitePayload,
  inviteSecretVerifier,
  isCanonicalFingerprint,
  parseInvitePayload,
  type InviteEndpoint,
  type InvitePayload,
  type IssuedCredential,
  type IssueInviteInput,
  type RedemptionRequest,
} from "../../src/services/bridge/inviteAuth.js";

// Deterministic test material only: every secret below is synthetic vector
// input, never a real credential (see AGENTS.md "Protected data").

const T0 = Date.parse("2026-08-30T00:00:00.000Z");
const HOST_ID = "host-identity-owned-outside-psyche-build";
const HOST_FINGERPRINT = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
const INVITE_FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../protocol-fixtures/invite-auth/v1",
);

function loadInviteFixture<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(INVITE_FIXTURE_DIR, file), "utf8")) as T;
}

function fixtureStore(
  canonical: CanonicalInviteFixture,
  credential: IssuedCredential,
  now: () => number,
): InviteStore {
  const randomValues = [
    Buffer.from(canonical.random.inviteIdBytes, "base64url"),
    Buffer.from(canonical.random.secretBytes, "base64url"),
  ];
  return new InviteStore({
    ...canonical.store,
    now,
    random: (bytes) => {
      const value = randomValues.shift();
      if (!value || value.length !== bytes) throw new Error("fixture randomness does not match requested bytes");
      return value;
    },
    issueCredential: async () => credential,
  });
}

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
    hostId: HOST_ID,
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

describe("invite payloads", () => {
  it("refuses invalid host binding inputs before issuing", () => {
    expect(() => new InviteStore({
      hostId: "",
      hostFingerprint: HOST_FINGERPRINT,
    })).toThrow(TypeError);
    expect(() => new InviteStore({
      hostId: HOST_ID,
      hostFingerprint: "not-a-fingerprint",
    })).toThrow(TypeError);
  });

  it("round-trip through the deep-link encoding", () => {
    const harness = makeStore();
    const { payload, deepLink } = issue(harness);
    expect(deepLink.startsWith(INVITE_DEEP_LINK_PREFIX)).toBe(true);
    const parsed = parseInvitePayload(deepLink, T0);
    expect(parsed).toEqual({ ok: true, payload });
  });

  it("binds the supplied host identity and certificate fingerprint", () => {
    const harness = makeStore();
    const { payload, record } = issue(harness);
    expect(payload.hostId).toBe(record.hostId);
    expect(payload.hostFingerprint).toBe(record.hostFingerprint);
    expect(isCanonicalFingerprint(payload.hostFingerprint)).toBe(true);
  });

  it("preserves an opaque host identity supplied by its canonical owner", () => {
    const hostId = HOST_ID;
    const store = new InviteStore({
      hostId,
      hostFingerprint: HOST_FINGERPRINT,
      now: () => T0,
      random: fixedRandom(11),
    });
    const result = store.issue({
      hostName: "Opaque Identity Host",
      endpoints: [{ kind: "tcp", host: "192.0.2.11", port: 47123 }],
    });
    if (!result.ok) throw new Error(`issue failed: ${result.code}`);

    expect(result.invite.payload.hostId).toBe(hostId);
    expect(parseInvitePayload(result.invite.deepLink, T0)).toEqual({
      ok: true,
      payload: result.invite.payload,
    });
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

    const wrongProfile = { ...payload, protocolProfile: "bridge.v2" };
    expect(parseInvitePayload(encodeInvitePayload(wrongProfile), T0)).toEqual({
      ok: false,
      code: "invite_invalid_field",
    });

    const badPort = { ...payload, endpoints: [{ kind: "tcp" as const, host: "192.168.1.10", port: 0 }] };
    expect(parseInvitePayload(encodeInvitePayload(badPort)).ok).toBe(false);

    const endpointWithExtraField = JSON.stringify({
      ...payload,
      endpoints: [{ kind: "tcp", host: "192.168.1.10", port: 47123, token: "must-not-be-ignored" }],
    });
    const endpointWithExtraFieldLink =
      `${INVITE_DEEP_LINK_PREFIX}${Buffer.from(endpointWithExtraField, "utf8").toString("base64url")}`;
    expect(parseInvitePayload(endpointWithExtraFieldLink, T0)).toEqual({
      ok: false,
      code: "invite_invalid_field",
    });

    const expired = parseInvitePayload(encodeInvitePayload(payload), T0 + INVITE_TTL_MS + 1);
    expect(expired.ok).toBe(false);
  });

  it("refuses issuer input that would create an invalid transfer payload", () => {
    const harness = makeStore();
    const validEndpoint: InviteEndpoint = { kind: "tcp", host: "192.0.2.10", port: 47123 };
    const invalidInputs: IssueInviteInput[] = [
      { hostName: "", endpoints: [validEndpoint] },
      { hostName: "x".repeat(129), endpoints: [validEndpoint] },
      { hostName: "host\nname", endpoints: [validEndpoint] },
      { hostName: "host", endpoints: Array.from({ length: 5 }, () => validEndpoint) },
      { hostName: "host", endpoints: [{ kind: "tcp", host: "x".repeat(254), port: 47123 }] },
      { hostName: "host", endpoints: [{ kind: "tcp", host: "192.0.2.10", port: 0 }] },
    ];

    for (const input of invalidInputs) {
      expect(() => harness.store.issue(input)).toThrow(TypeError);
    }
  });

  it("rejects oversized Unicode payloads without replacing the usable pending invite", () => {
    const harness = makeStore();
    const prior = issue(harness);
    const recordsBefore = harness.store.list();
    expect(parseInvitePayload(prior.deepLink, T0)).toEqual({ ok: true, payload: prior.payload });

    const unicodeHost = "界".repeat(252);
    expect(() => harness.store.issue({
      hostName: "🌐".repeat(64),
      endpoints: Array.from(
        { length: 4 },
        (_, index): InviteEndpoint => ({ kind: "tcp", host: `${unicodeHost}${index}`, port: 47123 + index }),
      ),
    })).toThrow(TypeError);

    expect(harness.store.pendingInvite()).toEqual(prior.record);
    expect(harness.store.list()).toEqual(recordsBefore);
    expect(parseInvitePayload(prior.deepLink, T0)).toEqual({ ok: true, payload: prior.payload });
  });

  it("rejects an encoded payload that cannot fit before base64 decoding", () => {
    const maximumEncodedLength = Math.ceil(MAX_INVITE_PAYLOAD_BYTES * 4 / 3);
    const oversized = `${INVITE_DEEP_LINK_PREFIX}${"A".repeat(maximumEncodedLength + 1)}`;
    const decode = vi.spyOn(Buffer, "from");

    try {
      expect(parseInvitePayload(oversized)).toEqual({ ok: false, code: "invite_oversized" });
      expect(decode).not.toHaveBeenCalled();
    } finally {
      decode.mockRestore();
    }
  });
});

describe("canonical invite-auth protocol fixtures", () => {
  it.each([
    ["canonical-invite.json", INVITE_AUTH_CANONICAL_FIXTURE],
    ["denials.json", INVITE_AUTH_DENIAL_FIXTURE],
    ["expiry.json", INVITE_AUTH_EXPIRY_FIXTURE],
    ["replay.json", INVITE_AUTH_REPLAY_FIXTURE],
  ])("keeps %s synchronized with its typed source", (file, source) => {
    expect(fs.readFileSync(path.join(INVITE_FIXTURE_DIR, file), "utf8")).toBe(serialize(source));
  });

  it("pins canonical invite generation and parsing", () => {
    const canonical = loadInviteFixture<CanonicalInviteFixture>("canonical-invite.json");
    const now = Date.parse(canonical.now);
    const store = fixtureStore(
      canonical,
      {
        token: "unused-canonical-token",
        clientId: "unused-canonical-client",
        clientName: "Unused Canonical Client",
        pairedAt: canonical.now,
      },
      () => now,
    );

    const issued = store.issue(canonical.issue);
    expect(issued).toEqual({ ok: true, invite: canonical.expected });
    expect(parseInvitePayload(canonical.expected.deepLink, now)).toEqual({
      ok: true,
      payload: canonical.expected.payload,
    });
  });

  it("drives replay denial from the checked-in vector", async () => {
    const canonical = loadInviteFixture<CanonicalInviteFixture>("canonical-invite.json");
    const replay = loadInviteFixture<InviteRedemptionFixture>("replay.json");
    expect(replay.canonicalFixture).toBe("canonical-invite.json");

    let now = Date.parse(canonical.now);
    const store = fixtureStore(canonical, replay.credential, () => now);
    const issued = store.issue(canonical.issue);
    if (!issued.ok) throw new Error(`fixture issue failed: ${issued.code}`);
    const request = redeemRequest(issued.invite.payload, replay.request);

    const results = [
      await store.redeem(request),
      await store.redeem(request),
    ];
    expect(results).toEqual(replay.expected);
  });

  it("drives expiry denial from the checked-in vector", async () => {
    const canonical = loadInviteFixture<CanonicalInviteFixture>("canonical-invite.json");
    const expiry = loadInviteFixture<InviteRedemptionFixture>("expiry.json");
    expect(expiry.canonicalFixture).toBe("canonical-invite.json");
    if (!expiry.redeemAt) throw new Error("expiry fixture must declare redeemAt");

    let now = Date.parse(canonical.now);
    const store = fixtureStore(canonical, expiry.credential, () => now);
    const issued = store.issue(canonical.issue);
    if (!issued.ok) throw new Error(`fixture issue failed: ${issued.code}`);
    now = Date.parse(expiry.redeemAt);

    expect([await store.redeem(redeemRequest(issued.invite.payload, expiry.request))])
      .toEqual(expiry.expected);
  });

  it("pins every structured denial code and safe message", () => {
    const denials = loadInviteFixture<Record<string, string>>("denials.json");
    expect(denials).toEqual({
      credential_store_unavailable: denialMessage("credential_store_unavailable"),
      invite_already_redeemed: denialMessage("invite_already_redeemed"),
      invite_attempts_exhausted: denialMessage("invite_attempts_exhausted"),
      invite_expired: denialMessage("invite_expired"),
      invite_revoked: denialMessage("invite_revoked"),
      invite_secret_mismatch: denialMessage("invite_secret_mismatch"),
      malformed_request: denialMessage("malformed_request"),
      profile_mismatch: denialMessage("profile_mismatch"),
      unknown_invite: denialMessage("unknown_invite"),
    });
  });
});

describe("redemption", () => {
  it("does not expose mutable references to stored invite records", async () => {
    const harness = makeStore();
    const invite = issue(harness);

    invite.record.status = "revoked";
    const pending = harness.store.pendingInvite();
    expect(pending).not.toBeNull();
    if (!pending) throw new Error("expected a pending invite");
    pending.status = "revoked";

    expect((await harness.store.redeem(redeemRequest(invite.payload))).ok).toBe(true);
  });

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
