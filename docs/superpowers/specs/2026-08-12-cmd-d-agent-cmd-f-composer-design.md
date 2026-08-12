# Cmd+D Agent and Cmd+F Composer Shortcuts Design

**Date:** 2026-08-12

## Goal

Make Command+D on macOS and Control+D on other platforms the single keyboard
shortcut for opening the new-agent picker. Make Command/Control+F the single
shortcut for focusing the bottom command input and opening its slash-command
palette. Command/Control+P and Command/Control+K must no longer perform those
actions.

## Scope

Update the native desktop shell, embedded browser shortcut bridge, visible
shortcut hints, and focused regression tests.

Modify:

- `native/desktop/psyche-build-tauri/web/main.js`
- `native/desktop/psyche-build-tauri/web/index.html`
- `native/desktop/psyche-build-tauri/src-tauri/src/lib.rs`
- `__tests__/tauriAgentPicker.test.ts`
- `__tests__/tauriDesktopTabs.test.ts`

Do not introduce a shortcut registry, retain P as an alias, change shell-pane
Command/Control+T behavior, or rewrite historical design and plan documents.

## Shortcut Contracts

The agent picker uses the platform primary modifier:

- macOS: Command+D
- Other platforms: Control+D

The shortcut matches only when Alt and Shift are not pressed. Modified
variants such as Command+Shift+D or Control+Alt+D do not open the picker.

Command/Control+P has no agent-picker behavior. When the picker is closed it
falls through to the surrounding platform or focused control. When the picker
is open, the modal may still consume the keystroke as part of its existing
focus trap, but it must not reopen, reset, or refocus the picker.

The bottom command input uses the same platform primary modifier:

- macOS: Command+F
- Other platforms: Control+F

The shortcut matches only when Alt and Shift are not pressed. It preserves the
current Command/Control+K behavior exactly: focus `commandInput` and call
`openPalette("/", true)`.

Command/Control+K no longer focuses the input or opens the palette. It falls
through to the surrounding platform or focused control.

## Main Shell Routing

`routeGlobalShortcut` replaces its P branch with an exact D branch. The branch
calls the existing `openAgentPicker()` entry point and prevents the default
only when the picker opens.

`routeAgentPickerModalKeydown` recognizes the same exact D shortcut while the
picker is open. Repeating D preserves the current behavior: consume the event,
reset the picker to its default selection, and focus the picker list.

No new agent-launch path is added. D opens the existing picker; selecting an
agent continues through `launchSelectedAgent()` and `spawnAgentThread()`.

`routeGlobalShortcut` also replaces its K branch with an exact F branch. The
branch focuses `commandInput`, opens the slash-command palette with
`openPalette("/", true)`, and prevents the default browser Find action.

No new composer entry point is added. The rail palette button and other
existing callers continue to use the same input and palette functions.

## Embedded Browser Routing

Keyboard events inside a native child webview do not reach the main shell.
Extend the existing Rust-injected browser shortcut handler that already
forwards Command/Control+T.

For exact Command/Control+D, the child webview:

1. Prevents the embedded page or browser default.
2. Stops propagation inside the child webview.
3. Emits `browser:shortcut-agent-pane` with the existing browser label and URL
   payload shape.

The main shell listens for `browser:shortcut-agent-pane` and calls
`openAgentPicker()`. The existing `browser:shortcut-terminal-pane` bridge and
Command/Control+T behavior remain unchanged.

For exact Command/Control+F, the child webview:

1. Prevents the embedded page or browser Find default.
2. Stops propagation inside the child webview.
3. Emits `browser:shortcut-composer` with the existing browser label and URL
   payload shape.

The main shell listens for `browser:shortcut-composer`, focuses
`commandInput`, and calls `openPalette("/", true)`.

No P or K event or compatibility alias is emitted.

## Visible Shortcut Hints

Replace the agent shortcut label from `⌘P` to `⌘D` in:

- The New Pane menu.
- The terminal canvas empty state.
- The keyboard shortcuts overlay.

Change the keyboard shortcuts overlay's `Open the composer` row from `⌘K` to
`⌘F`.

The shell, browser, and Git hints remain unchanged.

## Regression Coverage

Update `__tests__/tauriAgentPicker.test.ts` to verify:

1. Exact Command/Control+D opens the picker through `routeGlobalShortcut`.
2. Command/Control+P does not call `openAgentPicker()`.
3. Alt/Shift-modified D does not call `openAgentPicker()`.
4. Repeated exact D is handled by `routeAgentPickerModalKeydown`.
5. P does not reopen or reset an already-open picker.
6. The New Pane menu, empty state, and help overlay show `⌘D` and no longer
   advertise `⌘P`.
7. Exact Command/Control+F focuses `commandInput`, opens
   `openPalette("/", true)`, and prevents the default.
8. Command/Control+K and Alt/Shift-modified F do not focus the input or open the
   palette.
9. The help overlay shows `⌘F` for `Open the composer` and no longer advertises
   `⌘K`.

Update `__tests__/tauriDesktopTabs.test.ts` to verify:

1. The Rust child-webview injection recognizes exact D.
2. It emits `browser:shortcut-agent-pane`.
3. The main shell listener opens the agent picker.
4. The Rust child-webview injection recognizes exact F.
5. It emits `browser:shortcut-composer`.
6. The main shell listener focuses the command input and opens the palette.
7. No P- or K-based browser bridge is present.
8. The existing terminal-pane T bridge remains intact.

The targeted agent-picker and desktop-tabs tests, test type-check, native web
build, Rust formatting check, and Rust check must pass.

## Security Correction Addendum

The embedded-browser event-emission design above is superseded for T, D, and F
shortcut forwarding. External child webviews cannot emit Tauri events under the
v2 ACL and must not receive general event-emission permission.

Each shortcut now invokes the dedicated `browser_app_shortcut` command. The
command accepts only callers whose trusted webview label starts with
`psyche-browser-`, allowlists the three shortcut actions, derives the payload
label from that caller, focuses the main webview, and emits the existing
internal shortcut event only to `main`. A dedicated capability grants remote
HTTP/HTTPS browser webviews only `allow-browser-app-shortcut`; existing
title/focus emission code remains unchanged and receives no added permission.
