import Foundation
import Security

/// The blob store behind `PairedHostStore`. Kept this narrow so tests can run
/// the real store logic against memory instead of a simulator keychain.
public protocol SecureStore: Sendable {
    func data(forKey key: String) throws -> Data?
    func set(_ data: Data, forKey key: String) throws
    func removeValue(forKey key: String) throws
}

public final class InMemorySecureStore: SecureStore, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String: Data]

    public init(storage: [String: Data] = [:]) {
        self.storage = storage
    }

    public func data(forKey key: String) throws -> Data? {
        lock.withLock { storage[key] }
    }

    public func set(_ data: Data, forKey key: String) throws {
        lock.withLock { storage[key] = data }
    }

    public func removeValue(forKey key: String) throws {
        _ = lock.withLock { storage.removeValue(forKey: key) }
    }
}

public enum KeychainSecureStoreError: Error, Sendable, Equatable, LocalizedError {
    case unexpectedStatus(OSStatus)

    public var errorDescription: String? {
        switch self {
        case .unexpectedStatus(let status):
            "The keychain rejected the paired host record (status \(status))."
        }
    }
}

public struct KeychainSecureStore: SecureStore {
    public static let defaultService = "ai.opencoven.psyche-ios.paired-hosts"

    /// Pairing survives reboots without the app ever needing the device
    /// unlocked while it runs, and a paired host must never ride an iCloud or
    /// device-to-device backup onto hardware that was never pinned to it.
    /// `AfterFirstUnlockThisDeviceOnly` is exactly that pair of properties.
    public static var accessibility: CFString { kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly }

    public let service: String

    public init(service: String = defaultService) {
        self.service = service
    }

    public func data(forKey key: String) throws -> Data? {
        var query = Self.lookupQuery(service: service, account: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            return item as? Data
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainSecureStoreError.unexpectedStatus(status)
        }
    }

    public func set(_ data: Data, forKey key: String) throws {
        let query = Self.lookupQuery(service: service, account: key)
        let updateStatus = SecItemUpdate(
            query as CFDictionary,
            Self.updateAttributes(data: data) as CFDictionary
        )
        switch updateStatus {
        case errSecSuccess:
            return
        case errSecItemNotFound:
            let addStatus = SecItemAdd(
                Self.insertAttributes(service: service, account: key, data: data) as CFDictionary,
                nil
            )
            guard addStatus == errSecSuccess else {
                throw KeychainSecureStoreError.unexpectedStatus(addStatus)
            }
        default:
            throw KeychainSecureStoreError.unexpectedStatus(updateStatus)
        }
    }

    public func removeValue(forKey key: String) throws {
        let status = SecItemDelete(Self.lookupQuery(service: service, account: key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainSecureStoreError.unexpectedStatus(status)
        }
    }

    static func lookupQuery(service: String, account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }

    static func insertAttributes(service: String, account: String, data: Data) -> [String: Any] {
        var attributes = lookupQuery(service: service, account: account)
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = accessibility
        return attributes
    }

    static func updateAttributes(data: Data) -> [String: Any] {
        [
            kSecValueData as String: data,
            kSecAttrAccessible as String: accessibility
        ]
    }
}
