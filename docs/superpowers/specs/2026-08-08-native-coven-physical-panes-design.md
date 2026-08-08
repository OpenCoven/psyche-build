# Native Coven Physical Panes Design

## Goal

Make Coven Code the default session experience in the macOS Psyche workspace.
Creating a session or opening an existing Coven session must use an independent
native Tauri PTY rendered as a visible physical pane. Neither flow may create,
attach to, or depend on a Psyche tmux session.

The legacy Psyche CLI/TUI and its explicit `/new-psyche` desktop action remain
tmux-backed. This change does not rewrite that runtime.

## Current state and scope

The native app already owns one PTY per local thread through `pty_start`,
`pty_write`, `pty_resize`, and `pty_stop`. The webview mounts one xterm instance
per thread, but the terminal host presents only the active instance, so threads
behave as tabs rather than simultaneously visible panes.

Opening a project currently calls `ensureProjectPsyche`, which normally starts
the Psyche TUI and therefore tmux. The `+` button, Command-T, and `/new-thread`
create a plain login shell. The codebase also contains project-scoped Coven
session discovery and normalization, but the current macOS session renderer is
intentionally local-only. The root daemon's `openProjectCovenSession` still
creates a tmux pane and sends `coven attach`; that compatibility path is not to
be used by the native app after this work.

This slice owns:

- default Coven Code session creation in the macOS app;
- project-scoped discovery and display of existing Coven sessions;
- native PTY attachment to a selected Coven session;
- a visible, resizable physical terminal-pane tree; and
- focus, deduplication, close, failure, and restoration behavior for those
  panes.

It does not remove tmux from the CLI/TUI, change Coven daemon persistence,
replace the browser/editor/diff panels, add arbitrary terminal tiling commands,
or modify CastCodes. CastCodes is the interaction precedent, not a runtime
dependency.

## User experience

Opening a project creates or focuses a Coven Code pane rooted at the selected
worktree. The session `+` button and Command-T do the same when focus is on the
terminal workspace. Browser-focused Command-T remains a browser-tab action.
`/new-thread` becomes a new Coven Code pane; `/new-shell` is added for the
existing plain-shell behavior. `/new-psyche` remains the explicit legacy TUI
escape hatch.

The first terminal occupies the complete terminal workspace. Creating another
session inserts a sibling physical pane beside the focused pane. The default
insertion is below the focused pane, matching the stacked layout in the
approved reference. Every pane has a compact header with its title, status,
focus treatment, and close button. Dividers are draggable and keyboard
operable. A pane has a practical minimum width and height; when the container
cannot satisfy those minima, the new pane is rejected with an inline status
instead of producing an unusable terminal.

Clicking a project-scoped Coven session in the rail behaves idempotently:

1. focus the physical pane already carrying that session id; or
2. create a native pane and run the safe attach command for that session.

Closing a pane stops only its local PTY attachment. It does not kill, archive,
or otherwise mutate the durable Coven session. Session kill and archive actions
are outside this slice.

## Architecture

### Workspace pane model

Add a small pure pane-tree module under the native web bundle. The tree has two
node types:

```text
leaf  { id, threadId }
split { id, axis: "row" | "column", ratio, first, second }
```

`row` places children left/right and `column` places them top/bottom. New Coven
panes replace the focused leaf with a `column` split whose first child is the
existing leaf and whose second child is the new leaf. Ratios clamp so both
descendants retain their minimum dimensions.

The canonical thread model remains the owner of PTY identity and lifecycle.
Each Coven thread adds:

```text
{
  kind: "coven-code" | "coven-attach",
  covenSessionId: string | null,
  projectId: string,
  worktreePath: string,
  paneLeafId: string
}
```

The pane tree owns only layout and focus. It never writes to PTYs or duplicates
session metadata. Removing a thread removes its leaf, collapses any one-child
split, and selects the nearest surviving leaf.

Pane layout is scoped per project and selected worktree. Switching projects or
worktrees swaps the visible tree without stopping background PTYs. The first
version persists split shape, ratios, titles, and Coven session ids, but not
live process handles. On app restart, ordinary Coven Code leaves start fresh;
attach leaves reconnect to their durable session after session discovery
confirms it still exists. Invalid or stale leaves are omitted.

### Native PTY launch contract

Reuse the existing Tauri PTY commands and `CommandBuilder`; do not add another
terminal transport. Extend environment discovery with the resolved Coven Code
executable and expose that path to the webview. Resolution uses the packaged
sidecar when present, then the app's augmented PATH. It never invokes a login
shell to construct a command.

A new Coven Code leaf starts the resolved executable with argument values,
including the selected worktree as `--cwd <path>`. Arguments are passed as an
array through `StartOptions`; paths, prompts, titles, and session ids are never
interpolated into shell text.

Opening an existing daemon session starts `coven attach <session-id>` directly
in its project/worktree directory. The native app validates the id against the
existing `[A-Za-z0-9._:-]{1,128}` contract before starting the PTY. This is a
native PTY attachment and must not call `coven.session.open`,
`openProjectCovenSession`, `createTmuxPane`, or any `tmux` command.

### Coven discovery and session creation

Restore the existing native `coven_sessions` discovery state to the current
local-only rail renderer, retaining its endpoint precedence, health-version
check, canonical project scoping, timeout, and response-size guard.

The rail shows local physical panes and remote Coven sessions under the same
project/worktree grouping. A remote row whose id is already attached points to
that leaf rather than rendering as a duplicate local action.

Default session creation is a local interactive Coven Code process. Psyche does
not pre-create a second daemon session before launching the interactive client;
Coven Code remains responsible for registering its own durable session. This
slice does not correlate the local leaf to a newly discovered daemon session,
because the current stable contract exposes no process/session correlation id.
The local leaf and daemon row remain separately addressable; the renderer never
guesses identity from title or timestamps.

Prompt-driven daemon launch through the root orchestration API remains a legacy
caller outside this native slice. If a later native surface adopts that API, it
must request harness `coven-code` and attach the result through a native leaf,
not through the root tmux open handler.

### Rendering and resize flow

`terminal-host` becomes the pane-tree container. Every visible leaf mounts its
existing `.term-instance`; inactive leaves are no longer globally hidden.
Clicking or focusing a terminal sets both `activeThreadId` and the focused leaf.
The tab strip remains a compact global session switcher: selecting a tab focuses
and reveals its physical leaf rather than hiding sibling panes.

Pane-tree layout emits a set of leaf rectangles. After creation, divider drag,
container resize, browser-panel resize, or project switch, the renderer fits
each visible xterm and lets its existing resize callback call `pty_resize`.
Updates are coalesced through one animation frame to avoid resize storms.

The browser/editor surface remains outside the terminal pane tree. Its existing
outer splitter continues to divide the complete terminal workspace from the
selected right-side panel.

## Error handling

- If Coven Code is unavailable, keep the new leaf visible with an actionable
  `Coven Code not found` error and installation/PATH guidance. Do not fall back
  to a shell, Psyche TUI, or tmux.
- If the Coven daemon is unavailable, new local Coven Code panes still work.
  The rail shows its existing compact unavailable state for remote sessions.
- If attach fails, keep the leaf and terminal output visible with Retry and
  Close actions. Retry reuses the same leaf and never creates a duplicate.
- If a remote session is outside the canonical project scope or has an unsafe
  id, do not render or attach it.
- If a split cannot meet minimum dimensions, leave the current tree unchanged
  and report the constraint through the project status surface.
- If a PTY exits, retain the leaf as exited until the user closes or retries it.
- If restoration cannot confirm an attach target, omit that leaf and preserve
  the rest of the valid tree.

## Security and reliability constraints

- Keep command and argument values separate all the way to `CommandBuilder`.
- Canonicalize every project/worktree root before launch and require the cwd to
  be equal to or inside an open project root.
- Use the existing safe Coven session-id contract and maximum length.
- Never inherit `TMUX` into a native Coven PTY.
- Do not log prompts, terminal contents, credentials, or daemon response bodies.
- Deduplicate attach requests before starting a PTY, including concurrent
  double-clicks, with an in-flight session-id reservation.
- Stop each native PTY exactly once when its leaf is explicitly closed. Closing
  a project closes its local PTYs but does not mutate durable Coven sessions.
- Keep `openProjectCovenSession` available only for legacy compatibility until
  its non-native consumers are migrated; add a native-source regression proving
  the macOS bundle cannot call it.

## Verification

### Pure webview tests

- insert below the focused leaf and preserve the previous leaf;
- nested insertion, split collapse, nearest-focus selection, and stable ids;
- ratio/minimum clamping plus pointer and keyboard divider updates;
- one animation-frame resize pass fits every visible terminal;
- project/worktree layout isolation and safe restoration;
- local/remote rail grouping and session-id deduplication;
- concurrent double-clicks create one attach leaf; and
- tab selection focuses a leaf without hiding its siblings.

### Native and contract tests

- Coven Code executable resolution for sidecar, augmented PATH, and missing
  binary states;
- `StartOptions` launches Coven Code with discrete `--cwd` arguments;
- attach launches `coven`, `attach`, and the validated id as discrete values;
- canonical cwd enforcement and unsafe session-id rejection;
- native Coven discovery success, unavailable, incompatible, malformed, and
  recovery states; and
- source guards proving native create/open paths contain no tmux calls and do
  not invoke the root `coven.session.open` compatibility handler.

### Regression and end-to-end gates

- existing CLI/TUI tmux tests continue to pass unchanged;
- focused Vitest suites for pane layout, session rendering, and PTY contracts;
- `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm smoke`, and
  `pnpm smoke:pack`;
- in `native/macos/psyche-build-tauri/src-tauri`, `cargo fmt --check`,
  `cargo test --locked`, and `cargo check --locked`;
- native `pnpm build:web` and an unsigned packaged-app build; and
- packaged smoke proving two simultaneous Coven Code panes, divider resizing,
  focus/input isolation, existing-session attach/focus, close without session
  kill, daemon-unavailable local launch, and explicit `/new-psyche` legacy
  behavior.

No implementation commit is ready until the packaged app has been inspected
with multiple live PTYs and the complete owning verification surface passes.
