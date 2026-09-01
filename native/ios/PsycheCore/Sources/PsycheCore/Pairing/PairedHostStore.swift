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

    func save(
        _ host: PairedHost,
        for generation: ConnectionGeneration
    ) throws -> Bool {
        let normalized = try normalize(host)
        var records = try records()

        if let existing = records[normalized.serverID],
           existing.certificateFingerprint != normalized.certificateFingerprint {
            throw PairedHostStoreError.identityChanged(serverID: normalized.serverID)
        }

        records[normalized.serverID] = normalized
        return try generation.withValidity {
            try write(records)
            return true
        } ?? false
    }

    /// The explicit re-pair path. Accepts a new fingerprint for a known server
    /// ID, so only call this once the user has confirmed the new certificate.
    public func replace(_ host: PairedHost) throws {
        let normalized = try normalize(host)
        var records = try records()
        records[normalized.serverID] = normalized
        try write(records)
    }

    /// The generation- and attempt-bound explicit re-pair path. Either a
    /// replaced connection or a cancelled pairing attempt is forbidden from
    /// rewriting a pinned fingerprint after it has been retired.
    func replace(
        _ host: PairedHost,
        for generation: ConnectionGeneration,
        authorizedBy authorization: PairingPersistenceAuthorization
    ) throws -> Bool {
        let normalized = try normalize(host)
        var records = try records()
        records[normalized.serverID] = normalized
        guard let committed = try generation.withValidity({
            try authorization.withAuthorization {
                try write(records)
                return true
            } ?? false
        }) else {
            return false
        }
        return committed
    }

    /// Records a reissued token for a host whose identity is already
    /// committed. This is deliberately not an identity path: the record must
    /// already exist with the same pinned fingerprint, and a retired
    /// connection or a cancelled pairing may not write at all.
    func reissueToken(
        _ token: String?,
        forServerID serverID: String,
        certificateFingerprint: String,
        for generation: ConnectionGeneration,
        authorizedBy authorization: PairingPersistenceAuthorization
    ) throws -> Bool {
        var records = try records()
        guard let existing = records[serverID] else { return false }
        let normalized = try PinnedCertificateDelegate
            .normalizeFingerprint(certificateFingerprint)
        guard existing.certificateFingerprint == normalized else {
            throw PairedHostStoreError.identityChanged(serverID: serverID)
        }
        records[serverID] = existing.withToken(token)
        return try generation.withValidity {
            try authorization.withAuthorization {
                try write(records)
                return true
            } ?? false
        } ?? false
    }

    /// Revalidates the readiness flow and publishes while this actor owns the
    /// paired-host record. A throwing store write is compensated and verified
    /// before it may be reported as not committed.
    func publishReadinessHost(
        _ host: PairedHost,
        policy: HostIdentityPublicationPolicy,
        claimedBy claim: HostReadinessHostPublicationClaim,
        authorizedBy authorization: HostReadinessFlowAuthorization
    ) -> HostReadinessTransactionResult {
        let previousData: Data?
        let nextData: Data
        do {
            try Task.checkCancellation()
            let normalized = try normalize(host)
            previousData = try secureStore.data(forKey: key)
            var records = try records(from: previousData)
            if policy == .preserve,
               let existing = records[normalized.serverID],
               existing.certificateFingerprint != normalized.certificateFingerprint {
                throw PairedHostStoreError.identityChanged(serverID: normalized.serverID)
            }
            records[normalized.serverID] = normalized
            nextData = try JSONEncoder().encode(records)
            try Task.checkCancellation()
        } catch {
            return .notCommitted(reason: error.localizedDescription)
        }

        return authorization.publishHost(claimedBy: claim) {
            do {
                try Task.checkCancellation()
                try secureStore.set(nextData, forKey: key)
                return .committed
            } catch {
                return compensateReadinessWrite(
                    to: previousData,
                    after: error
                )
            }
        }
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
        try records(from: secureStore.data(forKey: key))
    }

    private func records(from data: Data?) throws -> [String: PairedHost] {
        guard let data else { return [:] }
        do {
            return try JSONDecoder().decode([String: PairedHost].self, from: data)
        } catch {
            throw PairedHostStoreError.corruptedRecord
        }
    }

    private func write(_ records: [String: PairedHost]) throws {
        try secureStore.set(try JSONEncoder().encode(records), forKey: key)
    }

    private func compensateReadinessWrite(
        to previousData: Data?,
        after writeError: any Error
    ) -> HostReadinessTransactionResult {
        do {
            if let previousData {
                try secureStore.set(previousData, forKey: key)
            } else {
                try secureStore.removeValue(forKey: key)
            }
        } catch {
            return .indeterminate(reason: [
                "Paired-host publication failed: \(writeError.localizedDescription)",
                "Compensation failed: \(error.localizedDescription)"
            ].joined(separator: " "))
        }

        do {
            guard try secureStore.data(forKey: key) == previousData else {
                return .indeterminate(reason: [
                    "Paired-host publication failed: \(writeError.localizedDescription)",
                    "Compensation could not be verified."
                ].joined(separator: " "))
            }
        } catch {
            return .indeterminate(reason: [
                "Paired-host publication failed: \(writeError.localizedDescription)",
                "Compensation verification failed: \(error.localizedDescription)"
            ].joined(separator: " "))
        }

        return .notCommitted(reason: writeError.localizedDescription)
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
