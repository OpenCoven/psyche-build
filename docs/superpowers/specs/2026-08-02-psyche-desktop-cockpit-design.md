# Psyche Desktop Cockpit

> **Status: implemented, extended.** Written 2026-08-02, landed 2026-08-03 as a
> record of a decision already carried out — the Comux strip-out is done, the
> Tauri app is `native/macos/psyche-build-tauri` (`dev.opencoven.psyche`), and
> the cockpit exists. Since then the workspace has grown a read-only inspection
> rail (Browser, Files, Diffs, Git) and an editable code editor with a
> virtualized diff viewer. Read this for why the desktop workspace is shaped the
> way it is; see the follow-on specs listed under "Delivered Increments" for the
> panel and editor work that has since landed on top of it.

## Goal

Make Psyche Build the desktop coding workspace that succeeds the original
Comux desktop application. Preserve the native desktop and terminal experience
already present in the Psyche Build repository, while replacing Comux-specific
identity, state, and orchestration with Psyche.

Coven Cave remains a separate familiar and control-room application. CastCodes
is not reused. Editor and diff surfaces were out of scope for this founding
milestone but have since been added as separate increments (see "Delivered
Increments").

## First Release

The first release restores a usable desktop cockpit for Psyche projects:

- A persistent project switcher for multiple local projects.
- A project-scoped cockpit listing Psyche worktrees and lanes.
- Live, attachable terminal surfaces for running lanes.
- Psyche-native lane creation and lifecycle controls.
- Aggregated background activity and attention state in the project switcher.
- Reconnection to existing Psyche and tmux state after app restart.

The desktop window does not own lane processes. A project switch changes only
the rendered cockpit; lanes in other projects remain active.

## Architecture

The implementation lives in `native/macos/psyche-build-tauri`, the
Comux-derived desktop package renamed to `dev.opencoven.psyche`; it does not
create a fresh application or adopt CastCodes. The original `comux-tauri`
directory remains only as a stripped legacy stub. The shell is a no-bundler
Tauri 2 app whose static `web/` frontend (`main.js`, xterm terminals) talks to
a Rust backend over IPC commands.

The native desktop shell continues to host terminal surfaces. Its backend
reads Psyche project configuration and tmux state, then exposes project and
lane data to the frontend. The frontend renders that data without inventing a
second source of truth.

Psyche remains authoritative for worktree creation, orchestration, lifecycle
actions, and project configuration. The desktop layer invokes Psyche's
existing commands and APIs rather than reimplementing Git, tmux, or agent
process management.

## Project Navigation

The left rail presents remembered local projects. Each entry shows:

- Project name and path.
- Running-lane count.
- Attention-needed state.

Selecting a project loads its cockpit without affecting lanes in any project.
The last selected project is restored on app launch. Projects with active or
attention-needed lanes remain visibly distinct in the switcher.

## Project Cockpit

The active project view displays its Psyche worktrees and lanes. A lane
provides its worktree and branch identity, runtime status, and an attachable
terminal surface.

Creating a lane uses Psyche's existing worktree and orchestration flow. The
desktop UI may collect the inputs and render progress, but it does not create
branches or worktrees independently.

The cockpit marks a lane as needing attention when its process exits, fails,
or is awaiting terminal input. Project attention is the aggregate of its lane
states.

## Lifecycle and Recovery

Closing or restarting the desktop app never stops active lanes. On startup,
the shell discovers existing Psyche configuration and tmux sessions, restores
the last project when available, and reconciles rendered lane state with the
runtime.

A missing tmux session, missing worktree, or inconsistent project record is
shown as recoverable state with refresh or reconcile actions. The desktop
shell must not silently recreate sessions, worktrees, or branches, and must
not silently delete stale records.

Stop, archive, remove-worktree, merge, and branch-deletion actions remain
explicit and use Psyche's existing confirmation rules. Failed actions expose
the underlying error and leave the current state visible for recovery.

## Non-Goals

This founding milestone excluded, and the desktop shell still does not:

- Reuse or integrate CastCodes.
- Integrate with Coven Cave.
- Introduce a new independent desktop package.
- Change Psyche's agent, Git, or tmux authority model.

Editor and diff surfaces, originally listed here as non-goals, were delivered
as later increments (see "Delivered Increments"). Those increments remain
read-mostly: the inspection panels and diff viewer perform no staging,
committing, merging, branch deletion, or worktree cleanup, and the editor adds
only contained file edits — never file creation or deletion, language servers,
autocomplete, formatting, or side-by-side diffs. Lifecycle mutations still flow
through Psyche's existing confirmation-gated flows.

## Delivered Increments

The following specs describe work layered on top of this cockpit foundation and
already landed on `main`:

- `2026-08-03-macos-workspace-panels-design.md` — a read-only right rail with
  Browser, Files, Diffs, and Git panels, scoped to the selected project root
  with a canonicalizing containment boundary.
- `2026-08-03-macos-code-editor-diff-viewer-design.md` — a locally bundled
  CodeMirror 6 editor with explicit atomic saves and optimistic conflict
  detection, plus a virtualized, read-only unified diff viewer.

These increments preserve the cockpit's invariants: Psyche stays authoritative
for orchestration and lifecycle, the desktop shell never owns lane processes,
and no panel silently creates or removes runtime resources.

## Acceptance Criteria

- A native Psyche desktop app opens its restored Comux-derived cockpit.
- Users can add, select, and persist multiple local Psyche projects.
- Selecting a project does not interrupt lanes in another project.
- The switcher exposes background running and attention-needed state.
- The active project displays real Psyche worktrees, lanes, and attachable
  terminals.
- Restarting the desktop UI reconnects to active Psyche and tmux state.
- Destructive actions retain explicit confirmation and no recovery path
  silently creates or removes runtime resources.
- Existing Psyche CLI, terminal cockpit, and smoke coverage remain intact.

## Validation Strategy

Implementation will add focused tests for project persistence, switching,
attention aggregation, and recovery-state rendering. Integration coverage will
exercise the desktop/backend contract against an isolated tmux server and
temporary Git projects. Manual validation will open the packaged desktop app,
start a lane in one project, switch to another, restart the UI, and verify
that the original lane remains visible and attachable after reconciliation.
