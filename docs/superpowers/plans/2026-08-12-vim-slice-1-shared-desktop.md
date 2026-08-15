# Vim Slice 1: Shared Contract and Desktop Reference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the versioned Vim semantic core, opt-in settings, terminal-safe desktop chrome mode, and practical CodeMirror Vim editing.

**Architecture:** A new workspace package owns pure key normalization plus chrome/editor state machines. Desktop bundles a thin adapter that maps semantic actions onto existing xterm, pane, rail, dialog, save, and close seams; raw terminal input remains unchanged outside explicit chrome mode.

**Tech Stack:** TypeScript, Vitest, esbuild, CodeMirror 6, Tauri web UI, Playwright

**Tracking:** Claim `psyche-no8.1`; parent `psyche-no8`; approved spec `docs/superpowers/specs/2026-08-12-comprehensive-vim-support-design.md`.

---

## File map

- Create `packages/vim-core/package.json`, `tsconfig.json`, and `src/{types,normalize,chrome-machine,editor-machine,index}.ts` — pure contract.
- Create `protocol-fixtures/vim/v1/{chrome,editor}.json` — versioned traces.
- Create `__tests__/{vimContract,vimEditorMachine,tauriVimMode}.test.ts` — contract and desktop behavior.
- Create `native/desktop/psyche-build-tauri/web/vim/vim-entry.ts` — desktop adapter API.
- Modify `pnpm-workspace.yaml`, root and desktop `package.json` — workspace/typecheck/bundle wiring.
- Modify `native/desktop/psyche-build-tauri/web/{main.js,index.html,styles.css,editor/editor-entry.js}` — settings, chrome indicator, action execution, editor transactions.

### Task 1: Define the versioned contract and normalized keys

- [ ] Write `__tests__/vimContract.test.ts` first. Load `chrome.json`; assert `F6` enters `chrome-normal`, `Escape` exits without passthrough, disabled input passes through, `g g` emits `focus.first`, `Ctrl-w h` emits `pane.focus-left`, unsupported prefixes are consumed, and timeout/focus-loss reset pending keys.
- [ ] Run `pnpm vitest --run __tests__/vimContract.test.ts`; verify RED with module-not-found for `@opencoven/psyche-vim-core`.
- [ ] Create the package with these public types and no platform imports:

```ts
export type VimContext = 'disabled' | 'passthrough' | 'chrome-normal' | 'chrome-search' | 'editor';
export type VimDisposition = 'passthrough' | 'pending' | 'action' | 'unsupported';
export interface NormalizedKey { key: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; }
export interface VimResult { disposition: VimDisposition; context: VimContext; pending: string; actions: readonly VimAction[]; }
export type VimAction =
  | { type: 'chrome.enter' | 'chrome.exit' | 'focus.first' | 'focus.last' | 'focus.activate' }
  | { type: 'focus.move'; direction: 'left' | 'down' | 'up' | 'right' }
  | { type: 'pane.focus'; direction: 'left' | 'down' | 'up' | 'right' }
  | { type: 'pane.cycle' | 'pane.equalize' | 'pane.split-horizontal' | 'pane.split-vertical' }
  | { type: 'pane.resize'; direction: 'grow' | 'shrink' | 'narrow' | 'widen' }
  | { type: 'search.open' | 'search.next' | 'search.previous' | 'target.close' | 'target.refresh' | 'help.open' };
```

- [ ] Implement `normalizeKeyboardEvent` and `createChromeMachine({enabled, trigger, timeoutMs, now})`; validate timeout `250..3000`, use an injected clock, and return the original event only with `passthrough`.
- [ ] Add fixture validation that rejects duplicate IDs, unknown actions/contexts, absent dispositions, and sequences longer than 32 tokens. Run the focused test to GREEN.
- [ ] Add `packages/vim-core` to `pnpm-workspace.yaml`; declare `@opencoven/psyche-vim-core: workspace:*` in the root and desktop packages; add the package `typecheck` script; and prepend `pnpm --filter @opencoven/psyche-vim-core typecheck` to root `typecheck`. Commit: `Add versioned Vim input contract`.

### Task 2: Build practical editor semantics in the pure core

- [ ] Write `__tests__/vimEditorMachine.test.ts` with table-driven RED cases for modes, counts, `dw`, `ciw`, visual/block selection, registers, marks, `.`, macros with recursion limits, Unicode graphemes, `/ n N`, undo grouping, and every approved Ex command/rejection.
- [ ] Define `EditorDocumentPort` and editor actions so the machine never imports CodeMirror:

```ts
export interface EditorDocumentPort {
  text(): string;
  selections(): readonly { anchor: number; head: number }[];
  apply(edit: { from: number; to: number; insert: string; selections: readonly { anchor: number; head: number }[]; history: 'join' | 'new' }): void;
  command(action: 'save' | 'save-all' | 'close' | 'force-close' | 'next-buffer' | 'previous-buffer', argument?: string): Promise<boolean>;
}
```

- [ ] Implement modes and motions first; run only the mode/motion table and verify GREEN before adding operators/text objects.
- [ ] Implement bounded registers (64 entries/1 MiB total), marks, search, macro recording (10,000 emitted actions, depth 16), repeat, and Ex history (100 entries/64 KiB). Unknown Ex commands return an inline error action and never invoke a shell.
- [ ] Run `pnpm vitest --run __tests__/vimEditorMachine.test.ts`; verify all tables GREEN and `pnpm --filter @opencoven/psyche-vim-core typecheck` passes. Commit: `Add practical Vim editor state machine`.

### Task 3: Adapt the embedded CodeMirror editor

- [ ] Add failing behavioral cases to `__tests__/tauriWorkspaceEditorIntegration.test.ts`: enabling Vim creates one buffer-local adapter; `2dw`, visual block edit, undo, `:w`, dirty `:q`, `:q!`, and buffer navigation act through real CodeMirror state and existing save/guard callbacks.
- [ ] Run `pnpm vitest --run __tests__/tauriWorkspaceEditorIntegration.test.ts`; verify RED because `vimEnabled` and `dispatchVimKey` do not exist.
- [ ] Extend `createFileEditor` with `setVimEnabled`, `dispatchVimKey`, `vimStatus`, and callbacks `onVimCommand`/`onVimStatus`. Implement `EditorDocumentPort.apply` with CodeMirror transactions and preserve existing change/selection listeners.
- [ ] Wire editor commands in `main.js` to `saveFile`, `guardDirtyFile`, `closeFileTab`, and `activateFileTab`; never bypass read-only/truncated/binary checks.
- [ ] Rebuild with `pnpm --filter psyche-build-tauri build:web`; run editor integration and bundle-freshness tests. Commit generated `editor.bundle.js` with source: `Add Vim editing to workspace files`.

### Task 4: Add opt-in desktop chrome navigation and terminal fidelity

- [ ] Write `__tests__/tauriVimMode.test.ts` with a DOM/xterm harness proving disabled behavior is identical, `F6` sends no PTY bytes, chrome keys execute semantic actions, `Esc` sends no PTY byte and restores focus, paste/IME/mouse events remain opaque, modal/text-input precedence wins, and stale targets fail closed.
- [ ] Run it RED. Then create `web/vim/vim-entry.ts` exporting `createDesktopVimController({machine, capabilities, execute, status})` and add a `PsycheVim` esbuild target plus `<script nonce ... src="vim.bundle.js">`.
- [ ] Add `vimModeEnabled`, `vimChromeTrigger`, `vimSequenceTimeoutMs`, `vimRelativeLineNumbers`, and `vimClipboard` to the existing `psyche.tauri.settings.v1` sanitizer with the approved defaults/clamps. Add an opt-in settings UI; disabling resets state immediately.
- [ ] Add a persistent accessible `CHROME`/editor-mode indicator and capability-based executors for the approved focus, search, pane, guarded close, retry/refresh, and help actions. Reuse existing pane/layout/rail/dialog functions.
- [ ] Run `pnpm vitest --run __tests__/vimContract.test.ts __tests__/vimEditorMachine.test.ts __tests__/tauriVimMode.test.ts __tests__/tauriWorkspaceEditorIntegration.test.ts __tests__/tauriWebBundles.test.ts`, `pnpm typecheck`, `pnpm --filter psyche-build-tauri build:web`, and `git diff --check`.
- [ ] Run Playwright smoke against the served desktop web app for terminal passthrough, F6 enter/Escape exit, pane navigation, dirty close, editor `dw`, IME composition, and accessible indicator. Commit: `Add opt-in Vim chrome mode to desktop`.

### Task 5: Review and close the desktop slice

- [ ] Run `pnpm test`, `pnpm typecheck`, `pnpm build`, Rust fmt/check/test under `native/desktop/psyche-build-tauri/src-tauri`, and `git diff --check`.
- [ ] Run real `vim` and `nvim` smoke sessions inside xterm and nested tmux; record exact versions and byte-fidelity evidence in the Bead.
- [ ] Obtain independent spec review, then code-quality review; fix every Critical/Important finding and re-review.
- [ ] Close `psyche-no8.1` only with exact commands/results and documented interactive proof gaps.
