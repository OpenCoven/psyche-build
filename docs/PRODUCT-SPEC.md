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

## Mobile companion shape

The iOS codebase is a planned companion surface, not a released product and
not an independent authority. The shipped source opens into a **Now-first**
information architecture:

| Width class | Root navigation | Detail behavior |
|---|---|---|
| Compact | Tabs ordered **Now**, Projects, Settings | Now rows and project panes push `PaneWorkspaceView` on a navigation stack |
| Regular | Sidebar ordered **Now**, Projects, Settings, with project rows under Projects | A detail stack shows Now, all projects, one selected project, or Settings |

Now is a cross-project inbox generated from the authoritative workspace
snapshot. It groups every published pane by state: needs attention, running, and
recent. A row opens the pane; if the store is stale it shows "Showing last known
state" with the last confirmation time instead of presenting the workspace as
live. The root keeps tab state across size-class changes, and the Now route's
pushed pane path is shared with the regular detail stack. The compact Projects
route is hosted in its own unbound navigation stack, so rotating from a compact
project or project pane reconstructs the regular shell at the Projects root.

iOS source currently has two composition roots:

- **Production root:** `MobileAppComposition.production()` wires
  `URLSessionControlTransport`, `ControlRequestClient`, `WorkspaceStore`,
  `RemoteActionStore`, `PairedHostStore`, `HostReadinessMachine`,
  `WorkspaceCache`, and `TerminalSessionRegistry`, then reconnects only to the
  stored host.
- **Fixture root:** `-uiFixture` launches deterministic in-memory state through
  `DemoStore`, `FixtureControlRequests`, and `FixtureTerminalClient`. Fixture
  roots construct no transport and no Keychain-backed store. Fixture names,
  fixture roots, `DemoStore`, `-uiFixture`, and fixture-only debug controls such
  as `fixture-deliver-live-snapshot` are test scaffolding, not production
  behavior.

### Mobile bridge contract

The bridge supports protocol versions **2** and **3**
(`SUPPORTED_PROTOCOL_VERSIONS = [2, 3]`). A connection initially receives a
legacy v2 welcome. The client sends `hello` with one supported version; v3 gets
a v3 welcome and may use top-level `control` envelopes and `workspaceChanged`
events. v2 remains the legacy pane/project/ritual message set.

The v3 mobile control envelope currently accepts these production request
families when the host has wired the corresponding executor:

| Area | Requests | Contract |
|---|---|---|
| Workspace | `workspace.snapshot`, `workspaceChanged` | Complete snapshots carry a monotonic per-bridge sequence. Incremental changes are ignored across gaps until a full snapshot is accepted. |
| Terminal streams | `panes.attach`, `panes.detach`, `panes.input`, `panes.resize` | Streams attach only to tmux-backed published panes; binary frames are ordered after attach metadata. |
| Pane lifecycle | `panes.spawn`, `panes.kill`, `panes.meta` | Spawn targets must be the published project root or one of its worktrees. Kill stops the process but preserves branch and worktree. |
| Inspection | `files.list`, `files.read`, `files.diff` | Inspection is scoped to the selected pane's published available worktree and rejects absolute, escaping, missing, bare, or prunable targets. |
| Actions | `actions.start`, `actions.respond` | Action sessions are host-owned, one-shot for each reply, scoped to a published pane, and cleared on owner/session loss. |
| Rituals | `rituals.launch` / legacy `launchRitual` | Publication is wired; production execution is not a supported mobile claim until #242 completes. PR #434 keeps published rituals unavailable for execution where the live launcher is not ready. |

Unsupported or unwired control commands return `command_not_supported`,
`control_unavailable`, or a correlated error; they must not be documented as
working production UI.

### Exact mobile limits and guarantees

These limits are source constants, not product aspirations:

| Limit or guarantee | Exact value | Source |
|---|---:|---|
| Bridge protocol versions | `2`, `3` | `src/services/bridge/wireProtocol.ts` |
| LAN WebSocket client frame cap | `1 MiB` | `src/services/bridge/WSSListener.ts` |
| Legacy pairing code | `6` digits | `src/services/bridge/PairingFlow.ts` |
| Legacy pairing window | `5 minutes` | `src/services/bridge/PairingFlow.ts` |
| Legacy pairing wrong-code budget | `5` attempts | `src/services/bridge/PairingFlow.ts` |
| Invite protocol profile | `bridge.v3` only | `src/services/bridge/inviteAuth.ts` |
| Invite lifetime | `10 minutes` | `src/services/bridge/inviteAuth.ts` |
| Invite secret entropy | `32` bytes | `src/services/bridge/inviteAuth.ts` |
| Invite ID entropy | `16` bytes | `src/services/bridge/inviteAuth.ts` |
| Invite wrong-presentation budget | `5` attempts | `src/services/bridge/inviteAuth.ts` |
| Retained invite audit tail | `16` records | `src/services/bridge/inviteAuth.ts` |
| Invite payload cap | `2,048` bytes | `src/services/bridge/inviteAuth.ts` |
| Invite expiry clock skew tolerance | `60 seconds` | `src/services/bridge/inviteAuth.ts` |
| Pane output ring buffer on host | `256 KiB` per pane | `src/services/bridge/PaneOutputBuffer.ts` |
| v3 terminal streams per bridge connection | `4` | `src/services/bridge/BridgeDaemon.ts` |
| Mobile attached terminal sessions | `2` | `native/ios/PsycheCore/Sources/PsycheCore/Terminal/TerminalSessionRegistry.swift` |
| Mobile retained output per pane | `64 KiB` | `native/ios/PsycheCore/Sources/PsycheCore/Terminal/TerminalSessionRegistry.swift` |
| Mobile control request timeout | `15 seconds` | `native/ios/PsycheCore/Sources/PsycheCore/Connection/ControlRequestClient.swift` |
| Workspace cache encoded file cap | `256 KiB` for the whole encoded `PersistedWorkspaceCache` file | `native/ios/PsycheCore/Sources/PsycheCore/State/WorkspaceCache.swift` |
| Workspace cache draft count | `24` per cached state | `native/ios/PsycheCore/Sources/PsycheCore/State/WorkspaceCache.swift` |
| Workspace cache draft length | `4,096` characters per draft | `native/ios/PsycheCore/Sources/PsycheCore/State/WorkspaceCache.swift` |
| Mobile pane-spawn idempotency hot cache | `128` keys | `src/services/bridge/MobileControlGateway.ts` |
| Pending remote action sessions | `64` | `src/actions/remoteActionSessions.ts` |
| Remote action session TTL | `5 minutes` | `src/services/bridge/MobileControlGateway.ts` |
| Mobile file preview cap | `200,000` bytes | `src/utils/fileBrowser.ts` |
| Git buffer for browser/diff inspection | `16 MiB` | `src/utils/fileBrowser.ts` |
| Published rituals per project | `50` | `src/workspace/ritualPublication.ts` |
| Project ritual store read cap | `512 KiB` store + `16 KiB` manifest | `src/utils/rituals.ts` |
| Published ritual metadata caps | ID `128` bytes, name `256` bytes, description `1,024` bytes | `src/utils/rituals.ts` |

### Mobile lifecycle and recovery

`HostReadinessMachine` is the authority for whether iOS may present a host as
ready. The legal spine is:

```text
pairing → authenticating → host_committed → synchronizing → ready
```

Host identity must commit durably before any workspace snapshot can become
authoritative. The machine treats transport, authentication, secure-store,
decode/revision, workspace-apply, and revocation failures as named boundaries.
Proven failures preserve prior authoritative state only as stale; indeterminate
secure-store or workspace publication fails closed instead of guessing. Stored
hosts may be adopted for reconnect, but adoption creates no new authority.

`WorkspaceStore` applies events only in order. Duplicate or old sequences are
ignored. A sequence gap marks the workspace stale and requires a full snapshot;
the store does not patch across holes. Restored cache state is immediately
stale and awaiting a connection snapshot. Live commands, file inspection, pane
creation, renames, stops, and ritual launches require a live workspace and a
published target.

`WorkspaceCache` stores host-keyed cached states containing the last confirmed
workspace, sequence, confirmation timestamp, selection, and drafts. The encoded
cache file is capped as a whole; draft count and draft length are enforced per
cached state. Corrupt or unreadable cache files surface explicit recovery errors
and preserve the original data where possible; they are not silently replaced
with an empty workspace.

Bonjour parsing is currently a discovery adapter only. It validates TXT
metadata, certificate fingerprint shape, supported protocol versions, and
deduplicates on server ID, but no production caller has shipped the complete
discovery/connect flow yet (Bead i7c.11 remains open).

Known open gaps: #435 tracks the lost-reply unknown-outcome guard; #241 still
requires physical-device acceptance and real-Keychain partial-write evidence;
#280 has only the invite protocol/fixture slice merged; #242 still owns ritual
execution; Bead i7c.11 owns discovery/connect; Beads i7c.10.3 and i7c.10.4
remain in progress.

## Core model

The public model uses four definitions everywhere:

- **Task** — one requested outcome.
- **Lane** — one agent or terminal working on that task.
- **Isolation mode** — an isolated worktree, a shared worktree, a plain terminal, or an optional provider-managed session.
- **Integration** — inspect, compare, merge, create a PR, archive, or clean up.

Psyche Build implements that model with these primitives:

- **Project** — an explicit repo/workspace launched into Psyche Build.
- **Cockpit** — the visible terminal control surface.
- **Pane** — one terminal workspace and the concrete surface a lane runs in, often backed by a worktree and agent process.
- **Worktree** — an isolated git checkout for a task or branch; the most common isolation mode.
- **Agent** — Coven CLI (stable config/internal ID `coven-code`), Claude Code, Codex, OpenCode, Cline CLI, Gemini CLI, Qwen CLI, Amp CLI, pi CLI, Cursor CLI, Copilot CLI, Crush CLI, or another configured coding launcher.
- **Capability provider** — registers a bounded optional execution or session integration with Psyche Build; an explicitly unavailable provider fails closed.
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
