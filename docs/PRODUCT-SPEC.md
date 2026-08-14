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
Human / OpenMeow / OpenClaw
          │
          ▼
  Psyche Build tmux cockpit
          │
          ├─ projects
          ├─ panes
          ├─ git worktrees
          ├─ agent launchers
          ├─ rituals
          ├─ file browser
          ├─ merge / PR flows
          └─ Coven sessions
```

## Core model

- **Project** — an explicit repo/workspace launched into Psyche Build.
- **Cockpit** — the visible terminal control surface.
- **Pane** — one terminal workspace, often backed by a worktree and agent process.
- **Worktree** — an isolated git checkout for a task or branch.
- **Agent** — Coven Code, Claude Code, Codex, OpenCode, Cline CLI, Gemini CLI, Qwen CLI, Amp CLI, pi CLI, Cursor CLI, Copilot CLI, Crush CLI, or another configured coding launcher.
- **Ritual** — a reusable project setup recipe for opening a known pane layout.
- **Conductor** — a human, OpenClaw familiar, Cody/OpenMeow, or bridge process coordinating work.
- **Coven session** — an optional Coven-managed harness session that Psyche Build's CLI or bridge can launch or open when a local Coven daemon is available. The macOS app rail does not render daemon-discovered sessions.

## Target user

Psyche Build is for developers and maintainers who want multiple coding agents working at once without losing track of branches, terminals, tests, blockers, or handoffs.

The early user is comfortable with terminal tools and wants:

- parallel agent work without branch conflicts;
- terminal-level visibility;
- reusable setup rituals;
- explicit merge/PR/review control;
- project-scoped autonomy;
- a future path for OpenMeow/OpenClaw/Coven orchestration.

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

OpenMeow, OpenClaw, Coven, and future clients should talk to structured local state instead of blind terminal puppeteering.

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
- Coven daemon and bridge session list/open/launch integration;
- OpenMeow/OpenClaw orchestration path.

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
- Coven daemon and bridge session list/open/launch integration when a local Coven daemon is running; the macOS rail remains app-origin only.
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

## Agentic capability boundary

The orchestration layer may run an agentic coding capability for an
authoritative Coven session. The supported boundary is intentionally narrow: planning, code
synthesis, tool routing, repository navigation, iterative refinement,
verification, evaluation, debugging, and reasoning policy.

`src/orchestration/capabilityRouter.ts` owns provider selection. Coven-native
behavior is the default and is a pass-through, so existing launches are
unchanged. A future Psyche integration registers a `psyche` strategy against
the same input/output contract; it does not branch inside session lifecycle,
path validation, PTY execution, or persistence code. Explicit Psyche routing
fails closed when no Psyche strategy is registered or the strategy does not
support the requested capability.

The bridge fetches the session from the daemon and revalidates its project root
and cwd before invoking any provider. The authoritative session harness and id
become capability context, so Psyche cannot run ahead of session initialization
or substitute lifecycle identity. Initial `POST /api/v1/sessions` payloads are
unchanged.

Authenticated bridge clients invoke the seam with
`coven.capabilities.execute`. The daemon owns the router instance and accepts
optional strategy registrations from embedded callers; the standalone daemon
ships only the Coven-native strategy until Psyche is available. Capability
execution is limited to `starting`, `running`, and `waiting` sessions, and all
terminal or detached states fail closed before provider code runs.

Every capability execution returns a provider-neutral trace with task and
trace IDs, attempt and idempotency metadata, tool calls, deltas, and evaluation
outcomes. The capability bridge returns that trace to the orchestration caller
for event-ledger persistence without adding fields to the daemon's session
launch payload.
The Rust daemon remains responsible for canonical project roots, cwd
containment, harness validation, process launch, and the authoritative session
ledger.

## First demo loop

1. Open a repo in Psyche Build.
2. Press `n` and describe a coding task.
3. Pick Codex, Claude, or another configured agent.
4. Psyche Build creates an isolated worktree and terminal pane.
5. The agent works visibly.
6. Press `f` to inspect files or `m` to open the pane menu.
7. Merge, create a PR, attach another agent, or close the pane explicitly.
8. Press `u` to open a reusable ritual when starting a known workflow.
9. If Coven is running, open or launch a Coven-managed session from the bridge path.

If this loop is boringly reliable, Psyche Build is doing its job.

## Relationship to OpenMeow, OpenClaw, and Coven

- **OpenMeow** is the lightweight intake surface: toss the task.
- **Cody/OpenClaw** is the conductor: decide what needs doing and report back.
- **Coven** is the harness substrate: run and expose managed coding sessions.
- **Psyche Build** is the cockpit: keep the visible terminal/worktree control plane understandable.

These integrations should make Psyche Build more useful, but Psyche Build must remain valuable as a standalone CLI.
