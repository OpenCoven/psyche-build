# Bonjour discovery → connectable host flow

- Bead: `psyche-i7c.11` (mirror: [OpenCoven/psyche-build#216](https://github.com/OpenCoven/psyche-build/issues/216))
- Parent: `psyche-i7c` — Mobile multiproject and multipane cockpit (mirror: [#208](https://github.com/OpenCoven/psyche-build/issues/208))
- Reference module: `src/mobile/discoveredHostFlow.ts` (schema v1, tests in `__tests__/discoveredHostFlow.test.ts`)
- Authored: 2026-08-30, from the current `native/ios/PsycheCore` sources at `a4546f4`. The Beads source remains authoritative for scope and acceptance.
- Status: **design + platform-neutral reference logic.** The Swift implementation is a documented gap owned by the iOS track (see "Required Swift changes"); this document and module do not claim any of it is shipped.

## Objective

Let a user connect to a host they found on the LAN, without any pre-existing stored record, and make every step deliberate:

1. Browse `_psyche._tcp`, surface the hosts that survive TXT validation as connectable candidates.
2. Resolve a discovered service (`NWEndpoint.service(name:type:domain:)`) to a concrete host and port so it can become a `HostEndpoint` for the `wss://` URL.
3. Gate each candidate through `PairedHostStore.pairingStatus` so a changed fingerprint is presented as *requiring re-pairing*, never as connectable.
4. Replace the `hosts().first` heuristic with a deliberate selection rule.

## Current-state gap analysis (verified against the tree at `a4546f4`)

What already exists in `native/ios/PsycheCore/Sources/PsycheCore/`:

- `Pairing/BonjourHostDiscovery.swift` — `NWBrowser` browsing for `_psyche._tcp`, `BonjourHostParser` (TXT → `BonjourHostIdentity`, dedupe by server ID, sorted by server ID), a bounded 4-way resolver fan-in, and publication of `DiscoveredHost` (identity + resolved `HostEndpoint`). Unresolved hosts are dropped only after a complete batch proves it.
- `Pairing/BonjourServiceResolver.swift` — `NetServiceBonjourResolver` (`NetService` resolution with a 5 s timeout) producing `ResolvedBonjourEndpoint` (host, port); errors are `timedOut`, `unresolved`, `invalidEndpoint`.
- `Pairing/PairedHostStore.swift` — pinned-fingerprint persistence; `save` refuses a changed fingerprint, only `replace` (explicit re-pair) can rewrite one; `pairingStatus(forServerID:certificateFingerprint:)` returns `unpaired | paired | requiresRePairing`; `hosts()` is sorted by server ID.
- `Connection/ConnectionManager.swift` — `connect(to: HostEndpoint)` and the stored-host reconnect path.

The gaps that block discovery-driven connect:

1. **No production caller.** Nothing consumes `BonjourHostDiscovery`'s `AsyncStream<[DiscoveredHost]>`. `ConnectionManager` only reaches hosts via `PairedHostStore` (`connectToStoredHost()`), and `AppModel.start()` reads `pairedHostStore.hosts().first` for display. A discovered host can be neither paired with nor connected to.
2. **Service identity ≠ endpoint.** `NWBrowser` yields `NWEndpoint.service(name:type:domain:)`. A `HostEndpoint` needs host + port, so a discovered service must be resolved before it is connectable. Phase 3 ships a resolver, but no flow drives it end-to-end on a user path.
3. **Silent first-pick.** `connectToStoredHost()` takes `hosts().first` — the lexicographically-lowest server ID — which becomes a wrong-host connection the moment more than one host is paired.

Parsing/filtering coverage for `BonjourHostParser` already exists upstream (`BonjourHostDiscoveryTests`); this slice does not duplicate it.

## The connectable host flow (end to end)

```
NWBrowser batch (_psyche._tcp)
  → BonjourHostParser            (TXT → identity; unparseable TXT is dropped here, already covered upstream)
  → DiscoveredServiceRecord      (service key + resolution state; this flow's ledger)
  → resolution                   (service → host/port, bounded and retried)
  → DiscoveredHost candidate     (identity + endpoint + pairing status)
  → deliberate selection         (explicit user pick, or a sole unambiguous host)
  → connect → pair → store       (ConnectionManager + PairedHostStore)
```

Every candidate lives in exactly one resolution state:

```
discovered ──resolve-started──▶ resolving ──resolve-succeeded──▶ resolved
     │                              │                                │
     │                              ├──resolve-failed──▶ resolveFailed
     │                              └──browse-refresh(absent)──▶ disappeared
     └──browse-refresh(absent)─────────────────────────────────▶ disappeared

resolved ──resolve-started──▶ resolving (stale endpoint kept visible, unselectable)
resolveFailed ──resolve-retried──▶ resolving
disappeared ──browse-refresh(present)──▶ discovered   (fresh resolve required)
any state ──browse-refresh(absent)──▶ disappeared
```

Rules the states enforce (implemented in the reference module and mirrored in the spec below):

- Only `resolved` records become candidates, and a candidate carries a parsed identity plus an endpoint. `discovered`/`resolving`/`resolveFailed`/`disappeared` services are display-only, each with the concrete reason it is not connectable.
- A `resolveFailed` record must carry a non-empty, user-presentable reason — resolution failure is surfaced as an actionable error, never a silent no-op — and its stale endpoint is dropped.
- A `resolved` host that starts re-resolving keeps its stale endpoint visible (matching `BonjourHostDiscovery`'s "keep a still-present prior host visible during its refresh" batch behavior) but is not selectable until it resolves again.

## Service → HostEndpoint resolution strategy

`NWEndpoint.service(name:type:domain:)` carries no address. Two iOS mechanisms can turn it into one:

| Path | Mechanism | Notes |
|---|---|---|
| `NWConnection` path resolution | Build `NWConnection(to: .service(name:type:domain:), using: parameters)` and let its `stateUpdateHandler` drive the connection; the browser-side endpoint resolves as part of connecting. No separate resolve step, but connect and resolution are fused — a failure is a connection failure, and there is no host/port to show before dialing. |
| `NetService` resolution (shipped) | `NetService(domain:type:name:)` + `resolve(withTimeout:)` → `hostName` + `port` (`NetServiceBonjourResolver`). Yields a concrete `ResolvedBonjourEndpoint` before any TLS is attempted, with typed `timedOut`/`unresolved`/`invalidEndpoint` errors. |

**Decision: keep the shipped `NetServiceBonjourResolver` as the resolution mechanism, invoked through the existing `BonjourHostDiscovery` pipeline.** Rationale:

- The connect flow needs a *displayed, selectable* host before dialing — a name, an address, and a pairing status. The `NWConnection` path cannot produce that cleanly because resolution is fused with the connection attempt; a UI that lists "resolving…" hosts with actionable errors needs the standalone resolver.
- The fingerprint comes from TXT and is pinned by `PinnedCertificateDelegate` at connect time regardless of how the address was obtained, so neither path is more trusting than the other. Resolution output remains routing information only.
- `NetServiceBonjourResolver` already has timeout/unresolved/invalidEndpoint failures with localized descriptions, and `BonjourHostDiscovery` already bounds resolution concurrency (4) and drops hosts only when a complete batch proves them unresolved.

If the iOS owner later replaces the resolver with an `NWConnection`-based one, the contract to preserve is exactly the reference module's: a service is connectable only in the `resolved` state; failures surface as `resolveFailed` with a reason; the resolved endpoint is re-derived on demand, never persisted as authority.

Resolution bounds to preserve in the Swift implementation: a bounded timeout (5 s today), bounded concurrency (4 concurrent resolutions), and re-resolution on demand (connect-time refresh, user pull-to-refresh, or re-entry into the foreground), not a background resolve loop.

## Pairing-status integration

For each discovered candidate, the flow queries the store exactly the way `PairedHostStore.pairingStatus(forServerID:certificateFingerprint:)` already does — stored fingerprint (normalized at save) vs the TXT-presented fingerprint, normalized like `PinnedCertificateDelegate.normalizeFingerprint` (strip colons, lowercase, 64 hex):

| Status | Meaning | Offered as |
|---|---|---|
| `unpaired` | no stored record for this server ID | connectable — connecting is the *pairing* path |
| `paired` | pinned fingerprint matches | connectable — direct connect |
| `requiresRePairing` | presented fingerprint differs from the pinned one (or the presented value is unparseable) | **not connectable** — presented as requiring re-pairing; the only exits are an explicit re-pair (`PairedHostStore.replace`, which the user must confirm) or forgetting the host |

This is acceptance criterion 3: a server ID whose fingerprint changed is presented as requiring re-pairing, not offered as connectable. The connect-time pin check stays in force as the second gate: a stale TXT fingerprint cannot grant trust, it can only produce a connect-time mismatch, which lands the host in `requiresRePairing`.

The pairing lifecycle the UI drives (reference: `pairingTransition` in the reference module):

```
unpaired ──startPairing──▶ pairing ──pairingSucceeded──▶ paired
paired ──fingerprintChanged──▶ requiresRePairing ──startRePairing──▶ re-pairing
re-pairing ──rePairConfirmed──▶ paired            (only after the user confirms; store `replace`)
re-pairing ──pairingFailed──▶ requiresRePairing   (failed re-pair returns to the gate)
re-pairing ──rePairAbandoned──▶ requiresRePairing
any state ──hostForgotten──▶ unpaired
```

Notable rejections (each a typed rejection, never a silent state change): `startPairing` while pairing/re-pairing/already paired; `pairingSucceeded` outside `pairing`; `rePairConfirmed` outside `re-pairing`; `fingerprintChanged` from `unpaired` (nothing pinned yet). A failed or abandoned re-pair returns to `requiresRePairing` — never silently back to `paired`.

## Deliberate host selection (replaces `hosts().first`)

The rule, in priority order (implemented as `selectDiscoveredHost` in the reference module):

1. **Fail closed on malformed input.** A candidate with unknown fields, an unparseable fingerprint, or an invalid endpoint rejects the whole selection (`malformed-candidate`). An untrusted discovery surface must not degrade into a partial pick. An empty candidate set is a typed rejection (`no-connectable-host`), never an implicit "pick nothing silently".
2. **Fail closed on identity conflicts.** Two candidates claiming the same server ID with different normalized certificate fingerprints are rejected as `ambiguous-candidate-set`. The client never arbitrates identity conflicts; the user re-observes the LAN and, if the certificate really changed, re-pairs explicitly.
3. **Connectability gate.** Only resolved candidates with `pairingStatus ∈ {unpaired, paired}` are connectable. `requiresRePairing` hosts are excluded with a "pinned fingerprint changed; requires re-pairing" reason.
4. **Explicit user selection first.** A selection naming a known, connectable server ID wins. Unknown server ID → `explicit-selection-unknown`; known but not connectable → `explicit-selection-not-connectable` with the concrete per-host reasons.
5. **Auto basis is deliberate, never a silent first-pick:**
   - zero connectable hosts → `no-connectable-host`, carrying every ruled-out host and its reason (unresolved, resolving, resolve-failed, disappeared, or requires-re-pairing) so failures are visible;
   - exactly one distinct connectable server ID → select it (`sole-connectable-host`);
   - one identity with several distinct endpoints (e.g. two interfaces) → deterministic pick by endpoint ordering, remaining endpoints reported as `alternates` (`stable-ordering-tie-break`);
   - **more than one distinct connectable server ID → `deliberate-selection-required`.** The lexicographically-lowest server ID is an ordering for display, never a choice: the caller must surface `orderedConnectable` and let the user pick. This is the anti-`hosts().first` rule.

Deterministic ordering (`compareCandidates`): server ID ascending (the identity), then endpoint host and port ascending (endpoint uniqueness), then service-type/name/domain so the order is total even for duplicate endpoint keys. Duplicate `(serverID, endpoint)` instances collapse. Identical inputs always produce identical results, independent of input order — this is the property that lets a rendered list hold still between browses.

**Where the stored-host reconnect meets this rule.** `ConnectionManager.connectToStoredHost()` currently reads `hosts().first`. The replacement shape (spec for the Swift owner):

- `connectToStoredHost()` is *removed as a zero-argument auto-pick*. The app either reconnects to a specific server ID the user has selected, or to the single stored host when exactly one exists.
- The same three-way rule applies to stored hosts: explicit selection first; sole stored host connects; more than one stored host with no explicit selection leaves the manager idle awaiting a deliberate pick (no connect attempt, no silent default). Rationale: at auto-reconnect time there is no discovery surface to disambiguate with, so anything beyond the sole-host case would be exactly the `hosts().first` bug again.

## Stale and disappeared services

Two complementary mechanisms, both driven by caller-supplied ticks (the reference module has no clock):

1. **Batch reconciliation** — every browse batch reconciles the ledger. A service the batch still reports gets its observation tick refreshed; a service it no longer reports becomes `disappeared` and leaves the candidate set (endpoint dropped). A `disappeared` service the batch sees again returns to `discovered` with a cleared endpoint and must resolve again before it is selectable. This mirrors `BonjourHostDiscovery.beginBatch`, which removes `publishedHosts` entries the batch no longer contains.
2. **Stale expiry** — records also carry `lastSeenAt`; anything not observed within the expiry window becomes `disappeared` even if the browser still lists it (covers browser lag after app resume and hosts that stop advertising without a final batch). Expiry marks the record `disappeared` with the reason `stale`; it can only return through re-observation.

A `disappeared` host is removed from the candidate set, not hidden: the UI shows it as "no longer visible on the network" until the user closes it or it re-appears. A re-observed service returns to `discovered` — identity retained for display, endpoint cleared, fresh resolution required.

## Required Swift changes (spec for the iOS owner)

Additive; no existing pairing or persistence semantics are weakened. All paths keep the existing security boundaries: TXT is attacker-controlled and never trusted beyond display; the fingerprint is pinned and verified by `PinnedCertificateDelegate` at connect time; only `replace` rewrites a pinned fingerprint, and only after explicit user confirmation.

### 1. Consume discovery and surface candidates (new, e.g. `Pairing/DiscoveredHostSurface.swift`)

- Own a `BonjourHostDiscovery` observation: `start()` on foreground entry / sheet open, `stop()` on leave; retain the last `[DiscoveredHost]` batch plus per-service resolution state (`DiscoveredServiceRecord` mirror).
- Drive `resolve-retried` for `resolveFailed` services on demand (user retry button or connect attempt), reusing the existing resolver with its bounded timeout.
- Expose `candidates() -> [DiscoveredHostCandidate]`: resolved `DiscoveredHost`s joined with `PairedHostStore.pairingStatus(forServerID:certificateFingerprint:)` (queried per server ID, not by reading `hosts().first`).
- Surface resolution failures as actionable errors (the resolver's `timedOut`/`unresolved`/`invalidEndpoint` descriptions), not silent list gaps.

### 2. `ConnectionManager`

- Replace `connectToStoredHost()`'s body: `hosts().first` → deliberate selection per the rule above. Concretely: `func connectToStoredHost(serverID: String)` (explicit) plus a guarded zero-argument auto-reconnect that connects only when `hosts().count == 1`; with more than one stored host it does nothing but remain idle for a user pick.
- Add a discovered-host connect path: `func connect(to discovered: DiscoveredHost) async` that (a) uses `manualCredentials` for an unpaired host (the connect-for-pairing path that already exists via `connect(to:)`), and (b) rejects a `requiresRePairing` host up front with an actionable error pointing at the re-pair flow, mirroring acceptance criterion 3.
- On a successful pairing commit, the flow already persists via the generation/attempt-bound `save`/`replace` variants; no change to their authorization rules.

### 3. `PairedHostStore`

- No persistence changes required: `save`/`replace`/`updateToken`/`pairingStatus` already implement the pinned-fingerprint rules the flow depends on. The flow only consumes `pairingStatus(forServerID:certificateFingerprint:)` and `host(withServerID:)`.
- If a convenience is wanted, add `pairedHost(serverID:)`-style lookups on the existing actor rather than widening `hosts()` callers.

### 4. `AppModel` / UI

- Replace `hosts().first` (display of `hostName`) with the deliberate selection: show the selected/sole stored host; with several stored hosts, show the selection, not host #1.
- Host list rows render: name, resolved endpoint (or the state with its reason: resolving / resolution failed + retry / disappeared), and pairing status — `Connect` for `paired`/`unpaired`, `Re-pair required` for `requiresRePairing` (not a connect affordance).

## Acceptance criteria mapping (Bead `psyche-i7c.11`)

| Acceptance criterion | How this design satisfies it | Proof owner |
|---|---|---|
| A discovered host can be paired with and connected to without a pre-existing stored record | Discovery stream → resolved candidate with `unpaired` status → deliberate selection → connect → pair → `PairedHostStore.save` | iOS implementation slice (simulator/device run) |
| Service resolution failure surfaces an actionable error rather than a silent no-op | `resolveFailed` state requires a non-empty reason; excluded candidates carry per-host reasons into every rejection result | iOS implementation slice + reference-module tests |
| A serverID whose fingerprint changed is presented as requiring re-pairing, not offered as connectable | `pairingStatus` gate excludes `requiresRePairing` from connectability in selection; re-pair is the only exit and requires user confirmation | iOS implementation slice + reference-module tests |
| Host selection is deliberate rather than lexicographic | `hosts().first` removed; explicit selection first; sole-host auto-connect; >1 host requires a deliberate pick; ambiguity fails closed | iOS implementation slice + reference-module tests |

## Reference module mapping (`src/mobile/discoveredHostFlow.ts` ↔ Swift)

| TS (v1, pure, deterministic; no I/O, no clock) | Swift counterpart to implement |
|---|---|
| `DiscoveredServiceRecord` (service key, state, `lastSeenAt`, optional identity/endpoint/failureReason) | the flow's ledger type; wraps `BonjourServiceRecord` + resolution state |
| `advanceResolution` (total state machine, typed rejections) | resolution lifecycle inside the discovery consumer |
| `reconcileBrowseBatch`, `expireStaleEntries` | batch reconciliation + stale sweep on foreground/resume |
| `DiscoveredHostCandidate` + `candidateFromRecord` | `DiscoveredHost` + `pairingStatus` |
| `resolvePairingStatus`, `pairingStatusForRecord` | `PairedHostStore.pairingStatus(forServerID:certificateFingerprint:)` (mirrored) |
| `selectDiscoveredHost` (explicit → sole → tie-break → deliberate-selection-required; ambiguity and malformed input fail closed) | `ConnectionManager` selection rule + the host-picker UI ordering |
| `pairingTransition` + `PAIRING_TRANSITIONS` (exhaustive table) | pairing flow state in the pairing/host-selection UI |
| `normalizeCertificateFingerprint`, `resolvePairingStatus` | `PinnedCertificateDelegate.normalizeFingerprint` (mirrored) |

## Scope, non-goals, and risk

- This slice ships the design and the platform-neutral reference logic only. No Swift changes, no Xcode project changes, no UI — the Swift implementation is a documented gap owned by the iOS track.
- No Bonjour TXT parsing/filtering tests are duplicated; that coverage exists upstream in `BonjourHostDiscoveryTests`.
- No Psyche protocol conformance is claimed (issue #253 owns the profile pin); no release/support-matrix changes; no `.github/**`, `.beads/**`, or generated outputs touched.
- Risk class: **R1** — documentation plus an isolated, additive reference module with focused tests. It holds no authority, persists nothing, performs no I/O, and infers no runtime state. The Swift implementation that consumes it is R2/R3 and carries its own review and evidence bars.
