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
        let replacementHost = makeHost(fingerprint: otherFingerprint, token: "token-2")

        secureStore.blockNextRead()
        let replacement = Task {
            try await store.replace(replacementHost, for: generation)
        }
        await secureStore.waitUntilReadBegins()
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
        await secureStore.waitUntilReadBegins()

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
    private var storage: [String: Data] = [:]
    private var shouldBlockNextRead = false
    private var readBegan = false
    private var readReleased = false
    private var readBeganWaiters: [CheckedContinuation<Void, Never>] = []

    func blockNextRead() {
        condition.withLock {
            shouldBlockNextRead = true
            readBegan = false
            readReleased = false
        }
    }

    func waitUntilReadBegins() async {
        await withCheckedContinuation { continuation in
            let shouldResume = condition.withLock {
                guard !readBegan else { return true }
                readBeganWaiters.append(continuation)
                return false
            }
            if shouldResume {
                continuation.resume()
            }
        }
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
            readBegan = true
            let waiters = readBeganWaiters
            readBeganWaiters.removeAll()
            condition.unlock()
            waiters.forEach { $0.resume() }
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
