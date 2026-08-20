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

    func testLastConnectedHostReturnsTheExactSelectedHost() async throws {
        let secureStore = InMemorySecureStore()
        let store = PairedHostStore(secureStore: secureStore)
        let hostA = makeHost(serverID: "server-a")
        let hostZ = makeHost(serverID: "server-z")

        try await store.save(hostA)
        try await store.save(hostZ)
        try await store.markLastConnected(serverID: "server-z")

        let selected = try await store.lastConnectedHost()

        XCTAssertEqual(selected, hostZ)
    }

    func testLastConnectedHostReturnsNilWhenNoSelectionExists() async throws {
        let store = PairedHostStore(secureStore: InMemorySecureStore())

        let selected = try await store.lastConnectedHost()

        XCTAssertNil(selected)
    }

    func testMarkLastConnectedRejectsUnknownHostsWithoutWritingSelection() async throws {
        let secureStore = InMemorySecureStore()
        let store = PairedHostStore(secureStore: secureStore)

        do {
            try await store.markLastConnected(serverID: "server-missing")
            XCTFail("Expected an unknown host to be rejected")
        } catch {
            XCTAssertEqual(error as? PairedHostStoreError, .unknownHost(serverID: "server-missing"))
            XCTAssertEqual(
                error.localizedDescription,
                "Choose a paired host before making it the reconnect target."
            )
        }

        XCTAssertNil(try secureStore.data(forKey: PairedHostStore.lastConnectedKey))
    }

    func testRemovingTheSelectedHostClearsTheSelection() async throws {
        let store = PairedHostStore(secureStore: InMemorySecureStore())
        try await store.save(makeHost())
        try await store.markLastConnected(serverID: "server-1")

        try await store.remove(serverID: "server-1")

        let selected = try await store.lastConnectedHost()
        XCTAssertNil(selected)
    }

    func testRemovingAnotherOrUnknownHostPreservesSelection() async throws {
        let store = PairedHostStore(secureStore: InMemorySecureStore())
        try await store.save(makeHost(serverID: "server-a"))
        try await store.save(makeHost(serverID: "server-z"))
        try await store.markLastConnected(serverID: "server-z")

        try await store.remove(serverID: "server-a")
        try await store.remove(serverID: "server-missing")

        let selected = try await store.lastConnectedHost()

        XCTAssertEqual(selected?.serverID, "server-z")
    }

    func testRemoveAllClearsPairedHostsAndLastConnectedSelection() async throws {
        let secureStore = InMemorySecureStore()
        let store = PairedHostStore(secureStore: secureStore)
        try await store.save(makeHost())
        try await store.markLastConnected(serverID: "server-1")

        try await store.removeAll()

        let hosts = try await store.hosts()
        XCTAssertEqual(hosts, [])
        XCTAssertNil(try secureStore.data(forKey: PairedHostStore.defaultKey))
        XCTAssertNil(try secureStore.data(forKey: PairedHostStore.lastConnectedKey))
    }

    func testCustomSelectionKeysKeepMarkAndLookupIsolatedAcrossStores() async throws {
        let secureStore = InMemorySecureStore()
        let keyA = "paired-hosts.alpha"
        let keyB = "paired-hosts.beta"
        let selectionKeyA = PairedHostStore.selectionKey(forStoreKey: keyA)
        let selectionKeyB = PairedHostStore.selectionKey(forStoreKey: keyB)
        let storeA = PairedHostStore(secureStore: secureStore, key: keyA)
        let storeB = PairedHostStore(secureStore: secureStore, key: keyB)
        let hostA = makeHost(serverID: "server-a")
        let hostB = makeHost(serverID: "server-b")
        let selectedAData = try JSONEncoder().encode("server-a")
        let selectedBData = try JSONEncoder().encode("server-b")

        try await storeA.save(hostA)
        try await storeB.save(hostB)

        try await storeA.markLastConnected(serverID: "server-a")

        let selectedAAfterFirstMark = try await storeA.lastConnectedHost()
        let selectedBAfterFirstMark = try await storeB.lastConnectedHost()
        XCTAssertEqual(selectedAAfterFirstMark, hostA)
        XCTAssertNil(selectedBAfterFirstMark)
        XCTAssertNil(try secureStore.data(forKey: PairedHostStore.lastConnectedKey))
        XCTAssertEqual(try secureStore.data(forKey: selectionKeyA), selectedAData)

        try await storeB.markLastConnected(serverID: "server-b")

        let selectedAAfterSecondMark = try await storeA.lastConnectedHost()
        let selectedBAfterSecondMark = try await storeB.lastConnectedHost()
        XCTAssertEqual(selectedAAfterSecondMark, hostA)
        XCTAssertEqual(selectedBAfterSecondMark, hostB)
        XCTAssertEqual(try secureStore.data(forKey: selectionKeyA), selectedAData)
        XCTAssertEqual(try secureStore.data(forKey: selectionKeyB), selectedBData)
    }

    func testCustomSelectionKeysKeepClearAndRemoveAllIsolatedAcrossStores() async throws {
        let secureStore = InMemorySecureStore()
        let keyA = "paired-hosts.alpha"
        let keyB = "paired-hosts.beta"
        let selectionKeyA = PairedHostStore.selectionKey(forStoreKey: keyA)
        let selectionKeyB = PairedHostStore.selectionKey(forStoreKey: keyB)
        let storeA = PairedHostStore(secureStore: secureStore, key: keyA)
        let storeB = PairedHostStore(secureStore: secureStore, key: keyB)
        let hostA = makeHost(serverID: "server-a")
        let hostB = makeHost(serverID: "server-b")

        try await storeA.save(hostA)
        try await storeB.save(hostB)
        try await storeA.markLastConnected(serverID: "server-a")
        try await storeB.markLastConnected(serverID: "server-b")

        try await storeA.clearLastConnectedHost()

        let selectedAAfterClear = try await storeA.lastConnectedHost()
        let selectedBAfterClear = try await storeB.lastConnectedHost()
        XCTAssertNil(selectedAAfterClear)
        XCTAssertEqual(selectedBAfterClear, hostB)

        try await storeA.markLastConnected(serverID: "server-a")
        try await storeA.removeAll()

        let hostsAAfterRemoveAll = try await storeA.hosts()
        let selectedAAfterRemoveAll = try await storeA.lastConnectedHost()
        let hostsBAfterRemoveAll = try await storeB.hosts()
        let selectedBAfterRemoveAll = try await storeB.lastConnectedHost()
        XCTAssertEqual(hostsAAfterRemoveAll, [])
        XCTAssertNil(selectedAAfterRemoveAll)
        XCTAssertEqual(hostsBAfterRemoveAll, [hostB])
        XCTAssertEqual(selectedBAfterRemoveAll, hostB)
        XCTAssertNil(try secureStore.data(forKey: keyA))
        XCTAssertNil(try secureStore.data(forKey: selectionKeyA))
        XCTAssertNotNil(try secureStore.data(forKey: keyB))
        XCTAssertNotNil(try secureStore.data(forKey: selectionKeyB))
    }

    func testCustomSelectionKeyNamespaceAvoidsPrimaryKeySuffixCollisions() async throws {
        let secureStore = InMemorySecureStore()
        let keyA = "paired-hosts.alpha"
        let keyB = "paired-hosts.alpha.last-connected"
        let selectionKeyA = PairedHostStore.selectionKey(forStoreKey: keyA)
        let storeA = PairedHostStore(secureStore: secureStore, key: keyA)
        let storeB = PairedHostStore(secureStore: secureStore, key: keyB)
        let hostA = makeHost(serverID: "server-a")
        let hostB = makeHost(serverID: "server-b")

        XCTAssertNotEqual(selectionKeyA, keyB)

        try await storeA.save(hostA)
        try await storeB.save(hostB)
        let originalStoreBRecordData = try secureStore.data(forKey: keyB)

        try await storeA.markLastConnected(serverID: "server-a")

        let selectedAAfterMark = try await storeA.lastConnectedHost()
        let hostsBAfterMark = try await storeB.hosts()
        let selectedBAfterMark = try await storeB.lastConnectedHost()

        XCTAssertEqual(try secureStore.data(forKey: keyB), originalStoreBRecordData)
        XCTAssertEqual(selectedAAfterMark, hostA)
        XCTAssertEqual(hostsBAfterMark, [hostB])
        XCTAssertNil(selectedBAfterMark)

        try await storeA.removeAll()

        let selectedAAfterRemoveAll = try await storeA.lastConnectedHost()
        let hostsBAfterRemoveAll = try await storeB.hosts()

        XCTAssertNil(selectedAAfterRemoveAll)
        XCTAssertEqual(try secureStore.data(forKey: keyB), originalStoreBRecordData)
        XCTAssertEqual(hostsBAfterRemoveAll, [hostB])
    }

    func testStaleLastConnectedSelectionIsRemovedAndReturnsNil() async throws {
        let secureStore = InMemorySecureStore()
        let store = PairedHostStore(secureStore: secureStore)
        try await store.save(makeHost(serverID: "server-a"))
        try secureStore.set(try JSONEncoder().encode("server-z"), forKey: PairedHostStore.lastConnectedKey)

        let selected = try await store.lastConnectedHost()

        XCTAssertNil(selected)
        XCTAssertNil(try secureStore.data(forKey: PairedHostStore.lastConnectedKey))
    }

    func testSuccessfulRecordSuccessfulConnectionUpdatesSelectionAndEndpointTogether() async throws {
        let store = PairedHostStore(secureStore: InMemorySecureStore())
        let generation = ConnectionGeneration(id: 1)
        let host = makeHost()
        let connectedHost = makeHost(
            host: "10.0.0.9",
            port: 5151,
            token: "token-2"
        )

        try await store.save(host)

        let committed = try await store.recordSuccessfulConnection(
            connectedHost,
            for: generation
        )

        let loaded = try await store.host(withServerID: "server-1")
        let selected = try await store.lastConnectedHost()

        XCTAssertTrue(committed)
        XCTAssertEqual(loaded?.serverName, "Studio")
        XCTAssertEqual(loaded?.endpoint.host, "10.0.0.9")
        XCTAssertEqual(loaded?.endpoint.port, 5151)
        XCTAssertEqual(loaded?.token, "token-2")
        XCTAssertEqual(selected, loaded)
    }

    func testFailedSelectionWriteRollsBackSuccessfulConnectionToExactPriorBytes() async throws {
        let secureStore = InjectedFailureSecureStore()
        let store = PairedHostStore(secureStore: secureStore)
        let generation = ConnectionGeneration(id: 1)
        let originalHost = makeHost()

        try await store.save(originalHost)

        let originalRecordData = try secureStore.data(forKey: PairedHostStore.defaultKey)
        let originalSelectionData = try secureStore.data(forKey: PairedHostStore.lastConnectedKey)
        XCTAssertNil(originalSelectionData)

        secureStore.failNextSet(
            forKey: PairedHostStore.lastConnectedKey,
            error: .selectionWriteFailed
        )

        do {
            _ = try await store.recordSuccessfulConnection(
                makeHost(host: "10.0.0.9", port: 5151, token: "token-2"),
                for: generation
            )
            XCTFail("Expected the selection write to fail")
        } catch {
            XCTAssertEqual(error as? InjectedSecureStoreFailure, .selectionWriteFailed)
        }

        XCTAssertEqual(try secureStore.data(forKey: PairedHostStore.defaultKey), originalRecordData)
        XCTAssertEqual(
            try secureStore.data(forKey: PairedHostStore.lastConnectedKey),
            originalSelectionData
        )
        let loaded = try await store.host(withServerID: "server-1")
        let selected = try await store.lastConnectedHost()
        XCTAssertEqual(loaded, originalHost)
        XCTAssertNil(selected)
    }

    func testRemovingSelectedHostRollsBackToExactPriorBytesWhenSelectionClearFails() async throws {
        let secureStore = InjectedFailureSecureStore()
        let store = PairedHostStore(secureStore: secureStore)
        let originalHost = makeHost()
        let otherHost = makeHost(serverID: "server-z")

        try await store.save(originalHost)
        try await store.save(otherHost)
        try await store.markLastConnected(serverID: "server-1")

        let originalRecordData = try secureStore.data(forKey: PairedHostStore.defaultKey)
        let originalSelectionData = try secureStore.data(forKey: PairedHostStore.lastConnectedKey)

        secureStore.failNextRemove(
            forKey: PairedHostStore.lastConnectedKey,
            error: .selectionRemoveFailed
        )

        do {
            try await store.remove(serverID: "server-1")
            XCTFail("Expected clearing the selected host to fail")
        } catch {
            XCTAssertEqual(error as? InjectedSecureStoreFailure, .selectionRemoveFailed)
        }

        XCTAssertEqual(try secureStore.data(forKey: PairedHostStore.defaultKey), originalRecordData)
        XCTAssertEqual(
            try secureStore.data(forKey: PairedHostStore.lastConnectedKey),
            originalSelectionData
        )
        let restoredOriginalHost = try await store.host(withServerID: "server-1")
        let restoredOtherHost = try await store.host(withServerID: "server-z")
        let restoredSelection = try await store.lastConnectedHost()
        XCTAssertEqual(restoredOriginalHost, originalHost)
        XCTAssertEqual(restoredOtherHost, otherHost)
        XCTAssertEqual(restoredSelection, originalHost)
    }

    func testRemoveAllRollsBackToExactPriorBytesWhenSelectionRemovalFails() async throws {
        let secureStore = InjectedFailureSecureStore()
        let store = PairedHostStore(secureStore: secureStore)
        let originalHost = makeHost()

        try await store.save(originalHost)
        try await store.markLastConnected(serverID: "server-1")

        let originalRecordData = try secureStore.data(forKey: PairedHostStore.defaultKey)
        let originalSelectionData = try secureStore.data(forKey: PairedHostStore.lastConnectedKey)

        secureStore.failNextRemove(
            forKey: PairedHostStore.lastConnectedKey,
            error: .selectionRemoveFailed
        )

        do {
            try await store.removeAll()
            XCTFail("Expected the selection removal to fail")
        } catch {
            XCTAssertEqual(error as? InjectedSecureStoreFailure, .selectionRemoveFailed)
        }

        XCTAssertEqual(try secureStore.data(forKey: PairedHostStore.defaultKey), originalRecordData)
        XCTAssertEqual(
            try secureStore.data(forKey: PairedHostStore.lastConnectedKey),
            originalSelectionData
        )
        let restoredHosts = try await store.hosts()
        let restoredSelection = try await store.lastConnectedHost()
        XCTAssertEqual(restoredHosts, [originalHost])
        XCTAssertEqual(restoredSelection, originalHost)
    }

    func testInvalidatedRecordSuccessfulConnectionLeavesHostAndSelectionUntouched() async throws {
        let secureStore = SaveBoundarySecureStore()
        let store = PairedHostStore(secureStore: secureStore)
        let generation = ConnectionGeneration(id: 1)
        let originalHost = makeHost(serverID: "server-1")
        let otherHost = makeHost(serverID: "server-z")
        let updatedHost = makeHost(
            host: "10.0.0.9",
            port: 5151,
            token: "token-2"
        )

        try await store.save(originalHost)
        try await store.save(otherHost)
        try await store.markLastConnected(serverID: "server-z")

        secureStore.blockNextRead()
        let commit = Task {
            try await store.recordSuccessfulConnection(updatedHost, for: generation)
        }
        try await secureStore.waitUntilReadBegins()
        generation.invalidate()
        secureStore.releaseRead()

        let committed = try await commit.value
        let loaded = try await store.host(withServerID: "server-1")
        let selected = try await store.lastConnectedHost()

        XCTAssertFalse(committed)
        XCTAssertEqual(loaded, originalHost)
        XCTAssertEqual(selected, otherHost)
    }

    func testChangedFingerprintDuringSuccessfulConnectionFinalizationThrowsAndPreservesData() async throws {
        let secureStore = InMemorySecureStore()
        let store = PairedHostStore(secureStore: secureStore)
        let generation = ConnectionGeneration(id: 1)
        let originalHost = makeHost(serverID: "server-1")
        let otherHost = makeHost(serverID: "server-z")

        try await store.save(originalHost)
        try await store.save(otherHost)
        try await store.markLastConnected(serverID: "server-z")

        do {
            _ = try await store.recordSuccessfulConnection(
                makeHost(
                    serverID: "server-1",
                    fingerprint: otherFingerprint,
                    host: "10.0.0.9",
                    port: 5151,
                    token: "token-2"
                ),
                for: generation
            )
            XCTFail("Expected a changed fingerprint to be rejected")
        } catch {
            XCTAssertEqual(error as? PairedHostStoreError, .identityChanged(serverID: "server-1"))
            XCTAssertTrue(error.localizedDescription.localizedCaseInsensitiveContains("re-pair"))
        }

        let loaded = try await store.host(withServerID: "server-1")
        let selected = try await store.lastConnectedHost()

        XCTAssertEqual(loaded, originalHost)
        XCTAssertEqual(selected, otherHost)
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
        host: String = "psyche.local",
        port: Int = 4242,
        token: String? = "token-1"
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
}

private enum InjectedSecureStoreFailure: Error, Equatable {
    case selectionWriteFailed
    case selectionRemoveFailed
}

private final class InjectedFailureSecureStore: SecureStore, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String: Data] = [:]
    private var nextSetFailures: [String: InjectedSecureStoreFailure] = [:]
    private var nextRemoveFailures: [String: InjectedSecureStoreFailure] = [:]

    func failNextSet(forKey key: String, error: InjectedSecureStoreFailure) {
        lock.withLock {
            nextSetFailures[key] = error
        }
    }

    func failNextRemove(forKey key: String, error: InjectedSecureStoreFailure) {
        lock.withLock {
            nextRemoveFailures[key] = error
        }
    }

    func data(forKey key: String) throws -> Data? {
        lock.withLock { storage[key] }
    }

    func set(_ data: Data, forKey key: String) throws {
        if let error = lock.withLock({ nextSetFailures.removeValue(forKey: key) }) {
            throw error
        }
        lock.withLock {
            storage[key] = data
        }
    }

    func removeValue(forKey key: String) throws {
        if let error = lock.withLock({ nextRemoveFailures.removeValue(forKey: key) }) {
            throw error
        }
        _ = lock.withLock {
            storage.removeValue(forKey: key)
        }
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
