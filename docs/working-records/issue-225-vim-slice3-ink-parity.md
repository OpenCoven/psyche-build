# Working record — issue 225: Vim Slice 3, Ink TUI parity

**Issue:** [OpenCoven/psyche-build#225](https://github.com/OpenCoven/psyche-build/issues/225) — `[psyche-no8.3]` Vim Slice 3: Ink TUI parity (P2, Bead `psyche-no8.3`, blocked-by-family)
**Canonical outcome:** gh-246 (post-release Vim/keyboard-mode parity train; parent Bead `psyche-no8`, gh-222)
**Branch:** `psyche/issue-225-vim-slice3-ink-parity` (based on `origin/main` at `f12b753` after fast-forward from `a4546f4`)
**Risk class:** R1 — contract module, documentation, and isolated tests. No product behavior changes: no existing source file is modified, the new module is imported by its own tests only, and the Ink runtime integration is explicitly deferred to a later reviewed slice (R2 at that point).

## Outcome

Define where and how the shared cross-platform Vim contract (`vim/v1`) attaches at the TOP of the existing Ink input precedence chain, as an executable, deterministic contract model:

1. `docs/vim/INK-PARITY-CONTRACT.md` — the Ink parity contract: attachment point (the single `useInput` chain in `src/hooks/useInputHandling.ts`, one adapter call, no second hook); pre-adapter gates that stay above the adapter (`ignoreInput`, tmux popups, inline rename, colon buffer, prompts, SGR mouse, busy states); reserved Ctrl+C quit confirmation above the chrome gate in every mode; disabled-behavior identity guarantee; F6 chrome mode (default/rebindable trigger, enter/exit, indicator and persistence obligations); scoped search, navigation, guarded actions (`target.close`/`target.refresh` behind existing guards), mode-aware help; the reuse map routing every shared semantic action through existing pane/project/popup/settings/lifecycle paths (no new action paths); accessibility-copy requirements; observation/testing protocol; honest scope boundaries and gaps.
2. `src/vim/inkPrecedence.ts` — versioned (`VIM_INK_PRECEDENCE_VERSION = 1`) pure TS module, no I/O, no clock, no state: `VIM_INK_PRECEDENCE_TABLE` (6 ordered stages: pre-adapter gate → reserved chord → chrome-mode gate → vim semantic ops → existing Ink bindings → terminal passthrough); `resolveKeyForInk()` returning typed outcomes `chrome-op | semantic-op | existing-binding | passthrough | rejected`; disabled mode short-circuits the chrome/semantic stages (identity with enabled-inactive for every key except the claimable trigger); `EXISTING_INK_BINDINGS` (41 entries mirroring the current `useInputHandling` chain in evaluation order, with guards and the existing action path each reuses); `VIM_INK_SEMANTIC_OPS` (27 entries mirroring the shared `vim/v1` chrome machine keymap exactly); `RESERVED_INK_CHORDS`; `DEFAULT_INK_CHROME_TRIGGER` (F6); `isClaimableInkTrigger()`/`validateChromeTriggerForInk()` fail-closed trigger validation (no reserved-chord or existing-binding collisions); fail-closed input validation (`TypeError` on malformed keys/contexts/pending sequences, `rejected` outcome for inconsistent snapshots so a pending key can never fall through to a terminal); tables frozen and self-checked at load.
3. `__tests__/vimInkPrecedence.test.ts` — 192 table-driven tests (detail below).

## Scope and boundaries

- **Contract-only slice.** `src/hooks/useInputHandling.ts`, `src/PsycheApp.tsx`, `src/services/PopupManager.ts`, `src/actions/**`, settings, and all product behavior are untouched. Wiring the adapter into the chain is a later behavior change with its own review and evidence.
- **Sibling slices untouched:** #222 (semantic contract), #223 (shared core fixtures), #224 (web contract), #226 (iOS), #227 (acceptance docs). `packages/vim-core` was not modified. The `VimAction` chrome vocabulary is mirrored (documented in both files) rather than imported, keeping concurrently-owned slices compile-time independent; runtime fixture-version pinning (`VIM_INK_FIXTURE_VERSION === 'vim/v1'`, asserted against `protocol-fixtures/vim/v1/chrome.json`) guards drift.
- **Honest deltas documented, not papered over:** interactive chrome-search query entry and page-move (`Ctrl-u`/`Ctrl-d`) appear in the design prose but not in the shared `vim/v1` machine vocabulary on main; the Ink table contains only actions the shared core can emit, and the contract assigns those gaps to #222/core.
- No edits to `.github/**`, `.beads/**`, `pnpm-lock.yaml`, `package.json`, barrels/`index.ts`, `docs/ROADMAP.md`, `docs/SUPPORT-MATRIX.md`, or any generated output. No Beads or upstream GitHub mutations (upstream writes are token-denied; PR pipeline runs on the fork).

## Exact commands and observed results

All commands run from `/home/node/trees/issue-225` on branch
`psyche/issue-225-vim-slice3-ink-parity` (Node v24, pnpm 10.34.5 via `npx pnpm`):

| Command | Observed result |
| --- | --- |
| `npx pnpm install --frozen-lockfile` | exit 0 — `Done in 828ms` (typescript 7.0.2, vite 8.2.1, vitest 4.1.10 present) |
| `npx pnpm exec vitest --run __tests__/vimInkPrecedence.test.ts` | exit 0 — **192 passed (192)**, 1 file |
| `npx pnpm exec vitest --run __tests__/vimContract.test.ts __tests__/vimEditorMachine.test.ts` | exit 0 — **144 passed (144)**, 2 files (pre-existing Vim core suites; proves no interference) |
| `npx pnpm exec tsc --noEmit` | exit 0 — no output (clean) |
| `npx pnpm exec tsc -p tsconfig.test.json --noEmit` | exit 0 — no output (clean) |
| `git diff --check` | exit 0 — no output (no whitespace/conflict markers) |

Defects found and fixed during verification, before the final runs above:

1. The first authoring pass omitted the `matchesModifierClass` helper (ReferenceError on 138 tests); restored the exact-modifier matcher mirroring the shared core.
2. `tsc --noEmit` flagged `pendingSequence ?? ''` inferring `{}` (`TS2345` at `src/vim/inkPrecedence.ts`); replaced with an explicit string-guard + cast.
3. Four test-design corrections: the disabled/enabled identity properly excludes the claimable trigger (entering chrome mode on trigger press while enabled is intended behavior, now asserted separately); disabled-with-pending must `rejected` (fail-closed) rather than defer; the `?` flip row needed its real shift form; `EXISTING_INK_BINDINGS` needed `Object.freeze`.

No baseline failures were encountered; nothing was stashed or skipped.

## Test counts

- New tests: **192** in `__tests__/vimInkPrecedence.test.ts`, all passing. Coverage: disabled-mode identity over a 49-key matrix × two surface snapshots; chrome gate (enter/exit/rebind/modifier variants/gated/busy/reserved chord/trigger claimability); no-shadowing sweep over all 41 enumerated existing bindings (disabled and enabled) plus 10 explicit flip rows and guarded-fallthrough rows; full 27-entry semantic keymap replay; unknown-key rejection in `chrome-normal`/`chrome-search` and invalid pending continuations; fail-closed validation (8 adversarial `TypeError`/inconsistent cases); determinism (25× repeated resolutions, frozen tables, ordered precedence table, unique binding ids); fixture-version pinning.
- Not run here (out of scope for an R1 contract/isolated-test slice; fork CI runs the full Quality suite on the PR head): full `pnpm test`, `pnpm build`, `pnpm smoke`, Playwright suites, Rust fmt/check/test, `pnpm ios:project:check`.

## Proof gaps

- **No runtime Ink evidence exists.** No chrome-mode session was driven against a built app or the real `useInputHandling` chain; the attachment is specified and modeled, not wired. Recorded as a gap for the integration slice, not a pass.
- **No real-terminal evidence exists** (tmux/Windows Terminal/iTerm chrome-mode smoke, byte-for-byte PTY passthrough under chrome mode); this host has no tmux. The existing terminal-transport suites were not executed here.
- **No accessibility runtime evidence exists** (screen-reader announcement of the `CHROME` indicator); the copy/announcement obligations are specified in the contract only.
- **No independent human review has occurred yet**; the design's independent-review completion gate is not satisfied by this record.
- Not run locally: full repository gate and platform gates (see above); fork CI supplies Linux runners for the Quality suite. No iOS/Rust claims are made.

## Head SHA

- Deliverables commit (module + tests + contract doc + this record): `4e58f7a69e100fe537429afe5a69b7527d351c87`. The record-keeping commit that follows it only fills in this SHA; the reviewed content is the deliverables commit. The PR head SHA is recorded in the PR body and status comment.

## Rollback

The slice is purely additive (3 new files, no existing file modified). Roll back by reverting the deliverables commit or deleting the branch; no persisted format, schema, command surface, or security boundary is affected.
