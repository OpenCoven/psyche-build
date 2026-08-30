# Working record — issue 229: GPU slice 4 evidence contract (deterministic merge, classifier, bounded metrics)

- Issue: OpenCoven/psyche-build#229 (`psyche-z7c.4`, parent epic #228, canonical outcome gh-199)
- Branch: `psyche/issue-229-gpu-slice4-evidence`
- Risk class: **R1** (new isolated documentation + pure additive TypeScript module with its own
  tests; no product behavior, authority, protocol, or persistence surface touched)
- Date: 2026-08-30

## Outcome

Shipped the slice-4 core evidence contract as three additive files:

1. `docs/gpu/SLICE4-DIAGNOSTICS-CONTRACT.md` — the diagnostics contract: native + browser
   evidence merge rules, verbatim evidence policy, renderer classification table, bounded
   rendering/transport metrics (retention + polling cadence), the debug-authorized
   1/6/12/24-terminal stress-harness boundary (harness itself = #230), and the diagnostics
   surface boundary (=#231).
2. `src/gpu/slice4ReportMerge.ts` — versioned (schema v1) pure TS module:
   `mergeSlice4Reports()` (deterministic native+browser merge with strict unknown-field
   rejection and omission-not-placeholder optional fields), `classifyRenderer()`
   (accelerated/software/unknown/unavailable, fail-closed), `boundedMetricsWindow()` (explicit
   retention and polling-cadence constants; oversize → typed rejection, never silent truncation).
3. `__tests__/gpuSlice4ReportMerge.test.ts` — 37 focused tests: merge determinism, classification
   table, omission-not-placeholder, bounds enforcement, unknown-field rejection.

## Scope and boundaries (what was deliberately NOT done)

- No stress harness: scenario execution, native fixture commands, and the launcher are owned by
  #230. This slice fixes only the authorization boundary the harness must satisfy (debug build +
  startup environment authorization; fixed fixtures only; fixed 1/6/12/24 scenario set).
- No in-app diagnostics surface: panel, titlebar action, and copy-JSON UI are owned by #231. This
  slice fixes only what the surface may render (present fields only, no placeholder rows).
- No verification-matrix work (#232): no manifest, no physical-collection procedure. The
  acceleration vocabulary here is kept identical to the matrix's so evidence maps without
  translation (verified against `git show fork/psyche/issue-232-gpu-verification-matrix:src/gpu/verificationMatrix.ts`).
- No changes to existing files, barrels, package scripts, workflows, or generated outputs. No
  native Rust code (this host cannot build it); no frame scheduler or PTY changes (slices 1–3).

## Evidence policy compliance

The issue's evidence policy is quoted verbatim in the contract doc and enforced by the module:
accelerated/software/unknown/unavailable come only from runtime evidence; unsupported
version/backend/adapter fields are omitted (never placeholder-filled, with `unsupportedFields`
naming what the driver stack masked); hosted compilation and unit tests never claim physical GPU
acceleration. No `accelerated` claim is made anywhere in this slice for any platform.

## Exact commands and observed results

All run from `/home/node/trees/issue-229` on branch `psyche/issue-229-gpu-slice4-evidence`
(based on `origin/main` = `f323879`, fast-forwarded mid-task from `63667f3` to keep the PR base
current; re-verified after the fast-forward).

| Command | Observed result |
| --- | --- |
| `npx pnpm install --frozen-lockfile` | exit 0 (locked dependency install, no lockfile change) |
| `npx pnpm exec vitest --run __tests__/gpuSlice4ReportMerge.test.ts` | `Test Files 1 passed (1)`, `Tests 37 passed (37)` |
| `npx pnpm exec tsc --noEmit` | exit 0 (src tree clean) |
| `npx pnpm exec tsc -p tsconfig.test.json --noEmit` | exit 0 (test tree typechecked) |
| `git diff --check` | exit 0, no output (whitespace clean) |
| `npx pnpm test` (full portable suite, with my change) | 10 failed files / 56 failed tests, 4824 passed (330 files) |
| `npx pnpm test` (baseline, same command after `git stash -u`) | same 10 failed files / same 56 failed tests, 4787 passed (329 files) |

Baseline comparison: the 56 failures are pre-existing and environmental — they occur identically
without my change (my diff adds exactly 37 passing tests and zero failures). Failure clusters:
`__tests__/daemon/*` and `spawnPromptTransport` (tmux/PTY-dependent), `macosBuildChannels`,
`processIdentity`, `runProcess` descendant-pipe timeout — none touch `src/gpu/` or this slice's
files. Not fixed here (out of slice; not caused by it).

## Test counts

- New tests: 37 passed, 0 failed (`__tests__/gpuSlice4ReportMerge.test.ts`).
- Full suite delta vs baseline: +37 passed, ±0 failed.

## Exact head SHA

- Deliverable commit: `438da065950e5069d00aad894b81ccfa3c9843e6` (all four files).
- Final branch head: the commit recording this note plus the PR head — the
  authoritative exact-head value is the head SHA shown on the fork PR for
  `psyche/issue-229-gpu-slice4-evidence`.

## Proof gaps (honest)

- **No physical GPU evidence.** Nothing here was executed on macOS/Windows/Linux physical
  hardware. No `accelerated` claim is made for any platform. Physical evidence belongs to the
  verification matrix (#232) and remains an explicit open gap for the epic.
- **No hosted-CI substitute claims.** Fork CI validates types/tests on virtualized runners only.
- **No Rust proof.** This host has no cargo/rust; native diagnostics code is out of this slice's
  scope anyway.
- **No tmux-dependent runs.** `scripts/agent-bootstrap` / `scripts/agent-check` were not run
  (runbook forbids: host has no tmux); full-suite failures above are the documented consequence.
- **Stress mode not executed.** The 1/6/12/24 boundary is specified and unit-tested at the
  contract level only; no terminal was spawned.

## Rollback

Revert the single commit on this branch (`git revert <head-sha>`) or delete the branch. All
changes are additive new files; no existing file, schema, or behavior is modified, so rollback is
complete and side-effect-free.

## Security and privacy

- No credentials, tokens, private keys, raw prompts, unrestricted terminal output, private repo
  contents, environment dumps, private URLs, or unredacted personal paths were placed in any file,
  PR, or comment. Fixture strings in tests are synthetic renderer identity examples (public
  ANGLE/Mesa/SwiftShader formats), not host data.
- No generated outputs were touched (`generated-agents-doc.ts`, desktop web bundles, Xcode
  project, `dist/**`).
