# Psyche Native iOS Cloud Terminal Design

- **Status:** approved for planning by the 2026-08-01 autopilot objective
- **Product:** Psyche Build for iPhone and iPad
- **Primary experience:** a touch- and keyboard-optimized terminal cockpit for coding from anywhere
- **Recommended architecture:** native SwiftUI client + paired Psyche host + secure cloud relay and storage

## Objective

Create a native iOS application that makes coding-agent sessions practical on
an iPhone or iPad. The app must preserve Psyche's visible terminal and
worktree model while adding secure remote connectivity, durable cloud state,
and an interaction layer designed for touch, software keyboards, external
keyboards, intermittent networks, and small screens.

The iOS app is a control surface, terminal renderer, and offline-capable
session client. It does not attempt to run arbitrary local shells, tmux,
Node.js CLIs, or coding agents inside the iOS sandbox. Execution remains on a
paired Mac/Linux host in the first release and may later run in a managed cloud
workspace through the same session protocol.

## Success condition

The design is successful when it provides an implementable path for a user to:

1. Sign in, pair a trusted Psyche host, and reconnect from outside the local
   network without opening inbound ports.
2. Browse projects, panes, Coven sessions, status, and attention events.
3. Create a worktree-backed coding lane, select an agent, send a prompt, and
   attach to its live terminal.
4. Use the terminal comfortably with touch or hardware keyboard input,
   including control keys, escape sequences, text selection, copy/paste,
   resizing, and reconnect/resume.
5. Inspect files and diffs, approve bounded actions, and receive completion or
   attention notifications.
6. Recover useful state after app suspension, network loss, host restart, or
   relay interruption.
7. Store account, device, project, session, draft, preference, notification,
   and optional encrypted transcript metadata in the cloud without making the
   cloud database authoritative for git or process state.
8. Ship through measurable milestones with security, protocol, unit,
   integration, UI, performance, and TestFlight acceptance gates.

## Validation loop

Every milestone follows the same loop:

1. Define a user-visible acceptance scenario and protocol contract.
2. Add deterministic unit and contract tests before integrating UI.
3. Run the scenario against a local fake host, then a real Psyche/tmux host.
4. Repeat under disconnect, reconnect, duplicate-message, process-restart, and
   app-backgrounding faults.
5. Measure terminal input latency, stream recovery, memory use, battery impact,
   and data-loss behavior.
6. Promote only when automated checks pass and the TestFlight checklist can be
   completed on both iPhone and iPad.

The release-level proof is a 30-minute remote coding session that creates a
lane, runs an agent, survives a network handoff and app suspension, reviews the
diff, and completes an explicit merge or PR action without lost input,
duplicated actions, or an unscoped filesystem operation.

## Existing repository baseline

Psyche Build already contains most of the host-side primitives needed for an
iOS companion:

- `src/services/bridge/BridgeDaemon.ts` exposes authenticated project, pane,
  ritual, terminal-stream, and input operations.
- `src/services/bridge/PaneStreamHub.ts` fans tmux control-mode output into
  per-pane buffers and forwards raw input bytes.
- `src/services/bridge/PaneOutputBuffer.ts` provides bounded replay with
  monotonic sequence numbers.
- `src/services/bridge/PairingFlow.ts` and `TokenStore.ts` implement a
  short-lived pairing window, persistent device tokens, and revocation.
- `src/services/bridge/wireProtocol.ts` defines a mobile-oriented protocol v2
  and explicitly references a Swift `PsycheCore` mirror.
- `src/daemon/protocol.ts` defines a second, newer control protocol with
  projects, panes, PTY attach/input/resize, Coven sessions, and capability
  routing.
- The web terminal already demonstrates mobile control keys and ANSI rendering,
  but a native app should use a mature VT terminal engine instead of carrying
  that custom parser forward.

The main architectural debt is that the repository has two overlapping bridge
protocols. The iOS effort must consolidate them before adding cloud transport;
otherwise local and remote clients will drift.

## Product principles

1. **Terminal first, not terminal only.** The terminal is the center of the
   experience, while native navigation, status, files, diffs, approvals, and
   notifications reduce the amount of fragile terminal manipulation required.
2. **Remote execution is explicit.** Every session visibly identifies its host,
   project root, worktree, branch, agent, and connectivity mode.
3. **No invisible destructive automation.** Merge, push, PR, delete, kill, and
   credential-sensitive actions require clear policy and confirmation.
4. **Fast re-entry beats perfect mirroring.** The app should restore the active
   project, pane, terminal viewport, draft prompt, and last acknowledged stream
   sequence within seconds.
5. **Cloud is a relay and durable control plane, not the source of truth for
   code.** Git repositories and running processes remain authoritative on the
   execution host.
6. **Private by default.** Source files and full terminal transcripts are not
   uploaded unless the user enables a feature that requires them.
7. **One protocol across LAN, internet relay, and future cloud workspaces.**

## Architecture options

### Option A: LAN-only native companion

The app connects directly to the existing TLS/Bonjour bridge.

**Advantages**

- Lowest implementation cost.
- Reuses pairing and streaming code.
- No hosted infrastructure or account system.

**Disadvantages**

- Does not satisfy coding from anywhere.
- Bonjour and private IP connectivity fail outside the local network.
- Host discovery, notifications, and durable cross-device state remain weak.

### Option B: Hybrid host with secure cloud relay — recommended

A lightweight host connector maintains an outbound authenticated WebSocket to
the cloud. The iOS app connects to the same relay. The relay authorizes and
routes protocol frames while durable services store metadata, drafts,
preferences, cursors, notifications, and optional encrypted artifacts.

**Advantages**

- Works over cellular, NAT, captive networks, and changing IP addresses.
- Reuses Psyche's tmux/worktree/agent engine.
- Avoids the cost and operational complexity of managed compute in v1.
- Creates the transport seam needed for cloud workspaces later.
- Permits direct LAN mode as a latency-optimized fallback.

**Disadvantages**

- Requires accounts, device identity, relay infrastructure, abuse controls,
  observability, and a stricter security model.
- The user's host must remain online for host-backed sessions.

### Option C: Cloud-native workspaces first

Every coding session runs in an ephemeral hosted VM or container.

**Advantages**

- The phone is fully independent of a home computer.
- Compute, storage, networking, and lifecycle can be standardized.

**Disadvantages**

- Highest cost and security burden.
- Requires repository credential handling, workspace images, quotas, billing,
  warm pools, sandboxing, egress controls, and data retention policy.
- Delays the terminal experience while rebuilding capabilities Psyche already
  has on the host.

### Decision

Implement Option B first. Keep runtime discovery and session attachment behind
interfaces so Option C can be added as a second execution-provider type rather
than a replacement.

## System architecture

```text
┌──────────────────────── Native iOS app ────────────────────────┐
│ SwiftUI shell │ TerminalKit │ Files/Diff │ Drafts │ Keychain   │
│ Session store │ Offline cache │ Push handling │ Telemetry opt-in│
└───────────────┬───────────────────────────────┬─────────────────┘
                │ direct local TLS/WSS          │ internet WSS/HTTPS
                │                               ▼
                │              ┌──────── Psyche Cloud ───────────┐
                │              │ Auth and device registry        │
                │              │ Session relay / presence        │
                │              │ Metadata and cursor store       │
                │              │ Artifact/blob storage           │
                │              │ Push notification service       │
                │              │ Audit, rate limit, observability │
                │              └──────────────┬──────────────────┘
                │                             │ outbound WSS
                ▼                             ▼
┌────────────────────── Psyche host connector ───────────────────┐
│ Protocol gateway │ policy engine │ idempotency │ event journal │
│ Existing Psyche/tmux/worktrees/agents/Coven integration         │
└──────────────────────────────┬───────────────────────────────────┘
                               ▼
              Local Mac/Linux or future cloud workspace
```

### Native iOS modules

#### AppShell

Owns authentication state, adaptive navigation, deep links, lifecycle,
background transitions, global error presentation, and dependency injection.
Use SwiftUI navigation with an iPhone stack and an iPad three-column layout.

#### Identity

Uses Sign in with Apple as the minimum App Store-friendly identity and may add
GitHub OAuth for repository-oriented features. Stores refresh credentials,
paired-host device keys, and local encryption keys in Keychain. A Secure
Enclave-backed signing key should identify each installation when available.

#### ConnectionManager

Selects direct LAN or relay transport, performs protocol negotiation, restores
subscriptions, sends heartbeats, applies exponential backoff with jitter, and
publishes explicit connection states:

`offline`, `discovering`, `connecting`, `authenticating`, `syncing`,
`connected`, `degraded`, and `blocked`.

It must never silently switch to a different host or project.

#### PsycheCore

A local Swift package containing versioned wire models, codecs, request
correlation, stream framing, capability negotiation, domain models, and fake
transports. Generate shared protocol fixtures from one schema source rather
than maintaining unrelated TypeScript and Swift unions.

#### TerminalSession

Owns a terminal emulator instance, stream sequence cursor, viewport size,
input queue, replay recovery, selection, clipboard policy, and per-pane
connection lifecycle. Use a maintained native terminal library such as
SwiftTerm, wrapped behind a `TerminalRendering` interface so the engine can be
replaced or patched independently.

#### CodingKeyboard

Provides an always-available accessory row with configurable `Esc`, `Tab`,
`Ctrl`, `Alt/Option`, arrows, pipe, slash, dash, backtick, braces, and a
command-palette key. Modifier keys support tap-to-latch and hold-to-chord.
Haptics and visible latch state prevent ambiguous input.

Gestures:

- one-finger drag scrolls terminal history;
- two-finger drag moves the cursor or emits arrows when cursor mode is active;
- long press starts selection;
- edge swipe opens the session drawer;
- pinch changes font size, not terminal dimensions, until the gesture ends;
- an explicit keyboard button focuses input and avoids accidental keyboard
  activation while scrolling.

#### ProjectStore

Maintains projects, panes, Coven sessions, attention counts, host presence, and
recent activity. It merges cloud metadata with authoritative live host state
and marks stale data rather than presenting cached state as live.

#### WorkspaceActions

Provides typed operations for creating panes, launching Coven sessions,
focusing, resizing, killing, renaming, running rituals, reviewing diffs,
merging, pushing, and opening PRs. Every mutating request carries a request ID,
idempotency key, expected project/host identity, and policy classification.

#### FilesAndDiff

Starts read-only. It requests bounded files, directory listings, git status,
and unified diffs through scoped host APIs. Syntax highlighting and diff
rendering are native. Editing files directly on iOS is intentionally deferred
until terminal and review reliability are proven.

#### OfflineStore

Uses SwiftData or SQLite for non-secret cache data:

- host and project summaries;
- pane summaries;
- terminal scrollback windows;
- last acknowledged sequence per stream;
- draft prompts;
- recent commands;
- pending safe actions;
- preferences and keyboard layouts.

Secrets remain in Keychain. Cached terminal and file content use iOS file
protection and a user-controlled retention policy.

### Host modules

#### UnifiedProtocolGateway

Replaces the duplicate mobile v2 and daemon v0 surfaces with a single
versioned protocol. Existing local clients receive a compatibility adapter
during migration.

The protocol separates:

- request/response control messages;
- server events;
- terminal binary streams;
- file/diff payloads;
- action approval challenges;
- capability negotiation and versioning.

#### RelayConnector

Runs with the Psyche daemon and creates an outbound TLS connection to the cloud
using short-lived credentials. It registers presence for a stable host ID,
forwards authorized frames, reconnects after sleep or network change, and does
not expose a listening public port.

#### PolicyEngine

Evaluates each operation against project scope, role, host settings, action
risk, and user approval. Existing project-root containment remains mandatory.
The cloud relay cannot broaden permissions granted by the host.

#### EventJournal

Assigns monotonic per-session event sequence numbers and retains a bounded
replay window. Terminal data remains byte-oriented, but control operations and
state transitions become journaled events. This supports resume, duplicate
suppression, notifications, and diagnostics.

#### FileService

Provides read-only, size-limited, project-scoped file tree, file content, git
status, and diff operations. It rejects symlink escapes and paths outside the
canonical project or worktree root.

## Cloud control plane

The cloud implementation should begin as a small, provider-isolated service.
A Cloudflare deployment is a strong fit for the relay phase:

- Workers for HTTPS APIs, auth callbacks, signed upload URLs, and policy
  endpoints;
- Durable Objects for per-host or per-live-session WebSocket coordination,
  presence, ordering, and short replay windows;
- D1 for accounts, organizations, devices, hosts, projects, session metadata,
  notification preferences, and audit indexes;
- R2 for optional encrypted transcript chunks, screenshots, logs, and exported
  artifacts;
- Queues for push notifications, audit processing, cleanup, and asynchronous
  fan-out;
- Apple Push Notification service integration for pane attention and session
  completion.

Keep these behind `RelayStore`, `MetadataStore`, `ArtifactStore`, and
`NotificationSink` interfaces. The product protocol must not expose
Cloudflare-specific identifiers.

### Cloud data authority

| Data | Authority | Cloud retention |
|---|---|---|
| Git repository and worktree files | execution host / git remote | not stored by default |
| Process and tmux state | execution host | presence and summary only |
| Pane and session metadata | host live state | durable cache/index |
| Terminal output | host journal | bounded relay buffer; optional encrypted archive |
| Draft prompts and preferences | user cloud account | durable |
| Device and host identities | cloud registry + device keys | durable |
| Action audit events | host and cloud append-only records | policy-defined |
| Large artifacts | host or R2 | explicit upload only |

### Suggested data model

- `users`
- `organizations`
- `memberships`
- `devices`
- `hosts`
- `host_credentials`
- `projects`
- `sessions`
- `panes`
- `subscriptions`
- `stream_cursors`
- `drafts`
- `preferences`
- `notification_endpoints`
- `action_requests`
- `audit_events`
- `artifact_manifests`

All records use opaque IDs. Project paths are host-private and should be
redacted or represented by a user-selected display name in cloud indexes.

## Unified protocol v3

### Envelope

Every JSON control frame contains:

```json
{
  "version": 3,
  "type": "panes.create",
  "requestId": "uuid",
  "idempotencyKey": "uuid",
  "hostId": "host-id",
  "projectId": "project-id",
  "sentAt": "ISO-8601",
  "payload": {}
}
```

Responses repeat `requestId`. Events include `eventId`, `sessionId`, and a
monotonic `seq`. Protocol negotiation advertises supported capabilities so an
older host can remain usable with a reduced UI.

### Minimum control surface

- account/device: authenticate, register, revoke, list
- hosts: list, presence, capabilities, pair, unpair
- projects: list, open, recent
- panes: list, create, update metadata, status, kill
- terminal: attach, detach, resize, input, snapshot, replay
- Coven: list sessions, launch, attach, send input, kill
- rituals: list, launch
- files: list, read bounded content, git status, diff
- actions: request, challenge, approve, reject, result
- notifications: subscribe, preferences, acknowledge

### Terminal stream

Binary terminal frames use a compact fixed header containing protocol version,
stream ID, sequence, flags, and payload length. Flags identify snapshot,
incremental output, gap, compression, exit, and error frames.

Input is not considered accepted until the host acknowledges its input
sequence. The app may queue ordinary text briefly during reconnect, but it
must not automatically replay control sequences, Enter, or destructive
shortcuts without explicit user confirmation after an ambiguous disconnect.

### Resume behavior

On reconnect, the app sends the last acknowledged control-event and terminal
sequence numbers. The host returns missing data if retained; otherwise it sends
a fresh snapshot with `gap=true`. The terminal is reset from the snapshot
before new incremental frames are applied.

## Key user journeys

### First launch and pairing

1. User signs in.
2. The app explains that code executes on a trusted host.
3. On the Mac/Linux host, the user opens Psyche and runs the Pair action.
4. The phone discovers the host on LAN or scans a QR/deep link containing a
   short-lived pairing challenge.
5. Both devices display a matching verification phrase.
6. The host approves the device and the app stores a device-bound credential.
7. The host connector registers outbound relay presence.
8. The app opens the project list and records whether the connection is direct
   or relayed.

### Start a coding task

1. Tap **New lane**.
2. Choose a project and optional subdirectory.
3. Enter or dictate a task.
4. Pick an agent or choose a plain terminal.
5. Review generated branch/worktree name and autonomy profile.
6. Submit once; the idempotent create request returns a pane immediately.
7. The app opens the terminal and shows creation progress as structured events.

### Work in the terminal

The terminal occupies the full content area. A compact status bar shows host,
branch, agent, connection quality, and attention state. The keyboard accessory
and command palette cover common terminal actions. Users can hide all chrome
with a focus-mode gesture or hardware shortcut.

### Review and finish

The session drawer shows changed-file count, tests, agent status, and pending
approval. The user opens a native diff, then selects Merge, Create PR, Keep
branch, or Close terminal. Destructive cleanup remains a separate action.

### Offline and reconnect

Cached projects and sessions remain visible but are labeled stale. Drafts are
editable offline. Live terminal input is disabled unless the app has an
authenticated connection. After reconnect, the app restores subscriptions and
resolves stream gaps before enabling input.

## Security and privacy

### Threat model

Protect against:

- stolen phones;
- compromised cloud credentials;
- malicious or replayed relay frames;
- host impersonation;
- cross-project path traversal;
- symlink escape;
- duplicate destructive requests;
- unauthorized device persistence;
- transcript leakage;
- relay operators reading sensitive content;
- notification content appearing on a lock screen.

### Required controls

- TLS 1.3 for all links.
- Device-bound asymmetric keys and short-lived access tokens.
- Explicit host trust with key pinning and visible host identity.
- End-to-end encryption for terminal, file, prompt, and artifact payloads when
  relayed. The relay routes ciphertext and minimal metadata.
- Keychain storage for credentials and encryption keys.
- iOS data protection for caches.
- Canonical project-root and worktree containment on every host operation.
- Idempotency and expiry on all mutations.
- Confirmation challenges for merge, push, PR, kill, delete, credential use,
  and policy changes.
- Device revocation from both host and account control planes.
- Redacted logs and opt-in diagnostics.
- Configurable transcript retention, defaulting to local bounded scrollback and
  no cloud archive.
- Generic lock-screen notifications unless the user opts into details.

## Reliability and error handling

- Every operation has a typed, user-actionable error code.
- Connection loss never appears as command success.
- Cached state is labeled with last-updated time.
- Mutations transition through `queued`, `sent`, `accepted`, `running`,
  `succeeded`, `failed`, or `unknown`; an `unknown` result requires explicit
  reconciliation before retry.
- Host sleep, daemon restart, app suspension, relay failover, and duplicate
  delivery are first-class test scenarios.
- Backpressure limits terminal buffers and file payloads.
- Slow consumers receive a snapshot gap rather than unbounded memory growth.
- Push notifications are hints; the app refreshes authoritative state when
  opened.

## Performance budgets

- Warm app to cached project list: under 500 ms on supported devices.
- Connected app to interactive terminal: p50 under 1 s, p95 under 3 s.
- Added relay input latency: p50 under 100 ms, p95 under 250 ms excluding the
  user's network.
- Terminal rendering: sustained 60 fps for normal output and no main-thread
  stalls over 100 ms during burst output.
- Resume after short disconnect: under 2 s when replay is available.
- iPhone memory target: under 200 MB with one active terminal and bounded
  scrollback.
- Background idle battery use: negligible; no permanent polling loop.

## Accessibility

- Dynamic Type for all non-terminal chrome.
- VoiceOver labels and actions for panes, status, keyboard modifiers, and
  dialogs.
- Adjustable terminal font, line spacing, contrast, and cursor style.
- Do not rely on color alone for status.
- Full hardware keyboard navigation with discoverable shortcuts.
- Reduced-motion support and haptic toggles.

## Scope

### MVP

- iPhone and iPad native app.
- Sign in, device registration, LAN pairing, and relay connection.
- Project/pane list and status.
- Create plain or agent-backed panes.
- Reliable terminal attach/input/resize/replay.
- Custom coding keyboard and hardware keyboard shortcuts.
- Draft prompts and cached session metadata.
- Attention/completion push notifications.
- Read-only git status, files, and diffs.
- Explicit kill, merge, and PR actions through host policy challenges.

### Deferred

- Local arbitrary code execution on iOS.
- Full native source editor or IDE.
- Collaborative shared terminals.
- Voice-driven autonomous coding.
- Managed cloud workspaces and billing.
- Cloud indexing of entire repositories.
- Automatic destructive action approval.
- Background terminal execution by the iOS app.

## Testing strategy

### Shared protocol

- Golden JSON and binary fixtures consumed by TypeScript and Swift.
- Property tests for framing, ordering, truncation, and unknown fields.
- Compatibility tests for v2 mobile and v0 daemon adapters.
- Fuzz tests for malformed lengths, invalid UTF-8 control frames, oversized
  payloads, and sequence gaps.

### Host

- Unit tests for policy, scope containment, replay, idempotency, relay
  reconnect, and file limits.
- Integration tests with real tmux panes and fake agents.
- Fault injection for host restart, sleep, output bursts, and stale approval.

### Cloud

- Durable relay ordering and disconnect tests.
- Authorization isolation across users, organizations, hosts, and projects.
- Load tests for concurrent WebSockets and burst terminal output.
- Queue retry and duplicate push tests.
- Retention and deletion tests.

### iOS

- Unit tests for reducers, stores, protocol codecs, action state machines, and
  resume logic.
- Terminal rendering/input tests using recorded ANSI/VT fixtures.
- UI tests for pairing, pane creation, keyboard controls, reconnect, diff
  review, approval, and error states.
- Network Link Conditioner scenarios for latency, loss, handoff, and offline.
- Physical-device tests for software keyboard, external keyboard, background
  suspension, memory pressure, and rotation.

### End-to-end release scenarios

1. LAN pair and direct terminal.
2. Cellular relay terminal with the host behind NAT.
3. Create an agent lane and receive attention notification.
4. Suspend for five minutes, resume, and recover without terminal corruption.
5. Lose the network after sending input and reconcile the ambiguous action.
6. Review a diff and create a PR.
7. Revoke the device and verify immediate access loss.
8. Attempt cross-project and symlink path access and verify rejection.

## Delivery checkpoints

### Checkpoint 0: Protocol and product foundation

Unify the two host protocols, publish schemas and golden fixtures, add
capability negotiation, and preserve compatibility adapters.

### Checkpoint 1: Native LAN vertical slice

Ship an internal SwiftUI app that pairs locally, lists panes, attaches one
terminal, sends input, resizes, and reconnects.

### Checkpoint 2: Mobile interaction quality

Add the coding keyboard, command palette, gestures, adaptive iPhone/iPad
layouts, session drawer, cached scrollback, drafts, and accessibility.

### Checkpoint 3: Cloud identity and relay

Add accounts, device/host registry, outbound host connector, end-to-end
encrypted relay, presence, remote reconnect, and audit events.

### Checkpoint 4: Cloud storage and notifications

Persist metadata, preferences, drafts, cursors, optional encrypted artifacts,
and APNs notifications with retention controls.

### Checkpoint 5: Coding workflow completeness

Add pane creation, agents, Coven sessions, files, diffs, rituals, approvals,
merge, and PR flows.

### Checkpoint 6: Hardening and TestFlight

Complete fault injection, performance budgets, security review, privacy
manifest, App Store disclosures, beta telemetry, support diagnostics, and
release runbooks.

### Checkpoint 7: Managed cloud workspace discovery

Only after host-backed MVP retention and reliability targets are met, prototype
an `ExecutionProvider` that provisions managed cloud workspaces behind the same
protocol.

## Key decisions and assumptions

- Minimum deployment target should be selected during implementation based on
  the current App Store and dependency support window; target the newest two
  major iOS/iPadOS generations unless product requirements demand older
  devices.
- SwiftUI is the app shell; terminal emulation is wrapped as an isolated native
  component.
- The first release requires an online Psyche host for execution.
- Direct LAN and cloud relay transports coexist.
- Cloud transcript storage is opt-in and encrypted.
- Read-only native file and diff review precedes native editing.
- The existing iOS-compatible Rust engine precedent may be reused for shared
  domain logic when it reduces duplication, but protocol and UI work should
  not block on embedding Rust.
- Cloud-provider choices are implementation details behind interfaces.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Terminal library lacks required VT behavior | Maintain recorded compatibility corpus and isolate renderer |
| Relay adds perceptible latency | Prefer direct LAN, keep binary frames compact, locate relays near users |
| Duplicate protocols cause drift | Make protocol unification Checkpoint 0 and generate fixtures |
| Host sleeps while user is mobile | Clear presence state, actionable wake guidance, future wake integrations |
| App Store review questions terminal behavior | Clearly position app as a remote client; do not download or execute local code |
| Sensitive output reaches cloud | E2EE, minimal metadata, no transcript archive by default |
| Destructive action duplicated after reconnect | Idempotency keys, action reconciliation, approval expiry |
| Cloud cost grows with terminal bandwidth | Direct mode, bounded replay, compression after measurement, quotas |
| Small-screen terminal is frustrating | Focus mode, accessory keyboard, native drawers, iPad optimization, usability testing |

## Exit criteria for implementation planning

- Architecture option and v1 execution model are explicit.
- MVP and deferred scope are separated.
- Native, host, protocol, cloud, security, storage, UX, testing, and rollout
  boundaries are defined.
- Existing repository components and migration debt are identified.
- Every checkpoint has a measurable validation path.
- No placeholders or unresolved product decisions block task decomposition.
