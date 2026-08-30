# Working record — issue 212: accessibility and motion semantics (psyche-i7c.10.3)

- **Branch:** `psyche/issue-212-a11y-motion-semantics`
- **Worktree:** `/home/node/trees/issue-212`
- **Implementation commit:** `f619bbad7f72bc94310effb36e4bf17a0025983b`
- **Branch head at push:** recorded in the fork PR body and status comment (the
  working record file lands inside the final commit, so it cannot contain that
  commit's own SHA).
- **Upstream issue:** [OpenCoven/psyche-build#212](https://github.com/OpenCoven/psyche-build/issues/212)
  (Beads mirror `psyche-i7c.10.3`, P1, blocked; canonical outcome gh-200).
- **PR:** fork PR (CompleteDotTech/psyche-build) — link and head SHA in the PR
  body and status comment; upstream writes are token-denied so this pipeline
  runs on the fork with real CI.

## Outcome

Platform-neutral accessibility and motion semantics contract for the mobile
cockpit (Phase 10 family), plus a versioned (v1) TypeScript reference
implementation and focused tests:

- `docs/a11y/MOBILE-MOTION-SEMANTICS.md` — the v1 contract: status never
  color-only (required textual equivalents per token), combined
  pane/project/host summaries, selected-split trait rules, consequence-first
  confirmation phrasing, Dynamic Type identity-preservation rules, Reduce
  Motion trait stripping, stable identifier requirements, and the
  accessibility UI test definition (Now → pane → action sheet).
- `src/a11y/motionSemantics.ts` — pure, import-free, I/O-free reference
  module: `PANE_STATUS_TOKENS` / `PANE_STATUS_DESCRIPTORS` (every token
  carries a required `text` and `summaryPhrase`), `summaryForPaneProjectHost()`
  (identity-complete label + structured parts, `Selected` announcement for the
  focused pane, fail-closed caps, no color vocabulary),
  `motionTraitsFor()` (v1 transition → trait table; `reduceMotion` strips
  `matched-geometry` and `nonessential-transition` classes, retains
  `essential-state` activity indicator, flags instant state change),
  `confirmationCopy()` (consequence-first stop/close/send-input copy naming
  pane/project/host and worktree/branch survival), version constants
  (`MOTION_SEMANTICS_CONTRACT_VERSION = 1`, `MOTION_SEMANTICS_CONTRACT_ID`).
- `__tests__/a11yMotionSemantics.test.ts` — table-driven tests over every
  status token, transition kind, and confirmation kind, including rejection
  of empty/whitespace-only/oversize/non-string inputs and unknown tokens.

## Scope and boundaries

Did NOT do (out of slice):

- No SwiftUI/Xcode/XCUITest changes — the iOS integration consuming this
  contract belongs to the mobile track (gh-200; parents #209/#211). Section 9
  of the contract defines the required UI test; it is not implemented here.
- No wiring into existing product surfaces (`src/components/`, TUI, web) —
  this PR is additive reference semantics only; consumption is a follow-up
  for the owning surfaces.
- No edits to files owned by concurrent agents (`docs/gpu/`, `docs/vim/`,
  `docs/mobile/`, `docs/perf/`, `docs/review/`, `src/mobile/`, `src/perf/`,
  `src/gpu/`, `src/vim/`) and none to generated outputs, `.github/**`,
  `.beads/**`, `pnpm-lock.yaml`, `package.json` dependencies, barrels, or
  `docs/ROADMAP.md` / `docs/SUPPORT-MATRIX.md`.
- Did not resolve the Beads dependency (blocked by #211 / psyche-i7c.10.2);
  this contract is independent of that state-reconciliation work and does not
  claim the blocked dependency resolved.

## Risk class

- [x] **R1** — documentation + isolated pure tests. The module is not yet
      consumed by any runtime surface; no product behavior, authority,
      confirmation flow, persistence, or recovery path changes. (Per
      AGENTS.md, R2 would apply to the future SwiftUI integration that wires
      these semantics into user-facing surfaces.)

## Exact commands and observed results

Run from `/home/node/trees/issue-212` (branch
`psyche/issue-212-a11y-motion-semantics`, base `origin/main` at `a4546f4`):

| Command | Result |
|---|---|
| `npx pnpm install --frozen-lockfile` | exit 0 (clean install, no lockfile changes) |
| `npx pnpm exec vitest --run __tests__/a11yMotionSemantics.test.ts` | **54 passed, 0 failed** (`Test Files 1 passed (1)`, `Tests 54 passed (54)`) |
| `npx pnpm exec tsc --noEmit` | exit 0, no output |
| `npx pnpm exec tsc -p tsconfig.test.json --noEmit` | exit 0, no output |
| `git diff --check` | clean (no whitespace/conflict-marker errors) |
| `git status` (before commit) | only the three new files plus this record; no unrelated modifications |

Fork CI: recorded in the PR body / status comment once terminal (Quality gate
plus change-classified jobs; skipped counts as green per runbook).

## Test counts

- New focused suite: 54 tests, 54 passed, 0 failed, 0 skipped
  (`__tests__/a11yMotionSemantics.test.ts`).
- No existing tests were modified or deleted; no existing test was relied on
  for this slice's evidence.

## Proof gaps

1. **SwiftUI / XCUITest verification (documented gap — macOS CI/host
   required).** The acceptance criterion "Accessibility UI test completes
   Now→pane→action sheet" requires the repository-pinned Xcode, iOS
   simulator, and XcodeGen on a macOS host (`PSYCHE_AGENT_CHECK_IOS=1`).
   This host has no Xcode/iOS tooling (runbook: no Xcode, no sudo), so the
   UI test is specified (contract §9) but not executed here. No local iOS
   proof is claimed.
2. **Repository full gate not run.** `scripts/agent-bootstrap` /
   `scripts/agent-check fast|full` require tmux, which this host lacks
   (runbook). The slice's gates are the vitest + both tsc runs above.
3. **Product-path evidence.** Unit tests of a pure reference module are not
   user-path evidence; no user path claims to have changed. The SwiftUI
   consumption of these semantics remains with the mobile track.
4. **Physical-device / TestFlight claims:** none made.
5. Upstream issue/PR write-back (commenting on OpenCoven#212) is
   token-denied; status is reported on the fork PR thread per runbook.

## Rollback

- Additive-only: three (now four) new files, zero modifications to existing
  files. `git revert <implementation-commit> <working-record-commit>` or
  deleting the branch removes the slice entirely.
- No persisted formats, schemas, generated outputs, or shared configuration
  touched; no migration or cleanup is needed.

## Beads / tracker note

- Issue body is a generated Beads mirror (`psyche-i7c.10.3`); per
  `.beads/README.md` and the sole-migrator rule it was not hand-edited. The
  blocked dependency on #211 remains owned by the Beads source.
