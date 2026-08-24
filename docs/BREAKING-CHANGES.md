# Breaking changes: comux → Psyche Build

This tool was previously published as `comux`. It is now **Psyche Build** —
package `psyche-build`, command `psyche`.

This is a **clean break**. Nothing from a `comux` installation is read,
migrated, or carried forward. There is no `comux` command alias and no
compatibility shim.

The dangerous part is not the rename itself — it is that most of the breakage
is **silent**. Hooks do not error when they stop being found; they simply never
run. Read the hooks section below even if you skip the rest.

## Install

```sh
npm uninstall -g comux
```

Install and open the supported public `v0.0.1` macOS GUI through the OpenCoven
Homebrew Cask:

```sh
brew install --cask opencoven/tap/psyche-build
open -a "Psyche Build"
```

The Cask installs only `Psyche Build.app`. For source CLI development, use the
repository checkout, follow `CONTRIBUTING.md`, and invoke it explicitly:

```sh
node /path/to/psyche-build/psyche
```

The Psyche Build Node CLI is not an npm release in `0.0.1`.

## What changes

| Was | Now |
|---|---|
| package `comux` | package `psyche-build` |
| command `comux` | command `psyche` |
| `.comux/` | `.psyche/` |
| `.comux/comux.config.json` | `.psyche/psyche.config.json` |
| `.comux-hooks/` | `.psyche-hooks/` |
| `~/.comux/` | `~/.psyche/` |
| `~/.comux.global.json` | `~/.psyche.global.json` |
| `COMUX_*` environment variables | `PSYCHE_*` |
| `# >>> comux` block in `~/.tmux.conf` | `# >>> psyche` |
| MCP tools `comux_*` | `psyche_*` |

Psyche Build detects leftover `comux` state at startup and prints what it
found, what you lose, and how to migrate. It never reads it.

## Hooks — the silent one

Hook scripts break in two independent ways, neither of which reports an error.

**1. The directory is no longer searched.** Hook lookup now resolves
`.psyche-hooks/` → `.psyche/hooks/` → `~/.psyche/hooks/`. A script sitting in
`.comux-hooks/` is not found, and a hook that is not found is not an error — it
is simply skipped.

**2. The variables inside are empty.** Every `$COMUX_*` reference becomes an
unset variable. This is worse than a crash, because shell expands unset
variables to the empty string:

```sh
cd "$COMUX_WORKTREE_PATH"              # cd "" — silently stays put
rm -rf "$COMUX_WORKTREE_PATH/build"    # rm -rf "/build"
```

Migrate both at once:

```sh
mv .comux-hooks .psyche-hooks
grep -rl --null -- COMUX_ .psyche-hooks | xargs -0 sed -i '' -e 's/COMUX_/PSYCHE_/g'
```

On GNU sed (Linux), use this version instead:

```sh
grep -rl --null -- COMUX_ .psyche-hooks | xargs -0 -r sed -i -e 's/COMUX_/PSYCHE_/g' --
```

### Hook environment variables

Every variable passed to hook scripts, with its old name:

| Was | Now | Present for |
|---|---|---|
| `COMUX_ROOT` | `PSYCHE_ROOT` | always |
| `COMUX_SERVER_PORT` | `PSYCHE_SERVER_PORT` | always |
| `COMUX_PANE_ID` | `PSYCHE_PANE_ID` | pane hooks |
| `COMUX_SLUG` | `PSYCHE_SLUG` | pane hooks |
| `COMUX_PROMPT` | `PSYCHE_PROMPT` | pane hooks |
| `COMUX_AGENT` | `PSYCHE_AGENT` | pane hooks |
| `COMUX_TMUX_PANE_ID` | `PSYCHE_TMUX_PANE_ID` | pane hooks |
| `COMUX_WORKTREE_PATH` | `PSYCHE_WORKTREE_PATH` | worktree hooks |
| `COMUX_BRANCH` | `PSYCHE_BRANCH` | worktree hooks |
| `COMUX_TARGET_BRANCH` | `PSYCHE_TARGET_BRANCH` | merge hooks |

> **Note:** earlier documentation listed `COMUX_PANE_SLUG`, `COMUX_PANE_PROMPT`,
> `COMUX_PANE_AGENT`, `COMUX_PROJECT_PATH`, `COMUX_PROJECT_NAME`,
> `COMUX_BRANCH_NAME`, `COMUX_MAIN_BRANCH`, and `COMUX_CALLBACK_URL`. **None of
> those were ever set** — the docs had drifted from the code. If your hooks use
> them, they were already reading empty values. The table above is the real
> contract, and the docs now match it.

## Codex hooks

Codex hook configs live in each worktree's `.codex/hooks.json`, outside this
repo. Psyche Build removes a stale `comux-stop-hook.cjs` entry when it installs
its own, so Codex will not keep firing a hook whose script no longer exists.
Its state directory moves from `.codex/comux/` to `.codex/psyche/`.

## tmux

Run `psyche doctor --fix`. It backs up `~/.tmux.conf`, removes the orphaned
`# >>> comux` block — whose keybindings invoke a binary that no longer exists —
and installs the `# >>> psyche` block.

If a tmux server is still running from a comux session, restart it
(`tmux kill-server`) before the first `psyche` run. The old server holds
`@comux_*` options and `__comux__` pane titles that the new build does not read.

## Coven

Unchanged. The `coven-code` harness, Coven session integration, the daemon API
contract, and the capability provider ids (`coven-native`, `psyche`) are all
unaffected by the rename.

## macOS app

The Tauri bundle identifier changed, so macOS treats the app as new: fresh
preferences, keychain entries, and permission prompts. Previously granted
permissions must be re-granted.

## What is not migrated

Deliberately: pane and worktree records, global settings, onboarding state, and
the compiled native helper. Existing worktrees and branches are untouched in git
— only Psyche Build's own records of them are not carried over. You can still
find them with `git worktree list`.
