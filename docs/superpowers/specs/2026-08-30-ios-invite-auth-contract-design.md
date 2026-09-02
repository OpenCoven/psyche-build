# Fail-Closed Single-Use iOS Invite Authentication — Protocol Contract

- **Date:** 2026-08-30
- **Status:** blocked replacement candidate for [OpenCoven/psyche-build#280](https://github.com/OpenCoven/psyche-build/issues/280), slice 1 ("Protocol and fixtures"). Reference logic: [`src/services/bridge/inviteAuth.ts`](../../../src/services/bridge/inviteAuth.ts). Vectors: [`__tests__/bridge/inviteAuth.test.ts`](../../../__tests__/bridge/inviteAuth.test.ts) and [`protocol-fixtures/invite-auth/v1/`](../../../protocol-fixtures/invite-auth/v1/).
- **Risk class:** R3 (authentication, authority, protocol, persistence, revocation, recovery) per [`AGENTS.md`](../../../AGENTS.md).
- **Related:** #200 (iOS internal beta), #241 (host-readiness gate, prerequisite), draft PR #264 (source material, deliberately not merged).

## Outcome

A reviewable, fail-closed contract for pairing the native iOS companion with a trusted Psyche desktop host: typed invite/redemption records, bounded expiry, single-use atomic redemption, deterministic denials, and secret-free evidence — proven by executable vectors, with no UI and no wire cutover in this slice.

## Why invites, and why now

The bridge today pairs with a **six-digit pairing code** in a five-minute window (`PairingFlow`, `src/services/bridge/PairingFlow.ts`): 10^6 values, attempt-capped at 5 per window (`docs/BRIDGE-SECURITY.md`, rule 3). That is acceptable for a supervised moment at the host, but it is a manual, headful interaction that cannot be delivered as a scannable object, cannot be revoked ahead of use, and cannot carry host-identity binding — the code only means "the person who can see the host screen". A **single-use invite** moves that authority into a bounded, transferable, cryptographically random object: the host issues it, the intended device consumes it exactly once, and everything else fails closed.

This slice intentionally does **not** replace `PairingFlow`; it defines the protocol the invite path must satisfy before any issuer/consumer wiring (slice 2), iOS parsing (slice 3), or QR/deep-link presentation (slice 4) is built on it.

## Identity model

| Identity | Definition | Canonical owner | Durable? | Current code anchor |
|---|---|---|---|---|
| Host identity (`hostId`) | Opaque identifier supplied by the eventual canonical owner | **Unresolved; blocked on the host-readiness and upstream ownership decisions** | Must be durable before activation | `BridgeDaemon.serverId` is currently process-scoped; the certificate fingerprint is separately pinned |
| Host transport fingerprint | SHA-256 of the TLS certificate, colon-separated uppercase hex | Same | Yes | `fingerprintFromPEM` in `TLSCertificate.ts`; pinned client-side by `PinnedCertificateDelegate` |
| Device identity (`clientId`) | Client-chosen stable id, bound to the issued credential | The iOS device | Yes | `PairRequestPayload.clientId` in `src/services/bridge/wireProtocol.ts`; `DeviceRecord.clientId` in `TokenStore.ts` |
| Invite identity (`inviteId`) | `i1-` + 128-bit random, public half of the invite | The host's issuer (single writer) | No — invite records are bounded and terminal | New: `InviteStore` in `inviteAuth.ts` |
| Credential identity (`token`) | 256-bit random durable device token | The host's `TokenStore` (`src/services/bridge/TokenStore.ts`) | Yes | `DeviceRecord.token` |

**Explicit blocker:** `BridgeDaemon.serverId` is a fresh `randomUUID()` per process (`src/services/bridge/BridgeDaemon.ts`) and therefore cannot satisfy durable host identity. The TLS fingerprint is a verifiable certificate binding, but this product repository does not have an approved decision that the certificate key owns host identity. `InviteStore` consequently accepts a bounded opaque `hostId` from its future composition layer and binds it into the invite/verifier without deriving or claiming ownership. Activation remains blocked until #313's host-readiness contract is accepted and the upstream ownership decision identifies the canonical durable host identifier and rotation semantics.

## Threat model and required defenses

| # | Threat | Contract answer | Vector |
|---|---|---|---|
| 1 | Invite secret leaks from storage/logs | Host stores only a domain-separated SHA-256 verifier (`inviteSecretVerifier`, bound to host+invite ids). The `InvitePayload` transfer object is the sole secret carrier. Denial messages are fixed strings. | "never stores, logs, or echoes the secret" |
| 2 | Replay after successful redemption | Invite transitions to terminal `redeemed` and never returns to `pending`; replay ⇒ `invite_already_redeemed`. | "commits exactly once; the replay receives a deterministic denial" |
| 3 | Concurrent redemption | `InviteStore.redeem` serializes through a single-writer promise chain (same discipline as `TokenStore.mutate` and `mutateBridgeConfig` — `docs/BRIDGE-SECURITY.md` "Config integrity"); exactly one commit, others get `invite_already_redeemed`. | "serializes concurrent redemptions to a single commit" |
| 4 | Stale acceptance (old invite still open) | Issuance supersedes: issuing a new invite revokes all pending ones (`PairingFlow`'s "at most one window" rule). Old invite ⇒ `invite_revoked`. | "supersedes the previous pending invite on the next issuance" |
| 5 | Cross-host use | Redemption requires the request's opaque `hostId` to equal the issuer-supplied host id; a foreign host id receives the same `unknown_invite` denial as an unknown invite (no oracle). The client separately verifies the pinned certificate fingerprint. | "fails closed on a foreign host id…" |
| 6 | Downgrade | Profile is fixed (`INVITE_PROTOCOL_PROFILE = "bridge.v3"`); no legacy negotiation on this path. Mismatch ⇒ `profile_mismatch` (and consumes attempt budget so profile probing can't ride secret guessing for free). | "refuses protocol downgrade" |
| 7 | Brute force / probing | 256-bit random secret + attempt cap (`INVITE_MAX_ATTEMPTS = 5`, mirroring `PAIR_MAX_ATTEMPTS`) + constant-time compare (`timingSafeEqual`, per `PairingFlow.codesMatch`). Exhaustion is terminal (`exhausted`). | "exhausts the attempt budget…" |
| 8 | Long-lived invites | `INVITE_TTL_MS = 10 min`, bounded both at issuance and re-validated at redemption; clients refuse payloads claiming more than `INVITE_TTL_MS + INVITE_CLOCK_SKEW_MS` of life. | "denies an expired invite…"; payload bound test |
| 9 | Credential-store failure re-arms the invite | Redemption marks the invite `redeemed` **before** awaiting issuance; a store failure yields `credential_store_unavailable` and the invite stays consumed. A credential-store failure therefore can never leave a pending invite (acceptance criterion: "a credential-store failure cannot expose the new host/workspace as authoritative"). | "fails closed when the credential store fails…" |
| 10 | Discovery data treated as identity | `endpoints` are routing hints; QR/Bonjour addresses never confer identity. Durable fields are `hostId` + `hostFingerprint`; address changes preserve identity. | payload round-trip + fingerprint binding tests |
| 11 | Malformed input / injection | Strict shapes: bounded opaque host id, `i1-` invite id, 43-char base64url secret, control-character rejection on `clientName`/`hostName` (same command-boundary rule as `quoteTmuxArgument` — `docs/BRIDGE-SECURITY.md` rule 1), exact endpoint fields and bounds, oversized encoded payloads rejected before decode. | "rejects malformed requests…", payload rejection tests |
| 12 | Revocation semantics | Explicit `revoke(inviteId)` marks terminal; revocation of an unknown/terminal invite is a no-op, not an error. | "honours explicit revocation" |
| 13 | Superseded-flow acceptance | An invite redeemed under a superseded profile can never be accepted later: profile is part of the record, checked before the secret comparison, and consumed attempts make retry-forcing visible. | "refuses protocol downgrade" |

## Fail-closed rules (normative)

1. **Secret handling.** `InviteRecord` has no secret field. The QR/deep-link payload (`psyc://invite/v1/<base64url JSON>`) is the only runtime secret carrier. Runtime invite material must never reach logs, accessibility output, screenshots, crash reports, process args, support bundles, persistent app state, or captured fixtures. Checked-in protocol fixtures use only fixed public synthetic values. The Swift-side counterpart must keep runtime payloads in local scope only and persist only the exchanged credential (aligning with `PairedHostStore`/`SecureStore`, which already store only the durable token in the Keychain with `AfterFirstUnlockThisDeviceOnly`).
2. **Atomic consume.** Mark `redeemed` → issue credential → report. Both orders of failure are covered: consume-then-fail ⇒ `credential_store_unavailable` with the invite dead (no replay); the credential write itself remains `TokenStore`'s existing atomic-write domain (temp file + rename, 0600).
3. **Deterministic denials.** Every path returns one of nine fixed codes (`InviteDenialCode`); user text comes only from `denialMessage(code)` — a pure lookup, so no denial can echo the secret or record internals. Wrong-host and unknown-invite return the *same* code so a foreign host learns nothing.
4. **Attempt budget.** Five wrong presentations (secret *or* profile) mark the invite `exhausted` — terminal, same shape as `PairingFlow`'s exhausted window and the same reason-reporting rule: the code states what happened; callers must not reconstruct reasons from post-hoc state inspection.
5. **Fail closed on identity mismatch.** The client must verify `payload.hostFingerprint` equals the TLS certificate presented, extending the existing pin (`PinnedCertificateDelegate`), and must compare `payload.hostId` with the canonical durable identity once its owner and rotation rules are approved. Mismatch means re-pair guidance, never fallback acceptance. On the host, a redemption naming any other `hostId` is indistinguishable from an unknown invite.
6. **Bounded state.** `MAX_STORED_INVITES` bounds the retained audit tail; issuance supersedes the previous pending invite and prunes oldest terminal records, failing with `store_full` only if no room can be made.

## State machine

```
             issue()                redeem() ok               redeem() fail
  (absent) ───────────► pending ────┬──────────────► redeemed (terminal)
                         ▲  │       └─ attempts≥5 ──► exhausted (terminal)
                    issue │ (superseded by the next issue)
                         ▼        revoke()        TTL elapsed / budget gone
                       revoked (terminal)          (via expired / exhausted)
```

- `pending → redeemed`: exactly once, under the single-writer redemption critical section.
- `pending → revoked`: supersession (`issue()`) or explicit `revoke()`.
- `pending → exhausted`: `INVITE_MAX_ATTEMPTS` failed presentations.
- Terminal states are permanent; `prune()`/`makeRoom()` may later drop records for the bounded tail but can never re-open them.

## Wire and storage boundaries

- **New wire surface (slice 2, not in this PR):** `pairInvite` client message carrying the redemption request; server replies `pairAccepted`-shaped credential response or an `error` frame whose `code` is the denial code. `parseInvitePayload` already bounds the client-held side (version, field set, shapes, expiry window, endpoint count).
- **Storage:** invite records live only in host memory in this slice; when slice 2 adds persistence it must follow the `TokenStore`/`mutateBridgeConfig` disciplines (atomic write-then-rename, serialized read-modify-write, distinguish absent vs unreadable) and persist verifiers only. iOS persistence remains `PairedHostStore` via `SecureStore` (Keychain), which stores only the durable credential.
- **Logging:** `InviteRecord`, `InviteDenialCode`, and `denialMessage` are safe by construction; `InvitePayload` and deep links are not. Log denial **codes**, never payloads.

## Ordering with #241 (hard prerequisite)

Slice 3 (iOS credential exchange) must not expose workspace state before #241's atomic host-readiness state machine commits authority. This contract deliberately produces only the durable credential; it grants no authority, exposes no workspace surface, and its denial paths leak nothing about host state (same denial for foreign host and unknown invite).

## Test/acceptance gate for slice 1

`__tests__/bridge/inviteAuth.test.ts` covers bounded pre-decode rejection, opaque host-id preservation, strict payload and issuer validation, immutable record views, single-commit and concurrent redemption, replay, expiry, supersession, revocation, foreign-host indistinguishability, downgrade refusal, credential-store failure, secret hygiene, retained-record bounds, and generated-fixture drift. Canonical generation plus denial/replay/expiry vectors live under `protocol-fixtures/invite-auth/v1/`.

## What remains for this issue

- Slice 2 — desktop issuer/consumer wiring: `:invite` command surface, `BridgeDaemon` message handling, persistence with revocation, replacing/paralleling the `:pair` flow (behind the #241 readiness gate).
- Resolve canonical durable host-identity ownership and rotation before wiring. Do not substitute the process-scoped `BridgeDaemon.serverId`, a transport endpoint, or an unapproved certificate-derived local identity.
- Slice 3 — iOS parse/validate/redeem/store (`PsycheCore` Pairing module).
- Slice 4 — QR/deep-link presentation and recovery UI.
- Slice 5 — physical acceptance matrix (pairing, interruption, replay, expiry, supersession, restart, revocation, reconnect).
- Slice 6 — TestFlight distribution evidence under #200.
- R3 independent security review of each focused PR (acceptance criterion).
