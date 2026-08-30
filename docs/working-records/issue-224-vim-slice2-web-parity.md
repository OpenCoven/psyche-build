# Working record — issue 224, Vim Slice 2: browser and web parity (contract slice)

- Issue: [OpenCoven/psyche-build#224](https://github.com/OpenCoven/psyche-build/issues/224) — `[psyche-no8.2]` Vim Slice 2: browser and web parity (Bead `psyche-no8.2`, P2; blocked-by-family)
- Canonical outcome: gh-246 (post-release cross-platform Vim track)
- Branch: `psyche/issue-224-vim-slice2-web-parity` (worktree `/home/node/trees/issue-224`, fast-forwarded to `origin/main` at `f12b753` before work)
- Date: 2026-08-30
- Executor: delegated issue agent (fork pipeline per runbook; upstream writes token-denied)

## Outcome

Shipped the web adapter-contract slice — contract-only by design; the Vue browser terminal integration itself is explicitly out of scope (it is owned by the remaining web slice execution, with the composable/indicator/settings design in the dated plan under `docs/superpowers/plans/2026-08-12-vim-slice-2-web.md`):

1. `docs/vim/WEB-PARITY-CONTRACT.md` — how the shared v1 fixture set (`protocol-fixtures/vim/v1/`, `@opencoven/psyche-vim-core`) applies to the Vue browser terminal and dashboard: the one-fixture-version rule (`'vim/v1'` pin, drift fails the gate), the chrome-mode gate rules, the `/api/keys` byte-exactness boundary outside chrome mode (transport enumerated; never replaced, re-encoded, or replayed; the only two bounded exceptions while enabled), chrome navigation mapping, accessible settings/help requirements, state/validation/reset obligations, and the explicit no-change boundary.
2. `frontend/src/vim/webAdapterContract.ts` — versioned (v1) pure TypeScript web adapter-contract module, no runtime imports and no DOM references: `classifyWebKeyEvent()` (key-event → semantic-op classification with the chrome-mode gate: gate OFF ⇒ every event classifies as passthrough carrying the exact original event reference, never a semantic op — including `F6` and `Esc`; gate ON ⇒ only the allowed chrome navigation op set, everything else consumed as `unsupported` and never falling through), `normalizeWebKeyEvent()` (parity with the shared core's normalization), `validateWebAdapterResult()` / `validateWebSemanticOp()` / `validateWebAdapterState()` strict fail-closed validators, `safeWebAdapterState()` (invalid restored state degrades to disabled/default), and `clearWebAdapterPending()` / `resetWebAdapter()` reset-boundary helpers. The op vocabulary is exactly the shared v1 chrome action vocabulary minus `chrome.enter` — entry belongs to the trigger seam (the design resolves the configured trigger before "active chrome mode", mirroring desktop handling `F6` before xterm), so the `chrome-enter-f6` fixture maps to the seam boundary rather than a classification outcome.
3. `__tests__/vimWebAdapterContract.test.ts` — 139 adversarial tests: gate-off passthrough invariant across 34 key classes (printable, symbols, control/alt/meta chords, function keys incl. `F6`, `Esc`, IME/`Process`/`Unidentified`, modifier-only keys) with event-identity (`toBe`) assertions; gate-off never yields an op for keys that are ops when the gate is on; gate-on restricted op set (single keys, `g`-prefix, `Ctrl-w` pane prefixes, scoped search `n`/`N`), `Esc` exit with the gate turning off (including with pending sequences), unsupported consumption (never passthrough, no replayable event, state unchanged), pending reset on unknown keys, type-rejection of 9 malformed event classes and malformed adapter state, shared v1 fixture replay of every `chrome.json` trace with the documented enter-seam boundary, exact op-vocabulary lock against the shared v1 chrome vocabulary, normalization parity with `normalizeKeyboardEvent`, strict validator rejection tables (28 result cases, 13 state cases), safe-state fallback, reset helpers, module purity (no imports/DOM), and `@ts-expect-error` type-level proofs that consumed results can never carry a replayable event and that `chrome.enter` is not a web op.

### Module location note

The task prompt suggested `frontend/vim/webAdapterContract.ts`. The `frontend/` package keeps all sources under `frontend/src/` (see `frontend/src/components/`, `frontend/src/utils/`), so the closest additive location is `frontend/src/vim/webAdapterContract.ts` — same filename, inside the package's source root, where the future composable (`frontend/src/composables/…` per the plan) sits naturally beside it.

### Dependency decision

The module deliberately does not import `@opencoven/psyche-vim-core`: the frontend package's dependencies must not change in this slice (runbook hard rule; `frontend/package.json` lists only `vue`), and the contract stays independently reviewable. Vocabulary alignment is instead enforced by tests (`__tests__/vimWebAdapterContract.test.ts` imports the shared core and asserts normalization parity, fixture replay parity, and the exact op-vocabulary lock), so drift in either direction fails CI.

## Scope and boundaries

- Files created: `frontend/src/vim/webAdapterContract.ts`, `__tests__/vimWebAdapterContract.test.ts`, `docs/vim/WEB-PARITY-CONTRACT.md`, `docs/working-records/issue-224-vim-slice2-web-parity.md`. Nothing else touched: no edits to `frontend/src/components/Terminal.vue`/`Dashboard.vue`, `terminal.ts`, `dashboard.ts`, `styles.css`, `/api/keys` handling (client or server), or native input behavior.
- No collision with sibling slices: #223 owns `packages/vim-core/**` and `protocol-fixtures/vim/**` (read for alignment, not modified); #222 owns the semantic contract; #225/#226 own Ink/iOS adapters; #227 owns `docs/vim/ACCEPTANCE-MATRIX.md` and `src/vim/acceptanceManifest.ts` (its `docs/vim/` directory coexists with this slice's distinct file).
- No edits to `.github/**`, `.beads/**`, `pnpm-lock.yaml`, `package.json` (root or frontend) dependencies, `docs/ROADMAP.md`, `docs/SUPPORT-MATRIX.md`, barrel/index files, or generated outputs.
- No product runtime behavior changed; the module is unreferenced by product code. Nothing touches authority, confirmation, receipt, revocation, idempotency, work preservation, persistence, or recovery behavior.

## Risk class

**R1** — documentation plus an isolated, additive pure module with focused tests. The module classifies events and validates shapes; it holds no authority, performs no I/O, persists nothing, and infers no runtime state. The future Vue integration that consumes it is R2 and will carry its own behavior tests, accessibility assertions, and user-path evidence per AGENTS.md.

## Exact commands and results

All commands run from `/home/node/trees/issue-224` (Node v24.16.0, pnpm 10.34.5, TypeScript 7.0.2, vitest 4.1.10):

| Command | Result |
| --- | --- |
| `git merge --ff-only origin/main` | OK — `a4546f4` → `f12b753` (fast-forward, branch based on current `origin/main`) |
| `npx pnpm install --frozen-lockfile` | OK — "Lockfile is up to date … Done in 760ms" |
| `npx pnpm exec vitest --run __tests__/vimWebAdapterContract.test.ts` | OK — `Test Files 1 passed (1)`, `Tests 139 passed (139)` (after fixing two arrow-linebreak parse errors and a switch-narrowing error found by these runs) |
| `npx pnpm exec vitest --run __tests__/vimContract.test.ts` | OK — `Tests 18 passed (18)` (pre-existing shared-core suite unaffected) |
| `npx pnpm exec tsc --noEmit` | OK — exit 0, no output |
| `npx pnpm exec tsc -p tsconfig.test.json --noEmit` | OK — exit 0, no output (this is the gate that typechecks the new module plus test; it caught one invalid `Record → WebAdapterState` cast, fixed by constructing the validated object) |
| `npx pnpm exec tsc --noEmit --strict --target es2022 --module esnext --moduleResolution bundler --ignoreConfig frontend/src/vim/webAdapterContract.ts` | OK — exit 0 (standalone strict check of the module itself) |
| `git diff --check` / `git diff --cached --check` | OK — exit 0, no output |

One design iteration worth recording: the first draft grouped the three direction-carrying op kinds into one `switch` case when mapping web ops onto shared-core actions in the drift test; TypeScript correctly refused the resulting union-of-pairs, and splitting the cases made each mapping exact.

## Exact head SHA

- Deliverable content (module, tests, contract document; all verification above ran against this tree): committed as the first commit on the branch; the final pushed branch head adds only this working-record commit on top. The exact head SHA cannot be contained in its own commit and is reported in the PR body and status comment (visible via `gh pr view` on the fork).

## Test counts

- New focused suite: 139 tests, 139 passed, 0 failed (`__tests__/vimWebAdapterContract.test.ts`).
- Pre-existing `__tests__/vimContract.test.ts` re-run as a neighbor check: 18 passed, 0 failed.
- Full repository suite and `scripts/agent-check`: **not run here** — see proof gaps.

## Proof gaps

- **Browser runtime verification is a documented gap of this slice.** No Playwright or real-browser run exists: the Vue integration is intentionally not implemented here, so there is no product surface to drive yet. The `keys-transport-unchanged`, `native-text-inputs-unchanged`, and `web-browser-automation` acceptance items remain open and are tracked by #227's acceptance manifest/matrix (all platform items `not-run` there); real Vim/Neovim/tmux smoke on the browser terminal belongs to the integration slice plus #227's smoke protocol.
- **No local tmux; `scripts/agent-bootstrap` and `scripts/agent-check` not run** (runbook: they require tmux, unavailable on this host). Fork CI supplies repository-level checks on the PR.
- **Full repository vitest suite not run locally** — runbook scope is focused verification; the fork's Quality gate runs the repository suite on the PR.
- **No iOS/Xcode or Rust proof** — not applicable to this slice; nothing under `native/**` was touched or claimed.
- **Beads source not directly queried**; scope and acceptance criteria were taken from the generated GitHub mirror body of #224 (read 2026-08-30) and the approved design document.

## Rollback notes

- Revert the branch's two commits (or close the PR without merging) to remove all four files; no generated artifacts, dependencies, shared configs, or other agents' paths are touched, so rollback is clean and complete.
- The module is additive and unreferenced by product code; deleting it cannot affect runtime behavior. The contract document and test gate it only.

## Security and privacy

- No credentials, tokens, private keys, raw prompts, unrestricted terminal output, private repo contents, environment dumps, private URLs, or unredacted personal paths are included in any file, PR, or comment. The contract document enumerates transport shapes (`{ key, ctrlKey, altKey, shiftKey, metaKey }`, bulk `{ text }`) already public in the repository source and explicitly requires the integration to keep keystroke payloads out of diagnostics.
- The contract hardens the failure direction: malformed events/states/results fail closed (`TypeError`) rather than guessing, consumed sequences can never be replayed into `/api/keys` or text inputs, and invalid restored state degrades to disabled/default behavior.
