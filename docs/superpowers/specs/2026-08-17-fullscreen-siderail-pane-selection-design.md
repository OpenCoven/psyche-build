# Fullscreen Siderail Pane Selection Design

## Goal

When the desktop workspace is showing one maximized pane, selecting another
local pane from the left siderail keeps fullscreen mode active and replaces the
visible focused pane with the selected pane.

## Current Behavior

Local siderail rows delegate selection to `focusThread`. That function updates
the active thread and the layout's `focusedLeafId`, but it leaves
`maximizedLeafId` pointing at the previously maximized pane. The siderail
therefore marks the new row as selected while the canvas continues displaying
the old pane.

## Design

Keep pane-focus behavior centralized in `focusThread`.

After resolving the selected thread's layout leaf, `focusThread` will:

1. Detect whether that layout is currently maximized.
2. If so, move `maximizedLeafId` to the selected leaf.
3. Set `focusedLeafId` to the selected leaf as it does today.
4. Render the workspace and complete the existing focus restoration flow.

This preserves one-pane fullscreen mode while ensuring its visible pane,
focused pane, active thread, siderail selection, and persisted layout state all
refer to the same thread.

Normal multi-pane layouts remain unchanged. Invalid, hidden, closing, or
otherwise unfocusable threads continue to return before mutating focus or
maximize state.

## Alternatives Considered

### Patch only the siderail click handler

This is narrower but leaves keyboard, command-palette, and other explicit focus
paths capable of producing the same stale fullscreen state.

### Ignore `maximizedLeafId` while rendering

Rendering the focused leaf instead would leave maximize controls and persisted
layout state inconsistent with what is visible.

## Testing

Add a focused desktop pane regression that starts with pane A maximized, focuses
pane B through the shared focus path, and verifies:

- fullscreen mode remains active;
- `maximizedLeafId` and `focusedLeafId` both identify pane B;
- pane B becomes the active thread and rendered pane;
- existing non-maximized focus behavior remains unchanged.
