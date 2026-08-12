# Comprehensive Vim Support Design

**Status:** Approved design

**Date:** 2026-08-12

## Objective

Add opt-in, practical Vim support across every keyboard-capable Psyche surface without stealing input from terminal Vim/Neovim, text fields, dialogs, assistive technology, or platform-native controls.

The feature covers three distinct interaction domains:

1. terminal Vim/Neovim input fidelity;
2. practical Vim editing in Psyche's embedded file editor; and
3. app-wide Vim navigation through an explicit chrome mode.

Desktop is the reference implementation. Browser/web, the Ink TUI, and iOS hardware keyboards then implement the same versioned semantic contract and conformance fixtures.

## Decisions

- Vim support is opt-in. Existing users retain current keyboard behavior.
- `F6` is the default, configurable chrome-mode trigger.
- App chrome never intercepts Vim sequences until the user explicitly enters chrome mode.
- `Esc` leaves chrome mode and restores input to the previously focused surface.
- Terminal bytes remain opaque and pass through unchanged outside chrome mode.
- The embedded editor targets practical Vim parity rather than Neovim plugins, Lua, or unrestricted Ex scripting.
- One shared semantic contract defines normalized keys, state transitions, actions, precedence, resets, and fixtures.
- Delivery is phased: shared contract and desktop, web, Ink TUI, iOS, then cross-platform acceptance.

## Non-goals

- Embedding Neovim or exposing a Neovim RPC/plugin host.
- Loading `.vimrc`, `init.vim`, `init.lua`, plugins, arbitrary mappings, or arbitrary Ex commands.
- Reinterpreting terminal output to guess whether Vim is running.
- Replacing xterm, PTY, bridge, tmux, or iOS terminal transports.
- Making Vim mode the default or changing existing shortcuts while the mode is disabled.
- Emulating a mouse or forcing modal navigation on touch-only use.

## Architecture

### Shared semantic core

Create a pure, versioned input core with no DOM, xterm, CodeMirror, Ink, SwiftUI, PTY, or network dependencies. It owns:

- normalized key tokens and modifier representation;
- `disabled`, `passthrough`, `chrome-normal`, `chrome-search`, and editor contexts;
- pending prefixes, counts, operators, registers, marks, macros, search state, and reset deadlines;
- semantic action output; and
- deterministic conformance traces.

The TypeScript core is the executable reference for desktop, browser/web, Ink, and the embedded editor. iOS implements the same state machine in Swift and must pass fixtures generated from the versioned contract. Fixtures live under `protocol-fixtures/vim/v1/` and contain inputs, starting context, expected state, emitted actions, consumed/passthrough disposition, and reset behavior.

Raw platform events never directly invoke product actions. Each adapter performs:

```text
raw event -> normalized key token -> semantic state machine -> action executor
```

The state machine returns one of:

- `passthrough`: deliver the original, unmodified event or bytes to the focused surface;
- `pending`: consume the key while showing the pending sequence;
- `action`: consume the key and execute one or more semantic actions; or
- `unsupported`: consume the sequence, reset safely, and show a visible explanation.

### State ownership

Each app window or TUI process owns one chrome-mode state. Each embedded editor buffer owns independent editor state for marks, undo grouping, pending operators, and last change. Named registers and recorded macros are workspace-scoped and bounded. Terminal processes own their own Vim state; Psyche does not inspect or duplicate it.

Focus restoration records a stable semantic target rather than a raw DOM or view pointer. Leaving chrome mode restores the terminal, editor, input, or accessible control if it still exists; otherwise it focuses the nearest surviving pane or navigation container.

### Platform adapters

#### Desktop Tauri

The desktop adapter integrates with the existing document shortcut router, pane layout, session tree, browser chrome, xterm terminal controller, and CodeMirror editor. It must preserve existing modal precedence and current `Cmd`/`Ctrl` application shortcuts.

xterm input stays on its existing `term.onData -> sendToThread -> pty_write` route. `F6` is handled before xterm only to enter chrome mode. While chrome mode is active, the adapter consumes semantic navigation keys and does not send them to the PTY. On `Esc`, terminal delivery resumes without synthesizing an extra escape byte.

#### Browser/web

The Vue terminal adapter uses the existing `/api/keys` transport. It normalizes hardware keyboard events before the current global key handler, while native text inputs and textareas retain their normal behavior. Browser chrome, dashboard controls, dialogs, and terminal focus implement the shared action interface.

#### Ink TUI

The adapter sits at the top of the existing `useInputHandling` precedence chain. When disabled or outside chrome mode it preserves every existing shortcut. In chrome mode it routes semantic actions through existing pane, project, popup, settings, and lifecycle functions rather than creating parallel commands.

#### iOS

Hardware keyboard commands normalize into the Swift contract adapter. `PtyTerminal.sendInput`, `XtermWebView`, and current bridge messages remain the only terminal input path. The `CodingKeyRow` adds an accessible Chrome key as the software-keyboard equivalent of `F6`; it does not manufacture a terminal `F6` sequence when entering app chrome mode.

## Configuration and persistence

The initial settings are:

- `vimModeEnabled: boolean`, default `false`;
- `vimChromeTrigger: normalized key chord`, default `F6`;
- `vimSequenceTimeoutMs: integer`, default `1000`, clamped to `250..3000`;
- `vimRelativeLineNumbers: boolean`, default `false`; and
- `vimClipboard: "unnamed" | "system"`, default `unnamed`.

Settings use each platform's existing versioned settings/storage path. Missing or invalid values fall back safely. Enabling the feature requires an explicit user action. Disabling it immediately resets pending sequences, exits chrome/editor command state to native input behavior, clears visible mode chrome, and does not send pending keys elsewhere.

Mappings are not user-configurable in the first version. The chrome trigger is configurable because function-key availability varies; semantic commands remain fixed until cross-platform parity is proven.

## Input precedence and safety

Input is resolved in this order:

1. OS accessibility and reserved system commands;
2. active native modal/dialog controls;
3. IME composition, dead keys, and native editable text controls;
4. the configured chrome trigger;
5. active Psyche chrome mode;
6. active embedded-editor Vim mode;
7. existing Psyche application shortcuts; and
8. unchanged terminal or focused-control passthrough.

The adapter must ignore composition updates until the platform reports committed text. Paste payloads are atomic and never parsed as Vim command sequences. Key-up events, mouse reporting, bracketed paste, function keys other than the configured trigger, and terminal escape/control sequences remain unchanged outside chrome mode.

Pending sequences reset on `Esc`, timeout, focus loss, modal opening, workspace/window replacement, mode disable, or adapter disposal. A pending or unsupported chrome sequence never falls through into a PTY or text input.

## Chrome-mode interaction contract

Entering chrome mode shows a persistent `CHROME` indicator with the pending sequence and focused semantic target. The indicator must be exposed to assistive technology without announcing every ordinary navigation key.

Core actions:

| Keys | Semantic action |
| --- | --- |
| `h`, `j`, `k`, `l` | Move focus spatially or within the active collection |
| `gg`, `G` | Move to first or last item |
| `Ctrl-u`, `Ctrl-d` | Move by page |
| `/` | Enter scoped chrome search |
| `n`, `N` | Next or previous scoped match |
| `Enter` | Activate or open the focused target |
| `Ctrl-w h/j/k/l` | Focus pane by direction |
| `Ctrl-w w` | Cycle panes |
| `Ctrl-w +`, `Ctrl-w -`, `Ctrl-w <`, `Ctrl-w >` | Resize pane in bounded steps |
| `Ctrl-w =` | Equalize pane layout |
| `Ctrl-w s`, `Ctrl-w v` | Create horizontal or vertical terminal pane |
| `x` | Request guarded close for the focused target |
| `r` | Retry or refresh when the target advertises that action |
| `?` | Open mode- and target-aware Vim help |
| `Esc` | Exit chrome mode and restore prior focus |

Actions are capability-based. A target declares which semantic actions it supports; unavailable actions return `unsupported`, leave product state unchanged, and show a brief status. Destructive actions retain existing confirmation and dirty-file guards. Chrome mode cannot bypass authorization, lifecycle, close, save, or merge gates.

Chrome search is scoped to the current navigation surface: sessions within the rail, panes within the workspace, commands within a picker, files within the file list, or controls within a dialog. It does not search terminal contents.

## Embedded-editor Vim contract

The CodeMirror adapter uses the shared editor machine and applies semantic edits as CodeMirror transactions. It does not install an independent Vim plugin with divergent state.

Supported modes:

- normal;
- insert and replace;
- characterwise, linewise, and blockwise visual;
- operator-pending;
- search;
- command-line; and
- macro recording/playback.

Required practical-parity surface:

- counts and repeat: numeric prefixes, `.`, and count composition;
- motions: character, word/WORD, line, paragraph, document, matching delimiter, find/till, and search motions;
- operators: delete, change, yank, indent, outdent, case transform, join, and format when the language service supports it;
- text objects: word/WORD, quotes, backticks, parentheses, brackets, braces, angle brackets, paragraph, and tag where syntax support is available;
- edits: insert/append/open, replace, substitute, paste before/after, join, increment/decrement numbers, and undo/redo;
- registers: unnamed, numbered delete, small delete, named, black-hole, expression-result, last insert, current filename, and system clipboard according to settings;
- marks: local lowercase marks, jump back/forward, change positions, and last insert/selection positions;
- macros: record into named registers, play, repeat, counts, and recursion/step bounds;
- search: forward/backward, next/previous, word under cursor, case rules, whole-word rules, and `:noh`; and
- visual selection behavior consistent with UTF-16 CodeMirror positions while preserving Unicode grapheme boundaries.

The bounded Ex command set is:

- `:w`, `:wa`;
- `:q`, `:q!`, `:qa`, `:qa!`;
- `:wq`, `:x`;
- `:e`, `:edit`, `:bn`, `:bp`, `:b {name}`;
- `:noh`, `:nohlsearch`;
- `:set number`, `nonumber`, `relativenumber`, `norelativenumber`, `ignorecase`, `noignorecase`, `smartcase`, `nosmartcase`, `wrap`, and `nowrap`; and
- range-prefixed substitute with literal or regular-expression search, confirmation, and bounded replacement count.

Unknown or malformed Ex commands do not execute shell code. They retain the editor buffer, show an inline error, and preserve command history. `:q` and buffer navigation use existing dirty-file decision gates; `:w` uses the existing bounded atomic save path.

Macros, registers, Ex history, search patterns, and pending operations are bounded in byte count and entry count. Macro recursion and total replay actions have hard limits. None of these stores can contain terminal output unless the user explicitly yanks text inside the editor.

## Accessibility

- Native Tab and Shift-Tab traversal remain available.
- Text inputs, textareas, contenteditable controls, and platform dialogs keep native editing unless chrome mode was explicitly entered.
- Screen-reader roles, labels, selection, expanded/collapsed state, and focus announcements remain authoritative.
- Chrome and editor mode indicators expose concise accessible labels.
- Escape always offers a bounded path back to passthrough/native interaction.
- Reduced-motion preferences disable animated focus travel without changing focus semantics.
- Touch remains fully supported; Vim mode adds keyboard behavior and never hides existing touch controls.

## Error handling

- Unsupported normalized keys in passthrough remain untouched.
- Unsupported keys in chrome mode are consumed, reset according to prefix rules, and reported without side effects.
- If an action target disappears, the adapter re-resolves the nearest stable target and reports the stale action.
- If focus restoration fails, focus moves to the active pane container and announces the fallback.
- Adapter exceptions reset pending state and surface a nonfatal status; they never replay consumed keys into a terminal.
- Invalid persisted configuration falls back to disabled/default behavior.
- A fixture version unknown to an adapter fails its conformance gate rather than silently accepting drift.

## Testing and acceptance

### Shared conformance

Golden traces cover every context, prefix, count, operator, reset, timeout, supported action, unsupported action, and precedence boundary. TypeScript and Swift adapters must produce identical semantic output for shared traces. Fixture validation rejects duplicate cases, unknown actions, missing terminal dispositions, and unbounded sequences.

### Terminal fidelity

Tests prove byte-for-byte passthrough outside chrome mode for printable input, `Esc`, control chords, Alt/meta sequences, function keys, bracketed paste, IME committed text, mouse mode, and randomized byte sequences. Entering and leaving chrome mode must not synthesize terminal input. Real Vim and Neovim smoke sessions cover insert/normal transitions, mappings, macros, terminal mouse mode, and nested tmux.

### Embedded editor

Behavioral tests execute commands against real CodeMirror state and assert document text, selections, registers, marks, undo groups, search state, dirty state, and save/close effects. Golden Vim scenarios include counts, composed operators, Unicode, block selections, macros, substitutions, and rejected Ex commands.

### Product adapters

Each platform tests enable/disable persistence, trigger rebinding, modal precedence, native text inputs, search, pane focus/layout, guarded actions, help, status reporting, focus restoration, and accessibility. Browser automation exercises the desktop and web apps. Ink tests use its existing input harness. iOS unit/UI tests exercise external-keyboard commands and the accessible software Chrome key.

### Completion gates

A platform slice is complete only when:

- its adapter passes all shared fixtures applicable to that platform;
- existing shortcut and terminal transport suites remain green;
- its real-surface smoke test passes;
- accessibility assertions pass;
- unsupported capabilities and proof gaps are documented; and
- independent specification and code-quality reviews approve.

Cross-platform parity is not complete until desktop, web, Ink, and iOS all pass the same contract version. Physical iOS hardware-keyboard evidence remains an explicit proof gap until run on available hardware.

## Delivery slices and tracking

Track the work as one parent Bead with dependency-ordered children:

1. shared contract, conformance fixtures, settings schema, and desktop reference adapter;
2. browser/web adapter parity;
3. Ink TUI adapter parity;
4. iOS hardware keyboard and software Chrome-key parity; and
5. cross-platform conformance, documentation, performance, accessibility, and physical-device acceptance.

The desktop slice includes embedded-editor practical parity because CodeMirror is the reference editor implementation. Later platform slices implement editor behavior only where that platform exposes an embedded editor; terminal and chrome parity remain mandatory everywhere.

Each child Bead names its required skills, exact tests, review gates, and predecessor. No child may be closed based only on source contracts when its platform supports behavioral execution.

## Rollout

The setting remains off by default through all slices. Development and preview builds expose it once the desktop reference adapter passes its acceptance gate. Stable release requires all keyboard-capable platforms to pass conformance or to advertise a precise, documented capability limitation approved by maintainers.

Telemetry is not required. Diagnostics may record contract version, enabled state, current context, semantic action name, reset reason, and error category, but never raw terminal bytes, pasted text, editor contents, register contents, search terms, macros, or Ex command text.
