# Ink TUI Vim parity contract (v1)

- **Issue:** [OpenCoven/psyche-build#225](https://github.com/OpenCoven/psyche-build/issues/225) — "[psyche-no8.3] Vim Slice 3: Ink TUI parity" (Bead `psyche-no8.3`)
- **Parent:** [#222](https://github.com/OpenCoven/psyche-build/issues/222) (shared Vim semantic contract) · **Canonical outcome:** gh-246 · **Design:** [Comprehensive Vim support design](../superpowers/specs/2026-08-12-comprehensive-vim-support-design.md)
- **Shared fixture version:** `vim/v1` (`protocol-fixtures/vim/v1/`) · **Executable model:** [`src/vim/inkPrecedence.ts`](../../src/vim/inkPrecedence.ts) (`VIM_INK_PRECEDENCE_VERSION = 1`) · **Tests:** [`__tests__/vimInkPrecedence.test.ts`](../../__tests__/vimInkPrecedence.test.ts)
- **Status:** contract slice. The Ink runtime integration itself is a later, separate behavior change; this document defines where it must attach and what it must preserve. Beads remains the authoritative tracker; this mirror-language doc is implementation context.

## 1. Where the shared contract attaches

The Ink TUI's entire application input surface is one handler: the `useInput(async (input, key) => …)` chain inside [`src/hooks/useInputHandling.ts`](../../src/hooks/useInputHandling.ts) (invoked from `src/PsycheApp.tsx`). Every existing pane, project, popup, settings, and lifecycle behavior is reachable only through that chain. The shared Vim contract therefore attaches at the **top of that single chain** — as the first decision made by the handler — and nowhere else:

```
Ink useInput delivery
  └─ Vim adapter call: resolveKeyForInk(normalizedKey, snapshot)   ← attachment point (this contract)
       ├─ chrome-op        → perform the chrome-mode transition only
       ├─ semantic-op      → route ONE shared action through existing paths (§5)
       ├─ rejected         → consume the key; status only; NEVER fall through
       ├─ existing-binding → defer: run the existing chain unchanged
       └─ passthrough      → defer: nobody claims the key; focused surface/PTY
                              receives it byte-for-byte via the existing path
```

Rules of attachment:

1. **One attachment point.** The adapter never adds a second `useInput` hook, a second key router, or parallel command implementations. Ink broadcasts input to every active `useInput` subscriber, so a second hook would create an unmodeled precedence surface.
2. **The adapter is a decision, not a mode machine.** Chrome context (`inactive | chrome-normal | chrome-search`) and pending sequence state stay owned by the shared semantic core (`@opencoven/psyche-vim-core` chrome machine, `vim/v1`). The adapter feeds `resolveKeyForInk` a snapshot and obeys the outcome; pending expiry (250–3000 ms, default 1000) is the core machine's clock concern, deliberately not modeled here.
3. **Normalized keys.** The adapter converts Ink's `(input, key)` pair to the `VimInkKey` shape before resolving: printable characters lowercase (`'G'` → key `'g'`, `shift: true`), `key.return` → `'Enter'`, `key.escape` → `'Escape'`, `key.upArrow/downArrow/leftArrow/rightArrow` → `'ArrowUp'/'ArrowDown'/'ArrowLeft'/'ArrowRight'`, and `key.ctrl/alt/shift/meta` verbatim. This is the same normalization the shared core performs.
4. **Contract module is pure.** `src/vim/inkPrecedence.ts` does no I/O, reads no clock, keeps no state, and imports nothing from Ink, React, tmux, PTY, or the terminal. Same inputs → same frozen outcome, always.

### Pre-adapter gates that stay above the adapter

The design's platform precedence (reserved system commands → native modals → IME/text controls → chrome trigger → chrome mode → existing shortcuts → passthrough) maps onto Ink as follows. The following existing states keep owning input **before** the adapter runs; the adapter must pass `surface.inputGated: true` (or `busy: true`) for them, and chrome mode must not be entered, continued, or exited while they are active:

| Existing Ink state | Where it lives today |
| --- | --- |
| `ignoreInput` cooldown (popup operations, buffered-key suppression) | `useInputHandling` first gate; PsycheApp already folds in the hooks prompt and pair banner |
| Active tmux popups (settings, logs, shortcuts, menus — separate processes) | `PopupManager` + `INPUT_IGNORE_DELAY` |
| Inline rename text entry | `handleInlineRenameInput` |
| Colon-command buffer (`:pair`, `:devices`) once entered | `colonBufferRef` |
| Prompts: quit-confirm, file-copy, command, hooks prompt | dedicated branches / dedicated `useInput` in `PsycheApp` |
| SGR mouse report sequences | consumed before bindings (would otherwise leak into rename input) |
| Busy states: `isCreatingPane`, `runningCommand`, `isUpdating`, `isLoading` | swallow-all gate mid-chain |

While any of these is active the resolver answers `existing-binding` with binding id `chain.input-gate` — even for the chrome trigger, and even inside chrome mode. The adapter must additionally reset the core machine's pending state on every modal opening, consistent with the design's reset rules (Esc, timeout, focus loss, modal opening, workspace/window replacement, mode disable, adapter disposal).

### Reserved lifecycle chord

**Ctrl+C quit confirmation is above the chrome gate in every mode** (`lifecycle.quit-confirm` → existing two-press confirm → `cleanExit()`). Chrome mode can never bypass lifecycle, confirmation, dirty-file, authorization, close, save, or merge gates — chrome-mode requests for guarded behavior are routed into the same guards as today, and unknown chrome keys are consumed (`rejected`) rather than allowed to leak. `validateChromeTriggerForInk` also fails closed if a persisted trigger collides with a reserved chord or with any enumerated existing binding; a misconfigured setting falls back to the default trigger/disabled behavior instead of stealing a shortcut.

## 2. Disabled behavior is unchanged (identity guarantee)

With `vimModeEnabled: false`:

- stages 3–4 of the precedence table never run; the resolver answers only from the existing-binding/passthrough stages;
- the trigger itself is short-circuited (F6 remains an unbound key → passthrough to the focused pane, exactly as today);
- for **every key other than the claimable trigger**, the enabled-but-not-in-chrome answer is bit-identical to the disabled answer — enabling the settings flag alone changes nothing observable;
- no `chrome-op`, `semantic-op`, or `rejected` outcome can occur while disabled (the single fail-closed exception: an inconsistent snapshot carrying a pending sequence is rejected so a pending key can never reach a terminal).

This identity is table-tested over a 49-key matrix under empty and fully-available surface snapshots, plus every entry of the semantic keymap, in `__tests__/vimInkPrecedence.test.ts`.

## 3. F6 chrome mode

- **Trigger:** F6 by default (`DEFAULT_INK_CHROME_TRIGGER`), matching the shared core default. Rebinding is allowed (function-key availability varies per the design) but the configured trigger must pass `validateChromeTriggerForInk`: structurally valid and colliding with no reserved chord and no enumerated existing binding in any surface state. Modifier variants of the trigger (`Shift+F6`, `Ctrl+F6`) do not enter chrome mode; F6 pressed **inside** chrome mode is rejected (no double-enter); the trigger is not claimable while a pre-adapter gate is active.
- **Enter/exit:** trigger press while `inactive` → `chrome.enter`; plain `Esc` while in `chrome-normal`/`chrome-search` → `chrome.exit`, restoring prior focus (the chain is not consulted for that key). Esc with a pending sequence exits and clears pending.
- **Indicator (integration obligation):** entering chrome mode shows a persistent `CHROME` indicator naming the mode, the pending sequence, and the focused semantic target, exposed to assistive technology through the existing Ink status/toast surfaces (`StateManager.showToast` / status line) with a concise accessible label (e.g. "Vim chrome mode active"). Ordinary navigation keys must not be announced individually. Esc always remains a bounded path back to native interaction.
- **Persistence:** `vimModeEnabled` (default `false`), `vimChromeTrigger` (default `F6`), `vimSequenceTimeoutMs` (default 1000, clamped 250–3000) are read from the existing `SettingsManager` paths per platform. Missing or invalid values fall back safely to disabled/default; enabling requires an explicit user action; disabling immediately resets pending sequences, exits chrome state, clears visible mode chrome, and sends no pending keys anywhere.

## 4. Search, navigation, guarded actions, help

The chrome-mode semantic keymap mirrors the shared `vim/v1` chrome machine one-for-one (`packages/vim-core/src/chrome-machine.ts`); `VIM_INK_SEMANTIC_OPS` is the explicit table and the tests replay every entry.

- **Navigation:** `h j k l` → `focus.move`; `gg` (pending `g`) → `focus.first`; `G` → `focus.last`; `Enter` → `focus.activate`.
- **Panes:** `Ctrl-w` starts the pane prefix; `h j k l` → `pane.focus`, `w` → `pane.cycle`, `+ - < >` → `pane.resize` (bounded steps), `=` → `pane.equalize`, `s`/`v` → `pane.split-horizontal/vertical`.
- **Search:** `/` → `search.open` (scoped to the current navigation surface — panes within the workspace, projects within the rail, items within a picker; never terminal contents); in `chrome-search`, `n`/`N` → `search.next`/`search.previous`, `Esc` exits. Note the honest delta: the current shared machine consumes every other key in `chrome-search` (they resolve to `rejected` here); interactive query text entry is owned by the shared semantic contract (#222), not by this slice, and must not be invented at the Ink layer.
- **Guarded actions:** `x` → `target.close` and `r` → `target.refresh` are capability-based: the focused target must advertise the action; otherwise the adapter reports a brief status via the existing status path, leaves product state unchanged, and records `unsupported`. Closing always flows through the existing confirmation/dirty-file guards (§5).
- **Help:** `?` (shift) → `help.open`, routed to the mode- and target-aware help surface. The existing `?` shortcuts popup (`popupManager.launchShortcutsPopup`) is the reused help surface; it must present chrome-mode bindings only while chrome mode is active once mode-aware help lands.
- **Rejected keys:** any chrome-mode key with no semantic entry — including arrows, `:`, digits, unknown letters, and any `alt`/`meta` chord — resolves to `rejected`: consumed, pending reset per prefix rules, brief status, zero side effects, and **never** delivery to a PTY or text input.

## 5. Existing actions are reused (no new action paths)

Every `semantic-op` and every guarded action must execute through an action path that already exists in the Ink app. `EXISTING_INK_BINDINGS` in `src/vim/inkPrecedence.ts` catalogues the chain's bindings (41 entries, in evaluation order, with their guards and the exact existing function they run). The semantic routing map:

| Shared semantic action | Existing Ink path it must reuse |
| --- | --- |
| `focus.move` / `focus.first` / `focus.last` / `focus.activate` | the pane/sidebar selection logic the arrow-key bindings run (`setSelectedIndex`, `findCardInDirection`, collection bounds) |
| `pane.focus` / `pane.cycle` | the same spatial/cyclic pane-focus logic used by the arrow bindings |
| `pane.resize` / `pane.equalize` | the existing tmux layout/enforce-control-pane-size path (as used by `enforceControlPaneSize` / `Layout reset`) |
| `pane.split-horizontal` / `pane.split-vertical` | the existing pane-creation path (`handleCreateTerminalPane` / transactional pane creation) with the existing capacity guards |
| `target.close` | the existing close path for the focused target: `openPaneMenu`/pane-menu close flow and `executePaneShortcut` routes — always behind the existing confirmation and dirty-file guards |
| `target.refresh` | the existing refresh/retry path for the focused surface |
| `search.open` / `search.next` / `search.previous` | the navigation-collection search surface (no terminal-content search) |
| `help.open` | `popupManager.launchShortcutsPopup` (mode-aware help surface) |
| `chrome.enter` / `chrome.exit` | mode transition only; indicator via the existing status/toast surfaces |

Unavailable actions return `unsupported` semantics (brief status, no state change). Adapter exceptions reset pending state and surface a nonfatal status; consumed keys are never replayed into a terminal.

## 6. Accessibility copy requirements

- Mode transitions announce concise, human labels ("Vim chrome mode active", "Vim chrome mode off") through the existing status/toast surfaces; per-key announcements are prohibited.
- The `CHROME` indicator exposes mode, pending sequence, and focused target as text available to assistive technology.
- Native Tab/Shift-Tab traversal, text-input behavior outside chrome mode, and screen-reader roles/labels/selection/focus announcements remain authoritative and untouched.
- Escape always offers the bounded path back to native interaction; focus restoration falls back to the active pane container with a status announcement.
- Guarded actions keep their existing confirmations and copy; chrome mode adds no new destructive vocabulary.

## 7. How the precedence chain is observed and tested

- **Executable model:** `resolveKeyForInk` returns the typed outcome for every key × snapshot; `VIM_INK_PRECEDENCE_TABLE` states the six stages in order; `EXISTING_INK_BINDINGS` (41 entries) and `VIM_INK_SEMANTIC_OPS` (27 entries) are the explicit tables, frozen at module load and self-checked for duplicate/shadowing entries.
- **Table-driven tests** (`__tests__/vimInkPrecedence.test.ts`, 192 tests): disabled-mode identity over the key matrix (including "only the claimable trigger may differ"); chrome gate (enter/exit, modifier variants, rebind, gated/busy suppression, reserved Ctrl+C above chrome); no-shadowing sweep asserting every enumerated existing binding stays with the chain outside chrome mode (disabled and enabled) plus explicit flip rows (`h`, `r`, `n`, `?`, `Enter`, `q`, `j`, `x`, `/`, arrows); full semantic keymap replay; unknown-key rejection in `chrome-normal`/`chrome-search` and invalid pending continuations; fail-closed validation (`TypeError` on malformed keys/contexts/pending); determinism (25× identical resolutions) and frozen tables; fixture-version pinning (`VIM_INK_FIXTURE_VERSION === 'vim/v1'` must equal the version declared in `protocol-fixtures/vim/v1/chrome.json`).
- **Runtime integration (later slice) must add:** the existing Ink input/shortcut suites remain green with the adapter attached; the Ink input harness exercises chrome mode end-to-end (enter/exit, indicator, routing through reused paths, disable reset); the shared `vim/v1` fixtures replay through the real adapter; accessibility assertions on the indicator copy.

## 8. Scope boundaries and known gaps (honest record)

- **Contract-only.** No Ink runtime code changes in this slice: `useInputHandling.ts`, `PsycheApp.tsx`, `PopupManager`, and the actions are untouched. The attachment point is specified here and modeled in `src/vim/inkPrecedence.ts`; wiring it is a separate reviewed behavior change (R2).
- **Not implemented here (owned elsewhere):** interactive chrome-search query entry and page-move (`Ctrl-u`/`Ctrl-d`) are named in the design but absent from the shared `vim/v1` machine vocabulary today; they belong to the shared semantic contract slice (#222)/core, not to Ink. The Ink table deliberately contains only actions the shared core can emit.
- **Not proven here:** no real-terminal (tmux/iTerm/Windows) chrome-mode evidence exists yet — that requires the runtime integration and real-surface smoke runs; no Ink harness run against a built app has been performed in this slice.
- **Sibling slices:** #222 semantic contract, #223 shared core fixtures, #224 web contract, #226 iOS, #227 acceptance matrix. This slice touches none of their files; `VimAction` vocabulary is mirrored (documented) rather than imported to keep the slices compile-time independent, and fixture-version pinning is asserted at runtime.
