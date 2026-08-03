# Changelog

## [0.0.1] - 2026-08-03

### Orchestration

- Run parallel coding agents in isolated git worktrees and tmux lanes, with clear orchestration for review, handoff, and completion.

### Coven Connectivity

- Pair with Coven hosts, browse active sessions, and control remote tmux panes from the workspace.

### macOS Workspace

- Native macOS workspace with a syntax-highlighted CodeMirror editor and a bounded, virtualized diff viewer for large changes.
- Personalize themes and backgrounds, with accessibility-aware controls, notifications, and clear operator feedback.

### iOS Cockpit

- iOS cockpit foundation for protocol and connection work, with compact navigation for smaller screens.
- The current iOS experience is demo-first while the remote-control workflow matures.

### Release Integrity

- Signed and notarized dual-architecture macOS DMGs with checksums, internal TestFlight distribution, and Homebrew availability.

### TestFlight: What to Test

#### Launch and navigation

- Launch the app and verify that navigation is clear at both compact and regular widths.
- Rotate the device and confirm the compact navigation remains usable.

#### Host and pane browsing

- Open the host-pairing UI, then browse available terminals and panes after pairing.
- Treat remote interactions as a demo-first preview; production iOS remote control is not yet available.

### Known Limitations

- iOS builds are distributed internally through TestFlight only.
- There is no Windows or Linux application in this release.
