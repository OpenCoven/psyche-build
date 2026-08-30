# Phase 9 full-lifecycle validation and review protocol

- **Contract owner:** `psyche-i7c.9.5` — Validate and review full lifecycle actions ([OpenCoven/psyche-build#221](https://github.com/OpenCoven/psyche-build/issues/221))
- **Phase 9 parent:** `psyche-i7c.9` ([#217](https://github.com/OpenCoven/psyche-build/issues/217)) — Phase 9: full lifecycle merge, PR, stop, close, and cleanup
- **Epic:** `psyche-i7c` — Mobile multiproject and multipane cockpit ([#208](https://github.com/OpenCoven/psyche-build/issues/208))
- **Canonical outcome:** #200 (iOS internal beta and continuity loop). Earlier broad prose references to the gh-195 outcome for this iOS family are historical/superseded (2026-08-28 reconciliation note); #200 stays the source of truth.
- **Machine-checkable companion:** [`src/review/lifecycleReviewChecklist.ts`](../../src/review/lifecycleReviewChecklist.ts) (record version **v1**)
- **Complementary contract:** [`docs/review/MOBILE-BRANCH-HANDOFF.md`](MOBILE-BRANCH-HANDOFF.md) owns the whole-branch handoff checklist for `psyche-i7c.10.6` (#215); this document owns the **Phase 9** validation and review gates that feed its `i7c.9.5.lifecycle-review-signoff` row. Neither file duplicates the other's gates.
- **Contract version:** v1, 2026-08-30

This document defines the validation and review **contract** for Phase 9's full lifecycle actions (merge, PR, stop, close, and cleanup on mobile). It is not itself evidence and it does not approve anything: every checklist item below is closed only by a phase-review record entry with a verifiable evidence pointer, and approval is computed, not asserted. Executing the suites and reviews belongs to the phase owner once the implementation slices (#218–#220) land; this contract defines how their outcome is validated.

## 1. Purpose, scope, and authority

### Purpose

Make the Phase 9 review executable and auditable: (a) enumerate the lifecycle host/core/UI suites that must run, (b) define the spec-compliance, security, and code-quality review checklists, (c) state the approval criteria and the severity rules under which findings block phase closure, and (d) bind all of it to a versioned record that a maintainer can validate mechanically.

### Scope

- Suites to run: existing mainline host/core/UI regressions (§2) plus the fixture suites delivered by #219/#220.
- Spec-compliance review checklist tracing every #217 acceptance criterion and child gate (§3).
- Security review checklist focused on **no bypass of existing merge/PR/cleanup safeguards** (§4).
- Code-quality review checklist with severity classification (§5).
- Approval criteria and the phase-review record (§6), and how findings block phase closure (§7).

### Out of scope

- Implementing any Phase 9 slice: #218 owns the native pane action menu and guarded confirmations, #219 owns the merge/PR interactive workflows, #220 owns the fixture requesters, UI tests, and host coverage. This protocol reviews their output; it does not produce it.
- Executing the review now: #221 is blocked by #220. Until the dependency closes, every checklist item is legitimately `not-run` — except the security no-bypass items, which may never be recorded `not-run` (§4) and therefore block the phase until an explicit verdict exists.
- The whole-branch handoff gates (Beads hygiene, clean worktree, required checks, independent branch review): those belong to `MOBILE-BRANCH-HANDOFF.md` (#215). This protocol's record closes only `i7c.9.5`.
- Merging, closing issues, editing Beads records, or pushing to `main`.

### Authority boundaries that review must preserve

Per `AGENTS.md` and the control-plane docs, lifecycle actions are **R3** (authority, security, consequential actions). The review must confirm, not assume:

- The paired host remains the single source of truth for workspace, action, merge/PR, and cleanup validation. The mobile client consumes versioned protocol envelopes over the bridge; it never direct-reads Psyche's database, duplicates canonical protocol state, or infers authority/completion from a UI selection, tmux pane, process, path, worktree, branch, provider session, Bead, or GitHub issue.
- Confirmation, receipt, revocation, idempotency, and recovery semantics are preserved end to end: an action is executed once per idempotency key, acknowledged only after the host operation succeeds, and never re-executed silently after an ambiguous failure.
- No test or review accommodation may weaken any of the above. A test that only passes by relaxing a safeguard is itself a Critical finding (§5).

## 2. Validation protocol: lifecycle suites to run

Run from the phase-branch checkout at the exact head under review. Each row closes exactly one checklist item; run the suites with:

```bash
npx pnpm exec vitest --run <suites...>
```

Every suite below exists on current `main` (the companion module's registry test proves each path exists, so drift breaks the build rather than the review). Run them at the reviewed head and capture per-suite output as the evidence pointer for the matching item.

### Host suites — host action-workflow regressions

| Checklist item | Suites | Pass requirement |
|---|---|---|
| `host.merge-action-regressions` | `__tests__/actions/mergeAction.test.ts` | Merge through the host action keeps sibling-pane handling and exact pane-identity teardown; worktree/branch retained on failure paths. |
| `host.close-cleanup-regressions` | `__tests__/actions/closeAction.test.ts` | Close enters host cleanup choices; cleanup is opt-in and background-safe; prompt-file cleanup stays best-effort. |
| `host.worktree-cleanup-regressions` | `__tests__/worktreeCleanupService.test.ts`, `__tests__/worktreeCleanupCrossProcess.test.ts` | Cleanup never removes a worktree still referenced by sibling panes; cross-process cleanup stays guarded. |
| `host.pr-action-regressions` | `__tests__/actions/createPullRequestAction.test.ts` | PR creation reuses the host flow, including review and message surfaces. |
| `host.remote-action-dispatch` | `__tests__/remotePaneActions.test.ts` | Mobile action requests enqueue/drain/bind/clean up through the host queue, never client-side execution. |

### Core suites — merge/PR decision core, approvals, and the mobile boundary

| Checklist item | Suites | Pass requirement |
|---|---|---|
| `core.merge-validation-regressions` | `__tests__/mergeValidation.test.ts` | Uncommitted-worktree and dirty-main detection and their user choices keep host ownership. |
| `core.merge-target-regressions` | `__tests__/mergeTargets.test.ts` | Target selection, fallback targets, and base-branch rules stay host-owned. |
| `core.multi-merge-orchestrator-regressions` | `__tests__/actions/multiMergeOrchestrator.test.ts` | Per-worktree uncommitted choices and issue handling stay in the orchestrator. |
| `core.conflict-resolution-regressions` | `__tests__/actions/conflictResolution.test.ts` | Conflict and dirty-main handlers keep their prompts, choices, and terminal outcomes. |
| `core.pr-summary-regressions` | `__tests__/prSummary.test.ts` | PR summaries stay host-generated and editable through the existing review surface. |
| `core.control-approval-chain` | `__tests__/controlApprovals.test.ts` | Approval transactions, consume assertions, lease revisions, and redacted effects preserve authority and one-time confirmation. |
| `core.mobile-gateway-action-boundary` | `__tests__/bridge/mobileControlGateway.test.ts`, `__tests__/bridge/mobileActionRegistration.test.ts` | Action and pane scope are validated before the live executor runs; idempotency keys deduplicate execution; owner sessions clear on disconnect. |

### UI suites — menu regressions on main plus the #219/#220 fixture suites

| Checklist item | Suites | Pass requirement |
|---|---|---|
| `ui.pane-action-menu-regressions` | `__tests__/paneMenuActions.test.ts` | The action menu keeps its existing guarded availability and shortcut semantics. |
| `ui.merge-pr-interactive-fixtures` | delivered by #220 (implementing the #219 flows) | Merge confirmation/choice chains and the PR review sheet (title/body editing, related files, final URL) reach terminal outcomes with explicit single-use cancel. |
| `ui.stop-close-cleanup-fixtures` | delivered by #220 | Stop vs close-and-clean-up are visually and semantically distinct; cleanup routes through host cleanup choices. |
| `ui.in-progress-disable-fixtures` | delivered by #220 | In-progress/stale actions are disabled; result/error/progress states are visible. |

The #220 fixture suites land on the phase branch; the record entry for these items points at their exact suite path and green output, never at a description of what the suites are expected to cover.

### Suite-run evidence rules

- Run at the exact head under review; record the head SHA with the outputs.
- A red suite is a finding (§7), not a negotiable gate: `fail` with a pointer to the failure, then fix and re-run.
- Local runs where the host can support them, plus the fork PR's CI checks, are both recorded. Test counts alone do not substitute for the production-path evidence the security review requires (§4).

## 3. Spec-compliance review checklist

Checklist item id `spec.phase-9-acceptance-criteria` closes this section. Execute against the whole Phase 9 diff (base `origin/main` → phase head). Every row must be traced to implementation, tests, and evidence.

| # | Spec requirement (source) | Review question | Trace to |
|---|---|---|---|
| S1 | Merge and PR reuse existing validation, sibling handling, uncommitted choices, fallback targets, and PR review (#217) | Do merge/PR on mobile call the existing host workflows, with zero client-side re-decision? | §2 suites; `src/actions/merge/**`, `src/actions/implementations/{mergeAction,createPullRequestAction}.ts` |
| S2 | Stop terminates the pane while retaining the worktree/branch (#217) | Is retention structural (no cleanup side effect of stop), not just absent in the tested case? | Stop path code + §4 X3 negative tests |
| S3 | Close and Clean Up enters host cleanup choices (#217) | Does cleanup route through `PaneAction.CLOSE` into host choices rather than a parallel client flow? | Close action code + `host.close-cleanup-regressions` |
| S4 | Destructive actions name host/project/pane/worktree/branch and consequence (#217) | Does every confirmation read the consequence before its button, with scoped metadata asserted in fixtures? | #218 gate; `ui.*-fixtures` items |
| S5 | In-progress/stale actions are disabled and tested (#217) | Are stale/running guards enforced in the action chain, not only in the menu render? | `ui.in-progress-disable-fixtures` |
| S6 | Every destructive flow has a tested confirmation/cancel path; merge/PR regressions stay green; fixtures assert scoped metadata (#220) | Are the #220 fixture suites present, deterministic (no wall-clock/sleep assertions), and green at the reviewed head? | `ui.*-fixtures` items' run records |

**Exit rule:** S1–S6 all traced with pointers, and every suite item in §2 pass. Unresolved spec gaps are findings (§5 severity rules) and must block `spec.phase-9-acceptance-criteria`.

## 4. Security review checklist — no bypass of merge/PR/cleanup safeguards

These are the security-class items (`securityClass: true` in the companion module). **They cannot be `not-run`:** the reviewer must reach an explicit `pass` or `fail` verdict backed by evidence before the record validates. A `pass` requires citing the code path(s) *and* the negative test proving a bypass is rejected — "I did not find a bypass" is not evidence.

| Checklist item | What must hold | Required negative test |
|---|---|---|
| `security.merge-safeguard-preservation` | Merge reuses existing validation, sibling handling, uncommitted choices, and fallback targets on every surface. | A merge request that skips or fails host validation is rejected, not silently merged. |
| `security.pr-review-safeguard-preservation` | PR review keeps host authority for validation and generation; the client only edits and navigates. | A PR action that bypasses host review/validation is rejected. |
| `security.stop-retention-boundary` | Stop terminates the pane while retaining worktree and branch; cleanup happens only through explicit host cleanup choices. | Stop never discards work: retained worktree/branch asserted after stop; cleanup choices cannot be defaulted to destructive. |
| `security.destructive-confirmation-integrity` | Every destructive flow names the target and consequence before its button; cancel is explicit and single-use; stale/running actions are disabled. | Confirmation cannot complete without its consequence copy; cancel consumes the flow; disabled actions cannot be invoked through the action chain. |
| `security.authority-scope-idempotency-preservation` | Host-authoritative validation; no direct Psyche DB reads; operations scoped to published workspace resources; confirmation/receipt/revocation/idempotency unchanged. | Out-of-scope or duplicate-idempotency-key requests are rejected/deduplicated by the gateway (`mobileControlGateway` scope and idempotency cases). |

**Preservation set (review explicitly verifies these are unchanged, not merely present):** authority (host decides), confirmation (one-time, consequence-named), receipt (acknowledge only after host success), revocation (owner/session teardown clears capabilities), idempotency (one execution per key+payload), work preservation (stop retains work; cleanup is opt-in), persistence, and recovery.

**Any bypass is a Critical finding** (§5) and blocks the item, the phase, and — through `i7c.9.5.lifecycle-review-signoff` — the branch handoff.

## 5. Code-quality review checklist

Checklist item id `quality.code-review-severity-triage` closes this section. Review the whole Phase 9 diff, not slice-by-slice only; seams between slices (#218 menu → #219 flows → #220 fixtures) are where quality defects hide.

### Structure and layering

- Q1: Lifecycle actions call existing host action workflows; duplicate merge/cleanup/PR logic on the client is a finding.
- Q2: All protocol contact flows through versioned adapters; no direct database reads and no client-side reimplementation of host authority.
- Q3: Stop/cleanup semantics share one host-owned path; divergent per-surface copies are a finding.

### Correctness and state authority

- Q4: Confirmation/choice chains reach terminal outcomes for every branch (confirm, cancel, error, stale); no flow can end in an undefined state.
- Q5: Failure paths preserve work and state: failed merge/cleanup retains the worktree/branch; errors surface with scoped metadata, not silent fallbacks.
- Q6: Idempotency and stale-guard behavior are structural (enforced in the action chain/gateway), not conventions.

### Tests and determinism

- Q7: Every destructive flow has tested confirmation/cancel paths; negative tests cover the §4 boundaries; fixture tests are deterministic (no sleeps, no wall-clock dependence).
- Q8: Existing host merge/PR/action regressions are unchanged or extended additively; no suite was weakened to pass.

### Hygiene

- Q9: Generated outputs untouched by hand; no debug logging, dead flags, or commented-out code left in the phase head; naming/typing consistent with repo conventions.

### Severity classification and blocking rule

| Severity | Definition | Examples in this phase |
|---|---|---|
| **Critical** | Violates authority, security, confirmation, receipt, revocation, idempotency, work-preservation, persistence, or compatibility contracts; risks data loss | A merge path that skips host validation; stop discarding a worktree; credentials or raw prompts in a fixture |
| **Important** | Contract/spec deviation, missing failure-boundary coverage, wrong ordering with user-visible consequence | Untested cancel path; stale action remains enabled; fixture asserts copy but not scope |
| **Minor** | Style, naming, doc polish, test ergonomics | Cosmetic issues, redundant helpers |

**Blocking rule:** the phase is blocked while any Critical or Important finding is open. Minors may be deferred with an owner-acknowledged list recorded alongside `quality.code-review-severity-triage` evidence.

## 6. Approval criteria and the phase-review record

The record is plain JSON-shaped data validated by `src/review/lifecycleReviewChecklist.ts`. Rules (version **v1**):

- `version` must be `1`; unsupported versions are rejected, never reinterpreted.
- `items` must contain exactly one entry for **every** checklist item id; omitted items are `missing-item`, duplicates are `duplicate-item`, unknown ids are `unknown-item` — all invalid, all blocking.
- Every entry carries `status` (`pass` | `fail` | `not-run`), `itemId`, and a non-empty `evidence` pointer (durable file path, URL, run id, or — for `not-run` — a statement naming the concrete blocker or owner gate).
- Security no-bypass items (§4) **cannot be `not-run`**: such an entry produces a `security-not-run` problem and makes the record invalid.
- Unknown fields (record or entry level) are errors, never warnings. Optional record provenance: `reviewer`, `reviewedHead` (non-empty strings).
- `phaseApproved: true` is rejected with `invalid-approval` while any item is not `pass`.
- Structural validity (`valid: true`) is necessary but not sufficient: `phaseApproval()` decides approved vs blocked.

Approval semantics:

```ts
import { phaseApproval, validatePhaseReview } from '../src/review/lifecycleReviewChecklist.js';

const validation = validatePhaseReview(record); // strict structural check
const summary = phaseApproval(record);           // 'approved' | 'blocked' + reasons
```

`approved` requires: a structurally valid record **and** every checklist item `pass`. Any `fail`, `not-run`, or missing entry blocks, with a per-item reason (`gate-failed` / `gate-not-run` / `gate-missing`) naming the item and requirement; an invalid record blocks with `record-invalid` plus the detailed problems.

Example — a blocked record early in the phase (suite runs recorded, fixture suites still pending, security review started but not finished):

```json
{
  "version": 1,
  "phaseApproved": false,
  "reviewer": "phase-9-review-agent",
  "reviewedHead": "<exact phase-head SHA>",
  "items": [
    { "itemId": "host.merge-action-regressions", "status": "pass",
      "evidence": "vitest run output for __tests__/actions/mergeAction.test.ts at <sha>" },
    { "itemId": "ui.merge-pr-interactive-fixtures", "status": "not-run",
      "evidence": "blocked by #220: fixture suites not yet merged on the phase branch" },
    { "itemId": "security.merge-safeguard-preservation", "status": "pass",
      "evidence": "security review note §4 X1: merge paths traced, negative test <path>" }
  ]
}
```

*(Abbreviated: a real record must list all 23 item ids from `LIFECYCLE_REVIEW_ITEM_IDS`. This example is invalid as shown — `missing-item` for the absent ids — and `phaseApproval()` would block it.)*

Phase approval for `psyche-i7c.9.5` additionally requires the parent's own closure conditions (#217 child gates #218–#220), which are tracked as Bead gates and by the handoff contract — the record above closes only the #221 review, not the phase family.

## 7. How findings block phase closure

1. **Any finding is severity-classified** (§5) at the moment it is raised, with an evidence pointer.
2. **Critical or Important** ⇒ the owning checklist item is recorded `fail` (evidence: the finding). `phaseApproval()` then reports `blocked` — `validatePhaseReview` rejects any `phaseApproved: true` claim with `invalid-approval` while the item is not `pass`. Fix → re-run the affected suites/negative tests → re-record the item `pass` with fresh evidence at the new head.
3. **Security no-bypass items** additionally cannot be parked `not-run` while a review is pending: the item stays open as `fail` with the pending-review blocker as evidence, and the record remains blocked (and invalid if not-run) until an explicit verdict exists.
4. **Minor** findings may be deferred: the item can stay `pass` only when the deferral list is recorded in the review evidence and acknowledged by the owner. An unacknowledged Minor list is an Important finding by definition.
5. **Phase closure** for `i7c.9.5` = `phaseApproval(record).approved` is true, the record and its evidence pointers are attached to the phase evidence trail, and the parent #217 gates (#218–#220) are closed in Beads. Until then the phase stays blocked; no review shortcut, `not-applicable` verdict, or approval claim can close it.

## 8. Relationship to the branch handoff contract

This protocol's checklist item set is the machine-checkable form of the #221 gate. `MOBILE-BRANCH-HANDOFF.md` (#215) consumes it as the `i7c.9.5.lifecycle-review-signoff` phase-gate row and owns the cross-cutting handoff gates (Beads hygiene, clean worktree, required checks, independent branch review). Evidence recorded here is referenced there by pointer; verdicts are never copied or re-derived, so the two contracts cannot drift apart silently.
