import Foundation
import Security
import XCTest
@testable import PsycheCore

final class PairedHostStoreTests: XCTestCase {
    private let fingerprint = "0c8893630b087f7ab19a71c016e599cebc3b5235fd449e9917a43850edddaa38"
    private let otherFingerprint = String(repeating: "b", count: 64)

    func testRoundTripsAndClearsThroughTheSecureStore() async throws {
        let secureStore = InMemorySecureStore()
        let store = PairedHostStore(secureStore: secureStore)
        let host = makeHost()

        try await store.save(host)

        let loaded = try await store.host(withServerID: "server-1")
        let all = try await store.hosts()
        XCTAssertEqual(loaded, host)
        XCTAssertEqual(all, [host])
        XCTAssertEqual(loaded?.clientID, "client-1")
        XCTAssertEqual(loaded?.token, "token-1")
        XCTAssertEqual(loaded?.endpoint.port, 4242)

        try await store.removeAll()

        let cleared = try await store.hosts()
        let clearedBlob = try secureStore.data(forKey: PairedHostStore.defaultKey)
        XCTAssertEqual(cleared, [])
        XCTAssertNil(clearedBlob)
    }

    func testSurvivesAFreshStoreOverTheSameSecureStore() async throws {
        let secureStore = InMemorySecureStore()
        try await PairedHostStore(secureStore: secureStore).save(makeHost())

        let reopened = try await PairedHostStore(secureStore: secureStore).hosts()

        XCTAssertEqual(reopened, [makeHost()])
    }

    func testPersistsFingerprintsInOneCanonicalForm() async throws {
        let store = PairedHostStore(secureStore: InMemorySecureStore())
        let colonSeparated = fingerprint.uppercased().chunked(every: 2).joined(separator: ":")

        try await store.save(makeHost(fingerprint: colonSeparated))

        let loaded = try await store.host(withServerID: "server-1")
        XCTAssertEqual(loaded?.certificateFingerprint, fingerprint)
    }

    func testRejectsAMalformedFingerprint() async {
        let store = PairedHostStore(secureStore: InMemorySecureStore())

        do {
            try await store.save(makeHost(fingerprint: "nope"))
            XCTFail("Expected a malformed fingerprint to be rejected")
        } catch {
            XCTAssertEqual(error as? PairedHostStoreError, .invalidFingerprint)
            XCTAssertTrue(error.localizedDescription.localizedCaseInsensitiveContains("re-pair"))
        }
    }

    func testSameServerIDWithAChangedFingerprintRefusesToOverwrite() async throws {
        let store = PairedHostStore(secureStore: InMemorySecureStore())
        try await store.save(makeHost())

        do {
            try await store.save(makeHost(fingerprint: otherFingerprint, token: "token-2"))
            XCTFail("Expected a changed fingerprint to require re-pairing")
        } catch {
            XCTAssertEqual(error as? PairedHostStoreError, .identityChanged(serverID: "server-1"))
            XCTAssertTrue(error.localizedDescription.localizedCaseInsensitiveContains("re-pair"))
        }

        let loaded = try await store.host(withServerID: "server-1")
        XCTAssertEqual(loaded?.certificateFingerprint, fingerprint)
        XCTAssertEqual(loaded?.token, "token-1")
    }

    func testExplicitRePairingAcceptsTheNewFingerprint() async throws {
        let store = PairedHostStore(secureStore: InMemorySecureStore())
        try await store.save(makeHost())

        try await store.replace(makeHost(fingerprint: otherFingerprint, token: "token-2"))

        let loaded = try await store.host(withServerID: "server-1")
        let all = try await store.hosts()
        XCTAssertEqual(loaded?.certificateFingerprint, otherFingerprint)
        XCTAssertEqual(loaded?.token, "token-2")
        XCTAssertEqual(all.count, 1)
    }

    func testGenerationBoundRePairingCannotReplaceTrustAfterSupersession() async throws {
        let secureStore = SaveBoundarySecureStore()
        let store = PairedHostStore(secureStore: secureStore)
        try await store.save(makeHost())
        let generation = ConnectionGeneration(id: 1)
        let authorization = PairingPersistenceAuthorization()
        let replacementHost = makeHost(fingerprint: otherFingerprint, token: "token-2")

        secureStore.blockNextRead()
        let replacement = Task {
            try await store.replace(
                replacementHost,
                for: generation,
                authorizedBy: authorization
            )
        }
        try await secureStore.waitUntilReadBegins()
        generation.invalidate()
        secureStore.releaseRead()

        let replaced = try await replacement.value
        XCTAssertFalse(replaced)
        let loaded = try await store.host(withServerID: "server-1")
        XCTAssertEqual(loaded?.certificateFingerprint, fingerprint)
        XCTAssertEqual(loaded?.token, "token-1")
    }

    func testSaveUpdatesEverythingElseAboutAKnownHost() async throws {
        let store = PairedHostStore(secureStore: InMemorySecureStore())
        try await store.save(makeHost())

        try await store.save(PairedHost(
            serverID: "server-1",
            serverName: "Renamed",
            endpoint: HostEndpoint(
                host: "10.0.0.9",
                port: 5151,
                certificateFingerprint: fingerprint
            ),
            clientID: "client-1",
            token: "token-2"
        ))

        let loaded = try await store.host(withServerID: "server-1")
        XCTAssertEqual(loaded?.serverName, "Renamed")
        XCTAssertEqual(loaded?.endpoint.host, "10.0.0.9")
        XCTAssertEqual(loaded?.endpoint.port, 5151)
        XCTAssertEqual(loaded?.token, "token-2")
    }

    func testInvalidatedGenerationCannotCommitAtTheSecureWriteBoundary() async throws {
        let secureStore = SaveBoundarySecureStore()
        let store = PairedHostStore(secureStore: secureStore)
        let generation = ConnectionGeneration(id: 1)
        let host = makeHost()

        secureStore.blockNextRead()
        let saveTask = Task {
            try await store.save(host, for: generation)
        }
        try await secureStore.waitUntilReadBegins()

        generation.invalidate()
        secureStore.releaseRead()

        let committed = try await saveTask.value
        let hosts = try await store.hosts()
        XCTAssertFalse(committed)
        XCTAssertEqual(hosts, [])
    }

    func testTokenRefreshDoesNotRequireRePairing() async throws {
        let store = PairedHostStore(secureStore: InMemorySecureStore())
        try await store.save(makeHost())

        try await store.updateToken("token-refreshed", forServerID: "server-1")
        try await store.updateToken("ignored", forServerID: "unknown-server")

        let loaded = try await store.host(withServerID: "server-1")
        let all = try await store.hosts()
        XCTAssertEqual(loaded?.token, "token-refreshed")
        XCTAssertEqual(loaded?.certificateFingerprint, fingerprint)
        XCTAssertEqual(all.count, 1)
    }

    func testSaveBoundarySecureStoreWaitTimesOutWhenNoReadBegins() async {
        let secureStore = SaveBoundarySecureStore()

        secureStore.blockNextRead()

        do {
            try await secureStore.waitUntilReadBegins(timeout: .milliseconds(20))
            XCTFail("Expected the bounded save-boundary read gate to time out")
        } catch let error as BoundedAsyncSignal.WaitError {
            XCTAssertEqual(error, .timedOut("paired host store secure-store read to begin"))
        } catch {
            XCTFail("Expected WaitError.timedOut, got \(error)")
        }
    }

    func testPairingStatusReportsUnpairedPairedAndRePairing() async throws {
        let store = PairedHostStore(secureStore: InMemorySecureStore())
        try await store.save(makeHost())

        let unpaired = try await store.pairingStatus(
            forServerID: "server-2",
            certificateFingerprint: fingerprint
        )
        let paired = try await store.pairingStatus(
            forServerID: "server-1",
            certificateFingerprint: fingerprint.uppercased()
        )
        let changed = try await store.pairingStatus(
            forServerID: "server-1",
            certificateFingerprint: otherFingerprint
        )
        let malformed = try await store.pairingStatus(
            forServerID: "server-1",
            certificateFingerprint: "nope"
        )

        XCTAssertEqual(unpaired, .unpaired)
        XCTAssertEqual(paired, .paired)
        XCTAssertEqual(changed, .requiresRePairing)
        XCTAssertEqual(malformed, .requiresRePairing)
    }

    func testHostsAreOrderedByServerIDAndRemovableIndividually() async throws {
        let store = PairedHostStore(secureStore: InMemorySecureStore())
        try await store.save(makeHost(serverID: "server-c"))
        try await store.save(makeHost(serverID: "server-a"))
        try await store.save(makeHost(serverID: "server-b"))

        try await store.remove(serverID: "server-b")
        try await store.remove(serverID: "server-unknown")

        let all = try await store.hosts()
        XCTAssertEqual(all.map(\.serverID), ["server-a", "server-c"])
    }

    func testCorruptedBlobSurfacesRepairGuidance() async {
        let secureStore = InMemorySecureStore()
        try? secureStore.set(Data("not json".utf8), forKey: PairedHostStore.defaultKey)
        let store = PairedHostStore(secureStore: secureStore)

        do {
            _ = try await store.hosts()
            XCTFail("Expected a corrupted record to be reported")
        } catch {
            XCTAssertEqual(error as? PairedHostStoreError, .corruptedRecord)
            XCTAssertTrue(error.localizedDescription.localizedCaseInsensitiveContains("re-pair"))
        }
    }

    func testKeychainStoreUsesAfterFirstUnlockThisDeviceOnly() {
        let attributes = KeychainSecureStore.insertAttributes(
            service: "service",
            account: "account",
            data: Data([1])
        )
        let updates = KeychainSecureStore.updateAttributes(data: Data([1]))

        XCTAssertEqual(
            attributes[kSecAttrAccessible as String] as! CFString,
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        )
        XCTAssertEqual(
            updates[kSecAttrAccessible as String] as! CFString,
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        )
        XCTAssertEqual(attributes[kSecClass as String] as! CFString, kSecClassGenericPassword)
        XCTAssertEqual(attributes[kSecAttrService as String] as? String, "service")
        XCTAssertEqual(attributes[kSecAttrAccount as String] as? String, "account")
    }

    func testKeychainLookupQueryDoesNotLeakTheSecret() {
        let query = KeychainSecureStore.lookupQuery(service: "service", account: "account")

        XCTAssertNil(query[kSecValueData as String])
        XCTAssertEqual(query[kSecAttrService as String] as? String, "service")
    }

    private func makeHost(
        serverID: String = "server-1",
        fingerprint: String? = nil,
        token: String? = "token-1"
    ) -> PairedHost {
        PairedHost(
            serverID: serverID,
            serverName: "Studio",
            endpoint: HostEndpoint(
                host: "psyche.local",
                port: 4242,
                certificateFingerprint: fingerprint ?? self.fingerprint
            ),
            clientID: "client-1",
            token: token
        )
    }
}

private final class SaveBoundarySecureStore: SecureStore, @unchecked Sendable {
    private let condition = NSCondition()
    private let readBeganSignal = BoundedAsyncSignal()
    private var storage: [String: Data] = [:]
    private var shouldBlockNextRead = false
    private var readReleased = false

    func blockNextRead() {
        readBeganSignal.reset()
        condition.withLock {
            shouldBlockNextRead = true
            readReleased = false
        }
    }

    func waitUntilReadBegins(timeout: Duration = .milliseconds(250)) async throws {
        try await readBeganSignal.wait(
            for: "paired host store secure-store read to begin",
            timeout: timeout
        )
    }

    func releaseRead() {
        condition.withLock {
            readReleased = true
            condition.broadcast()
        }
    }

    func data(forKey key: String) throws -> Data? {
        condition.lock()
        if shouldBlockNextRead {
            shouldBlockNextRead = false
            condition.unlock()
            readBeganSignal.signal()
            condition.lock()
            while !readReleased {
                condition.wait()
            }
        }
        let data = storage[key]
        condition.unlock()
        return data
    }

    func set(_ data: Data, forKey key: String) throws {
        condition.withLock {
            storage[key] = data
        }
    }

    func removeValue(forKey key: String) throws {
        _ = condition.withLock {
            storage.removeValue(forKey: key)
        }
    }
}

private extension String {
    func chunked(every size: Int) -> [Substring] {
        stride(from: 0, to: count, by: size).map { offset in
            let start = index(startIndex, offsetBy: offset)
            let end = index(start, offsetBy: size, limitedBy: endIndex) ?? endIndex
            return self[start..<end]
        }
    }
}

// MARK: - Host readiness (issue #241, slice 1)

/// Deterministic in-memory record of every boundary call a readiness flow
/// made, with configurable failures per boundary. A lock-guarded class keeps
/// every test deterministic — no actor hops, no scheduling.
private final class ReadinessBoundaryRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var callLog: [String] = []
    private var commitFailure: (any Error)?
    private var validationFailure: (any Error)?
    private var applyFailure: (any Error)?

    var calls: [String] {
        lock.withLock { callLog }
    }

    func setCommitFailure(_ error: (any Error)?) {
        lock.withLock { commitFailure = error }
    }

    func setValidationFailure(_ error: (any Error)?) {
        lock.withLock { validationFailure = error }
    }

    func setApplyFailure(_ error: (any Error)?) {
        lock.withLock { applyFailure = error }
    }

    func commitHostIdentity(_ host: PairedHost) throws {
        lock.withLock { callLog.append("commit:\(host.serverID)") }
        if let commitFailure {
            throw commitFailure
        }
    }

    func validateSnapshot(_ candidate: HostReadinessSnapshotCandidate) throws {
        lock.withLock { callLog.append("validate:\(candidate.sequence)") }
        if let validationFailure {
            throw validationFailure
        }
    }

    func applyWorkspace(_ candidate: HostReadinessSnapshotCandidate) throws {
        lock.withLock { callLog.append("apply:\(candidate.sequence)") }
        if let applyFailure {
            throw applyFailure
        }
    }
}

private enum ReadinessBoundaryError: Error, Equatable {
    case commitFailed
    case validationFailed
    case applyFailed
}

/// Exhaustive coverage of the pure transition table: every allowed transition
/// is asserted, plus the rejections that prove an out-of-place event changes
/// nothing.
final class HostReadinessTransitionsTests: XCTestCase {
    func testStateRawValuesMatchTheIssueContract() {
        // The raw values are the contract's stable state names; the order is
        // the delivery order of the readiness spine.
        XCTAssertEqual(
            HostReadinessState.allCases.map(\.rawValue),
            [
                "unknown",
                "discovering",
                "pairing",
                "authenticating",
                "host_committed",
                "synchronizing",
                "ready",
                "degraded",
                "reconnecting",
                "revoked"
            ]
        )
    }

    func testTheReadinessSpineAdvancesOneStateAtATime() {
        // The spine `pairing → authenticating → host_committed →
        // synchronizing → ready` is the atomic sequence: authority is durably
        // committed before any snapshot may be applied, and `ready` is only
        // reachable through an accepted snapshot.
        XCTAssertEqual(
            HostReadinessTransitions.destination(for: .discoveryStarted, from: .unknown),
            .discovering
        )
        XCTAssertEqual(
            HostReadinessTransitions.destination(for: .pairingStarted, from: .discovering),
            .pairing
        )
        XCTAssertEqual(
            HostReadinessTransitions.destination(for: .authenticationStarted, from: .pairing),
            .authenticating
        )
        XCTAssertEqual(
            HostReadinessTransitions.destination(for: .hostCommitSucceeded, from: .authenticating),
            .hostCommitted
        )
        XCTAssertEqual(
            HostReadinessTransitions.destination(for: .synchronizationStarted, from: .hostCommitted),
            .synchronizing
        )
        XCTAssertEqual(
            HostReadinessTransitions.destination(for: .workspaceAccepted, from: .synchronizing),
            .ready
        )
    }

    func testReconnectionAndRecoveryTransitions() {
        XCTAssertEqual(
            HostReadinessTransitions.destination(for: .reconnectionStarted, from: .unknown),
            .reconnecting
        )
        XCTAssertEqual(
            HostReadinessTransitions.destination(for: .reconnectionStarted, from: .degraded),
            .reconnecting
        )
        XCTAssertEqual(
            HostReadinessTransitions.destination(for: .reconnectionStarted, from: .ready),
            .reconnecting
        )
        XCTAssertEqual(
            HostReadinessTransitions.destination(for: .reconnectionStarted, from: .reconnecting),
            .reconnecting,
            "retrying a stored-host reconnection replaces the abandoned attempt"
        )
        XCTAssertEqual(
            HostReadinessTransitions.destination(for: .discoveryStarted, from: .reconnecting),
            .discovering
        )
        XCTAssertEqual(
            HostReadinessTransitions.destination(for: .discoveryStarted, from: .degraded),
            .discovering
        )
        XCTAssertEqual(
            HostReadinessTransitions.destination(for: .discoveryStarted, from: .revoked),
            .discovering,
            "the explicit re-pair path is the way out of revocation"
        )
        XCTAssertEqual(
            HostReadinessTransitions.destination(for: .connectionLost, from: .ready),
            .reconnecting
        )
    }

    func testRejectedTransitionsChangeNothing() {
        // Events from states their spine step does not belong to are rejected.
        XCTAssertNil(
            HostReadinessTransitions.destination(for: .workspaceAccepted, from: .hostCommitted)
        )
        XCTAssertNil(
            HostReadinessTransitions.destination(for: .synchronizationStarted, from: .authenticating)
        )
        XCTAssertNil(
            HostReadinessTransitions.destination(for: .hostCommitSucceeded, from: .synchronizing)
        )
        XCTAssertNil(
            HostReadinessTransitions.destination(for: .connectionLost, from: .synchronizing)
        )
        XCTAssertNil(
            HostReadinessTransitions.destination(for: .discoveryStarted, from: .ready)
        )
        XCTAssertNil(
            HostReadinessTransitions.destination(for: .pairingStarted, from: .ready)
        )
        XCTAssertNil(
            HostReadinessTransitions.destination(for: .reconnectionStarted, from: .revoked),
            "revoked credentials cannot reconnect; recovery is discovery and re-pair"
        )
        XCTAssertNil(
            HostReadinessTransitions.destination(for: .authenticationStarted, from: .discovering)
        )
    }

    func testEveryFailureBoundaryHasADeterministicDestination() {
        // In-flow failures with previous authority preserve it: transport
        // loss aims back at the committed host, everything else degrades.
        let flowStates: [HostReadinessState] = [
            .pairing, .authenticating, .hostCommitted, .synchronizing
        ]
        for state in flowStates {
            XCTAssertEqual(
                HostReadinessTransitions.destination(
                    forFailure: .transport,
                    from: state,
                    hasCommittedHost: true
                ),
                .reconnecting,
                "transport failure from \(state.rawValue) must aim at the committed host"
            )
            XCTAssertEqual(
                HostReadinessTransitions.destination(
                    forFailure: .transport,
                    from: state,
                    hasCommittedHost: false
                ),
                .unknown,
                "transport failure with no authority from \(state.rawValue) must report unknown"
            )
            for boundary: HostReadinessFailureBoundary in [
                .authentication, .secureStore, .decodeRevision, .workspaceApply
            ] {
                XCTAssertEqual(
                    HostReadinessTransitions.destination(
                        forFailure: boundary,
                        from: state,
                        hasCommittedHost: true
                    ),
                    .degraded,
                    "\(boundary.rawValue) failure from \(state.rawValue) must degrade with stale state preserved"
                )
                XCTAssertEqual(
                    HostReadinessTransitions.destination(
                        forFailure: boundary,
                        from: state,
                        hasCommittedHost: false
                    ),
                    .unknown,
                    "\(boundary.rawValue) failure for a first host must report unknown"
                )
            }
            XCTAssertEqual(
                HostReadinessTransitions.destination(
                    forFailure: .revocation,
                    from: state,
                    hasCommittedHost: true
                ),
                .revoked
            )
        }

        // A reconnection that cannot reach the stored host stops retrying and
        // degrades instead of looping.
        XCTAssertEqual(
            HostReadinessTransitions.destination(
                forFailure: .transport,
                from: .reconnecting,
                hasCommittedHost: true
            ),
            .degraded
        )
        // Transport loss on a live connection is `connectionLost`, not a
        // `.failed(.transport)` event.
        XCTAssertNil(
            HostReadinessTransitions.destination(
                forFailure: .transport,
                from: .ready,
                hasCommittedHost: true
            )
        )
    }

    func testRevocationFailsClosedFromEveryRestingAndFlowState() {
        for state in HostReadinessState.allCases {
            XCTAssertEqual(
                HostReadinessTransitions.destination(
                    forFailure: .revocation,
                    from: state,
                    hasCommittedHost: state == .ready || state == .revoked
                ),
                .revoked,
                "revocation must fail closed from \(state.rawValue)"
            )
        }
    }
}

/// Behavioral coverage of the machine: the atomic commit-before-apply
/// sequence, every rollback boundary, stale-state preservation, and the
/// single-flight concurrency guard.
final class HostReadinessMachineTests: XCTestCase {
    private let fixedDate = Date(timeIntervalSinceReferenceDate: 762_543_210)

    private func makeHost(serverID: String, clientID: String = "client-1") -> PairedHost {
        PairedHost(
            serverID: serverID,
            serverName: serverID == "new-host" ? "New Host" : "Studio",
            endpoint: HostEndpoint(
                host: "\(serverID).local",
                port: 4242,
                certificateFingerprint: String(repeating: "a", count: 64)
            ),
            clientID: clientID,
            token: "token-1"
        )
    }

    private func makeCandidate(sequence: UInt64) -> HostReadinessSnapshotCandidate {
        HostReadinessSnapshotCandidate(
            workspace: WorkspaceSnapshot(revision: 3, projects: []),
            sequence: sequence
        )
    }

    private func makeMachine(
        committedHost: PairedHost? = nil,
        recorder: ReadinessBoundaryRecorder
    ) -> HostReadinessMachine {
        HostReadinessMachine(
            committedHost: committedHost,
            adapters: HostReadinessAdapters(
                commitHostIdentity: { host in
                    try recorder.commitHostIdentity(host)
                },
                validateSnapshot: { candidate in
                    try recorder.validateSnapshot(candidate)
                },
                applyWorkspace: { candidate in
                    try recorder.applyWorkspace(candidate)
                }
            ),
            now: { Date(timeIntervalSinceReferenceDate: 762_543_210) }
        )
    }

    /// Drives a full successful pairing to `ready`, so tests that need a
    /// previously authoritative host have something real on screen.
    private func driveToReady(
        _ machine: HostReadinessMachine,
        recorder: ReadinessBoundaryRecorder,
        host: PairedHost,
        sequence: UInt64 = 7
    ) async throws -> HostReadinessFlow {
        _ = try await machine.beginDiscovery()
        let flow = try await machine.beginPairing(expectedServerID: host.serverID)
        _ = try await machine.markAuthenticated(for: flow)
        try await machine.commitHostIdentity(host, for: flow)
        try await machine.synchronizeWorkspace(
            makeCandidate(sequence: sequence),
            for: flow
        )
        return flow
    }

    func testHappyPathCommitsTheHostBeforeApplyingTheWorkspace() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)
        let host = makeHost(serverID: "new-host")

        try await driveToReady(machine, recorder: recorder, host: host)

        let state = await machine.state
        let presentation = await machine.presentation
        let committed = await machine.committedHost
        let failure = await machine.lastFailure
        XCTAssertEqual(
            recorder.calls,
            ["commit:new-host", "validate:7", "apply:7"],
            "the secure-store commit must precede validation and the workspace apply"
        )
        XCTAssertEqual(state, .ready)
        XCTAssertEqual(presentation, .live(hostID: "new-host", confirmedAt: fixedDate))
        XCTAssertEqual(committed, host)
        XCTAssertNil(await machine.lastFailure)
    }

    func testReconnectionFromAStoredHostReachesReadyThroughTheSameSpine() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let host = makeHost(serverID: "old-host", clientID: "client-old")
        let machine = makeMachine(committedHost: host, recorder: recorder)

        let flow = try await machine.beginReconnection()
        _ = try await machine.markAuthenticated(for: flow)
        try await machine.commitHostIdentity(host, for: flow)
        try await machine.synchronizeWorkspace(makeCandidate(sequence: 7), for: flow)

        let state = await machine.state
        XCTAssertEqual(state, .ready)
        XCTAssertEqual(recorder.calls, ["commit:old-host", "validate:7", "apply:7"])
        let presentation = await machine.presentation
        XCTAssertEqual(presentation, .live(hostID: "old-host", confirmedAt: fixedDate))
    }

    func testASecureStoreFailureNeverLeavesTheNewWorkspaceApplied() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)
        let oldHost = makeHost(serverID: "old-host", clientID: "client-old")
        try await driveToReady(machine, recorder: recorder, host: oldHost, sequence: 5)

        // A live workspace from the previously authoritative host exists.
        let livePresentation = await machine.presentation
        XCTAssertEqual(livePresentation, .live(hostID: "old-host", confirmedAt: fixedDate))

        recorder.setCommitFailure(ReadinessBoundaryError.commitFailed)
        let flow = try await machine.beginPairing(expectedServerID: "new-host")
        _ = try await machine.markAuthenticated(for: flow)

        do {
            try await machine.commitHostIdentity(makeHost(serverID: "new-host"), for: flow)
            XCTFail("Expected the secure-store boundary to fail the flow")
        } catch {
            // The original secure-store error surfaces to the caller.
        }

        let state = await machine.state
        let presentation = await machine.presentation
        let committed = await machine.committedHost
        let failure = await machine.lastFailure
        XCTAssertEqual(state, .degraded)
        XCTAssertEqual(
            presentation,
            .stale(hostID: "old-host", confirmedAt: fixedDate),
            "the previously authoritative workspace must survive, clearly stale"
        )
        XCTAssertEqual(committed, oldHost, "committed authority must survive the rollback")
        XCTAssertEqual(failure?.boundary, .secureStore)
        XCTAssertEqual(
            recorder.calls,
            ["commit:old-host", "validate:5", "apply:5", "commit:new-host"],
            "no snapshot may be applied after a failed commit"
        )
    }

    func testASecureStoreFailureForAFirstHostLeavesNoWorkspaceState() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)

        let flow = try await machine.beginPairing(expectedServerID: "new-host")
        _ = try await machine.markAuthenticated(for: flow)
        recorder.setCommitFailure(ReadinessBoundaryError.commitFailed)

        do {
            try await machine.commitHostIdentity(makeHost(serverID: "new-host"), for: flow)
            XCTFail("Expected the secure-store boundary to fail the flow")
        } catch {
            // Expected.
        }

        let state = await machine.state
        let presentation = await machine.presentation
        let committed = await machine.committedHost
        XCTAssertEqual(state, .unknown, "a failed first host leaves nothing authoritative")
        XCTAssertEqual(presentation, .noState, "a failed new host must not show any state")
        XCTAssertNil(committed)
        XCTAssertEqual(recorder.calls, ["commit:new-host"])
    }

    func testADecodeRevisionFailureRejectsTheSnapshotBeforeItIsApplied() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)
        let oldHost = makeHost(serverID: "old-host", clientID: "client-old")
        try await driveToReady(machine, recorder: recorder, host: oldHost, sequence: 5)

        recorder.setValidationFailure(ReadinessBoundaryError.validationFailed)
        let flow = try await machine.beginPairing(expectedServerID: "new-host")
        _ = try await machine.markAuthenticated(for: flow)
        try await machine.commitHostIdentity(makeHost(serverID: "new-host"), for: flow)

        do {
            try await machine.synchronizeWorkspace(makeCandidate(sequence: 7), for: flow)
            XCTFail("Expected the decode/revision boundary to reject the snapshot")
        } catch {
            // Expected.
        }

        let state = await machine.state
        let presentation = await machine.presentation
        XCTAssertEqual(state, .degraded)
        XCTAssertEqual(
            recorder.calls,
            ["commit:old-host", "validate:5", "apply:5", "commit:new-host", "validate:7"],
            "the workspace apply must never run after validation rejects the snapshot"
        )
        XCTAssertEqual(presentation, .stale(hostID: "old-host", confirmedAt: fixedDate))
    }

    func testAWorkspaceApplyFailureRollsBackWithoutASuccessShapedWorkspace() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)
        let oldHost = makeHost(serverID: "old-host", clientID: "client-old")
        try await driveToReady(machine, recorder: recorder, host: oldHost, sequence: 5)

        let flow = try await machine.beginPairing(expectedServerID: "new-host")
        _ = try await machine.markAuthenticated(for: flow)
        try await machine.commitHostIdentity(makeHost(serverID: "new-host"), for: flow)

        recorder.setApplyFailure(ReadinessBoundaryError.applyFailed)
        do {
            try await machine.synchronizeWorkspace(makeCandidate(sequence: 7), for: flow)
            XCTFail("Expected the workspace-apply boundary to fail the flow")
        } catch {
            // Expected.
        }

        let state = await machine.state
        let presentation = await machine.presentation
        XCTAssertEqual(state, .degraded)
        XCTAssertEqual(presentation, .stale(hostID: "old-host", confirmedAt: fixedDate))
        let committed = await machine.committedHost
        XCTAssertEqual(committed?.serverID, "new-host", "the commit succeeded, so authority moved")
        XCTAssertEqual(
            recorder.calls,
            ["commit:new-host", "validate:7", "apply:7"],
            "the apply ran but its failure must not leave a success-shaped workspace"
        )
    }

    func testATransportFailureDuringSynchronizationRollsBackToReconnecting() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)
        let oldHost = makeHost(serverID: "old-host", clientID: "client-old")
        try await driveToReady(machine, recorder: recorder, host: oldHost, sequence: 5)

        let flow = try await machine.beginPairing(expectedServerID: "new-host")
        _ = try await machine.markAuthenticated(for: flow)
        try await machine.commitHostIdentity(makeHost(serverID: "new-host"), for: flow)
        _ = try await machine.fail(.transport, reason: "Connection lost", for: flow)

        let state = await machine.state
        let presentation = await machine.presentation
        XCTAssertEqual(state, .reconnecting)
        XCTAssertEqual(presentation, .stale(hostID: "old-host", confirmedAt: fixedDate))
        XCTAssertFalse(recorder.calls.contains("apply:7"))
    }

    func testAnAuthenticationFailurePreservesThePreviousStaleState() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)
        let oldHost = makeHost(serverID: "old-host", clientID: "client-old")
        try await driveToReady(machine, recorder: recorder, host: oldHost, sequence: 5)

        let flow = try await machine.beginPairing(expectedServerID: "new-host")
        _ = try await machine.fail(.authentication, reason: "Pairing rejected", for: flow)

        let state = await machine.state
        let presentation = await machine.presentation
        let failure = await machine.lastFailure
        XCTAssertEqual(state, .degraded)
        XCTAssertEqual(presentation, .stale(hostID: "old-host", confirmedAt: fixedDate))
        XCTAssertEqual(failure?.boundary, .authentication)
        XCTAssertEqual(failure?.reason, "Pairing rejected")
        XCTAssertEqual(failure?.stateAtFailure, .pairing)
    }

    func testAConnectionLostRelabelsALiveWorkspaceStaleAndAimsAtTheStoredHost() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)
        try await driveToReady(
            machine,
            recorder: recorder,
            host: makeHost(serverID: "old-host", clientID: "client-old")
        )

        _ = try await machine.noteConnectionLost()

        let state = await machine.state
        let presentation = await machine.presentation
        XCTAssertEqual(state, .reconnecting)
        XCTAssertEqual(presentation, .stale(hostID: "old-host", confirmedAt: fixedDate))
        let committed = await machine.committedHost
        XCTAssertEqual(committed, makeHost(serverID: "old-host", clientID: "client-old"))
    }

    func testAWrongHostIdentityAtTheCommitBoundaryFailsClosed() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)
        let oldHost = makeHost(serverID: "old-host", clientID: "client-old")
        try await driveToReady(machine, recorder: recorder, host: oldHost, sequence: 5)

        let flow = try await machine.beginReconnection()
        _ = try await machine.markAuthenticated(for: flow)

        do {
            try await machine.commitHostIdentity(
                makeHost(serverID: "impostor", clientID: "client-9"),
                for: flow
            )
            XCTFail("A wrong-host identity must fail closed")
        } catch let error as HostReadinessError {
            XCTAssertEqual(
                error,
                .wrongHostIdentity(expected: "old-host", actual: "impostor")
            )
        }

        let state = await machine.state
        let committed = await machine.committedHost
        let failure = await machine.lastFailure
        XCTAssertEqual(state, .revoked)
        XCTAssertEqual(committed, oldHost, "committed authority must not be overwritten")
        XCTAssertEqual(
            await machine.presentation,
            .stale(hostID: "old-host", confirmedAt: fixedDate)
        )
        XCTAssertEqual(recorder.calls, [], "a wrong-host commit must never reach the secure store")
        XCTAssertEqual(failure?.boundary, .revocation)
    }

    func testASupersededFlowCannotCommitOrApplyAnything() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)
        let oldHost = makeHost(serverID: "old-host", clientID: "client-old")
        try await driveToReady(machine, recorder: recorder, host: oldHost, sequence: 5)

        let superseded = try await machine.beginPairing(expectedServerID: "new-host")
        _ = try await machine.markAuthenticated(for: superseded)
        try await machine.commitHostIdentity(
            makeHost(serverID: "new-host", clientID: "client-new"),
            for: superseded
        )
        _ = try await machine.fail(.transport, reason: "Connection lost", for: superseded)

        let retry = try await machine.beginReconnection()
        XCTAssertNotEqual(retry, superseded)

        // The abandoned flow wakes up and tries to commit again.
        do {
            try await machine.commitHostIdentity(
                makeHost(serverID: "rogue-host", clientID: "client-rogue"),
                for: superseded
            )
            XCTFail("A superseded flow must not be able to commit")
        } catch let error as HostReadinessError {
            XCTAssertEqual(error, .supersededFlow)
        }
        do {
            try await machine.synchronizeWorkspace(makeCandidate(sequence: 9), for: superseded)
            XCTFail("A superseded flow must not be able to apply a snapshot")
        } catch {
            // Expected.
        }

        let state = await machine.state
        let committed = await machine.committedHost
        XCTAssertEqual(state, .reconnecting)
        XCTAssertEqual(committed, makeHost(serverID: "new-host", clientID: "client-1"))
        XCTAssertEqual(
            recorder.calls,
            ["commit:old-host", "validate:5", "apply:5", "commit:new-host"],
            "only the owning flow ever crosses the commit boundary"
        )
    }

    func testASecondFlowCannotStartWhileOneIsActive() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)

        let first = try await machine.beginPairing(expectedServerID: "first-host")
        do {
            _ = try await machine.beginPairing(expectedServerID: "second-host")
            XCTFail("A second readiness flow must be refused while one is active")
        } catch let error as HostReadinessError {
            XCTAssertEqual(error, .flowAlreadyActive(serverID: "first-host"))
        }

        // The active flow is untouched by the rejected one.
        _ = try await machine.markAuthenticated(for: first)
        let state = await machine.state
        XCTAssertEqual(state, .authenticating)
    }

    func testReconnectionRequiresACommittedHost() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)

        do {
            _ = try await machine.beginReconnection()
            XCTFail("Reconnection without committed authority must be refused")
        } catch let error as HostReadinessError {
            XCTAssertEqual(error, .committedHostRequired)
        }
    }

    func testSynchronizationRequiresACommittedHost() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)

        let flow = try await machine.beginPairing(expectedServerID: "new-host")
        _ = try await machine.markAuthenticated(for: flow)

        do {
            try await machine.synchronizeWorkspace(makeCandidate(sequence: 7), for: flow)
            XCTFail("Synchronization requires a committed host")
        } catch {
            // Expected: no commit, no snapshot.
        }

        XCTAssertTrue(recorder.calls.isEmpty)
    }

    func testABeginFlowRelabelsALiveWorkspaceStaleImmediately() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)
        try await driveToReady(
            machine,
            recorder: recorder,
            host: makeHost(serverID: "old-host", clientID: "client-old")
        )

        _ = try await machine.beginPairing(expectedServerID: "new-host")

        let presentation = await machine.presentation
        XCTAssertEqual(
            presentation,
            .stale(hostID: "old-host", confirmedAt: fixedDate),
            "the visible workspace cannot vouch for itself once a flow retargets the transport"
        )
    }

    func testARollbackKeepsThePreviousConfirmedAtTimestamp() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)
        try await driveToReady(
            machine,
            recorder: recorder,
            host: makeHost(serverID: "old-host", clientID: "client-old")
        )

        let flow = try await machine.beginPairing(expectedServerID: "new-host")
        _ = try await machine.markAuthenticated(for: flow)
        try await machine.commitHostIdentity(makeHost(serverID: "new-host"), for: flow)

        recorder.setApplyFailure(ReadinessBoundaryError.applyFailed)
        do {
            try await machine.synchronizeWorkspace(makeCandidate(sequence: 7), for: flow)
            XCTFail("Expected the workspace-apply boundary to fail")
        } catch {
            // Expected.
        }

        let presentation = await machine.presentation
        guard case .stale(let hostID, let confirmedAt) = presentation else {
            return XCTFail("Expected stale presentation after rollback, got \(presentation)")
        }
        XCTAssertEqual(hostID, "old-host")
        XCTAssertEqual(confirmedAt, fixedDate)
    }

    func testRevocationFailsClosedAndRecoveryGoesThroughDiscovery() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)
        let oldHost = makeHost(serverID: "old-host", clientID: "client-old")
        try await driveToReady(machine, recorder: recorder, host: oldHost)

        _ = try await machine.revoke(reason: "Token revoked")

        var state = await machine.state
        var presentation = await machine.presentation
        XCTAssertEqual(state, .revoked)
        XCTAssertEqual(presentation, .stale(hostID: "old-host", confirmedAt: fixedDate))
        let stillCommitted = await machine.committedHost
        XCTAssertEqual(committed, makeHost(serverID: "old-host", clientID: "client-old"))

        // Recovery is the explicit path: discovery, then a fresh pairing.
        _ = try await machine.beginDiscovery()
        let flow = try await machine.beginPairing(expectedServerID: "new-host")
        _ = try await machine.markAuthenticated(for: flow)
        try await machine.commitHostIdentity(makeHost(serverID: "new-host"), for: flow)
        try await machine.synchronizeWorkspace(makeCandidate(sequence: 7), for: flow)

        state = await machine.state
        presentation = await machine.presentation
        XCTAssertEqual(state, .ready)
        XCTAssertEqual(presentation, .live(hostID: "new-host", confirmedAt: fixedDate))
    }

    func testADegradedStateRecoversThroughAReconnectionFlow() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)
        let host = makeHost(serverID: "old-host", clientID: "client-old")
        try await driveToReady(machine, recorder: recorder, host: host, sequence: 5)

        // Commit the new host, then fail at the workspace-apply boundary.
        let failed = try await machine.beginPairing(expectedServerID: "new-host")
        _ = try await machine.markAuthenticated(for: failed)
        try await machine.commitHostIdentity(
            makeHost(serverID: "new-host", clientID: "client-new"),
            for: failed
        )
        recorder.setApplyFailure(ReadinessBoundaryError.applyFailed)
        do {
            try await machine.synchronizeWorkspace(makeCandidate(sequence: 7), for: failed)
            XCTFail("Expected the workspace-apply boundary to fail")
        } catch {
            // Expected.
        }
        XCTAssertEqual(await machine.state, .degraded)

        // Recovery runs the same spine against the committed authority.
        let retry = try await machine.beginReconnection()
        _ = try await machine.markAuthenticated(for: retry)
        try await machine.commitHostIdentity(
            makeHost(serverID: "new-host", clientID: "client-new"),
            for: retry
        )
        try await machine.synchronizeWorkspace(makeCandidate(sequence: 8), for: retry)

        let state = await machine.state
        XCTAssertEqual(state, .ready)
        let presentation = await machine.presentation
        XCTAssertEqual(presentation, .live(hostID: "new-host", confirmedAt: fixedDate))
    }
}
