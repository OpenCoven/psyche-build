# Bonjour Host Connection Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the iOS Bonjour host-selection flow from discovery through pairing, authoritative workspace readiness, and exact last-connected reconnect.

**Architecture:** Keep transport and persistence authority in PsycheCore while adding a small `@MainActor` `PairHostModel` for SwiftUI orchestration. Bonjour discovery publishes resolved and failed rows, `PairedHostStore` owns exact last-connected selection, and `ConnectionManager` exposes deliberate paired/unpaired connection APIs plus a generation-safe workspace-readiness waiter.

**Tech Stack:** Swift 6, SwiftUI, Combine, Network.framework, URLSession WebSocket, Keychain-backed `SecureStore`, XCTest/XCUITest, XcodeGen, `xcodebuild`

---

**Design reference:** `docs/superpowers/specs/2026-08-20-bonjour-host-connection-flow-design.md`

**Execution prerequisite:** Run this plan in an isolated worktree based on commit
`fb6438be`. The repository root used to write the plan contains unrelated dirty
changes in `.beads/interactions.jsonl`, `.gitignore`, and
`__tests__/daemon/controlSocketMount.test.ts`; do not stage or modify them.

## File Responsibility Map

- `native/ios/PsycheCore/Sources/PsycheCore/Pairing/BonjourHostDiscovery.swift`
  publishes resolved and failed discovery entries and retries one advertised
  service without restarting the sheet.
- `native/ios/PsycheCore/Sources/PsycheCore/Pairing/PairedHostStore.swift`
  persists exact last-connected selection and atomically finalizes a
  generation-valid successful connection.
- `native/ios/PsycheCore/Sources/PsycheCore/Connection/ConnectionManager.swift`
  connects to a deliberate paired host, waits for the first applied workspace
  snapshot, and finalizes the successful host.
- `native/ios/PsycheCore/Sources/PsycheCore/Connection/MobileAppComposition.swift`
  owns the production Bonjour discovery actor and starts exact reconnect.
- `native/ios/PsycheApp/Sources/PsycheApp/Pairing/PairHostModel.swift`
  owns discovery observation, selection, validation, progress, cancellation,
  and user-facing errors.
- `native/ios/PsycheApp/Sources/PsycheApp/Views/PairHostSheet.swift` renders the
  state-driven pairing and host-selection flow.
- `native/ios/PsycheApp/Sources/PsycheApp/Views/SettingsView.swift` presents a
  fresh pairing model and records the ready host.
- `native/ios/PsycheApp/Sources/PsycheApp/AppModel.swift` creates production or
  network-free fixture pairing models and derives host context from exact
  selection.
- `native/ios/PsycheCore/Tests/PsycheCoreTests/BonjourHostDiscoveryTests.swift`,
  `PairedHostStoreTests.swift`, and `ConnectionManagerTests.swift` cover Core
  behavior.
- `native/ios/PsycheApp/UnitTests/PairHostModelTests.swift` covers the app state
  machine without network or Keychain access.
- `native/ios/PsycheApp/Tests/PsycheAppUITests/PsycheAppUITests.swift` covers
  discover, re-pair warning, manual validation, and ready dismissal through the
  fixture root.

## Task 1: Publish Actionable Bonjour Resolution Results

**Files:**
- Modify: `native/ios/PsycheCore/Sources/PsycheCore/Pairing/BonjourHostDiscovery.swift`
- Test: `native/ios/PsycheCore/Tests/PsycheCoreTests/BonjourHostDiscoveryTests.swift`

- [ ] **Step 1: Write failing tests for mixed discovery results**

Add tests that expect a valid but unresolved advertisement to remain alongside
a resolved host:

```swift
func testDiscoveryPublishesResolvedAndFailedRowsTogether() async throws {
    let good = BonjourServiceKey(name: "Studio", domain: "local.")
    let bad = BonjourServiceKey(name: "Offline", domain: "local.")
    let browser = FakeBonjourBrowser()
    let resolver = FakeBonjourServiceResolver(results: [
        good: .success(ResolvedBonjourEndpoint(host: "studio.local", port: 4242)),
        bad: .failure(.failed),
    ])
    let discovery = BonjourHostDiscovery(browser: browser, resolver: resolver)
    let batches = await discovery.start()
    let first = Task {
        for await batch in batches where !batch.isEmpty {
            return batch
        }
        return []
    }

    browser.emit([
        makeRecord(name: good.name, domain: good.domain, serverID: "server-good"),
        makeRecord(name: bad.name, domain: bad.domain, serverID: "server-bad"),
    ])

    let entries = await first.value
    XCTAssertEqual(entries.map(\.serverID), ["server-bad", "server-good"])
    XCTAssertEqual(entries.first?.availability, .resolutionFailed(.unresolved))
    guard case let .resolved(host) = entries.last?.availability else {
        return XCTFail("Expected the usable host to remain resolved")
    }
    XCTAssertEqual(host.endpoint.host, "studio.local")
}
```

Add typed resolver-error coverage:

```swift
func testDiscoveryMapsResolverFailuresToBoundedReasons() async {
    let cases: [(BonjourServiceResolverError, BonjourResolutionFailure)] = [
        (.timedOut, .timedOut),
        (.unresolved, .unresolved),
        (.invalidEndpoint, .invalidEndpoint),
    ]

    for (resolverError, expected) in cases {
        let browser = FakeBonjourBrowser()
        let resolver = TypedFailureBonjourServiceResolver(error: resolverError)
        let discovery = BonjourHostDiscovery(browser: browser, resolver: resolver)
        let stream = await discovery.start()
        let result = Task {
            for await batch in stream where !batch.isEmpty {
                return batch[0]
            }
            fatalError("Discovery ended without an entry")
        }
        browser.emit([makeRecord(serverID: "server-1")])
        let entry = await result.value
        XCTAssertEqual(entry.availability, .resolutionFailed(expected))
        await discovery.stop()
    }
}
```

Add these test helpers:

```swift
private actor TypedFailureBonjourServiceResolver: BonjourServiceResolving {
    let error: BonjourServiceResolverError

    init(error: BonjourServiceResolverError) {
        self.error = error
    }

    func resolve(name: String, domain: String) async throws
        -> ResolvedBonjourEndpoint {
        throw error
    }
}
```

and overload the existing record helper:

```swift
private func makeRecord(
    name: String = "Studio",
    domain: String = "local.",
    serverID: String
) -> BonjourServiceRecord {
    makeRecord(
        name: name,
        domain: domain,
        txt: [
            "serverId": serverID,
            "fingerprint": fingerprint,
            "versions": "3",
        ]
    )
}
```

- [ ] **Step 2: Write a failing per-row retry test**

Use a sequenced resolver so the first attempt fails and the explicit retry
replaces only that row:

```swift
func testRetryReplacesOneFailedRowWithoutDisturbingOtherHosts() async throws {
    let retryKey = BonjourServiceKey(name: "Retry", domain: "local.")
    let stableKey = BonjourServiceKey(name: "Stable", domain: "local.")
    let resolver = RetryBonjourServiceResolver(
        retryKey: retryKey,
        endpoints: [
            retryKey: ResolvedBonjourEndpoint(host: "retry.local", port: 4343),
            stableKey: ResolvedBonjourEndpoint(host: "stable.local", port: 4242),
        ]
    )
    let browser = FakeBonjourBrowser()
    let discovery = BonjourHostDiscovery(browser: browser, resolver: resolver)
    let batches = await discovery.start()
    let recorder = DiscoveryEntryRecorder()
    let consumer = Task {
        for await batch in batches {
            recorder.record(batch)
        }
    }

    browser.emit([
        makeRecord(name: retryKey.name, domain: retryKey.domain, serverID: "retry"),
        makeRecord(name: stableKey.name, domain: stableKey.domain, serverID: "stable"),
    ])
    try await recorder.waitForEntry(
        serverID: "retry",
        availability: .resolutionFailed(.unresolved)
    )

    await discovery.retry(serverID: "retry")

    let recovered = try await recorder.waitForResolvedEntry(serverID: "retry")
    XCTAssertEqual(recovered.endpoint.host, "retry.local")
    XCTAssertNotNil(recorder.latestEntry(serverID: "stable"))
    consumer.cancel()
}
```

Add a lock-backed `DiscoveryEntryRecorder` beside the existing test recorders.
Its `record(_:)` method replaces `latest`, `waitForEntry` polls for at most
1,000 `Task.yield()` iterations, and `waitForResolvedEntry` unwraps
`.resolved`. Use the same timeout failure style as the existing
`waitForSnapshotRequest` helper:

```swift
private final class DiscoveryEntryRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var latest: [BonjourDiscoveryEntry] = []

    func record(_ entries: [BonjourDiscoveryEntry]) {
        lock.withLock { latest = entries }
    }

    func latestEntry(serverID: String) -> BonjourDiscoveryEntry? {
        lock.withLock { latest.first { $0.serverID == serverID } }
    }

    func waitForEntry(
        serverID: String,
        availability: BonjourHostAvailability
    ) async throws {
        for _ in 0..<1_000 {
            if latestEntry(serverID: serverID)?.availability == availability {
                return
            }
            await Task.yield()
        }
        throw FakeBonjourServiceResolverError.timeout
    }

    func waitForResolvedEntry(serverID: String) async throws -> DiscoveredHost {
        for _ in 0..<1_000 {
            if let entry = latestEntry(serverID: serverID),
               case let .resolved(host) = entry.availability {
                return host
            }
            await Task.yield()
        }
        throw FakeBonjourServiceResolverError.timeout
    }
}
```

Add the retry resolver:

```swift
private actor RetryBonjourServiceResolver: BonjourServiceResolving {
    let retryKey: BonjourServiceKey
    let endpoints: [BonjourServiceKey: ResolvedBonjourEndpoint]
    var attempts: [BonjourServiceKey: Int] = [:]

    init(
        retryKey: BonjourServiceKey,
        endpoints: [BonjourServiceKey: ResolvedBonjourEndpoint]
    ) {
        self.retryKey = retryKey
        self.endpoints = endpoints
    }

    func resolve(name: String, domain: String) async throws
        -> ResolvedBonjourEndpoint {
        let key = BonjourServiceKey(name: name, domain: domain)
        attempts[key, default: 0] += 1
        if key == retryKey, attempts[key] == 1 {
            throw BonjourServiceResolverError.unresolved
        }
        guard let endpoint = endpoints[key] else {
            throw BonjourServiceResolverError.unresolved
        }
        return endpoint
    }
}
```

- [ ] **Step 3: Run the discovery test file and confirm RED**

Run:

```bash
xcodebuild -project native/ios/Psyche.xcodeproj \
  -scheme PsycheCore \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  -only-testing:PsycheCoreTests/BonjourHostDiscoveryTests test
```

Expected: compile failures because `BonjourDiscoveryEntry`,
`BonjourHostAvailability`, `BonjourResolutionFailure`, and `retry(serverID:)`
do not exist.

- [ ] **Step 4: Add the public discovery result types**

Place these beside `DiscoveredHost`:

```swift
public struct BonjourDiscoveryEntry: Sendable, Equatable, Identifiable {
    public let identity: BonjourHostIdentity
    public let availability: BonjourHostAvailability

    public var id: String { identity.serverID }
    public var serverID: String { identity.serverID }
    public var serverName: String { identity.serverName }

    public init(
        identity: BonjourHostIdentity,
        availability: BonjourHostAvailability
    ) {
        self.identity = identity
        self.availability = availability
    }
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

- [ ] **Step 5: Convert discovery publication from hosts to entries**

Replace `publishedHosts` with:

```swift
private var publishedEntries: [String: BonjourDiscoveryEntry] = [:]
private var latestIdentities: [String: BonjourHostIdentity] = [:]
```

Change `start()` to return `AsyncStream<[BonjourDiscoveryEntry]>`, update the
continuation type, and make each successful or failed resolution produce an
entry:

```swift
private static func resolveEntry(
    _ identity: BonjourHostIdentity,
    using resolver: any BonjourServiceResolving
) async -> BonjourDiscoveryEntry? {
    guard !Task.isCancelled else { return nil }
    do {
        let resolved = try await resolver.resolve(
            name: identity.serverName,
            domain: identity.domain
        )
        guard !Task.isCancelled,
              let endpoint = endpoint(
                  from: resolved,
                  fingerprint: identity.certificateFingerprint
              ) else {
            return BonjourDiscoveryEntry(
                identity: identity,
                availability: .resolutionFailed(.invalidEndpoint)
            )
        }
        return BonjourDiscoveryEntry(
            identity: identity,
            availability: .resolved(DiscoveredHost(
                identity: identity,
                endpoint: endpoint
            ))
        )
    } catch let error as BonjourServiceResolverError {
        let failure: BonjourResolutionFailure
        switch error {
        case .timedOut: failure = .timedOut
        case .unresolved: failure = .unresolved
        case .invalidEndpoint: failure = .invalidEndpoint
        }
        return BonjourDiscoveryEntry(
            identity: identity,
            availability: .resolutionFailed(failure)
        )
    } catch is CancellationError {
        return nil
    } catch {
        return BonjourDiscoveryEntry(
            identity: identity,
            availability: .resolutionFailed(.unresolved)
        )
    }
}
```

In each batch, set `latestIdentities` from the current validated identities,
remove vanished server IDs from both dictionaries, and publish:

```swift
private func publishCurrentEntries() {
    continuation?.yield(
        publishedEntries.values.sorted { $0.serverID < $1.serverID }
    )
}
```

Retain the existing observation IDs, batch IDs, cancellation checks, and
four-resolution concurrency limit.

- [ ] **Step 6: Implement per-row retry**

Add this actor method:

```swift
public func retry(serverID: String) async {
    guard let identity = latestIdentities[serverID] else { return }
    let currentObservationID = observationID
    guard let entry = await Self.resolveEntry(identity, using: resolver),
          currentObservationID == observationID,
          latestIdentities[serverID] == identity,
          !Task.isCancelled else {
        return
    }
    publishedEntries[serverID] = entry
    publishCurrentEntries()
}
```

Ensure `stop()`, observation replacement, and termination clear
`latestIdentities` and `publishedEntries`.

- [ ] **Step 7: Update existing discovery assertions and run GREEN**

Where existing tests expected `[DiscoveredHost]`, unwrap resolved entries with
a local helper:

```swift
private func resolvedHosts(
    in entries: [BonjourDiscoveryEntry]
) -> [DiscoveredHost] {
    entries.compactMap {
        guard case let .resolved(host) = $0.availability else { return nil }
        return host
    }
}
```

Change the existing `FirstBatchRecorder` storage and `record` parameter from
`[DiscoveredHost]` to `[BonjourDiscoveryEntry]`. Assertions that only inspect
identity can continue using `map(\.serverID)`; endpoint assertions use
`resolvedHosts(in:)`.

Run the command from Step 3.

Expected: all `BonjourHostDiscoveryTests` pass, including cancellation and
stale-batch cases.

- [ ] **Step 8: Commit the discovery result change**

```bash
git add \
  native/ios/PsycheCore/Sources/PsycheCore/Pairing/BonjourHostDiscovery.swift \
  native/ios/PsycheCore/Tests/PsycheCoreTests/BonjourHostDiscoveryTests.swift
git diff --cached --check
git commit -m "feat(ios): surface Bonjour resolution failures" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 2: Persist Exact Last-Connected Selection

**Files:**
- Modify: `native/ios/PsycheCore/Sources/PsycheCore/Pairing/PairedHostStore.swift`
- Test: `native/ios/PsycheCore/Tests/PsycheCoreTests/PairedHostStoreTests.swift`

- [ ] **Step 1: Write failing selection tests**

Add coverage for exact selection, unknown IDs, and cleanup:

```swift
func testLastConnectedHostIsExactRatherThanSortedFirst() async throws {
    let secureStore = InMemorySecureStore()
    let store = PairedHostStore(secureStore: secureStore)
    try await store.save(makeHost(serverID: "server-a"))
    try await store.save(makeHost(serverID: "server-z"))

    try await store.markLastConnected(serverID: "server-z")

    XCTAssertEqual(try await store.lastConnectedHost()?.serverID, "server-z")
}

func testMarkLastConnectedRejectsUnknownHost() async {
    let store = PairedHostStore(secureStore: InMemorySecureStore())

    do {
        try await store.markLastConnected(serverID: "missing")
        XCTFail("Expected an unknown host to be rejected")
    } catch {
        XCTAssertEqual(
            error as? PairedHostStoreError,
            .unknownHost(serverID: "missing")
        )
    }
}

func testRemovingSelectedHostClearsSelection() async throws {
    let store = PairedHostStore(secureStore: InMemorySecureStore())
    try await store.save(makeHost())
    try await store.markLastConnected(serverID: "server-1")

    try await store.remove(serverID: "server-1")

    XCTAssertNil(try await store.lastConnectedHost())
}
```

Extend `testRoundTripsAndClearsThroughTheSecureStore` so `removeAll()` also
asserts the selection key is absent.

- [ ] **Step 2: Write a failing generation-bound finalization test**

```swift
func testSuccessfulConnectionFinalizationWritesEndpointAndSelectionTogether() async throws {
    let secureStore = InMemorySecureStore()
    let store = PairedHostStore(secureStore: secureStore)
    try await store.save(makeHost())
    let generation = ConnectionGeneration(id: 1)
    let refreshed = makeHost(host: "studio.local", port: 5151)

    let committed = try await store.recordSuccessfulConnection(
        refreshed,
        for: generation
    )

    XCTAssertTrue(committed)
    XCTAssertEqual(try await store.lastConnectedHost(), refreshed)
}

func testInvalidGenerationCannotFinalizeConnection() async throws {
    let store = PairedHostStore(secureStore: InMemorySecureStore())
    try await store.save(makeHost())
    let generation = ConnectionGeneration(id: 1)
    generation.invalidate()

    let committed = try await store.recordSuccessfulConnection(
        makeHost(host: "ignored.local", port: 5151),
        for: generation
    )

    XCTAssertFalse(committed)
    XCTAssertNil(try await store.lastConnectedHost())
    XCTAssertEqual(
        try await store.host(withServerID: "server-1")?.endpoint.host,
        "psyche.local"
    )
}
```

Extend the existing `makeHost` helper before adding these tests:

```swift
private func makeHost(
    serverID: String = "server-1",
    fingerprint: String? = nil,
    token: String? = "token-1",
    host: String = "psyche.local",
    port: Int = 4242
) -> PairedHost {
    PairedHost(
        serverID: serverID,
        serverName: "Studio",
        endpoint: HostEndpoint(
            host: host,
            port: port,
            certificateFingerprint: fingerprint ?? self.fingerprint
        ),
        clientID: "client-1",
        token: token
    )
}
```

- [ ] **Step 3: Run the store test file and confirm RED**

Run:

```bash
xcodebuild -project native/ios/Psyche.xcodeproj \
  -scheme PsycheCore \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  -only-testing:PsycheCoreTests/PairedHostStoreTests test
```

Expected: compile failures for the new error, selection methods, key, and
generation-bound finalizer.

- [ ] **Step 4: Add the selection key and explicit error**

Extend `PairedHostStoreError`:

```swift
case unknownHost(serverID: String)
```

with:

```swift
case .unknownHost:
    "Choose a paired host before making it the reconnect target."
```

Add:

```swift
public static let lastConnectedKey = "paired-host-last-connected.v1"
```

- [ ] **Step 5: Implement exact selection operations**

Add:

```swift
public func lastConnectedHost() throws -> PairedHost? {
    guard let data = try secureStore.data(forKey: Self.lastConnectedKey) else {
        return nil
    }
    let serverID = try JSONDecoder().decode(String.self, from: data)
    guard let host = try records()[serverID] else {
        try secureStore.removeValue(forKey: Self.lastConnectedKey)
        return nil
    }
    return host
}

public func markLastConnected(serverID: String) throws {
    guard try records()[serverID] != nil else {
        throw PairedHostStoreError.unknownHost(serverID: serverID)
    }
    try secureStore.set(
        try JSONEncoder().encode(serverID),
        forKey: Self.lastConnectedKey
    )
}

public func clearLastConnectedHost() throws {
    try secureStore.removeValue(forKey: Self.lastConnectedKey)
}
```

Update `remove(serverID:)` to clear a matching selection and update
`removeAll()` to remove both keys.

- [ ] **Step 6: Add atomic generation-bound finalization**

Add this internal method:

```swift
func recordSuccessfulConnection(
    _ host: PairedHost,
    for generation: ConnectionGeneration
) throws -> Bool {
    let normalized = try normalize(host)
    var updatedRecords = try records()

    if let existing = updatedRecords[normalized.serverID],
       existing.certificateFingerprint != normalized.certificateFingerprint {
        throw PairedHostStoreError.identityChanged(serverID: normalized.serverID)
    }
    updatedRecords[normalized.serverID] = normalized
    let selection = try JSONEncoder().encode(normalized.serverID)

    return try generation.withValidity {
        try write(updatedRecords)
        try secureStore.set(selection, forKey: Self.lastConnectedKey)
        return true
    } ?? false
}
```

Both secure-store writes occur synchronously while the generation validity lock
is held, so a retired connection cannot update either endpoint or selection.

- [ ] **Step 7: Run the store tests and commit**

Run the command from Step 3.

Expected: all `PairedHostStoreTests` pass.

```bash
git add \
  native/ios/PsycheCore/Sources/PsycheCore/Pairing/PairedHostStore.swift \
  native/ios/PsycheCore/Tests/PsycheCoreTests/PairedHostStoreTests.swift
git diff --cached --check
git commit -m "feat(ios): persist last connected host" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 3: Make Deliberate Connections Workspace-Ready

**Files:**
- Modify: `native/ios/PsycheCore/Sources/PsycheCore/Connection/ConnectionManager.swift`
- Test: `native/ios/PsycheCore/Tests/PsycheCoreTests/ConnectionManagerTests.swift`

- [ ] **Step 1: Write failing exact-host connection tests**

Add a test proving selected credentials and a matching refreshed endpoint are
used:

```swift
func testConnectToPairedHostUsesExactCredentialsAndRefreshedEndpoint() async throws {
    let fake = FakeTransport()
    let composition = makeComposition(transport: fake)
    let stored = makePairedHost(
        serverID: "server-z",
        endpoint: testEndpoint(host: "old.local"),
        clientID: "stored-client",
        token: "stored-token"
    )
    try await composition.pairedHostStore.save(stored)
    let refreshed = testEndpoint(host: "studio.local", port: 5151)

    let connect = Task {
        try await composition.manager.connectToPairedHost(
            serverID: "server-z",
            resolvedEndpoint: refreshed
        )
    }
    try await waitForHello(on: fake)

    guard case let .legacy(.hello(hello)) = await fake.sentMessages.first else {
        return XCTFail("Expected hello")
    }
    XCTAssertEqual(hello.clientID, "stored-client")
    XCTAssertEqual(hello.token, "stored-token")
    XCTAssertEqual(await fake.connectionAttempts, [refreshed])

    await fake.emit(.legacy(.welcome(makeWelcome(serverID: "server-z"))))
    _ = try await connect.value
}
```

Extend the existing test helpers so the snippets compile:

```swift
private func testEndpoint(
    host: String = "psyche.local",
    port: Int = 4242,
    fingerprint: String = testCertificateFingerprint
) -> HostEndpoint {
    HostEndpoint(
        host: host,
        port: port,
        certificateFingerprint: fingerprint
    )
}

private func makeWelcome(serverID: String = "host") -> WelcomePayload {
    WelcomePayload(
        serverID: serverID,
        serverName: "Host",
        protocolVersion: 3,
        projectName: nil
    )
}

private func makePairedHost(
    serverID: String = "server-1",
    endpoint: HostEndpoint? = nil,
    clientID: String = "stored-client",
    token: String? = "stored-token"
) -> PairedHost {
    PairedHost(
        serverID: serverID,
        serverName: "Host",
        endpoint: endpoint ?? testEndpoint(),
        clientID: clientID,
        token: token
    )
}
```

Add a mismatch test:

```swift
func testConnectToPairedHostRefusesChangedFingerprintBeforeTransport() async throws {
    let fake = FakeTransport()
    let composition = makeComposition(transport: fake)
    try await composition.pairedHostStore.save(makePairedHost())

    do {
        _ = try await composition.manager.connectToPairedHost(
            serverID: "server-1",
            resolvedEndpoint: testEndpoint(
                fingerprint: String(repeating: "b", count: 64)
            )
        )
        XCTFail("Expected changed identity to require re-pairing")
    } catch {
        XCTAssertEqual(
            error as? PairedHostStoreError,
            .identityChanged(serverID: "server-1")
        )
    }
    XCTAssertEqual(await fake.connectionAttempts, [])
}
```

Add an exact startup reconnect test with two stored hosts:

```swift
func testConnectToLastConnectedHostDoesNotUseSortedFirst() async throws {
    let fake = FakeTransport()
    let composition = makeComposition(transport: fake)
    try await composition.pairedHostStore.save(makePairedHost(
        serverID: "server-a",
        endpoint: testEndpoint(host: "alpha.local")
    ))
    try await composition.pairedHostStore.save(makePairedHost(
        serverID: "server-z",
        endpoint: testEndpoint(host: "studio.local")
    ))
    try await composition.pairedHostStore.markLastConnected(serverID: "server-z")

    let reconnect = Task {
        await composition.manager.connectToLastConnectedHost()
    }
    try await waitForHello(on: fake)
    XCTAssertEqual(
        await fake.connectionAttempts.first?.host,
        "studio.local"
    )
    await fake.emit(.legacy(.welcome(makeWelcome(serverID: "server-z"))))
    let requestID = try await waitForSnapshotRequest(on: fake)
    await fake.emit(.control(.workspaceSnapshot(MobileWorkspaceSnapshotResult(
        requestID: requestID,
        sequence: 1,
        workspace: makeWorkspace(revision: 1)
    ))))
    await reconnect.value
}
```

- [ ] **Step 2: Write failing workspace-readiness tests**

Prove readiness waits past negotiated `.connected` and finalizes only after
snapshot application:

```swift
func testWorkspaceReadinessFinalizesEndpointAndSelectionAfterSnapshot() async throws {
    let fake = FakeTransport()
    let composition = makeComposition(transport: fake)
    try await composition.pairedHostStore.save(makePairedHost())
    let refreshed = testEndpoint(host: "new.local", port: 5151)

    let connect = Task {
        try await composition.manager.connectToPairedHost(
            serverID: "server-1",
            resolvedEndpoint: refreshed
        )
    }
    try await waitForHello(on: fake)
    await fake.emit(.legacy(.welcome(makeWelcome()))
    _ = try await connect.value

    let readiness = Task {
        try await composition.manager.waitForWorkspaceReady()
    }
    await Task.yield()
    XCTAssertNil(try await composition.pairedHostStore.lastConnectedHost())

    let requestID = try await waitForSnapshotRequest(on: fake)
    await fake.emit(.control(.workspaceSnapshot(MobileWorkspaceSnapshotResult(
        requestID: requestID,
        sequence: 1,
        workspace: makeWorkspace(revision: 7)
    ))))
    try await readiness.value

    let selected = try await composition.pairedHostStore.lastConnectedHost()
    XCTAssertEqual(selected?.endpoint, refreshed)
    XCTAssertEqual(composition.workspaceStore.workspace?.revision, 7)
}
```

Add tests where disconnect, snapshot failure, and generation replacement throw
instead of completing readiness.

- [ ] **Step 3: Run the manager test file and confirm RED**

Run:

```bash
xcodebuild -project native/ios/Psyche.xcodeproj \
  -scheme PsycheCore \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  -only-testing:PsycheCoreTests/ConnectionManagerTests test
```

Expected: compile failures for `connectToPairedHost` and
`waitForWorkspaceReady`.

- [ ] **Step 4: Add explicit connection errors and readiness state**

Extend `ConnectionManagerError`:

```swift
case selectedHostUnavailable(serverID: String)
case connectionFailed(reason: String)
case workspaceReadinessUnavailable
```

Add localized messages that preserve the supplied server ID or failure reason.

Add actor state:

```swift
private var pendingReadyHost: PairedHost?
private var workspaceReadyGeneration: ConnectionGeneration?
private var workspaceReadinessWaiters:
    [UUID: (
        generation: ConnectionGeneration,
        continuation: CheckedContinuation<Void, any Error>
    )] = [:]
```

Resume all remaining readiness waiters from `deinit` with
`.workspaceReadinessUnavailable`.

- [ ] **Step 5: Add deliberate paired and pairing connection APIs**

Add:

```swift
@discardableResult
public func connectToPairedHost(
    serverID: String,
    resolvedEndpoint: HostEndpoint? = nil
) async throws -> PairedHost {
    let selected = try await selectedPairedHost(
        serverID: serverID,
        resolvedEndpoint: resolvedEndpoint
    )
    lifecycleIntentEpoch &+= 1
    let intentEpoch = lifecycleIntentEpoch
    await connect(
        using: ConnectionConfiguration(
            endpoint: selected.endpoint,
            credentials: ConnectionCredentials(
                clientID: selected.clientID,
                token: selected.token
            ),
            readyHost: selected
        ),
        intentEpoch: intentEpoch
    )
    guard state == .connected else {
        if case let .failed(reason) = state {
            throw ConnectionManagerError.connectionFailed(reason: reason)
        }
        throw ConnectionManagerError.workspaceReadinessUnavailable
    }
    return selected
}

private func selectedPairedHost(
    serverID: String,
    resolvedEndpoint: HostEndpoint?
) async throws -> PairedHost {
    guard let stored = try await pairedHostStore.host(withServerID: serverID) else {
        throw ConnectionManagerError.selectedHostUnavailable(serverID: serverID)
    }
    guard let resolvedEndpoint else { return stored }
    let status = try await pairedHostStore.pairingStatus(
        forServerID: serverID,
        certificateFingerprint: resolvedEndpoint.certificateFingerprint
    )
    guard status == .paired else {
        throw PairedHostStoreError.identityChanged(serverID: serverID)
    }
    return stored.withEndpoint(resolvedEndpoint)
}

public func connectForPairing(to endpoint: HostEndpoint) async throws {
    await connect(to: endpoint)
    guard state == .connected else {
        if case let .failed(reason) = state {
            throw ConnectionManagerError.connectionFailed(reason: reason)
        }
        throw ConnectionManagerError.workspaceReadinessUnavailable
    }
}
```

Add `readyHost: PairedHost?` to `ConnectionConfiguration`; set
`pendingReadyHost` when the new generation becomes active. Existing
`connect(to:)` passes `readyHost: nil`, and
`withPairingCredentials(clientID:token:)` preserves the existing `readyHost`.

In the `pairAccepted` handler, set `pendingReadyHost = host` after the
generation-bound `replace` succeeds and before requesting the initial snapshot.

- [ ] **Step 6: Add workspace-readiness waiting and completion**

Add:

```swift
public func waitForWorkspaceReady() async throws {
    guard let generation = activeGeneration else {
        throw ConnectionManagerError.workspaceReadinessUnavailable
    }
    if workspaceReadyGeneration === generation { return }

    let waiterID = UUID()
    try await withTaskCancellationHandler {
        try await withCheckedThrowingContinuation { continuation in
            guard activeGeneration === generation else {
                continuation.resume(
                    throwing: ConnectionManagerError.workspaceReadinessUnavailable
                )
                return
            }
            workspaceReadinessWaiters[waiterID] = (generation, continuation)
        }
    } onCancel: {
        Task { [weak self] in
            await self?.cancelWorkspaceReadinessWaiter(waiterID)
        }
    }
}
```

After `WorkspaceStore.applySnapshot` returns, finalize the host before
completing waiters:

```swift
if let pendingReadyHost {
    let committed = try await pairedHostStore.recordSuccessfulConnection(
        pendingReadyHost,
        for: generation
    )
    guard committed else { return .ignored }
}
workspaceReadyGeneration = generation
completeWorkspaceReadiness(for: generation, with: .success(()))
```

If finalization throws, tear down the active connection with the localized
error and fail readiness. On snapshot request failure, disconnect, cancellation,
or generation replacement, call:

```swift
completeWorkspaceReadiness(
    for: generation,
    with: .failure(error)
)
```

Reset `pendingReadyHost` and `workspaceReadyGeneration` in
`resetPerConnectionState`.

- [ ] **Step 7: Replace lexicographic reconnect**

Replace `connectToStoredHost()` with:

```swift
public func connectToLastConnectedHost() async {
    let intentEpoch = lifecycleIntentEpoch
    guard canStartStoredReconnect(intentEpoch: intentEpoch) else { return }

    do {
        guard let host = try await pairedHostStore.lastConnectedHost() else {
            return
        }
        guard canStartStoredReconnect(intentEpoch: intentEpoch) else { return }
        let selected = try await selectedPairedHost(
            serverID: host.serverID,
            resolvedEndpoint: nil
        )
        await connect(
            using: ConnectionConfiguration(
                endpoint: selected.endpoint,
                credentials: ConnectionCredentials(
                    clientID: selected.clientID,
                    token: selected.token
                ),
                readyHost: selected
            ),
            intentEpoch: intentEpoch
        )
        guard state == .connected else {
            if case let .failed(reason) = state {
                throw ConnectionManagerError.connectionFailed(reason: reason)
            }
            throw ConnectionManagerError.workspaceReadinessUnavailable
        }
        try await waitForWorkspaceReady()
    } catch {
        guard lifecycleIntentEpoch == intentEpoch else { return }
        transition(to: .failed(error.localizedDescription))
    }
}
```

Preserve the existing intent-epoch guards so a user action can supersede
startup reconnect.

- [ ] **Step 8: Run manager tests and commit**

Run the command from Step 3.

Expected: all `ConnectionManagerTests` pass, including existing connect,
pairing, cancellation, and generation-race coverage.

```bash
git add \
  native/ios/PsycheCore/Sources/PsycheCore/Connection/ConnectionManager.swift \
  native/ios/PsycheCore/Tests/PsycheCoreTests/ConnectionManagerTests.swift
git diff --cached --check
git commit -m "feat(ios): complete selected host connections" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 4: Compose Discovery and Exact Startup Reconnect

**Files:**
- Modify: `native/ios/PsycheCore/Sources/PsycheCore/Connection/MobileAppComposition.swift`
- Modify: `native/ios/PsycheApp/Sources/PsycheApp/AppModel.swift`
- Test: `native/ios/PsycheApp/UnitTests/AppModelTests.swift`

- [ ] **Step 1: Write failing AppModel startup-selection tests**

Add an internal production initializer to the test target through
`@testable import`, then test exact host context:

```swift
func testProductionContextUsesLastConnectedHostRatherThanSortedFirst() async throws {
    let secureStore = InMemorySecureStore()
    let pairedStore = PairedHostStore(secureStore: secureStore)
    try await pairedStore.save(makeHost(serverID: "server-a", name: "Alpha"))
    try await pairedStore.save(makeHost(serverID: "server-z", name: "Studio"))
    try await pairedStore.markLastConnected(serverID: "server-z")
    let composition = MobileAppComposition(
        transport: FakeTransport(),
        pairedHostStore: pairedStore
    )
    let model = AppModel(composition: composition)

    await model.loadLastConnectedHostContext()

    XCTAssertEqual(model.hostName, "Studio")
}
```

Add this local helper and update the existing production-composition test to
assert one shared `bonjourHostDiscovery`:

```swift
private func makeHost(serverID: String, name: String) -> PairedHost {
    PairedHost(
        serverID: serverID,
        serverName: name,
        endpoint: HostEndpoint(
            host: "\(serverID).local",
            port: 4242,
            certificateFingerprint: String(repeating: "a", count: 64)
        ),
        clientID: "client-\(serverID)",
        token: "token-\(serverID)"
    )
}
```

- [ ] **Step 2: Run AppModel tests and confirm RED**

Run:

```bash
xcodebuild -project native/ios/Psyche.xcodeproj \
  -scheme PsycheApp \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  -only-testing:PsycheAppTests/AppModelTests test
```

Expected: compile failures because composition does not own discovery and
`AppModel` cannot receive an injected production composition.

- [ ] **Step 3: Add discovery to MobileAppComposition**

Add:

```swift
public let bonjourHostDiscovery: BonjourHostDiscovery
```

Extend the initializer:

```swift
public init(
    transport: any PsycheTransport,
    pairedHostStore: PairedHostStore,
    bonjourHostDiscovery: BonjourHostDiscovery = BonjourHostDiscovery(),
    clientID: String = UUID().uuidString,
    clientName: String = "Psyche iOS"
) {
    self.bonjourHostDiscovery = bonjourHostDiscovery
    // retain the existing shared request/store/manager graph
}
```

Change startup:

```swift
public func start() async {
    guard !hasStarted else { return }
    hasStarted = true
    terminalRegistry.start()
    await connectionManager.connectToLastConnectedHost()
}
```

- [ ] **Step 4: Add AppModel production injection and exact host context**

Factor the current production branch into:

```swift
init(composition: MobileAppComposition) {
    fixtureName = nil
    self.composition = composition
    workspaceStore = composition.workspaceStore
    terminalRegistry = composition.terminalRegistry
}
```

Keep `init(fixture:...)` as the launch-facing initializer and delegate its
production branch to the same assignments.

Replace the sorted-first lookup in `start()`:

```swift
await loadLastConnectedHostContext()
```

and add the directly testable helper:

```swift
func loadLastConnectedHostContext() async {
    guard let composition else { return }
    if let paired = try? await composition.pairedHostStore.lastConnectedHost() {
        hostName = paired.serverName
    }
}
```

Rename `recordPairedHostName` to:

```swift
func recordConnectedHost(_ host: PairedHost) {
    hostName = host.serverName
    connectionError = nil
}
```

- [ ] **Step 5: Run AppModel tests and commit**

Run the command from Step 2.

Expected: all `AppModelTests` pass and fixture tests still prove that no
network/Keychain graph exists.

```bash
git add \
  native/ios/PsycheCore/Sources/PsycheCore/Connection/MobileAppComposition.swift \
  native/ios/PsycheApp/Sources/PsycheApp/AppModel.swift \
  native/ios/PsycheApp/UnitTests/AppModelTests.swift
git diff --cached --check
git commit -m "feat(ios): compose exact host reconnect" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 5: Add the PairHostModel State Machine

**Files:**
- Create: `native/ios/PsycheApp/Sources/PsycheApp/Pairing/PairHostModel.swift`
- Create: `native/ios/PsycheApp/UnitTests/PairHostModelTests.swift`
- Modify: `native/ios/Psyche.xcodeproj/project.pbxproj` through XcodeGen

- [ ] **Step 1: Write failing model tests for discovery classification**

Create `PairHostModelTests.swift` with a closure-driven fake dependency set:

```swift
@MainActor
final class PairHostModelTests: XCTestCase {
    func testDiscoveryRowsCarryPairingStatusAndResolutionFailure() async {
        let stream = AsyncStream<[BonjourDiscoveryEntry]> { continuation in
            continuation.yield([
                makeEntry(serverID: "paired", availability: .resolved(makeHost())),
                makeEntry(
                    serverID: "changed",
                    fingerprint: String(repeating: "b", count: 64),
                    availability: .resolved(makeHost(
                        serverID: "changed",
                        fingerprint: String(repeating: "b", count: 64)
                    ))
                ),
                makeEntry(
                    serverID: "offline",
                    availability: .resolutionFailed(.timedOut)
                ),
            ])
        }
        let model = PairHostModel(dependencies: .fake(
            discovery: stream,
            pairingStatuses: [
                "paired": .paired,
                "changed": .requiresRePairing,
                "offline": .unpaired,
            ]
        ))

        model.start()
        try await waitForRows(3, in: model)

        XCTAssertEqual(model.rows.map(\.pairingStatus), [
            .requiresRePairing,
            .unpaired,
            .paired,
        ])
        XCTAssertEqual(
            model.rows.first(where: { $0.id == "offline" })?.resolutionFailure,
            .timedOut
        )
    }
}
```

Sort expected rows by server ID, matching Core discovery.

- [ ] **Step 2: Write failing action-flow tests**

Add focused tests for each action:

```swift
func testPairedHostConnectsAndCompletesOnlyAfterWorkspaceReady() async {
    let probe = PairHostDependencyProbe()
    let model = makeModel(probe: probe, status: .paired)
    try? await loadAndSelectFirstRow(model)

    let submit = Task { await model.submit() }
    await probe.waitForPairedConnect()
    XCTAssertEqual(model.phase, .loadingWorkspace)
    XCTAssertNil(model.readyHost)

    probe.finishWorkspaceReadiness()
    await submit.value

    XCTAssertEqual(model.phase, .ready)
    XCTAssertEqual(model.readyHost?.serverID, "server-1")
}

func testChangedFingerprintRequiresWarningBeforePairing() async {
    let probe = PairHostDependencyProbe()
    let model = makeModel(probe: probe, status: .requiresRePairing)
    try? await loadAndSelectFirstRow(model)

    await model.submit()

    XCTAssertEqual(model.phase, .confirmingRePair)
    XCTAssertEqual(await probe.connectForPairingCount, 0)
}

func testManualEntryRejectsMalformedPortAndFingerprint() async {
    let model = PairHostModel(dependencies: .fake())
    model.showManualEntry = true
    model.manualHost = "studio.local"
    model.manualPort = "70000"
    model.manualFingerprint = "nope"
    model.pairingCode = "123456"

    await model.submit()

    XCTAssertEqual(model.phase, .failed)
    XCTAssertNotNil(model.errorMessage)
}
```

Also cover retry delegation, code rejection, code clearing after failure,
cancellation/disconnect on stop, and unpaired/manual success.

Add these concrete test helpers in the same file:

```swift
private actor PairHostDependencyProbe {
    private(set) var pairedConnectCount = 0
    private(set) var connectForPairingCount = 0
    private var readinessContinuation: CheckedContinuation<Void, Never>?

    func connectPaired(
        serverID: String,
        endpoint: HostEndpoint?
    ) -> PairedHost {
        pairedConnectCount += 1
        return makeTestPairedHost(serverID: serverID, endpoint: endpoint)
    }

    func connectForPairing(endpoint: HostEndpoint) {
        connectForPairingCount += 1
    }

    func waitForWorkspaceReady() async {
        await withCheckedContinuation { readinessContinuation = $0 }
    }

    func finishWorkspaceReadiness() {
        readinessContinuation?.resume()
        readinessContinuation = nil
    }

    func waitForPairedConnect() async {
        for _ in 0..<1_000 {
            if pairedConnectCount > 0 { return }
            await Task.yield()
        }
    }
}

private func waitForRows(
    _ count: Int,
    in model: PairHostModel
) async throws {
    for _ in 0..<1_000 {
        if model.rows.count == count { return }
        await Task.yield()
    }
    throw PairHostTestError.timedOut
}

private func loadAndSelectFirstRow(_ model: PairHostModel) async throws {
    model.start()
    try await waitForRows(1, in: model)
    model.selectedServerID = try XCTUnwrap(model.rows.first?.id)
}

private func makeModel(
    probe: PairHostDependencyProbe,
    status: PairingStatus
) -> PairHostModel {
    let entry = makeEntry(
        serverID: "server-1",
        availability: .resolved(makeDiscoveredHost(serverID: "server-1"))
    )
    let stream = AsyncStream<[BonjourDiscoveryEntry]> { continuation in
        continuation.yield([entry])
    }
    return PairHostModel(dependencies: .init(
        startDiscovery: { stream },
        stopDiscovery: {},
        retryDiscovery: { _ in },
        pairingStatus: { _, _ in status },
        connectPaired: {
            await probe.connectPaired(serverID: $0, endpoint: $1)
        },
        connectForPairing: {
            await probe.connectForPairing(endpoint: $0)
        },
        pair: { _ in makeTestPairedHost() },
        waitForWorkspaceReady: {
            await probe.waitForWorkspaceReady()
        },
        disconnect: {}
    ))
}
```

Define `PairHostTestError.timedOut`, `makeEntry`, `makeDiscoveredHost`, and
`makeTestPairedHost` as file-private constructors using one valid 64-character
fingerprint. Add a file-private `Dependencies.fake(...)` factory that supplies
finished/no-op defaults and accepts the discovery stream plus a
`[String: PairingStatus]` map used by the classification test:

```swift
private extension PairHostModel.Dependencies {
    static func fake(
        discovery: AsyncStream<[BonjourDiscoveryEntry]> = .init {
            $0.finish()
        },
        pairingStatuses: [String: PairingStatus] = [:]
    ) -> Self {
        .init(
            startDiscovery: { discovery },
            stopDiscovery: {},
            retryDiscovery: { _ in },
            pairingStatus: { serverID, _ in
                pairingStatuses[serverID] ?? .unpaired
            },
            connectPaired: { serverID, endpoint in
                makeTestPairedHost(serverID: serverID, endpoint: endpoint)
            },
            connectForPairing: { _ in },
            pair: { _ in makeTestPairedHost() },
            waitForWorkspaceReady: {},
            disconnect: {}
        )
    }
}
```

- [ ] **Step 3: Run XcodeGen and the new tests to confirm RED**

Run:

```bash
pnpm ios:project:generate
xcodebuild -project native/ios/Psyche.xcodeproj \
  -scheme PsycheApp \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  -only-testing:PsycheAppTests/PairHostModelTests test
```

Expected: compile failure because `PairHostModel` does not exist.

- [ ] **Step 4: Define the model's stable public state**

Create `PairHostModel.swift` with:

```swift
import Combine
import Foundation
import PsycheCore

@MainActor
final class PairHostModel: ObservableObject {
    enum Phase: Equatable {
        case browsing
        case selected
        case confirmingRePair
        case connecting
        case pairing
        case loadingWorkspace
        case ready
        case failed
    }

    struct Row: Identifiable, Equatable {
        let entry: BonjourDiscoveryEntry
        let pairingStatus: PairingStatus

        var id: String { entry.serverID }
        var serverName: String { entry.serverName }
        var resolutionFailure: BonjourResolutionFailure? {
            guard case let .resolutionFailed(failure) = entry.availability else {
                return nil
            }
            return failure
        }
    }

    struct Dependencies: Sendable {
        let startDiscovery:
            @Sendable () async -> AsyncStream<[BonjourDiscoveryEntry]>
        let stopDiscovery: @Sendable () async -> Void
        let retryDiscovery: @Sendable (String) async -> Void
        let pairingStatus:
            @Sendable (String, String) async throws -> PairingStatus
        let connectPaired:
            @Sendable (String, HostEndpoint?) async throws -> PairedHost
        let connectForPairing: @Sendable (HostEndpoint) async throws -> Void
        let pair: @Sendable (String) async throws -> PairedHost
        let waitForWorkspaceReady: @Sendable () async throws -> Void
        let disconnect: @Sendable () async -> Void
    }

    @Published private(set) var rows: [Row] = []
    @Published private(set) var phase: Phase = .browsing
    @Published private(set) var errorMessage: String?
    @Published private(set) var readyHost: PairedHost?
    @Published var selectedServerID: String?
    @Published var showManualEntry = false
    @Published var manualHost = ""
    @Published var manualPort = ""
    @Published var manualFingerprint = ""
    @Published var pairingCode = ""
}
```

Add computed validation for host whitespace, `1...65535`, fingerprint
normalization, and exactly six numeric code characters.

- [ ] **Step 5: Add production dependency composition**

Add:

```swift
convenience init(composition: MobileAppComposition) {
    let discovery = composition.bonjourHostDiscovery
    let store = composition.pairedHostStore
    let manager = composition.connectionManager
    self.init(dependencies: Dependencies(
        startDiscovery: { await discovery.start() },
        stopDiscovery: { await discovery.stop() },
        retryDiscovery: { await discovery.retry(serverID: $0) },
        pairingStatus: {
            try await store.pairingStatus(
                forServerID: $0,
                certificateFingerprint: $1
            )
        },
        connectPaired: {
            try await manager.connectToPairedHost(
                serverID: $0,
                resolvedEndpoint: $1
            )
        },
        connectForPairing: { try await manager.connectForPairing(to: $0) },
        pair: { try await manager.pair(code: $0) },
        waitForWorkspaceReady: { try await manager.waitForWorkspaceReady() },
        disconnect: { await manager.disconnect() }
    ))
}
```

- [ ] **Step 6: Implement discovery observation and retry**

`start()` creates one observation task, converts each snapshot into rows by
querying `pairingStatus`, sorts by server ID, and preserves selection only while
that server ID remains present.

`retry(serverID:)` sets an in-flight row ID, awaits the dependency, and leaves
the updated row to the discovery stream. `stop()` cancels observation and
action tasks, stops discovery, disconnects an incomplete connection, and clears
the pairing code.

Use separate `observationTask` and `actionTask` properties so a discovery
refresh cannot cancel a user's active connection.

- [ ] **Step 7: Implement paired, pairing, re-pair, and manual submission**

For a resolved paired row:

```swift
private func connectPaired(_ row: Row, endpoint: HostEndpoint) async throws {
    phase = .connecting
    let host = try await dependencies.connectPaired(row.id, endpoint)
    phase = .loadingWorkspace
    try await dependencies.waitForWorkspaceReady()
    readyHost = host
    phase = .ready
}
```

For unpaired or confirmed re-pair:

```swift
private func pair(endpoint: HostEndpoint) async throws {
    guard isPairingCodeValid else {
        throw ValidationError.invalidPairingCode
    }
    phase = .connecting
    try await dependencies.connectForPairing(endpoint)
    phase = .pairing
    let host = try await dependencies.pair(pairingCode)
    phase = .loadingWorkspace
    try await dependencies.waitForWorkspaceReady()
    pairingCode = ""
    readyHost = host
    phase = .ready
}
```

`submit()` routes `.requiresRePairing` to `.confirmingRePair` without opening a
connection. `confirmRePairing()` runs the pairing path. Manual submission builds
a normalized `HostEndpoint` from all three required fields and then runs the
same pairing path.

On failure, retain selection/manual endpoint fields, clear `pairingCode`, set
`errorMessage = error.localizedDescription`, and set `.failed`.

- [ ] **Step 8: Run model tests and commit**

Run the command from Step 3.

Expected: all `PairHostModelTests` pass without network or Keychain access.

```bash
git add \
  native/ios/PsycheApp/Sources/PsycheApp/Pairing/PairHostModel.swift \
  native/ios/PsycheApp/UnitTests/PairHostModelTests.swift \
  native/ios/Psyche.xcodeproj/project.pbxproj
git diff --cached --check
git commit -m "feat(ios): add Bonjour pairing state model" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 6: Render and Wire the Host-Selection Sheet

**Files:**
- Modify: `native/ios/PsycheApp/Sources/PsycheApp/Views/PairHostSheet.swift`
- Modify: `native/ios/PsycheApp/Sources/PsycheApp/Views/SettingsView.swift`
- Modify: `native/ios/PsycheApp/Sources/PsycheApp/AppModel.swift`
- Modify: `native/ios/PsycheApp/UnitTests/AppModelTests.swift`

- [ ] **Step 1: Add a network-free fixture pairing model**

In `AppModel`, add:

```swift
func makePairHostModel() -> PairHostModel {
    if let composition {
        return PairHostModel(composition: composition)
    }
    return PairHostModel.fixture()
}
```

Implement `PairHostModel.fixture()` with a finished in-memory discovery stream
containing:

- `studio` as resolved and paired;
- `new-host` as resolved and unpaired;
- `changed-host` as resolved and requiring re-pairing; and
- `offline-host` as `.resolutionFailed(.timedOut)`.

Its action closures return deterministic `PairedHost` values, its readiness
closure completes immediately, and its disconnect closure is a no-op. This
preserves the fixture root's guarantee that no network or Keychain graph exists.

Use one helper that constructs the identity and endpoint consistently:

```swift
static func fixture() -> PairHostModel {
    let fingerprint = String(repeating: "a", count: 64)

    func entry(
        id: String,
        name: String,
        availability: BonjourHostAvailability
    ) -> BonjourDiscoveryEntry {
        BonjourDiscoveryEntry(
            identity: BonjourHostIdentity(
                serverID: id,
                serverName: name,
                domain: "local.",
                certificateFingerprint: fingerprint,
                supportedVersions: [PsycheProtocolVersion.current]
            ),
            availability: availability
        )
    }

    func discovered(id: String, name: String, port: Int) -> DiscoveredHost {
        let identity = BonjourHostIdentity(
            serverID: id,
            serverName: name,
            domain: "local.",
            certificateFingerprint: fingerprint,
            supportedVersions: [PsycheProtocolVersion.current]
        )
        return DiscoveredHost(
            identity: identity,
            endpoint: HostEndpoint(
                host: "\(id).local",
                port: port,
                certificateFingerprint: fingerprint
            )
        )
    }

    let studio = discovered(id: "studio", name: "Studio", port: 4242)
    let newHost = discovered(id: "new-host", name: "New Host", port: 4243)
    let changed = discovered(id: "changed-host", name: "Changed Host", port: 4244)
    let stream = AsyncStream<[BonjourDiscoveryEntry]> { continuation in
        continuation.yield([
            entry(id: "studio", name: "Studio", availability: .resolved(studio)),
            entry(id: "new-host", name: "New Host", availability: .resolved(newHost)),
            entry(
                id: "changed-host",
                name: "Changed Host",
                availability: .resolved(changed)
            ),
            entry(
                id: "offline-host",
                name: "Offline Host",
                availability: .resolutionFailed(.timedOut)
            ),
        ])
    }

    return PairHostModel(dependencies: .init(
        startDiscovery: { stream },
        stopDiscovery: {},
        retryDiscovery: { _ in },
        pairingStatus: { serverID, _ in
            switch serverID {
            case "studio": .paired
            case "changed-host": .requiresRePairing
            default: .unpaired
            }
        },
        connectPaired: { _, endpoint in
            PairedHost(
                serverID: studio.serverID,
                serverName: studio.serverName,
                endpoint: endpoint ?? studio.endpoint,
                clientID: "fixture-client",
                token: "fixture-token"
            )
        },
        connectForPairing: { _ in },
        pair: { _ in
            PairedHost(
                serverID: newHost.serverID,
                serverName: newHost.serverName,
                endpoint: newHost.endpoint,
                clientID: "fixture-client",
                token: "fixture-token"
            )
        },
        waitForWorkspaceReady: {},
        disconnect: {}
    ))
}
```

Add an `AppModelTests` assertion:

```swift
func testFixturePairingModelComposesNoLiveConnectionGraph() async {
    let appModel = AppModel(fixture: WorkspaceFixtures.multiproject)
    let pairModel = appModel.makePairHostModel()

    pairModel.start()
    for _ in 0..<1_000 where pairModel.rows.count != 4 {
        await Task.yield()
    }

    XCTAssertNil(appModel.composition)
    XCTAssertEqual(pairModel.rows.count, 4)
}
```

- [ ] **Step 2: Replace the non-networked sheet stub**

Change the initializer to own a model for the sheet lifetime:

```swift
struct PairHostSheet: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model: PairHostModel
    private let onReady: (PairedHost) -> Void

    init(
        model: PairHostModel,
        onReady: @escaping (PairedHost) -> Void
    ) {
        _model = StateObject(wrappedValue: model)
        self.onReady = onReady
    }
}
```

Render a `List` with:

- `Section("Nearby hosts")` and one button per `model.rows`;
- status labels `Paired`, `Pair`, `Requires re-pairing`, or
  `Address unavailable`;
- a Retry button on failed-resolution rows;
- `Section("Manual connection")` with host, port, fingerprint, and code fields;
- footer text saying the port and fingerprint must be copied from Psyche and
  that the app will not trust an unknown certificate automatically;
- a selected-host code field for unpaired/re-pairing rows;
- progress and error sections keyed by `model.phase`; and
- a destructive-looking certificate-change confirmation section whose primary
  button says `Continue to re-pair`.

Use these stable identifiers:

```text
pair-host-sheet
pair-host-row-<serverID>
pair-host-status-<serverID>
pair-host-retry-<serverID>
pair-host-manual-toggle
pair-host-manual-host
pair-host-manual-port
pair-host-manual-fingerprint
pair-host-code
pair-host-submit
pair-host-repair-confirm
pair-host-error
pair-host-progress
```

Start discovery with `.task { model.start() }`, stop with:

```swift
.onDisappear {
    model.stop()
}
```

Observe `model.readyHost`; call `onReady(host)` and dismiss only after phase
`.ready`.

- [ ] **Step 3: Wire Settings to a fresh model**

Replace the current closure-only sheet:

```swift
.sheet(isPresented: $isPairSheetPresented) {
    PairHostSheet(model: model.makePairHostModel()) { host in
        model.recordConnectedHost(host)
    }
}
```

Rename the Settings action from `Pair a host` to `Connections` while retaining
the existing `settings-pair-host` identifier. Change the footer to:

```swift
Text("Discover, pair, or switch to a Psyche host on your local network.")
```

- [ ] **Step 4: Run app unit tests and build**

Run:

```bash
pnpm ios:project:generate
xcodebuild -project native/ios/Psyche.xcodeproj \
  -scheme PsycheApp \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  -only-testing:PsycheAppTests/AppModelTests \
  -only-testing:PsycheAppTests/PairHostModelTests test
xcodebuild -project native/ios/Psyche.xcodeproj \
  -scheme PsycheApp \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build build
```

Expected: both unit-test classes pass and the app builds under Swift 6 strict
concurrency.

- [ ] **Step 5: Commit the SwiftUI flow**

```bash
git add \
  native/ios/PsycheApp/Sources/PsycheApp/AppModel.swift \
  native/ios/PsycheApp/Sources/PsycheApp/Views/PairHostSheet.swift \
  native/ios/PsycheApp/Sources/PsycheApp/Views/SettingsView.swift \
  native/ios/PsycheApp/UnitTests/AppModelTests.swift \
  native/ios/Psyche.xcodeproj/project.pbxproj
git diff --cached --check
git commit -m "feat(ios): wire Bonjour host selection UI" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 7: Prove the Flow End to End

**Files:**
- Modify: `native/ios/PsycheApp/Tests/PsycheAppUITests/PsycheAppUITests.swift`
- Modify: `native/ios/README.md`

- [ ] **Step 1: Add UI coverage for discovered statuses and retry**

Add:

```swift
func testConnectionsSheetShowsDiscoveredStatusesAndResolutionRetry() throws {
    let app = launchApp()
    openSettings(in: app)
    element("settings-pair-host", in: app).tap()

    XCTAssertTrue(element("pair-host-sheet", in: app).waitForExistence(timeout: 10))
    XCTAssertTrue(element("pair-host-status-studio", in: app).label.contains("Paired"))
    XCTAssertTrue(
        element("pair-host-status-changed-host", in: app)
            .label.contains("Requires re-pairing")
    )
    XCTAssertTrue(element("pair-host-retry-offline-host", in: app).exists)
}
```

Add a width-independent `openSettings(in:)` helper that taps the Settings tab
on compact width or `source-settings` on regular width.

- [ ] **Step 2: Add UI coverage for re-pair warning and manual validation**

```swift
func testChangedFingerprintRequiresExplicitRePairConfirmation() throws {
    let app = launchApp()
    openConnections(in: app)

    element("pair-host-row-changed-host", in: app).tap()
    element("pair-host-submit", in: app).tap()

    XCTAssertTrue(
        element("pair-host-repair-confirm", in: app)
            .waitForExistence(timeout: 10)
    )
}

func testManualConnectionRejectsInvalidPortAndFingerprint() throws {
    let app = launchApp()
    openConnections(in: app)
    element("pair-host-manual-toggle", in: app).tap()

    element("pair-host-manual-host", in: app).tap()
    element("pair-host-manual-host", in: app).typeText("studio.local")
    element("pair-host-manual-port", in: app).tap()
    element("pair-host-manual-port", in: app).typeText("70000")
    element("pair-host-manual-fingerprint", in: app).tap()
    element("pair-host-manual-fingerprint", in: app).typeText("nope")
    element("pair-host-code", in: app).tap()
    element("pair-host-code", in: app).typeText("123456")
    element("pair-host-submit", in: app).tap()

    XCTAssertTrue(element("pair-host-error", in: app).waitForExistence(timeout: 10))
}
```

- [ ] **Step 3: Add UI coverage for workspace-ready dismissal**

Use the paired fixture row, whose dependency completes readiness
deterministically:

```swift
func testPairedHostDismissesOnlyAfterReadyAndUpdatesHostContext() throws {
    let app = launchApp()
    openConnections(in: app)

    element("pair-host-row-studio", in: app).tap()
    element("pair-host-submit", in: app).tap()

    XCTAssertFalse(element("pair-host-sheet", in: app).waitForExistence(timeout: 2))
    let host = element("settings-host", in: app)
    XCTAssertTrue(host.waitForExistence(timeout: 10))
    XCTAssertTrue(host.label.contains("Studio"), host.label)
}
```

If the sheet dismissal animation makes the negative wait unreliable, assert
that `settings-view` becomes hittable and `pair-host-sheet` no longer exists.

- [ ] **Step 4: Run focused UI tests**

Run:

```bash
xcodebuild -project native/ios/Psyche.xcodeproj \
  -scheme PsycheApp \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  -only-testing:PsycheAppUITests/PsycheAppUITests/testConnectionsSheetShowsDiscoveredStatusesAndResolutionRetry \
  -only-testing:PsycheAppUITests/PsycheAppUITests/testChangedFingerprintRequiresExplicitRePairConfirmation \
  -only-testing:PsycheAppUITests/PsycheAppUITests/testManualConnectionRejectsInvalidPortAndFingerprint \
  -only-testing:PsycheAppUITests/PsycheAppUITests/testPairedHostDismissesOnlyAfterReadyAndUpdatesHostContext \
  test
```

Expected: all four tests pass without network or Keychain access.

- [ ] **Step 5: Document the live acceptance procedure**

Add a `Bonjour connection acceptance` subsection to `native/ios/README.md`:

```markdown
### Bonjour connection acceptance

1. Launch a host build and run `:pair`.
2. Open Settings > Connections on an iPhone on the same LAN.
3. Select the advertised host, enter the six-digit code, and confirm that the
   sheet closes only after a populated workspace appears.
4. Relaunch the app and confirm it reconnects to the same last-connected host.
5. Pair a second host and confirm selecting it changes the next launch target.
6. Advertise a known server ID with a changed fingerprint and confirm the app
   shows the warning-gated re-pair path instead of Connect.
7. Force service resolution failure and confirm the failed row, Retry action,
   and manual host/port/fingerprint fallback remain available.
```

- [ ] **Step 6: Run the complete automated verification**

Run:

```bash
pnpm ios:project:check
xcodebuild -project native/ios/Psyche.xcodeproj \
  -scheme PsycheCore \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build test
xcodebuild -project native/ios/Psyche.xcodeproj \
  -scheme PsycheApp \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  -only-testing:PsycheAppTests \
  -only-testing:PsycheAppUITests test
git diff --check
```

Expected: project generation is clean, all Core tests pass, all app unit/UI
tests pass, and the worktree has no whitespace errors.

- [ ] **Step 7: Perform live acceptance**

Follow the README procedure with exact host and iOS builds. Record:

- host commit;
- iOS commit;
- device and OS version;
- selected server IDs;
- whether each of the seven acceptance steps passed; and
- any environmental failure separately from a product failure.

Do not close `psyche-i7c.11` until the no-record pairing, workspace readiness,
last-connected relaunch, changed-fingerprint warning, and resolution-failure
recovery have all passed.

- [ ] **Step 8: Commit verification coverage and documentation**

```bash
git add \
  native/ios/PsycheApp/Tests/PsycheAppUITests/PsycheAppUITests.swift \
  native/ios/README.md
git diff --cached --check
git commit -m "test(ios): verify Bonjour connection completion" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```
