# iOS Live Cockpit Activation Design

**Date:** 2026-08-12
**Status:** Approved direction; written-spec review pending
**Scope:** Internal TestFlight, same-LAN host discovery and control

## Objective

Activate the existing Psyche Build iOS cockpit as a trustworthy companion for
scanning multiple panes, reading bounded summaries, and performing deliberate
management actions against a live Psyche host.

The first release is local-network-first. It must not expose the bridge to the
public internet, upload terminal transcripts, or make destructive repository
decisions from a batch action.

## Product Outcome

An authorized internal tester can:

1. launch Psyche Build on a Mac and open a short pairing window;
2. discover that host from the iPhone, enter the six-digit code, pin its TLS
   identity, and reconnect later using a Keychain-backed device token;
3. scan every published project, worktree, and pane from the phone's Now and
   Projects views;
4. read a short, recent summary for panes that are waiting, idle, failed, or
   otherwise need attention;
5. open one pane on iPhone or two panes on a sufficiently wide iPhone/iPad,
   send terminal input, create or rename panes, stop a pane with confirmation,
   and launch a ritual; and
6. distinguish live state from stale last-known state after disconnects or
   sequence gaps.

## Existing Foundation

The host already starts an authenticated TLS WebSocket bridge, publishes it as
`_psyche._tcp.local.` through Bonjour, opens bounded six-digit pairing windows,
issues revocable device tokens, publishes sequenced workspace snapshots, and
supports pane streams and mobile control requests.

The iOS app already contains the live transport composition, Keychain-backed
paired-host storage, certificate pinning, Bonjour parsing, sequenced workspace
store, Now/Projects views, one- and two-pane terminal presentation, pane input,
create, rename, stop, action-response protocol types, and ritual launch.

The activation gaps are:

- `PairHostSheet` records a label instead of completing the real discovery and
  pairing handshake;
- authoritative workspace pane snapshots do not carry the host's bounded agent
  summary, so the Now screen loses context on refresh or reconnect;
- management capabilities are scattered across terminal and pane-detail UI
  instead of forming a clear phone review flow; and
- live TestFlight acceptance does not yet prove pairing, reconnect, summary
  freshness, mutation confirmation, and stale-state behavior end to end.

## Scope Boundaries

### Included

- internal TestFlight build and authorized testers;
- same-LAN Bonjour discovery;
- manual hostname fallback for networks where mDNS is unavailable;
- live pairing, TLS fingerprint pinning, Keychain token storage, reconnect, and
  device revocation compatibility;
- bounded summaries in authoritative workspace snapshots;
- Now and Projects summary presentation;
- pane input, create, rename, stop, ritual launch, and existing action response
  surfaces where the host advertises them;
- one-pane phone use and the existing two-pane wide-layout experience;
- explicit stale/offline/error states and accessibility coverage.

### Excluded

- public App Store or external TestFlight distribution;
- direct public-internet exposure of the bridge;
- a hosted relay, APNs delivery, or guaranteed background execution;
- Tailscale/WireGuard setup automation;
- uploading or storing terminal transcripts on the phone;
- phone-side LLM summarization;
- batch merge, branch deletion, worktree cleanup, force operations, or silent
  destructive actions;
- redesigning the desktop or terminal protocols beyond the fields and commands
  required by this activation.

Away-from-LAN access can follow through a user-managed private VPN using the
manual-host path. A hosted relay and push notifications require a separate
security and operations design.

## Architecture

### 1. Live Discovery and Pairing

`PairHostSheet` becomes a state-driven live pairing flow backed by a small
pairing model rather than directly storing a display name.

The model owns:

- starting and stopping `BonjourHostDiscovery` with the sheet lifecycle;
- presenting compatible discovered hosts, including name, server identity, and
  supported protocol version;
- accepting a manually entered hostname when discovery is unavailable;
- connecting through `URLSessionControlTransport` without an existing token;
- validating the host welcome and advertised certificate fingerprint;
- submitting the six-digit code only while the host challenge is active;
- receiving `pairAccepted`, constructing `PairedHost`, and persisting it through
  `PairedHostStore.replace` only after the authenticated handshake succeeds;
- handing the accepted host to `ConnectionManager` for the first authoritative
  workspace snapshot; and
- exposing specific retryable errors without claiming success early.

The desktop flow remains `:pair`: opening the pairing window shows the code and
challenge expiration. Pairing attempts stay rate-limited by the existing host
budget. The iOS UI never stores the six-digit code.

The manual-host fallback must still obtain and verify the host's server ID and
certificate fingerprint during the handshake. It must not treat a typed
hostname as trusted identity.

### 2. Durable Bounded Pane Summaries

The host workspace contract gains optional summary fields on each pane:

```ts
interface PaneSummarySnapshot {
  text: string;
  updatedAt: string;
  state: "working" | "waiting" | "idle" | "failed" | "unknown";
  needsResponse: boolean;
}
```

`WorkspacePaneInput` and `PaneSnapshot` carry `summary?: PaneSummarySnapshot`.
The TUI workspace provider derives it from the pane's existing analyzed
`agentSummary`, status, attention state, and last activity. It does not capture
or summarize terminal output in the bridge path.

Host publication rules:

- trim surrounding whitespace and collapse internal runs of whitespace;
- cap `text` at 280 Unicode scalar-safe characters;
- omit empty summaries;
- include the source activity timestamp as `updatedAt`;
- set `needsResponse` from authoritative pane attention state;
- clear summaries when pane state makes the previous summary misleading;
- preserve the most recent valid summary across snapshot rebuilds while the
  underlying pane metadata still reports it; and
- send no transcript, prompt, environment value, credential, or unbounded
  diagnostic field.

The Swift workspace model decodes the optional envelope. Older hosts remain
compatible because absence means no summary. `WorkspaceStore` folds the summary
into `NowItem`, and Now/Projects rows show at most two lines with freshness and
stale-state semantics. Accessibility labels include the summary only when it is
present and do not repeat it twice.

Attention events may update a pane summary optimistically, but a sequence gap
or reconnect always returns to the authoritative workspace snapshot. The phone
never treats an event-only summary as durable truth.

### 3. Phone Management Flow

The Now view is the cross-project review queue. Sections remain Needs You,
Running, and Recent. Each row presents title, bounded summary when available,
project/worktree context, status, and relative freshness.

Tapping a row opens the existing `PaneWorkspaceView`. The existing pane action
menu remains the primary deliberate mutation surface:

- **New pane:** scoped to a published project root or worktree and protected by
  the existing idempotency key;
- **Rename:** non-empty title, explicit submission, surfaced host errors;
- **Stop:** destructive styling and confirmation naming pane, project, host,
  and the fact that branch/worktree survive;
- **Send input:** only to the focused attached pane;
- **Launch ritual:** only from the host-published ritual list and project; and
- **Respond to action:** approve or deny only when a host-published pending
  action supplies an explicit response contract.

The first activation does not add multi-select destructive controls. Two-pane
management uses the existing primary/secondary selection on wide layouts; the
focused pane receives composer input and each pane retains independent stream
attachment.

Commands must remain disabled while the workspace is stale or the connection
generation is invalid. A request that loses its connection must surface as
unconfirmed, refresh the authoritative snapshot after reconnect, and never
optimistically claim success.

## Data Flow

```text
StateManager pane metadata
  -> TUI workspace provider
  -> bounded PaneSummarySnapshot
  -> BridgeDaemon workspace snapshot/event sequence
  -> authenticated pinned WSS connection
  -> iOS ConnectionManager
  -> WorkspaceStore authoritative snapshot
  -> Now / Projects / PaneWorkspaceView

iOS deliberate command
  -> ControlRequestClient request ID + idempotency key where applicable
  -> MobileControlGateway
  -> host control runtime and scope validation
  -> ack/result or explicit error
  -> authoritative workspace refresh/event
```

## Error and Recovery Behavior

- Bonjour failure leaves manual-host pairing available.
- Protocol mismatch identifies supported versions and refuses pairing.
- Certificate mismatch refuses reconnect and requires explicit re-pairing; it
  never silently replaces a pinned identity.
- Invalid, expired, or exhausted pairing codes remain errors and do not persist
  a host.
- Invalid/revoked device tokens return the app to a re-pair-required state.
- A workspace sequence gap preserves the last confirmed snapshot, marks it
  stale, disables mutations, and requests a full snapshot.
- A command timeout or disconnect is reported as unconfirmed. The UI waits for
  refreshed host state rather than assuming the mutation happened.
- Summary parse or validation failure drops only that summary, not the pane or
  workspace snapshot.

## Security and Privacy

- Keep the bridge TLS-only and token-authenticated.
- Keep Bonjour TXT data limited to protocol negotiation, server identity, and
  public certificate fingerprint.
- Store device tokens and pinned identity only in Keychain-backed storage.
- Do not log pairing codes, device tokens, terminal input, or summary source
  material.
- Treat all Bonjour TXT records as attacker-controlled until the TLS/pairing
  handshake verifies identity.
- Apply existing host project/worktree scope checks to every mobile mutation.
- Summaries contain recent bounded evidence only; no full transcript transport.

## Testing Strategy

### TypeScript host and wire tests

- workspace snapshots include normalized bounded summaries and omit empty data;
- Unicode truncation does not split a scalar or surrogate pair;
- stale summaries clear on disqualifying pane transitions;
- wire fixtures round-trip summary envelopes and remain backward compatible;
- mobile gateway pairing and management requests preserve auth, request IDs,
  idempotency, and scope validation;
- no workspace response contains captured terminal text.

### Swift core tests

- Bonjour discovery filters incompatible and malformed records;
- live pairing persists only an accepted, identity-verified host;
- code rejection, expiration, fingerprint mismatch, and token revocation are
  recoverable explicit states;
- reconnect requests an authoritative snapshot;
- summary envelopes decode, sort, age, clear, and survive sequence recovery;
- stale workspace state refuses mutations;
- generation changes discard late pairing, snapshot, and command completions.

### SwiftUI and accessibility tests

- pairing discovery, manual fallback, progress, success, and error states;
- Now rows show bounded summary, project context, freshness, and attention;
- summary accessibility labels are concise and nonduplicative;
- create, rename, stop confirmation, input focus, ritual, and action response;
- phone portrait uses one pane; supported wide layouts attach exactly two;
- stale state is visible and disables management controls.

### Live acceptance

Using an exact internal iOS build and an exact host build on the same LAN:

1. discover the host through Bonjour;
2. run `:pair`, enter the code, pin identity, and receive a live snapshot;
3. terminate/relaunch iOS and reconnect without another code;
4. observe at least three panes across two worktrees with correct summaries and
   Needs You/Running/Recent placement;
5. send input to the focused pane and prove the other visible pane did not
   receive it;
6. create and rename a pane, stop it after confirmation, and prove its
   worktree/branch remain;
7. disconnect the Mac network, observe stale state and disabled mutations,
   reconnect, and recover via an authoritative snapshot;
8. revoke the phone from the host and prove the next reconnect requires
   pairing; and
9. inspect logs and wire captures to confirm no code, token, credential, or
   terminal transcript leakage.

## Delivery

The implementation should remain one reviewable feature branch with small
signed commits organized by seam:

1. live pairing and reconnect;
2. host snapshot summary contract and iOS presentation;
3. management-state hardening and UI completion;
4. internal iOS build/test and exact host-to-phone acceptance.

The work is complete when the automated TypeScript and Swift gates pass, the
live same-LAN acceptance checklist is evidenced, the generated Xcode project is
deterministic, the worktree is clean, and delivery is ready for maintainer
review. Internal TestFlight publication requires the separately authorized
release environment and is not implied by a local archive alone.
