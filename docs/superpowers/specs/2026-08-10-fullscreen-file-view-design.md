# Fullscreen File View Design

## Goal

Open and activate workspace files using the same focused-canvas presentation as
a maximized pane. The file editor fills the canvas, the pane minimap remains
available for returning to active work, and open file tabs remain intact when
the user leaves the editor.

## Interaction contract

- Opening or activating a file enters file focus.
- The file editor fills the active workspace canvas.
- The sessions sidebar and Git dock retain their current visibility.
- The focus-mode minimap shows the current file followed by the workspace's
  visible panes, including their existing status and attention indicators.
- Clicking a pane in the minimap leaves the file tab open and focuses that pane.
- Pressing Escape returns to the pane that was focused before file focus and
  leaves the file tab open.
- Activating the file tab again re-enters file focus.
- Closing the active file returns to the recorded pane.

## Architecture

Keep files in the existing tab and editor model. A file does not become a
pane-tree leaf and does not participate in tiling, spanning, pane persistence,
or pane lifecycle operations.

Add a transient file-focus presentation state that records the return thread
ID. File activation hides the tiled pane host, shows the existing editor, and
renders the existing pane minimap beside it. The minimap renderer accepts a
file-focus context so it can prepend the active file as the current item while
continuing to derive pane entries from the active pane layout.

Entering file focus from a pane records that pane as the return target.
Switching between file tabs while already in file focus preserves the original
return target. Returning through Escape, a pane minimap entry, or active-file
closure clears file focus and uses the existing pane focus flow so project,
workspace, status, terminal fitting, browser bounds, and sidebar state remain
consistent.

## State and fallback behavior

File-focus state is transient and is not saved in workspace persistence. The
existing open-file, dirty-buffer, selection, cursor, and save-conflict state
continues unchanged.

Before returning, resolve the recorded thread against the active project and
workspace. If it is no longer visible or available, fall back to the active
layout's focused leaf, then its first visible leaf. If the layout has no pane,
restore the empty canvas.

Project switching and dirty-file navigation continue through the existing
guards. A blocked navigation leaves the editor focused and does not clear the
return target.

## Keyboard and navigation behavior

Escape keeps the existing transient-layer priority. Help, menus, set picking,
and armed confirmations still close before file focus. When file focus is the
next active layer, Escape returns to the recorded pane without closing the file
tab. Pane maximize remains the following fallback when no file is focused.

Clicking a pane minimap entry uses the same return path as Escape, with the
clicked pane as the explicit destination. File tabs continue to use their
existing activation, close, middle-click, keyboard cycling, and dirty-file
guards.

## Error handling

- Failed file reads remain visible in the editor through the current file error
  state.
- Dirty-file save, discard, reload, and cancel decisions remain authoritative
  before any navigation away from a file.
- Missing return panes are handled by deterministic layout fallback rather than
  stale IDs or silent navigation failure.
- A workspace with no panes restores the normal empty canvas.

## Verification

Add focused contract tests proving that:

- file activation records the return pane;
- the file editor and pane minimap render together;
- the current file is marked as the minimap's current item;
- clicking a pane leaves the file tab open and focuses that pane;
- Escape returns without closing the file tab;
- fallback selection works when the original pane is closed or hidden;
- the Git dock and sessions sidebar keep their current visibility;
- dirty-file guards can block the return path without corrupting focus state.

Run the existing workspace editor, physical pane, keyboard cascade, workspace
panel, and related native web regression tests after the focused tests pass.
