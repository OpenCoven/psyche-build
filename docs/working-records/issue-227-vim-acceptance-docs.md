# Working record — issue 227: Vim Slice 5, cross-platform acceptance and documentation

**Issue:** [OpenCoven/psyche-build#227](https://github.com/OpenCoven/psyche-build/issues/227) — `[psyche-no8.5]` Vim Slice 5: cross-platform acceptance and documentation (P2, Bead `psyche-no8.5`)
**Canonical outcome:** gh-246 (post-release Vim/keyboard-mode parity train; parent Bead `psyche-no8`, gh-222)
**Branch:** `psyche/issue-227-vim-acceptance-docs` (based on `origin/main` at `a4546f4`)
**Risk class:** R1 — documentation and isolated tests (no product behavior change; `src/vim/acceptanceManifest.ts` is a new, versioned contract module consumed only by its own tests in this slice)

## Outcome

Define and document the cross-platform Vim acceptance contract so slices
#223–#226 have one fixture-version rule and one bounded checklist to fill per
platform:

1. `docs/vim/ACCEPTANCE-MATRIX.md` — one fixture-version rule across
   desktop/web/Ink/iOS; per-platform acceptance checklists (desktop adapter,
   Vue browser terminal, Ink TUI precedence chain, iOS Swift adapter with F6
   hardware command and accessible software chrome key); real
   Vim/Neovim/tmux smoke protocol; accessibility and performance checks;
   opt-in behavior contract; byte-exact terminal passthrough outside explicit
   chrome mode; physical-device proof-gap recording; final cumulative review
   requirements.
2. `src/vim/acceptanceManifest.ts` — versioned (v1) manifest contract:
   `VIM_ACCEPTANCE_FIXTURE_VERSION` (`'vim/v1'`, aligned with
   `protocol-fixtures/vim/v1/chrome.json` and `packages/vim-core`), platform
   enum (`desktop | web | ink | ios`), required-acceptance-item id catalog per
   platform (15 shared-floor items + platform-specific items),
   `validateAcceptanceManifest()` strict validator (all four platforms
   required, unknown fields rejected at manifest/platform/item level, unknown
   platforms rejected, statuses bounded to `pass | fail | not-run |
   unavailable`, required item coverage with no duplicates/unknowns,
   evidence-for-`pass` and gap-for-`fail`/`not-run`/`unavailable` discipline),
   and `createUnstartedAcceptanceManifest()` producing the honest all-`not-run`
   starting state for later slices to fill per platform.
3. `__tests__/vimAcceptanceManifest.test.ts` — 13 focused adversarial tests.

## Scope and boundaries

- **Dependency noted:** #223–#226 (Vim slices 1–4) are open/blocked-in-flight
  and own all adapter behavior. **No Vim behavior exists on main** — the only
  Vim code is the shared core `packages/vim-core` (pre-existing) and the v1
  chrome fixture; a tree search found no `vim` references in `src/`,
  `frontend/src`, or `native/` product trees other than this slice's new file,
  and no `F6` handling anywhere in product sources. This slice therefore
  implements no editor behavior; the manifest defines what each platform slice
  must later prove.
- `packages/psyche-vim-core` was **not** touched (owned by #223's agent).
  No shared/other-agent files were modified: no `docs/gpu|a11y|mobile|perf|
  review/`, no `src/a11y|mobile|perf|gpu/`, no `.github/**`, no
  `package.json`/`pnpm-lock.yaml`, no barrels/`index.ts`, no generated outputs.
- The doc-coverage test asserts every required item id in
  `REQUIRED_VIM_ACCEPTANCE_ITEMS` appears in `ACCEPTANCE-MATRIX.md`, so the
  item catalog and the human-readable matrix cannot drift silently. A later
  slice adding an item id must update both in the same change.
- Smoke protocol in the matrix is a **prescription, not evidence**: it has not
  been executed on any surface (no adapter exists to drive it).

## Exact commands and observed results

All commands run from `/home/node/trees/issue-227` on branch
`psyche/issue-227-vim-acceptance-docs` (Node v24, pnpm 10.34.5 via `npx pnpm`):

| Command | Observed result |
| --- | --- |
| `npx pnpm install --frozen-lockfile` | exit 0 — `Done in 806ms` (dependencies already satisfied; typescript 7.0.2, vite 8.2.1, vitest 4.1.10 present) |
| `npx pnpm exec vitest --run __tests__/vimAcceptanceManifest.test.ts` | exit 0 — **13 passed (13)**, 1 file |
| `npx pnpm exec vitest --run __tests__/vimAcceptanceManifest.test.ts __tests__/vimContract.test.ts __tests__/vimEditorMachine.test.ts` | exit 0 — **157 passed (157)**, 3 files (my suite plus pre-existing Vim suites to prove no interference) |
| `npx pnpm exec tsc --noEmit` | exit 0 — no output (clean) |
| `npx pnpm exec tsc -p tsconfig.test.json --noEmit` | exit 0 — no output (clean) |
| `git diff --check` | exit 0 — no output (no whitespace/conflict markers) |

One defect was found and fixed during verification before these final runs:
the initial `createUnstartedAcceptanceManifest` used an `Object.fromEntries`
cast that failed `tsc --noEmit` (`TS2352` at `src/vim/acceptanceManifest.ts`);
replaced with an explicit, cast-free per-platform construction. The final
commands above were run after that fix.

No baseline failures were encountered; nothing was stashed or skipped.

## Test counts

- New tests: **13** (all passing).
- Not run here (out of scope for an R1 docs/isolated-test slice; CI on the
  fork runs the full Quality suite on the PR head): full `pnpm test`, `pnpm
  build`, `pnpm smoke`, Playwright suites, Rust fmt/check/test,
  `pnpm ios:project:check`.

## Proof gaps

- **No Vim/Neovim/tmux smoke evidence exists** for any platform — the smoke
  protocol is documented but unexecuted; this host also has no tmux. Recorded
  as a gap, not a pass, per runbook rule 6.
- **No physical-device (iOS hardware keyboard) evidence exists**; the matrix
  defines how such gaps must be recorded (`not-run` vs `unavailable` + gap
  note) and none has been recorded yet because no platform slice has executed
  its checklist.
- **No performance measurements exist**; budgets (p95 dispatch < 8 ms; no
  frame stall > 33.4 ms) are contract targets only.
- **Not run locally:** full repository gate and platform gates (see above);
  CI on the fork supplies Linux runners for the Quality suite. No iOS/Rust
  claims are made.

## Head SHA

- Deliverables commit (implementation + tests + docs + this record):
  `51dfb8a3f8d5d5caa652cce76ef1790450c5a5b9`. Any later commits on this branch
  are record-keeping only; the reviewed content is this commit. The PR head
  SHA is recorded in the PR body and status comment.

## Rollback

The slice is purely additive (3 new files, no existing file modified). Roll
back by reverting the deliverables commit or deleting the branch; no persisted
format, schema, command surface, or security boundary is affected.
