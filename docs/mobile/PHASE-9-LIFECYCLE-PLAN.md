# Phase 9 — Full Lifecycle Merge, PR, Stop, Close, and Cleanup: Execution Plan

- Bead: `psyche-i7c.9` (mirror: [OpenCoven/psyche-build#217](https://github.com/OpenCoven/psyche-build/issues/217))
- Parent: `psyche-i7c` — Mobile multiproject and multipane cockpit (mirror: #208)
- Contract module: `src/mobile/lifecycleActionContext.ts` (schema v1, tests in `__tests__/lifecycleActionContext.test.ts`)
- Plan authored: 2026-08-30 (mirror bodies of #218–#221 read at authoring time; Beads remains authoritative)
- Status: planning/contract slice. This document and the context module do **not** implement any child deliverable; children #218–#221 own their implementations.

## Objective

Expose complete guarded pane lifecycle actions on mobile by reusing the existing host action workflows and preserving their confirmations, choices, and merge-target logic. Phase 9 delivers, in the Beads source's own terms: scoped action context, native action menu, distinct stop/cleanup semantics, merge/PR review flows, and end-to-end UI fixtures.

Canonical outcome tracking stays with gh-200; this phase is the separately gated iOS/mobile delivery track (gh-217) and does not block the macOS v0.0.1 outcome.

## Closed child history: `psyche-i7c.9.1` re-lands here

Beads records `psyche-i7c.9.1` ("Attach complete scoped context to action chains") as closed history, and #218's implementation note states the isolated `feat/mobile-pane-actions` branch/worktree was externally removed before any source change could land — the claim was released stale. Its deliverable is therefore re-landed at the parent level as this phase's scoped action-context contract (`src/mobile/lifecycleActionContext.ts`, v1), which #218 and #219 must consume rather than re-invent. Children still own all wiring, UI, and evidence.

## Deliverable breakdown and dependency order

| Order | Child | Bead | Mirror | Owns |
|---|---|---|---|---|
| — (closed) | Attach complete scoped context to action chains | `psyche-i7c.9.1` | — | Re-landed as the parent-level v1 contract module (see above); no open child owns it |
| 1 | Native pane action menu and guarded confirmations | `psyche-i7c.9.2` | [#218](https://github.com/OpenCoven/psyche-build/issues/218) | Add merge, create PR, stop, close and clean up, rename, files, and rituals to pane actions; native stop confirmation; route cleanup through `PaneAction.CLOSE`; stale/in-progress disabling; result/error/progress visibility |
| 2 | Merge and PR interactive workflows | `psyche-i7c.9.3` | [#219](https://github.com/OpenCoven/psyche-build/issues/219) | Wire choice/input/PR review sheets to the existing merge/PR action results: uncommitted changes, sibling panes, fallback target confirmation, generated summary editing, final URL messages |
| 3 | Lifecycle action UI and host coverage | `psyche-i7c.9.4` | [#220](https://github.com/OpenCoven/psyche-build/issues/220) | Deterministic fixture requesters and UI tests for merge, PR review, stop, close/cleanup choice, errors, in-progress disabling; run existing merge/action host regressions |
| 4 | Validation and review | `psyche-i7c.9.5` | [#221](https://github.com/OpenCoven/psyche-build/issues/221) | Run lifecycle host/core/UI suites; complete spec/security/code-quality reviews; prove no bypass of existing safeguards |

Dependency order (Beads `Blocked by` edges, matching the mirror bodies):

1. #218 → 2. #219 → 3. #220 → 4. #221. Explicitly: **#218 gates #219; #218+#219 gate #220; #220 gates #221; #221 closes the phase.** There are no parallel tracks in this phase — #219's flows build directly on #218's menu/confirmations, #220's fixtures exercise both, and #221 reviews the assembled whole.

## Reuse contract: which host seams the children must reuse (not re-implement)

The parent acceptance criteria are reuse criteria. The mobile surface wires to these existing host seams and must preserve their behavior exactly; weakening any of them to make a mobile flow simpler is prohibited:

- **Action model** — `src/actions/types.ts`: `ActionResult` types (`confirm`, `choice`, `input`, `pr_review`, `progress`, `error`, `success`), `PaneAction`, `ACTION_REGISTRY` (`requires.worktree` metadata), and the menu registry. #218 adds menu entries and guard states on this model; it does not fork a second action registry.
- **Merge validation and issue chains** — `src/actions/implementations/mergeAction.ts` with `validateMerge` and the issue handlers under `src/actions/merge/issueHandlers/`: `worktreeUncommittedHandler` (choices `commit_automatic`, `commit_ai_editable`, `commit_manual`, `cancel`), `mainDirtyHandler` (adds `stash_main`), `mergeConflictHandler`, `handleNothingToMerge`. #219 renders these existing choice chains verbatim; it does not pre-filter or pre-answer them.
- **Sibling handling** — merge's sibling-pane confirmation ("Sibling Agents Active") and the exact-identity removal seam `ActionContext.removePaneIdentitiesFromConfig` with tmux ownership assessment (`assessTmuxTeardownOwnership`). Mobile merge must surface the sibling confirmation and inherit the same abort/retain behavior when teardown fails.
- **Fallback merge/PR targets** — `src/utils/mergeTargets.ts` (`resolveMergeTarget`, `buildFallbackMergeMessage`, fallback reasons `missing`/`merged`/`branch_changed`) and the "Parent Merge Target Unavailable" confirmations in both `mergeAction.ts` and `createPullRequestAction.ts`. The fallback confirmation must reach the mobile surface unchanged.
- **PR review** — `createPullRequestAction.ts` `pr_review` result with `reviewData` (`repoPath`, `sourceBranch`, `targetBranch`, `files`, `aiFailed`): editable title/body, related-file navigation, and the final URL message. #219 wires the sheet to this result type; the host remains the source of truth for generation and submission.
- **Close and cleanup choices** — `closeAction.ts` cleanup options `kill_only` ("Just close pane"), `kill_and_clean` ("Close and remove worktree"), `kill_clean_branch` ("Close and delete everything"), sibling-aware cleanup skip, `WorktreeCleanupService` background cleanup, and the lifecycle/begin-close guards. "Close and Clean Up" on mobile enters this host choice flow; it does not offer its own parallel cleanup vocabulary.
- **Stop semantics** — stop is a distinct native action that maps onto the host's verified pane teardown path (`tearDownFullPaneWithVerification` / `verifyFullPaneAbsent` / `assessTmuxTeardownOwnership`) with `kill_only` semantics: terminate the pane (and its owned tmux resources), always retain the worktree and branch. Stop must never trigger worktree/branch deletion and must never reuse the `kill_and_clean`/`kill_clean_branch` branches.
- **Remote action plumbing** — `src/actions/remoteActionSessions.ts` (single-use sessions, TTL, `REMOTE_CONTEXT_KEYS`) and `src/services/bridge/MobileControlGateway.ts`. Cancel paths stay explicit and single-use exactly as `RemoteActionSessions.respond` enforces (a pending session is consumed before validation, so a concurrent reply cannot double-execute).
- **tmux server identity** — `src/services/TmuxServerIdentity.ts` (pid + process-start generation). The scoped context mirrors this shape so a stale context can be detected instead of killing a reused pane id.

## Scoped action-context contract (this slice)

`src/mobile/lifecycleActionContext.ts` (v1) is the machine-checkable form of the scoped context that every Phase 9 lifecycle action chain carries:

- **Schema** — `LifecycleActionContext` v1: `actionId` (`merge | create_pr | stop | close | rename | files | rituals`), `host.name`, canonical selected project (`project.canonicalRoot` + optional `displayName`), exact pane identity (`pane.id`, `pane.tmuxPaneId` in `%N` form, `pane.tmuxSessionName`, `pane.tmuxServer` pid/process-start/socket/session), optional `worktree` (`path`, `branch`), `authority` (`kind: approval | lease | host-session`, `reference`), `consequence`, and `capturedAt`. Structurally mirrors `PaneLifecycleIdentity` + `TmuxServerIdentity` + the tmux session from `ActionContext`, without importing host services (pure contract module).
- **`validateActionContext()`** — strict, fail-closed validator for a context arriving from any surface: unknown fields rejected at every level; required identities present (host, canonical project root, exact pane identity incl. tmux server generation, action id, authority reference, consequence); absolute canonical paths without traversal segments; conservative git-branch shape; tmux target-safe session names (no `:`/`.`); bounded lengths; and credential-shaped (GitHub/AWS/Slack/JWT/PEM/labeled secrets) or raw-command-shaped (shell metacharacters, `rm -rf`, `kill-pane`, tool+subcommand+flag) content rejected as `unsafe-content`. Worktree identity is required exactly for `merge`/`create_pr` (mirroring the host `requires.worktree` registry). Malformed input produces problems; it never throws and never partially accepts.
- **`consequenceSummary()`** — one stable, ordered line naming `host`, `project`, `pane`, `worktree`, `branch`, and `consequence` (worktree/branch rendered as `none attached`/`none` for shell panes). Returns `null` instead of a partial string when a required field is missing, so a destructive confirmation can fail closed rather than name only some of what it is about to affect. This is the direct implementation of the parent criterion "Destructive actions name host/project/pane/worktree/branch/consequence".
- **Classification and staleness helpers** — `DESTRUCTIVE_LIFECYCLE_ACTION_IDS` (`merge`, `stop`, `close`) with `isDestructiveLifecycleAction()` for consequence-first gating, and `isLifecycleActionContextStale()` (aligned with the gateway's 5-minute remote action-session TTL; future/unparseable capture instants count as stale) so stale snapshots disable actions instead of executing on a possibly-changed host, pane, worktree, or authority.

**Authority notice (binding for all children):** the `authority` reference is display/scoping metadata only. The host control plane and host action workflows remain the single source of truth for validation, confirmation, cleanup choices, and revocation; no mobile surface may infer authority or completion from a UI selection, tmux pane, worktree, branch, Bead, or GitHub issue. A context that fails `validateActionContext`, or whose authority reference the host no longer honors, is disabled — never executed.

How children consume the contract:

- **#218** attaches a validated context to each lifecycle menu action; destructive menu items render `consequenceSummary()` above (before) the confirm button; stale (`isLifecycleActionContextStale`) or already-running (host action-session state) actions render disabled with their result/error/progress states visible.
- **#219** carries the same context through the multi-step merge/PR choice/input/review chains so every step's sheet names what it affects; the host's `RemoteActionSessions` single-use semantics remain the cancellation contract.
- **#220** asserts in fixtures that every destructive flow carries scoped metadata (host/project/pane/worktree/branch) and a consequence — a fixture without a validated context or a complete summary is a failing fixture.
- **#221** reviews that no flow renders a destructive confirmation without a complete consequence summary and that no mobile path bypasses host validation.

## Parent acceptance criteria → owning child mapping

| Parent acceptance criterion (verbatim) | Owned by | Contract support |
|---|---|---|
| "Merge and PR reuse existing validation, sibling handling, uncommitted choices, fallback targets, and PR review." | #219 (flows), #220 (regressions stay green) | Reuse contract table above; context module adds no host logic |
| "Stop terminates the pane while retaining worktree/branch." | #218 (native stop + stop confirmation), #220 (fixtures) | `stop` action id; destructive classification; `consequenceSummary()` names the retained worktree/branch |
| "Close and Clean Up enters host cleanup choices." | #218 (routes through `PaneAction.CLOSE`) | Host `closeAction` choices are the only cleanup vocabulary; context carries worktree/branch so each choice can name what it deletes |
| "Destructive actions name host/project/pane/worktree/branch/consequence." | #218 (renders), #220 (asserts) | `consequenceSummary()` + strict validator |
| "In-progress/stale actions are disabled and tested." | #218 (disables), #220 (tests) | `isLifecycleActionContextStale()` + host action-session state; disabled-state fixtures |

## Per-child plans, acceptance criteria, risk class, and evidence expectations

Acceptance criteria below are verbatim-faithful to the Bead mirror bodies (the generated GitHub mirror of the Beads source, read 2026-08-30). Where Beads and this plan ever disagree, Beads wins.

### #218 — Build native pane action menu and guarded confirmations (`psyche-i7c.9.2`)

- **Work:** Add merge, create PR, stop, close and clean up, rename, files, and rituals to pane actions. Implement native stop confirmation and route cleanup through `PaneAction.CLOSE`.
- **Acceptance criteria (verbatim-faithful):**
  - Stop and cleanup are visually/semantically distinct.
  - Destructive confirmation reads consequence before its button.
  - Stale or already-running actions are disabled.
  - Result/error/progress states remain visible.
- **Risk class: R2, with R3 expectations for the destructive-confirmation semantics.** Product behavior on the owning surface, but stop/merge/close confirmations guard consequential actions: the consequence-first rendering, stop/cleanup distinctness, and stale/in-progress disabling get failure-boundary review even though authority stays on the host.
- **Evidence expectations:** Automated — behavior tests for menu composition, stop-vs-cleanup distinctness, consequence-before-button ordering, disabled states (stale via `isLifecycleActionContextStale`, in-progress via host session state), and result/error/progress visibility. Operator-observed — a simulator walkthrough of the menu → destructive confirmation → cancel path recorded in the child's working record (bounded observations with simulator/OS named).

### #219 — Exercise merge and PR interactive workflows on mobile (`psyche-i7c.9.3`)

- **Work:** Wire choice/input/PR review sheets to existing merge/PR action results, including uncommitted changes, sibling panes, fallback target confirmation, generated summary editing, and final URL messages.
- **Acceptance criteria (verbatim-faithful):**
  - Merge confirmation/choice chains reach terminal outcomes.
  - PR review supports title/body editing and related-file navigation.
  - Cancel paths are explicit and single-use.
  - Host remains source of truth for all validation.
- **Risk class: R2/R3 (mixed).** Interactive flows over consequential actions: the UI is product behavior (R2), but the guarantee that every chain terminates in a host-executed outcome with no mobile-side shortcut, and that cancels are single-use, is authority-adjacent (R3). The mobile surface must never pre-answer, filter, or summarize away a host choice.
- **Evidence expectations:** Automated — tests driving each chain (uncommitted choices incl. `stash_main`, sibling confirmation, fallback target confirmation, PR review editing + related-file navigation, final URL message) to terminal success/error/cancel outcomes. Operator-observed — one merge and one PR walkthrough on simulator recorded in the working record. Host-side regressions are #220's; this child proves the mobile chain behavior.

### #220 — Add lifecycle action UI and host coverage (`psyche-i7c.9.4`)

- **Work:** Add deterministic fixture requesters and UI tests for merge, PR review, stop, close/cleanup choice, errors, and in-progress disabling; run existing merge/action host regressions.
- **Acceptance criteria (verbatim-faithful):**
  - Every destructive flow has a tested confirmation/cancel path.
  - Merge/PR existing regressions remain green.
  - UI fixtures assert scoped metadata and consequences.
- **Risk class: R1/R2.** Test and fixture work. The hard constraint is the third criterion: fixtures must assert the scoped metadata (host/project/pane/worktree/branch) and consequences — via the v1 contract's validator and `consequenceSummary()` — not merely that a popup appeared.
- **Evidence expectations:** Automated — fixture-driven UI tests for every destructive flow's confirm and cancel paths, in-progress disabling, and error states; the existing merge/action host regressions executed and green. Operator-observed — none strictly required beyond recording what ran where; the child's working record names the exact suites and counts.

### #221 — Validate and review full lifecycle actions (`psyche-i7c.9.5`)

- **Work:** Run lifecycle host/core/UI suites and complete spec/security/code-quality reviews.
- **Acceptance criteria (verbatim-faithful):**
  - No bypass of existing merge/PR/cleanup safeguards remains.
  - Tests pass and reviews approve the phase.
- **Risk class: R3.** The phase's review gate over consequential actions: threat/failure-boundary review that no mobile path bypasses host validation, confirmation, cleanup choices, or single-use cancels; independent review per AGENTS.md R3.
- **Evidence expectations:** Automated — lifecycle host/core/UI suites green against the exact integration head SHA. Operator-observed — the independent reviewers' findings records (spec, security, code-quality) with no Critical/Important defects or their resolution; explicit statement per reuse-contract row that host behavior is unchanged.

## Evidence expectations (phase-wide)

- Every child retains a working record under `docs/working-records/` with outcome, scope, risk class, exact commands and observed results, exact head SHA, and explicit proof gaps. Test counts never substitute for user-path evidence (AGENTS.md).
- Automated proof: focused tests and gates runnable in CI (Quality and change-classified runners). Skipped CI jobs are documented, not claimed.
- Operator-observed proof: simulator walkthroughs recorded with target, OS, and bounded outputs; unprovenanced screenshots are not evidence.
- Every claim carries exact commands and results, or an explicit "not run here / gap" statement.
- Protected data: fixtures and records contain synthetic identifiers only — no credentials, tokens, raw prompts, or unredacted personal paths (the context validator's content policy is itself part of the proof surface).

## Non-goals

- **No host behavior changes.** Merge validation, sibling handling, uncommitted/main-dirty/conflict choices, fallback targets, PR generation/review, close/cleanup choices, teardown ownership, and revocation semantics are reused verbatim; nothing in this phase weakens or forks them.
- **No implementation of the children here.** This slice ships the plan and the scoped-context contract only; #218–#221 own their code, tests, fixtures, and evidence.
- **No iOS TestFlight, device, or distribution claims.** Those require separate acceptance evidence this phase does not produce.
- **gh-200 owns availability** and the remaining post-release track; earlier broad prose references for the iOS family are historical/superseded.
- **No Psyche protocol conformance claims** (gh-253 profile pin has not landed).
- **No upstream GitHub write-backs** from this pipeline: upstream PR/issue writes are token-denied; execution runs on the fork with real CI, ready for maintainer handoff.
- **No changes to** `docs/ROADMAP.md`, `docs/SUPPORT-MATRIX.md`, generated outputs, `.beads/**`, or `.github/**`.
- **Desktop/macOS track** is out of scope; this plan governs the mobile/iOS track only.

## Plan change log

- 2026-08-30: Initial plan and v1 scoped action-context contract (`src/mobile/lifecycleActionContext.ts`, `__tests__/lifecycleActionContext.test.ts`) authored for OpenCoven/psyche-build#217; closed `psyche-i7c.9.1` scope re-landed at parent level per #218's stale-claim note.
