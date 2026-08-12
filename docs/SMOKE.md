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
3. Confirm project open creates one `coven chat` PTY owned by that linked
   worktree. This pane delegates into Coven Code without psyche tmux. Find its
   daemon session ID and define `PSYCHE_SESSION_ID=<id>`.
4. Inspect the daemon record:

   ```bash
   coven sessions --json | jq -e --arg id "$PSYCHE_SESSION_ID" \
     '.sessions[] | select(.id == $id) | {id, status, labels}'
   ```

   Confirm `labels` contains the exact `source:psyche-build` marker and `status` is
   `starting`, `running`, or `waiting`.
5. Confirm exactly one active daemon-backed Coven row appears for
   `$PSYCHE_SESSION_ID`.
6. Press Command-T twice and confirm three simultaneous physical panes.
7. Type distinct input in each pane and confirm focus/input isolation.
8. Type a partial prompt in Coven, drag PNG and JPEG files from Finder onto the
   pane, confirm quoted absolute paths appear at cursor without submitting; for
   mixed drops, confirm every image path is inserted in Finder order and the
   skipped count is reported.
9. Start a Coven turn, press Ctrl+C, and confirm the PTY remains running while
   pane, rail, and minimap return to **Waiting for you** after the prompt settles.
10. Drag a divider and use its arrow-key controls; confirm all visible PTYs resize.
11. Start a concurrent active Coven Code session outside psyche in the same
   repository and record its ID as `EXTERNAL_SESSION_ID=<id>`. Confirm daemon
   JSON lists it:

    ```bash
    coven sessions --json | jq -e --arg id "$EXTERNAL_SESSION_ID" \
      '.sessions[] | select(.id == $id) | {id, status, labels}'
    ```

    Confirm no row for `$EXTERNAL_SESSION_ID` appears in the psyche rail,
    including after searching for it.
12. Capture the owned session labels, select its active Coven rail row twice,
    then compare the labels again:

    ```bash
    BEFORE_LABELS="$(coven sessions --json | jq -ce --arg id "$PSYCHE_SESSION_ID" \
      '.sessions[] | select(.id == $id) | .labels | sort')" || exit 1
    test -n "$BEFORE_LABELS" || exit 1
    # Select the $PSYCHE_SESSION_ID row twice in the Coven rail.
    AFTER_LABELS="$(coven sessions --json | jq -ce --arg id "$PSYCHE_SESSION_ID" \
      '.sessions[] | select(.id == $id) | .labels | sort')" || exit 1
    test -n "$AFTER_LABELS" || exit 1
    test "$BEFORE_LABELS" = "$AFTER_LABELS"
    ```

    Confirm the first selection creates one native physical
    `coven attach <id>` pane, the second focuses it, and the labels are unchanged.
13. Close the attachment and confirm daemon JSON still lists the durable session.
14. Complete `$PSYCHE_SESSION_ID` and confirm its Coven row disappears after the
    next successful refresh. The refresh must not create, close, or focus a local
    pane; the exited/local pane remains governed by the normal close and focus
    controls.
15. Stop the daemon and confirm new `coven chat` panes still launch while the rail
   shows stale/unavailable discovery state.
16. Run `/new-shell` and `/new-psyche`; confirm the former is a login shell and
    only the latter starts the legacy tmux-backed TUI.

Expected:

- `coven doctor` and the local Coven daemon/status command report a usable runtime.
- When Coven is running for the same project, the sidebar shows matching rows in a `Coven` subsection.
- Clicking a durable Coven row opens one visible native pane with `coven attach <session-id>`; clicking it again focuses that attachment.
- When Coven is unavailable, the rail shows one global unavailable or stale-discovery state and psyche keeps running.
- Finder image drops target only the running terminal pane under the pointer,
  insert shell-safe paths without synthesizing Enter, and never target Web,
  editor, sidebar, failed, or exited panes.
- Ctrl+C leaves a healthy Coven PTY running and re-arms local attention when the
  prompt returns.
- Compatible rollout requires Coven label persistence and Coven Code marker
  mapping. Older Coven or Coven Code versions fail closed to no Coven rows while
  native PTY panes remain functional. Historical sessions are not migrated;
  only sessions created after compatible versions are installed can appear.

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
