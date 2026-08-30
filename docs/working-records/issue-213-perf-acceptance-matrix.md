# Working record — issue-213-perf-acceptance-matrix

**Issue:** [OpenCoven/psyche-build#213](https://github.com/OpenCoven/psyche-build/issues/213) — `[psyche-i7c.10.4]` Run performance and full acceptance matrix (P1, **blocked**)
**Family:** mobile cockpit Phase 10 (`psyche-i7c.10`, parent #209); canonical outcome gh-200
**Blocked by:** #210 (bounded protected workspace cache), #211 (restored-vs-live stale UX), #212 (accessibility/motion semantics)
**Branch:** `psyche/issue-213-perf-acceptance-matrix` (worktree `/home/node/trees/issue-213`)
**Baseline:** `origin/main` at `a4546f4`
**Risk class:** R1 — documentation plus isolated, additive tests; no product behavior, authority, persistence, or protocol surface touched

## Outcome

Delivered the #213 **definition slice** (the issue's execution half remains open
and blocked, as documented in the issue's acceptance criteria):

1. `docs/perf/MOBILE-ACCEPTANCE-MATRIX.md` — the full mobile acceptance matrix:
   the four measurement areas from the issue (workspace serialization,
   event-stream bounds, memory/session caps, navigation responsiveness), the
   complete automated gate list (TypeScript suites, Xcode project-generation
   check, PsycheCore, iPhone, and iPad suites, plus one paired-host scenario
   when feasible), the environment-only baselines that may be documented
   instead of run, and the live paired-host scenario definition
   (pair → Now → split → input → file/diff → action → reconnect) with its
   concrete unavailable dependency recorded verbatim.
2. `src/perf/acceptanceThresholds.ts` — versioned (v1) threshold contract:
   16 typed thresholds with explicit units and provenance, a strict
   `validateThresholdSet()` (finite/positive/bounded-count checks, unknown-field
   rejection, status↔value↔owner invariants), and `evaluateObservation()`
   classifying observations as within/warn/breach with inclusive boundaries.
   Every number is either a production-mirror (source file cited: 8 entries) or
   an explicitly reasoned proposal (4 entries); the 4 ungrounded entries are
   `null` + "to be measured" with an owning issue (#213/#210). No number is
   invented silently.
3. `__tests__/mobileAcceptanceThresholds.test.ts` — 25 focused tests: contract
   shape, validator rejections (negative/NaN/infinite/unknown fields/duplicate
   ids/status invariants/warn ordering), and `evaluateObservation` boundary
   behavior for both directions plus refusal paths.
4. This working record.

## Scope and boundaries

- Additive only. New files under `docs/perf/`, `src/perf/`, `__tests__/`, and
  `docs/working-records/` — none of them owned by concurrent slices
  (`docs/gpu/`, `docs/vim/`, `docs/a11y/`, `docs/mobile/`, `docs/review/`,
  `src/a11y/`, `src/mobile/`, `src/gpu/` untouched).
- Did **not** implement the cache (#210), stale-state UX (#211), accessibility
  semantics (#212), or any measurement tooling; did **not** modify existing
  product code, generated outputs, `.github/**`, `.beads/**`, lockfile, or
  `package.json` dependencies.
- Did **not** run any performance measurement or iOS test: live measurement on
  iPhone/iPad hardware is impossible on this Linux host (no Xcode/iOS tooling,
  no tmux, no sudo) and is an explicit documented gap, not a silent omission.

## Verification — exact commands and observed results

Run from `/home/node/trees/issue-213` (Node v24, pnpm 10.34.5 via `npx pnpm`):

| Command | Result |
|---|---|
| `npx pnpm install --frozen-lockfile` | Done (738 ms); lockfile unchanged |
| `npx pnpm exec vitest --run __tests__/mobileAcceptanceThresholds.test.ts` | **25 passed (25)**, 0 failed |
| `npx pnpm exec tsc --noEmit` | exit 0 |
| `npx pnpm exec tsc -p tsconfig.test.json --noEmit` | exit 0 |
| `git diff --check` | clean |

Not run here (gaps, with the unavailable dependency named):

- Full TypeScript unit suite beyond the new file, and the iOS gates
  (`pnpm ios:project:check`, PsycheCore, iPhone/iPad simulator suites): require
  macOS/Xcode tooling — supplied by CI on the fork PR, not by this host.
- Live paired-host scenario (§4 of the matrix): requires a physical iPhone/iPad
  with a reviewed install build and a same-LAN authorized host with pairing
  credentials; neither exists on this host nor in CI runners. Recorded verbatim
  in `docs/perf/MOBILE-ACCEPTANCE-MATRIX.md` §4.3.
- Any performance measurement: none exists yet; all proposal values are
  documented defaults pending #213 execution evidence, and the four
  ungrounded thresholds carry `null` + "to be measured" with owners.

## Commits

- Implementation commit: recorded in the PR (see branch
  `psyche/issue-213-perf-acceptance-matrix`); adds
  `src/perf/acceptanceThresholds.ts`, `__tests__/mobileAcceptanceThresholds.test.ts`,
  `docs/perf/MOBILE-ACCEPTANCE-MATRIX.md`.
- Working record commit: the final branch-head commit adds only this file.
  Verification above was executed on the implementation commit's exact tree.

## Test counts

- New tests: 25, all passing (1 file).
- Repository suite: not run in full on this host (concurrent-agent worktrees
  share the checkout cache; the fork PR's Quality CI runs the full suite).

## Proof gaps

- No on-device (iPhone/iPad) evidence — impossible on this host; gated on
  gh-200 Phases 1–6 deliverables and #213 execution.
- No macOS/Xcode evidence — delegated to fork PR CI (change-classified iOS
  jobs may skip; a skipped job is not a pass).
- No live paired-host scenario — dependency documented per matrix §4.3.
- Threshold values: 4 production-mirrors pinned to `a4546f4` constants; 4
  proposals marked as such; 4 entries `null` pending #210/#213 owners. The
  matrix gates nothing on proposal values until measurement upgrades them.

## Rollback

Revert the single implementation commit (and this record commit) on the fork
PR; both are additive and touch no existing file, so rollback cannot affect
other slices.

## Coordination notes

- `docs/perf/` and `src/perf/` were confirmed absent at `a4546f4`; no other
  agent's namespace was touched. The threshold module imports nothing and is
  imported by nothing outside its test, so it cannot collide with concurrent
  slices.
- Beads source remains authoritative for the mirror issue; no Beads or upstream
  GitHub writes were attempted (upstream writes are token-denied for this
  agent; the fork PR is the status surface per the runbook).
