import Foundation

public enum MobileCredentialStoreError: Error, Sendable, Equatable, LocalizedError {
    case invalidToken
    case invalidEndpoint
    case corruptedRecord

    public var errorDescription: String? {
        switch self {
        case .invalidToken:
            "The durable mobile credential is invalid. Connect again."
        case .invalidEndpoint:
            "The mobile endpoint identity is invalid. Connect again."
        case .corruptedRecord:
            "The stored mobile credential could not be read. Connect again."
        }
    }
}

/// A durable authentication result, bound to the endpoint that issued it.
/// One-time invite values are intentionally not represented here.
public struct MobileCredential: Codable, Sendable, Equatable {
    public let endpoint: HostEndpoint
    public let token: String

    public init(endpoint: HostEndpoint, token: String) {
        self.endpoint = endpoint
        self.token = token
    }
}

public actor MobileCredentialStore {
    public static let defaultKey = "mobile-credential.v1"
    public static let keychainService = "ai.opencoven.psyche-ios.mobile-credentials"

    private let secureStore: any SecureStore
    private let key: String

    public init(
        secureStore: any SecureStore,
        key: String = defaultKey
    ) {
        self.secureStore = secureStore
        self.key = key
    }

    public init(key: String = defaultKey) {
        self.init(
            secureStore: KeychainSecureStore(service: Self.keychainService),
            key: key
        )
    }

    public func save(endpoint: HostEndpoint, token: String) throws {
        let credential = try MobileCredential(endpoint: normalize(endpoint), token: token)
        guard !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw MobileCredentialStoreError.invalidToken
        }
        try secureStore.set(JSONEncoder().encode(credential), forKey: key)
    }

    public func credential(for endpoint: HostEndpoint) throws -> MobileCredential? {
        let requested = try normalize(endpoint)
        guard let data = try secureStore.data(forKey: key) else { return nil }
        let credential: MobileCredential
        do {
            credential = try JSONDecoder().decode(MobileCredential.self, from: data)
        } catch {
            throw MobileCredentialStoreError.corruptedRecord
        }
        guard Self.matches(credential.endpoint, requested) else { return nil }
        return credential
    }

    public func clear() throws {
        try secureStore.removeValue(forKey: key)
    }

    private func normalize(_ endpoint: HostEndpoint) throws -> HostEndpoint {
        let host = endpoint.host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
        guard !host.isEmpty, (1...65_535).contains(endpoint.port),
              let fingerprint = try? PinnedCertificateDelegate
                .normalizeFingerprint(endpoint.certificateFingerprint) else {
            throw MobileCredentialStoreError.invalidEndpoint
        }
        return HostEndpoint(
            host: host,
            port: endpoint.port,
            route: endpoint.route,
            certificateFingerprint: fingerprint
        )
    }

    private static func matches(_ lhs: HostEndpoint, _ rhs: HostEndpoint) -> Bool {
        lhs.host == rhs.host &&
            lhs.port == rhs.port &&
            lhs.certificateFingerprint == rhs.certificateFingerprint
    }
}
