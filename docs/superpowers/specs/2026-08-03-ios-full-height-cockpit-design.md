# iOS Full-Height Cockpit Design

## Goal

Make the native iOS cockpit and terminal fill the available screen height
instead of rendering as a short content-sized panel.

## Design

`CockpitView` and `TerminalDetail` will explicitly accept the full height
proposed by their SwiftUI containers with `maxHeight: .infinity`. The terminal
output `ScrollView` remains the flexible child inside `TerminalDetail`; the
terminal header and coding-key row keep their intrinsic heights.

The layout will continue to respect the system safe areas. It will not draw
terminal controls under the status area or home indicator, and it will not use
a fixed pixel height or a device-specific screen measurement.

## State and Data Flow

This is presentation-only sizing. Project selection, pane selection,
NavigationSplitView visibility, terminal output, pairing, and transport state
remain unchanged.

## Failure Behavior

If a parent container proposes less height, SwiftUI may compress the terminal
output region while preserving the header and coding keys. The output remains
scrollable, so no terminal lines need to be discarded.

## Validation

UI coverage on iPhone will compare the app window, main cockpit, and terminal
output frames. The cockpit must occupy nearly all of the window height, and the
terminal output must expand beyond the previous content-sized presentation.
Existing compact navigation, iPad siderails, project selection, and pairing
tests must continue to pass.
