# Bonjour Host Connection Flow Design

**Date:** 2026-08-20
**Status:** Approved
**Issue:** `psyche-i7c.11`
**Scope:** iOS Bonjour discovery through paired, workspace-ready connection

## Objective

Complete the iOS host connection flow so a user can deliberately select a
Bonjour-advertised Psyche host, pair or re-pair it when necessary, and reach an
authoritative live workspace without requiring a pre-existing paired record.

The same flow keeps a secure manual fallback for networks where mDNS is
unavailable and replaces lexicographic stored-host selection with an explicit
last-connected policy.

## Existing Foundation

The repository already provides:

- `_psyche._tcp` publication from the desktop bridge;
- validated Bonjour TXT parsing and bounded service resolution;
- `DiscoveredHost` values containing identity metadata and a pinned
  `HostEndpoint`;
- Keychain-backed `PairedHostStore` records and `PairingStatus`;
- generation-safe connect and pairing operations in `ConnectionManager`;
- an authenticated workspace snapshot path; and
- the current non-networked `PairHostSheet` stub.

The remaining gaps are that resolution failures are discarded, no production
UI consumes discovery, pairing completion is not tied to workspace readiness,
and startup reconnects to `hosts().first`.

## Product Outcome

From Settings, a user can:

1. see compatible Bonjour hosts and their pairing status;
2. retry a host whose service address could not be resolved;
3. select a paired host and connect using its stored credentials;
4. select an unpaired host, enter the six-digit code, and complete pairing;
5. explicitly confirm a certificate-change warning before re-pairing;
6. manually enter a host, port, and certificate fingerprint when Bonjour is
   unavailable; and
7. leave the flow only after the first authoritative workspace snapshot has
   been applied.

On later launches, the app reconnects only to the persisted last-connected
server ID. It does not fall back to sorted host order.

## Scope Boundaries

### Included

- Bonjour discovery lifecycle owned by the pairing sheet model;
- resolved and resolution-failed discovery rows;
- deliberate host selection and last-connected persistence;
- matching-pair connect, new pairing, and confirmed re-pairing;
- manual host, port, and fingerprint entry;
- workspace-ready completion and explicit retryable errors;
- Core, model, SwiftUI, and live acceptance coverage.

### Excluded

- changing the desktop Bonjour advertisement or bridge protocol;
- trust-on-first-use or an unpinned TLS probe;
- automatic selection of the first discovered host;
- public-internet discovery, relay, or VPN configuration;
- background Bonjour browsing outside the connection flow; and
- redesigning unrelated Settings or workspace screens.

## Architecture

### PairHostSheet

`PairHostSheet` renders state supplied by `PairHostModel`. It does not call
networking or secure storage directly.

The sheet presents:

- discovered host rows with name, pairing status, and availability;
- a failed-resolution row with Retry and manual-entry guidance;
- a manual-entry section for host/address, port, and fingerprint;
- the selected host and six-digit code entry;
- a certificate-change warning before re-pairing;
- connecting, pairing, and workspace-loading progress;
- actionable errors with retry or back actions; and
- completion only after workspace readiness.

### PairHostModel

`PairHostModel` is a `@MainActor` observable model composed from focused
PsycheCore dependencies. It owns presentation state and orchestration, not
transport mechanics.

Its responsibilities are:

- start and stop `BonjourHostDiscovery` with the sheet lifecycle;
- merge discovery entries with `PairedHostStore.pairingStatus`;
- retain the user's selected row while compatible snapshots refresh;
- validate manual host, port, fingerprint, and pairing-code input;
- route paired, unpaired, and re-pairing actions to `ConnectionManager`;
- cancel in-flight work when the sheet closes or the user goes back;
- wait for workspace readiness before reporting success; and
- expose stable phases and user-facing errors to SwiftUI.

The model uses injected protocols or closures at its boundary so discovery,
store, and connection behavior can be tested without a live network or
Keychain.

### BonjourHostDiscovery

Discovery publishes typed entries instead of dropping every failed
resolution:

```swift
public struct BonjourDiscoveryEntry: Sendable, Equatable, Identifiable {
    public let identity: BonjourHostIdentity
    public let availability: BonjourHostAvailability
    public var id: String { identity.serverID }
}

public enum BonjourHostAvailability: Sendable, Equatable {
    case resolved(DiscoveredHost)
    case resolutionFailed(BonjourResolutionFailure)
}

public enum BonjourResolutionFailure: Sendable, Equatable {
    case timedOut
    case unresolved
    case invalidEndpoint
}
```

Only records that pass identity, fingerprint, and protocol validation become
entries. A valid advertisement whose service cannot resolve remains visible
with a bounded failure reason. Malformed or incompatible advertisements stay
filtered because they cannot be presented as trustworthy host identities.

Discovery retains the latest valid service record for each server ID while it
is present and exposes `retry(serverID:)`. Retrying replaces that row's
availability when resolution succeeds or updates its bounded failure when it
fails again. A service that disappears is removed from the next snapshot.

Existing cancellation, concurrency limits, stale-batch rejection, and stable
server-ID ordering remain in force.

### ConnectionManager

`ConnectionManager` remains the sole owner of transport generations,
authentication, pairing persistence, and snapshot requests.

It gains these deliberate operations:

- `connectToLastConnectedHost()` connects to the exact selected stored host;
- `connectToPairedHost(serverID:resolvedEndpoint:)` connects to a selected
  paired server ID and accepts a nullable newly resolved endpoint whose
  fingerprint must match the stored pin; and
- `waitForWorkspaceReady()` awaits readiness for the active generation.

The selected-paired-host path loads the exact stored record, refuses a
fingerprint mismatch, and uses its stored client ID and token. A matching
Bonjour endpoint supplies the host and port used for the attempt.

The workspace-readiness awaiter completes only after
`WorkspaceStore.applySnapshot` returns for the active generation. It fails on
snapshot request failure, disconnect, cancellation, or generation replacement.
It does not treat the negotiated `.connected` state as workspace readiness.

The existing unpaired path connects with manual credentials, completes the
pairing handshake, and persists through `PairedHostStore.replace` only after
`pairAccepted`. Re-pairing uses that same authenticated path after explicit UI
confirmation; discovery alone can never replace a stored fingerprint.

### PairedHostStore and Selection

Host records retain their current encoding. Last-connected selection is stored
under a separate Keychain-backed key so this change requires no host-record
migration.

`PairedHostStore` gains these exact operations:

```swift
func lastConnectedHost() throws -> PairedHost?
func markLastConnected(serverID: String) throws
func clearLastConnectedHost() throws
```

`markLastConnected` requires the server ID to exist in the paired-host records.
Removing that host clears a matching selection, and `removeAll` clears both
records and selection.

The last-connected ID is written only after workspace readiness. Failed,
cancelled, or snapshot-incomplete attempts never change launch selection.

After a workspace-ready connection through a matching discovered endpoint, the
store updates that host's name, host, and port while preserving its server ID,
client ID, token, and fingerprint.

`MobileAppComposition.start()` replaces `connectToStoredHost()` with an exact
last-connected reconnect. `AppModel` also derives displayed host context from
the active or last-connected host rather than `hosts().first`.

## UI and State Flow

`PairHostModel` exposes these conceptual phases:

1. **Browsing:** show discovered entries and manual fallback.
2. **Selected:** show the chosen host and the action allowed by its pairing
   status.
3. **Re-pair warning:** explain that the known server ID presents a different
   certificate and require explicit confirmation.
4. **Connecting:** establish the pinned connection and negotiate the supported
   protocol.
5. **Awaiting code:** accept exactly six digits for an unpaired or confirmed
   re-pair attempt.
6. **Pairing:** submit the code and await accepted persisted credentials.
7. **Loading workspace:** await the first authoritative snapshot.
8. **Ready:** update app host context, record last-connected selection, invoke
   completion, and dismiss the sheet.
9. **Failed:** show the specific retryable error, retain the selected host or
   validated manual endpoint, and clear the pairing code before another
   attempt.

A matching paired host skips code entry. An unpaired host and a confirmed
re-pair host require code entry. A resolution-failed host cannot connect until
Retry succeeds or the user supplies the manual endpoint and fingerprint.

Manual entry requires:

- a non-empty host or IP address without whitespace;
- a port in `1...65535`;
- a fingerprint accepted by `PinnedCertificateDelegate` normalization; and
- a six-digit pairing code.

The UI explains that the port and fingerprint must be copied from Psyche. It
never infers or silently accepts a certificate.

## Error and Recovery Behavior

- Resolution timeout, unresolved service, and invalid resolved endpoint remain
  visible on the advertised host row with Retry and manual-entry guidance.
- Invalid manual fields fail locally before opening a connection.
- Protocol mismatch refuses pairing and identifies that the host is
  incompatible.
- A stored server ID with a changed fingerprint is never offered as a normal
  Connect action.
- Re-pairing requires a certificate-change warning confirmation followed by a
  successful code pairing before the stored pin changes.
- Pairing rejection, expiration, or exhaustion leaves the host selected and
  allows a new code after the current attempt finishes.
- Pin rejection, transport failure, snapshot failure, cancellation, and
  generation replacement fail the current flow explicitly.
- Closing the sheet cancels discovery and any active connect/pair/readiness
  task and tears down an incomplete connection.
- No failure writes last-connected selection or reports success.

## Security and Privacy

- Bonjour TXT fields remain attacker-controlled discovery hints until the
  pinned TLS and pairing flow verifies the connection.
- Manual fallback requires an out-of-band fingerprint shown by Psyche.
- The app never performs an unpinned certificate probe or trust-on-first-use.
- Pairing codes are held only in transient view/model state and are not logged
  or persisted.
- Device tokens, fingerprints, paired records, and last-connected selection
  remain in Keychain-backed storage.
- A changed fingerprint requires deliberate re-pairing and cannot be accepted
  by a discovery refresh.

## Testing Strategy

### BonjourHostDiscoveryTests

- publish resolved and resolution-failed entries in one stable snapshot;
- preserve validated identity data on a failed row;
- map timeout, unresolved, and invalid endpoint failures;
- retry one server ID without disturbing other rows;
- replace a failed row after successful retry;
- remove rows for services that disappear;
- preserve concurrency bounds, cancellation, and stale-batch rejection.

### PairedHostStoreTests

- return the exact last-connected host;
- return no host when no selection exists;
- never fall back to lexicographic ordering;
- reject marking an unknown server ID;
- clear selection when the selected host is removed;
- clear selection with `removeAll`;
- decode existing host records unchanged.

### ConnectionManagerTests

- connect to a selected paired host with its stored client ID and token;
- use a refreshed matching endpoint without changing the stored pin;
- refuse a selected endpoint whose fingerprint differs;
- complete workspace readiness only after snapshot application;
- fail readiness on snapshot error, disconnect, cancellation, or generation
  replacement;
- persist endpoint refresh and last-connected selection only after readiness;
- keep pairing and generation-race guarantees intact.

### PairHostModel and SwiftUI Tests

- render resolved paired, unpaired, re-pairing, and failed-resolution rows;
- retry a failed row and recover it in place;
- require re-pair warning confirmation;
- validate manual host, port, fingerprint, and code fields;
- drive paired connect, new pairing, and re-pairing paths;
- show code, protocol, pin, transport, and snapshot errors;
- cancel active work on dismissal;
- report success and dismiss only after workspace readiness;
- expose concise accessibility labels and disable duplicate actions while work
  is in progress.

### Live Acceptance

Using an exact iOS build and host build on the same LAN:

1. start with no paired record and discover the Mac through Bonjour;
2. pair with the six-digit code and reach a populated workspace;
3. terminate and relaunch the app and reconnect to that exact last-connected
   host;
4. pair a second host and deliberately switch between hosts without relying on
   server-ID sort order;
5. advertise a known server ID with a changed fingerprint and verify that only
   the warning-gated re-pair path is available; and
6. force one service-resolution failure and verify the persistent failed row,
   Retry action, and manual host/port/fingerprint fallback.

## Completion Criteria

The issue is complete when all automated coverage passes and live acceptance
demonstrates a no-record Bonjour discovery through pairing, persisted
credentials, authoritative workspace readiness, and exact last-connected
reconnect, with actionable resolution errors and warning-gated re-pairing.
