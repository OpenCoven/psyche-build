# Psyche adapter plan: immutable pin, compatibility canary, incremental adoption

Date: 2026-08-30
Status: Design for issue #253 delivery slices 2–4 plus the slice-5 reference flow. **Not implemented in this change; not a protocol-conformance claim.**
Related: parent architecture #201 · roadmap control #195 · `OpenCoven/psyche#9` (roadmap) · `OpenCoven/psyche#11` (protocol publication) · `OpenCoven/psyche#12` (ownership) · `OpenCoven/psyche#13` (reference-client mirror)
Current-state mapping: [Psyche compatibility map](PSYCHE-COMPATIBILITY-MAP.md) (delivery slice 1, merged as PR #262)

## 1. Purpose and authority

This document turns the seam inventory in `docs/PSYCHE-COMPATIBILITY-MAP.md` into a reviewable design for the three implementation-facing slices of #253:

1. **Slice 2 — immutable protocol pin:** how Psyche Build records and verifies exactly one released Psyche consumer profile.
2. **Slice 3 — compatibility canary:** the offline vector set, machine-readable evidence, and its CI blocking policy.
3. **Slice 4 — incremental adapters:** the mode, correlation, translation, receipt-projection, and recovery state machines plus the migration order and rollback contract.

Section 6 sketches the slice-5 reference flow so adapter slices can be ordered against it, and section 7 fixes the Build-owned seam types.

Authority rules this plan operates under:

- The classification in `docs/PSYCHE-COMPATIBILITY-MAP.md` governs every field named here. Where this plan repeats a rule, the map is normative.
- Exact Psyche wire shapes, negotiation records, digest rules, and unknown-field/enum behavior are **blocked on `OpenCoven/psyche#11`**; ownership-sensitive enforcement changes are **blocked on `OpenCoven/psyche#12`** (`docs/PSYCHE-COMPATIBILITY-MAP.md` §Known protocol blockers). This plan therefore defines Build-owned schemas only and never invents canonical Psyche types.
- Until a released profile is pinned and canaried, this repository must not claim Psyche protocol conformance (`AGENTS.md` repository role; `docs/PSYCHE-COMPATIBILITY-MAP.md`).
- Everything touching `src/control/**` is R3 under `AGENTS.md` risk classes; the pin/canary/adapter implementation PRs will need threat/failure-boundary review, negative tests, and independent review before merge.

## 2. Non-goals

Carried from #253: no big-bang rewrite; no replacing tmux or Git worktrees for architectural purity; no reclassifying Beads as runtime task identity; no claiming Threads execution before the adapter implements it; no making the current public release depend on an unreleased future protocol. This change ships design artifacts only — no runtime code, no workflow change, no dependency change.

## 3. Immutable protocol pin (slice 2)

### 3.1 Pin artifact

The pin is one committed JSON manifest, validated by [`docs/psyche/pin.schema.json`](psyche/pin.schema.json). At adoption time it lives at `docs/psyche/psyche-profile-pin.json` and records:

- `consumer` — the pinning Build commit (`OpenCoven/psyche-build` + 40-hex SHA), so the pin is reviewable in the exact PR that changed it.
- `profile` — the released profile id (`opencoven.psyche.consumer@<semver>`), its major, and the release source URL. **Never a branch, never `main`.**
- `artifact` — the released artifact URI, `sha256` digest, and `digestSource`: the out-of-band location (release evidence page) where the digest was published, independent of the artifact bytes themselves.
- `compatibility` — the profile's declared `unknownFieldPolicy` (`reject` default), `unknownEnumPolicy` (`reject` only), and the explicit downgrade window (which previous profile ids remain readable).
- `status` — `active` | `quarantined` | `retired`; only one active pin at a time.

The canonical-JSON and bounding rules for anything the adapter later derives or stores come from the existing machinery: `canonicalizeBoundedJson` in `src/control/boundedJson.ts` (bounded depth/nodes, finite numbers) and `AGENT_CONTROL_LIMITS` in `src/control/limits.ts` for size budgets. Pin files are small, static, and reviewed; canary evidence is the bounded artifact (§4.3).

### 3.2 Verification state machine

```text
                 ┌────────────┐   load + schema-validate
     (none) ───▶ │ unpinned   │   manifest, one active status
                 └─────┬──────┘
                       ▼
                 ┌────────────┐   fetch artifact, recompute sha256,
                 │ verifying  │   compare against pin.digest AND
                 └─────┬──────┘   digestSource publication
        digest match ─ ┴ ─ digest mismatch / unknown major /
              │           unsupported profile / unreachable digestSource
              ▼                     │
        ┌──────────┐                ▼
        │  active  │          ┌─────────────┐
        └────┬─────┘          │ quarantined │  fail closed; adapter stays
             │ profile bump   │ (refuses)   │  disabled; existing local
             ▼                └─────────────┘  paths unaffected
        ┌──────────┐
        │ retired  │  only via a reviewed pin change
        └──────────┘
```

Rules:

- Verification runs at adapter-module load and again immediately before any canary execution; a pin that passed once is not trusted for the next process.
- `quarantined` is a terminal-refusal state, not a fallback: the adapter never "best-effort" runs against an unverifiable artifact (map §Rollback contract: "incompatible or unverifiable protocol state is quarantined rather than rewritten").
- Unknown major or unsupported profile is a refusal, never an automatic upgrade (issue: fail closed on unknown major).

### 3.3 Fail-closed rules

| Trigger | Behavior |
| --- | --- |
| Manifest fails its JSON Schema | refuse to load the adapter |
| Digest mismatch (artifact vs `artifact.digest`) | refuse, `quarantined` |
| `digestSource` unreachable or disagrees | refuse — digest must be corroborated out-of-band, not self-attested |
| Profile major unknown to this Build version | refuse with an explicit unsupported-major error |
| Profile id not in `compatibility` downgrade/readable set | refuse reads that need it |
| Runtime sees a field/enum outside the pinned profile | `reject` (see §4.4 unknown-enum/version vector) |

These mirror the local fail-closed precedents: capability denial codes (`lease_missing`, `lease_expired`, `lease_revision_mismatch`, `owner_restarted`, `capability_denied` in `src/control/capabilityLeases.ts`), approval denial codes (`approval_digest_mismatch`, `approval_identity_mismatch` in `src/control/approvals.ts`), and owner-epoch fencing (`src/control/ownerLock.ts`).

### 3.4 Decision D1 — pin format (maintainer)

**Recommendation:** a committed pin manifest + digest-verified released artifact fetched at verification time (§3.1).

Alternatives considered:

1. **npm package dependency** (e.g. a future `@opencoven/psyche-profile-*`): lockfile gives integrity, but it couples Build's release cadence to package publication, hides the pin behind a version bump, and cannot express `digestSource` corroboration or profile metadata. Rejected for now.
2. **Vendored artifact copy in-tree:** strongest reproducibility, but duplicates the protocol source of truth and makes every profile refresh a large binary diff. Rejected; the digest + release-URI pin keeps provenance without vendoring.
3. **Floating dependency on `OpenCoven/psyche` `main`:** explicitly forbidden by the issue ("no floating main-branch dependency").

### 3.5 Decision D2 — artifact transport and CI caching (maintainer)

**Recommendation:** CI fetches the pinned release artifact each run and verifies its digest; a runner-level cache keyed by the digest is allowed because a cache hit still re-verifies bytes against `artifact.digest` and `digestSource` corroboration happens out-of-band. Local/offline development may reuse a cache only when the digest matches and evidence is marked `environment.ci: false`.

Alternatives: committing the artifact bytes (see D1 alternative 2), or trusting the cache without re-verification (rejected — converts the cache into the trust root).

## 4. Compatibility canary (slice 3)

### 4.1 Runner contract

The first canary is **offline and credential-free** (`docs/PSYCHE-COMPATIBILITY-MAP.md` §Canary design). The runner:

1. loads and verifies the pin (§3.2);
2. executes the pinned profile's vector set — positive negotiation and lifecycle vectors, then the negative catalog (§4.4) — through the profile's own runner/interface once `OpenCoven/psyche#11` defines it; until then vectors and evidence are defined here so the contract does not get invented under time pressure;
3. writes one bounded evidence receipt (§4.3) to a fixed local path and exits nonzero on any failed vector.

The runner never needs tmux, git, network beyond artifact verification, provider sessions, or credentials. Bounded-JSON and limits discipline follows `src/control/boundedJson.ts` and `src/control/limits.ts`.

### 4.2 Vector manifest

Each vector validates against [`docs/psyche/canary-vector.schema.json`](psyche/canary-vector.schema.json). A vector is `(id, category, kind, profile, description, input, expectation)`:

- `category` is the closed enum required by #253: `negotiation | lifecycle | denial | authority-widening | stale-correlation | duplicate-retry | ambiguity-fence | restart | downgrade | unknown-enum | unknown-version | cancellation`.
- `kind` is `positive` or `negative`.
- `input.profileVectorId` + `input.payload` are handed to the profile runner; `payload` is opaque to Build by design — Build must not pre-parse an unreleased wire shape.
- `expectation` fixes the observable outcome: negative vectors assert one of `reject | deny | ambiguous-unknown | quarantine | fail-closed` plus a `mustNot` list (`effect-executed`, `success-receipt`, `authority-widened`, `identity-forked`); positive vectors assert `accepted` plus required invariants.

Golden examples live in [`docs/psyche/examples/`](psyche/examples/) (§8).

### 4.3 Evidence receipt

Each run emits one JSON document validating against [`docs/psyche/canary-evidence.schema.json`](psyche/canary-evidence.schema.json), extending the sketch already committed in `docs/PSYCHE-COMPATIBILITY-MAP.md`:

```json
{
  "consumer": "OpenCoven/psyche-build",
  "consumerSha": "<exact-sha>",
  "profile": "<released-profile>",
  "artifactDigest": "sha256:<digest>",
  "positive": { "passed": 0, "failed": 0 },
  "negative": { "passed": 0, "failed": 0 },
  "result": "pass|fail"
}
```

The schema makes it complete and auditable: `schemaVersion`, `consumer.repository`/`consumerSha` (exact PR head), `profile.id`/`profile.digest`, per-vector results (≤512 entries, notes ≤512 bytes), `environment.ci`, `generatedAt`, and a `result` that is `pass` only when **every** vector passed. Evidence is append-only per run; it never mutates the pin.

### 4.4 Negative (and positive) vector catalog

Each vector category maps to the current Build behavior it must protect. "Current analog" cites the live code path; the canary proves the adapter preserves it under the pinned profile.

| Category | Kind | Guards | Current analog (cited) |
| --- | --- | --- | --- |
| `negotiation` | positive | hello/profile negotiation yields an accepted session with declared profile id | `hello`/`welcome` handshake, principal kinds incl. `compatibility` (`src/control/protocol.ts`, `CONTROL_PROTOCOL_VERSION`) |
| `lifecycle` | positive | task→lane→action→receipt lifecycle completes with stable correlation | `ControlCommand` union + `CommandRecord` sequence (`src/control/types.ts`), `ControlRuntime.submit` (`src/control/runtime.ts`) |
| `denial` | negative | insufficient/absent grant is refused, nothing executes | `capability_denied`, `lease_missing` (`src/control/capabilityLeases.ts`); `approval_denied` (`src/control/approvals.ts`) |
| `authority-widening` | negative | wider target, extra capability, or scope escape vs. the granted lease is refused | `targetsEqual`/`authorityKeys` exact-target matching and renewal-identity lock (`src/control/capabilityLeases.ts`); path containment (`src/control/scope.ts`) |
| `stale-correlation` | negative | wrong task/actor/lease-revision binding is refused, not re-bound | `lease_revision_mismatch`, `lane_conflict` (`src/control/leases.ts`); `approval_identity_mismatch` (`src/control/approvals.ts`) |
| `duplicate-retry` | negative+positive | retry with the same correlation resolves to the one recorded effect; no second execution | idempotency-key dedup and journal replay (`src/control/runtime.ts`; `docs/CONTROL-PLANE.md` §2) |
| `ambiguity-fence` | negative | conflicting/ambiguous evidence yields explicit `unknown`, never a guessed success | `CommandOutcome` `unknown` status (`src/control/types.ts`); `compactedCommandOutcome` + exact-outcome sidecar digests (`src/control/journal.ts`) |
| `restart` | negative+positive | after restart the same identity and exact known/unknown state return; owner epoch fences stale actors | owner epoch + `owner_restarted` (`src/control/ownerLock.ts`, `src/control/capabilityLeases.ts`); `recoverNonterminalCommands` (`src/control/journal.ts`) |
| `downgrade` | negative | reads/writes outside the pin's declared compatibility window are refused | pin `compatibility` (§3.1); additive persistence rule (map §Migration seams) |
| `unknown-enum` | negative | unknown enum value fails closed (`reject`), never coerced | fail-closed style of `capability_denied`/`approval_payload_invalid` (`src/control/capabilityLeases.ts`, `src/control/approvals.ts`) |
| `unknown-version` | negative | unknown major/profile version refuses before any effect | pin verification (§3.2–3.3) |
| `cancellation` | negative | cancellation without a terminal outcome stays `unknown`/unresolved; process disappearance is not success | journal `command.unknown` recovery path (`src/control/journal.ts`); map §Persistence row: never reinterpret process disappearance as successful cancellation |

Negative-vector failure modes that must abort the canary regardless of `expectation`: an effect executing, a success receipt being emitted, authority widening, or an identity fork.

### 4.5 Decision D3 — CI wiring and blocking policy (maintainer)

**Recommendation:** add a `psyche-canary` CI job that (a) runs on every PR that touches `docs/psyche/**`, the future `src/control/psyche/**`, or the canary workflow wiring — the same path-scoped pattern as `scripts/classify-ci-changes.sh` used by `.github/workflows/ci.yml` — and (b) is a **required** check for exactly those changes. A red canary therefore blocks only contract-adopting changes, per the issue, and does not retroactively declare `v0.0.1` unsupported. Promotion to an unconditional release requirement is a separate support decision recorded in `docs/SUPPORT-MATRIX.md` / `docs/RELEASE-ACCEPTANCE.md`.

Alternatives: always-required on every PR (blocks unrelated product work with protocol latency; rejected until the profile is a release requirement) or advisory non-required check (no enforcement; rejected because it silently rots).

### 4.6 v0.0.1 non-retrogression

The canary's red state never rewrites the support story of an already-released Build version: `docs/SUPPORT-MATRIX.md` claims remain tied to their own release evidence, and the pin's `status: retired` does not delete historical evidence. This matches the issue's "do not retroactively declare `v0.0.1` unsupported".

## 5. Incremental adapters (slice 4)

### 5.1 Adapter mode state machine

The adapter is one component with one mode at a time, per domain (task correlation, lease translation, approval translation, receipt projection, cancellation, recovery):

```text
 ┌──────────┐  profile pinned + canary green   ┌──────────┐  equivalence proven
 │ disabled │ ────────────────────────────────▶│  shadow  │  for the domain
 └──────────┘  records correlation only,       └────┬─────┘  (canary + focused
               no enforcement change                │       migration tests)
                                                    ▼
              removing duplicate local        ┌────────────┐
        ┌─────────────┐   semantics allowed   │ enforcing  │
        │   retired   │◀──────────────────────└─────┬──────┘
        └─────────────┘                             │ pin quarantined /
              ▲                                     │ canary red
              │ disable/rollback (any state)        ▼
        └─────────────┐                      ┌──────────┐
                      └──────────────────────│ disabled │
                                             └──────────┘
```

- `disabled → shadow`: additive correlation recording only (map §Seam A). Existing behavior bit-for-bit; no new authority. In `shadow` the adapter observes and records; in `enforcing` it translates verified Psyche grants into exact local assertions and projects receipts; in `retired` the duplicate local semantics for that domain are gone.
- `shadow → enforcing` per domain **only** after canary equivalence evidence for that domain, and — for lease/approval enforcement — after the `OpenCoven/psyche#12` ownership gate.
- A domain reaches `retired` only after its equivalence evidence justifies removing the duplicate local semantics (issue slice 4, final checkbox); that removal is always a separate reviewed change, never a side effect of entering `enforcing`.
- Any state → `disabled` is the rollback: correlation fields stay (they are additive), no effects are replayed, local authority (`src/control/runtime.ts`) is already the only mutation path, so disabling cannot fork identity.

### 5.2 Seam A — correlation envelope and binding

The envelope validates against [`docs/psyche/correlation-envelope.schema.json`](psyche/correlation-envelope.schema.json): a `local` side (`taskId` ≤ `MAX_CONTROL_TASK_ID_LENGTH` = 256 per `src/control/taskIdentity.ts`; optional local action id), an optional `protocol` side (ids **assigned by the pinned profile's authority**, never minted by Build from product state), and a `binding` state:

```text
 local-only ── profile assigns protocol id ──▶ bound ── conflicting caller/local
                                                   │      id for the same slot
     ▲                                             ▼
     └──────── adapter disabled/rolled back ── quarantined (refuses, records)
```

Rules (map §Seam A, enforced by the schema's `conflictPolicy: "reject"`):

- absent protocol ids preserve existing behavior;
- once a slot is bound, a conflicting id fails closed;
- protocol ids never derive from pane ids, paths, branch names, provider ids, Beads, or GitHub issues — the canonical-root in `src/control/projectIdentity.ts` stays a lookup key, pane/worktree/branch stay `Intentional product-local state`, and `ControlActorKind`'s existing `compatibility` kind (`src/control/types.ts`) is how adapter traffic identifies itself to the runtime;
- persistence writes old and new correlation fields transactionally or rolls back the migration (journal discipline in `src/control/journal.ts`).

### 5.3 Seam B — capability and approval translation

The adapter may translate a verified Psyche grant into the **exact** local assertion and then let the existing stores authorize — never authorizing independently:

- lease: `CapabilityLease { id, requestId, revision, ownerEpoch, actorId, taskId, grants, createdAt, expiresAt }` (`src/control/capabilityLeases.ts`). A translated lease is constructed through `grant()` and asserted through `assert()`, inheriting revision/expiry/owner-epoch/target/capability checking, TTL cap `AGENT_CONTROL_LIMITS.leaseTtlMs`, and bounded lifecycle history.
- approval: `Approval` binds action, task, actor/subject, `leaseId`+`leaseRevision`, resource, capability, redacted effect, and `executablePayloadDigest` (`src/control/approvals.ts`). Translation must preserve consume-once (`consumed`), denial, expiry (`approval_expired`, `AGENT_CONTROL_LIMITS.approvalTtlMs`), capacity limits, and both digests. A Psyche approval is never reduced to a boolean.

Denial mapping from §4.4 vectors to existing codes: unknown-enum/wider-target/stale-correlation → `capability_denied` / `lease_revision_mismatch` / `approval_digest_mismatch`; wrong owner epoch → `owner_restarted`.

### 5.4 Seam C — receipt projection

```text
 local effect reaches authoritative terminal path
   (journal terminal event + exact sidecar, src/control/journal.ts)
        │                       │
        ▼ terminal & replayable │ terminal but ambiguous / compacted-unknown
  ┌───────────────┐             ▼
  │ receipt       │      ┌──────────────┐   never before local terminal,
  │ emitted       │      │ withheld     │   never from UI/process/transport
  │ (profile-     │      │ (unknown,    │   state; never re-derived from a
  │  provenance)  │      │  quarantined)│   pane, branch, or provider answer
  └───────────────┘      └──────────────┘
```

- Projection is derived from the journaled `CommandOutcome` (`succeeded | failed | unknown | rejected`, `src/control/types.ts`) plus immutable correlation metadata; the map's rule stands: no success receipt before the effect is terminal and durably replayable.
- Emitted receipts carry profile id + digest provenance so a later pin change cannot reinterpret them (map §Rollback contract).
- `unknown` (including `idempotency_outcome_compacted` and recovery `command.unknown`) projects to an explicit unresolved Psyche state or no receipt — never to success (`src/control/journal.ts`).

### 5.5 Seam D — restart/reconnect restoration

Persist protocol correlation next to the existing durable recovery keys, then on restart, in order: load local recovery state → re-verify the pin → validate stored correlation → restore the same Psyche ids if valid → surface `unknown`/quarantine otherwise → never rerun a consequential effect because protocol evidence is unavailable (map §Seam D). Owner-epoch fencing continues to fence superseded daemons (`src/control/ownerLock.ts`, `owner_restarted`).

### 5.6 Migration order and per-slice rollback

**Recommendation (decision D4):** migrate one bounded lifecycle at a time, in this order — (1) task correlation envelope, (2) capability-lease translation, (3) approval translation, (4) action/receipt projection, (5) cancellation semantics, (6) restart/recovery. Rationale: correlation is purely additive (no enforcement), lease translation precedes approvals because approvals bind `leaseId`/`leaseRevision`, receipts precede cancellation/recovery because both consume receipts. Each slice:

- **entry:** pin active + canary green for that domain's vectors; ownership gate satisfied where enforcement changes;
- **exit:** equivalence proven (canary + focused migration tests), after which *duplicate local semantics* for that domain may be removed in a separate reviewed change;
- **rollback:** additive correlation fields remain readable (compatibility reads), adapter mode returns to `disabled`, no destructive migration, no replayed effects, receipts keep their provenance (map §Rollback contract; journal compatibility in `src/control/journal.ts`).

Adapter code location (decision D5): recommend `src/control/psyche/**` (translation must sit behind the single mutation authority and shares the R3 boundary with `src/control/runtime.ts`), alternative `src/adapters/psyche/**` rejected because `src/adapters/` today holds product action adapters, not authority-adjacent translation, and the map requires the adapter "behind or alongside" `ControlRuntime` (`docs/CONTROL-PLANE.md` §2; `docs/REPOSITORY-MAP.md` change-routing row "Psyche protocol adoption").

### 5.7 Never-rules

Repeated from the map because adapters are where they would be violated: no stable identity from Beads, GitHub, tmux, a process, a path, a provider session, a transport, or a UI selection; UI state may choose what to display or request, never grant authority or prove completion; tracker ids stay planning-plane only.

## 6. Reference flow (slice 5)

Desktop task → isolated lane → execution/evidence → guarded action → approval/receipt → restart/reconnect → **same identity resumes**, as one bounded receipt chain:

1. **Task:** operator/agent creates a task; Build records `local-only` correlation; profile assigns the Psyche task id (§5.2).
2. **Lane:** delegation binds the task to a lane; pane/worktree/branch remain product-local attachments (`LaneLease {paneId, actorId, actorKind, taskId?, revision, expiresAt}`, `src/control/leases.ts`); the lane's canonical identity is the bound Psyche lane id.
3. **Execution/evidence:** every mutation crosses `ControlRuntime.submit` (`src/control/runtime.ts`), is journaled before the effect (`src/control/journal.ts`), and per-pane order is preserved by the runtime's serialization (`docs/CONTROL-PLANE.md` §2.4).
4. **Guarded action:** capability assertion through `src/control/capabilityLeases.ts`; effect dispatch only at the daemon effect boundary (`src/daemon/index.ts`, `src/daemon/controlHandlers.ts`).
5. **Approval/receipt:** `ApprovalStore` consume-once (`src/control/approvals.ts`), then a projected receipt with profile provenance (§5.4).
6. **Restart/reconnect:** Seam D restoration returns the same ids or explicit `unknown` (§5.5).

Extensions and boundaries: iOS observation/approval waits for #200's connection/readiness and physical acceptance gates (issue §Delivery slices; `docs/SUPPORT-MATRIX.md`); Familiar/Threads/Coven ownership boundaries follow `OpenCoven/psyche#12`; Threads execution is not claimed until the adapter implements it (issue non-goals). The bridge wire protocol between Build and the iOS client (`protocol-fixtures/`, mirrored by `src/services/bridge/wireProtocol.ts` and `native/ios/PsycheCore/.../BridgeMessages.swift`) remains a product transport — its fixtures pattern (typed source, generated JSON, contract tests both sides, `protocol-fixtures/README.md`) is the model for how the future Psyche profile vectors will be kept drift-free, not a place to invent Psyche messages.

## 7. Normative seam types (TypeScript)

Build-owned; deliberately **not** mirrors of unreleased Psyche wire types. These are the shapes the JSON Schemas in `docs/psyche/` constrain; the implementation PR that lands the adapter types them under `src/control/psyche/` (D5). Shown here as the reviewable normative reference — no `src/` file is added by this change.

```ts
export type PsycheProfileId = `opencoven.psyche.consumer@${number}.${number}.${number}`;
export type Sha256Hex = string; // 64 lowercase hex chars
export type GitSha = string;    // 40 lowercase hex chars

export interface PsycheProfilePin {
  readonly schemaVersion: 1;
  readonly consumer: { readonly repository: 'OpenCoven/psyche-build'; readonly commitSha: GitSha };
  readonly profile: { readonly id: PsycheProfileId; readonly major: number; readonly source: string };
  readonly artifact: {
    readonly uri: string;
    readonly digestAlgorithm: 'sha256';
    readonly digest: Sha256Hex;
    /** Out-of-band publication of the digest (release evidence), not the artifact itself. */
    readonly digestSource: string;
  };
  readonly compatibility: {
    readonly unknownFieldPolicy: 'reject' | 'ignore-and-record';
    readonly unknownEnumPolicy: 'reject';
    readonly readableProfiles: readonly PsycheProfileId[];
  };
  readonly status: 'active' | 'quarantined' | 'retired';
  readonly pinnedAt: string; // ISO-8601 UTC
}

export type PsycheCanaryCategory =
  | 'negotiation' | 'lifecycle' | 'denial' | 'authority-widening' | 'stale-correlation'
  | 'duplicate-retry' | 'ambiguity-fence' | 'restart' | 'downgrade'
  | 'unknown-enum' | 'unknown-version' | 'cancellation';

export interface PsycheCanaryVector {
  readonly schemaVersion: 1;
  readonly id: string; // psyche-canary-*
  readonly category: PsycheCanaryCategory;
  readonly kind: 'positive' | 'negative';
  readonly profile: PsycheProfileId;
  readonly description: string;
  readonly input: { readonly profileVectorId: string; readonly payload: unknown };
  readonly expectation:
    | { readonly result: 'accepted'; readonly must: readonly string[] }
    | {
        readonly result: 'reject' | 'deny' | 'ambiguous-unknown' | 'quarantine' | 'fail-closed';
        readonly mustNot: readonly ('effect-executed' | 'success-receipt' | 'authority-widened' | 'identity-forked')[];
      };
}

export interface PsycheCanaryEvidence {
  readonly schemaVersion: 1;
  readonly consumer: { readonly repository: 'OpenCoven/psyche-build'; readonly commitSha: GitSha };
  readonly profile: { readonly id: PsycheProfileId; readonly digest: Sha256Hex };
  readonly artifactDigestVerified: boolean;
  readonly environment: { readonly ci: boolean };
  readonly vectors: readonly {
    readonly id: string;
    readonly category: PsycheCanaryCategory;
    readonly kind: 'positive' | 'negative';
    readonly result: 'pass' | 'fail';
    readonly notes?: string; // ≤512 bytes
  }[];
  readonly summary: {
    readonly positive: { readonly total: number; readonly passed: number; readonly failed: number };
    readonly negative: { readonly total: number; readonly passed: number; readonly failed: number };
  };
  readonly result: 'pass' | 'fail';
  readonly generatedAt: string; // ISO-8601 UTC
}

export type CorrelationBindingState = 'local-only' | 'bound' | 'quarantined';

export interface PsycheCorrelationEnvelope {
  readonly schemaVersion: 1;
  readonly local: {
    readonly taskId?: string; // ≤ MAX_CONTROL_TASK_ID_LENGTH (256), src/control/taskIdentity.ts
    readonly actionId?: string;
  };
  /** Present only when bound; ids are assigned by the pinned profile's authority. */
  readonly protocol?: {
    readonly profileId: PsycheProfileId;
    readonly taskId?: string;
    readonly laneId?: string;
    readonly actionId?: string;
    readonly receiptId?: string;
    readonly boundAt: string;
  };
  readonly binding: {
    readonly state: CorrelationBindingState;
    readonly conflictPolicy: 'reject';
  };
}
```

## 8. Golden examples

Checked-in examples under [`docs/psyche/examples/`](psyche/examples/), each an instance of its schema:

| File | Demonstrates |
| --- | --- |
| `psyche-profile-pin.example.json` | an active pin with digest corroboration and a readable downgrade window |
| `canary-vector-negotiation-positive.example.json` | positive negotiation vector with `must` invariants |
| `canary-vector-authority-widening-negative.example.json` | wider-target denial with `mustNot: ["effect-executed", "authority-widened"]` |
| `canary-vector-stale-correlation-negative.example.json` | stale lease-revision/task correlation denial |
| `canary-evidence-pass.example.json` | a full evidence receipt: pin verified, all vectors passed, `result: "pass"` |
| `correlation-envelope-bound.example.json` | a `bound` envelope with local + protocol slots and `conflictPolicy: "reject"` |

These are **examples of Build-owned shapes**, not Psyche wire captures; no Psyche protocol bytes exist here.

## 9. Maintainer decision register

| # | Decision | Recommendation | Alternatives considered | Owner gate |
| --- | --- | --- | --- | --- |
| D1 | Pin format | Committed pin manifest + digest-verified release artifact (§3.1) | npm package dep; vendored artifact copy; floating `main` (forbidden) | #253 reviewers |
| D2 | Artifact transport/cache | Fetch per run; digest-keyed cache allowed with re-verification (§3.5) | commit artifact bytes; trust cache | #253 reviewers |
| D3 | Canary CI policy | Path-scoped required check blocking only contract-adopting changes; promotion to release requirement is a separate support decision (§4.5) | always-required; advisory | #253 + `docs/SUPPORT-MATRIX.md` owner |
| D4 | Migration order | correlation → leases → approvals → receipts → cancellation → recovery, one domain per slice (§5.6) | approval-first (rejected: approvals bind lease revision); all-at-once (big-bang, forbidden) | `OpenCoven/psyche#12` + #253 |
| D5 | Adapter code location | `src/control/psyche/**` (R3 boundary shared with the authority) | `src/adapters/psyche/**`; standalone package | #201 architecture owner |

## 10. Acceptance mapping

| #253 acceptance criterion | Advanced by |
| --- | --- |
| Current-state mapping approved before implementation | satisfied by PR #262 (slice 1); this plan builds on it |
| Pin an immutable, released Psyche consumer profile | §3 design + `docs/psyche/pin.schema.json`; **execution waits for `OpenCoven/psyche#11`** |
| CI runs required positive and negative canaries on the exact PR head | §4 design + vector/evidence schemas + consumer commit sha in evidence; wiring decision D3 |
| No stable identity depends on Beads/GitHub/tmux/process/path/provider/transport/UI | §5.2 binding rules + §5.7 never-rules |
| Existing user-visible behavior and macOS release claims remain truthful | adapter modes start at `disabled` (no behavior change); §4.6 non-retrogression |
| Every migrated consequence preserves scope/authority/approval/idempotency/receipt/revocation/recovery | §5.3–5.5 preserving the cited invariants |
| Failed migrations roll back without data loss, duplicate effects, or identity forks | §5.1 rollback path + §5.6 per-slice rollback |
| #201 and `OpenCoven/psyche#13` link final reference-flow evidence | §6 defines the evidence chain; linking happens on the implementing PRs |

## 11. What this change does not do

No runtime code, no `src/` changes, no workflow/branch-protection changes, no dependency changes, no pin content (the pin file is created only when a released profile exists to pin), no canary runner implementation, and no claim of Psyche conformance. Implementation slices land separately, each gated per §5.6 and the #253 sequencing rules (mapping may proceed during stabilization; the pin waits for `OpenCoven/psyche#11`; ownership-sensitive work waits for `OpenCoven/psyche#12`; adapters must not become an implicit prerequisite for #196/#199/#200).

## 12. Code-path citation index

| Claim | Path |
| --- | --- |
| Single mutation authority; idempotency; owner-epoch check; per-pane serialization | `src/control/runtime.ts`, `docs/CONTROL-PLANE.md` |
| Lane lease shape and revision/expiry enforcement | `src/control/leases.ts` |
| Capability lease shape, exact-target grants, denial codes, history bounds | `src/control/capabilityLeases.ts`, `src/control/limits.ts` |
| Approval intent binding, digests, consume-once, limits | `src/control/approvals.ts`, `src/control/limits.ts` |
| Command/outcome types, idempotency key, actor kinds | `src/control/types.ts` |
| Journal kinds, exact-outcome sidecars, compaction, recovery | `src/control/journal.ts` |
| Owner epoch fencing | `src/control/ownerLock.ts` |
| Project scope containment; canonical root as lookup key | `src/control/scope.ts`, `src/control/projectIdentity.ts` |
| Local task-id normalization bound (256) | `src/control/taskIdentity.ts` |
| Canonical bounded JSON | `src/control/boundedJson.ts` |
| Control socket protocol and `compatibility` principal | `src/control/protocol.ts` |
| Daemon effect boundary | `src/daemon/index.ts`, `docs/CONTROL-PLANE.md` |
| Wire-fixture drift-prevention model | `protocol-fixtures/README.md`, `src/services/bridge/wireProtocol.ts` |
| Path-scoped CI classification | `scripts/classify-ci-changes.sh`, `.github/workflows/ci.yml` |
| Field classification and seam inventory (slice 1) | `docs/PSYCHE-COMPATIBILITY-MAP.md` |
| Risk classes for the implementation PRs | `AGENTS.md` |
| Design-history location convention | `docs/superpowers/README.md` |
