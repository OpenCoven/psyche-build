# iOS Collapsible Siderails Design

## Goal

Let the native iOS terminal use the full available screen while keeping the
Projects and Panes rails available on demand.

## Design

`CockpitView` will bind `NavigationSplitView` to
`NavigationSplitViewVisibility` and `NavigationSplitViewColumn` state. On
compact-width iPhones, the preferred column is `.detail`, so both left rails
are collapsed and the terminal fills the screen. On regular-width iPads, the
initial visibility remains `.all`.

The terminal detail toolbar will expose one sidebar toggle. On iPhone it moves
the compact split view between `.detail` and `.sidebar`; selecting a pane
returns to `.detail`. On iPad it switches visibility between `.detailOnly` and
`.all`, collapsing or restoring Projects and Panes together. The implementation
will retain native split-view navigation rather than introducing a custom
drawer or replacing the existing three-column iPad layout.

## State and Data Flow

The visibility state is local presentation state owned by `CockpitView`.
Changing it does not alter the selected project, selected pane, connection
state, terminal output, or protocol model. Restoring the rails therefore shows
the same project and pane selections.

## Accessibility and Failure Behavior

The toggle will have a stable accessibility label and identifier that describe
whether it opens or closes the siderails. Because the behavior uses SwiftUI's
native split-view visibility API, unsupported transitions remain under system
navigation control and require no fallback error state.

## Validation

UI coverage will verify that:

1. The iPhone cockpit opens with the terminal detail visible and both siderails
   collapsed.
2. Tapping the toggle reveals the Projects and Panes navigation.
3. Selecting a pane on iPhone, or toggling the rails on iPad, returns to the
   full-width terminal.
4. Existing host-pairing navigation and pane selection remain functional.
