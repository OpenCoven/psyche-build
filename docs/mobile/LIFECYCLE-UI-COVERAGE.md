# Lifecycle action UI coverage — mobile cockpit (v1)

- **Contract version:** 1
- **Fixture module:** [`src/mobile/lifecycleFixtures.ts`](../../src/mobile/lifecycleFixtures.ts)
  (`LIFECYCLE_FIXTURES_CONTRACT_ID = 'psyche.mobile.lifecycle.fixtures.v1'`)
- **Focused tests:** [`__tests__/lifecycleFixtures.test.ts`](../../__tests__/lifecycleFixtures.test.ts)
- **Issue:** [OpenCoven/psyche-build#220](https://github.com/OpenCoven/psyche-build/issues/220)
  (Beads mirror `psyche-i7c.9.4`, P1, blocked)
- **Phase:** `psyche-i7c.9` — full lifecycle merge, PR, stop, close, and cleanup (parent #217)
- **Canonical outcome:** gh-200 (post-release mobile track); canonical outcome tracking for this
  issue family follows the issue body's disposition note.

## 1. Purpose and scope

This document is the required UI test matrix for the mobile lifecycle action surfaces: merge,
PR review, stop, close/cleanup choice, error states, and in-progress disabling. It defines what a
lifecycle UI implementation (and its UI tests) must cover before the lifecycle track can claim the
`psyche-i7c.9.4` acceptance criteria:

- Every destructive flow has a tested confirmation **and** cancel path.
- UI fixtures assert scoped metadata (host, project, pane, worktree, branch, and merge/PR target)
  and consequence-first copy.
- The existing host merge/action regression suites stay green.

**In scope here:** the coverage matrix below, the deterministic v1 fixture requesters and strict
validators in `src/mobile/lifecycleFixtures.ts`, and their focused test suite.

**Out of scope here (owned elsewhere — do not implement in this slice):**

- The native pane action menu and guarded confirmations themselves —
  [OpenCoven/psyche-build#218](https://github.com/OpenCoven/psyche-build/issues/218)
  (`psyche-i7c.9.2`) owns the action catalog. `LIFECYCLE_ACTION_CATALOG_SHAPE` in the fixture
  module is the coverage contract those catalog entries must satisfy, not a second catalog.
- The interactive merge/PR workflow exercise on mobile —
  [OpenCoven/psyche-build#219](https://github.com/OpenCoven/psyche-build/issues/219)
  (`psyche-i7c.9.3`).
- XCUITest/SwiftUI execution (see §9 — documented gap).

## 2. Fixture contract

Fixtures are produced by pure, deterministic requesters — fixed ids, no randomness, no timestamps,
no I/O — so UI tests on any platform can assert against the same strings:

| Export | Purpose |
|---|---|
| `requestLifecycleFixture(scenarioId)` | Deep-frozen fixture for one scenario; repeated calls with the same id are deep-equal. Unknown ids fail closed. |
| `requestLifecycleFixtureSet()` | The complete 16-scenario set in canonical order, with a `byScenarioId` index. |
| `validateLifecycleFixture(candidate)` | Strict single-fixture validator: unknown fields rejected, enums checked, scoped metadata and consequence invariants enforced. |
| `validateFixtureSet(candidate)` | Strict full-set validator: completeness vs the catalog shape, unique ids, confirmation+cancel coverage per flow. |
| `LIFECYCLE_ACTION_CATALOG_SHAPE` | The v1 action-catalog shape: every action kind must expose `confirm`, `cancel`, `error`, and `in-progress`. |
| `DESTRUCTIVE_LIFECYCLE_ACTION_KINDS` | `merge`, `stop`, `close` — the flows that can destroy uncommitted or persisted work. |

Every fixture carries:

- **Scenario identity:** `scenarioId` (`<kind>.<role>`), `actionKind`, `scenarioRole`, and a fixed
  `requesterId` (`psyche.mobile.lifecycle.fixture.<scenarioId>`).
- **Scoped metadata** (`scope`): `hostName`, `projectName`, `paneTitle`, `worktreeName`,
  `branchName`, and `targetBranchName` (merge/PR target; exactly `null` for `stop`/`close`).
- **Consequence text:** consequence-first, starts with `This …`, names the full scope, and states
  immediacy (`now`) on confirmations.
- **Survival note:** always names the worktree and the branch and states what survives or was
  preserved.
- **Expected UI state** (`expected`): dialog kind, title, message, `confirmLabel`/`cancelLabel`
  (exactly `null` when absent), choice `options`, `actionEnabled`, `disabledReason`, `inProgress`,
  `errorText`, and `cancelHasNoSideEffects`.

## 3. The v1 action-catalog shape

| Action kind | Destructive | `confirm` | `cancel` | `error` | `in-progress` |
|---|---|---|---|---|---|
| `merge` | yes | confirmation dialog | cancel outcome (info) | merge-conflict error | entry point disabled |
| `pr-review` | no (consequential: publishes) | confirmation dialog | cancel outcome (info) | publish-failure error | entry point disabled |
| `stop` | yes | confirmation dialog | cancel outcome (info) | nothing-to-stop error | entry point disabled |
| `close` | yes | cleanup choice (3 options) | cancel outcome (info) | cleanup-skipped error | entry point disabled |

The fixture option ids and copy for the close/cleanup choice mirror the host close action's
three-way choice in `src/actions/implementations/closeAction.ts` (`kill_only`, `kill_and_clean`,
`kill_clean_branch`), so a mobile surface and the host action assert the same choice set.

## 4. Required UI test matrix

Each row is a required UI test. "Fixture" names the deterministic scenario whose `scope`,
`consequenceText`, `survivalNote`, and `expected` block supply the exact assertion strings.
Steps are written for the mobile cockpit pane/action surface; the same assertions apply on any
platform consuming the fixtures.

### 4.1 Merge (destructive)

| Scenario | Precondition | Steps | Required assertions |
|---|---|---|---|
| `merge.confirm` | Worktree pane `agent-merge` on `wt/merge-demo` / `feat/merge-demo`, host `lan-host-1` | Open the pane action menu → tap **Merge** | A confirmation dialog titled `Merge Worktree` appears **before** any merge runs; message names the pane and target (`main`); confirm label `Merge`, cancel label `Cancel`; the accessibility text contains the consequence sentence and survival note (worktree + branch survive); no merge has run yet while the dialog is open |
| `merge.cancel` | Confirmation dialog open | Tap **Cancel** | The dialog closes with an info outcome (`Merge Cancelled`); the consequence text states no merge ran; `main`, the worktree, and the pane are unchanged (assert scoped metadata); the action can be re-invoked |
| `merge.error` | Conflicting state between `feat/merge-demo` and `main` | Run the merge and hit the conflict | An error dialog appears; `errorText` names the pane, host, target, and that `main` was left unchanged; only a `Dismiss` control is offered; the survival note names the preserved worktree and branch |
| `merge.in-progress` | A merge is already running for the pane | Open the pane action menu while the merge runs | The merge entry point is **disabled** (`actionEnabled === false`); no dialog is shown (`dialog === 'none'`); `disabledReason` states a merge for the pane/host is `in progress`; no second merge can be started |

### 4.2 PR review (consequential, non-destructive)

| Scenario | Precondition | Steps | Required assertions |
|---|---|---|---|
| `pr-review.confirm` | Branch `feat/pr-demo` on `wt/pr-demo`, host `lan-host-1` | Open the pane action menu → tap **Create PR** | A confirmation dialog titled `Create Pull Request` appears **before** anything is published; message names the branch; confirm label `Create PR`, cancel label `Cancel`; consequence text names pane, worktree, branch, target `main`, project, host; survival note states publishing changes nothing locally |
| `pr-review.cancel` | Confirmation dialog open | Tap **Cancel** | Info outcome (`Pull Request Cancelled`); consequence text states nothing was published and no PR against `main` exists; worktree and branch untouched |
| `pr-review.error` | Remote rejects the push | Run PR creation with a failing push | Error dialog `Pull Request Failed`; `errorText` names the branch, host, and that nothing was published; only `Dismiss` offered; survival note names the preserved worktree and branch |
| `pr-review.in-progress` | PR creation already running | Open the action menu | The create-PR entry point is disabled; `disabledReason` names the pane/host and `in progress`; no dialog rendered |

### 4.3 Stop (destructive — ends the running session)

| Scenario | Precondition | Steps | Required assertions |
|---|---|---|---|
| `stop.confirm` | Session running in pane `agent-stop` (`wt/stop-demo` / `feat/stop-demo`) | Open the pane action menu → tap **Stop** | Confirmation dialog `Stop Pane Session` appears **before** the session ends; confirm label `Stop`, cancel label `Cancel`; consequence text states the session ends `now`; survival note states the worktree, branch, and the pane itself survive — only the session ends |
| `stop.cancel` | Confirmation dialog open | Tap **Cancel** | Info outcome (`Stop Cancelled`); the session keeps running; consequence text and survival note assert nothing ended and the worktree/branch survive untouched |
| `stop.error` | Session already exited | Tap **Stop** on the exited pane | Error dialog `Nothing To Stop`; `errorText` names the pane, host, and that there was nothing to stop; only `Dismiss` offered; worktree and branch preserved |
| `stop.in-progress` | A stop/teardown is already running | Open the action menu | The stop entry point is disabled; `disabledReason` names the pane/host and `in progress`; no dialog rendered |

### 4.4 Close / cleanup choice (destructive)

| Scenario | Precondition | Steps | Required assertions |
|---|---|---|---|
| `close.confirm` | Worktree pane `agent-close` (`wt/close-demo` / `feat/close-demo`) | Open the pane action menu → tap **Close** | A choice dialog `Close Pane` appears **before** anything is removed; exactly the three host cleanup options render — `kill_only` (default, non-dangerous), `kill_and_clean` (danger), `kill_clean_branch` (danger); labels/descriptions match the fixture; a `Cancel` control is present |
| `close.confirm` (destructive options) | Same choice dialog | Inspect the two destructive options | The danger options are visibly marked destructive **and** carry text (never color-only): "Delete worktree but keep branch" / "Remove worktree and delete branch"; the default keeps worktree and branch |
| `close.cancel` | Choice dialog open | Tap **Cancel** | Info outcome `Close Cancelled`; the pane stays open, its session keeps running; consequence text asserts no cleanup ran and pane, worktree, and branch all survive |
| `close.error` | Sibling panes still share the worktree | Close with a cleanup option while siblings hold the worktree | Error dialog `Cleanup Skipped`; `errorText` names the pane, host, worktree, that cleanup was skipped because siblings still use it, and that the branch was not deleted; survival note names the preserved worktree and branch |
| `close.in-progress` | A close/teardown is already running | Open the action menu | The close entry point is disabled; `disabledReason` names the pane/host and `in progress`; no dialog rendered |

## 5. Destructive-flow confirmation/cancel coverage requirement

For every action kind in `DESTRUCTIVE_LIFECYCLE_ACTION_KINDS` (`merge`, `stop`, `close`):

1. The confirmation fixture (`<kind>.confirm`) must render a guarded confirmation (dialog kind
   `confirmation`, or `choice` for close's cleanup choice) **before** the action runs, with both a
   verb-first confirm label and a non-destructive `Cancel` control.
2. The cancel fixture (`<kind>.cancel`) must assert the no-op outcome: dialog `info`, no
   confirm/cancel controls, consequence text beginning `This cancels …`, scoped metadata named as
   unchanged, and a survival note naming the worktree and branch.
3. `cancelHasNoSideEffects` must be `true` exactly when a cancel/dismiss control exists
   (`Cancel` on confirmation/choice/error dialogs; `Dismiss` on error dialogs).

The strict validators enforce this structurally (`validateFixtureSet` refuses any set missing a
`confirm` or `cancel` fixture for any action kind), and the focused tests assert it per flow.

## 6. In-progress disabling requirement

While an action is running for a pane, its entry point must be disabled — not hidden, and not
re-triggerable: `expected.actionEnabled === false`, `expected.inProgress === true`,
`expected.dialog === 'none'`, and `expected.disabledReason` states what is `in progress` and where
(pane + host). This prevents double-fire of merge/stop/close teardowns. Each action kind has an
`<kind>.in-progress` fixture and a UI test row above.

## 7. Host regression suites to keep green

The mobile lifecycle UI must not regress the owning host action behavior. These existing suites
are the host merge/action regression set for this issue and must stay green in CI:

| Suite | Covers |
|---|---|
| `__tests__/actions/mergeAction.test.ts` | Merge action flow: confirmation, issue handlers, teardown, hooks |
| `__tests__/actions/multiMergeOrchestrator.test.ts` | Multi-merge queueing, stop-multi-merge choice |
| `__tests__/actions/mergeAction.test.ts` + `__tests__/mergeValidation.test.ts` + `__tests__/mergeTargets.test.ts` | Merge pre-checks, validation issues, target resolution/fallback confirmation |
| `__tests__/actions/closeAction.test.ts` | Close action cleanup choices (`kill_only` / `kill_and_clean` / `kill_clean_branch`), worktree removal, sibling handling |
| `__tests__/actions/createPullRequestAction.test.ts` | PR creation confirm/fallback/error flows |
| `__tests__/actions/conflictResolution.test.ts` | Merge-conflict resolution flow |
| `__tests__/actions/remoteActionSessions.test.ts` + `__tests__/remotePaneActions.test.ts` | Remote/host action session behavior |
| `__tests__/paneMenuActions.test.ts` | Pane action menu wiring |

If a host regression fails after a lifecycle UI change, fix the change — never weaken the host
action's confirmation, receipt, idempotency, or cleanup behavior to make a test pass.

## 8. Execution status (documented gap)

- **Executed on this host (Linux CI host, no tmux/iOS tooling):**
  - `npx pnpm exec vitest --run __tests__/lifecycleFixtures.test.ts` — the fixture determinism,
    completeness, destructive confirm/cancel, scoped-metadata, and strict-validation tests.
  - The host regression suites listed in §7 (see the working record for the exact run and result).
  - `npx pnpm exec tsc --noEmit` and `tsc -p tsconfig.test.json --noEmit`.
- **Not executed here (proof gap):** the actual UI test execution of the §4 matrix
  (XCUITest/Simulator or equivalent) requires the repository-pinned iOS tooling on a macOS host
  (`PSYCHE_AGENT_CHECK_IOS=1`). This document defines the required matrix and the fixture module
  supplies the assertion strings; executing them against a SwiftUI surface is the owning mobile
  track's acceptance step. No UI-execution proof is claimed by this slice.

## 9. Change discipline for new scenarios

1. A new lifecycle UI behavior first gets a row in the matrix above and a scenario in
   `LIFECYCLE_ACTION_CATALOG_SHAPE` (a new `kind` or `role`).
2. Extend `LIFECYCLE_FIXTURE_SPECS` and `LifecycleScenarioId` in
   `src/mobile/lifecycleFixtures.ts`; the strict validators and completeness tests fail until the
   new `kind.role` pair is covered.
3. Destructive additions must ship both `confirm` and `cancel` fixtures in the same change.
4. Bump `LIFECYCLE_FIXTURES_CONTRACT_VERSION` only when the fixture shape itself changes (v1 adds
   fields without removing or re-purposing existing ones).
