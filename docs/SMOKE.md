# psyche smoke test

Use this loop to verify the current public CLI/core path.

## Automated cockpit startup check

```bash
pnpm smoke
```

Builds, then starts the built `dist/index.js` in a throwaway git repo, under a
throwaway `HOME`, on a tmux server of its own — so it cannot read or write your
settings, tmux config, or runtime state. It declines the first-run tmux
onboarding offer, waits for the project-local `.psyche/psyche.config.json`,
checks the cockpit identified the disposable project and started with no panes,
then quits and confirms the tmux session is gone. Everything is torn down on
success and on failure; a startup failure prints the captured cockpit pane.

Requires `tmux` and `git`. It fails rather than skips when tmux is missing,
since it is the only assertion the command makes.

This complements `pnpm smoke:pack` rather than replacing it. `smoke:pack`
verifies what the published tarball would contain; `pnpm smoke` verifies the
built cockpit actually starts. A package can pack correctly and still fail to
launch.

The manual checks below still cover the richer pane, ritual, merge, and
optional Coven flows that the automated check deliberately leaves alone.

## Package checks

From the psyche checkout:

```bash
pnpm install --ignore-scripts
pnpm run typecheck
pnpm run test
pnpm run build
node ./psyche doctor --json
npm pack --dry-run --json
```

Expected:

- TypeScript and tests pass.
- `doctor --json` reports tmux and git checks.
- `doctor --json` reports `agent-cli-guidance` and `coven-guidance`.
- `usable` is `true` when there are no blocking errors.
- `healthy` may be `false` if only recommended setup warnings remain.
- `npm pack --dry-run --json` includes the README and docs files intended for npm.

## First-run onboarding smoke

Use this check when touching setup, doctor, agent discovery, or Coven docs.

```bash
pnpm run dev:doctor
node ./psyche doctor
node ./psyche doctor --json
```

Expected:

- Text output says whether psyche can run, even when recommended setup warnings remain.
- If no supported agent CLI is detected, doctor explains that plain terminal panes still work and lists the supported agent CLIs.
- Doctor explains that Coven is optional for core tmux/worktree/agent/merge/PR workflows.
- JSON output includes stable check IDs for automation: `agent-cli-guidance` and `coven-guidance`.
- `psyche doctor --fix` only applies safe tmux repairs and the managed tmux config block.

## Interactive cockpit smoke

Use a disposable git repository outside the psyche checkout so worktree creation cannot touch the project under test.

Replace `/path/to/psyche/checkout/psyche` with the executable from your checkout, or use an installed `psyche` binary after packaging.

```bash
rm -rf /tmp/psyche-smoke
mkdir -p /tmp/psyche-smoke
cd /tmp/psyche-smoke

git init
git config user.email smoke@example.com
git config user.name "psyche smoke"
echo '# smoke' > README.md
git add README.md
git commit -m "init smoke repo"

node /path/to/psyche/checkout/psyche
# or, if installed:
psyche
```

Expected:

- psyche opens the terminal cockpit for the disposable project.
- `n` creates an agent/worktree pane.
- `t` creates a plain terminal pane.
- `u` opens rituals.
- `f` opens the file browser for a worktree pane.
- `m` opens the pane menu.
- `h` / `H` hide and restore pane visibility.
- `p` adds another project to the sidebar.
- `r` can reopen a closed worktree.
- Closing psyche leaves no orphaned controller process.

## Coven integration smoke

Run this section when Coven is installed locally and you want to verify the optional sessions panel.

### Native Coven physical panes

1. Launch the unsigned macOS app with `coven` available on the augmented PATH.
2. Open the linked-worktree path itself as the project.
3. Confirm project open creates one `coven chat` PTY owned by that linked worktree.
4. Press Command-T twice and confirm three simultaneous physical panes.
5. Type distinct input in each pane and confirm focus/input isolation.
6. Type a partial prompt in Coven, drag PNG and JPEG files from Finder onto the
   pane, confirm quoted absolute paths appear at cursor without submitting.
7. Drop a mix of image/non-image files, confirm every image path is inserted in
   Finder order and skipped count is reported.
8. Start a Coven turn, press Ctrl+C, confirm PTY remains running while
   pane/session rail/minimap return to **Waiting for you** after prompt settles.
9. Drag a divider and use its arrow-key controls; confirm all visible PTYs resize.
10. Select a durable session in the Coven rail twice; confirm one native
   `coven attach <id>` pane is created and the second action focuses it.
11. Close the attachment and confirm `coven sessions` still lists the durable session.
12. Stop the daemon and confirm new `coven chat` panes still launch while the rail
   shows stale/unavailable discovery state.
13. Run `/new-shell` and `/new-psyche`; confirm the former is a login shell and
    only the latter starts the legacy tmux-backed TUI.

Expected:

- `coven doctor` and the local Coven daemon/status command report a usable runtime.
- When Coven is running for the same project, the sidebar shows matching rows in a `Coven` subsection.
- Clicking a durable Coven row opens one visible native pane with `coven attach <session-id>`; clicking it again focuses that attachment.
- When Coven is unavailable, the rail shows one global unavailable or stale-discovery state and psyche keeps running.
- Finder image drops target only running terminal pane under pointer, never Web/editor/sidebar/failed/exited.
- Image drops insert shell-safe paths only and never synthesize Enter.
- Ctrl+C leaves healthy Coven PTY running and re-arms local attention for returned prompt.

## Merge / PR smoke

Use only disposable branches for this check.

Expected:

- A worktree pane can be reviewed from the pane menu.
- Merge and PR actions remain explicit menu choices.
- psyche does not push, merge, publish, delete, or clean up work without a user action.
- Hooks can run on worktree create / pre-merge / post-merge when configured.

## Coven bridge smoke

When a local Coven daemon is available for the same project:

- psyche can list/open Coven sessions through the daemon bridge.
- launching a Coven session is scoped to the current project root.
- out-of-project `cwd` values are rejected before work starts.
- opening a Coven session creates a pane that runs `coven attach <session-id>`.
- desktop-use event polling follows Coven `seq` cursors from the `/api/v1/events` envelope.
- stopped or missing daemons surface a recoverable `coven daemon start` message instead of breaking normal psyche panes.

Keep this smoke conservative: it should prove project scoping and visibility, not hidden automation.
