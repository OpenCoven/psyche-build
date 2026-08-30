# Mobile workspace cache contract (v1)

- Bead: `psyche-i7c.10.1` (mirror: [OpenCoven/psyche-build#210](https://github.com/OpenCoven/psyche-build/issues/210)), "Implement bounded protected workspace cache"
- Parent: `psyche-i7c.10` (mirror: [#209](https://github.com/OpenCoven/psyche-build/issues/209)) — Phase 10: recovery, persistence, accessibility, and acceptance
- Canonical outcome: gh-200 (this is the separately gated mobile delivery track; it makes no release-availability claim)
- Reference implementation: `src/mobile/workspaceCache.ts` (schema v1, tests in `__tests__/workspaceCache.test.ts`)
- Contract authored: 2026-08-31. The Beads source remains authoritative for the deliverable definition; this document is its platform-neutral specification.
- Risk class: **R3** (persistence/recovery, host boundary, and what is persisted — see section 2)

## 1. Purpose, scope, and ownership

The workspace cache is a **bounded, protected, host-scoped record** of the last workspace state
confirmed by an authenticated session: the workspace's project/pane enumeration, the last-confirmed
sequence, the selection, and per-pane input drafts. It exists so a mobile cockpit can restore a
viewable workspace across launches and connection drops — and so it can never be fooled into
treating those bytes as live state.

Owned by this deliverable (#210):

- The v1 record schema, validation, and canonical serialization (`CachedWorkspaceState`).
- The storage model and adapter contract (write-temp-then-promote over an injected
  `WorkspaceCacheStorageAdapter`).
- Host-identity keying and other-host refusal.
- The complete-until-first-auth protection envelope.
- Bounds enforcement with explicit typed failures — never silent truncation.
- Data minimization rules and the closed schema.

Explicitly **not** owned by this deliverable:

- **Stale/live reconciliation** — `psyche-i7c.10.2` ([#211](https://github.com/OpenCoven/psyche-build/issues/211)) owns presenting restored state as stale, reconciling selection/drafts against an authoritative snapshot, last-confirmed banners, and input/mutation re-enablement. #211 consumes these exact entry points (`createWorkspaceCacheStore`, `restoreWorkspaceCache`, `RestoredCachedWorkspaceState`); this module never reconciles.
- **Platform persistence mechanics** — real Application Support files, file-protection attributes, crash-atomic renames, and their XCTest proof are owned by the platform layers that implement the adapter. This module is platform-neutral TypeScript with an injected storage adapter; it holds no I/O of its own.
- **Authentication** — the module accepts caller attestations (`authAccepted`); it does not verify them. The bridge session remains the authority (see `docs/BRIDGE-SECURITY.md`).

## 2. Threat and failure boundary (why this is R3)

The cache sits next to recovery and persistence semantics. Required behavior per failure mode:

| Failure mode | Required behavior |
|---|---|
| Process dies between temp write and promote | Promoted record untouched; orphaned temp cleaned up by the platform layer (adapter contract) |
| Promote fails | Typed error (`promote-failed`); prior record byte-identical; temp discarded by the module |
| Hostile/corrupt stored bytes (bad UTF-8, bad JSON, wrong shape) | `unusable` restore result; payload never exposed; record NOT removed implicitly |
| Record written by another host (backup/container restore, sync) | `refused-other-host`; nothing about the foreign payload is exposed or logged |
| Oversize record (write side) | Typed error before any storage call; no truncation |
| Oversize stored record (read side) | `unusable` with `oversize-record`, parsed nowhere |
| Cached state presented before authentication | Impossible through this module: `presentableAsLive`, `inputEnabled`, `mutationsAllowed` are literal `false` on every restored state |
| Credential/source/transcript smuggled into the record | Closed schema rejects unknown fields; credential-shaped content in free-text fields is rejected (`forbidden-content`) |
| Caller ignores protection flags | Out of module reach; see section 6 for the contract boundary and #211's enforcement |

Negative tests for each row live in `__tests__/workspaceCache.test.ts` (section 12).

## 3. Storage model

### 3.1 Location

Records live in the platform's protected application-data directory (Application Support on Apple
platforms), at the relative key:

```
psyche/mobile/workspace-cache/v1/<hostKey>.json
```

The version segment scopes the storage key to the schema version; a v2 format uses a new directory
and never collides with v1 bytes. The key is path-safe (`[A-Za-z0-9._:-]` only, produced by
`deriveHostKey`). Exactly one workspace is cached per host scope in v1.

### 3.2 Adapter contract

The module never touches the filesystem. Platforms implement:

```ts
interface WorkspaceCacheStorageAdapter {
  read(key: string): Uint8Array | null;
  writeTemp(key: string, bytes: Uint8Array): WorkspaceCacheTempHandle;
  promote(key: string, temp: WorkspaceCacheTempHandle): void;
  discardTemp(temp: WorkspaceCacheTempHandle): void;
  remove(key: string): void;
}
```

Semantics the adapter MUST uphold:

- `writeTemp` durably writes bytes to a private temp location for `key`; the promoted record is untouched.
- `promote` atomically replaces the promoted record (rename-class operation). It is all-or-nothing: either the promoted record becomes the new bytes or it stays exactly as before. No torn state is observable.
- `discardTemp` removes a temp location; safe for unknown handles.
- `remove` is idempotent.
- `read` returns a copy (or null); callers must not be able to mutate the stored bytes through the returned array.
- Adapter failures are wrapped by the module into typed errors (`temp-write-failed`, `promote-failed`, `storage-read-failed`) with the cause attached.

`createMemoryWorkspaceCacheStorage()` is the executable specification of this contract and is used directly by the test suite.

### 3.3 Write path (atomic replacement)

`saveWorkspaceCache` runs, in order: **validate → stamp → serialize → byte-budget check → writeTemp → promote**. Consequences:

- A validation rejection or byte-budget rejection happens **before any storage call** — the adapter is untouched, nothing is truncated.
- If `promote` throws, the module discards the temp handle (best-effort) and throws `promote-failed`; the previously promoted record remains byte-identical. There is no code path that removes the promoted record before a successful promote.
- Replacement is the only write mode: a save always atomically replaces this host's single record.

### 3.4 Read path and removal

`restoreWorkspaceCache` never deletes anything. An unusable record stays on disk for diagnosis until someone calls `discardWorkspaceCache` explicitly — the only removal path. Implicit deletion on read would destroy diagnostic evidence and violate work-preservation discipline.

## 4. File protection ("complete until first auth", device axis)

On Apple platforms, cache record **and temp** files MUST carry
`NSFileProtectionCompleteUntilFirstUserAuthentication` or stricter. This is the *device* axis of
"complete-until-first-auth": the bytes are unreadable until first unlock after boot, which bounds
what a cold attacker can extract from a stolen device before first unlock.

Authentication has two distinct axes, and the contract keeps them separate:

1. **Device unlock** — governs file-protection classes (this section). Platform-owned.
2. **Bridge session auth** — governs whether cached state may participate in reconciliation (section 6). Owned by the bridge session; this module receives it only as the `authAccepted` attestation.

A file-protection class never implies session authentication, and vice versa. Neither axis ever
upgrades restored state to live (section 6).

## 5. Host-identity keying

Other-host state **never restores**. Two independent layers enforce this:

1. **Key namespacing** — the storage key embeds the derived host key, so another host's record lives at a different location.
2. **In-record host key** — the record carries `hostKey` and restore refuses any record whose stored key is absent, non-string, malformed, or simply not the deriving host's key (`refused-other-host`), *before* validation and before any payload exposure. This catches the realistic contamination scenario: a backup/container restore that leaves foreign bytes under the local key.

### 5.1 Identity input and derivation

```ts
deriveHostKey({ platform, installScopeId })  // → 'ios:01234567-89ab-…'
```

- `platform` ∈ `ios | ipados | macos` — keying is scoped per platform family, so ids cannot collide across families.
- `installScopeId` — opaque, install-scoped identifier generated **once per install by the platform layer** (for example a UUID in platform-protected storage). It MUST NOT be derived from hostname, user name, hardware serial, or any other personally identifying or unstable value.
- Validation fails closed: non-object identities, unknown platforms, and ids that are too short (< 8), too long (> 128), wrongly chartered (`[A-Za-z0-9._:-]` required — which excludes `/` and whitespace, so path-traversal-shaped ids are impossible), or non-string throw `invalid-host-identity`.

**Why exact identity instead of a digest:** the key must be exact-match for the never-restores guarantee; hashing cannot add entropy the input lacks and could only introduce cross-host collisions. The key is therefore the normalized identity itself — a bounded opaque routing key with no credentials, user identity, or filesystem paths in it.

### 5.2 Refusal semantics

`refused-other-host` exposes exactly one fact ("not ours") — no stored host key, no payload, no problem list that could describe foreign content. Cross-host purge is out of scope in v1: a foreign record under a foreign key is unreachable through this host's key and is bounded by the byte cap; a maintenance path may add explicit enumeration later without breaking v1.

## 6. Complete-until-first-auth protection (session axis)

Restored state is wrapped in a protection envelope whose flags are **literal types**:

| Flag | Value | Meaning |
|---|---|---|
| `protection` | `protected-inert` (before first-auth assertion) / `stale-pending-reconciliation` (after) | View-only recovery context vs. eligible for #211's reconciliation |
| `presentableAsLive` | `false` (literal type — always) | Cached state is never the live surface, before or after auth |
| `inputEnabled` | `false` (literal type) | Input is enabled only by live reconciliation, never by the cache |
| `mutationsAllowed` | `false` (literal type) | The cache never grants mutation authority |
| `reconciliationAllowed` | `false` → `true` after the first-auth assertion | Gates reconciliation attempts, not presentation |

Because the first three are literal-typed `false`, there is no value of `RestoredCachedWorkspaceState` under which the cache may be presented as live, used for input, or mutated — the guarantee "cached state is never presented as live before auth succeeds" is enforced structurally, and enforced *always*, not merely pre-auth. What the first-auth assertion changes is only `protection`/`reconciliationAllowed`.

Attestations:

- `restore({ auth: { authAccepted } })` — the platform layer passes `true` only after its bridge session reported authentication success. Before that, restore returns `protected-inert`.
- `save(state, { auth: { authAccepted: true } })` — attests the state being cached was observed during an authenticated session (for example the last-known state of a session that has since dropped). The literal `true` type makes pre-auth writes inexpressible at compile time; the runtime check (`auth-required`) covers untyped callers.

Boundary statement: these are attestations, not proofs. A caller that lies about `authAccepted` can obtain the stale-pending mode — but even then the returned state is still never live, never input-enabled, and never mutable. The stronger guarantee does not depend on caller honesty. Enabling interaction after successful reconciliation is #211's decision, on top of live state, not the cache's.

## 7. Bounds: explicit failure, never truncation

| Constant | Value | Applies to |
|---|---|---|
| `WORKSPACE_CACHE_MAX_RECORD_BYTES` | 131,072 (128 KiB) | Serialized record, UTF-8 bytes — authoritative total budget |
| `WORKSPACE_CACHE_MAX_PROJECTS` | 8 | `projects[]` |
| `WORKSPACE_CACHE_MAX_PANES` | 24 | `panes[]` |
| `WORKSPACE_CACHE_MAX_DRAFTS` | 24 | `drafts[]` (at most one per pane) |
| `WORKSPACE_CACHE_MAX_DRAFT_CODE_UNITS` | 2,048 | one draft, UTF-16 code units |
| `WORKSPACE_CACHE_MAX_DISPLAY_TEXT_CODE_UNITS` | 200 | project name, pane title |
| `WORKSPACE_CACHE_MAX_ID_CODE_UNITS` | 128 | identifier fields |
| `WORKSPACE_CACHE_MIN/MAX_HOST_ID_CODE_UNITS` | 8 / 128 | `installScopeId` |

Layering: **per-field limits are necessary but not sufficient** — the record byte budget is authoritative. A record whose fields are individually legal can still exceed the byte budget (e.g. 24 max-length drafts of three-byte characters) and then fails explicitly with `oversize-record`. The byte check runs before any storage call on write and before parsing on read.

Failure semantics: every over-bound input throws a typed `WorkspaceCacheError` whose `code` mirrors the first validation problem (`too-many-items`, `oversize-field`, `oversize-record`, …) with the full structured `problems` array attached. No function in this module truncates, clamps, or drops content to make a record fit.

Referential integrity is part of the bounds: drafts must reference cached panes, panes must reference cached projects, selection must reference cached (and mutually consistent) ids, and duplicate ids are rejected. A dangling reference is inconsistent state, not something to normalize away.

## 8. Data minimization and exclusions

The v1 record contains: bounded opaque identifiers, short display names/titles, the last-confirmed sequence, an optional caller-supplied `lastConfirmedAtMs`, selection refs, and draft texts. It MUST NOT contain:

- **Credentials, tokens, keys** — closed schema (no field exists for them) plus a shape-based backstop scan (`forbidden-content`) over the only free-text fields (project names, pane titles, drafts). The scan is a backstop, not a guarantee; the schema is the primary control.
- **Full source code** — no file contents, no diffs, no trees, no paths anywhere in the record.
- **Transcripts / terminal output** — no pane output, no event logs, no raw prompts.
- **Filesystem paths** — project/pane references are opaque ids plus display names only; unredacted personal paths are protected data and are structurally excluded.
- **Wall-clock data generated by this module** — the module never reads a clock or a random source. `lastConfirmedAtMs` is optional, caller-supplied, and validated (non-negative safe integer); interpretation of it belongs to #211.

The schema is **closed**: any field outside the v1 shape — at the root or nested in projects, panes, selection, or drafts — is rejected with `unknown-field`, not ignored. A future schema adds fields by bumping `WORKSPACE_CACHE_RECORD_VERSION` and the storage-key version segment; this module refuses every other version explicitly (`unsupported-version`), so a newer writer's record fails closed on an older reader instead of being partially interpreted.

## 9. v1 record schema

Canonical JSON, UTF-8, fixed key order (deterministic — same record, same bytes):

```json
{
  "version": 1,
  "hostKey": "ios:01234567-89ab-4cde-8f01-23456789abcd",
  "workspaceId": "workspace-1",
  "lastConfirmedSequence": 42,
  "lastConfirmedAtMs": 1700000000000,
  "projects": [{ "projectId": "project-alpha", "name": "Alpha" }],
  "panes": [{ "paneId": "pane-1", "projectId": "project-alpha", "title": "Agent" }],
  "selection": { "projectId": "project-alpha", "paneId": "pane-1" },
  "drafts": [{ "paneId": "pane-1", "text": "fix the flaky test" }]
}
```

`selection` is `null` when nothing is selected; `lastConfirmedAtMs` is optional and omitted when absent; `drafts` entries exist only for panes with non-empty in-progress input. Identifiers match `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`; display text is single-line (no control characters); draft text may contain tab and line feed only.

## 10. Typed errors and restore results

`WorkspaceCacheError` carries `code`, optional structured `problems`, and the `cause` of adapter failures.

| Error code | When |
|---|---|
| `invalid-host-identity` | Malformed host identity or non-derived host key |
| `auth-required` | Save without the authenticated-session attestation |
| problem codes (1:1 with first problem) | Input failed strict validation: `invalid-record`, `unsupported-version`, `unknown-field`, `missing-field`, `invalid-field`, `host-mismatch`, `too-many-items`, `oversize-field`, `forbidden-content` |
| `oversize-record` | Serialized bytes exceed the record budget (write side) |
| `temp-write-failed` / `promote-failed` | Adapter failures; prior record untouched |
| `storage-read-failed` | Adapter read failure |

Restore results (never thrown, always explicit):

| Status | Meaning | Payload exposed |
|---|---|---|
| `empty` | No record for this host's key | — |
| `refused-other-host` | Stored key absent/malformed/foreign | Never |
| `unusable` | Failed strict validation (oversize, wrong version, unknown fields, corrupt bytes) — problems returned, record left in place | Never |
| `restored` | Same host, valid v1 record | Wrapped in the protection envelope |

Validation problem messages carry paths, shapes, and lengths — never offending content.

## 11. Determinism and compatibility

The core module contains no clock reads and no randomness; serialization is canonical (fixed key order, JSON, UTF-8). The same input always yields byte-identical output, which makes the cache format diffable and its tests exact. Platform layers may add wall-clock metadata around the record (file timestamps, their own metadata files) — not inside it.

## 12. Verification matrix

Proven by `__tests__/workspaceCache.test.ts` (79 tests, all passing against the module as delivered — exact commands and results in the working record):

- Same-host restore of workspace (projects/panes), sequence, selection, and drafts — including empty-selection/empty-draft workspaces.
- Other-host refusal: key namespacing, in-record host-key refusal under a contaminated key, malformed stored keys, and refusal-before-validation (foreign payload never described back).
- Explicit oversize failure: field-count, field-length, identifier, and total-byte rejections with typed codes; storage untouched; boundary values at exactly the caps accepted; read-side oversize refused without parsing.
- Atomic writes: write-temp-then-promote order; no `remove` during save; promote failure and temp-write failure leave the prior record byte-identical; temp handle discarded on promote failure; validation failure never touches the adapter; recovery after failure.
- Inert-until-auth: `protected-inert` before the assertion, `stale-pending-reconciliation` after; `presentableAsLive`/`inputEnabled`/`mutationsAllowed` literal-false in both modes (with a compile-time proof test).
- Closed schema: unknown fields at every nesting level; credential-shaped content rejected (`forbidden-content`) with a false-positive guard for benign text.
- Fail-closed restore: corrupt JSON, invalid UTF-8, non-object root, wrong version, missing hostKey, oversize bytes — all `unusable`, none exposed, none implicitly removed.
- Determinism: no clock/random calls in the module source (source-scan test); save→restore→save record-stable.

Platform-owned verification that **cannot** run in this environment and is a documented gap (see the working record):

- `NSFileProtectionCompleteUntilFirstUserAuthentication` attributes on the real cache and temp files (XCTest on iOS/macOS).
- Atomicity of the real rename under crash/kill (XCTest with process-level fault injection).
- Real Application Support placement and container backup/restore behavior end-to-end.
