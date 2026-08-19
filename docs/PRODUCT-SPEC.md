# Psyche Build Product Spec

- **Status:** early public product
- **Package:** `psyche-build`
- **Command:** `psyche`
- **One-liner:** Psyche Build is a project-scoped multiagent coding harness that runs parallel agent lanes in visible tmux/worktree sessions.

## Thesis

Parallel coding agents are useful only when the work stays visible, scoped, and recoverable.

Psyche Build gives developers one cockpit for launching agent lanes, watching terminals, keeping branches isolated, and bringing work back through explicit review. It focuses the proven terminal-cockpit primitives — tmux panes, git worktrees, agent launchers, rituals, file browsing, and merge flows — with clean Psyche Build branding and a source package that can also be validated as a package archive.

> Branch, develop, inspect, and merge — all in parallel.

## Product shape

```text
Developer
    │
    ▼
Psyche Build cockpit
    ├─ projects
    ├─ panes
    ├─ git worktrees
    ├─ agent launchers
    ├─ rituals
    ├─ file browser
    ├─ merge / PR flows
    └─ optional project-scoped sessions
```

## Core model

The public model uses four definitions everywhere:

- **Task** — one requested outcome.
- **Lane** — one agent or terminal working on that task.
- **Isolation mode** — an isolated worktree, a shared worktree, a plain terminal, or a Coven-managed session.
- **Integration** — inspect, compare, merge, create a PR, archive, or clean up.

Psyche Build implements that model with these primitives:

- **Project** — an explicit repo/workspace launched into Psyche Build.
- **Cockpit** — the visible terminal control surface.
- **Pane** — one terminal workspace and the concrete surface a lane runs in, often backed by a worktree and agent process.
- **Worktree** — an isolated git checkout for a task or branch; the most common isolation mode.
- **Agent** — Coven Code, Claude Code, Codex, OpenCode, Cline CLI, Gemini CLI, Qwen CLI, Amp CLI, pi CLI, Cursor CLI, Copilot CLI, Crush CLI, or another configured coding launcher.
- **Capability provider** — resolves a lane's execution capability. Coven-native is the default; Psyche is an optional registration point; an explicitly unavailable provider fails closed.
- **Ritual** — a reusable project setup recipe for opening a known pane layout.
- **Operator** — the person coordinating visible work and approving consequential actions.
- **Optional session** — a provider-managed session that Psyche Build can list,
  launch, or attach only when its canonical project scope is proven.

## Target user

Psyche Build is for developers and maintainers who want multiple coding agents working at once without losing track of branches, terminals, tests, blockers, or handoffs.

The early user is comfortable with terminal tools and wants:

- parallel agent work without branch conflicts;
- terminal-level visibility;
- reusable setup rituals;
- explicit merge/PR/review control;
- project-scoped autonomy;
- a structured local control path for optional integrations.

## Product pillars

### 1. Worktree isolation

Every agent lane should be able to work in its own branch and checkout. Parallelism should not trample the main tree.

### 2. Visible execution

Every worker should be inspectable as a terminal pane. No mysterious hidden jobs as the primary experience.

### 3. Human-legible review

Psyche Build helps with merge, PR, and cleanup flows, but review remains explicit and understandable.

### 4. Repeatable setup

Rituals should make common project layouts fast without depending on brittle tmux snapshots.

### 5. Bridge-friendly local control

Optional clients should use Psyche Build's structured, project-scoped control
surface instead of blind terminal puppeteering.

The agent control surface is capability-leased and project-scoped. Agents may
act only on registered pane/browser resources at exact generations. Risky
effects pause for operator approval; resource replacement, provider disconnect,
or owner restart fails closed. The product does not substitute whole-desktop,
accessibility, coordinate, raw tmux, or shell control when a typed provider is
unavailable. See [Agent surface control](./AGENT-SURFACE-CONTROL.md).

## Capability targets

Psyche Build should keep the core user promise sharp:

- tmux pane orchestration;
- git worktree isolation;
- agent launcher registry;
- multi-select launches;
- AI naming for branches, panes, and commits;
- project/pane metadata;
- file browser and pane visibility controls;
- attention/completion heuristics and notifications;
- rituals for reusable layouts;
- merge, PR, and cleanup workflows;
- lifecycle hooks.

Psyche Build-specific additions:

- source `psyche-build` package and `psyche` command, validated through the package archive;
- cleaned public docs and branding;
- local bridge/daemon direction;
- optional local-session list/open/launch integration;
- project-scoped control APIs for trusted clients.

## v0 scope

### Included now / near-term

- Source/package-archive Node CLI `psyche`; npm publication is not part of `0.0.1`.
- TypeScript + Ink tmux cockpit.
- Project-scoped tmux session.
- Pane/worktree creation.
- Agent launcher registry.
- Multi-select agent launches.
- Built-in rituals and project rituals.
- Pane file browser and visibility controls.
- Merge/PR-oriented pane menu flows.
- Local daemon/control bridge.
- Optional local-session list/open/launch integration when a compatible
  provider is running; the macOS rail remains app-origin only.
- Smoke docs and contributor loop.

### Not yet

- Full native desktop cockpit as the primary public experience.
- Cloud terminals.
- Team collaboration.
- Hosted agent orchestration.
- Marketplace/plugin story.
- Broad public claims about stable automation policies.

## Bridge rules

The bridge must stay conservative:

- operate on explicitly launched project roots;
- reject out-of-project paths;
- prefer worktree-backed coding lanes;
- expose bounded pane capture/status APIs;
- avoid push, merge, publish, delete, or external actions without explicit approval;
- keep secrets and infrastructure URLs out of UI copy and logs.

## Optional integration boundary

Psyche Build accepts optional agent and session integrations only through
bounded, project-scoped interfaces. It revalidates canonical project identity,
resource ownership, lifecycle state, and requested capability before exposing
or acting on provider-managed state. Missing, incompatible, or unavailable
providers fail closed without disabling ordinary panes, worktrees, file
browsing, merges, pull requests, rituals, settings, or cleanup. See
[Psyche Build integrations](INTEGRATIONS.md).

## First demo loop

1. Open a repo in Psyche Build.
2. Press `n` and describe a coding task.
3. Pick Codex, Claude, or another configured agent.
4. Psyche Build creates an isolated worktree and terminal pane.
5. The agent works visibly.
6. Press `f` to inspect files or `m` to open the pane menu.
7. Merge, create a PR, attach another agent, or close the pane explicitly.
8. Press `u` to open a reusable ritual when starting a known workflow.
9. If an optional local session provider is available, open or launch a
   project-scoped session from the bridge path.

If this loop is boringly reliable, Psyche Build is doing its job.

## Optional integrations

Psyche Build remains complete as a standalone tmux and git-worktree cockpit.
Supported coding agents and a compatible local session provider may extend the
workflow, but they do not own Psyche Build's project identity, pane lifecycle,
merge decisions, or cleanup behavior. See
[Psyche Build integrations](INTEGRATIONS.md).
