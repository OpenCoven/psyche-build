# Working record — issue 218: native pane action menu and guarded confirmations (psyche-i7c.9.2)

- **Branch:** `psyche/issue-218-pane-action-menu`
- **Worktree:** `/home/node/trees/issue-218`
- **Implementation commit:** `175c140baf53eb7df2627095dab54f39bfb350ab`
- **Branch head at push:** recorded in the fork PR body and status comment (the
  working record file lands inside the final commit, so it cannot contain that
  commit's own SHA).
- **Upstream issue:** [OpenCoven/psyche-build#218](https://github.com/OpenCoven/psyche-build/issues/218)
  (Beads mirror `psyche-i7c.9.2`, P1; canonical outcome gh-200).
- **PR:** fork PR (CompleteDotTech/psyche-build) — link and head SHA in the PR
  body and status comment; upstream writes are token-denied so this pipeline
  runs on the fork with real CI.

## Outcome

Versioned (v1) pane action menu contract for the mobile cockpit (Phase 9
family) plus a pure TypeScript reference implementation and focused tests:

- `docs/mobile/PANE-ACTION-MENU-CONTRACT.md` — the v1 contract: the seven-action
  catalog (merge, create PR, stop, close and clean up, rename, files, rituals)
  with per-action ids, titles, destructive classification, follow-up-flow and
  ellipsis rules, touched scope, and survival semantics; stop vs.
  close-and-clean-up visual+semantic distinctness rules (different ids, titles,
  consequences, survival values) and cleanup routing through the single
  `PaneAction.CLOSE` id (no separate cleanup action); destructive confirmation
  ordering (consequence → scope → disposition → confirm/cancel buttons, i.e.
  the consequence is read before its button) with exact-scope naming and
  fail-closed caps; stale / already-running / unreachable-host disabling with
  required textual reasons and single-flight-per-pane rules; result, error, and
  progress visibility states that always carry text and never rely on spinner,
  color, or auto-clear; SwiftUI/XCUITest mirror requirements and the required
  UI test definition.
- `src/mobile/paneActionCatalog.ts` — pure, import-free, I/O-free reference
  module: `PANE_ACTION_IDS` / `PANE_ACTION_CATALOG` (typed `PaneActionId`
  union with consequence metadata: scope kinds touched, survival semantics,
  standalone consequence text), `PANE_ACTION_DESTRUCTIVE_IDS` +
  `confirmationRequiredFor()` (destructive set exactly `merge`, `stop`,
  `close`), `confirmationCopy()` (consequence-first detail with
  `consequenceSentence` / `scopeSentence` / `dispositionSentence` split out for
  reading-order assertions, `CONFIRMATION_PRESENTATION_ORDER` with buttons
  last, verb-first confirm label, plain `Cancel`, no color vocabulary or
  emoji, fail-closed caps, rejects non-destructive and unknown ids),
  `availabilityFor()` (disabled on stale context, on an action already running
  (single-flight), or on an unreachable host — each with a bounded reason token
  and a textual reason naming the action; documented precedence), and
  `PANE_ACTION_FEEDBACK_STATES` / `describePaneActionFeedback()` /
  `feedbackLineFor()` (in-progress / succeeded / failed lines that always name
  the action and pass host detail through verbatim, fail-closed). Version
  constants: `PANE_ACTION_CATALOG_VERSION = 1`,
  `PANE_ACTION_CATALOG_ID = 'psyche.mobile.pane-action-catalog.v1'`.
- `__tests__/paneActionCatalog.test.ts` — 50 focused tests: catalog table
  alignment and text hygiene; the destructive set (every destructive action
  requires confirmation; exactly merge/stop/close); copy ordering and
  exact-scope naming (including merge-target naming and host-selected-target
  fallback); availability reasons for stale, already-running, other-running,
  unreachable-host, and their precedence; stop vs. close/cleanup distinctness
  (different ids, titles, consequence text, survival semantics, both stating
  worktree/branch survival); fail-closed rejection of unknown ids on every
  entry point; feedback state table and line building.

## Scope and boundaries

Did NOT do (out of slice):

- **No SwiftUI/Xcode/XCUITest changes.** The native menu itself is the
  documented gap in the issue acceptance criteria; section 7 of the contract
  defines the required SwiftUI mirror and UI test. This host has no Xcode/iOS
  tooling (see proof gaps).
- **No interactive merge/PR flow work** (choice/input/PR-review sheets,
  uncommitted-change and sibling-pane flows, fallback-target confirmation,
  summary editing, final URLs) — that is #219 (`psyche-i7c.9.3`), which is
  blocked by this issue. This contract only defines the menu entry points and
  the merge confirmation guard; the flows reuse existing host workflows.
- **No phase plan or scoped action-context schema work** — that is #217
  (`psyche-i7c.9`). This module is self-contained (no imports) and is the
  action-catalog authority; it composes with, but does not duplicate, the
  context schema.
- **No wiring into existing product surfaces** (`src/panes/`, `src/actions/`,
  TUI, web, `native/ios/**`) — additive reference semantics only; consumption
  is a follow-up for the owning surfaces. No files owned by concurrent agents
  were touched, and none to generated outputs, `.github/**`, `.beads/**`,
  `pnpm-lock.yaml`, `package.json` dependencies, barrels, or
  `docs/ROADMAP.md` / `docs/SUPPORT-MATRIX.md`.
- **No execution path, authority, or receipt changes.** The catalog is
  presentation semantics; control-plane confirmation/approval/receipt
  requirements are untouched and never bypassed.

Recreation note: the issue implementation notes record that an earlier isolated
`feat/mobile-pane-actions` worktree for this task was externally removed before
any source change landed. This deliverable was recreated fresh in this worktree
from `origin/main` at `a4546f4`. At implementation time the mirror issue had
zero comments (the referenced prior audit/composition-seam findings were not
present on the mirror or in the Beads interaction log, which shows only field
changes), so the contract was authored from the issue body, the Phase 9 family
issues (#217/#219), and the sibling #212 exemplar style.

## Risk class

- [x] **R1** — documentation + isolated pure tests. The module is not yet
      consumed by any runtime surface; no product behavior, authority,
      confirmation flow, persistence, or recovery path changes. Confirmation
      copy here is presentation only; it never weakens or replaces control
      plane confirmation requirements (per AGENTS.md this would become R2/R3
      for the future SwiftUI integration that wires these semantics into
      user-facing execution paths).

## Exact commands and observed results

Run from `/home/node/trees/issue-218` (branch
`psyche/issue-218-pane-action-menu`, base `origin/main` at `a4546f4`):

| Command | Result |
|---|---|
| `npx pnpm install --frozen-lockfile` | exit 0 (clean install, no lockfile changes) |
| `npx pnpm exec vitest --run __tests__/paneActionCatalog.test.ts` | **50 passed, 0 failed** (`Test Files 1 passed (1)`, `Tests 50 passed (50)`) |
| `npx pnpm exec tsc --noEmit` | exit 0, no output |
| `npx pnpm exec tsc -p tsconfig.test.json --noEmit` | exit 0, no output |
| `git diff --check` | clean (no whitespace/conflict-marker errors) |
| `git status` (before commit) | only the three new files; no unrelated modifications |

Fork CI: recorded in the PR body / status comment once terminal (Quality gate
plus change-classified jobs; skipped counts as green per runbook).

## Test counts

- New focused suite: 50 tests, 50 passed, 0 failed, 0 skipped
  (`__tests__/paneActionCatalog.test.ts`).
- No existing tests were modified or deleted; no existing test was relied on
  for this slice's evidence.

## Proof gaps

1. **SwiftUI / XCUITest verification (documented gap — macOS CI/host
   required).** The acceptance criteria "Stop and cleanup are
   visually/semantically distinct", "Destructive confirmation reads consequence
   before its button", "Stale or already-running actions are disabled", and
   "Result/error/progress states remain visible" are encoded as contract rules
   plus a pure reference module and unit tests; the on-device/on-simulator UI
   test that walks menu → guarded confirmation → disabled reasons → feedback
   states (contract §7.3) requires the repository-pinned Xcode, iOS simulator,
   and XcodeGen on a macOS host (`PSYCHE_AGENT_CHECK_IOS=1`). This host has no
   Xcode/iOS tooling (runbook: no Xcode, no sudo), so no local iOS proof is
   claimed.
2. **Repository full gate not run.** `scripts/agent-bootstrap` /
   `scripts/agent-check fast|full` require tmux, which this host lacks
   (runbook). The slice's gates are the vitest + both tsc runs above.
3. **Product-path evidence.** Unit tests of a pure reference module are not
   user-path evidence; no user path claims to have changed. SwiftUI
   consumption remains with the mobile track.
4. **Physical-device / TestFlight claims:** none made.
5. **Upstream write-back token-denied.** Commenting on OpenCoven#218 is
   blocked by token permissions; status is reported on the fork PR thread per
   runbook.

## Rollback

- Additive-only: three (now four) new files, zero modifications to existing
  files. `git revert <implementation-commit> <working-record-commit>` or
  deleting the branch removes the slice entirely.
- No persisted formats, schemas, generated outputs, or shared configuration
  touched; no migration or cleanup is needed.

## Beads / tracker note

This PR addresses OpenCoven/psyche-build#218 (Beads `psyche-i7c.9.2`). The
Beads mirror is authoritative; no Beads mutations were performed from this
agent (runbook forbids `.beads/**` edits), and the issue remains open for the
maintainer to progress. Canonical outcome for the iOS/mobile post-release
track is gh-200. Upstream issue/PR write-back is token-denied; the fork PR
thread is the status surface.
