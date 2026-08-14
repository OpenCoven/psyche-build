# Changelog

## Unreleased

### Security

- Added project-scoped agent control for registered panes and browser tabs with
  exact resource generations, task-bound capability leases, approve-once risky
  actions, operator revocation, and no whole-desktop fallback.
- Browser automation now uses bounded semantic snapshots and typed actions.
  Submit-capable actions bind captured form method/destination; approved scripts
  are limited to 64 KiB source, five seconds, and 256 KiB JSON results. Each
  approved script now runs in a fresh native WebKit content world so it cannot
  poison the page automation realm or a later approved invocation.
- Durable agent-control journal events and journaled receipts now contain
  allowlisted metadata only. Terminal output, semantic/page contents,
  screenshots, secret values, raw scripts, cookies, headers, absolute/full paths
  or unredacted path components, and provider error details are not persisted.
  Approval context may retain only a redacted basename and redacted target
  description. Live in-memory control state may retain exact operational
  resource IDs until owner restart.
- The bridge and daemon no longer accept a tmux pane id that is not a real
  pane id. Control mode is line-oriented, so a pane id containing a newline
  used to end the intended command and start another one — reaching
  `run-shell`, and so arbitrary commands as the user — from any paired device
  or daemon client.
- Pane operations on the loopback daemon now stay inside the project the daemon
  is scoped to. `panes.attach`, `panes.focus`, and `panes.kill` previously took
  a raw tmux pane id, letting a client authorized for one project read output
  from and type into any tmux pane on the machine.
- LAN pairing now closes the window after five wrong codes and reports
  `too_many_attempts`. A six-digit code with unlimited guesses was brute-forceable
  inside its own five-minute window, and pairing grants a durable device token.
- Pairing codes and daemon tokens are compared in constant time, and
  `PairingFlow` now reports why an attempt failed instead of leaving the caller
  to infer it — an expired window is reported as expired, not as a spent
  attempt budget.
- Keystroke payloads are validated as canonical base64 before decoding.
  `Buffer.from(str, 'base64')` never throws — it silently drops characters
  outside the alphabet — so the previous `try`/`catch` was dead code and
  malformed input reached the terminal as mangled bytes.
- Both servers cap client frames at 1 MiB, the daemon disconnects connections
  that never authenticate, and a connection may hold at most 64 attached streams.

### Reliability

- Neither server can be taken down by a single client frame any more: socket and
  listener `error` events are handled, async dispatch failures answer with an
  error frame instead of crashing the process, and malformed requests are
  rejected rather than thrown. `panes.attach` with no pane id was a one-frame
  denial of service.
- A pane's output stream now costs one shared emitter listener per connection
  rather than one per attached pane, which removes a listener leak and the
  spurious "possible memory leak" warnings that came with it.
- `.psyche/psyche.config.json` — the pane registry — is written atomically, and
  a read that fails for any reason other than "the file does not exist" is now
  an error. Previously an unreadable or corrupt config was silently replaced
  with an empty one on the next write, erasing every pane, worktree path, and
  branch name in the project.
- Opening a Coven session and patching pane metadata now go through the same
  mutation lock as pane spawning, so concurrent operations no longer drop each
  other's panes.

### Documentation

- Added [Bridge and daemon security model](./docs/BRIDGE-SECURITY.md).

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
