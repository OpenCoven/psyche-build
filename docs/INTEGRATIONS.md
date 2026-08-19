# Psyche Build integrations

Psyche Build's core tmux, git-worktree, pane, file-browser, merge, pull-request,
ritual, settings, and cleanup workflows work without optional integrations.

## Supported coding agents

Psyche Build detects supported agent CLIs from the launch environment and runs
each selected agent inside a Psyche-managed pane and worktree. Agent-specific
permission flags are configured by Psyche Build; installation, accounts, and
provider behavior remain owned by the agent CLI.

## Optional local session provider

When a compatible local Coven daemon is available, Psyche Build can list,
launch, and attach project-scoped sessions. Psyche Build verifies the canonical
project root before exposing a session and keeps unavailable states non-fatal.
The integration is optional and does not replace Psyche Build's ordinary agent
or terminal panes.

## Failure behavior

Missing, stopped, incompatible, or malformed integrations stay isolated from
Psyche Build's core workflow. Psyche Build reports the unavailable integration
without disabling panes, worktrees, file browsing, merges, pull requests, or
cleanup.
