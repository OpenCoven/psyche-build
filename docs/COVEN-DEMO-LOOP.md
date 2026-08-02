# psyche + Coven demo loop

This loop is the public OpenCoven story in the smallest useful form:

1. Open a project in psyche.
2. Launch or attach a Coven-backed Codex or Claude Code session.
3. Watch the work as a visible pane/session.
4. Inspect files and diffs from psyche.
5. Merge, create a PR, archive, or clean up explicitly.

The upstream OpenCoven roadmap tracks this same slice under the psyche "Next" milestone:
https://github.com/OpenCoven/coven/blob/main/docs/ROADMAP.md

## Prerequisites

Install psyche and Coven, then verify both from the same shell:

```bash
npm install -g psyche-build
npx @opencoven/cli doctor
```

Coven is optional. psyche still works as a standalone tmux/worktree cockpit when Coven is not installed or the daemon is stopped.

For the Coven-backed path, start the local daemon:

```bash
coven doctor
coven daemon start
coven daemon status
```

## Demo path

From the repository you want to work in:

```bash
cd /path/to/project
psyche
```

Inside psyche:

1. Press `n` to create a normal psyche agent pane, or press `d` to launch the desktop-use Coven pane.
2. For a CLI-launched Coven session, run one of these in a terminal pane:

   ```bash
   coven run codex "fix the failing tests" --title "Fix tests"
   coven run claude "review this branch" --title "Review branch"
   ```

3. The side panel shows matching Coven sessions for the active project when the daemon API is reachable.
4. Use `j` to watch the pane, `f` to inspect files and diffs, and `m` to open the pane menu.
5. Finish with an explicit action: merge, create a GitHub PR, close/archive the session, or clean up the worktree.

## Current Coven contract verified by psyche

psyche talks to the local Coven daemon through `/api/v1`:

- `GET /api/v1/health`
- `GET /api/v1/sessions`
- `POST /api/v1/sessions`
- `GET /api/v1/sessions/:id`
- `GET /api/v1/events?sessionId=...`
- `POST /api/v1/sessions/:id/input`

The current stable daemon contract is `apiVersion: "coven.daemon.v1"`. Event reads use the paginated event envelope with `nextCursor.afterSeq`, and psyche keeps polling from that sequence cursor instead of replaying the whole event log.

The older `coven sessions --json` adapter remains available only as an explicit legacy fallback for visibility-only compatibility. The default list, launch, open, and event paths use the local daemon API.

## Unavailable states

If Coven is missing or stopped, psyche keeps running:

- the side panel shows a compact Coven unavailable state;
- desktop-use launch failures point at `coven daemon start`;
- ordinary psyche panes, worktrees, file browsing, merge, PR, and cleanup flows still work.

Use this recovery checklist:

```bash
command -v coven
coven doctor
coven daemon restart
coven daemon status
```
