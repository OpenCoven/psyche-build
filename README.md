<h1 align="center">psyche ✨</h1>

<h3 align="center">Multiagent coding harness for parallel agent lanes</h3>

<p align="center">
  Manage multiple AI coding agents in visible, isolated terminal workspaces.<br/>
  Branch, develop, inspect, merge, and hand off — all in parallel.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/psyche-build"><strong>npm</strong></a>
  ·
  <a href="https://github.com/OpenCoven/psyche-build/issues"><strong>Issues</strong></a>
</p>

---

## Install

```sh
npm install -g psyche-build
```

Or try it without a global install:

```sh
npm exec psyche-build@latest -- doctor --json
```

## Quick Start

```sh
cd /path/to/your/project
psyche
```

Press `n` to create a new pane, type a prompt, pick one or more agents (or none for a plain terminal), and psyche handles the rest — tmux pane, git worktree, branch, and agent launch.

Press `u` to open rituals: reusable setup recipes for starting a project with a known pane layout. Built-ins include Start Coding, Terminal First, Review Stack, Release Check, and Fix OpenClaw. You can also save project rituals and attach a default ritual to a project.

Open the selected pane menu with `m` when you want to inspect, merge, create a PR, attach another agent, or clean up.

For the full psyche + Coven walkthrough, see [Demo loop](./docs/DEMO-LOOP.md).

New to tmux? Run:

```sh
psyche doctor
psyche doctor --fix
```

`psyche doctor` checks tmux, git, clipboard/navigation support, psyche session styling, and the psyche-managed tmux config block. `--fix` applies safe repairs, backs up an existing `~/.tmux.conf`, and only edits the block between `# >>> psyche` and `# <<< psyche`.

The doctor output also calls out supported agent CLIs and the Coven boundary:

- Without an agent CLI, psyche can still open and manage plain terminal panes.
- With a supported agent CLI, psyche can launch agent panes from prompts.
- Without Coven, psyche still manages tmux panes, worktrees, merge, PR, settings, rituals, and local file browsing.
- With a local Coven daemon, psyche can also list, open, and launch scoped Coven harness sessions.

## What it does

psyche creates a tmux pane for each task. Every work pane gets its own git worktree and branch so agents work in complete isolation. When a task is done, open the pane menu with `m` and choose Merge to bring it back into your main branch, or Create GitHub PR to push the branch and file a pull request.

- **Worktree isolation** — each pane is a full working copy, no conflicts between agents
- **Agent support** — Claude Code, Codex, OpenCode, Cline CLI, Gemini CLI, Qwen CLI, Amp CLI, pi CLI, Cursor CLI, Copilot CLI, and Crush CLI
- **Multi-select launches** — choose any combination of enabled agents per prompt
- **AI naming** — branches, pane labels, and commit messages can be generated automatically
- **Smart merging** — review, auto-commit, merge, PR, and cleanup flows stay explicit
- **macOS notifications** — background panes can send native attention alerts when they settle and need you
- **Built-in file browser** — inspect a pane's worktree, search files, and preview code or diffs without leaving psyche
- **Pane visibility controls** — hide individual panes, isolate one project, or restore everything later without stopping work
- **Multi-project cockpit** — add multiple repos to the same session and switch scope from the sidebar
- **Rituals** — open, save, and attach reusable project setup recipes without restoring brittle tmux snapshots
- **Fix OpenClaw cockpit** — a built-in ritual opens Coven repair, verification, diff watch, and session panes so rescue work stays visible
- **Coven sessions** — when Coven is running locally, the sidebar shows live session status and `[o]` opens any session as a visible psyche pane
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

When focus is inside a work pane, tmux receives your keys instead of psyche. Use `Ctrl-b` then `Left Arrow` to return to the psyche sidebar. When mouse events are enabled, click a pane/thread/worktree row to select it and double-click a pane/thread/worktree name or project header to edit it inline. On macOS, `Alt+Shift+M` opens the focused pane menu when your terminal sends Option as Meta. In Terminal.app, enable **Settings > Profiles > Keyboard > Use Option as Meta key**. In iTerm2, use **Settings > Profiles > Keys > Left/Right Option Key > Esc+**.

## Requirements

- tmux 3.0+
- Node.js 18+
- Git 2.20+
- At least one supported agent CLI for agent panes (for example [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), [OpenCode](https://github.com/opencode-ai/opencode), [Cline CLI](https://docs.cline.bot/cline-cli/getting-started), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Qwen CLI](https://github.com/QwenLM/qwen-code), [Amp CLI](https://ampcode.com/manual), [pi CLI](https://www.npmjs.com/package/@mariozechner/pi-coding-agent), [Cursor CLI](https://docs.cursor.com/en/cli/overview), [Copilot CLI](https://github.com/github/copilot-cli), [Crush CLI](https://github.com/charmbracelet/crush)). Plain terminal panes work without an agent CLI.
- [OpenRouter API key](https://openrouter.ai/) (optional, for AI branch names, status analysis, and commit messages)

## Coven and OpenCoven

psyche works as a standalone tmux/worktree cockpit. It also speaks to Coven when a local Coven daemon is available, so OpenCoven-managed harness sessions can appear beside normal psyche panes.

Coven is the harness substrate. psyche is the cockpit. OpenMeow and OpenClaw can sit above them as intake and orchestration layers.

Demo loop:

1. Open a project in psyche.
2. Launch a Coven-backed Codex or Claude Code session.
3. Watch it as a visible pane/session.
4. Inspect files and diffs.
5. Merge, create a PR, archive, or clean up explicitly.

See [psyche + Coven demo loop](./docs/COVEN-DEMO-LOOP.md) and the [OpenCoven public roadmap](https://github.com/OpenCoven/coven/blob/main/docs/ROADMAP.md).

## Docs

- [Documentation index](./docs/README.md)
- [Demo loop](./docs/DEMO-LOOP.md)
- [psyche + Coven demo loop](./docs/COVEN-DEMO-LOOP.md)
- [Product spec](./docs/PRODUCT-SPEC.md)
- [Smoke test](./docs/SMOKE.md)
- [Contributing](./CONTRIBUTING.md)

## Contributing

See **[CONTRIBUTING.md](./CONTRIBUTING.md)** for the recommended local "psyche-on-psyche" development loop, hook setup, and PR workflow.

## License

MIT
