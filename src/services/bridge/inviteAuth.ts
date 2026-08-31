import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Single-use iOS invite authentication — protocol contract and reference logic.
 *
 * This module is the typed source of truth for issue #280 slice 1 ("Protocol
 * and fixtures"): the invite record shapes, the bounds, the redemption state
 * machine, and the deterministic denial outcomes. It is deliberately pure:
 * no sockets, no filesystem, no UI. Wiring it into `BridgeDaemon` is slice 2
 * ("Desktop issuer/consumer"); the design record lives at
 * `docs/superpowers/specs/2026-08-30-ios-invite-auth-contract-design.md`.
 *
 * Invariants this module enforces (each pinned by a vector in
 * `__tests__/bridge/inviteAuth.test.ts`):
 *
 * 1. The host never persists or logs the invite secret. Storage keeps only a
 *    domain-separated SHA-256 verifier; the secret exists only inside the
 *    issued `InvitePayload` (the QR/deep-link transfer object) and the
 *    caller's memory until redemption.
 * 2. Exactly one redemption commits. The store serializes redemptions through
 *    a single-writer queue (same discipline as `TokenStore.mutate` and
 *    `mutateBridgeConfig`), marks the invite `redeemed` before awaiting
 *    credential issuance, and never returns an invite to `pending`.
 * 3. Every failed path yields a fixed, structured denial code whose message
 *    contains no secret material and no oracle about *why* beyond the code.
 * 4. Invites are bound to an opaque host identity supplied by its canonical
 *    owner, the pinned TLS certificate fingerprint, and one protocol profile;
 *    wrong-host and downgrade attempts fail closed. This slice does not claim
 *    ownership of durable host identity while the upstream decision is open.
 * 5. Guessing the secret is bounded: an attempt budget tears the invite down
 *    after `INVITE_MAX_ATTEMPTS` wrong presentations, mirroring
 *    `PairingFlow`'s exhausted-window rule (`docs/BRIDGE-SECURITY.md` rule 3).
 */

// ---------------------------------------------------------------------------
// Bounds and fixed protocol identifiers
// ---------------------------------------------------------------------------

/**
 * The one protocol profile an invite can be redeemed under. Invite-based
 * pairing never negotiates down: `LEGACY_PROTOCOL_VERSION` (see
 * `wireProtocol.ts`) is out of scope for this path by construction.
 */
export const INVITE_PROTOCOL_PROFILE = "bridge.v3";

/** How long an invite may live once issued. Bounded, not tunable per invite. */
export const INVITE_TTL_MS = 10 * 60 * 1000;

/** Entropy of the invite secret. 256-bit random, same class as the daemon token. */
export const INVITE_SECRET_BYTES = 32;

/** Identifier entropy (public half of the invite). */
export const INVITE_ID_BYTES = 16;

/**
 * Wrong presentations tolerated before the invite tears itself down. Mirrors
 * `PAIR_MAX_ATTEMPTS` in `PairingFlow.ts`: a 256-bit secret does not need the
 * cap for entropy reasons, but the cap converts a client bug or a hostile
 * relay into a deterministic, observable denial instead of silent probing.
 */
export const INVITE_MAX_ATTEMPTS = 5;

/**
 * Upper bound on retained invite records (audit tail). At most one invite is
 * live (pending) at a time; issuing a new one supersedes the previous one.
 * The tail is pruned to this bound; if pruning cannot make room, issuance
 * fails closed instead of growing unbounded.
 */
export const MAX_STORED_INVITES = 16;

/** The encoded QR/deep-link transfer object is refused above this size. */
export const MAX_INVITE_PAYLOAD_BYTES = 2048;

/** Maximum unpadded base64url characters that can decode to the payload bound. */
export const MAX_INVITE_PAYLOAD_ENCODED_CHARS = Math.ceil(MAX_INVITE_PAYLOAD_BYTES * 4 / 3);

/** Deep-link scheme prefix for the discovery payload. QR carries the same string. */
export const INVITE_DEEP_LINK_PREFIX = "psyc://invite/v1/";

/** Clock skew tolerated when validating a client-held payload's expiry bound. */
export const INVITE_CLOCK_SKEW_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// Invite records and transfer payload
// ---------------------------------------------------------------------------

export type InviteStatus = "pending" | "redeemed" | "revoked" | "exhausted";

/**
 * What the host stores. There is no secret field here — only
 * `secretVerifier`, a domain-separated digest of the secret. Never widen this
 * record to carry the secret; the QR/deep-link payload is the sole carrier.
 */
export interface InviteRecord {
  inviteId: string;
  hostId: string;
  hostFingerprint: string;
  protocolProfile: string;
  secretVerifier: string;
  issuedAt: string;
  expiresAt: string;
  status: InviteStatus;
  attemptsUsed: number;
}

/**
 * Discovery data + the one-time secret, encoded into a QR code or deep link.
 * Discovery addresses (Bonjour `_psyche._tcp` TXT, endpoint lists here) are
 * routing hints only; the identity-binding fields are `hostId` and
 * `hostFingerprint`. Runtime instances must never be persisted, logged, or
 * placed in accessibility output, screenshots, captured fixtures, or crash
 * reports; checked-in contract fixtures use fixed public synthetic values.
 */
export interface InvitePayload {
  v: 1;
  hostId: string;
  hostFingerprint: string;
  hostName: string;
  inviteId: string;
  secret: string;
  expiresAt: string;
  protocolProfile: string;
  endpoints: InviteEndpoint[];
}

/** Routing hint. Address changes never change host identity. */
export interface InviteEndpoint {
  kind: "tcp";
  host: string;
  port: number;
}

export interface IssuedInvite {
  record: InviteRecord;
  payload: InvitePayload;
  /** The exact string to render as a QR code / deep link. */
  deepLink: string;
}

export interface IssueInviteInput {
  hostName: string;
  endpoints: InviteEndpoint[];
}

// ---------------------------------------------------------------------------
// Redemption
// ---------------------------------------------------------------------------

export interface RedemptionRequest {
  hostId: string;
  inviteId: string;
  secret: string;
  clientId: string;
  clientName: string;
  protocolProfile: string;
}

/** The durable credential — the only artifact pairing is allowed to produce. */
export interface IssuedCredential {
  token: string;
  clientId: string;
  clientName: string;
  pairedAt: string;
}

/**
 * Deterministic denial codes. The code is the whole story a client gets:
 * messages built from `denialMessage` are fixed strings, so no denial path
 * can echo the secret or leak record internals.
 */
export type InviteDenialCode =
  | "unknown_invite"
  | "invite_expired"
  | "invite_revoked"
  | "invite_already_redeemed"
  | "invite_attempts_exhausted"
  | "invite_secret_mismatch"
  | "profile_mismatch"
  | "malformed_request"
  | "credential_store_unavailable";

export type InviteRedemptionResult =
  | { ok: true; credential: IssuedCredential }
  | { ok: false; code: InviteDenialCode };

/** User-safe, secret-free wording for each denial code. */
export function denialMessage(code: InviteDenialCode): string {
  switch (code) {
    case "unknown_invite":
      return "This invite is not valid for this host.";
    case "invite_expired":
      return "This invite has expired. Ask the host for a new one.";
    case "invite_revoked":
      return "This invite was revoked. Ask the host for a new one.";
    case "invite_already_redeemed":
      return "This invite was already used. Ask the host for a new one.";
    case "invite_attempts_exhausted":
      return "Too many failed attempts with this invite. Ask the host for a new one.";
    case "invite_secret_mismatch":
      return "The invite did not match. Check it and try again.";
    case "profile_mismatch":
      return "This invite requires a newer app version. Update and try again.";
    case "malformed_request":
      return "The pairing request was malformed.";
    case "credential_store_unavailable":
      return "The host could not store the credential. Ask for a new invite.";
  }
}

// ---------------------------------------------------------------------------
// Encoded payload (QR / deep link)
// ---------------------------------------------------------------------------

export type InviteParseResult =
  | { ok: true; payload: InvitePayload }
  | { ok: false; code: "malformed_invite" | "unsupported_invite_version" | "invite_oversized" | "invite_expired" | "invite_invalid_field" };

/**
 * Encode the transfer object. The wire form is
 * `psyc://invite/v1/<base64url(canonical JSON)>`; canonical JSON means the
 * fixed field order of `InvitePayload` serialized by `JSON.stringify`, so
 * byte-identical payloads can be asserted in contract tests.
 */
export function encodeInvitePayload(payload: InvitePayload): string {
  const json = JSON.stringify(canonicalInviteJson(payload));
  return INVITE_DEEP_LINK_PREFIX + Buffer.from(json, "utf8").toString("base64url");
}

/**
 * Strict, fail-closed decode. Rejects oversize input before decoding, unknown
 * versions, unknown or missing fields, out-of-bound field shapes, an expiry
 * beyond the issuance bound, and payloads already expired at parse time.
 */
export function parseInvitePayload(raw: string, now: number = Date.now()): InviteParseResult {
  if (typeof raw !== "string" || !raw.startsWith(INVITE_DEEP_LINK_PREFIX)) {
    return { ok: false, code: "malformed_invite" };
  }
  const encoded = raw.slice(INVITE_DEEP_LINK_PREFIX.length);
  if (encoded.length === 0 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    return { ok: false, code: "malformed_invite" };
  }
  if (encoded.length > MAX_INVITE_PAYLOAD_ENCODED_CHARS) {
    return { ok: false, code: "invite_oversized" };
  }
  const json = Buffer.from(encoded, "base64url").toString("utf8");
  if (Buffer.byteLength(json, "utf8") > MAX_INVITE_PAYLOAD_BYTES) {
    return { ok: false, code: "invite_oversized" };
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { ok: false, code: "malformed_invite" };
  }
  if (!isPlainObject(value)) {
    return { ok: false, code: "malformed_invite" };
  }
  if (value.v !== 1) {
    return { ok: false, code: "unsupported_invite_version" };
  }
  const expectedFields = [
    "v", "hostId", "hostFingerprint", "hostName", "inviteId",
    "secret", "expiresAt", "protocolProfile", "endpoints",
  ];
  for (const key of Object.keys(value)) {
    if (!expectedFields.includes(key)) {
      return { ok: false, code: "invite_invalid_field" };
    }
  }
  const hostId = value.hostId;
  const inviteId = value.inviteId;
  const secret = value.secret;
  const hostFingerprint = value.hostFingerprint;
  const hostName = value.hostName;
  const expiresAt = value.expiresAt;
  const protocolProfile = value.protocolProfile;
  const endpoints = value.endpoints;
  if (!isValidHostId(hostId)) {
    return { ok: false, code: "invite_invalid_field" };
  }
  if (typeof inviteId !== "string" || !/^i1-[A-Za-z0-9_-]{22}$/.test(inviteId)) {
    return { ok: false, code: "invite_invalid_field" };
  }
  if (typeof secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
    return { ok: false, code: "invite_invalid_field" };
  }
  if (typeof hostFingerprint !== "string" || !isCanonicalFingerprint(hostFingerprint)) {
    return { ok: false, code: "invite_invalid_field" };
  }
  if (!isValidDisplayName(hostName)) {
    return { ok: false, code: "invite_invalid_field" };
  }
  if (protocolProfile !== INVITE_PROTOCOL_PROFILE) {
    return { ok: false, code: "invite_invalid_field" };
  }
  if (typeof expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(expiresAt)) {
    return { ok: false, code: "invite_invalid_field" };
  }
  const expiryMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiryMs)) {
    return { ok: false, code: "invite_invalid_field" };
  }
  // A client must never hold an invite whose claimed lifetime exceeds what
  // the host is allowed to issue, plus small clock slack.
  if (expiryMs > now + INVITE_TTL_MS + INVITE_CLOCK_SKEW_MS) {
    return { ok: false, code: "invite_invalid_field" };
  }
  if (expiryMs <= now) {
    return { ok: false, code: "invite_expired" };
  }
  if (!Array.isArray(endpoints) || endpoints.length === 0 || endpoints.length > 4) {
    return { ok: false, code: "invite_invalid_field" };
  }
  for (const endpoint of endpoints) {
    if (!isValidEndpoint(endpoint)) {
      return { ok: false, code: "invite_invalid_field" };
    }
  }
  return {
    ok: true,
    payload: {
      v: 1,
      hostId,
      hostFingerprint,
      hostName,
      inviteId,
      secret,
      expiresAt,
      protocolProfile,
      endpoints: endpoints.map((endpoint) => ({
        kind: "tcp",
        host: endpoint.host as string,
        port: endpoint.port as number,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Store — single-writer issuance and atomic redemption
// ---------------------------------------------------------------------------

export interface InviteStoreDeps {
  hostId: string;
  hostFingerprint: string;
  /** Injectable clock for deterministic vectors. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable randomness for deterministic vectors. Defaults to `randomBytes`. */
  random?: (bytes: number) => Buffer;
  /**
   * Credential issuance (production: `TokenStore.issue`). Called at most once
   * per invite, strictly after the invite is marked `redeemed`, inside the
   * store's single-writer critical section.
   */
  issueCredential?: (request: RedemptionRequest) => Promise<IssuedCredential>;
}

export type IssueInviteResult =
  | { ok: true; invite: IssuedInvite }
  | { ok: false; code: "store_full" };

/**
 * Reference issuer/redeemer. At most one pending invite exists at a time
 * (issuing supersedes the previous one — the same "at most one window" rule
 * as `PairingFlow`). Redemptions are serialized through a promise chain, so
 * validate-then-consume-then-issue is atomic with respect to any other
 * redemption, and concurrent attempts observe a terminal state and receive a
 * deterministic denial.
 */
export class InviteStore {
  private readonly records = new Map<string, InviteRecord>();
  private readonly deps: Required<Pick<InviteStoreDeps, "now">> & InviteStoreDeps;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: InviteStoreDeps) {
    if (!isValidHostId(deps.hostId) || !isCanonicalFingerprint(deps.hostFingerprint)) {
      throw new TypeError("invite store requires a valid host identity and certificate fingerprint");
    }
    this.deps = { now: Date.now, ...deps };
  }

  /**
   * Issue a fresh invite. Any currently pending invite is superseded
   * (status `revoked`) so stale acceptance cannot survive a new issuance,
   * and the retained audit tail is pruned to `MAX_STORED_INVITES`.
   */
  issue(input: IssueInviteInput): IssueInviteResult {
    validateIssueInput(input);
    const now = this.deps.now();
    for (const record of this.records.values()) {
      if (record.status === "pending") {
        record.status = "revoked";
      }
    }
    if (!this.makeRoom(now)) {
      return { ok: false, code: "store_full" };
    }
    const idBytes = this.deps.random?.(INVITE_ID_BYTES) ?? randomBytes(INVITE_ID_BYTES);
    const inviteId = `i1-${idBytes.toString("base64url")}`;
    const secret = this.deps.random?.(INVITE_SECRET_BYTES) ?? randomBytes(INVITE_SECRET_BYTES);
    const secretText = secret.toString("base64url");
    const expiresMs = now + INVITE_TTL_MS;
    const record: InviteRecord = {
      inviteId,
      hostId: this.deps.hostId,
      hostFingerprint: this.deps.hostFingerprint,
      protocolProfile: INVITE_PROTOCOL_PROFILE,
      secretVerifier: inviteSecretVerifier(this.deps.hostId, inviteId, secretText),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(expiresMs).toISOString(),
      status: "pending",
      attemptsUsed: 0,
    };
    this.records.set(inviteId, record);
    const payload: InvitePayload = {
      v: 1,
      hostId: this.deps.hostId,
      hostFingerprint: this.deps.hostFingerprint,
      hostName: input.hostName,
      inviteId,
      secret: secretText,
      expiresAt: record.expiresAt,
      protocolProfile: INVITE_PROTOCOL_PROFILE,
      endpoints: input.endpoints.map((endpoint) => ({ ...endpoint })),
    };
    return {
      ok: true,
      invite: {
        record: { ...record },
        payload,
        deepLink: encodeInvitePayload(payload),
      },
    };
  }

  /**
   * Redeem an invite. Serialized single-writer; the invite transitions to
   * `redeemed` before the credential write is awaited, so a credential-store
   * failure consumes the invite (fail closed) instead of leaving it
   * replayable.
   */
  async redeem(request: RedemptionRequest): Promise<InviteRedemptionResult> {
    const run = this.queue.then(() => this.redeemExclusive(request));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async redeemExclusive(request: RedemptionRequest): Promise<InviteRedemptionResult> {
    const shape = validateRedemptionShape(request);
    if (!shape.ok) {
      return { ok: false, code: shape.code };
    }
    if (request.hostId !== this.deps.hostId) {
      // Same denial as an unknown id: a foreign host learns nothing.
      return { ok: false, code: "unknown_invite" };
    }
    const record = this.records.get(request.inviteId);
    if (!record) {
      return { ok: false, code: "unknown_invite" };
    }
    if (record.status === "redeemed") {
      return { ok: false, code: "invite_already_redeemed" };
    }
    if (record.status === "revoked") {
      return { ok: false, code: "invite_revoked" };
    }
    if (record.status === "exhausted") {
      return { ok: false, code: "invite_attempts_exhausted" };
    }
    const now = this.deps.now();
    if (Date.parse(record.expiresAt) <= now) {
      return { ok: false, code: "invite_expired" };
    }
    if (request.protocolProfile !== record.protocolProfile) {
      // Downgrade attempt: consume attempt budget too, so profile probing
      // cannot ride alongside secret guessing for free.
      return this.registerFailure(record, "profile_mismatch");
    }
    if (!secretMatches(record.secretVerifier, this.deps.hostId, record.inviteId, request.secret)) {
      return this.registerFailure(record, "invite_secret_mismatch");
    }
    // Consume first: from here on the invite can never return to pending.
    record.status = "redeemed";
    const issue = this.deps.issueCredential ?? defaultIssueCredential;
    try {
      const credential = await issue(request);
      return { ok: true, credential };
    } catch {
      // The credential write failed. The invite stays consumed — re-issuing
      // is the recovery path. Never leave a replayable invite behind.
      return { ok: false, code: "credential_store_unavailable" };
    }
  }

  private registerFailure(record: InviteRecord, code: InviteDenialCode): InviteRedemptionResult {
    record.attemptsUsed += 1;
    if (record.attemptsUsed >= INVITE_MAX_ATTEMPTS) {
      record.status = "exhausted";
      return { ok: false, code: "invite_attempts_exhausted" };
    }
    return { ok: false, code };
  }

  /** Revoke one invite. Pending only; returns whether anything changed. */
  revoke(inviteId: string): boolean {
    const record = this.records.get(inviteId);
    if (!record || record.status !== "pending") {
      return false;
    }
    record.status = "revoked";
    return true;
  }

  /** The live invite, if any. Never exposes the secret — records cannot. */
  pendingInvite(): InviteRecord | null {
    const now = this.deps.now();
    for (const record of this.records.values()) {
      if (record.status === "pending" && Date.parse(record.expiresAt) > now) {
        return { ...record };
      }
    }
    return null;
  }

  /** Immutable audit view. Verifiers only. */
  list(): readonly InviteRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  /** Drop terminal/expired records. Returns how many were removed. */
  prune(now: number = this.deps.now()): number {
    let removed = 0;
    for (const [inviteId, record] of this.records) {
      const terminal = record.status !== "pending";
      const expired = Date.parse(record.expiresAt) <= now;
      if (terminal || expired) {
        this.records.delete(inviteId);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Make room for a new record without destroying the live invite. Drops the
   * oldest non-pending (or already-expired) records first; only fails when
   * nothing but a live pending invite remains at the bound.
   */
  private makeRoom(now: number): boolean {
    if (this.records.size < MAX_STORED_INVITES) {
      return true;
    }
    const droppable = [...this.records.values()]
      .filter((record) => record.status !== "pending" || Date.parse(record.expiresAt) <= now)
      .sort((a, b) => Date.parse(a.issuedAt) - Date.parse(b.issuedAt));
    for (const record of droppable) {
      if (this.records.size < MAX_STORED_INVITES) {
        break;
      }
      this.records.delete(record.inviteId);
    }
    return this.records.size < MAX_STORED_INVITES;
  }
}

function defaultIssueCredential(request: RedemptionRequest): Promise<IssuedCredential> {
  // Production wiring (slice 2) passes `TokenStore.issue` here. The default
  // exists so the reference logic is runnable and testable standalone.
  return Promise.resolve({
    token: randomBytes(32).toString("hex"),
    clientId: request.clientId,
    clientName: request.clientName,
    pairedAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Shape validation and secret comparison
// ---------------------------------------------------------------------------

type ShapeResult =
  | { ok: true }
  | { ok: false; code: "malformed_request" };

function validateRedemptionShape(request: RedemptionRequest): ShapeResult {
  if (!isPlainObject(request)) {
    return { ok: false, code: "malformed_request" };
  }
  if (typeof request.inviteId !== "string" || !/^i1-[A-Za-z0-9_-]{22}$/.test(request.inviteId)) {
    return { ok: false, code: "malformed_request" };
  }
  if (!isValidHostId(request.hostId)) {
    return { ok: false, code: "malformed_request" };
  }
  if (typeof request.secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(request.secret)) {
    return { ok: false, code: "malformed_request" };
  }
  if (typeof request.clientId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(request.clientId)) {
    return { ok: false, code: "malformed_request" };
  }
  if (
    typeof request.clientName !== "string"
    || request.clientName.length === 0
    || request.clientName.length > 128
    || hasControlChars(request.clientName)
  ) {
    return { ok: false, code: "malformed_request" };
  }
  if (typeof request.protocolProfile !== "string" || request.protocolProfile.length === 0 || request.protocolProfile.length > 32) {
    return { ok: false, code: "malformed_request" };
  }
  return { ok: true };
}

/**
 * Domain-separated verifier. The host id and invite id are bound into the
 * digest so a verifier leaked from one host (or one invite) is not a verifier
 * for any other. The secret itself is never an input to storage.
 */
export function inviteSecretVerifier(hostId: string, inviteId: string, secret: string): string {
  return createHash("sha256")
    .update("psyche-invite-secret-v1\x00")
    .update(hostId)
    .update("\x00")
    .update(inviteId)
    .update("\x00")
    .update(secret, "utf8")
    .digest("hex");
}

function secretMatches(verifier: string, hostId: string, inviteId: string, secret: string): boolean {
  const expected = Buffer.from(verifier, "utf8");
  const supplied = Buffer.from(inviteSecretVerifier(hostId, inviteId, secret), "utf8");
  if (expected.length !== supplied.length) {
    return false;
  }
  return timingSafeEqual(expected, supplied);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Canonical fingerprint form produced by `TLSCertificate.ts` (colon-separated uppercase hex). */
export function isCanonicalFingerprint(value: string): boolean {
  return /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(value);
}

function hasControlChars(value: string): boolean {
  return /[\x00-\x1f\x7f]/.test(value);
}

function isValidHostId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && !hasControlChars(value);
}

function isValidDisplayName(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && !hasControlChars(value);
}

function isValidEndpoint(value: unknown): value is InviteEndpoint {
  if (!isPlainObject(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length !== 3 || !keys.every((key) => key === "kind" || key === "host" || key === "port")) {
    return false;
  }
  return value.kind === "tcp"
    && typeof value.host === "string"
    && value.host.length > 0
    && value.host.length <= 253
    && !hasControlChars(value.host)
    && typeof value.port === "number"
    && Number.isInteger(value.port)
    && value.port >= 1
    && value.port <= 65535;
}

function validateIssueInput(input: IssueInviteInput): void {
  if (
    !isPlainObject(input)
    || !isValidDisplayName(input.hostName)
    || !Array.isArray(input.endpoints)
    || input.endpoints.length === 0
    || input.endpoints.length > 4
    || !input.endpoints.every(isValidEndpoint)
  ) {
    throw new TypeError("issue requires a valid host name and one to four TCP endpoints");
  }
}

function canonicalInviteJson(payload: InvitePayload): Record<string, unknown> {
  return {
    v: payload.v,
    hostId: payload.hostId,
    hostFingerprint: payload.hostFingerprint,
    hostName: payload.hostName,
    inviteId: payload.inviteId,
    secret: payload.secret,
    expiresAt: payload.expiresAt,
    protocolProfile: payload.protocolProfile,
    endpoints: payload.endpoints.map((endpoint) => ({
      kind: endpoint.kind,
      host: endpoint.host,
      port: endpoint.port,
    })),
  };
}
