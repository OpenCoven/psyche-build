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
forces a clean prepack build, checks the `npm pack` file list, installs a real
tarball, and verifies the exported `psyche-build/control-task-tokens` subpath;
`pnpm smoke` verifies the built cockpit actually starts. A package can pack
correctly and still fail to launch.

The manual checks below still cover the richer pane, ritual, merge, and
optional Coven flows that the automated check deliberately leaves alone.

## Package checks

From the psyche checkout:

```bash
pnpm install --ignore-scripts
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run smoke:pack
node ./psyche doctor --json
```

Expected:

- TypeScript and tests pass.
- `pnpm smoke:pack` includes `dist/control-task-tokens.js` and
  `dist/control-task-tokens.d.ts` in the real tarball, installs that tarball,
  and imports `psyche-build/control-task-tokens`.
- `doctor --json` reports tmux and git checks.
- `doctor --json` reports `agent-cli-guidance` and `coven-guidance`.
- `usable` is `true` when there are no blocking errors.
- `healthy` may be `false` if only recommended setup warnings remain.
- The packaged archive still includes the README and docs files intended for npm.

## Local desktop launch smoke

From the repository root, install the platform's documented Tauri prerequisites
and the locked JavaScript dependencies, then launch the desktop app:

```text
pnpm install --frozen-lockfile
pnpm dev:tauri
```

Run the same commands in Terminal on macOS, PowerShell on Windows, or a shell on
Linux. Expect a native desktop window to open with working PTYs, files, Git,
editor, and browser surfaces. macOS retains its platform-specific presentation;
Windows and Linux use portable opaque, decorated windows.

Windows Coven local-session discovery is unavailable because that integration
uses a Unix-socket transport. This does not disable PTYs, files, Git, the editor,
or the browser. These checks launch the app from source and do not describe
Windows or Linux artifacts as released. Hosted CI checks portability only; it
does not prove physical GPU acceleration.

## Native session persistence

1. Launch the packaged macOS app and open a project with at least one linked
   worktree.
2. Press `Ctrl+T` and confirm a shell opens in the selected worktree.
3. Press `Ctrl+A` and confirm Coven Code opens in the same worktree by running
   `coven code --session-id <id>`.
4. Move the panes into a mixed row/column layout, resize both split axes, hide
   one pane, and focus the other.
5. Quit Psyche without using **Stop and close**.
6. Run `tmux -S ~/.psyche/macos-app/native-sessions.sock list-sessions` and
   confirm both Psyche-owned sessions remain live.
7. Reopen Psyche and confirm visible/hidden state, layout topology, split
   ratios, focus, scrollback, and interactive process state are restored.
8. Use **Stop and close** on one pane and confirm only its tmux session is
   removed.
9. Force-quit Psyche, reopen it, and confirm the last successful workspace save
   restores without terminating the remaining session.

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
3. Confirm project open does not create an agent pane.
4. Press `Ctrl+A` or choose **Open Coven Terminal** and confirm it creates one
   `coven code --session-id <id>` PTY for the linked worktree. The daemon ID
   becomes `PSYCHE_SESSION_ID`.
5. Inspect the daemon record:

   ```bash
   coven sessions --json | jq -e --arg id "$PSYCHE_SESSION_ID" \
     '.sessions[] | select(.id == $id) | {id, status, labels}'
   ```

   Confirm `labels` contains the exact `source:psyche-build` marker and `status` is
   `starting`, `running`, or `waiting`.
6. Confirm exactly one active daemon-backed Coven row appears for
   `$PSYCHE_SESSION_ID`.
7. Press Command-T twice and confirm three simultaneous physical panes.
8. Type distinct input in each pane and confirm focus/input isolation.
9. Type a partial prompt in Coven, drag PNG and JPEG files from Finder onto the
   pane, confirm quoted absolute paths appear at cursor without submitting; for
   mixed drops, confirm every image path is inserted in Finder order and the
   skipped count is reported.
10. Start a Coven turn, press Ctrl+C, and confirm the PTY remains running while
   pane, rail, and minimap return to **Waiting for you** after the prompt settles.
11. Drag a divider and use its arrow-key controls; confirm all visible PTYs resize.
12. Start a concurrent active Coven Code session outside psyche in the same
   repository and record its ID as `EXTERNAL_SESSION_ID=<id>`. Confirm daemon
   JSON lists it:

    ```bash
    coven sessions --json | jq -e --arg id "$EXTERNAL_SESSION_ID" \
      '.sessions[] | select(.id == $id) | {id, status, labels}'
    ```

    Confirm no row for `$EXTERNAL_SESSION_ID` appears in the psyche rail,
    including after searching for it.
13. Capture the owned session labels, select its active Coven rail row twice,
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
14. Close the attachment and confirm daemon JSON still lists the durable session.
15. Complete `$PSYCHE_SESSION_ID` and confirm its Coven row disappears after the
    next successful refresh. The refresh must not create, close, or focus a local
    pane; the exited/local pane remains governed by the normal close and focus
    controls.
16. Stop the daemon and confirm new `coven code --session-id <id>` panes still
    launch while discovery is stale/unavailable.
17. Run `/new-shell` and `/new-psyche`; confirm the former is a login shell and
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
