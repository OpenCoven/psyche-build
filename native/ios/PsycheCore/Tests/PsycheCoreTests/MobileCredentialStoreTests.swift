import Foundation
import Security
import XCTest
@testable import PsycheCore

final class MobileCredentialStoreTests: XCTestCase {
    private let fingerprint = "0c8893630b087f7ab19a71c016e599cebc3b5235fd449e9917a43850edddaa38"

    func testPersistsCredentialThroughAFreshStore() async throws {
        let secureStore = InMemorySecureStore()
        let endpoint = makeEndpoint()
        let store = MobileCredentialStore(secureStore: secureStore)

        try await store.save(endpoint: endpoint, token: "durable-token")

        let reopened = MobileCredentialStore(secureStore: secureStore)
        let credential = try await reopened.credential(for: endpoint)
        XCTAssertEqual(credential?.endpoint, endpoint)
        XCTAssertEqual(credential?.token, "durable-token")
    }

    func testDoesNotReturnCredentialToADifferentEndpointIdentity() async throws {
        let store = MobileCredentialStore(secureStore: InMemorySecureStore())
        try await store.save(endpoint: makeEndpoint(), token: "durable-token")

        let wrongHost = try await store.credential(for: makeEndpoint(host: "other.example"))
        let wrongPort = try await store.credential(for: makeEndpoint(port: 4343))
        let wrongCertificate = try await store.credential(
            for: makeEndpoint(fingerprint: String(repeating: "b", count: 64))
        )
        XCTAssertNil(wrongHost)
        XCTAssertNil(wrongPort)
        XCTAssertNil(wrongCertificate)
    }

    func testMatchesOnlyTheNormalizedHostPortAndCertificateIdentity() async throws {
        let store = MobileCredentialStore(secureStore: InMemorySecureStore())
        try await store.save(endpoint: makeEndpoint(), token: "durable-token")

        let equivalent = HostEndpoint(
            host: "STUDIO.EXAMPLE.",
            port: 4242,
            route: .relay,
            certificateFingerprint: fingerprint.uppercased()
        )

        let credential = try await store.credential(for: equivalent)
        XCTAssertEqual(credential?.token, "durable-token")
    }

    func testClearRemovesPersistedCredential() async throws {
        let secureStore = InMemorySecureStore()
        let endpoint = makeEndpoint()
        let store = MobileCredentialStore(secureStore: secureStore)
        try await store.save(endpoint: endpoint, token: "durable-token")

        try await store.clear()

        let credential = try await store.credential(for: endpoint)
        XCTAssertNil(credential)
        XCTAssertNil(try secureStore.data(forKey: MobileCredentialStore.defaultKey))
    }

    func testPersistsOnlyDurableCredentialFields() async throws {
        let secureStore = InMemorySecureStore()
        let store = MobileCredentialStore(secureStore: secureStore)
        try await store.save(endpoint: makeEndpoint(), token: "durable-token")

        let data = try XCTUnwrap(secureStore.data(forKey: MobileCredentialStore.defaultKey))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["endpoint", "token"])
        XCTAssertFalse(data.contains(Data("psyche_invite".utf8)))
        XCTAssertFalse(data.contains(Data("one-time".utf8)))
    }

    func testProductionKeychainUsesDeviceOnlyAfterFirstUnlock() {
        let attributes = KeychainSecureStore.insertAttributes(
            service: MobileCredentialStore.keychainService,
            account: MobileCredentialStore.defaultKey,
            data: Data([1])
        )

        XCTAssertEqual(attributes[kSecAttrService as String] as? String, MobileCredentialStore.keychainService)
        XCTAssertEqual(
            attributes[kSecAttrAccessible as String] as! CFString,
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        )
    }

    private func makeEndpoint(
        host: String = "studio.example",
        port: Int = 4242,
        fingerprint: String? = nil
    ) -> HostEndpoint {
        HostEndpoint(
            host: host,
            port: port,
            certificateFingerprint: fingerprint ?? self.fingerprint
        )
    }
}
