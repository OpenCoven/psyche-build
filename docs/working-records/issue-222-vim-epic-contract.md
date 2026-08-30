# Working record — issue-222-vim-epic-contract

- **Issue:** OpenCoven/psyche-build#222 — `[psyche-no8] Comprehensive opt-in Vim support across Psyche` (Bead `psyche-no8`, P2 epic; canonical outcome gh-246)
- **Branch:** `psyche/issue-222-vim-epic-contract` (based on `origin/main` at `f12b753`)
- **Date:** 2026-08-30 (UTC)
- **Host:** Linux x64, Node v24, pnpm 10.34.5 via `npx pnpm`, 12 cores; no tmux, no cargo/rust, no Xcode/iOS tooling, no sudo

## Outcome

Delivered the focused, additive epic-contract slice for the Vim epic:

1. `docs/vim/VIM-EPIC-CHARTER.md` — objective, invariants (opt-in; byte-exact terminal
   passthrough outside explicit chrome mode; host-owned consequential actions routed
   through typed authority paths), the one versioned semantic contract, contract-surface
   ownership map, slice map #223–#227 with acceptance criteria quoted from the beads and
   current status, acceptance-order note (mirrored bead dependency edges are inverted;
   recorded by the 2026-08-30 backlog audit on #222), completion gates, and the
   post-release/gh-246 disposition note.
2. `src/vim/semanticContract.ts` — versioned v1 semantic contract:
   `VIM_SEMANTIC_CONTRACT_VERSION = 1`, fixture version `vim/v1` (identical to #227's
   `VIM_ACCEPTANCE_FIXTURE_VERSION`), typed semantic-op union over seven kinds
   (motion / edit / search / ex / chrome / persistence / accessibility), 13 bounded
   contexts, bounded payload limits, `validateOpFixture()` + `validateOpFixtures()`
   strict fail-closed validators (unknown fields/ops rejected, bounded payloads,
   per-context classification rules, duplicate ids/cases rejected), `chromeModeGuard()`
   classifying every event as `terminal-passthrough` while chrome mode is inactive and
   exposing chrome ops only in active chrome mode, plus `assertChromeOpReachable()`
   fail-closed assertion and `isChromeScopedOp()` type guard.
3. `__tests__/vimSemanticContract.test.ts` — 37 tests covering validator + guard
   behavior, including the three required classes: chrome-mode-off passthrough
   invariant, unknown op rejection, bounded payload rejection.

## Scope and boundaries

- Did **not** touch `packages/psyche-vim-core/**` (#223's), `docs/vim/ACCEPTANCE-MATRIX.md`
  (#227's), `src/vim/acceptanceManifest.ts` (#227's, lives on its own branch),
  `protocol-fixtures/**`, settings schema, or any runtime adapter/entry point.
- No edits to `index.ts`/barrel files, `.github/**`, `.beads/**`, `pnpm-lock.yaml`,
  `package.json` dependencies, `docs/ROADMAP.md`, `docs/SUPPORT-MATRIX.md`.
- No generated outputs touched; no generator run.
- The contract module is intentionally not consumed by any runtime path yet: wiring it
  into adapters is #223–#226 implementation work.
- No Beads or GitHub issue mutations (upstream writes are token-denied for this agent;
  the fork PR pipeline is the status surface).

## Risk class

- [x] **R1 — documentation or isolated tests.** This slice adds one pure, additive TS
      module (no I/O, no runtime consumers), one test file, and two docs files. No
      product behavior, authority, persistence, or transport path is changed. The
      module encodes authority invariants (`route: 'host-authority'`, chrome-mode
      reachability) as types and fail-closed validation only; the slices that wire it
      into product behavior own the corresponding R3 review for their surfaces.

## Verification — exact commands and observed results

All commands run from `/home/node/trees/issue-222` on branch
`psyche/issue-222-vim-epic-contract`:

| Command | Observed result |
| --- | --- |
| `npx pnpm install --frozen-lockfile` | exit 0 — `Done in 752ms using pnpm v10.34.5` |
| `npx pnpm exec vitest --run __tests__/vimSemanticContract.test.ts` | exit 0 — `Test Files 1 passed (1)`, `Tests 37 passed (37)` |
| `npx pnpm exec tsc --noEmit` | exit 0 — no output (clean, full `src` tree) |
| `npx pnpm exec tsc -p tsconfig.test.json --noEmit` | exit 0 — no output (clean, `src` + `__tests__`) |
| `git diff --check` | exit 0 — no output (no whitespace/conflict markers) |

One intermediate test run failed (1/36) during development: my own duplicate-case rule
correctly rejected two fixtures sharing `editor-command-line::<Enter>` in one set; the
test data was split into two sets and all tests then passed. Recorded for honesty; the
final state is the 37/37 run above.

## Test counts

- New tests: **37 passed, 0 failed, 0 skipped** (`__tests__/vimSemanticContract.test.ts`).
- Full repository suite not run locally in this slice (the runbook scope is the new
  test files); CI's Quality gate runs the broader suite on the PR.

## Proof gaps

- **Not run here:** real Vim/Neovim terminal smoke sessions, tmux nested sessions, and
  tmux-dependent repository gates (`scripts/agent-bootstrap`, `scripts/agent-check`) —
  this host has no tmux; the runbook forbids running them. These belong to #227's
  acceptance matrix.
- **Not run here:** iOS/Swift conformance and physical hardware-keyboard evidence —
  no Xcode/iOS tooling on this host; explicitly tracked as a proof gap in the epic
  design and #226/#227.
- **Not run here:** desktop (Tauri/cargo) and browser automation — no cargo/rust on
  this host; CI supplies Linux/macOS/Windows runners for applicable gates.
- **Structural gap (by design):** the contract module has no runtime consumer yet; it
  becomes behavioral evidence only when #223–#226 wire it into their adapters and
  fixtures.
- This working record documents isolated module tests, not a user-path proof.

## Exact head SHA

- Implementation head (code, tests, charter): see `git log` — the implementation
  commit is recorded in the PR body and status comment; this record was finalized in
  the commit immediately after it, and the exact pushed head SHA is stated in the PR
  body, the PR status comment, and the orchestrator report.

## Rollback

- Single revert of the PR (or `git revert` of the implementation commit) removes
  `src/vim/semanticContract.ts`, `__tests__/vimSemanticContract.test.ts`,
  `docs/vim/VIM-EPIC-CHARTER.md`, and this record. No generated outputs, no schema or
  persisted-format changes, no other files touched — revert is clean by construction.
