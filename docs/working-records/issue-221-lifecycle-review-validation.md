# Working record — issue 221: Phase 9 lifecycle validation/review contract

- **Issue:** [OpenCoven/psyche-build#221](https://github.com/OpenCoven/psyche-build/issues/221) — `[psyche-i7c.9.5] Validate and review full lifecycle actions` (Bead mirror `psyche-i7c.9.5`, P1, blocked)
- **Branch:** `psyche/issue-221-lifecycle-review-validation` (worktree `/home/node/trees/issue-221`, base `origin/main` at `a4546f45bb0ee05cfbb388a0fc5f9e951596be51` — the fork `main` the PR bases on; note: upstream `main` advanced to `f12b753` during this task, and the branch was deliberately rebased back onto the fork base so the PR diff contains exactly this slice)
- **Date:** 2026-08-30
- **Outcome:** delivered — additive review-contract slice; the Phase 9 review itself is **not executed here** (owned by the phase owner; #221 is blocked by #220).

## Outcome

Delivered the Phase 9 validation/review contract for full lifecycle actions (merge, PR, stop, close, cleanup):

1. `docs/review/LIFECYCLE-PHASE-REVIEW.md` — the protocol: suites to run (host/core/UI, exact vitest commands and suite paths), spec-compliance checklist (S1–S6), security no-bypass checklist (X1–X5, security-class items can never be `not-run`), code-quality checklist with severity rules (Q1–Q9), approval criteria, and how findings block phase closure.
2. `src/review/lifecycleReviewChecklist.ts` — versioned **v1** pure TS contract: typed checklist ids (5 host + 7 core + 4 UI suite items, 1 spec, 5 security, 1 quality = 23 items), strict `validatePhaseReview()` (every item `pass`/`fail`/`not-run` with a non-empty evidence pointer; security no-bypass items cannot be `not-run`; `phaseApproved: true` rejected while any item is not `pass`), and `phaseApproval()` summarizer with per-item blocking reasons.
3. `__tests__/lifecyclePhaseReview.test.ts` — 28 tests including the four required negative cases (security item `not-run` blocked; `fail` blocks approval; unknown item rejected; missing evidence pointer rejected).

Calibration: module/doc structure mirrors `src/mobile/phase10Gate.ts` + `__tests__/phase10Gate.test.ts` (exemplar) and the #215 sibling contract (`src/review/handoffChecklist.ts`, `docs/review/MOBILE-BRANCH-HANDOFF.md`, read from fork branch `psyche/issue-215-review-handoff-record`; its files were not modified).

## Scope and boundaries

- In scope: only the four deliverable paths above (all new files; no existing file touched).
- Not done (owned elsewhere, per task assignment): #215 owns `docs/review/MOBILE-BRANCH-HANDOFF.md` and `src/review/handoffChecklist.ts` — untouched, referenced only; #218/#219/#220 own the mobile lifecycle action implementation and fixture suites; the #221 review execution (running the §2 suites as phase evidence and filling the §6 record) belongs to the phase owner after #220 lands. #221 is `Blocked: yes` (blocked by #220), so the delivered record contract legitimately starts blocked.
- No changes to `.github/**`, `.beads/**`, `pnpm-lock.yaml`, `package.json`, generated outputs, barrels, or any other agent's files.
- Risk class: **R1** (documentation + isolated pure-TS contract module with its own tests; no product behavior, authority, or persistence change). The contract *describes* R3 safeguards but does not modify them.

## Exact commands and results

All run from `/home/node/trees/issue-221` at the state described above.

| Command | Result |
|---|---|
| `npx pnpm install --frozen-lockfile` | OK (pnpm 10.34.5, lockfile intact) |
| `npx pnpm exec vitest --run __tests__/lifecyclePhaseReview.test.ts` | **28 passed (28)** |
| `npx pnpm exec tsc --noEmit` | exit 0 |
| `npx pnpm exec tsc -p tsconfig.test.json --noEmit` | exit 0 (after loosening the test record helper to `readonly unknown[]` so intentionally malformed fixtures typecheck) |
| `git diff --check` | exit 0, no output |

Command-form verification of the §2 suite list (proves the documented vitest invocations are correct and the named suites are green on this base; **this is not phase-approval evidence** — the phase record was not created):

| Command | Result |
|---|---|
| `npx pnpm exec vitest --run __tests__/mergeValidation.test.ts __tests__/mergeTargets.test.ts __tests__/actions/mergeAction.test.ts` | 3 files, **12 passed (12)** |
| `npx pnpm exec vitest --run __tests__/actions/closeAction.test.ts __tests__/worktreeCleanupService.test.ts __tests__/worktreeCleanupCrossProcess.test.ts __tests__/actions/createPullRequestAction.test.ts` | 4 files, **92 passed (92)** |
| `npx pnpm exec vitest --run __tests__/remotePaneActions.test.ts __tests__/actions/multiMergeOrchestrator.test.ts __tests__/actions/conflictResolution.test.ts __tests__/prSummary.test.ts __tests__/controlApprovals.test.ts __tests__/bridge/mobileControlGateway.test.ts __tests__/bridge/mobileActionRegistration.test.ts __tests__/paneMenuActions.test.ts` | 8 files, **153 passed (153)** |

Total over all 15 mainline suites named in the protocol: **257 tests, 0 failures**. One iteration note: the first test run failed 1/28 because the initial "all-not-run is accepted" expectation contradicted the intended contract (security items may never be `not-run`); the test was corrected to assert the contract, not the code loosened.

## Exact head SHA

Recorded in the PR body and status comment (a commit cannot contain its own hash): run `git rev-parse HEAD` on this branch at the pushed tip. The branch is a single `feat(review)` commit on top of base `f12b753424f2444466aadbd70f8213768a657031`; the PR head SHA governs and the PR body quotes it verbatim.

## Proof gaps

- **Not run here (environment limits, per runbook):** `scripts/agent-bootstrap` / `scripts/agent-check` (require tmux), iOS/Xcode tooling (no iOS proof claimed), Rust/cargo checks (no lifecycle Rust surface touched), full `pnpm test` (only the new suite plus command-form verification of the 15 named suites).
- **Not produced here (out of scope by assignment):** the #218/#219/#220 fixture-suite run records, the executed spec/security/quality review outputs, and any `phaseApproval` record — the phase review belongs to the phase owner once #220 unblocks #221; every gate in the delivered contract therefore starts `not-run`/blocked.
- **Upstream writes:** OpenCoven PR/issue writes are token-denied for this agent (verified twice by the orchestrator); the PR is filed on the fork `CompleteDotTech/psyche-build` with real CI.
- CI on the fork is the only full-matrix check performed on this head (macOS/Linux/Windows/Quality); iOS/Rust jobs are change-classified and may legitimately be skipped.

## Rollback

Single additive commit on `psyche/issue-221-lifecycle-review-validation`; revert that commit (or delete the branch) to undo. No data, schema, generated output, or persisted format is affected; no other branch or file depends on these paths.
