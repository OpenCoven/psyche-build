<h1 align="center">Psyche Build ✨</h1>

<h3 align="center">Multiagent coding harness for parallel agent lanes</h3>

<p align="center">
  Manage multiple AI coding agents in visible, isolated terminal workspaces.<br/>
  Branch, develop, inspect, merge, and hand off — all in parallel.
</p>

<p align="center">
  <a href="https://github.com/OpenCoven/psyche-build/releases"><strong>Releases</strong></a>
  ·
  <a href="https://github.com/OpenCoven/psyche-build/issues"><strong>Issues</strong></a>
</p>

---

> **Upgrading from `comux`?** Psyche Build is the same tool under a new name,
> but it is a clean break — nothing is migrated, and hook scripts stop firing
> **silently**. See [Breaking changes](./docs/BREAKING-CHANGES.md).

## Distribution

When the `v0.0.1` GitHub Release and tap Cask are available, the only public
macOS installation path is:

```sh
brew install --cask opencoven/tap/psyche-build
open -a "Psyche Build"
```

The iOS build is internal TestFlight only. Authorized OpenCoven testers can
install `Psyche Build` `0.0.1 (1)` if it is available to their account in
TestFlight; this is not a public App Store or external TestFlight release.

Source development is separate; follow [CONTRIBUTING.md](./CONTRIBUTING.md) to
run the checkout. The Node CLI ships in the source tree and package archive,
but it is not an npm release for `0.0.1`. Windows, Linux, Android, external
TestFlight, and public App Store distribution are unavailable in `0.0.1`.

The Cask installs only `Psyche Build.app`; it does not install the Node CLI.
From a source checkout, invoke that CLI explicitly and verify the local setup
with:

```sh
node /path/to/psyche-build/psyche doctor --json
```

## Quick Start

```sh
cd /path/to/your/project
node /path/to/psyche-build/psyche
```

Press `n` to create a new pane, type a prompt, pick one or more agents (or none for a plain terminal), and Psyche Build handles the rest — tmux pane, git worktree, branch, and agent launch.

Press `u` to open rituals: reusable setup recipes for starting a project with a known pane layout. Built-ins include Start Coding, Terminal First, Review Stack, Release Check, and Fix OpenClaw. You can also save project rituals and attach a default ritual to a project.

Open the selected pane menu with `m` when you want to inspect, merge, create a PR, attach another agent, or clean up.

For the full Psyche Build + Coven walkthrough, see [Coven demo loop](./docs/COVEN-DEMO-LOOP.md).

New to tmux? Run:

```sh
node /path/to/psyche-build/psyche doctor
node /path/to/psyche-build/psyche doctor --fix
```

`psyche doctor` checks tmux, git, clipboard/navigation support, psyche session styling, and the psyche-managed tmux config block. `--fix` applies safe repairs, backs up an existing `~/.tmux.conf`, and only edits the block between `# >>> psyche` and `# <<< psyche`.

If a pane could not be verified as closed while its config was unavailable,
Psyche writes a runtime recovery marker and blocks destructive cleanup. Inspect
the marker with `psyche recover --project /path/to/project`; after reconciling
the pane and worktree manually, explicitly acknowledge its ID with
`psyche recover --project /path/to/project --acknowledge <marker-id>`.

The doctor output also calls out supported agent CLIs and the Coven boundary:

- Without an agent CLI, Psyche Build can still open and manage plain terminal panes.
- With a supported agent CLI, Psyche Build can launch agent panes from prompts.
- Without Coven, Psyche Build still manages tmux panes, worktrees, merge, PR, settings, rituals, and local file browsing.
- With a local Coven daemon, Psyche Build's CLI and bridge can list, open, and launch scoped Coven harness sessions.

## What it does

Psyche Build creates a tmux pane for each task. Every work pane gets its own git worktree and branch so agents work in complete isolation. When a task is done, open the pane menu with `m` and choose Merge to bring it back into your main branch, or Create GitHub PR to push the branch and file a pull request.

- **Worktree isolation** — each pane is a full working copy, no conflicts between agents
- **Agent support** — Coven Code, Claude Code, Codex, OpenCode, Cline CLI, Gemini CLI, Qwen CLI, Amp CLI, pi CLI, Cursor CLI, Copilot CLI, and Crush CLI
- **Multi-select launches** — choose any combination of enabled agents per prompt
- **AI naming** — branches, pane labels, and commit messages can be generated automatically
- **Smart merging** — review, auto-commit, merge, PR, and cleanup flows stay explicit
- **macOS notifications** — background panes can send native attention alerts when they settle and need you
- **Built-in file browser** — inspect a pane's worktree, search files, and preview code or diffs without leaving Psyche Build
- **Pane visibility controls** — hide individual panes, isolate one project, or restore everything later without stopping work
- **Multi-project cockpit** — add multiple repos to the same session and switch scope from the sidebar
- **Rituals** — open, save, and attach reusable project setup recipes without restoring brittle tmux snapshots
- **Fix OpenClaw cockpit** — a built-in ritual opens Coven repair, verification, diff watch, and session panes so rescue work stays visible
- **Coven sessions** — the CLI sidebar can show live session status and `[o]` opens a session as a visible Psyche Build pane; the macOS app rail intentionally shows app-origin local threads only
- **Lifecycle hooks** — run scripts on worktree create, pre-merge, post-merge, and more

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `n` | New pane (worktree + agent) |
| `t` | New terminal pane |
| `u` | Open or manage rituals |
| `e` | Rename the selected pane/thread or project inline |
| `j` / `Enter` | Jump to pane |
| `m` | Open pane menu |
| `f` | Browse files in selected pane's worktree |
| `x` | Close pane |
| `h` | Hide/show selected pane |
| `H` | Hide/show all other panes |
| `p` | Add project to sidebar |
| `P` | Show only the selected project's panes, then show all |
| `r` | Reopen closed worktrees for the active project |
| `s` | Settings |
| `l` | Logs |
| `?` | Keyboard shortcuts and help |
| `q` | Quit |

When focus is inside a work pane, tmux receives your keys instead of Psyche Build. Use `Ctrl-b` then `Left Arrow` to return to the Psyche Build sidebar. When mouse events are enabled, click a pane/thread/worktree row to select it and double-click a pane/thread/worktree name or project header to edit it inline. On macOS, `Alt+Shift+M` opens the focused pane menu when your terminal sends Option as Meta. In Terminal.app, enable **Settings > Profiles > Keyboard > Use Option as Meta key**. In iTerm2, use **Settings > Profiles > Keys > Left/Right Option Key > Esc+**.

## Requirements

- tmux 3.0+
- Node.js 20.10.0+
- Git 2.20+
- At least one supported agent CLI for agent panes (for example [Coven Code](https://github.com/OpenCoven/coven), [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), [OpenCode](https://github.com/opencode-ai/opencode), [Cline CLI](https://docs.cline.bot/cline-cli/getting-started), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Qwen CLI](https://github.com/QwenLM/qwen-code), [Amp CLI](https://ampcode.com/manual), [pi CLI](https://www.npmjs.com/package/@mariozechner/pi-coding-agent), [Cursor CLI](https://docs.cursor.com/en/cli/overview), [Copilot CLI](https://github.com/github/copilot-cli), [Crush CLI](https://github.com/charmbracelet/crush)). Plain terminal panes work without an agent CLI.
- [OpenRouter API key](https://openrouter.ai/) (optional, for AI branch names, status analysis, and commit messages)

## MCP server

`psyche mcp` exposes the project owner's leased pane and browser surface over
MCP (stdio JSON-RPC). It connects to the project control socket and starts the
detached owner when the socket is absent; mutations still pass through the
same authenticated authority, policy, approval, and receipt path as the UI.

```json
{
  "mcp_servers": [
    { "name": "psyche", "command": "psyche", "args": ["mcp"], "type": "stdio" }
  ]
}
```

| Tool | Does |
|---|---|
| `psyche_control_list` | List bounded controllable pane/browser resources, generations, and approvals |
| `psyche_control_lease` | Request, inspect, or release scoped authority; it cannot grant or approve authority |
| `psyche_pane_observe` | Read bounded pane output and status through an exact leased generation |
| `psyche_pane_action` | Perform one typed leased pane action and return its canonical receipt |
| `psyche_browser_inspect` | Capture a bounded semantic snapshot of an exact leased tab generation |
| `psyche_browser_action` | Perform one typed leased browser action and return its canonical receipt |
| `psyche_browser_script` | Submit an approval-gated browser script through an exact leased tab generation |
| `psyche_control_action_status` | Read the latest canonical receipt without retrying; missing bounded history reports `unknown` |
| `psyche_list_panes` | Compatibility alias that lists pane resources through the owner |
| `psyche_create_pane` | Compatibility alias for leased pane creation through the owner |
| `psyche_execute_task` | Compatibility alias that submits orchestration through the owner |
| `psyche_kill_pane` | Compatibility alias for approved pane close through the owner |
| `psyche_get_pane_output` | Compatibility alias for bounded leased pane observation |
| `psyche_list_rituals` | List built-in and project rituals |
| `psyche_list_worktrees` | List git worktrees for the project |

The compatibility mutation aliases require `task_id`, `lease_id`, and
`lease_revision`; pane-specific aliases also require the current generation.
Missing authority returns a structured `lease_missing` result without an
effect.

`psyche_kill_pane` **does not delete the pane's worktree or branch.** It returns
both so you can inspect or merge the work; removing them stays an explicit
action in the TUI, because a worktree can hold the only copy of uncommitted
changes.

## Coven and OpenCoven

Psyche Build works as a standalone tmux/worktree cockpit. Its CLI and bridge
also speak to Coven when a local daemon is available, so OpenCoven-managed
harness sessions can appear beside normal Psyche Build panes. The macOS app
rail intentionally does not render daemon-discovered sessions.

Coven is the harness substrate. Psyche Build is the cockpit. OpenMeow and OpenClaw can sit above them as intake and orchestration layers.

Demo loop:

1. Open a project in Psyche Build.
2. Launch a Coven-backed Codex or Claude Code session.
3. Watch it as a visible pane/session.
4. Inspect files and diffs.
5. Merge, create a PR, archive, or clean up explicitly.

See [Psyche Build + Coven demo loop](./docs/COVEN-DEMO-LOOP.md) and the [OpenCoven public roadmap](https://github.com/OpenCoven/coven/blob/main/docs/ROADMAP.md).

## Docs

- [Documentation index](./docs/README.md)
- [Breaking changes: comux → Psyche Build](./docs/BREAKING-CHANGES.md)
- [Bridge and daemon security model](./docs/BRIDGE-SECURITY.md)
- [Psyche Build + Coven demo loop](./docs/COVEN-DEMO-LOOP.md)
- [Product spec](./docs/PRODUCT-SPEC.md)
- [Smoke test](./docs/SMOKE.md)
- [Release runbook](./docs/RELEASE.md)
- [Contributing](./CONTRIBUTING.md)

## Contributing

See **[CONTRIBUTING.md](./CONTRIBUTING.md)** for the recommended local "Psyche-on-Psyche" development loop, hook setup, and PR workflow.

## License

MIT
