# Working record — issue 231: in-app developer GPU diagnostics surface

**Issue:** [OpenCoven/psyche-build#231](https://github.com/OpenCoven/psyche-build/issues/231) — `[psyche-z7c.4.5] Expose the in-app developer GPU diagnostics surface` (Bead `psyche-z7c.4.5`, P1, blocked)  
**Branch:** `psyche/issue-231-gpu-diagnostics-surface` (fork PR; exact heads below)  
**Date:** 2026-08-28  
**Risk class:** R1 (documentation + isolated tests; pure additive display contract, no product behavior change, no authority/security surface touched)

## Outcome

Shipped the developer GPU diagnostics surface as one focused, additive slice —
the display contract and its machine-checkable module, per the slice-4 design
plan (Task 5) scoped to this issue:

- `docs/gpu/DIAGNOSTICS-SURFACE-CONTRACT.md` — the development-only titlebar
  action + diagnostics panel contract: fail-closed dev-only authorization;
  only PRESENT graphics/runtime/renderer/transport/frame/process fields shown
  (unsupported rows omitted, never placeholders); prominent software-fallback
  presentation; deterministic JSON copy; scenario controls/progress/
  cancellation only when authorized; accessible status text; startup graphics
  logging independent of the panel; no capability/CSP expansion; transition
  styling restricted to the Slice 3 transform/opacity allowlist.
- `src/gpu/diagnosticsSurface.ts` — versioned (v1) pure TypeScript module:
  `isDiagnosticsAuthorized()` (debug build + exact
  `PSYCHE_RENDER_DIAGNOSTICS`=`'1'` token, no trimming, no default),
  `visibleRowsFor()` (closed 20-field catalog over six groups, returns only
  present/safely-presentable fields with their evidence class
  `reported`/`measured`/`derived`), `diagnosticsJson()` (deterministic,
  recursively key-sorted, name-only capped omission manifests),
  `copyForA11y()` (accessible status text; software fallback is the first
  sentence), `canControlScenarios()` (same authorization seam), and the
  `transform`/`opacity` transition allowlist with filters. No imports, no I/O,
  no DOM, no environment reads — the host passes observed values in.
- `__tests__/gpuDiagnosticsSurface.test.ts` — 51 focused/adversarial tests:
  unauthorized ⇒ no controls (table over debug/token combinations incl.
  padded, wrong, empty, numeric, production-with-token); unsupported rows
  omitted, never placeholders (absent fields, absent groups, non-finite
  numbers, empty/oversize strings and marker lists, out-of-vocabulary
  acceleration); deterministic JSON (byte-identical across calls, deep-equal
  across insertion orders, recursive key-sort, unknown values never
  serialized, omission manifests capped); a11y copy leads with
  `SOFTWARE FALLBACK:` for software acceleration; transition allowlist rejects
  every other property class (`all`, color/geometry/paint families); plus a
  documentation-contract test keeping the contract doc aligned with the
  module.

## Scope and boundaries

In scope: the three files above and this working record. Out of scope and
deliberately not done:

- **Tauri UI panel integration is a documented open gap** (see below): no
  edits to `native/desktop/psyche-build-tauri/web/index.html`, `web/main.js`,
  `web/styles.css`, or the runtime entry path. This slice ships the contract
  module + contract doc + tests that any markup implementation must satisfy;
  the markup/wiring itself is future work and is called out in the contract
  document and the PR.
- **Blocked by #230 (family context only):** the debug-authorized rendering
  stress harness owns stress execution and its native authorization. This
  slice implements neither; `canControlScenarios()` exposes only the panel-side
  gate and the #230 harness re-checks authorization on its own side. No #230
  files were touched or duplicated.
- **#228 (charter), #229 (report merge), #232 (verification matrix):** not
  touched; no overlap — filenames are unique across the family
  (`src/gpu/verificationMatrix.ts` vs `src/gpu/diagnosticsSurface.ts`, etc.).
- No edits to `index.ts`/barrels, `.github/**`, `.beads/**`, `pnpm-lock.yaml`,
  `package.json`, generated outputs, ROADMAP/SUPPORT-MATRIX.
- Upstream OpenCoven writes are token-denied; the pipeline runs on the fork
  `CompleteDotTech/psyche-build` with real CI.

## Exact commands and observed results

All commands run from `/home/node/trees/issue-231` (Node v24, pnpm 10.34.5 via
`npx pnpm`), on top of `origin/main` at `63667f3` (branch was fast-forwarded
from the stale `a4546f4` base before implementation):

| Command | Observed result |
|---|---|
| `git merge --ff-only origin/main` | exit 0 — fast-forwarded `a4546f4` → `63667f3` before any edit |
| `npx pnpm install --frozen-lockfile` | exit 0 — `Done in 758ms using pnpm v10.34.5`; no lockfile changes |
| `npx pnpm exec vitest --run __tests__/gpuDiagnosticsSurface.test.ts` (first run) | exit 1 — 2 failures found and fixed (unknown-group omission-manifest descent; two test expectations that contradicted the intended omit-empty-evidence rule), then re-run |
| `npx pnpm exec vitest --run __tests__/gpuDiagnosticsSurface.test.ts` (final) | exit 0 — `Test Files 1 passed (1)`, `Tests 51 passed (51)` |
| `npx pnpm exec tsc --noEmit` (final) | exit 0 — after fixing one narrowing error (TS2345) the first run found in `copyForA11y` |
| `npx pnpm exec tsc -p tsconfig.test.json --noEmit` (final) | exit 0 |
| `git diff --check` | exit 0 — no whitespace/conflict-marker issues |
| `git status --porcelain=v1 --untracked-files=all` (pre-commit) | exactly the three new files, nothing else |

Test counts: **51 passed, 0 failed** (focused suite; full-repository suite not
run on this host — see gaps). No baseline failures were encountered or masked:
`tsc` on the unmodified tree passed before my files were added, and all
failures observed during the session were in my new files and fixed.

## Exact head SHA

- Parent / base: `63667f3` (`origin/main`, post fast-forward)
- Implementation commit (module + tests + contract doc):
  `da8387ace99739d02539690e4883c5194bd1c6db`
- Final branch head = implementation commit + this working-record commit;
  both SHAs recorded in the PR body.

## Proof gaps (explicit, open)

1. **Tauri UI panel integration: not implemented (documented gap).** No
   titlebar action, panel markup, styles, or runtime wiring exists in this
   slice — only the pure display contract, its documentation, and the tests
   that pin it. The contract doc's "Surface anatomy" section describes the
   intended integration; any implementation must satisfy
   `visibleRowsFor()`/`diagnosticsJson()`/`copyForA11y()`/
   `canControlScenarios()` and the compositor transition audit.
2. **No runtime/browser/desktop evidence on this host.** No tmux, no
   cargo/rust, no Xcode/iOS tooling, no desktop app runtime, no GPU: the
   panel's runtime behavior (titlebar action, rendering, copy-to-clipboard,
   screen-reader output) could not be exercised locally. CI supplies
   Linux/macOS/Windows runners for build/test gates only — per the #232
   matrix, hosted CI never substitutes for physical acceleration evidence
   (and no acceleration claim is made here).
3. **Full-repository test suite not run locally.** Only the focused suite and
   both typechecks ran here; the fork CI Quality job runs the portable suite
   and is the recorded gate for the rest.
4. **#230 blocks this bead.** The stress harness (authorization counterpart
   and controls target) is not landed; this slice is deliverable
   independently and does not wait on it, per the task instruction to deliver
   the slice.
5. **Physical acceleration evidence** belongs to #232's matrix, not this
   slice; none is claimed.

## Rollback notes

Purely additive: revert the branch's commits (or delete the three new files
plus this record) to restore the pre-change tree. No generated outputs, no
existing-file modifications, no schema/persisted-format changes, no dependency
changes. Nothing outside this branch's PR needs rollback.
