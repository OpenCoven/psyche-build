import Foundation

public enum PairedHostStoreError: Error, Sendable, Equatable, LocalizedError {
    case invalidFingerprint
    case identityChanged(serverID: String)
    case unknownHost(serverID: String)
    case corruptedRecord
    case rollbackFailed

    public var errorDescription: String? {
        switch self {
        case .invalidFingerprint:
            "The host certificate fingerprint is invalid. Re-pair this device with the host."
        case .identityChanged:
            """
            This host is presenting a different certificate than the one you \
            paired with. Re-pair this device with the host to trust it again.
            """
        case .unknownHost:
            "Choose a paired host before making it the reconnect target."
        case .corruptedRecord:
            "The stored pairing could not be read. Re-pair this device with the host."
        case .rollbackFailed:
            "The paired host store could not restore its previous state after a failed write. Re-pair this device with the host."
        }
    }
}

/// Owns the paired-host records and the one rule that matters: a server ID
/// already on file cannot quietly start using a different certificate.
/// `save` refuses that; only `replace`, which the user reaches by re-pairing,
/// can rewrite a pinned fingerprint.
public actor PairedHostStore {
    public static let defaultKey = "paired-hosts.v1"
    public static let lastConnectedKey = "paired-host-last-connected.v1"
    static let customSelectionKeyPrefix = "paired-host-selection.v1."

    private let secureStore: any SecureStore
    private let key: String
    private let selectionKey: String

    public init(secureStore: any SecureStore, key: String = defaultKey) {
        self.secureStore = secureStore
        self.key = key
        self.selectionKey = Self.selectionKey(forStoreKey: key)
    }

    static func selectionKey(forStoreKey key: String) -> String {
        guard key != Self.defaultKey else { return Self.lastConnectedKey }
        return "\(customSelectionKeyPrefix)\(Data(key.utf8).base64EncodedString())"
    }

    /// Sorted by server ID so a list rendered from this never reorders itself
    /// between reads.
    public func hosts() throws -> [PairedHost] {
        try records().values.sorted { $0.serverID < $1.serverID }
    }

    public func host(withServerID serverID: String) throws -> PairedHost? {
        try records()[serverID]
    }

    public func lastConnectedHost() throws -> PairedHost? {
        guard let serverID = try selectedServerID() else { return nil }
        guard let host = try records()[serverID] else {
            try clearLastConnectedHost()
            return nil
        }
        return host
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
        let priorRecordsData = try secureStore.data(forKey: key)
        var records = try records(from: priorRecordsData)
        guard records.removeValue(forKey: serverID) != nil else { return }
        let priorSelectionData = try secureStore.data(forKey: selectionKey)
        let shouldClearSelection = decodedSelectedServerID(from: priorSelectionData) == serverID

        try performRollbackSafeMutation(
            recordsData: priorRecordsData,
            selectionData: priorSelectionData
        ) {
            try write(records)
            if shouldClearSelection {
                try clearLastConnectedHost()
            }
        }
    }

    public func removeAll() throws {
        let priorRecordsData = try secureStore.data(forKey: key)
        let priorSelectionData = try secureStore.data(forKey: selectionKey)

        try performRollbackSafeMutation(
            recordsData: priorRecordsData,
            selectionData: priorSelectionData
        ) {
            try secureStore.removeValue(forKey: key)
            try secureStore.removeValue(forKey: selectionKey)
        }
    }

    public func markLastConnected(serverID: String) throws {
        guard try records()[serverID] != nil else {
            throw PairedHostStoreError.unknownHost(serverID: serverID)
        }
        try writeLastConnected(serverID: serverID)
    }

    public func clearLastConnectedHost() throws {
        try secureStore.removeValue(forKey: selectionKey)
    }

    func recordSuccessfulConnection(
        _ host: PairedHost,
        for generation: ConnectionGeneration
    ) throws -> Bool {
        let priorRecordsData = try secureStore.data(forKey: key)
        let priorSelectionData = try secureStore.data(forKey: selectionKey)
        let normalized = try normalize(host)
        var records = try records(from: priorRecordsData)

        if let existing = records[normalized.serverID],
           existing.certificateFingerprint != normalized.certificateFingerprint {
            throw PairedHostStoreError.identityChanged(serverID: normalized.serverID)
        }

        records[normalized.serverID] = normalized
        return try generation.withValidity {
            try performRollbackSafeMutation(
                recordsData: priorRecordsData,
                selectionData: priorSelectionData
            ) {
                try write(records)
                try writeLastConnected(serverID: normalized.serverID)
                return true
            }
        } ?? false
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

    private func writeLastConnected(serverID: String) throws {
        try secureStore.set(try JSONEncoder().encode(serverID), forKey: selectionKey)
    }

    private func selectedServerID() throws -> String? {
        guard let data = try secureStore.data(forKey: selectionKey) else {
            return nil
        }
        do {
            return try JSONDecoder().decode(String.self, from: data)
        } catch {
            try secureStore.removeValue(forKey: selectionKey)
            return nil
        }
    }

    private func decodedSelectedServerID(from data: Data?) -> String? {
        guard let data else { return nil }
        return try? JSONDecoder().decode(String.self, from: data)
    }

    private func performRollbackSafeMutation<T>(
        recordsData: Data?,
        selectionData: Data?,
        perform mutation: () throws -> T
    ) throws -> T {
        do {
            return try mutation()
        } catch {
            try restorePriorState(
                recordsData: recordsData,
                selectionData: selectionData
            )
            throw error
        }
    }

    private func restorePriorState(
        recordsData: Data?,
        selectionData: Data?
    ) throws {
        var rollbackFailed = false

        do {
            try restore(recordsData, forKey: key)
        } catch {
            rollbackFailed = true
        }

        do {
            try restore(selectionData, forKey: selectionKey)
        } catch {
            rollbackFailed = true
        }

        if rollbackFailed {
            throw PairedHostStoreError.rollbackFailed
        }
    }

    private func restore(_ data: Data?, forKey key: String) throws {
        guard let data else {
            try secureStore.removeValue(forKey: key)
            return
        }
        try secureStore.set(data, forKey: key)
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
