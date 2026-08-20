# Coven Code Picker Launch

**Date:** 2026-08-20
**Status:** Approved

## Goal

Selecting **Coven Code** from the new-agent picker must launch Coven Code through
the resolved Coven executable. It must never open Codex or fall through to the
generic Codex agent launcher.

## Required Behavior

The Coven Code picker entry launches the canonical descriptor:

```text
command: resolved Coven executable
args: ["code", "--session-id", generated session ID]
kind: "coven-code"
launchKind: "coven-code"
name: "Coven Code"
metricsProvider: "coven"
env.COVEN_SESSION_SOURCE: "psyche-build"
```

The generated session ID, active project root, and selected worktree remain
required. The Codex picker entry continues launching `codex` independently.

## Architecture

Keep `covenCodeLaunch`, `spawnCovenThread`, and `ensureProjectCoven` as the one
canonical Coven Code creation path. The Coven Code picker selection bypasses
the generic CLI-agent branch and delegates directly to that path.

The picker must identify Coven Code by its stable `coven-code` ID. Its launch
must not consume the Codex registry entry, Codex command, or a stale generic
agent selection. Other registered agents continue using the existing generic
launcher.

No picker-specific duplicate of the Coven launch descriptor is added. This
prevents the picker command from drifting away from `/new-thread`, Open Coven
Terminal, retry, persistence, metrics, and native launch validation.

## Data Flow

```text
select Coven Code in new-agent picker
  -> resolve stable coven-code selection
  -> validate project, worktree, and resolved Coven executable
  -> ensureProjectCoven(project)
  -> spawnCovenThread(project, worktree)
  -> covenCodeLaunch(project, worktree)
  -> execute coven code --session-id <generated-id>
```

Selecting Codex remains:

```text
select Codex CLI
  -> generic agent launcher
  -> execute codex
```

## Error Handling

Existing explicit failures remain authoritative:

- no open project;
- no selected worktree;
- missing Coven executable;
- secure session ID generation failure; and
- PTY creation or startup failure.

The Coven Code selection must not recover from any failure by launching Codex,
another agent, or a bare shell. Existing status messages remain visible.

## Verification

Focused automated coverage must prove:

- the Coven Code picker entry delegates only to the canonical Coven launcher;
- the resulting launch descriptor uses the resolved Coven executable;
- its arguments are exactly `code --session-id <generated-id>`;
- its pane identity is `coven-code` and its display name is `Coven Code`;
- the Coven launch cannot consume the Codex command or generic Codex path;
- missing Coven CLI reports the existing error without fallback; and
- selecting the Codex entry still launches `codex`.

Run the focused Tauri agent-picker and Coven-launch Vitest suites.

## Scope

This patch does not change Coven daemon attachment, existing session rows,
Codex behavior, other agent launchers, persistence formats, or native session
protocols. It only hardens the new-agent picker boundary so the Coven Code
selection always uses the canonical Coven Code launch path.
