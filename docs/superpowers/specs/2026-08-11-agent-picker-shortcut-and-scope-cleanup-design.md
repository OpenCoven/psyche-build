# Agent Picker Shortcut and Scope Cleanup

## Goal

Restore the native macOS agent picker after removal of the composer scope menu and move its shortcut from Command-P to Command-D.

## Design

- Remove the stale `closeScopeMenu()` call from `openAgentPicker()`. The scope menu no longer exists, so restoring a no-op compatibility shim would retain dead behavior.
- Change both agent-picker keyboard paths from `p` to `d`: the global opener and the modal reset/refocus route.
- Change every visible agent-picker shortcut hint from `⌘P` to `⌘D`, including the new-pane menu, empty canvas action, and help overlay.
- Leave terminal, project, composer, dock, tab, and pane shortcuts unchanged.

## Error Handling

`openAgentPicker()` continues returning `false` when its elements are unavailable or the native dirty-file dialog owns modality. Otherwise it must open without depending on removed scope-menu state.

## Verification

- Add a regression that compiles and executes `openAgentPicker()` without a `closeScopeMenu` dependency.
- Update shortcut tests to require Command-D in both keyboard paths and all visible hints, and reject stale Command-P agent-picker hints.
- Run the focused agent-picker test, then the repository typecheck and test suite.
