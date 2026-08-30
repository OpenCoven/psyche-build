# Changelog

## Unreleased

## [0.0.2] - 2026-08-28

### Changed

- The Coven launcher now opens the bare Coven CLI (`coven`) across the TUI,
  daemon, conflict-resolution, and native desktop paths instead of entering
  `coven code`. The stable internal configuration ID remains `coven-code`.
- The native Coven theme now uses graphite surfaces with restrained violet
  focus accents, and performance diagnostics consistently show a dropped-frame
  value when frame timing is available.
- Repository planning now publishes from the canonical Beads store through a
  bounded managed-Project synchronizer with repeatable offline drift checks.
- Contributor, security, support, agent-operation, and Psyche compatibility
  contracts are now explicit and covered by repository checks.

### Fixed

- Files-pane toolbar controls no longer transfer focus to the pane canvas
  before their button action runs.
- Native Git history inspection now isolates repository, global, and system Git
  configuration so a project cannot redirect the read-only log operation.
- Restored Coven panes discard legacy code-mode session IDs and names before
  relaunching the bare CLI.

### TestFlight: What to Test

- Open a project and launch Coven CLI from the agent picker. Confirm it starts
  with the bare `coven` command and does not attempt to resume a generated
  session ID.
- Use the Files pane toolbar and confirm each control runs without moving focus
  into the pane canvas first.
- Inspect Git history in ordinary and bare repositories and confirm the log
  remains bounded to the selected repository.

## [0.0.1] - 2026-08-23

### Performance

- The direct-distributed macOS desktop app now opts its Tauri WKWebViews into
  the display's native refresh rate. WebKit otherwise limits
  `requestAnimationFrame` to about 60 Hz on macOS 13–15, even on ProMotion and
  high-refresh external displays. The opt-in is deliberately confined to the
  notarized DMG/Homebrew distribution and has no effect on other platforms.

### Security

- Added project-scoped agent control for registered panes and browser tabs with
  exact resource generations, task-bound capability leases, approve-once risky
  actions, operator revocation, and no whole-desktop fallback.
- Browser automation now uses bounded semantic snapshots and typed actions.
  Submit-capable actions bind captured form method/destination; approved scripts
  are limited to 64 KiB source, five seconds, and 256 KiB JSON results. Each
  approved script now runs in a fresh native WebKit content world so it cannot
  poison the page automation realm or a later approved invocation.
- Revoked approved browser-script authority at invocation completion by moving
  approved source into a one-shot Worker and applying only validated
  synchronous DOM mutation plans.
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

### Orchestration

- Run parallel coding agents in isolated git worktrees and tmux lanes, with clear orchestration for review, handoff, and completion.

### Coven Connectivity

- Pair with Coven hosts, browse active sessions, and control remote tmux panes from the workspace.

### macOS Workspace

- Native macOS workspace with a syntax-highlighted CodeMirror editor and a bounded, virtualized diff viewer for large changes.
- Personalize themes and backgrounds, with accessibility-aware controls, notifications, and clear operator feedback.

### iOS Cockpit

- iOS cockpit foundation for protocol and connection work, with compact navigation for smaller screens.
- The current iOS experience is demo-first while the remote-control workflow matures; source and simulator behavior do not establish live TestFlight availability.

### Distribution targets

- The public macOS release consists of signed and notarized dual-architecture DMGs, checksums, and a Homebrew Cask that points to those exact verified assets.
- The planned iOS delivery is an independently gated internal TestFlight companion for authorized OpenCoven testers.

### TestFlight: What to Test

#### Launch and navigation

- Launch the app and verify that navigation is clear at both compact and regular widths.
- Rotate the device and confirm the compact navigation remains usable.

#### Host and pane browsing

- Open the host-pairing UI, then browse available terminals and panes after pairing.
- Treat remote interactions as a demo-first preview; production iOS remote control is not yet available.

### Known Limitations

- This repository does not currently claim a live TestFlight build; internal distribution remains pending #200.
- There is no Windows or Linux application in this release.
