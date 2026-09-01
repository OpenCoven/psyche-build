# Working record — issue 223: Vim Slice 1, shared contract and desktop reference

**Issue:** [OpenCoven/psyche-build#223](https://github.com/OpenCoven/psyche-build/issues/223) — `[psyche-no8.1]` Vim Slice 1: shared contract and desktop reference (P2, Bead `psyche-no8.1`)
**Canonical outcome:** gh-246 (post-release Vim/keyboard-mode parity train; parent Bead `psyche-no8`, gh-222)
**Source PR:** [#299](https://github.com/OpenCoven/psyche-build/pull/299), head `648146b426c39eea045e14964eeb6594ee1575a0`
**Replacement branch:** `maint/pr299-vim-fixtures-v1`, with current `origin/main` merged without rebasing
**Risk class:** R3 — the change establishes a cross-language protocol fixture root and fail-closed parser contract, even though no product action path changes

## Outcome

An earlier isolated implementation of this slice (branch `design/comprehensive-vim-support` in a since-deleted external worktree) is not recoverable; this slice was rebuilt fresh from `main`. The shared core (`packages/vim-core`) already on `main` was inspected and left semantically untouched; this slice adds the versioned fixture data, a fail-closed loader, and the desktop reference contract:

1. **`protocol-fixtures/vim/v1/`** — the sole cross-language canonical root for the deterministic semantic-op fixture set, all at version `vim/v1`:
   - `chrome.json` — expands the existing canonical document to 28 chrome traces in the existing core fixture schema (`validateVimFixtures`-compatible): F6 enter, `Esc` exit, focus move/first/last/activate, `Ctrl-w` pane focus/cycle/split/equalize/resize, chrome search open/next/previous, target close/refresh, help, disabled passthrough, unrelated-key passthrough, unsupported-key consumption.
   - `motions.json` — 32 editor traces: `h`/`l`/`j`/`k` with clamping, counts, `0`/`^`/`$`, `w`/`b`/`e` incl. line wrap, `gg`/`G` with counts, `f`/`F`/`t`/`T`, `%` both directions plus no-match consumption, `{`/`}`, and unsupported-modified-key consumption.
   - `edits.json` — 18 editor traces: `dw`, `ciw`, `yy`, `yw`+`p`, `o`, insert/replace sessions with counts (`3i`, `R`), visual character/line/block deletes (`Ctrl-v j d`), `J`, `>>`, `g~w`, undo through the document port, `.` repeat, Unicode committed text (`œ` via IME `kind: "text"`), `dl`.
   - `search.json` — 8 editor traces: `/`+Enter, `?`+Enter, `n`, `N` direction inversion, `*` whole word, `No previous search` error, unsupported and invalid pattern fail-closed errors.
   - `ex-commands.json` — 16 editor traces typed through the real command-line flow: `:w`, `:wq`, `:q`, `:%s` global/first-per-line/confirm-through-port, `:set number`, `:b main`, `:2` goto, `:noh`, and every rejection (shell, pipes, `:g`, filesystem args, `:source`, unknown command).
   - `README.md` — protocol ownership, format, bounds, per-platform consumption contract (desktop/web/Ink/iOS), and the versioning policy (additive traces allowed in v1; expectation changes create a coordinated `protocol-fixtures/vim/v2/` contract).
2. **`packages/vim-core/src/fixtureLoader.ts`** — typed, platform-pure (no node/browser imports) fixture parser: `VIM_FIXTURE_VERSION` (`'vim/v1'`), `parseVimFixtureDocument` (dispatches on the optional `kind` field to the chrome schema via the existing core validator plus strict nested shape checks, or the editor schema), `validateEditorFixtures`, and `validateVimFixtureSet` (cross-document trace-id uniqueness). Strict and fail-closed: unknown fields rejected at document/trace/expected/input/action level, unsupported versions rejected, bounded trace/input/text/action/register/mark counts and lengths, integer range checks on cursors/positions, control-character rejection in key tokens, malformed JSON rejected with a typed error. Consuming hosts own the IO and load bytes from the protocol root (fs in tests/node, bundled or embedded JSON elsewhere), keeping the package's "no platform imports" property intact.
3. **Focused tests** (repo convention: root `__tests__/vim*.test.ts`, vitest):
   - `__tests__/vimFixtureLoaderV1.test.ts` — 12 tests: canonical-root and no-copy ownership, set integrity, version alignment, id uniqueness, UTF-8 source-byte bounds, and adversarial fail-closed cases (malformed JSON, wrong version, unknown kind, unknown fields at every level, duplicate ids, out-of-range cursors, oversized texts, invalid input tokens, invalid expectations/actions/registers/marks, chrome drift).
   - `__tests__/vimFixturesV1Conformance.test.ts` — 3 tests: validates the whole set, replays all 28 chrome traces through the real `createChromeMachine` (with the passthrough-event contract asserted), and replays all 74 editor traces through the real `createEditorMachine` against a deterministic `EditorDocumentPort` whose `undo` restores the pre-transaction snapshot — asserting exact mode/pending/count/text/cursor/actions/search/registers/marks per trace.
4. **`docs/vim/DESKTOP-REFERENCE-ADAPTER.md`** — the terminal-safe desktop chrome adapter contract: pure-core/thin-adapter split; byte-exact terminal passthrough outside chrome mode (unchanged `term.onData -> sendToThread -> pty_write` route; the only two exceptions — trigger observation and consumed chrome keys — both bounded; no synthesized `Esc` byte on exit); the F6 chrome navigation seam (`createChromeMachine` options mapped to the planned `vimModeEnabled`/`vimChromeTrigger`/`vimSequenceTimeoutMs` settings, action→executor table over existing desktop seams, capability-checked stale targets); the embedded-editor (CodeMirror) practical parity matrix with fixture evidence per row and explicit out-of-scope boundaries; and how desktop acceptance will be recorded (status vocabulary, evidence discipline, item list, Playwright coverage, real-editor smoke recording, gap handling — aligned with #227's acceptance contract).
5. **Barrel export (permitted exception, noted per task constraint):** one single-line export added to `packages/vim-core/src/index.ts` exporting the loader's public API (`VIM_FIXTURE_VERSION`, `parseVimFixtureDocument`, `validateEditorFixtures`, `validateVimFixtureSet` + types). Without it the loader is unusable outside the package. No other barrel, no `src/index.ts` at repo root, no `package.json`/lockfile/generated files touched.

## Scope and boundaries

- The existing canonical `protocol-fixtures/vim/v1/chrome.json` is expanded additively; editor documents and the fixture README are added beside it. No package-local fixture copy remains.
- The core machines remain semantically untouched. The loader and barrel export are package code, while fixture ownership stays at the repository protocol boundary.
- The desktop adapter implementation (executor wiring, settings keys, indicator, CodeMirror port, Playwright specs) is **not** in this slice's deliverable set and is claimed nowhere; the doc defines its contract. Real `vim`/`nvim`/tmux smokes have no executable surface in this environment and are prescribed, not executed.
- Did **not** duplicate #227's artifacts: `docs/vim/ACCEPTANCE-MATRIX.md` and `src/vim/acceptanceManifest.ts` do not exist on `main`; references remain explicitly prospective. The expanded canonical fixture root is ready for those later consumers without inventing a package-owned source.
- No edits to `.github/**`, `.beads/**`, `pnpm-lock.yaml`, `package.json`, `docs/ROADMAP.md`, `docs/SUPPORT-MATRIX.md`, generated outputs, or other agents' files.

## Exact commands and observed results

Commands were run in the isolated replacement worktree with the repository-pinned
pnpm 10.34.5 selected through Corepack:

| Command | Observed result |
| --- | --- |
| `pnpm exec vitest --run __tests__/vimFixtureLoaderV1.test.ts __tests__/vimFixturesV1Conformance.test.ts __tests__/vimContract.test.ts` before the move | exit 1 with the expected missing canonical editor fixtures, incomplete canonical chrome corpus, remaining package-local copy, and nested chrome-field acceptance |
| Same focused command after implementation | exit 0 — **58 passed**, 3 files |
| `pnpm exec vitest --run __tests__/vim*.test.ts` | exit 0 — **333 passed**, 10 files |
| `pnpm --filter @opencoven/psyche-vim-core typecheck && pnpm exec tsc --noEmit && pnpm run typecheck:tests && git diff --check` | exit 0 |
| `pnpm fixtures:generate` plus `git diff --exit-code` over its four explicit bridge outputs | exit 0 — generated bridge JSON remained byte-identical and the hand-authored `vim/v1/` subtree remained outside generator ownership |
| Focused bridge/workspace fixture contract suites | exit 0 — **133 passed**, 3 files |
| `bash ./scripts/agent-check fast` with pinned pnpm | exit 0 |
| Remaining `agent-check full` stages (`docs:focus:check`, docs build, typecheck, smoke, smoke:pack, desktop `build:web`, Rust fmt/test/check) | exit 0 |
| `bash ./scripts/agent-check full` | attempted repeatedly; the all-in-one unit phase did not complete because unrelated timing-sensitive control, macOS build-channel, desktop scan, and spawn-transport tests intermittently timed out under aggregate load |
| Isolated rerun of `__tests__/daemon/spawnPromptTransport.test.ts` | exit 0 — **29 passed** |
| Isolated rerun of `controlCredentials`, `macosBuildChannels`, and `tauriDesktopPlatform` suites | exit 0 — **191 passed** |

Fixture-development honesty note: three hand-computed expectations were corrected during bring-up after replaying against the approved core machines (each verified against machine semantics by reading the core source, not by snapshotting output): `motion-j-down` column mapping (cursor column 1 lands on column 1 of the next line, position 7), `edit-repeat-last-change-dot` given a two-word vs three-word document, and the visual-block register join (`a\nc` — block rows join with newlines in the register). One fixture trace was corrected for a schema detail: this core's substitute requires the trailing `/` (three-part `s/pattern/replacement/flags`), so `:s/alpha/omega/` (empty flags) is the first-match-per-line fixture.

## Test counts

- New fixture suites: 15 tests (12 loader + 3 conformance) replaying 102
  fixture traces: 28 chrome + 74 editor.
- All Vim suites: 333 passed, 0 failed across 10 files.

## Proof gaps

- **Desktop adapter behavior:** not implemented in this slice — the contract doc, fixtures, and loader are the deliverable; no browser/e2e/Playwright proof exists or is claimed.
- **Real-editor smokes (vim/nvim/tmux):** not run because the desktop adapter is
  not implemented in this slice.
- **iOS:** the opt-in pinned simulator gate was not asserted; this change adds
  canonical data for later Swift parity but no Swift consumer.
- **Aggregate full gate:** every non-unit stage passed and every observed
  timing-sensitive failing suite passed in isolation, but one uninterrupted
  `agent-check full` invocation remains blocked by unrelated suite flakiness.
- **CI:** the cross-repository source PR's checks were green at its old head.
  The local replacement commit is intentionally unpushed and therefore has no
  exact-head remote CI.

## Rollback

Revert the replacement commit to restore the prior tree. No data migrations,
generated application bundles, or persisted runtime state are involved.
