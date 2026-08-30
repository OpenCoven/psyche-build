# Working record — issue 232: GPU verification matrix

**Issue:** [OpenCoven/psyche-build#232](https://github.com/OpenCoven/psyche-build/issues/232) — `[psyche-z7c.4.6] Document and execute the GPU verification matrix` (Bead `psyche-z7c.4.6`, P1, blocked)  
**Branch:** `psyche/issue-232-gpu-verification-matrix` (fork PR; see exact head below)  
**Date:** 2026-08-28  
**Risk class:** R1 (documentation + isolated tests; no product behavior change)

## Outcome

Shipped the GPU verification matrix documentation and its machine-checkable
evidence-manifest contract as one focused, additive slice:

- `docs/gpu/VERIFICATION-MATRIX.md` — per-platform (macOS/Windows/Linux)
  evidence-collection protocol; the ten deterministic repository gates; the
  1/6/12/24-pane scenario matrix; performance targets (six-pane supported-
  hardware p95 frame time ≤ 33.4 ms; focus/resize input-to-next-paint < 100 ms);
  context-loss/minimize/background/restore checks; bounded CPU/RSS,
  queue/IPC/throughput/frame metrics; separate machine/driver metadata; CSP and
  capability diff audit; final cumulative spec/code review requirements; the
  explicit rule that hosted CI never substitutes for physical acceleration
  evidence; and unavailable physical platforms as open proof gaps.
- `src/gpu/verificationMatrix.ts` — versioned (v1) typed-constant module for the
  evidence manifest schema (platform set, gate list, scenario ids, metric keys,
  closed status vocabulary) plus `validateEvidenceManifest()`, a strict
  structural validator: rejects unknown fields at every level, requires exact
  provenance (release version, full 40-hex commit SHA, platform, architecture,
  UTC timestamp, collector) and machine/driver metadata, bounds and de-duplicates
  records, caps string sizes, rejects non-finite/out-of-range metric values, and
  fails closed on raw hostnames (digest-only machine identity).
- `__tests__/gpuVerificationMatrix.test.ts` — 33 adversarial/focused tests over
  the constants contract and the validator, plus a documentation-contract test
  that keeps `docs/gpu/VERIFICATION-MATRIX.md` aligned with the machine constants.

## Scope and boundaries

In scope: the verification matrix document, the manifest schema/validator
module, and focused tests. Out of scope and deliberately not done:

- **#231 (diagnostics surface) is unresolved and blocks this bead.** No
  diagnostics-surface, stress-harness, or runtime code was implemented here.
- No edits to files owned by concurrent slices; no changes to `index.ts`,
  barrels, workflows, package scripts, lockfile, Beads, or generated outputs.
- No execution evidence was collected: this slice ships the matrix + validator
  contract. Physical-hardware execution remains an explicit open gap (below).
- The upstream OpenCoven repository is token-denied for writes; the pipeline
  runs on the fork `CompleteDotTech/psyche-build` with real CI.

## Exact commands and observed results

All commands run from `/home/node/trees/issue-232` (Node v24, pnpm 10.34.5 via
`npx pnpm`), before the commits listed below:

| Command | Observed result |
|---|---|
| `npx pnpm install --frozen-lockfile` | exit 0 — `Done in 728ms using pnpm v10.34.5`; no lockfile changes |
| `npx pnpm exec vitest --run __tests__/gpuVerificationMatrix.test.ts` | exit 0 — `Test Files 1 passed (1)`, `Tests 33 passed (33)` |
| `npx pnpm exec tsc --noEmit` | exit 0 (after fixing one TS7022 inference circularity found by the first run) |
| `npx pnpm exec tsc -p tsconfig.test.json --noEmit` | exit 0 |
| `npx pnpm run build` | exit 0 — generate:hooks-docs + frontend production build + tsc; `git status` confirmed zero generated-output drift (the generator reproduced the committed file exactly) |
| `git diff --check` | exit 0 — no whitespace/conflict-marker issues |
| `git status --porcelain=v1 --untracked-files=all` (pre-commit) | exactly the three new files, nothing else |

Test counts: **33 passed, 0 failed** (focused suite; full-repository suite not
run on this host — see gaps).

## Exact head SHA

- Implementation commit (all three deliverables):
  `755feebc8553f9432d511f8f88111e494c074d64`
- Parent / base: `a4546f4` (current `origin/main`)
- Final branch head includes this working record as a separate commit and is
  recorded verbatim in the fork PR body and status comment for this issue.

## Proof gaps (explicit, open)

1. **Physical acceleration evidence (macOS/Windows/Linux): not collected.** This
   host has no physical GPU evidence-collection path, no desktop app runtime,
   and no tmux. Per the matrix's rule 2, all three platform rows remain open
   proof gaps; no acceleration claim is made for any platform.
2. **#231 blocks this bead.** The in-app diagnostics surface that presents and
   exports the diagnostics/scenario JSON is not merged, so end-to-end evidence
   collection cannot proceed yet.
3. **Gates not runnable on this host:** `pnpm smoke` and `pnpm smoke:pack`
   (smoke requires tmux, absent), `pnpm --dir
   native/desktop/psyche-build-tauri build:web`, and the Rust gates
   `cargo fmt/test/check` (no cargo toolchain). These are supplied by fork CI
   and remain to be recorded per release head in a real evidence manifest.
4. **Full repository test suite not run locally** (`pnpm test`); the runbook's
   focused verification set was used instead. Fork CI runs the full suite.
5. **`scripts/agent-bootstrap` / `scripts/agent-check` deliberately not run**
   (they require tmux, absent here, and the runbook forbids them on this host).

## Rollback notes

The slice is purely additive: revert the implementation commit
(`755feebc8553f9432d511f8f88111e494c074d64`) and the working-record commit, or
delete the branch. No existing file is modified; no generated output, workflow,
script, dependency, or barrel change exists to unwind. The validator module is
not yet referenced by any runtime code, so removal has no runtime blast radius.

## CI and review expectations

Fork CI (pull_request) must reach terminal green on this PR; per the matrix,
that CI passage proves buildability/tests/fallback reporting only and is
recorded nowhere as acceleration evidence. Final cumulative spec and code
reviews remain pending by design until execution evidence exists; the manifest
schema models them as `pending` rather than assuming approval.
