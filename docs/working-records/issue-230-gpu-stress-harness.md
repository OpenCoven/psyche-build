# Working record — issue 230: debug-authorized rendering stress harness

**Issue:** [OpenCoven/psyche-build#230](https://github.com/OpenCoven/psyche-build/issues/230) — `[psyche-z7c.4.4] Add the debug-authorized rendering stress harness` (Bead `psyche-z7c.4.4`, P1)  
**Branch:** `psyche/issue-230-gpu-stress-harness` (fork PR; exact head below)  
**Date:** 2026-08-28  
**Risk class:** R1 (documentation + isolated tests; no product behavior change, no runtime surface, no security-boundary change — the authorization rules are specified and tested as a pure contract, not rewired)

## Outcome

Shipped the debug-authorized rendering stress harness contract as one focused,
additive slice:

- `docs/gpu/STRESS-HARNESS-CONTRACT.md` — the fixed native steady/burst/rewrite
  fixtures; deterministic `panes-1`/`panes-6`/`panes-12`/`panes-24` scenarios
  with the exact 10 s warmup / 30 s measured / 5 s restore-and-context-loss
  phase timing (45 s per scenario); editor and local-browser adjacency order;
  focus churn every 250 ms and per-frame geometry churn; half the panes hidden
  at 15 s (odd 1-based indexes); minimize at 30 s and restore at 35 s; forced
  context loss at the 40 s restore boundary; the deterministic
  phase-transition table; the ordered cancellation-cleanup plan and its closed
  state set; the cross-platform diagnostics launcher boundary
  (`scripts/dev-tauri-diagnostics.mjs`: explicit child environment,
  `shell` on win32, exit/signal propagation); and the authorization rules —
  debug build **and** the startup environment token, both or nothing, with
  arbitrary commands and production stress commands rejected. No CSP or
  capability expansion; the harness never claims physical acceleration.
- `src/gpu/stressScenarios.ts` — versioned (v1), pure, dependency-free TS
  module: closed fixture enum, scenario ids aligned with #232's
  `GPU_VERIFICATION_SCENARIO_IDS`, known pane counts, pinned phase-timing and
  churn constants, `authorizeStressRun()` (both-or-nothing; exact `"1"`
  startup-token semantics mirroring native `stress_authorized_for`),
  `validateScenarioRequest()` and `validateFixtureSelection()` (closed enums
  only; command-shaped input rejected with the dedicated
  `arbitrary-command-rejected` code), `buildStressScenarios()` and
  `buildPhaseTransitionTable()` (deterministic tables), the per-pane fixture
  cycling rule, and `buildCancellationCleanupPlan()` /
  `validateCancellationCleanupOutcome()` (closed cleanup states; `pending`
  and `failed` outcomes fail closed). No `process.env` reads, no timers, no
  processes: the startup token is captured by the caller and passed in.
- `__tests__/gpuStressScenarios.test.ts` — 42 focused tests: constants
  contracts, deterministic scenario/transition tables, authorization negative
  tests (production context, missing flag, missing/invalid token, both-missing),
  closed-enum and unknown-pane-count rejections, arbitrary-command rejection,
  cancellation-cleanup states, malformed-input rejection, and a
  documentation-contract test keeping the contract doc aligned with the
  machine constants.

## Scope and boundaries

In scope: the stress-harness contract document, the pure contract module, and
their focused tests. Out of scope and deliberately not done:

- **No runtime wiring.** The native `diagnostics_spawn_fixture` command, the
  `scripts/dev-tauri-diagnostics.mjs` launcher script, and the in-app
  diagnostics panel belong to the #231 chain (and the charter/merge-rule
  surfaces belong to #228/#229). This slice specifies the contract they must
  satisfy; nothing existing was rewired to it.
- **No Rust mirror (decision below).** No `Cargo.toml`, dependency, `lib.rs`,
  or capability/CSP change; no edits to `index.ts`/barrels, workflows,
  lockfile, package scripts, Beads, or generated outputs.
- **No execution evidence.** No stress run was executed on any machine; the
  harness produces measurements only, and no acceleration or performance
  claim is made anywhere in this slice.
- The upstream OpenCoven repository is token-denied for writes; the pipeline
  runs on the fork `CompleteDotTech/psyche-build` with real CI.

### Rust-mirror decision (recorded gap)

The optional minimal Rust mirror was **skipped**. Grounds, per the task's own
skip condition ("if layout makes this risky, skip it and record the gap"):

1. A new `.rs` module is inert without a `mod` declaration in
   `native/desktop/psyche-build-tauri/src-tauri/src/lib.rs`; that insertion
   lands in the same alphabetical region (`runtime_diagnostics`,
   `workspace_contract`) that the dependent diagnostics-surface slice (#231)
   must edit for command registration — a deliberate cross-slice conflict.
2. No cargo toolchain exists on this host, so the mirror would be
   compile-untested locally; any `native/desktop/*` change classifies the PR
   as desktop and triggers the full cross-OS Rust gates
   (`cargo fmt --check`, `cargo test --locked`, `cargo check` on three
   runners), so an untested compile error would burn fix-push cycles with no
   local reproduction path.
3. The only Rust surface with real value — the enum-only
   `diagnostics_spawn_fixture` command with debug+startup-env authorization —
   requires `invoke_handler` command registration, which is behavior rewiring
   and explicitly out of scope. The existing authorization semantics already
   live in `runtime_diagnostics.rs` (`stress_authorized_for`) and are mirrored
   here as constants; a consumerless constants file would be dead code.

## Exact commands and observed results

All commands run from `/home/node/trees/issue-230` (Node v24, pnpm 10.34.5 via
`npx pnpm`, TypeScript 7.0.2, vitest 4.1.10), before the commits below:

| Command | Observed result |
|---|---|
| `npx pnpm install --frozen-lockfile` | exit 0 — `Done in 748ms using pnpm v10.34.5`; no lockfile changes |
| `npx pnpm exec vitest --run __tests__/gpuStressScenarios.test.ts` | exit 0 — `Test Files 1 passed (1)`, `Tests 42 passed (42)` |
| `npx pnpm exec tsc --noEmit` | exit 0 (after fixing five narrowing errors found by the first run: `includes()` does not narrow, replaced with type guards + total lookup maps) |
| `npx pnpm exec tsc -p tsconfig.test.json --noEmit` | exit 0 (after widening the test helper's parameter to accept `readonly` rejection arrays) |
| `npx pnpm run build` | exit 0 — generate:hooks-docs + frontend production build; `git status` before and after showed exactly the three new files and zero generated-output drift |
| `git diff --check` | exit 0 — no whitespace/conflict-marker issues |
| `git status --porcelain=v1 --untracked-files=all` (pre-commit) | exactly the three new files, nothing else |

Test counts: **42 passed, 0 failed** (focused suite; the full-repository
suite was not run on this host — see gaps).

## Exact head SHA

- Implementation commit (all three deliverables):
  `615baf14f2c90e93ac68e262367087cd2d36992f`
- Parent / base: `63667f3` (current `origin/main` after fast-forward from
  `a4546f4`).
- Final branch head includes this working record as a separate commit and is
  recorded verbatim in the fork PR body and status comment for this issue.

## Proof gaps (explicit, open)

1. **No runtime execution.** The stress harness has no runtime wiring in this
   slice; the native spawn command, launcher script, and diagnostics surface
   land with the #231 chain. Until then the contract is exercised by unit
   tests only — an open dependency, not a silent assumption.
2. **Physical acceleration evidence: not collected, and no claim is made.**
   This host has no desktop runtime, no GPU evidence-collection path, and no
   tmux; acceleration evidence is governed by
   `docs/gpu/VERIFICATION-MATRIX.md` (issue #232) and remains open there.
3. **Rust gates not runnable locally:** no cargo toolchain; `cargo fmt/test/
   check` are supplied by fork CI. The Rust mirror was skipped (decision
   above).
4. **Full repository test suite not run locally** (`pnpm test`); the runbook's
   focused verification set was used. Fork CI runs the full suite.
5. **`scripts/agent-bootstrap` / `scripts/agent-check` deliberately not run**
   (they require tmux, absent here; the runbook forbids them on this host).

## Rollback notes

The slice is purely additive: revert the implementation commit or delete the
branch. No existing file is modified; no generated output, workflow, script,
dependency, barrel, or capability change exists to unwind. The contract module
is not referenced by any runtime code, so removal has no runtime blast radius.

## CI and review expectations

Fork CI (pull_request) must reach terminal green on this PR; because no
`native/desktop/*` file changed, the desktop/iOS jobs classify as skipped
(skipped counts as green per the runbook). Reviewers should focus on the
authorization both-or-nothing semantics, the closed enums, and the
deterministic tables — those are the security-relevant boundaries this slice
fixes for the dependent #231 wiring.
