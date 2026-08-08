# Native Coven Physical Panes Design

**Date:** 2026-08-08
**Status:** Revised
**Supersedes:** The app-origin-only rail behavior in
`docs/superpowers/specs/2026-08-05-app-origin-session-rail-design.md`

## Goal

Make the interactive Coven experience the default terminal session in the
macOS Psyche workspace. Each new or attached Coven session runs in an
independent Tauri-owned PTY and appears as a simultaneously visible terminal
pane. Native create and attach flows must not create, attach to, or depend on a
Psyche tmux session.

The legacy Psyche CLI/TUI remains tmux-backed. `/new-psyche` is the explicit
escape hatch for opening that experience inside a native PTY; this work does
not rewrite its runtime.

## Product decisions

1. **Use the canonical `coven` launcher.** New interactive panes execute
   `coven chat`; attached panes execute `coven attach <session-id>`. The Tauri
   PTY sets the selected worktree as the child working directory. The app does
   not depend on a separately discoverable `coven-code` binary or an unverified
   `--cwd` flag.
2. **Keep native PTYs outside the root daemon pane authority.** The completed
   `ControlRuntime` cutover remains authoritative for root-daemon mutations.
   These panes are a separate Tauri-owned process surface, so native create and
   attach do not call `coven.session.open` or `openProjectCovenSession`; that
   compatibility path ultimately creates a tmux pane.
3. **Keep process state and layout state separate.** `state.threads` owns PTY
   lifecycle and Coven attachment metadata. A pure pane tree owns only
   placement, split ratios, and focus.
4. **Do not auto-recreate terminal processes after app restart in v1.** Pane
   topology survives project and worktree switches during the app process, but
   is not persisted to disk. On restart the active worktree receives one fresh
   `coven chat` pane; durable sessions remain available through discovery and
   explicit attach. This avoids silently launching several new sessions or
   guessing how an uncorrelated local process maps to a daemon session.
5. **Reintroduce daemon sessions intentionally.** The session rail remains
   app-origin-owned for local rows, but adds a distinct project-scoped Coven
   subsection backed by the existing bounded native discovery adapter. Remote
   rows are explicit attach/focus actions, not implicit local threads.

## Current state

The native app already owns one PTY per local thread through `pty_start`,
`pty_write`, `pty_resize`, and `pty_stop`. Each thread mounts one xterm element,
but CSS hides every terminal except `activeThreadId`, so local threads behave
like mutually exclusive views.

Opening or restoring a project calls `ensureProjectPsyche`, which normally
starts the Psyche TUI and therefore tmux. The terminal-side `+`, Command-T, and
`/new-thread` create plain login shells. The top tab strip is reserved for open
files; it is not a terminal-session switcher.

The native Rust bundle already contains `coven_sessions`, including endpoint
precedence, stable API validation, canonical project scoping, timeouts,
response-size limits, and safe session-id normalization. A later
app-origin-only change removed its webview polling and remote rows but retained
the adapter and shared session model.

The root daemon now routes `coven.session.open` through `ControlRuntime`, but
its concrete handler still uses `openProjectCovenSession`, which creates a tmux
pane and sends `coven attach`. That is valid for legacy daemon clients and is
not the native app's attach path.

## Scope

This design owns:

- default `coven chat` creation for project open, terminal-side `+`,
  Command-T, and `/new-thread`;
- `/new-shell` for the existing plain login-shell behavior;
- project-scoped daemon session discovery and explicit native attachment;
- a visible, resizable terminal pane tree per project worktree;
- focus, hide/reopen, close, exit, retry, deduplication, and in-process
  project/worktree restoration;
- executable discovery and canonical native launch validation; and
- source-boundary regressions that prevent the native path from drifting back
  to tmux or the root daemon's compatibility open handler.

It does not:

- remove tmux from the CLI/TUI or change root-daemon control authority;
- alter Coven daemon persistence or session lifecycle semantics;
- persist or automatically recreate a multi-pane process layout across app
  restart;
- add arbitrary directional split commands, pane drag-and-drop, pane zoom, or
  cross-worktree pane moves;
- replace the file tab strip or the browser/editor/diff/Git panels;
- bundle or auto-install the `coven` CLI; or
- modify CastCodes.

## User experience

### Creating sessions

Opening a project creates or focuses a running `coven chat` pane for its
selected worktree. Switching to a project or worktree with no visible pane
creates one. Re-selecting the same project/worktree focuses its last active
pane and does not spawn another process.

When the terminal surface owns focus, the rail `+`, Command-T, and
`/new-thread` insert a new `coven chat` pane below the focused pane.
Browser-focused Command-T remains a browser-tab action. `/new-shell` creates a
plain login-shell pane, while `/new-psyche` preserves the explicit legacy TUI
path.

The first terminal fills the terminal host. Each additional terminal replaces
the focused leaf with a top/bottom split containing the old leaf first and the
new leaf second. Every leaf has a compact header with its title, status, focus
treatment, and close button. The divider supports pointer drag and keyboard
resize.

The app checks layout feasibility before creating a thread or starting a PTY.
If the candidate split cannot keep every descendant above the minimum terminal
width and height, the tree and process list remain unchanged and the project
status explains why the pane was not created.

### Opening existing sessions

The session rail shows local Psyche threads and daemon-discovered Coven
sessions as separate subsections within the existing project/worktree groups.
Selecting a Coven session is idempotent:

1. focus its visible native attachment leaf, if one exists;
2. reopen and focus its hidden native attachment thread, if one exists; or
3. reserve the `(canonical project root, session id)` pair, create one leaf,
   and execute `coven attach <session-id>` in the session's scoped worktree.

The reservation remains active until launch succeeds or fails, so concurrent
clicks cannot create duplicate attachment PTYs.

### Focus, hide, close, and exit

`activeThreadId` remains the single input target. Clicking a leaf, focusing its
xterm, or selecting its local rail row updates `activeThreadId`, the focused
leaf, project `lastActiveThreadId`, status chrome, and command-bar target.

Hiding a local thread removes its leaf without stopping the PTY. Reopening it
inserts it below the current focused leaf. Closing a leaf stops and disposes
only its Tauri PTY, removes the thread and leaf, collapses one-child ancestors,
and focuses the nearest surviving leaf in the same worktree. Closing an
attachment never kills, archives, or otherwise mutates the durable Coven
session.

When a PTY exits, its leaf remains visible in an exited state. Retry restarts
the saved launch descriptor in the same thread and leaf; Close removes it.
Retry is accepted only from an exited or failed state and cannot race another
start.

## Architecture

### Pane tree

Add a small pure module to the native web bundle:

```text
leaf  { type: "leaf", id, threadId }
split { type: "split", id, ratio, first, second }
```

Terminal splits are top/bottom. The browser's existing outer splitter remains
independent. Left/right terminal
splits are deferred until the product has a real interaction for creating
them; the process-local v1 model needs no speculative direction field.

The module exposes pure operations for:

- creating a single-leaf tree;
- inserting below the focused leaf;
- removing or hiding a leaf and collapsing one-child ancestors;
- finding a leaf by thread id;
- selecting the nearest surviving leaf;
- clamping a divider ratio against descendant minimum sizes; and
- projecting leaf rectangles for a measured terminal host.

It does not know about DOM nodes, xterm, Tauri commands, projects, or Coven
sessions.

Runtime layout state is keyed by project id and canonical selected-worktree
path:

```text
paneLayouts[projectId][worktreePath] = {
  root,
  focusedLeafId
}
```

Leaves reference threads by id; threads do not store `paneLeafId`. This avoids
two writable links for the same relationship. A thread retains:

```text
{
  id,
  projectId,
  worktreePath,
  kind: "coven-chat" | "coven-attach" | "shell" | "psyche",
  covenSessionId: string | null,
  launch: { command, args, env, projectRoot, cwd },
  status: "starting" | "running" | "exited" | "failed",
  startInFlight,
  closeStarted,
  term,
  fit,
  host
}
```

Switching projects or worktrees swaps the rendered tree without stopping
background PTYs. The layout map is process-local in v1. Existing workspace
persistence remains at version 2 and continues to store projects, worktrees,
browser state, and outer panel layout only.

### Rendering and resize flow

`terminal-host` becomes the pane-tree root. The renderer creates split
containers, separators, pane headers, and leaf hosts from the current tree.
Every leaf in the selected tree is visible; terminal hosts belonging to other
project/worktree trees remain mounted but hidden as a group.

The top tab strip continues to show files only. Local and attached terminal
navigation remains in the session rail and physical pane headers.

One `requestAnimationFrame` scheduler owns terminal fitting. It runs after pane
creation/removal, divider changes, project/worktree switches, file-to-terminal
transitions, outer terminal/browser splitter movement, and window resize. Each
frame calls `fit()` once for every visible leaf; existing xterm resize events
then call `pty_resize`. The old `fitActiveTerm` call sites migrate to this
visible-tree scheduler so sibling PTYs receive their real dimensions.

The browser/editor surface remains outside the pane tree. Its existing outer
splitter continues to divide the complete terminal workspace from the selected
right-side panel.

### Native launch contract

Reuse `StartOptions` and the existing Tauri PTY commands. Do not introduce a
second terminal transport or construct commands through a login shell.

Extend `AppEnvironment` with `coven_path`, resolved by a strengthened
`which_on_path("coven")` search over the augmented app PATH that requires a
regular executable file. V1 does not claim sidecar support because the current
Tauri bundle has no `externalBin` configuration. If `coven` is absent, the
webview receives `null` and leaves the current tree unchanged while rendering
an actionable project-status error.

Separate the current overloaded cwd field in `StartOptions`:

```text
projectRoot: <canonical project opened in Psyche>
cwd: <canonical project root, linked worktree, or descendant>
```

The Rust boundary validates `cwd` against `projectRoot`. For a non-Git project,
`cwd` must equal or descend from the canonical project root. For a Git project,
the same rule applies, and an external linked worktree is also allowed when its
canonical path appears in `git worktree list --porcelain` for that project.
Descendants of that linked worktree are then valid. Missing, bare, prunable,
or unrelated worktrees are rejected.

New interactive pane:

```text
command: <absolute coven_path>
args: ["chat"]
projectRoot: <canonical open project root>
cwd: <canonical selected worktree>
```

Existing session attachment:

```text
command: <absolute coven_path>
args: ["attach", <validated exact session id>]
projectRoot: <canonical owning project root>
cwd: <canonical session cwd or owning worktree>
```

The webview rejects session ids that fail `[A-Za-z0-9._:-]{1,128}`, but the
Rust launch boundary must not rely on webview validation alone.

Command, arguments, cwd, and environment remain separate through
`CommandBuilder`. `TMUX` is removed by the existing PTY boundary. Native Coven
launches do not set `TMUX_TMPDIR`; only `/new-psyche` receives the legacy tmux
isolation environment.

### Discovery and local/remote identity

Restore webview use of the existing `coven_sessions` command and shared session
model. Query with each open project root and each non-missing canonical
worktree returned for that project, then map every accepted root back to its
owning project/worktree. Preserve endpoint precedence, health/version checks,
canonical exact-root filtering, timeouts, response-size limits,
latest-request-wins behavior, and compact unavailable/incompatible/error
states. This explicit ownership map lets an external linked worktree appear
under its Psyche project without weakening the adapter's exact-root scope.

Discovery runs after boot, project add/remove, worktree refresh, visibility
return, and successful local Coven start/attach. Polling runs only while the
window is visible and at least one project is open; hiding or closing the
window cancels its timer. A failed refresh keeps the last confirmed rows
visible with a stale/error indicator rather than replacing them with an empty
list.

Daemon rows and local threads keep distinct keys (`coven:<session-id>` and
`psyche:<thread-id>`). An attached daemon row points to its local thread action
when `covenSessionId` matches, but it does not disappear or become the same
record.

`coven chat` owns any daemon session it creates. Psyche does not pre-create a
second session and does not infer correlation from title, time, cwd, or
process. Until Coven exposes a stable process/session correlation identifier,
a new chat thread and a newly discovered daemon row remain separately
addressable.

## Operation flows

### Create a Coven pane

1. Resolve the active project and canonical selected worktree.
2. Require a resolved executable `coven_path`; otherwise leave state unchanged
   and report installation/PATH guidance.
3. Build and validate the candidate pane tree against the measured host.
4. Create the thread and leaf, mount xterm, and focus the leaf.
5. Start `<coven_path> chat` with discrete arguments, project scope, and
   worktree cwd.
6. Mark the leaf running, or retain it with an actionable failed state.
7. Refresh discovery after a successful start without blocking terminal input.

### Attach a Coven session

1. Require a normalized daemon row in the active canonical project scope.
2. Focus or reopen an existing matching attachment thread.
3. Acquire the in-flight project/session reservation.
4. Build and validate the candidate pane tree.
5. Create the thread and leaf and run
   `<coven_path> attach <exact-session-id>` with discrete arguments.
6. Release the reservation after success or failure.
7. Retain failures in the same leaf for Retry or Close.

### Close a pane

1. Set `closeStarted`; repeated close requests become no-ops.
2. Remove the leaf from the visible tree and choose local successor focus.
3. Call `pty_stop` once, then dispose xterm and remove the thread.
4. Collapse empty split structure and render the remaining tree.
5. Do not send a Coven kill/archive/sacrifice command.

## Error handling

- **Missing Coven CLI:** Leave the current tree and process list unchanged and
  show installation/PATH guidance in project status. Never fall back to a
  shell, Psyche TUI, tmux, or a shell-constructed command.
- **Daemon unavailable:** New `coven chat` panes remain available. Discovery
  shows stale confirmed data when present and a compact unavailable state
  otherwise.
- **Attach target disappears:** Keep the leaf and terminal output visible.
  Retry first refreshes discovery and proceeds only if the exact scoped session
  still exists.
- **Unsafe or out-of-scope session:** Do not render or attach it. Rust remains
  the final cwd-containment authority.
- **Insufficient pane space:** Leave layout and thread state unchanged and
  report the minimum-size constraint.
- **PTY start failure or exit:** Retain one leaf with Retry and Close. Do not
  create a replacement automatically.
- **Project close:** Stop each local PTY exactly once and discard its in-memory
  pane trees without mutating durable Coven sessions.
- **Malformed saved workspace:** Existing workspace sanitization continues to
  recover project/browser state; there is no persisted pane schema to migrate
  in v1.

## Security and reliability constraints

- Keep executable, arguments, cwd, and environment separate through
  `CommandBuilder`; never interpolate a session id, path, title, or prompt into
  shell text.
- Resolve `coven` to an absolute executable path through the existing augmented
  PATH logic.
- Canonicalize project roots and launch cwd in Rust; allow only descendants or
  Git-verified linked worktrees, and reject symlink and sibling-prefix escapes.
- Validate exact discovered session ids at both webview and Rust boundaries.
- Never inherit `TMUX` into a native Coven PTY.
- Do not log prompts, terminal contents, credentials, or daemon response
  bodies.
- Reserve attach identity before changing layout or starting a PTY.
- Guard start and close transitions so each PTY starts and stops at most once
  per state transition.
- Keep `openProjectCovenSession` for legacy daemon clients, but add a
  native-source regression proving the macOS create/attach path cannot call it,
  `coven.session.open`, `createTmuxPane`, or tmux commands.

## Delivery sequence

### PR 1 — Physical pane foundation

- Add the pure pane-tree module and focused Vitest coverage.
- Render all leaves for the selected project/worktree with accessible
  separators and pane headers.
- Replace active-only fitting with one visible-tree resize scheduler.
- Preserve current shell/Psyche launch behavior in this PR.

### PR 2 — Default Coven launch

- Split project scope from cwd in `StartOptions`, add canonical Rust
  root/worktree validation, and expose `coven_path`.
- Add `coven-chat` launch descriptors and make project open, terminal `+`,
  Command-T, and `/new-thread` use `coven chat`.
- Add `/new-shell`; preserve `/new-psyche`.
- Add missing-binary, start/exit/retry, hide/reopen, and close behavior.

### PR 3 — Discovery and native attach

- Restore bounded discovery lifecycle and remote rail rows, explicitly
  replacing the app-origin-only UI contract.
- Add attachment focus/reopen/deduplication and exact native launch.
- Add the tmux/control-handler source boundary and packaged multi-PTY smoke.

Each PR is independently reviewable. PR 1 changes layout only, PR 2 changes the
default local process, and PR 3 reintroduces daemon-derived UI and attachment.

## Verification

### Pure webview tests

- single leaf, insertion below focus, nested insertion, removal, collapse, and
  nearest local focus;
- stable leaf ids and no thread-to-leaf back-reference;
- ratio/minimum clamping and candidate rejection before thread creation;
- pointer and keyboard separator behavior with correct ARIA values;
- one animation-frame resize pass fitting every visible xterm exactly once;
- project/worktree tree isolation and in-process restoration;
- file tab strip remains file-only;
- local/remote grouping with distinct identities;
- concurrent attach clicks create one leaf and one PTY start; and
- hide/reopen, failed retry, exited retry, and idempotent close transitions.

### Native and contract tests

- `coven_path` resolution through augmented PATH and the missing-binary state;
- new chat launches absolute `coven`, `chat`, canonical project scope, and
  canonical cwd as separate values;
- attach launches absolute `coven`, `attach`, and the validated exact id as
  separate values;
- canonical cwd containment, external linked-worktree acceptance, and
  unrelated/symlink/sibling-prefix escape rejection;
- unsafe session-id rejection at the Rust boundary;
- discovery success, unavailable, incompatible, malformed, stale, and recovery
  states; and
- source guards proving native create/attach paths contain no tmux mutation and
  do not invoke the root `coven.session.open` compatibility path.

### Regression and end-to-end gates

- existing CLI/TUI tmux and daemon `ControlRuntime` tests remain unchanged;
- focused Vitest suites for pane layout, rail rendering, lifecycle, and PTY
  contracts;
- `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm smoke`, and
  `pnpm smoke:pack`;
- in `native/macos/psyche-build-tauri/src-tauri`, `cargo fmt --check`,
  `cargo test --locked`, and `cargo check --locked`;
- native `pnpm build:web` and an unsigned packaged-app build; and
- packaged smoke proving two simultaneous `coven chat` panes, divider resize,
  focus/input isolation, project/worktree switching, existing-session
  attach/focus, close without durable-session kill, daemon-unavailable local
  launch, `/new-shell`, and explicit `/new-psyche`.

No implementation branch is ready until the packaged app has been inspected
with multiple live PTYs and the complete owning verification surface passes.
