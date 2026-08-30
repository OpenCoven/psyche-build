# Working record — issue 228: GPU ADE epic charter and evidence policy

**Issue:** [OpenCoven/psyche-build#228](https://github.com/OpenCoven/psyche-build/issues/228) — `[psyche-z7c] GPU-accelerated multiplatform desktop ADE` (Bead `psyche-z7c`, P1 epic, `in_progress`; canonical outcome gh-199)  
**Branch:** `psyche/issue-228-gpu-ade-epic-charter` (fork PR; exact head below)  
**Date:** 2026-08-30  
**Risk class:** R1 (documentation + isolated tests; no product behavior change)

## Outcome

Shipped the epic-level charter and the machine-checkable evidence policy for the
GPU ADE family as one focused, additive slice:

- `docs/gpu/ADE-EPIC-CHARTER.md` — the epic objective (runnable macOS/Windows/
  Linux Tauri ADE on the platform WebView compositor, bounded PTY transport,
  isolated per-pane rendering, strict runtime acceleration evidence, repeatable
  diagnostics stress harness); the four-slice architecture verbatim from the
  issue with current status per slice, each status claim tied to an exact
  artifact observed on upstream `main` `63667f3` (slice 1 cross-platform
  runtime: `native/desktop/psyche-build-tauri` + `platform/{macos,windows,
  linux}.rs` + the change-classified `macos-15`/`windows-2025`/`ubuntu-24.04`
  desktop CI matrix; slice 2 bounded PTY batching: `pty_transport.rs` constants
  `MAX_PENDING_BYTES = 2 MiB`, `MAX_PENDING_FRAGMENTS = 128`,
  `MAX_BATCH_BYTES = 64 KiB`, `MAX_IN_FLIGHT = 2`, `HIDDEN_CADENCE = 100 ms`,
  `EXIT_DRAIN_TIMEOUT = 2 s` with ack sequencing and in-file Rust tests; slice 3
  per-pane lifecycle: `web/runtime/{terminal-pane-controller,frame-scheduler,
  pty-client,virtual-list}.ts`, `scrollback: 10_000`,
  `VIRTUAL_LIST_THRESHOLD = 200`; slice 4 diagnostics + 1/6/12/24-pane stress
  verification: in progress — #229/#230/#231 open, #232 matrix shipped on fork
  PR #7, physical acceleration evidence not collected); the constraints
  verbatim-faithful with per-clause operational rules (never drop or reorder
  raw PTY bytes; never weaken CSP/capabilities; never guess acceleration
  details; no GPU-disabling flags; no unobserved physical-platform claims);
  the evidence policy (four-value vocabulary from runtime evidence only,
  omission over placeholders, conflicts/masking classify `unknown`, hosted
  compilation never proves physical GPU acceleration); execution protocol notes
  (verbatim issue protocol plus the fork-pipeline note); and the acceptance
  criteria verbatim.
- `src/gpu/adeEvidencePolicy.ts` — versioned (v1) pure TS evidence policy:
  closed acceleration-evidence vocabulary (`accelerated`, `software`,
  `unknown`, `unavailable`); tested, versioned software-marker and
  hardware-backend token lists; `classifyRenderer()` over probe facts
  (unavailable only when both context probes conclusively failed; conflicting
  renderer/adapter strings classify `unknown`; software markers always beat a
  successful strict context; `accelerated` requires a strict context or WebGPU
  adapter plus available renderer evidence, otherwise `unknown` as masked);
  `resolveEvidenceConflict()` (agreeing affirmative claims stand; differing
  affirmative claims classify `unknown` with no tie-breaking; `unknown` or
  missing evidence is absence, never a contradiction; no affirmative evidence
  at all classifies `unknown`, never a guess); and `mergeEvidenceReports()`,
  the deterministic native+browser merge that keeps complementary observed
  values, omits and names fields nobody supplied, drops fields any collector
  declared unsupported even when the other supplied a value, omits and names
  conflicting values, treats empty/whitespace values as not supplied, and
  never introduces fields of its own.
- `__tests__/gpuAdeEvidencePolicy.test.ts` — 38 focused tests: vocabulary
  pins, marker/backend detection, the full `classifyRenderer()` decision
  table (including conflicting-evidence→`unknown`), the full conflict
  resolution table, merge field rules (missing fields omitted and named, not
  defaulted; unsupported-declared fields dropped; conflicting values omitted),
  merge determinism (identical deep-equal output, canonical `omittedFields`
  order, symmetry in collector arguments, no input mutation), and a
  documentation-contract test keeping the charter aligned with the
  implemented vocabulary and constraints.

## Scope and boundaries

In scope: the epic charter document, the evidence-policy module, and focused
tests. Out of scope and deliberately not done:

- **Slice files are not touched.** The stress harness belongs to #230, the
  in-app diagnostics surface to #231, and the verification matrix (docs +
  manifest validator, `docs/gpu/VERIFICATION-MATRIX.md` +
  `src/gpu/verificationMatrix.ts`) to #232 — shipped on fork PR
  CompleteDotTech/psyche-build#7. This slice adds only
  `docs/gpu/ADE-EPIC-CHARTER.md`, `src/gpu/adeEvidencePolicy.ts`, and
  `__tests__/gpuAdeEvidencePolicy.test.ts`; no filename collides with any
  slice's files.
- **No runtime code changes.** The policy module is pure and referenced by no
  runtime code; no edits to `index.ts`/barrels, workflows, package scripts,
  dependencies, lockfile, Beads, or generated outputs.
- **No execution evidence claimed.** Physical acceleration/stress evidence on
  macOS/Windows/Linux was not collected and is recorded as an open gap (below
  and in the charter's slice-4 status). No acceleration claim is made for any
  platform.
- The upstream OpenCoven repository is token-denied for writes; the pipeline
  runs on the fork `CompleteDotTech/psyche-build` with real CI.

## Exact commands and observed results

All commands run from `/home/node/trees/issue-228` (Node v24, pnpm 10.34.5 via
`npx pnpm`), before the commits listed below:

| Command | Observed result |
|---|---|
| `npx pnpm install --frozen-lockfile` | exit 0 — `Done in 743ms using pnpm v10.34.5`; no lockfile changes |
| `npx pnpm exec vitest --run __tests__/gpuAdeEvidencePolicy.test.ts` (first run) | 1 failed / 37 passed — `resolveEvidenceConflict('accelerated', 'unknown')` returned `unknown`; the implementation contradicted its documented table (a masked classification was treated as an affirmative value). Fixed in the module, not the test. |
| `npx pnpm exec vitest --run __tests__/gpuAdeEvidencePolicy.test.ts` (after fix) | exit 0 — `Test Files 1 passed (1)`, `Tests 38 passed (38)` |
| `npx pnpm exec tsc --noEmit` | exit 0 |
| `npx pnpm exec tsc -p tsconfig.test.json --noEmit` | exit 0 |
| `git diff --check` | exit 0 — no whitespace/conflict-marker issues |
| `git status --porcelain=v1 --untracked-files=all` (pre-commit) | exactly the three new files, nothing else |

Test counts: **38 passed, 0 failed** (focused suite; full-repository suite not
run on this host — see gaps).

## Exact head SHA

- Implementation commit (all three deliverables):
  `a20b47e8a57e6f26b616e179750c0d1e28a6e606`
- Parent / base: `63667f3` (current `origin/main`, "Report pane recovery
  failures visibly (#283)")
- Final branch head adds this working record as a separate commit and is
  recorded verbatim in the fork PR body and status comment.

## Proof gaps (explicit, open)

1. **Physical acceleration/stress evidence (macOS/Windows/Linux): not
   collected.** This host has no desktop app runtime, no tmux, no GPU
   evidence-collection path. Per the charter and the #232 matrix, all three
   platform rows remain open proof gaps; no acceleration claim is made for
   any platform, and hosted CI does not close this gap.
2. **Slice 4 is open.** #229/#230/#231 are open (#231 bead-blocked); #232's
   matrix is on fork PR #7, pending merge. The charter records their status as
   of 2026-08-30 at upstream `main` `63667f3` and must be re-verified when
   slices close.
3. **Gates not runnable on this host:** `pnpm smoke` and `pnpm smoke:pack`
   (smoke requires tmux, absent), `pnpm --dir native/desktop/psyche-build-tauri
   build:web`, and the Rust gates `cargo fmt/test/check` (no cargo toolchain).
   These are supplied by fork CI.
4. **Full repository test suite not run locally** (`pnpm test`); the runbook's
   focused verification set was used instead. Fork CI runs the full suite.
5. **`scripts/agent-bootstrap` / `scripts/agent-check` deliberately not run**
   (they require tmux, absent here; the runbook forbids them on this host).

## Rollback notes

The slice is purely additive: revert the implementation commit
(`a20b47e8a57e6f26b616e179750c0d1e28a6e606`) and the working-record commit, or
delete the branch. No existing file is modified; no generated output,
workflow, script, dependency, or barrel change exists to unwind. The policy
module is not referenced by any runtime code, so removal has no runtime blast
radius.
