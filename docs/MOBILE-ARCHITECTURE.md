# Mobile cockpit architecture (Now-first)

**Status:** architecture contract for the planned iOS companion
**Owning issue:** [OpenCoven/psyche-build#214](https://github.com/OpenCoven/psyche-build/issues/214)
**Canonical outcome:** [#200 — iOS internal beta and continuity loop](https://github.com/OpenCoven/psyche-build/issues/200)
**Epic:** [#208 — Mobile multiproject and multipane cockpit](https://github.com/OpenCoven/psyche-build/issues/208)

This document describes the Now-first mobile information architecture and the
protocol, transport, security, state, and lifecycle behavior behind it. It
separates what is **implemented on `main` today** from what is **tracked open**
in the Phase 10 family. Where a guarantee is stated, the proving code path is
named; where behavior is planned, the owning issue is named instead. This
document is not a support claim: the iOS application is a **planned internal
beta pending #200**, and no TestFlight availability is claimed. See the
[support matrix](SUPPORT-MATRIX.md) for the distribution contract.

Related contracts: [bridge security](./BRIDGE-SECURITY.md),
[control-plane architecture](./CONTROL-PLANE.md), [product spec](./PRODUCT-SPEC.md),
[iOS source readme](../native/ios/README.md).

## Implementation status at a glance

| Area | Status on `main` | Tracked work |
|---|---|---|
| Protocol v2 legacy bridge messages | Implemented (`src/services/bridge/wireProtocol.ts`) | — |
| Protocol v3 typed control envelopes + `workspaceChanged` | Implemented on the host and in PsycheCore | — |
| TLS self-signed transport, certificate pinning, pairing, device tokens | Implemented on both sides | — |
| Canonical workspace snapshot → Swift `WorkspaceStore` | Implemented | — |
| Now inbox (Needs You / Running / Recent, cross-project) | Implemented in `WorkspaceStore` and `NowView` | — |
| Adaptive one/two-pane workspace, ≤2 attached terminal streams | Implemented (client cap 2, host cap 4) | — |
| Bounded file inspection (list/read/diff) over control envelope | Implemented | — |
| Bounded remote action mechanism (`actions.start`/`actions.respond`) | Implemented as a mechanism | #217 full guarded lifecycle flows |
| Bonjour parse/discovery/resolver types | Implemented as library types with tests | #216 production connect flow |
| Cross-launch protected workspace cache (`WorkspaceCache`) | **Not implemented** | #210 |
| Restore-cached-state-as-stale reconciliation UX | **Not implemented** (in-memory staleness only) | #211 (blocks #214) |
| Accessibility/performance gates, final acceptance matrix | **Not proven** | #209, #200 |

Anything below described as implemented is pinned by tests named in
[bridge security](./BRIDGE-SECURITY.md) and by the PsycheCore/PsycheApp test
schemes. Anything described as planned has no implementation in this
repository yet.

## Information architecture: Now first

The mobile cockpit opens into a **Now inbox**, not a project list. `Now` is
the default root tab, and the root tabs are **Now**, **Projects**, and
**Settings** (`CockpitView.swift`). Both shells share one selection model, so
rotating an iPad lands on the equivalent screen instead of resetting.

- **Now** is the cross-project attention surface. It is derived entirely from
  the host's canonical workspace snapshot: every published pane of every
  published project becomes a `NowItem` carrying its project identity.
- **Projects** drills into one project, its worktrees, and its panes.
- A pane workspace can be pushed on top of either root; the pushed pane
  survives a size-class change.

### Now sections and ranking

`WorkspaceStore.makeNowSections` groups every pane in the snapshot into three
sections, in this order:

1. **Needs You** — the pane reports `needsAttention`, or its status matches
   (case-insensitively) `waiting`, `failed`, or `blocked`.
2. **Running** — status matches `starting`, `running`, `working`, or
   `analyzing`.
3. **Recent** — everything else. An unrecognized status falls to Recent rather
   than being hidden.

Within a section, items sort by most recent `lastActivity` first (the host
stamps ISO-8601 activity timestamps), then project title, then pane title,
then pane id, so identical snapshots cannot reorder.

## Adaptive workspace: one or two panes

`TerminalSessionRegistry` owns every attached terminal and never more than
**two** (`maximumAttachedSessions = 2`). Showing a third pane detaches one
first rather than quietly keeping three streams alive; the cap is a property
of the registry, not of callers.

`PaneWorkspaceView` renders one pane, or two side by side when there is room:
regular width at ≥ 700 pt, or compact width in landscape at ≥ 640 pt. Portrait
hides the secondary rather than discarding it, so rotating back restores the
split. Only panes actually on screen get a `TerminalPaneView`, and the
registry attaches exactly those — the workspace never holds a live PTY
subscription per pane in a list.

## Host publication model

The LAN bridge publishes **one canonical workspace snapshot**
(`src/workspace/snapshot.ts`): a `revision`, and the projects the running TUI
actually has — each project with its root, title, worktrees (each with its
panes, recoverability, running/attention counts) and project-level panes. The
TUI builds it lazily on each read via `createTuiWorkspaceProvider`
(`src/index.ts`, `src/workspace/tuiSnapshot.ts`); the snapshot is the
authority on which panes exist, and it also drives replay-buffer reclamation
for panes that disappear.

- Mutations announce change once, only when host state actually changed
  (`onWorkspaceChanged` fires after a non-replayed spawn, kill, meta update,
  or ritual launch). Broadcasts coalesce to one in-flight scan plus one
  pending rescan, and are skipped when the revision did not advance.
- Each broadcast increments a host-side `sequence` and is sent as
  `workspaceChanged` **only to authenticated protocol-v3 sessions**. A
  replayed idempotent request does not announce a change that did not happen.

## Protocol v2/v3 typed control envelopes

`src/services/bridge/wireProtocol.ts` and
`native/ios/PsycheCore/Sources/PsycheCore/Protocol/` mirror each other:

- `LEGACY_PROTOCOL_VERSION = 2`, `PROTOCOL_VERSION = 3`,
  `SUPPORTED_PROTOCOL_VERSIONS = [2, 3]`. Both sides ship the same constants
  (`PsycheProtocolVersion` in Swift); discovery drops a host advertising
  neither.
- Negotiation is at `hello`: the client sends `protocolVersion`; an
  unsupported value is refused with a protocol-mismatch error, and `welcome`
  reports the negotiated version (plus `supportedVersions`).
- **v2 messages stay byte-compatible.** `listPanes`, `subscribePane`,
  `sendInput`, rituals, pairing, and the legacy server messages are unchanged;
  legacy clients never receive the v3-only frames.
- **v3 adds two top-level envelopes** around the legacy set:
  - `{ type: "control", payload: <MobileControlRequest|MobileControlResponse> }`
    — typed control envelopes that reuse the canonical daemon control
    vocabulary (`workspace.snapshot`, `panes.input/resize/detach/kill/meta`
    from `src/daemon/protocol.ts`) plus mobile-specific requests
    (`panes.spawn` with `idempotencyKey`, `panes.attach`,
    `files.list/read/diff`, `actions.start/respond`, `rituals.launch`).
  - `{ type: "workspaceChanged", payload: { revision, sequence, workspace } }`.
- JSON encodings mirror Swift `BridgeCoder`: ISO-8601 dates, sorted object
  keys (`stableStringify`), `Data` as base64. Terminal output travels as
  binary frames: `[1-byte streamId length][streamId UTF-8][8-byte big-endian
  sequence][payload]`.
- `control` requests are refused unless the session is authenticated, has
  negotiated v3, and the host has a workspace provider (`not_authenticated`,
  `protocol_mismatch`, or `control_unavailable` otherwise).

## Transport and security

The mobile client connects to the **LAN bridge** (`src/services/bridge/`) —
the TLS surface documented in [bridge security](./BRIDGE-SECURITY.md). The
loopback daemon is a separate surface with its own contract and is not the
mobile transport.

### Transport and pairing

- The TUI starts the bridge on `0.0.0.0` with an ephemeral HTTPS port and a
  **self-signed certificate**: 2048-bit RSA, SHA-256, 10-year validity,
  `basicConstraints CA=false`, `serverAuth` key usage, SANs `localhost` and
  `127.0.0.1`. Cert and key are written `0600` under a `0700` bridge
  directory and reused across restarts (`src/services/bridge/TLSCertificate.ts`).
  The certificate is self-signed by design; the pin, not a CA chain, is what
  the client trusts.
- Discovery advertises `_psyche._tcp` over Bonjour. Publication is
  best-effort; a network without multicast discovery does not break a stored
  endpoint.
- Pairing is a six-digit code inside a **5-minute window**
  (`PAIR_WINDOW_MS`) with a **5-attempt budget** (`PAIR_MAX_ATTEMPTS`); the
  window closes with reason `exhausted` after the budget and stays closed
  until the operator deliberately re-opens it. Code and token comparisons use
  `timingSafeEqual` behind a length guard. A successful pair issues a durable
  device token; the host can revoke a token, which also closes the live
  session.
- `maxPayload` is **1 MiB** per frame on the LAN bridge.

### Client-side pinning and host identity

- `PinnedCertificateDelegate` pins the **SHA-256 of the leaf certificate**
  over the raw certificate data for the first `serverTrust` challenge;
  anything else is cancelled, and a rejected pin is remembered and surfaced as
  re-pair guidance rather than looking like an ordinary socket drop.
- `PairedHostStore` treats the host's `serverID` as identity: names,
  addresses, and tokens may change, but `save` **refuses** to overwrite a
  known server ID whose certificate fingerprint changed
  (`identityChanged`). Only an explicit re-pair (`replace`) rewrites a pinned
  fingerprint.
- Paired-host records (server ID, name, endpoint, client ID, token) are stored
  in the device Keychain with
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (`KeychainSecureStore`).
  The fingerprint is a normalized 64-hex SHA-256 digest.

### Project-boundary scoping of every operation

Authentication is not authorization. The host resolves every control request
against the **current authoritative workspace snapshot** before executing:

- `panes.attach/input/resize`, `panes.kill`, `panes.meta`, and
  `actions.start` require the pane to be a **published, tmux-backed pane** of
  the snapshot (`unknown_target` / `pane_scope_violation` otherwise), and
  pane ids must match tmux's `%<digits>` form (`invalid_pane`).
- `panes.spawn` and `rituals.launch` require the target project to be
  published, and a spawn target must be the project root or one of its
  published worktree paths. The Swift `WorkspaceStore` re-checks the same rule
  client-side before sending.
- `files.*` inspection resolves the pane's worktree from the snapshot (the
  worktree must not be missing, bare, or prunable) and then enforces
  filesystem containment in `mobileInspection.ts`: the requested relative path
  is resolved through `realpath` — including existing ancestors — and must
  stay inside the worktree root (`invalid_path`, `path_outside_root`).
  Dependency paths are filtered out of listings, and previews are capped.
- `actions.respond` revalidates the original pane scope before the host
  continues an interaction, so a stale session cannot act on a pane that is
  no longer published (`pane_scope_violation`).
- Every wire field is validated as unknown data (non-empty strings, safe
  integers, canonical RFC 4648 base64 via `decodeBase64Payload`), and every
  failure is an error frame with a stable code, never a crash.

### Bounded resources

| Limit | Value | Where |
|---|---|---|
| WebSocket frame cap (host) | 1 MiB | `WSSListener.MAX_CLIENT_FRAME_BYTES` |
| Terminal streams per connection (host cap) | 4 | `MAX_CONTROL_STREAMS_PER_CONNECTION` |
| Attached terminal streams (client cap) | 2 | `TerminalSessionRegistry.maximumAttachedSessions` |
| Per-pane host replay buffer | 256 KiB line-aligned ring | `PaneOutputBuffer.DEFAULT_CAP` |
| Per-pane client output window | 64 KiB | `TerminalSessionRegistry.defaultOutputLimit` |
| File read/diff preview | 200,000 bytes, `truncated` flag | `MAX_PREVIEW_BYTES` |
| Pairing window / attempts | 5 minutes / 5 | `PairingFlow` |
| Remote action sessions | 5-minute TTL, max 64 pending | `RemoteActionSessions` |
| Remembered spawn idempotency keys | 128 | `MAX_REMEMBERED_SPAWNS` |

The client caps itself at two attached terminals, but the host does not depend
on it: a connection may hold at most four control streams, and attaching a
fifth is refused with `too_many_streams`.

## Terminal streams

`panes.attach` returns the mobile attach result — `streamId`, the pane's
`latestSeq`, `hasReplay`, and a `replayMode` of `append` or `replace` — before
any output frame; frames raised while the response is in flight are queued so
live bytes can never overtake the replay. Output frames are binary:
`[1-byte streamId length][streamId][8-byte big-endian sequence][payload]`.

- Reattach asks the host for the **delta** since the per-pane sequence cursor,
  which deliberately outlives a disconnect. A host that cannot continue from
  the cursor answers `replayMode: replace`, and the client discards its buffer
  instead of splicing unrelated output.
- Frames at or behind the cursor are dropped as replay/duplicates.
- Disconnect clears live sessions but keeps the cursors and the bounded
  output (64 KiB per pane) so a reattach is cheap.
- The host enforces its own stream cap and reclaims the replay buffer of any
  pane the workspace no longer publishes once no client is streaming it.

## Commands, files, and actions

Implemented over the control envelope, each revalidated on the host:

- **Create** — `panes.spawn` with an `idempotencyKey`: one execution per key;
  a retry replays the first outcome rather than spawning a second pane, and
  the same key with a different payload is refused. The target must be a
  published project root or worktree.
- **Stop** — `panes.kill` terminates the pane's process. The worktree and
  branch stay on disk: a remote client cannot destroy uncommitted work as a
  side effect of closing a pane, and the UI must not present stop as cleanup.
- **Rename** — `panes.meta` changes title/agent; requires a non-empty change
  and a published pane.
- **Rituals** — `rituals.launch` targets a published project.
- **Inspect** — `files.list` / `files.read` / `files.diff` are answered from
  the pane's published worktree only, bounded as above, with ANSI stripped
  from diffs. The client refuses inspection while its workspace is stale.
- **Actions** — `actions.start` runs one of the host's typed `PaneAction`s
  through the executor the TUI registers; multi-step results come back as
  `confirm` / `choice` / `input` / `cancel` interactions answered with
  `actions.respond`, which revalidates the pane scope before continuing.
  Pending sessions expire after 5 minutes and are capped at 64 per owner. A
  host that has not wired an action executor answers `command_not_supported`
  rather than crashing.

**Tracked open, not implemented:** the complete guarded merge/PR/cleanup
mobile flows (sibling handling, uncommitted-work choices, merge-target
fallbacks, PR review) are Phase 9 work in
[#217](https://github.com/OpenCoven/psyche-build/issues/217). The transport
and session machinery they will reuse exists; the guarded end-to-end flows are
not accepted yet.

## State, staleness, and lifecycle

`WorkspaceStore` is the single mobile source of truth and is deliberately
conservative about what it accepts:

- **Sequence gating.** Incremental events apply only in order (`nextSequence`
  must equal `sequence + 1`). A gap means the client missed something: the
  store keeps the last state it knows is real, marks itself **stale**, and
  requests a full snapshot — the only way out of a gap, because a snapshot is
  complete state and may jump the sequence forward.
- **Connection generations.** Each transport connection gets a generation;
  events and snapshots from a superseded generation are ignored, and a new
  connection resets the sequence baseline while keeping the last known
  workspace visible.
- **Offline is visibly stale.** On disconnect the last confirmed workspace
  stays on screen with its `lastConfirmedAt` timestamp, but `isStale` is set:
  file inspection is refused (`staleWorkspace`), and live terminal sessions
  are torn down while their cursors survive for reattach. Offline state is
  presented as stale, never as live.
- **Reconciliation.** After each accepted snapshot, selections and drafts
  pointing at panes or projects the host no longer publishes are dropped
  rather than left dangling.
- **Reconnect** — at launch, production composition reconnects to the stored
  host and then reattaches terminal deltas. Host selection is currently
  `hosts().first` (lexicographically lowest server ID); a deliberate
  selection rule is part of [#216](https://github.com/OpenCoven/psyche-build/issues/216).

**Tracked open, not implemented:** a cross-launch on-disk workspace cache
(bounded, protected, same-host keyed, no credentials/source/transcripts) is
[#210](https://github.com/OpenCoven/psyche-build/issues/210), and the
restore-cached-state-as-stale reconciliation UX on top of it is
[#211](https://github.com/OpenCoven/psyche-build/issues/211), which blocks
this documentation issue. Today's staleness behavior is in-memory only and
lasts no longer than the process; do not rely on cold-start state.

## Demo-only vs production behavior

The iOS app composes exactly one of two roots at launch:

- **Production** (`AppModel.init` with no fixture flag) composes
  `MobileAppComposition.production()`: a real `URLSessionControlTransport`
  with certificate pinning, a Keychain-backed `PairedHostStore`, the shared
  `WorkspaceStore`, `ConnectionManager`, and `TerminalSessionRegistry`, then
  attempts to reconnect to the stored host.
- **Demo/fixture** is only entered with an explicit `-uiFixture <name>` launch
  argument. `DemoStore` builds deterministic fixture state in memory with a
  fixture control client and fixture terminal client. The fixture root
  **never constructs a transport or a Keychain store**, so UI tests cannot
  reach the network or the device keychain no matter what they tap.

Fixtures, previews, simulator runs, and UI-test success are development
evidence only. They do not establish host connectivity, pairing, or any
production user path, and they are not support claims (see the
[support matrix](SUPPORT-MATRIX.md) iOS rows and [#200](https://github.com/OpenCoven/psyche-build/issues/200)).

## Reconciliation notes

- This document describes the state of `main` at the time of
  [#214](https://github.com/OpenCoven/psyche-build/issues/214). It must be
  reconciled again when the Phase 10 family lands: bounded protected cache
  ([#210](https://github.com/OpenCoven/psyche-build/issues/210)), stale-state
  reconciliation ([#211](https://github.com/OpenCoven/psyche-build/issues/211)),
  lifecycle actions ([#217](https://github.com/OpenCoven/psyche-build/issues/217)),
  discovery wiring ([#216](https://github.com/OpenCoven/psyche-build/issues/216)),
  and Phase 10 acceptance
  ([#209](https://github.com/OpenCoven/psyche-build/issues/209)) under the
  [#208](https://github.com/OpenCoven/psyche-build/issues/208) epic.
- Distribution and physical-device acceptance remain owned by
  [#200](https://github.com/OpenCoven/psyche-build/issues/200); support status
  is governed by the [support matrix](SUPPORT-MATRIX.md), not by this file.
- Transport-level security rationale and rules (pairing budget, tmux command
  boundaries, config integrity) are maintained in
  [bridge security](./BRIDGE-SECURITY.md); this document only summarizes what
  mobile exercises.
