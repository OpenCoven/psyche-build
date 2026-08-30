# Working record — issue 220: lifecycle action UI and host coverage (psyche-i7c.9.4)

- **Branch:** `psyche/issue-220-lifecycle-ui-host-coverage`
- **Worktree:** `/home/node/trees/issue-220`
- **Base:** `origin/main` at `a4546f4`
- **Implementation commit:** `ae96d0f` (`feat(mobile): lifecycle action UI coverage contract and
  deterministic fixtures (refs OpenCoven/psyche-build#220)`)
- **Branch head at push:** recorded in the fork PR body and status comment (the working record
  file lands inside a follow-up commit, so it cannot contain its own commit's SHA).
- **Upstream issue:** [OpenCoven/psyche-build#220](https://github.com/OpenCoven/psyche-build/issues/220)
  (Beads mirror `psyche-i7c.9.4`, P1, blocked; canonical outcome gh-200).
- **PR:** fork PR (CompleteDotTech/psyche-build) — link and head SHA in the PR body and status
  comment; upstream writes are token-denied so this pipeline runs on the fork with real CI.

## Outcome

The fixture/coverage-contract slice of the lifecycle UI track, additive only:

- `docs/mobile/LIFECYCLE-UI-COVERAGE.md` — the v1 required UI test matrix for the mobile
  lifecycle surfaces: per-scenario rows for merge, PR review, stop, close/cleanup choice, errors,
  and in-progress disabling; the destructive-flow confirmation/cancel coverage requirement; the
  in-progress disabling requirement; the named host merge/action regression suites that must stay
  green (§7); and the execution status incl. the documented UI-execution gap (§8).
- `src/mobile/lifecycleFixtures.ts` — versioned (v1) pure TS fixture module: deterministic
  fixture requesters (`requestLifecycleFixture`, `requestLifecycleFixtureSet`) with fixed
  requester ids (`psyche.mobile.lifecycle.fixture.<scenarioId>`), no randomness, no timestamps,
  no I/O; 16 fixtures covering every `kind.role` pair of the pinned
  `LIFECYCLE_ACTION_CATALOG_SHAPE` (merge / pr-review / stop / close × confirm / cancel / error /
  in-progress); each fixture carries scoped metadata (host, project, pane, worktree, branch,
  merge/PR target), consequence-first text, a survival note, and the expected
  confirmation/cancel/disabled UI state; strict fail-closed validators
  (`validateLifecycleFixture`, `validateFixtureSet`) that reject unknown fields at every level,
  wrong enums, empty/oversize/unnormalized text, scope-dropping copy, and inconsistent states.
  The close/cleanup choice mirrors the host close action's `kill_only` / `kill_and_clean` /
  `kill_clean_branch` options.
- `__tests__/lifecycleFixtures.test.ts` — 87 focused tests: determinism (same requester id →
  deep-equal fixture on repeated calls, full-set deep-equality, no volatile fields, deep-frozen
  outputs), completeness vs the action-catalog shape, destructive flows carry both confirmation
  and cancel fixtures, cancel paths assert no-op outcomes, scoped metadata and consequence
  assertions, in-progress disabling assertions, and the strict-validators' rejection matrix
  (unknown fields at set/fixture/scope/expected/option level, wrong enums, missing scenarios,
  duplicate ids, wrong contract version, non-object inputs).

## Scope and boundaries

Did NOT do (out of slice):

- No changes to files owned by #218 (native pane action menu / action catalog) or #219
  (interactive merge/PR workflow exercise) — both are open blocked-by dependencies of this issue;
  `LIFECYCLE_ACTION_CATALOG_SHAPE` is the coverage contract their catalog entries must satisfy,
  not a second catalog or a competing implementation.
- No product/runtime behavior changes: nothing in `src/actions/**`, `src/services/**`,
  `src/components/**`, TUI, web, or native surfaces was modified; the module is not yet consumed
  by any runtime surface.
- No SwiftUI/Xcode/XCUITest implementation or execution — see Proof gaps.
- No edits to `.github/**`, `.beads/**`, `pnpm-lock.yaml`, `package.json` dependencies, barrels /
  `index.ts`, generated outputs, `docs/ROADMAP.md`, or `docs/SUPPORT-MATRIX.md`.
- Did not resolve or claim resolution of the Beads blocked state (blocked by #218 and #219); the
  fixture/coverage contract is independent of those deliverables and does not claim the blocked
  dependency resolved.

## Risk class

- [x] **R1** — documentation + isolated pure tests. The module is not consumed by any runtime
      surface; no product behavior, authority, confirmation flow, persistence, or recovery path
      changes. (Per AGENTS.md, R2/R3 would apply to the future surfaces that wire these fixtures
      into the mobile action menus and guarded confirmations.)

## Exact commands and observed results

Run from `/home/node/trees/issue-220` (branch `psyche/issue-220-lifecycle-ui-host-coverage`, base
`origin/main` at `a4546f4`):

| Command | Result |
|---|---|
| `npx pnpm install --frozen-lockfile` | exit 0 (clean install, no lockfile changes) |
| `npx pnpm exec vitest --run __tests__/lifecycleFixtures.test.ts` | **87 passed, 0 failed** (`Test Files 1 passed (1)`, `Tests 87 passed (87)`) |
| `npx pnpm exec vitest --run __tests__/actions/mergeAction.test.ts __tests__/actions/multiMergeOrchestrator.test.ts __tests__/actions/closeAction.test.ts __tests__/actions/createPullRequestAction.test.ts __tests__/actions/conflictResolution.test.ts __tests__/mergeTargets.test.ts __tests__/mergeValidation.test.ts __tests__/remotePaneActions.test.ts __tests__/paneMenuActions.test.ts` | **9 files passed, 77 tests passed, 0 failed** (host merge/action regression set per coverage doc §7) |
| `npx pnpm exec tsc --noEmit` | exit 0, no output |
| `npx pnpm exec tsc -p tsconfig.test.json --noEmit` | exit 0, no output |
| `git diff --check` | clean (no whitespace/conflict-marker errors) |
| `git status --porcelain` (before commit) | only the three new files; no unrelated modifications |

Fork CI: recorded in the PR body / status comment once terminal (Quality gate plus
change-classified jobs; skipped counts as green per runbook).

## Test counts

- New focused suite: 87 tests, 87 passed, 0 failed, 0 skipped
  (`__tests__/lifecycleFixtures.test.ts`).
- Host regression set: 9 test files, 77 tests, all passed — existing suites only, unmodified.
- No existing tests were modified or deleted.

## Proof gaps

1. **UI test execution (documented gap — macOS/iOS host required).** The acceptance criterion is
   the required UI test matrix (`docs/mobile/LIFECYCLE-UI-COVERAGE.md` §4). Executing it against a
   real mobile surface (XCUITest/Simulator) requires the repository-pinned Xcode, simulator, and
   XcodeGen on a macOS host (`PSYCHE_AGENT_CHECK_IOS=1`); this host has no Xcode/iOS tooling
   (runbook). The matrix, the deterministic fixture assertion strings, and the strict validators
   are delivered and unit-tested here; UI execution is explicitly **not** claimed. This is the
   same class of gap the runbook anticipates for the mobile track.
2. **Host regressions run on Linux only, locally.** The 9 host suites in §7 pass on this host;
   the full repository gate (`scripts/agent-bootstrap` / `scripts/agent-check fast|full`) requires
   tmux, which this host lacks (runbook), so it was not run. Fork CI supplies the Linux/macOS/Windows
   runner evidence; iOS jobs are change-classified and may be skipped (skipped counts as green).
3. **Product-path evidence.** Unit tests of a pure fixture module are not user-path evidence; no
   user path claims to have changed. The mobile consumption of these fixtures remains with #218/#219
   and the owning mobile track (gh-200).
4. **Beads blocked state** (blocked by #218, #219) remains owned by the Beads source; this slice
   delivers the fixture/coverage contract only.
5. Upstream issue/PR write-back (commenting on OpenCoven#220) is token-denied; status is reported
   on the fork PR thread per runbook.

## Rollback

- Additive-only: three new files (`docs/mobile/LIFECYCLE-UI-COVERAGE.md`,
  `src/mobile/lifecycleFixtures.ts`, `__tests__/lifecycleFixtures.test.ts`) plus this record;
  zero modifications to existing files. `git revert` of the two slice commits or deleting the
  branch removes the slice entirely.
- No persisted formats, schemas, generated outputs, or shared configuration touched; no migration
  or cleanup is needed.

## Beads / tracker note

- Issue body is a generated Beads mirror (`psyche-i7c.9.4`); per `.beads/README.md` and the
  sole-migrator rule it was not hand-edited. The blocked dependency on #218/#219 remains owned by
  the Beads source.
