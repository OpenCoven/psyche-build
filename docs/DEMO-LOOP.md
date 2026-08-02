# psyche + Coven demo loop

This walkthrough covers the local developer loop for using psyche as the visible cockpit for Coven-backed coding sessions.

## Prerequisites

- tmux 3.0+
- Node.js 18+
- Git 2.20+
- Coven installed locally

Before opening psyche, confirm Coven is available and the daemon is running:

```bash
coven doctor
coven start
coven status
```

If `coven start` or `coven status` is unavailable in your installed Coven build, use `coven daemon --help` and follow the daemon command shown there.

## Open a project in psyche

From the repository you want to work on:

```bash
psyche
```

psyche opens a tmux cockpit scoped to that project. The sidebar remains the control surface for panes, projects, Coven sessions, and review actions.

## Launch a Coven-backed session

Press `n` for New Pane, describe the coding task, and choose Codex, Claude Code, or another configured launcher. When the local Coven bridge path is available, the session can be launched as a Coven-managed harness session while still appearing as a visible psyche pane.

For desktop-use sessions, press `d`; psyche creates a pane and attaches to the Coven session with `coven attach <session-id>`.

## Watch it

The sidebar polls Coven every 15 seconds. Matching sessions appear under `☾ Coven sessions` for the project.

- Use the arrow keys to move between panes and project rows.
- Press `o` on the active project to open the latest matching Coven session as a visible psyche pane.
- If Coven is not running, psyche keeps running and shows a compact hint instead of failing the cockpit.

## Inspect files and diffs

- Press `f` to open the file browser for the selected pane or worktree.
- Press `m` to open the pane menu.
- Choose Inspect diff from the pane menu when you need to review changes before merge or PR work.

## Merge, PR, archive, and clean up

Press `m` on the relevant pane to use the explicit review and handoff actions:

- inspect the worktree;
- merge into the target branch;
- create a GitHub PR;
- attach another agent;
- archive, close, or clean up the pane when the work is done.

psyche should not push, merge, publish, delete, or clean up work without an explicit user action.

## Troubleshooting

### Coven is not installed

Install the public CLI, then reopen psyche:

```bash
npm i -g @opencoven/cli
```

### Coven is installed but not running

Start the local daemon and check status:

```bash
coven start
coven status
```

If your installed Coven build uses the daemon subcommand instead, inspect:

```bash
coven daemon --help
```

### Coven sessions do not appear

psyche reads sessions through:

```bash
coven sessions --json --all
coven sessions --json
```

If your Coven build only prints a table, psyche will show Coven as unavailable until the JSON sessions contract is available again. Track the broader Coven direction in the [OpenCoven public roadmap](https://github.com/OpenCoven/coven/blob/main/docs/ROADMAP.md).

### Opening a session fails

Run:

```bash
coven attach <session-id>
```

If attach fails directly in the terminal, fix the Coven runtime first. If direct attach works but psyche cannot open it, capture the psyche status message and the output of `coven sessions --json`.
