# Terminal Focus Report Suppression Design

**Date:** 2026-08-12
**Status:** Approved

## Goal

Prevent xterm focus reports from appearing as literal `^[[O` and `^[[I`
input when Psyche rebuilds the pane tree after launching a terminal agent.

## Scope

This design changes only the native macOS Tauri terminal client. It covers:

- terminal pane DOM rebuilds performed by `renderPaneWorkspace`;
- xterm input emitted while a terminal pane is internally detached and
  reattached; and
- focused regression tests for the filtering and render lifecycle.

It does not:

- update Codex or any other agent;
- suppress focus reports caused by real user or window focus changes;
- disable xterm focus reporting globally;
- alter PTY transport or Rust process spawning; or
- change ordinary keyboard, paste, shortcut, or mouse input.

## Root Cause

`renderPaneWorkspace` currently calls `terminalHost.replaceChildren()` and then
rebuilds the split tree with the persistent terminal pane elements. Detaching
and reattaching the focused xterm causes xterm to emit the terminal focus-out
and focus-in reports `ESC[O` and `ESC[I`.

Some terminal applications, including the affected Codex startup state, can
insert those reports into the active prompt instead of consuming them as focus
events. Repeated workspace renders therefore produce visible `^[[O^[[I`
garbage immediately after a new agent pane launches.

## Design

### Render-scoped suppression

Add a small render lifecycle around `renderPaneWorkspace`:

1. Identify mounted terminal threads whose pane elements are about to be
   reparented.
2. Mark those threads as undergoing an internal pane render.
3. Replace and rebuild the pane tree through the existing renderer.
4. Restore the active terminal focus through the existing focus path.
5. Clear the internal-render marker after the rebuilt DOM and focus events
   have settled.

The marker is bounded to Psyche's own DOM work. It is not a general startup
timer and does not depend on Codex output timing.

### Exact focus-report filtering

Route `term.onData` through a helper before `sendToThread`. The helper suppresses
data only when both conditions are true:

1. the owning thread is marked as undergoing an internal pane render; and
2. the payload consists entirely of one or more exact xterm focus reports,
   `ESC[I` or `ESC[O`.

All other payloads pass through unchanged. In particular, a payload containing
typed text, paste content, shortcuts, mouse protocol data, or any non-focus
bytes must not be partially filtered or dropped.

This preserves legitimate focus reporting when the user changes windows or
focuses another pane outside an internal render.

### Cleanup and failure behavior

Suppression cleanup must run even if pane rendering throws. A stale marker
would silently discard later focus reports, so the render lifecycle uses
explicit guaranteed cleanup.

If no terminal pane is focused or no terminal is mounted, rendering proceeds
without suppression. Browser and tool panes remain unaffected.

## Testing

Extend the native physical-pane source-contract tests to cover:

- exact `ESC[I` and `ESC[O` payloads are suppressed during an internal render;
- repeated combinations such as `ESC[OESC[I` are suppressed;
- the same reports pass through outside an internal render;
- ordinary text, control keys, paste content, and mixed payloads are preserved;
- `renderPaneWorkspace` enters suppression before replacing the pane DOM;
- suppression is cleared after focus restoration settles; and
- cleanup still occurs if the render path throws.

Run the focused physical-pane test file and the existing Codex/agent launch
contract tests that cover native pane creation.

## Acceptance Criteria

1. Launching a Codex pane no longer inserts `^[[O` or `^[[I` into its prompt
   because Psyche rebuilt the pane tree.
2. Normal terminal input remains byte-for-byte unchanged.
3. Real user and window focus changes still reach applications that enable
   terminal focus reporting.
4. Repeated pane renders cannot leave suppression enabled.
5. Browser and non-terminal panes retain their existing behavior.
