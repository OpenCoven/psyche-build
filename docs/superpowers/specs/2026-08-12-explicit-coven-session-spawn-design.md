# Explicit Coven Session Spawning

## Problem

The native macOS app creates a Coven session as a side effect of ordinary
workspace lifecycle operations. App boot, project opening, and project or
worktree activation call `ensureProjectCoven`. The helper creates a new
`coven code --session-id <id>` process whenever no matching visible local pane
exists.

Daemon sessions outlive the local UI state that initiated them. Restarting the
app, hiding a pane, or revisiting a project can therefore register another live
session for the same work. The Sessions rail correctly renders the distinct
daemon IDs it receives, but the user experiences them as repeated copies of one
session.

## Required Behavior

Psyche must create a Coven session only after an explicit user action.

The following lifecycle operations must not create a new Coven session or
attach a daemon session that is not already represented by a local pane:

- application boot;
- opening or restoring a project;
- switching projects;
- selecting or activating a worktree; and
- restoring a saved workspace layout.

These operations may continue discovering and rendering existing daemon
sessions. They may also preserve the normal workspace layout and focus an
already-open local pane. A user may explicitly attach to a discovered daemon
session from its rail row.

The following explicit actions may create or open a Coven terminal:

- the **Open Coven Terminal** worktree action;
- the Coven entry in the agent picker;
- the existing new-session command; and
- selecting an existing Coven daemon session row, which attaches instead of
  creating a new daemon session.

An explicit request that targets a visible live local Coven pane should focus
that pane. Concurrent explicit requests for the same project and worktree must
continue sharing the existing `covenEnsureFlights` operation so one user action
cannot create duplicate processes through event re-entry or double activation.

## Architecture

Keep `covenChatLaunch`, `spawnCovenThread`, and `ensureProjectCoven` as the
single Coven creation path. Change only its callers:

1. Remove `ensureProjectCoven` from boot, project-open completion, and
   project/worktree activation paths.
2. Preserve calls made by controls whose labels and intent explicitly request
   a Coven terminal.
3. Leave daemon discovery, session assignment, rail rendering, attach behavior,
   PTY launch validation, and normal restoration of existing local panes
   unchanged.

No preference or migration flag is added. Explicit-only behavior is the
default and sole policy.

## Data Flow

Passive workspace lifecycle:

```text
boot/open/activate
  -> restore project and worktree state
  -> refresh UI and daemon discovery
  -> no Coven PTY launch
```

Explicit new Coven request:

```text
user action
  -> ensureProjectCoven(project)
  -> reuse matching visible live pane, or share matching in-flight request
  -> spawnCovenThread
  -> covenChatLaunch creates one secure session ID
  -> start one validated Coven PTY
```

Existing daemon session selection:

```text
session row click
  -> attach flow for that daemon session ID
  -> no new Coven daemon session ID
```

## Error Handling

Passive lifecycle operations no longer depend on Coven availability and must
not show launch errors. Explicit creation retains the existing errors for a
missing Coven executable, unavailable pane space, invalid project or worktree
selection, and PTY startup failure.

Removing implicit calls must not replace failures with silent fallback
spawning. Discovery failures continue using the existing stale or unavailable
rail state.

## Verification

Focused tests must prove:

- boot with a restored or newly added project performs no Coven launch;
- project opening performs no Coven launch;
- project and worktree activation perform no Coven launch;
- passive lifecycle operations still refresh the expected workspace UI;
- passive restoration may focus an already-open local pane but does not launch
  a new Coven PTY;
- **Open Coven Terminal**, the Coven agent picker entry, and the new-session
  command each retain their explicit launch behavior;
- an existing visible live Coven pane is focused rather than duplicated;
- concurrent explicit requests for one project and worktree share one launch;
- clicking an existing daemon session attaches to its ID without creating a
  new session; and
- existing Coven discovery, row deduplication, and lifecycle tests remain
  unchanged and passing.

## Scope

This change does not terminate existing daemon sessions, rewrite daemon
records, alter session provenance, deduplicate different daemon IDs by title,
or add automatic daemon-session resume behavior. Existing duplicate sessions
remain visible until they complete or the user stops them; the fix prevents
passive app lifecycle events from creating more.
