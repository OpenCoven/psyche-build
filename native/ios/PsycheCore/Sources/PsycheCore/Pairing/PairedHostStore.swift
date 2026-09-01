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
    public static let defaultKey = "paired-hosts.v2"
    static let legacyKey = "paired-hosts.v1"

    private struct PersistedState: Codable {
        var records: [String: PairedHost]
        var selectedServerID: String?
    }

    private let secureStore: any SecureStore
    private let key: String
    private let fallbackKey: String?
    private var readySelectionOwner: ObjectIdentifier?

    public init(secureStore: any SecureStore, key: String = defaultKey) {
        self.secureStore = secureStore
        self.key = key
        fallbackKey = key == Self.defaultKey ? Self.legacyKey : nil
    }

    /// Sorted by server ID so a list rendered from this never reorders itself
    /// between reads.
    public func hosts() throws -> [PairedHost] {
        try state().records.values.sorted { $0.serverID < $1.serverID }
    }

    public func host(withServerID serverID: String) throws -> PairedHost? {
        try state().records[serverID]
    }

    public func selectedHost() throws -> PairedHost? {
        let snapshot = try stateSnapshot()
        let state = snapshot.state
        guard let selectedServerID = state.selectedServerID else { return nil }
        guard let host = state.records[selectedServerID] else {
            throw PairedHostStoreError.corruptedRecord
        }
        if snapshot.currentData == nil, fallbackKey != nil {
            try write(state)
        }
        return host
    }

    /// Persists a pairing, refusing to overwrite a known server ID whose
    /// fingerprint no longer matches. Everything else about a known host —
    /// name, address, token — is free to change.
    public func save(_ host: PairedHost) throws {
        try Task.checkCancellation()
        let normalized = try normalize(host)
        var state = try state()

        if let existing = state.records[normalized.serverID],
           existing.certificateFingerprint != normalized.certificateFingerprint {
            throw PairedHostStoreError.identityChanged(serverID: normalized.serverID)
        }

        state.records[normalized.serverID] = normalized
        state.selectedServerID = normalized.serverID
        try Task.checkCancellation()
        try write(state)
    }

    func save(
        _ host: PairedHost,
        for generation: ConnectionGeneration
    ) throws -> Bool {
        let normalized = try normalize(host)
        var state = try state()

        if let existing = state.records[normalized.serverID],
           existing.certificateFingerprint != normalized.certificateFingerprint {
            throw PairedHostStoreError.identityChanged(serverID: normalized.serverID)
        }

        state.records[normalized.serverID] = normalized
        state.selectedServerID = normalized.serverID
        return try generation.withValidity {
            try write(state)
            return true
        } ?? false
    }

    /// The explicit re-pair path. Accepts a new fingerprint for a known server
    /// ID, so only call this once the user has confirmed the new certificate.
    public func replace(_ host: PairedHost) throws {
        let normalized = try normalize(host)
        var state = try state()
        state.records[normalized.serverID] = normalized
        state.selectedServerID = normalized.serverID
        try write(state)
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
        var state = try state()
        state.records[normalized.serverID] = normalized
        state.selectedServerID = normalized.serverID
        guard let committed = try generation.withValidity({
            try authorization.withAuthorization {
                try write(state)
                return true
            } ?? false
        }) else {
            return false
        }
        return committed
    }

    /// Records a reissued credential binding for a host whose identity is
    /// already committed. This is deliberately not an identity path: the
    /// record must already exist with the same pinned fingerprint, and a
    /// retired connection or a cancelled pairing may not write at all.
    func reissueToken(
        _ token: String?,
        clientID: String,
        forServerID serverID: String,
        certificateFingerprint: String,
        for generation: ConnectionGeneration,
        authorizedBy authorization: PairingPersistenceAuthorization
    ) throws -> HostReadinessTransactionResult {
        let snapshot = try stateSnapshot()
        let previousData = snapshot.currentData
        var state = snapshot.state
        guard let existing = state.records[serverID] else {
            return .notCommitted(reason: nil)
        }
        let normalized = try PinnedCertificateDelegate
            .normalizeFingerprint(certificateFingerprint)
        guard existing.certificateFingerprint == normalized else {
            throw PairedHostStoreError.identityChanged(serverID: serverID)
        }
        state.records[serverID] = existing.withCredentials(
            clientID: clientID,
            token: token
        )
        let nextData = try JSONEncoder().encode(state)

        return generation.withValidity {
            authorization.withAuthorization {
                do {
                    try secureStore.set(nextData, forKey: key)
                    return .committed
                } catch {
                    return compensateWrite(
                        to: previousData,
                        after: error,
                        operation: "Credential reissue"
                    )
                }
            } ?? .notCommitted(reason: nil)
        } ?? .notCommitted(reason: nil)
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
            let snapshot = try stateSnapshot()
            previousData = snapshot.currentData
            var state = snapshot.state
            if policy == .preserve,
               let existing = state.records[normalized.serverID],
               existing.certificateFingerprint != normalized.certificateFingerprint {
                throw PairedHostStoreError.identityChanged(serverID: normalized.serverID)
            }
            state.records[normalized.serverID] = normalized
            nextData = try JSONEncoder().encode(state)
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
                return compensateWrite(
                    to: previousData,
                    after: error,
                    operation: "Paired-host publication"
                )
            }
        }
    }

    /// Advances automatic reconnect authority only after the connection's
    /// first workspace snapshot has completed readiness. The generation lock
    /// makes teardown and selection mutually exclusive at the write boundary.
    func selectReadyHost(
        serverID: String,
        for generation: ConnectionGeneration
    ) -> HostReadinessTransactionResult {
        let previousData: Data?
        let nextData: Data
        do {
            let snapshot = try stateSnapshot()
            previousData = snapshot.currentData
            var state = snapshot.state
            guard state.records[serverID] != nil else {
                return .notCommitted(
                    reason: "The ready host has no persisted pairing record."
                )
            }
            guard state.selectedServerID != serverID else {
                return generation.withValidity {
                    readySelectionOwner = ObjectIdentifier(generation)
                    return .committed
                }
                    ?? .notCommitted(reason: nil)
            }
            state.selectedServerID = serverID
            nextData = try JSONEncoder().encode(state)
        } catch {
            return .notCommitted(reason: error.localizedDescription)
        }

        return generation.withValidity {
            do {
                try secureStore.set(nextData, forKey: key)
                readySelectionOwner = ObjectIdentifier(generation)
                return .committed
            } catch {
                return compensateWrite(
                    to: previousData,
                    after: error,
                    operation: "Ready-host selection"
                )
            }
        } ?? .notCommitted(reason: nil)
    }

    /// Removes a server-rejected credential without discarding the pinned host
    /// identity. The generation lock prevents a retired connection from
    /// clearing credentials written by a newer one.
    func revokeToken(
        forServerID serverID: String,
        for generation: ConnectionGeneration
    ) -> HostReadinessTransactionResult {
        let previousData: Data?
        let nextData: Data
        do {
            let snapshot = try stateSnapshot()
            previousData = snapshot.currentData
            var state = snapshot.state
            guard let existing = state.records[serverID] else {
                return .notCommitted(
                    reason: "The rejected credential has no persisted host record."
                )
            }
            guard existing.token != nil else {
                return generation.withValidity { .committed }
                    ?? .notCommitted(reason: nil)
            }
            state.records[serverID] = existing.withToken(nil)
            nextData = try JSONEncoder().encode(state)
        } catch {
            return .notCommitted(reason: error.localizedDescription)
        }

        return generation.withValidity {
            do {
                try secureStore.set(nextData, forKey: key)
                return .committed
            } catch {
                return compensateWrite(
                    to: previousData,
                    after: error,
                    operation: "Credential revocation"
                )
            }
        } ?? .notCommitted(reason: nil)
    }

    /// Restores the previous reconnect selection when a generation retires
    /// after selection committed but before readiness could promote the host.
    /// The expected-current check avoids overwriting a later selection.
    func compensateReadyHostSelection(
        expectedServerID: String,
        restoringServerID: String?,
        selectedBy generation: ConnectionGeneration
    ) -> HostReadinessTransactionResult {
        guard readySelectionOwner == ObjectIdentifier(generation) else {
            return .notCommitted(reason: nil)
        }
        let previousData: Data?
        let nextData: Data
        do {
            let snapshot = try stateSnapshot()
            previousData = snapshot.currentData
            var state = snapshot.state
            guard state.selectedServerID == expectedServerID else {
                return .notCommitted(reason: nil)
            }
            if let restoringServerID,
               state.records[restoringServerID] == nil {
                return .indeterminate(
                    reason: "The previous ready host record is missing."
                )
            }
            state.selectedServerID = restoringServerID
            nextData = try JSONEncoder().encode(state)
        } catch {
            return .indeterminate(reason: error.localizedDescription)
        }

        do {
            try secureStore.set(nextData, forKey: key)
            readySelectionOwner = nil
            return .committed
        } catch {
            let compensation = compensateWrite(
                to: previousData,
                after: error,
                operation: "Ready-host selection compensation"
            )
            switch compensation {
            case .committed:
                return .indeterminate(
                    reason: "Ready-host selection compensation returned an invalid result."
                )
            case .notCommitted(let reason):
                return .indeterminate(
                    reason: reason.map {
                        "The previous ready-host selection could not be restored: \($0)"
                    } ?? "The previous ready-host selection could not be restored."
                )
            case .indeterminate:
                return compensation
            }
        }
    }

    /// Tokens are reissued without the host identity changing, so this skips
    /// the fingerprint rule rather than forcing a re-pair on every refresh.
    public func updateToken(_ token: String?, forServerID serverID: String) throws {
        var state = try state()
        guard let existing = state.records[serverID] else { return }
        state.records[serverID] = existing.withToken(token)
        try write(state)
    }

    public func pairingStatus(
        forServerID serverID: String,
        certificateFingerprint: String
    ) throws -> PairingStatus {
        guard let existing = try state().records[serverID] else { return .unpaired }
        guard let normalized = try? PinnedCertificateDelegate
            .normalizeFingerprint(certificateFingerprint) else {
            return .requiresRePairing
        }
        return existing.certificateFingerprint == normalized ? .paired : .requiresRePairing
    }

    public func remove(serverID: String) throws {
        var state = try state()
        guard state.records.removeValue(forKey: serverID) != nil else { return }
        if state.selectedServerID == serverID {
            state.selectedServerID = nil
        }
        try write(state)
    }

    public func removeAll() throws {
        if let fallbackKey {
            try secureStore.removeValue(forKey: fallbackKey)
        }
        try secureStore.removeValue(forKey: key)
    }

    private func state() throws -> PersistedState {
        try stateSnapshot().state
    }

    private func stateSnapshot() throws -> (state: PersistedState, currentData: Data?) {
        let currentData = try secureStore.data(forKey: key)
        if currentData != nil {
            return (try state(from: currentData), currentData)
        }
        if let fallbackKey,
           let fallbackData = try secureStore.data(forKey: fallbackKey) {
            return (try state(from: fallbackData), nil)
        }
        return (PersistedState(records: [:], selectedServerID: nil), nil)
    }

    private func state(from data: Data?) throws -> PersistedState {
        guard let data else {
            return PersistedState(records: [:], selectedServerID: nil)
        }
        do {
            let decoder = JSONDecoder()
            if let state = try? decoder.decode(PersistedState.self, from: data) {
                return try validate(state)
            }
            let records = try decoder.decode([String: PairedHost].self, from: data)
            return try validate(PersistedState(
                records: records,
                selectedServerID: records.keys.sorted().first
            ))
        } catch {
            if let error = error as? PairedHostStoreError {
                throw error
            }
            throw PairedHostStoreError.corruptedRecord
        }
    }

    private func validate(_ state: PersistedState) throws -> PersistedState {
        guard state.records.allSatisfy({ $0.key == $0.value.serverID }) else {
            throw PairedHostStoreError.corruptedRecord
        }
        if let selectedServerID = state.selectedServerID,
           state.records[selectedServerID] == nil {
            throw PairedHostStoreError.corruptedRecord
        }
        return state
    }

    private func write(_ state: PersistedState) throws {
        try secureStore.set(try JSONEncoder().encode(state), forKey: key)
    }

    private func compensateWrite(
        to previousData: Data?,
        after writeError: any Error,
        operation: String
    ) -> HostReadinessTransactionResult {
        do {
            if let previousData {
                try secureStore.set(previousData, forKey: key)
            } else {
                try secureStore.removeValue(forKey: key)
            }
        } catch {
            return .indeterminate(reason: [
                "\(operation) failed: \(writeError.localizedDescription)",
                "Compensation failed: \(error.localizedDescription)"
            ].joined(separator: " "))
        }

        do {
            guard try secureStore.data(forKey: key) == previousData else {
                return .indeterminate(reason: [
                    "\(operation) failed: \(writeError.localizedDescription)",
                    "Compensation could not be verified."
                ].joined(separator: " "))
            }
        } catch {
            return .indeterminate(reason: [
                "\(operation) failed: \(writeError.localizedDescription)",
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
