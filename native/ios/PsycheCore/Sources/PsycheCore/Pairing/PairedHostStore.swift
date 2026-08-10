import Foundation

public enum PairedHostStoreError: Error, Sendable, Equatable, LocalizedError {
    case invalidFingerprint
    case identityChanged(serverID: String)
    case corruptedRecord

    public var errorDescription: String? {
        switch self {
        case .invalidFingerprint:
            "The host certificate fingerprint is invalid. Re-pair this device with the host."
        case .identityChanged:
            """
            This host is presenting a different certificate than the one you \
            paired with. Re-pair this device with the host to trust it again.
            """
        case .corruptedRecord:
            "The stored pairing could not be read. Re-pair this device with the host."
        }
    }
}

/// Owns the paired-host records and the one rule that matters: a server ID
/// already on file cannot quietly start using a different certificate.
/// `save` refuses that; only `replace`, which the user reaches by re-pairing,
/// can rewrite a pinned fingerprint.
public actor PairedHostStore {
    public static let defaultKey = "paired-hosts.v1"

    private let secureStore: any SecureStore
    private let key: String

    public init(secureStore: any SecureStore, key: String = defaultKey) {
        self.secureStore = secureStore
        self.key = key
    }

    /// Sorted by server ID so a list rendered from this never reorders itself
    /// between reads.
    public func hosts() throws -> [PairedHost] {
        try records().values.sorted { $0.serverID < $1.serverID }
    }

    public func host(withServerID serverID: String) throws -> PairedHost? {
        try records()[serverID]
    }

    /// Persists a pairing, refusing to overwrite a known server ID whose
    /// fingerprint no longer matches. Everything else about a known host —
    /// name, address, token — is free to change.
    public func save(_ host: PairedHost) throws {
        try Task.checkCancellation()
        let normalized = try normalize(host)
        var records = try records()

        if let existing = records[normalized.serverID],
           existing.certificateFingerprint != normalized.certificateFingerprint {
            throw PairedHostStoreError.identityChanged(serverID: normalized.serverID)
        }

        records[normalized.serverID] = normalized
        try Task.checkCancellation()
        try write(records)
    }

    /// The explicit re-pair path. Accepts a new fingerprint for a known server
    /// ID, so only call this once the user has confirmed the new certificate.
    public func replace(_ host: PairedHost) throws {
        let normalized = try normalize(host)
        var records = try records()
        records[normalized.serverID] = normalized
        try write(records)
    }

    /// Tokens are reissued without the host identity changing, so this skips
    /// the fingerprint rule rather than forcing a re-pair on every refresh.
    public func updateToken(_ token: String?, forServerID serverID: String) throws {
        var records = try records()
        guard let existing = records[serverID] else { return }
        records[serverID] = existing.withToken(token)
        try write(records)
    }

    public func pairingStatus(
        forServerID serverID: String,
        certificateFingerprint: String
    ) throws -> PairingStatus {
        guard let existing = try records()[serverID] else { return .unpaired }
        guard let normalized = try? PinnedCertificateDelegate
            .normalizeFingerprint(certificateFingerprint) else {
            return .requiresRePairing
        }
        return existing.certificateFingerprint == normalized ? .paired : .requiresRePairing
    }

    public func remove(serverID: String) throws {
        var records = try records()
        guard records.removeValue(forKey: serverID) != nil else { return }
        try write(records)
    }

    public func removeAll() throws {
        try secureStore.removeValue(forKey: key)
    }

    private func records() throws -> [String: PairedHost] {
        guard let data = try secureStore.data(forKey: key) else { return [:] }
        do {
            return try JSONDecoder().decode([String: PairedHost].self, from: data)
        } catch {
            throw PairedHostStoreError.corruptedRecord
        }
    }

    private func write(_ records: [String: PairedHost]) throws {
        try secureStore.set(try JSONEncoder().encode(records), forKey: key)
    }

    /// Store fingerprints in one canonical form so a record saved from a
    /// colon-separated Bonjour TXT value compares equal to the same
    /// certificate seen anywhere else.
    private func normalize(_ host: PairedHost) throws -> PairedHost {
        guard let fingerprint = try? PinnedCertificateDelegate
            .normalizeFingerprint(host.certificateFingerprint) else {
            throw PairedHostStoreError.invalidFingerprint
        }
        return host.withEndpoint(HostEndpoint(
            host: host.endpoint.host,
            port: host.endpoint.port,
            route: host.endpoint.route,
            certificateFingerprint: fingerprint
        ))
    }
}
