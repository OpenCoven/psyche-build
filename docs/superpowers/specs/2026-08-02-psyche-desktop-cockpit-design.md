# Psyche Desktop Cockpit

## Goal

Make Psyche Build the desktop coding workspace that succeeds the original
Comux desktop application. Preserve the native desktop and terminal experience
already present in the Psyche Build repository, while replacing Comux-specific
identity, state, and orchestration with Psyche.

Coven Cave remains a separate familiar and control-room application. CastCodes
and editor parity are not part of this milestone.

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

The implementation extends the existing Comux-derived desktop package inside
`psyche-build`; it does not create a separate application or adopt CastCodes.

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

This milestone excludes:

- Code-editor parity.
- A full diff or review workspace.
- CastCodes integration or reuse.
- Coven Cave integration.
- A new independent desktop package.
- Changing Psyche's agent, Git, or tmux authority model.

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
