# Working record — issue 223: Vim Slice 1, shared contract and desktop reference

**Issue:** [OpenCoven/psyche-build#223](https://github.com/OpenCoven/psyche-build/issues/223) — `[psyche-no8.1]` Vim Slice 1: shared contract and desktop reference (P2, Bead `psyche-no8.1`)
**Canonical outcome:** gh-246 (post-release Vim/keyboard-mode parity train; parent Bead `psyche-no8`, gh-222)
**Branch:** `psyche/issue-223-vim-slice1-shared-core` (rebased fast-forward onto `origin/main` at `f12b753` before work started)
**Implementation head:** `bbb1effdde69ca18aeaff767eafd484548f3b27f` (`feat(vim): versioned v1 fixture set, fail-closed loader, and desktop reference contract (#223)`)
**Risk class:** R1 — documentation and isolated tests (additive fixtures, a new loader module consumed only by its own tests on `main`, and contract docs; no product behavior path changed; the single permitted barrel-export line in `packages/vim-core/src/index.ts` is noted below)

## Outcome

An earlier isolated implementation of this slice (branch `design/comprehensive-vim-support` in a since-deleted external worktree) is not recoverable; this slice was rebuilt fresh from `main`. The shared core (`packages/vim-core`) already on `main` was inspected and left semantically untouched; this slice adds the versioned fixture data, a fail-closed loader, and the desktop reference contract:

1. **`packages/vim-core/fixtures/v1/`** — deterministic semantic-op fixture set, all at version `vim/v1` (the single shared fixture version, matching `protocol-fixtures/vim/v1/chrome.json` and #227's `VIM_ACCEPTANCE_FIXTURE_VERSION` contract):
   - `chrome-navigation.json` — 28 chrome traces in the existing core fixture schema (`validateVimFixtures`-compatible): F6 enter, `Esc` exit, focus move/first/last/activate, `Ctrl-w` pane focus/cycle/split/equalize/resize, chrome search open/next/previous, target close/refresh, help, disabled passthrough, unrelated-key passthrough, unsupported-key consumption.
   - `motions.json` — 32 editor traces: `h`/`l`/`j`/`k` with clamping, counts, `0`/`^`/`$`, `w`/`b`/`e` incl. line wrap, `gg`/`G` with counts, `f`/`F`/`t`/`T`, `%` both directions plus no-match consumption, `{`/`}`, and unsupported-modified-key consumption.
   - `edits.json` — 18 editor traces: `dw`, `ciw`, `yy`, `yw`+`p`, `o`, insert/replace sessions with counts (`3i`, `R`), visual character/line/block deletes (`Ctrl-v j d`), `J`, `>>`, `g~w`, undo through the document port, `.` repeat, Unicode committed text (`œ` via IME `kind: "text"`), `dl`.
   - `search.json` — 8 editor traces: `/`+Enter, `?`+Enter, `n`, `N` direction inversion, `*` whole word, `No previous search` error, unsupported and invalid pattern fail-closed errors.
   - `ex-commands.json` — 16 editor traces typed through the real command-line flow: `:w`, `:wq`, `:q`, `:%s` global/first-per-line/confirm-through-port, `:set number`, `:b main`, `:2` goto, `:noh`, and every rejection (shell, pipes, `:g`, filesystem args, `:source`, unknown command).
   - `README.md` — format, bounds, per-platform consumption contract (desktop/web/Ink/iOS), and the versioning policy (additive traces allowed in v1; expectation changes bump the version everywhere in one reviewed change).
2. **`packages/vim-core/src/fixtureLoader.ts`** — typed, platform-pure (no node/browser imports) fixture loader: `VIM_FIXTURE_VERSION` (`'vim/v1'`), `parseVimFixtureDocument` (dispatches on the optional `kind` field to the chrome schema via the existing core validator plus document-level strict field checks, or the new editor schema), `validateEditorFixtures`, and `validateVimFixtureSet` (cross-document trace-id uniqueness). Strict and fail-closed: unknown fields rejected at document/trace/expected/input/action level, unsupported versions rejected, bounded trace/input/text/action/register/mark counts and lengths, integer range checks on cursors/positions, control-character rejection in key tokens, malformed JSON rejected with a typed error. Consuming hosts own the IO (fs in tests/node, bundled or embedded JSON elsewhere), keeping the package's "no platform imports" property intact.
3. **Focused tests** (repo convention: root `__tests__/vim*.test.ts`, vitest):
   - `__tests__/vimFixtureLoaderV1.test.ts` — 10 tests: set integrity, version alignment, id uniqueness, and adversarial fail-closed cases (malformed JSON, wrong version, unknown kind, unknown fields at every level, duplicate ids, out-of-range cursors, oversized texts, invalid input tokens, invalid expectations/actions/registers/marks, chrome drift).
   - `__tests__/vimFixturesV1Conformance.test.ts` — 3 tests: validates the whole set, replays all 28 chrome traces through the real `createChromeMachine` (with the passthrough-event contract asserted), and replays all 74 editor traces through the real `createEditorMachine` against a deterministic `EditorDocumentPort` whose `undo` restores the pre-transaction snapshot — asserting exact mode/pending/count/text/cursor/actions/search/registers/marks per trace.
4. **`docs/vim/DESKTOP-REFERENCE-ADAPTER.md`** — the terminal-safe desktop chrome adapter contract: pure-core/thin-adapter split; byte-exact terminal passthrough outside chrome mode (unchanged `term.onData -> sendToThread -> pty_write` route; the only two exceptions — trigger observation and consumed chrome keys — both bounded; no synthesized `Esc` byte on exit); the F6 chrome navigation seam (`createChromeMachine` options mapped to the planned `vimModeEnabled`/`vimChromeTrigger`/`vimSequenceTimeoutMs` settings, action→executor table over existing desktop seams, capability-checked stale targets); the embedded-editor (CodeMirror) practical parity matrix with fixture evidence per row and explicit out-of-scope boundaries; and how desktop acceptance will be recorded (status vocabulary, evidence discipline, item list, Playwright coverage, real-editor smoke recording, gap handling — aligned with #227's acceptance contract).
5. **Barrel export (permitted exception, noted per task constraint):** one single-line export added to `packages/vim-core/src/index.ts` exporting the loader's public API (`VIM_FIXTURE_VERSION`, `parseVimFixtureDocument`, `validateEditorFixtures`, `validateVimFixtureSet` + types). Without it the loader is unusable outside the package. No other barrel, no `src/index.ts` at repo root, no `package.json`/lockfile/generated files touched.

## Scope and boundaries

- **Additive only.** The only modified pre-existing file is `packages/vim-core/src/index.ts` (the single noted export line). The core machines, validators, and all 293 pre-existing Vim tests are untouched and pass.
- The desktop adapter implementation (executor wiring, settings keys, indicator, CodeMirror port, Playwright specs) is **not** in this slice's deliverable set and is claimed nowhere; the doc defines its contract. Real `vim`/`nvim`/tmux smokes have no executable surface in this environment and are prescribed, not executed.
- Did **not** duplicate #227's artifacts: `docs/vim/ACCEPTANCE-MATRIX.md` and `src/vim/acceptanceManifest.ts` do not exist on `main` (they land with that slice); they were read from `fork/psyche/issue-227-vim-acceptance-docs` via `git show` for alignment only (item ids, fixture-version rule, status vocabulary). `protocol-fixtures/vim/v1/chrome.json` was left as-is; the package fixture set references it as the version anchor rather than replacing it.
- No edits to `.github/**`, `.beads/**`, `pnpm-lock.yaml`, `package.json`, `docs/ROADMAP.md`, `docs/SUPPORT-MATRIX.md`, generated outputs, or other agents' files.

## Exact commands and observed results

All commands run from `/home/node/trees/issue-223` on branch `psyche/issue-223-vim-slice1-shared-core` (Node v24, pnpm 10.34.5 via `npx pnpm`):

| Command | Observed result |
| --- | --- |
| `npx pnpm install --frozen-lockfile` | exit 0 — `Done in 461ms` (typescript 7.0.2, vite 8.2.1, vitest 4.1.10 present) |
| `npx pnpm exec vitest --run __tests__/vimFixtureLoaderV1.test.ts __tests__/vimFixturesV1Conformance.test.ts` | exit 0 — **13 passed (13)**, 2 files (10 loader + 3 conformance) |
| `npx pnpm exec vitest --run` (10 files: the two new suites plus all 8 pre-existing `vim*.test.ts` suites) | exit 0 — **306 passed (306)**, 10 files (13 new + 293 pre-existing) |
| `npx pnpm exec tsc --noEmit` (repo root) | exit 0 — no output (clean) |
| `npx pnpm exec tsc --noEmit` (in `packages/vim-core`, the package's own `typecheck` script command) | exit 0 — no output (clean) |
| `npx pnpm exec tsc -p tsconfig.test.json --noEmit` | exit 0 — no output (clean) |
| `git diff --check` | exit 0 — no output (no whitespace/conflict markers) |

Fixture-development honesty note: three hand-computed expectations were corrected during bring-up after replaying against the approved core machines (each verified against machine semantics by reading the core source, not by snapshotting output): `motion-j-down` column mapping (cursor column 1 lands on column 1 of the next line, position 7), `edit-repeat-last-change-dot` given a two-word vs three-word document, and the visual-block register join (`a\nc` — block rows join with newlines in the register). One fixture trace was corrected for a schema detail: this core's substitute requires the trailing `/` (three-part `s/pattern/replacement/flags`), so `:s/alpha/omega/` (empty flags) is the first-match-per-line fixture.

## Test counts

- New: 13 tests (10 `vimFixtureLoaderV1.test.ts` + 3 `vimFixturesV1Conformance.test.ts` replaying 102 fixture traces: 28 chrome + 74 editor).
- Pre-existing Vim suites still green: 293 tests across 8 files.
- Focused battery total: 306 passed, 0 failed.

## Proof gaps

- **Desktop adapter behavior:** not implemented in this slice — the contract doc, fixtures, and loader are the deliverable; no browser/e2e/Playwright proof exists or is claimed.
- **Real-editor smokes (vim/nvim/tmux):** not run — this host has no tmux, no Rust toolchain, and no product build; recorded as prescribed-but-not-executed in the contract doc, consistent with the #227 protocol.
- **iOS/Rust/macOS evidence:** none; out of scope for this slice and unavailable on this host.
- **CI:** cross-platform verification is supplied by the fork's GitHub Actions `pull_request` runs; results are recorded on the PR, not here.

## Rollback

Single revert of the implementation commit `bbb1effdde69ca18aeaff767eafd484548f3b27f` (or deletion of the five new fixture JSON files, `README.md`, `src/fixtureLoader.ts`, the two test files, `docs/vim/DESKTOP-REFERENCE-ADAPTER.md`, and the one export line in `packages/vim-core/src/index.ts`) restores the prior tree exactly; no data migrations, generated outputs, or shared state are involved. The record commit itself is documentation-only.
