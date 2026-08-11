# Native session persistence

## Problem

The macOS Tauri app persists projects, browser state, and project layout, but
terminal sessions are owned by in-process `portable-pty` instances. Quitting or
crashing Psyche drops those PTYs, loses the JS thread model and pane topology,
and requires the user to start new shells or agents after reopening the app.

The required behavior is live continuity across Psyche app restarts. Shells,
nested Psyche sessions, Psyche-launched Coven chats, and Coven attachments must
continue running while the app is closed and reappear in their previous pane
layout when the app reopens. A full macOS reboot is outside this slice.

## Required behavior

- Quitting or crashing Psyche detaches the app from native sessions without
  terminating their processes.
- Reopening Psyche restores every still-live session in its saved project,
  worktree, hidden state, pane topology, split ratios, and focus position.
- Explicit **Stop and close** remains the terminating action. It stops the
  persistent session and removes its saved descriptor and pane leaf.
- Hiding a pane removes it from the canvas without stopping the session.
- A persisted session whose process is no longer live appears exited and
  retryable. Psyche does not silently relaunch it.
- A live session is not killed because restoration, attachment, rendering, or
  workspace persistence failed.
- `Ctrl+T` creates a persistent shell terminal in the selected worktree.
- `Ctrl+A` creates a persistent Coven chat agent in the selected worktree.
- Existing Command-key shortcuts retain their current macOS behavior.

## Architecture

### Persistent session owner

Each native session runs inside a Psyche-owned tmux server rather than being
owned directly by the Tauri process. The server uses an isolated socket
directory under:

```text
~/.psyche/macos-app/
```

It must not share the user's default tmux server or the nested tmux server used
by a Psyche CLI process. Session names are opaque values derived from stable
native session IDs.

The Rust backend continues to expose a PTY to the webview, but that PTY is a
disposable tmux client:

```text
webview xterm
  -> Tauri portable-pty client
  -> Psyche-owned tmux session
  -> shell, nested Psyche, Coven chat, or Coven attach process
```

When the app exits, the client disappears and the tmux-owned process remains.
When the app reopens, a new client attaches to the existing tmux session.

### Native session API

The Rust backend provides bounded commands for the native app:

- Create a tmux-backed session from an allowlisted launch kind.
- List live Psyche-owned session IDs.
- Attach a disposable PTY client to a live session.
- Resize and write through the attached client.
- Detach a client without stopping its session.
- Stop and remove a session explicitly.

The webview never constructs a raw tmux command. Rust owns socket selection,
session naming, argument construction, environment filtering, and lifecycle
validation.

### Workspace v3

Workspace persistence moves to a version 3 document written atomically by Rust
under `~/.psyche/macos-app/`. The existing localStorage version 2 document is a
one-time compatibility import when no version 3 file exists.

Version 3 retains the existing project, worktree presentation, project layout,
and browser state. It adds:

- Persisted native session descriptors.
- Per-project and per-worktree pane trees.
- Focused pane leaf IDs.
- Stable active project and active session IDs.

Runtime-only xterm objects, DOM elements, fit addons, in-flight promises,
temporary status flags, and buffered PTY data are never serialized.

## Persisted model

Each session descriptor contains only the data needed to identify, display,
reattach, or explicitly retry a session:

```text
id
projectId
worktreePath
name
kind
hidden
launchKind
covenSessionId, when applicable
```

Persisted launch kinds are allowlisted:

```text
shell
psyche
coven-chat
coven-attach
```

Serialized command paths, arbitrary arguments, and arbitrary environment
variables are not trusted as retry instructions. A retry reconstructs the
command from the current validated app environment and the allowlisted launch
kind. Coven attachment IDs continue to use the existing safe-session-ID
validation.

Each pane tree keeps the current leaf and split structure:

```text
leaf:
  type
  id
  threadId

split:
  type
  id
  orientation
  ratio
  first
  second
```

Trees are keyed by project ID and worktree path. Restore drops malformed nodes,
unknown thread references, duplicate leaves, invalid orientations, non-finite
ratios, and trees that cannot be reduced to a valid root. A missing orientation
continues to mean `column` for compatibility with the first physical-pane
format.

## Lifecycle and data flow

### Creating a session

1. The user invokes a UI action, `Ctrl+T`, or `Ctrl+A`.
2. Psyche resolves the active project and selected worktree.
3. The webview requests creation using an allowlisted launch kind.
4. Rust creates the isolated tmux session and starts the requested process.
5. The webview records the stable session descriptor, reserves pane geometry,
   and adds the pane leaf.
6. A disposable PTY attaches to the tmux session.
7. The updated workspace is scheduled for atomic persistence.

Creation fails before mutating the thread list or pane tree when the tmux
session cannot be created or the proposed pane tree cannot fit.

### Saving

Every durable mutation schedules a version 3 save:

- Session creation, retry, rename, hide, reopen, and close.
- Pane move and split resize.
- Focus changes that update the project's last active session.
- Project, worktree, browser, and layout changes already persisted today.

Writes are debounced during normal interaction. Visibility changes and window
close request an immediate save. Rust writes a temporary file, flushes it, and
atomically replaces the previous workspace only after the complete document is
valid.

### Quitting or crashing

Normal window destruction saves the workspace and detaches PTY clients. It does
not call the session-stop command.

An app crash may skip the final workspace write, so each durable mutation must
already have scheduled persistence. The last successful document remains
usable, and tmux sessions continue running independently.

### Restoring

1. Rust loads and validates workspace v3. If it is absent, Psyche imports the
   localStorage v2 project state and writes v3.
2. Psyche asks the isolated tmux server for live session IDs.
3. Persisted descriptors are reconciled against that live set.
4. Live descriptors rebuild JS thread records and attach new PTY clients.
5. Missing descriptors rebuild exited, retryable records without launching a
   process.
6. Pane trees are sanitized against the rebuilt thread set and mounted.
7. Saved project, worktree, pane, and focus selection are restored when valid;
   deterministic fallbacks choose the first available item otherwise.

Tmux sessions that are live but absent from the workspace document are left
running and are not adopted automatically. This avoids attaching unrelated or
stale sessions to the wrong workspace. A later recovery surface may expose
them, but that is outside this slice.

### Explicit close

**Stop and close** sends the bounded Rust stop command for the stable session
ID. After Rust confirms the owned tmux session has been removed, Psyche removes
the thread descriptor, collapses its pane-tree branch, updates focus, and saves
the workspace.

If stop fails, the pane remains present with an error. Psyche must not remove a
descriptor while the process may still be running.

## Keyboard shortcuts

The global capture-phase shortcut handler adds two Control-only shortcuts:

- `Ctrl+T`: call the existing shell creation path for the active worktree.
- `Ctrl+A`: call the existing Coven chat creation path for the active worktree.

These handlers run before xterm input and call `preventDefault()` only after the
shortcut is accepted. They do not replace the existing Command-key shortcuts,
numeric pane focus shortcuts, browser shortcuts, or file editor shortcuts.

The new-pane menu and help overlay display the same bindings so mouse and
keyboard entry points remain consistent.

## Error handling

- If tmux is unavailable, new sessions fail with an actionable visible error.
  Psyche does not fall back to a nonpersistent direct PTY.
- If a live session cannot be attached, its pane remains retryable and the tmux
  session remains untouched.
- If a persisted session is missing from tmux, it becomes exited and retryable.
- If workspace loading fails validation, Psyche preserves the invalid file for
  diagnosis, reports the failure, and starts from a safe empty workspace rather
  than executing untrusted data.
- If an atomic save fails, Psyche reports the error and preserves the last good
  workspace file.
- Unknown tmux sessions are never killed during reconciliation.
- A failed render or malformed pane tree cannot terminate a live session.

## Security and isolation

- The tmux socket and workspace file live in an app-owned directory with
  restrictive permissions.
- The app always addresses the explicit Psyche-owned socket and never the
  default tmux server.
- Stable session IDs and derived tmux names use a restricted character set and
  bounded length.
- Rust reconstructs retry commands from allowlisted launch kinds and the
  current trusted environment.
- Coven session IDs retain their existing validation before attachment.
- Project roots and worktree paths retain the current canonical containment
  checks before process creation.
- Nested Psyche processes receive a separate tmux environment so their internal
  pane server cannot collide with the native session owner.

## Compatibility

- Existing localStorage workspace v2 state imports projects, worktree
  presentation, browser state, and project layout into v3.
- Version 2 contains no native session descriptors, so upgrade does not invent
  or relaunch sessions.
- Pane splits without an orientation restore as columns.
- Existing Command-key behavior remains unchanged.
- A full macOS reboot ends the tmux server. After reboot, saved descriptors
  restore as exited and retryable; automatic relaunch is outside this slice.

## Verification

### JavaScript and model tests

- Version 2 imports into version 3 without fabricating sessions.
- Version 3 sanitizes session descriptors and pane trees.
- Live, missing, and unknown tmux IDs reconcile correctly.
- Restored trees retain row/column topology, ratios, hidden state, and focus.
- Create, move, resize, rename, hide, reopen, retry, and close schedule saves.
- `Ctrl+T` launches a shell through the persistent creation path.
- `Ctrl+A` launches Coven chat through the persistent creation path.
- Existing Command shortcuts and `Ctrl+1` through `Ctrl+9` still behave as
  before.

### Rust tests

- The backend creates, lists, attaches, detaches, and stops sessions on the
  explicit isolated tmux socket.
- Detaching a PTY client leaves the tmux session and child process alive.
- Explicit stop removes the owned tmux session.
- Invalid IDs, launch kinds, paths, and Coven attachment IDs are rejected.
- Retry command construction ignores serialized arbitrary commands and
  environment variables.
- Workspace v3 writes are atomic and preserve the previous file on failure.
- Corrupt and unsupported workspace documents fail closed.

### Integration acceptance

1. Open a project and create a shell with `Ctrl+T`.
2. Create a Coven chat with `Ctrl+A`.
3. Add, move, and resize panes across row and column splits.
4. Hide one live pane and focus another.
5. Quit Psyche without stopping sessions.
6. Confirm the underlying tmux sessions remain live.
7. Reopen Psyche and confirm every visible and hidden session, pane topology,
   split ratio, project/worktree assignment, and focus state is restored.
8. Confirm terminal scrollback and interactive processes continue from before
   the quit.
9. Use **Stop and close** on one pane and confirm only that tmux session and
   descriptor are removed.
10. Force-close Psyche, reopen it, and confirm the last successfully persisted
    state restores without terminating live sessions.
