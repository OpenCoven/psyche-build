<h1 align="center">Psyche Build ✨</h1>

<h3 align="center">Multiagent coding harness for parallel agent lanes</h3>

<p align="center">
  Manage multiple AI coding agents in visible, isolated terminal workspaces.<br/>
  Branch, develop, inspect, merge, and hand off — all in parallel.
</p>

<p align="center">
  <a href="https://github.com/OpenCoven/psyche-build/releases"><strong>Releases</strong></a>
  ·
  <a href="https://github.com/orgs/OpenCoven/projects/11"><strong>Roadmap</strong></a>
  ·
  <a href="https://github.com/OpenCoven/psyche-build/issues"><strong>Issues</strong></a>
</p>

GitHub is the public planning mirror; [Beads](./.beads/README.md) remains the
authoritative source for issue and roadmap state.

---

> **Upgrading from `comux`?** Psyche Build is the same tool under a new name,
> but it is a clean break — nothing is migrated, and hook scripts stop firing
> **silently**. See [Breaking changes](./docs/BREAKING-CHANGES.md).

## Distribution

The supported public macOS installation path for `v0.0.1` is:

```sh
brew install --cask opencoven/tap/psyche-build
open -a "Psyche Build"
```

The [GitHub Release](https://github.com/OpenCoven/psyche-build/releases/tag/v0.0.1)
contains signed and notarized Apple Silicon and Intel DMGs plus `SHA256SUMS`.
The Homebrew Cask installs only `Psyche Build.app`; it does not install the
Node CLI.

The iOS companion remains an independently gated internal-beta track under
[#200](https://github.com/OpenCoven/psyche-build/issues/200). This repository
does not currently claim a live TestFlight build, public App Store release, or
external TestFlight release.

Source development is separate; follow [CONTRIBUTING.md](./CONTRIBUTING.md) to
run the checkout. The Node CLI ships in the source tree and package archive,
but it is not an npm release for `0.0.1`. Windows, Linux, Android, external
TestFlight, and public App Store distribution are unavailable in `0.0.1`.

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

Press `u` to open rituals: reusable setup recipes for starting a project with a known pane layout. Built-ins include Start Coding, Terminal First, Review Stack, and Release Check. You can also save project rituals and attach a default ritual to a project.

Open the selected pane menu with `m` when you want to inspect, merge, create a PR, attach another agent, or clean up.

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

## The model

Every Psyche Build workflow uses the same four definitions:

- **Task** — one requested outcome.
- **Lane** — one agent or terminal working on that task.
- **Isolation mode** — an isolated worktree, a shared worktree, a plain
  terminal, or an optional provider-managed session.
- **Integration** — inspect, compare, merge, create a PR, archive, or clean up.

A pane is the concrete surface a lane runs in; a worktree is the most common
isolation mode. Psyche Build owns lane orchestration. Optional capability and
session providers register bounded integrations; an explicitly unavailable
provider fails closed instead of degrading silently.

## What it does

Psyche Build creates a tmux pane for each task. Every work pane gets its own git worktree and branch so agents work in complete isolation. When a task is done, open the pane menu with `m` and choose Merge to bring it back into your main branch, or Create GitHub PR to push the branch and file a pull request.

- **Worktree isolation** — each pane is a full working copy, so parallel lanes do not edit the same checkout
- **Agent support** — [Coven CLI](https://github.com/OpenCoven/coven), Claude Code, Codex, OpenCode, Cline CLI, Gemini CLI, Qwen CLI, Amp CLI, pi CLI, Cursor CLI, Copilot CLI, and Crush CLI
- **Multi-select launches** — choose any combination of enabled agents per prompt
- **AI naming** — branches, pane labels, and commit messages can be generated automatically
- **Smart merging** — review, auto-commit, merge, PR, and cleanup flows stay explicit
- **macOS notifications** — background panes can send native attention alerts when they settle and need you
- **Built-in file browser** — inspect a pane's worktree, search files, and preview code or diffs without leaving Psyche Build
- **Pane visibility controls** — hide individual panes, isolate one project, or restore everything later without stopping work
- **Multi-project cockpit** — add multiple repos to the same session and switch scope from the sidebar
- **Rituals** — open, save, and attach reusable project setup recipes without restoring brittle tmux snapshots
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
- At least one supported agent CLI for agent panes (for example [Coven CLI](https://github.com/OpenCoven/coven), [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), [OpenCode](https://github.com/opencode-ai/opencode), [Cline CLI](https://docs.cline.bot/cline-cli/getting-started), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Qwen CLI](https://github.com/QwenLM/qwen-code), [Amp CLI](https://ampcode.com/manual), [pi CLI](https://www.npmjs.com/package/@mariozechner/pi-coding-agent), [Cursor CLI](https://docs.cursor.com/en/cli/overview), [Copilot CLI](https://github.com/github/copilot-cli), [Crush CLI](https://github.com/charmbracelet/crush)). Plain terminal panes work without an agent CLI.
- [OpenRouter API key](https://openrouter.ai/) (optional, for AI branch names, status analysis, and commit messages)

## MCP server

`psyche mcp` exposes the project owner's leased pane and browser surface over
MCP (stdio JSON-RPC). It connects to the project control socket and starts the
detached owner when the socket is absent; mutations still pass through the
same authenticated authority, policy, approval, and receipt path as the UI.
For task-scoped agent use, start it with a trusted task binding so the control
server can derive scope from authenticated context instead of caller-supplied
`task_id`.

```json
{
  "mcp_servers": [
    {
      "name": "psyche",
      "command": "psyche",
      "args": ["mcp", "--task-id", "task-123"],
      "env": { "PSYCHE_CONTROL_TASK_TOKEN": "<task-bound-token>" },
      "type": "stdio"
    }
  ]
}
```

`--task-id <task-id>` or `PSYCHE_CONTROL_TASK_ID=<task-id>` must be paired with
`PSYCHE_CONTROL_TASK_TOKEN=<task-bound-token>`. The server binds that token to
one task subject during authentication, echoes the trusted `taskId` and
`subjectId` in its welcome frame, and the client rejects a mismatched welcome.
Task-bound MCP also pins `project_root` reads and commands to the canonical
launch project, accepting only that root or one of its symlink aliases.
Conflicting request `task_id` values are rejected with
`task_binding_mismatch` before any task-scoped control read or command is
sent. Task-bound clients may omit `task_id`, in which case the authenticated
binding supplies it. Each task keeps exactly one active subject by default:
rotating a token invalidates the prior token immediately, and the replacement
subject does not inherit the revoked subject's leases, pending requests,
approvals, or receipts. Already-open task-bound sockets are revalidated
against the active subject before every read and command, and capability
leases plus `approval.resolve` re-check that subject before use so stale
authority fails closed immediately. Pending approvals also keep durable
task/actor/subject plus lease/action ownership, so lease expiry/prune or
subject rotation can rewrite `approval_required` into one terminal
`action_invalidated` receipt without depending on a live lease map.
Task-bound pre-execution validation failures likewise keep exact
task/actor ownership and include lease id/revision whenever the runtime can
still prove that lease context; when it cannot, the receipt stays visible only
to that exact bound subject and never crosses task scope.
Starting `psyche mcp` without a task binding is still
allowed for operators and diagnostics, but non-operator task-scoped reads and
task-sensitive commands fail closed with `task_binding_required`; for
non-operator callers, a supplied `task_id` stays compatibility input, not
proof of authority. The legacy shared agent token
stays unbound and cannot use task-sensitive commands. Embedded launchers mint
and revoke task credentials through the public ESM subpath:

```ts
import {
  issueControlTaskCredential,
  issueControlTaskToken,
  issueControlTaskTokenForCanonicalRoot,
  revokeControlTaskCredential,
} from 'psyche-build/control-task-tokens';
```

These trusted-launcher helpers require operator/agent root secret material and
must not be exposed to untrusted agents. By default, control credential state
lives outside the repository under
`~/.config/psyche/control/projects/<sha256(canonicalProjectRoot)>/`, with
`control-credentials.json`, `task-credentials/<sha256(taskId)>.json`, and
`task-credential-locks/<sha256(taskId)>.lock/` stored as user-only `0700`
directories and `0600` files. Legacy in-project `.psyche` task credential
directories, lock directories, and task-binding files are treated as untrusted
input and are ignored rather than followed or migrated automatically.
This protects against malicious repository contents or sibling project paths
that try to precreate, symlink, hardlink, or rename credential state. It does
not protect against already-arbitrary code execution as the same user, which
can read process memory or the per-user state directory directly.
`issueControlTaskCredential()` returns the replacement token plus
`{ taskId, subjectId, principalId }` metadata for the new subject and reports
the replaced subject when one existed. `issueControlTaskToken*()` are
convenience wrappers for the one-active-token-per-task flow and return only the
replacement token. `revokeControlTaskCredential()` removes the active subject
for a task so the old token fails authentication on reconnect and on the next
read or mutation from an already-open socket.

| Tool | Does |
|---|---|
| `psyche_control_list` | List bounded controllable pane/browser resources, generations, and active approvals for the bound task subject; unbound non-operators receive `task_binding_required` |
| `psyche_control_lease` | Request, inspect, or release scoped authority for the bound task subject; bound clients may omit `task_id`, exact matches are accepted, and conflicts are rejected before any read or command; it cannot grant or approve authority |
| `psyche_pane_observe` | Read bounded pane output and status through an exact leased generation |
| `psyche_pane_action` | Perform one typed leased pane action and return its canonical receipt |
| `psyche_browser_inspect` | Capture a bounded semantic snapshot of an exact leased tab generation |
| `psyche_browser_action` | Perform one typed leased browser action and return its canonical receipt |
| `psyche_browser_script` | Submit an approval-gated browser script through an exact leased tab generation |
| `psyche_control_action_status` | Read the latest live receipt or redacted replay receipt for the bound task subject when durable ownership proves the action belongs to it |
| `psyche_list_panes` | Compatibility alias that lists pane resources visible to the bound task subject |
| `psyche_create_pane` | Compatibility alias for leased pane creation through the owner |
| `psyche_execute_task` | Compatibility alias that submits orchestration through the owner |
| `psyche_kill_pane` | Compatibility alias for approved pane close through the owner |
| `psyche_get_pane_output` | Compatibility alias for bounded leased pane observation |
| `psyche_list_rituals` | List built-in and project rituals |
| `psyche_list_worktrees` | List git worktrees for the project |

Every task-scoped tool accepts an omitted `task_id` when the MCP process starts
task-bound. Exact-bound `task_id` values are accepted, and conflicting values
are rejected before any control read or command. Without a task binding,
non-operator task-scoped reads and commands fail closed with
`task_binding_required`, so non-operator caller-supplied `task_id` values
remain compatibility-only and never authorize access on their own. When
`psyche_control_action_status` falls back to a replayed journal receipt, the
result keeps the redacted journal resource shape (`resource.idDigest`) instead
of inventing a live resource id.

See [Agent surface control](./docs/AGENT-SURFACE-CONTROL.md) for the complete
lease, approval, generation, browser-provider, redaction, and recovery model.

`psyche_kill_pane` **does not delete the pane's worktree or branch.** It returns
both so you can inspect or merge the work; removing them stays an explicit
action in the TUI, because a worktree can hold the only copy of uncommitted
changes.

## Optional integrations

Psyche Build's tmux, worktree, terminal, agent, file-browser, merge,
pull-request, ritual, settings, and cleanup workflows work independently.
Supported coding agents and a compatible local session provider can extend
those workflows without becoming prerequisites.

For optional agent and local-session boundaries, see
[Psyche Build integrations](./docs/INTEGRATIONS.md).

## Docs

- [Documentation index](./docs/README.md)
- [Breaking changes: comux → Psyche Build](./docs/BREAKING-CHANGES.md)
- [Bridge and daemon security model](./docs/BRIDGE-SECURITY.md)
- [Psyche Build integrations](./docs/INTEGRATIONS.md)
- [Product spec](./docs/PRODUCT-SPEC.md)
- [Smoke test](./docs/SMOKE.md)
- [Release runbook](./docs/RELEASE.md)
- [Contributing](./CONTRIBUTING.md)

## Contributing

See **[CONTRIBUTING.md](./CONTRIBUTING.md)** for the recommended local "Psyche-on-Psyche" development loop, hook setup, and PR workflow.

## License

MIT
