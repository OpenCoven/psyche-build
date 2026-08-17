# Coven Code Agent Mode

**Date:** 2026-08-17
**Status:** Approved

## Goal

Agent mode must always launch and identify Coven Code. Psyche must not launch,
display, or persist Coven Chat for a new agent-mode pane.

## Required Behavior

Every explicit Coven agent action uses the resolved `coven` executable with:

```text
coven code --session-id <id>
```

This applies to:

- the Coven Code entry in the agent picker;
- the Ctrl+A/new-agent action;
- `/new-thread`; and
- **Open Coven Terminal**.

New panes use `Coven Code` as their display name and `coven-code` as both their
pane kind and launch kind. They retain the existing secure session ID,
`COVEN_SESSION_SOURCE=psyche-build`, project root, worktree path, and Coven
metrics provider.

`coven-attach` remains a separate kind because it attaches to an existing
daemon session rather than launching a new agent-mode session.

## Architecture

Keep one canonical Coven Code launch path. The launch option, explicit action
handlers, pane creation, retry behavior, deduplication, persistence, metrics,
and session discovery must all use the same `coven-code` identity.

The canonical launch descriptor contains:

```text
command: resolved Coven executable
args: ["code", "--session-id", generated session ID]
kind: "coven-code"
launchKind: "coven-code"
name: "Coven Code"
metricsProvider: "coven"
env.COVEN_SESSION_SOURCE: "psyche-build"
```

No new runtime path may create, compare, display, or persist `coven-chat`.

## Persistence Migration

Workspace restore recognizes the exact legacy pane kind and launch kind
`coven-chat` only at the persistence boundary. It converts those values to
`coven-code` before the restored pane enters application state.

The next workspace save writes only the migrated `coven-code` form. Unknown
kinds remain subject to the existing validation rules and are not silently
coerced.

This migration preserves existing saved panes while making `coven-code` the
only active identity after restore.

## Data Flow

New agent-mode launch:

```text
explicit user action
  -> canonical Coven Code launcher
  -> generate secure session ID
  -> create coven-code pane
  -> execute coven code --session-id <id>
  -> persist coven-code metadata
```

Legacy workspace restore:

```text
read persisted pane
  -> detect exact coven-chat legacy identity
  -> normalize kind and launchKind to coven-code
  -> restore pane
  -> save migrated metadata
```

Existing daemon-session attachment:

```text
select daemon session
  -> create or focus coven-attach pane
  -> execute the existing attach flow
```

## User Interface

Agent-mode UI uses `Coven Code` consistently. Picker command hints, new-pane
labels, command descriptions, success messages, pane titles, status messages,
help text, and smoke instructions must not describe a new launch as Coven Chat
or `coven chat`.

Historical design documents may continue describing the behavior that existed
when they were written. Current product documentation and active test
expectations must describe Coven Code.

## Error Handling

The existing explicit failures remain authoritative:

- missing Coven executable;
- missing project or selected worktree;
- secure session ID generation failure;
- invalid launch descriptor; and
- PTY startup or retry failure.

Failures must remain visible through the existing status and pane lifecycle.
Psyche must not fall back to `coven chat`, another agent, or an untracked shell
command.

The persistence migration is exact and fail-closed. It rewrites only the known
legacy `coven-chat` value.

## Verification

Focused automated coverage must prove:

- every new Coven agent launch executes `code --session-id`;
- every agent-mode launch surface routes through the canonical Coven Code
  launcher;
- new pane and launch metadata use `coven-code`;
- UI labels and command hints use `Coven Code` and `coven code`;
- legacy persisted `coven-chat` panes restore as `coven-code`;
- the migrated workspace is re-saved without `coven-chat`;
- deduplication still focuses a matching visible live pane;
- retry retains the exact Coven Code launch descriptor;
- Coven metrics and daemon-session association still work for launched panes;
- `coven-attach` behavior is unchanged; and
- active source, product documentation, smoke instructions, and tests contain
  no Coven Chat launch contract.

Run the focused native desktop Vitest suites that cover agent picking, Coven
launching, persistence, footer metrics, and session discovery, followed by the
native desktop build or repository typecheck required by the touched surfaces.

## Scope

This change does not alter daemon APIs, terminate existing sessions, change
session provenance, rename `coven-attach`, or modify non-Coven agent launchers.
It removes the legacy Coven Chat identity from active agent-mode behavior while
preserving old saved panes through one bounded restore migration.
