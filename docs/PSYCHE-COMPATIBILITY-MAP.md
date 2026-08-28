# Psyche Build → Psyche compatibility map

Date: 2026-08-28  
Status: Current-state mapping for issue #253; **not** a protocol-conformance claim

## Purpose

This document freezes the pre-adapter state model Psyche Build exposes today and classifies each important identity or lifecycle field into one of four buckets:

1. **Psyche-owned target semantic** — the field is expected to become a projection of a released Psyche contract.
2. **Adapter seam** — Build may retain its current product interface while translating to/from Psyche.
3. **Protocol gap / blocked** — no released Psyche consumer profile exists yet, so Build must not invent a canonical replacement.
4. **Intentional product-local state** — the field remains UI/runtime composition and must never become durable protocol identity.

The immutable protocol pin and compatibility runner are blocked on `OpenCoven/psyche#11` and the ownership policy in `OpenCoven/psyche#12`. Until those land, this repository may map and prepare seams, but it must not claim Psyche protocol conformance or direct-read Psyche persistence.

## Ownership boundary

Psyche Build remains the coding cockpit. It owns product-local composition around projects, panes, terminals, tmux sessions, worktrees, branches, desktop/browser/TUI/iOS presentation, and optional provider integrations.

Psyche is the target canonical orchestration protocol for task, lane, execution, capability/lease, approval, action, receipt, cancellation, recovery, and compatibility semantics.

The Coven daemon remains authoritative for actual process/PTY execution, project-boundary enforcement, and runtime events. A pane, process, tmux id, worktree, branch, path, provider session, Bead, GitHub issue, or UI selection is therefore never sufficient evidence of canonical identity, authority, completion, or recovery.

## Current-state inventory

| Domain | Current Build representation | Current authority | Psyche target | Classification | Migration rule |
|---|---|---|---|---|---|
| Project scope | canonicalized project root; owner/control state derives from it | Build host/control plane + daemon project boundary | project/snapshot scope or equivalent released contract | Adapter seam | Preserve current canonical root as a local lookup key; never promote a filesystem path to durable Psyche identity. |
| Task correlation | `taskId` appears in task-bound control credentials, capability leases, approvals, actions, and status queries | Build control plane | canonical Psyche task identifier | Psyche-owned target semantic | Add a protocol-owned task id alongside current compatibility fields; reject mismatched caller-supplied correlation. |
| Lane surface | pane/worktree/branch plus lane leases | Build product/control plane | canonical Psyche lane identifier and lane state | Adapter seam | Keep pane/worktree/branch as local projections; bind them to a Psyche lane instead of deriving lane identity from them. |
| Pane identity | tmux pane id / pane metadata / generation | daemon + Build control surface | execution/resource attachment only | Intentional product-local state | Never use pane id as task, lane, action, receipt, or recovery identity. Generation remains a local stale-resource fence. |
| Worktree identity | filesystem worktree path + Git branch | Build/git | isolation attachment only | Intentional product-local state | Worktree and branch remain implementation details; migration must survive path/branch rename without identity fork. |
| Provider session | optional agent/provider/Coven session ids | provider integration / daemon | execution embodiment or provider attachment | Adapter seam | Store provider ids only as embodiment metadata beneath canonical execution identity. |
| Owner epoch | monotonic owner lock epoch | Build control host | execution/authority fencing concept | Adapter seam | Retain as a local daemon-owner fence unless/until the released Psyche profile defines a compatible fence; never widen authority across epochs. |
| Lane lease | `LaneLease { paneId, actorId, actorKind, taskId?, revision, expiresAt }` | Build `LaneLeaseStore` | canonical lane-control lease or equivalent | Psyche-owned target semantic after profile release | Preserve fail-closed revision/expiry behavior; do not infer a Psyche lease from pane ownership alone. |
| Capability lease | `CapabilityLease { id, requestId, revision, ownerEpoch, actorId, taskId, grants, expiresAt }` | Build capability lease store | canonical capability/lease grant | Psyche-owned target semantic after profile release | Adapter must preserve exact actor/task/scope/capability binding, expiry, revision, revocation, and owner fence. |
| Approval | `Approval` binds action, task, actor/subject, lease id+revision, target, capability, effect and executable payload digest | Build approval store | canonical approval / verdict | Psyche-owned target semantic after profile release | Do not reduce approval to a boolean. Preserve intent digest, identity binding, expiry, denial, consumption, revocation, and one-action semantics. |
| Action identity | `actionId` plus command/idempotency keys in control runtime | Build control runtime | canonical Psyche action id / attempt correlation | Psyche-owned target semantic after profile release | Introduce protocol id alongside local id; retries must resolve to one effect or an explicit ambiguous/unknown state. |
| Receipt/outcome | durable `CommandOutcome`, journal terminal events, exact sidecars and redacted retained projections | Build control journal/runtime | canonical action receipt / execution evidence | Psyche-owned target semantic after profile release | Adapter must not reconstruct success from UI/process state. Canonical receipt projection must be derived from the authoritative result path. |
| Idempotency | `idempotencyKey`, durable exact outcomes, retained compacted markers | Build control runtime/journal | canonical retry/idempotency semantics | Adapter seam | Preserve non-duplication across reconnect/restart. Unknown or unavailable durability must fail closed rather than replay an effect. |
| Cancellation / interruption | pane/control actions and orchestration lifecycle-specific cancellation paths | Build runtime/orchestrator/daemon | canonical cancellation acknowledgement and unresolved outcome | Protocol gap until released profile | Map current behavior before adopting; never reinterpret process disappearance as successful cancellation. |
| Persistence | control journal, durable snapshots/sidecars, credential state, product session/worktree state | Build local stores + daemon | protocol-defined durable identity/evidence projections | Adapter seam | Keep existing persisted formats readable during migration; protocol ids are additive first. No big-bang rewrite. |
| Recovery | nonterminal command recovery, pane/worktree recovery markers, owner fencing, reconnect behavior | Build control/runtime/product recovery | canonical Psyche recovery semantics | Psyche-owned target semantic after profile release | Restart must preserve identity and exact known/unknown state; never silently mint a new task/lane/action to escape ambiguity. |
| UI selection | active project, selected pane/thread, focused tab, visible session | Build UI | none | Intentional product-local state | UI state may choose what to display or request; it must never grant authority or prove completion. |
| Beads / GitHub issue | planning and public-mirror identifiers | Beads/GitHub planning plane | none | Intentional product-local state | Never use tracker identity as runtime task/action/receipt identity. |

## Current invariants that adapters must preserve

### 1. One mutation authority

`docs/CONTROL-PLANE.md` defines the current Build invariant: every state-changing daemon operation flows through one `ControlRuntime`, which performs owner fencing, lease/scope checks, idempotency handling, per-pane serialization, durable journaling, and only then dispatches the real effect. A Psyche adapter must sit behind or alongside this authority boundary during migration; it must not create a second mutation path.

### 2. Capability scope is explicit

`src/control/capabilityLeases.ts` binds a capability lease to `actorId`, `taskId`, an owner epoch, revision, expiry, a concrete target, and enumerated capabilities. Any future Psyche lease projection must be at least as restrictive. Translation failure, unknown capabilities, stale revisions, or widened targets fail closed.

### 3. Approval is an intent-bound record

`src/control/approvals.ts` binds approval to one action, task, actor/subject, lease revision, resource, capability, redacted effect, and executable-payload digest. A future adapter cannot collapse this into `approved: true`; it must preserve identity, intent, expiry, denial/revocation, and consume-once behavior.

### 4. Receipts come from the authoritative effect path

Current `CommandOutcome` evidence is journaled and replay-aware. Product state such as “pane vanished”, “branch exists”, “provider says done”, or “button disabled” cannot substitute for an authoritative terminal result. The Psyche adapter must preserve that distinction and eventually map the authoritative result to the released Psyche receipt shape.

### 5. Recovery cannot fork identity

A crash, reconnect, moved worktree, restarted daemon, lost provider session, or stale UI must recover the same known protocol identity or surface an explicit unresolved/unknown result. Recovery must never manufacture a new task/lane/action merely to regain progress.

## Migration seams

The migration should remain additive and reversible until compatibility evidence proves equivalence.

### Seam A — protocol correlation envelope

Add optional protocol-owned identifiers to the internal orchestration/control context rather than replacing existing fields immediately:

```text
localTaskId?       -> psycheTaskId?
localLaneRef?      -> psycheLaneId?
localActionId      -> psycheActionId?
localReceiptRef?   -> psycheReceiptId?
protocolProfile?   -> immutable profile id + digest
```

Rules:

- absent protocol ids preserve existing behavior while the adapter is disabled;
- once an operation is bound to a Psyche id, conflicting caller/local ids are rejected;
- protocol ids never derive from pane ids, paths, branch names, provider ids, Beads, or GitHub issues;
- persistence writes old and new correlation fields transactionally or rolls back the migration.

### Seam B — capability and approval translation

The existing lease and approval stores remain the local enforcement path during early adoption. The adapter may translate a verified Psyche capability/approval into the current exact local assertion, but it may not independently authorize an effect. Unknown enum/version, wider target, missing subject binding, stale correlation, digest mismatch, or downgrade request is a denial.

### Seam C — canonical receipt projection

After an effect reaches the existing authoritative terminal path, the adapter may construct a Psyche receipt projection from the exact outcome plus immutable correlation metadata. It must never generate a success receipt before the local effect is terminal and durably replayable under the current contract.

### Seam D — restart/reconnect restoration

Persist protocol correlation next to the existing durable recovery keys. On restart:

1. load existing local recovery state;
2. validate the pinned protocol profile and stored correlation;
3. restore the same Psyche ids if evidence is valid;
4. surface `unknown`/quarantine if the local outcome is ambiguous or the protocol pin cannot be verified;
5. never rerun a consequential effect solely because protocol evidence is unavailable.

## Known protocol blockers

The following work must not be implemented by guessing types in Psyche Build:

- exact task/lane/execution/action/receipt schema names and fields;
- profile negotiation record and supported-version envelope;
- canonical byte representation and digest rules;
- unknown-field and unknown-enum behavior;
- cancellation acknowledgement/unresolved-result representation;
- ambiguity/fencing and restart vectors;
- migration/downgrade compatibility window;
- artifact provenance and release signature/checksum contract.

Those are owned by `OpenCoven/psyche#11` and `OpenCoven/psyche#12`. Build consumes one immutable released profile after those gates pass.

## Canary design after profile publication

The first canary must be offline and credential-free. It should verify the exact artifact digest before executing the profile runner and emit a bounded JSON receipt with at least:

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

Required negative vectors include unknown major/profile, digest mismatch, authority widening, stale task/lane/action correlation, duplicate/retry, ambiguity/fence, restart, downgrade, malformed/unknown enum, and cancellation with unresolved outcome.

A red canary initially blocks only PRs that modify the protocol adapter/pin surface. It does not retroactively make `v0.0.1` unsupported. Promotion into a repository-wide release requirement is a later explicit support decision.

## Rollback contract

Before each adapter slice:

- current local persisted records remain readable;
- new protocol correlation fields are additive and optional;
- no destructive migration is required merely to disable the adapter;
- disabling the adapter returns to the previous local authority path without replaying effects;
- receipts already emitted retain immutable profile/version provenance;
- incompatible or unverifiable protocol state is quarantined rather than rewritten into a locally convenient identity.

## Acceptance for the mapping slice

This mapping slice is complete when:

- every state category named in #253 is classified above;
- product-local references are explicitly barred from becoming stable protocol identity;
- current authority/approval/idempotency/receipt/recovery invariants are preserved;
- migration and rollback constraints are explicit;
- exact profile/schema details remain blocked on released Psyche artifacts rather than guessed locally;
- focused tests protect these boundary statements from documentation drift.

Approval of this document satisfies only delivery slice 1 of #253. It does **not** satisfy the immutable-pin, canary, adapter, or reference-flow acceptance criteria.