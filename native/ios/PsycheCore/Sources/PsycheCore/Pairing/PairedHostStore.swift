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

final class ReadyHostSelectionAuthorization: @unchecked Sendable {
    private let lock = NSLock()
    private var isAuthorized = true
    private var isFinalized = false

    func finalize(_ operation: () throws -> Void) rethrows -> Bool {
        try lock.withLock {
            guard isAuthorized, !isFinalized else { return false }
            try operation()
            isFinalized = true
            isAuthorized = false
            return true
        }
    }

    func supersede() {
        lock.withLock {
            isAuthorized = false
        }
    }

    func withSupersession<T>(
        _ operation: () -> (value: T, restoreAuthorization: Bool)
    ) -> T {
        lock.withLock {
            let wasAuthorized = isAuthorized
            isAuthorized = false
            let result = operation()
            if result.restoreAuthorization {
                isAuthorized = wasAuthorized
            }
            return result.value
        }
    }

    func revokeBeforeFinalization() -> Bool {
        lock.withLock {
            guard isAuthorized, !isFinalized else { return false }
            isAuthorized = false
            return true
        }
    }

    var finalized: Bool {
        lock.withLock { isFinalized }
    }
}

/// Owns the paired-host records and the one rule that matters: a server ID
/// already on file cannot quietly start using a different certificate.
/// `save` refuses that; only `replace`, which the user reaches by re-pairing,
/// can rewrite a pinned fingerprint.
public actor PairedHostStore {
    public static let defaultKey = "paired-hosts.v2"
    static let legacyKey = "paired-hosts.v1"

    struct ReadyHostSelectionTransaction: Codable, Equatable, Sendable {
        let id: UUID
        let candidateServerID: String
        let previousServerID: String?
    }

    struct ReadyHostSelectionPreparation: Sendable {
        let result: HostReadinessTransactionResult
        let transaction: ReadyHostSelectionTransaction?
        let authorization: ReadyHostSelectionAuthorization?
    }

    private struct PersistedState: Codable {
        var records: [String: PairedHost]
        var selectedServerID: String?
        var pendingReadySelection: ReadyHostSelectionTransaction? = nil
    }

    private enum SupersedingMutationResult {
        case committed
        case unchanged(any Error)
        case indeterminate(any Error)
    }

    private let secureStore: any SecureStore
    private let key: String
    private let fallbackKey: String?
    private let readyHostSelectionCommitStart: @Sendable () -> Void
    private var readySelectionOwner: (
        generation: ObjectIdentifier,
        transactionID: UUID?,
        authorization: ReadyHostSelectionAuthorization
    )?

    public init(secureStore: any SecureStore, key: String = defaultKey) {
        self.secureStore = secureStore
        self.key = key
        fallbackKey = key == Self.defaultKey ? Self.legacyKey : nil
        readyHostSelectionCommitStart = {}
    }

    init(
        secureStore: any SecureStore,
        key: String = defaultKey,
        readyHostSelectionCommitStart: @escaping @Sendable () -> Void
    ) {
        self.secureStore = secureStore
        self.key = key
        fallbackKey = key == Self.defaultKey ? Self.legacyKey : nil
        self.readyHostSelectionCommitStart = readyHostSelectionCommitStart
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
        let selectedServerID = if let pending = state.pendingReadySelection {
            if readySelectionOwner?.transactionID == pending.id,
               readySelectionOwner?.authorization.finalized == true {
                state.selectedServerID
            } else {
                pending.previousServerID
            }
        } else {
            state.selectedServerID
        }
        guard let selectedServerID else { return nil }
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
        let snapshot = try stateSnapshot()
        var state = snapshot.state

        if let existing = state.records[normalized.serverID],
           existing.certificateFingerprint != normalized.certificateFingerprint {
            throw PairedHostStoreError.identityChanged(serverID: normalized.serverID)
        }

        state.records[normalized.serverID] = normalized
        state.selectedServerID = normalized.serverID
        state.pendingReadySelection = nil
        try Task.checkCancellation()
        let nextData = try JSONEncoder().encode(state)
        try mutateSupersedingReadySelection(
            previousData: snapshot.currentData
        ) {
            try secureStore.set(nextData, forKey: key)
        }
    }

    func save(
        _ host: PairedHost,
        for generation: ConnectionGeneration
    ) throws -> Bool {
        let normalized = try normalize(host)
        let snapshot = try stateSnapshot()
        var state = snapshot.state

        if let existing = state.records[normalized.serverID],
           existing.certificateFingerprint != normalized.certificateFingerprint {
            throw PairedHostStoreError.identityChanged(serverID: normalized.serverID)
        }

        state.records[normalized.serverID] = normalized
        state.selectedServerID = normalized.serverID
        state.pendingReadySelection = nil
        let nextData = try JSONEncoder().encode(state)
        return try generation.withValidity {
            try mutateSupersedingReadySelection(
                previousData: snapshot.currentData
            ) {
                try secureStore.set(nextData, forKey: key)
            }
            return true
        } ?? false
    }

    /// The explicit re-pair path. Accepts a new fingerprint for a known server
    /// ID, so only call this once the user has confirmed the new certificate.
    public func replace(_ host: PairedHost) throws {
        let normalized = try normalize(host)
        let snapshot = try stateSnapshot()
        var state = snapshot.state
        state.records[normalized.serverID] = normalized
        state.selectedServerID = normalized.serverID
        state.pendingReadySelection = nil
        let nextData = try JSONEncoder().encode(state)
        try mutateSupersedingReadySelection(
            previousData: snapshot.currentData
        ) {
            try secureStore.set(nextData, forKey: key)
        }
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
        let snapshot = try stateSnapshot()
        var state = snapshot.state
        state.records[normalized.serverID] = normalized
        state.selectedServerID = normalized.serverID
        state.pendingReadySelection = nil
        let nextData = try JSONEncoder().encode(state)
        guard let committed = try generation.withValidity({
            try authorization.withAuthorization {
                try mutateSupersedingReadySelection(
                    previousData: snapshot.currentData
                ) {
                    try secureStore.set(nextData, forKey: key)
                }
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
    /// makes teardown and the complete selection transaction mutually exclusive.
    func selectReadyHost(
        serverID: String,
        for generation: ConnectionGeneration
    ) -> ReadyHostSelectionPreparation {
        readyHostSelectionCommitStart()
        return generation.withValidity {
            let previousData: Data?
            let nextData: Data
            let transaction: ReadyHostSelectionTransaction?
            do {
                let snapshot = try stateSnapshot()
                var state = snapshot.state
                guard state.records[serverID] != nil else {
                    return ReadyHostSelectionPreparation(
                        result: .notCommitted(
                            reason: "The ready host has no persisted pairing record."
                        ),
                        transaction: nil,
                        authorization: nil
                    )
                }
                let finalizedTransactionID: UUID? = if readySelectionOwner?
                    .authorization.finalized == true {
                    readySelectionOwner?.transactionID
                } else {
                    nil
                }
                if let pending = state.pendingReadySelection,
                   finalizedTransactionID == pending.id {
                    state.pendingReadySelection = nil
                    previousData = try JSONEncoder().encode(state)
                } else {
                    previousData = snapshot.currentData
                }
                let previousServerID = if let pending = state.pendingReadySelection {
                    pending.previousServerID
                } else {
                    state.selectedServerID
                }
                if previousServerID == serverID {
                    state.selectedServerID = serverID
                    state.pendingReadySelection = nil
                    transaction = nil
                } else {
                    let pending = ReadyHostSelectionTransaction(
                        id: UUID(),
                        candidateServerID: serverID,
                        previousServerID: previousServerID
                    )
                    state.selectedServerID = serverID
                    state.pendingReadySelection = pending
                    transaction = pending
                }
                nextData = try JSONEncoder().encode(state)
            } catch {
                return ReadyHostSelectionPreparation(
                    result: .notCommitted(reason: error.localizedDescription),
                    transaction: nil,
                    authorization: nil
                )
            }

            let authorization = ReadyHostSelectionAuthorization()
            supersedeReadySelection()
            let result: HostReadinessTransactionResult
            do {
                try secureStore.set(nextData, forKey: key)
                readySelectionOwner = (
                    generation: ObjectIdentifier(generation),
                    transactionID: transaction?.id,
                    authorization: authorization
                )
                result = .committed
            } catch {
                result = compensateWrite(
                    to: previousData,
                    after: error,
                    operation: "Ready-host selection"
                )
            }
            return ReadyHostSelectionPreparation(
                result: result,
                transaction: result == .committed ? transaction : nil,
                authorization: result == .committed ? authorization : nil
            )
        } ?? ReadyHostSelectionPreparation(
            result: .notCommitted(reason: nil),
            transaction: nil,
            authorization: nil
        )
    }

    /// Clears the provisional marker after the workspace and host became live
    /// together. If this cleanup cannot be proven, restart still falls back to
    /// the previously confirmed host rather than inventing durable readiness.
    func completeReadyHostSelection(
        _ transaction: ReadyHostSelectionTransaction,
        authorizedBy authorization: ReadyHostSelectionAuthorization,
        selectedBy generation: ConnectionGeneration
    ) -> HostReadinessTransactionResult {
        guard readySelectionOwner?.generation == ObjectIdentifier(generation),
              readySelectionOwner?.transactionID == transaction.id,
              readySelectionOwner?.authorization === authorization,
              authorization.finalized else {
            return .notCommitted(reason: nil)
        }
        let previousData: Data?
        let nextData: Data
        do {
            let snapshot = try stateSnapshot()
            previousData = snapshot.currentData
            var state = snapshot.state
            guard state.selectedServerID == transaction.candidateServerID,
                  state.pendingReadySelection == transaction else {
                return .notCommitted(reason: nil)
            }
            state.pendingReadySelection = nil
            nextData = try JSONEncoder().encode(state)
        } catch {
            authorization.supersede()
            readySelectionOwner = nil
            return .indeterminate(reason: error.localizedDescription)
        }
        do {
            try secureStore.set(nextData, forKey: key)
            readySelectionOwner = nil
            return .committed
        } catch {
            let result = compensateWrite(
                to: previousData,
                after: error,
                operation: "Ready-host selection completion"
            )
            if case .indeterminate = result {
                authorization.supersede()
                readySelectionOwner = nil
            }
            return result
        }
    }

    func acknowledgeReadyHostSelection(
        authorizedBy authorization: ReadyHostSelectionAuthorization,
        selectedBy generation: ConnectionGeneration
    ) {
        guard readySelectionOwner?.generation == ObjectIdentifier(generation),
              readySelectionOwner?.transactionID == nil,
              readySelectionOwner?.authorization === authorization,
              authorization.finalized else {
            return
        }
        readySelectionOwner = nil
    }

    func cancelReadyHostSelection(
        authorizedBy authorization: ReadyHostSelectionAuthorization,
        selectedBy generation: ConnectionGeneration
    ) {
        guard readySelectionOwner?.generation == ObjectIdentifier(generation),
              readySelectionOwner?.transactionID == nil,
              readySelectionOwner?.authorization === authorization,
              authorization.revokeBeforeFinalization() else {
            return
        }
        readySelectionOwner = nil
    }

    /// Removes a server-rejected credential without discarding the pinned host
    /// identity. The expected binding makes a delayed revocation safe after
    /// connection teardown without overwriting a newer credential.
    func revokeToken(
        forServerID serverID: String,
        expectedClientID: String,
        expectedToken: String?
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
            guard existing.clientID == expectedClientID,
                  existing.token == expectedToken else {
                return .notCommitted(reason: nil)
            }
            guard existing.token != nil else {
                return .committed
            }
            state.records[serverID] = existing.withToken(nil)
            nextData = try JSONEncoder().encode(state)
        } catch {
            return .notCommitted(reason: error.localizedDescription)
        }

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
    }

    /// Restores the previous reconnect selection when a generation retires
    /// after selection committed but before readiness could promote the host.
    /// The expected-current check avoids overwriting a later selection.
    func compensateReadyHostSelection(
        _ transaction: ReadyHostSelectionTransaction,
        authorizedBy authorization: ReadyHostSelectionAuthorization,
        selectedBy generation: ConnectionGeneration
    ) -> HostReadinessTransactionResult {
        guard readySelectionOwner?.generation == ObjectIdentifier(generation),
              readySelectionOwner?.transactionID == transaction.id,
              readySelectionOwner?.authorization === authorization,
              authorization.revokeBeforeFinalization() else {
            return .notCommitted(reason: nil)
        }
        let previousData: Data?
        let nextData: Data
        do {
            let snapshot = try stateSnapshot()
            previousData = snapshot.currentData
            var state = snapshot.state
            guard state.selectedServerID == transaction.candidateServerID,
                  state.pendingReadySelection == transaction else {
                return .notCommitted(reason: nil)
            }
            if let previousServerID = transaction.previousServerID,
               state.records[previousServerID] == nil {
                return .indeterminate(
                    reason: "The previous ready host record is missing."
                )
            }
            state.selectedServerID = transaction.previousServerID
            state.pendingReadySelection = nil
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
        let snapshot = try stateSnapshot()
        var state = snapshot.state
        guard state.records.removeValue(forKey: serverID) != nil else { return }
        var supersedesSelection = false
        if let pending = state.pendingReadySelection {
            let finalized = readySelectionOwner?.transactionID == pending.id
                && readySelectionOwner?.authorization.finalized == true
            if pending.candidateServerID == serverID {
                supersedesSelection = true
                state.selectedServerID = pending.previousServerID
                state.pendingReadySelection = nil
            } else if pending.previousServerID == serverID {
                supersedesSelection = true
                state.selectedServerID = finalized
                    ? pending.candidateServerID
                    : nil
                state.pendingReadySelection = nil
            }
        } else if state.selectedServerID == serverID {
            supersedesSelection = true
            state.selectedServerID = nil
        }
        let nextData = try JSONEncoder().encode(state)
        if supersedesSelection {
            try mutateSupersedingReadySelection(
                previousData: snapshot.currentData
            ) {
                try secureStore.set(nextData, forKey: key)
            }
        } else {
            try secureStore.set(nextData, forKey: key)
        }
    }

    public func removeAll() throws {
        let previousData = try secureStore.data(forKey: key)
        try mutateSupersedingReadySelection(previousData: previousData) {
            if let fallbackKey {
                try secureStore.removeValue(forKey: fallbackKey)
            }
            try secureStore.removeValue(forKey: key)
        }
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
        return (
            PersistedState(
                records: [:],
                selectedServerID: nil,
                pendingReadySelection: nil
            ),
            nil
        )
    }

    private func state(from data: Data?) throws -> PersistedState {
        guard let data else {
            return PersistedState(
                records: [:],
                selectedServerID: nil,
                pendingReadySelection: nil
            )
        }
        do {
            let decoder = JSONDecoder()
            if let state = try? decoder.decode(PersistedState.self, from: data) {
                return try validate(state)
            }
            let records = try decoder.decode([String: PairedHost].self, from: data)
            return try validate(PersistedState(
                records: records,
                selectedServerID: records.keys.sorted().first,
                pendingReadySelection: nil
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
        if let pending = state.pendingReadySelection {
            guard state.selectedServerID == pending.candidateServerID,
                  state.records[pending.candidateServerID] != nil,
                  pending.previousServerID != pending.candidateServerID else {
                throw PairedHostStoreError.corruptedRecord
            }
            if let previousServerID = pending.previousServerID,
               state.records[previousServerID] == nil {
                throw PairedHostStoreError.corruptedRecord
            }
        }
        return state
    }

    private func write(_ state: PersistedState) throws {
        try secureStore.set(try JSONEncoder().encode(state), forKey: key)
    }

    private func supersedeReadySelection() {
        readySelectionOwner?.authorization.supersede()
        readySelectionOwner = nil
    }

    private func mutateSupersedingReadySelection(
        previousData: Data?,
        _ mutation: () throws -> Void
    ) throws {
        guard let owner = readySelectionOwner else {
            try mutation()
            return
        }
        let result = owner.authorization.withSupersession {
            do {
                try mutation()
                return (
                    value: SupersedingMutationResult.committed,
                    restoreAuthorization: false
                )
            } catch {
                do {
                    let currentData = try secureStore.data(forKey: key)
                    if currentData == previousData {
                        return (
                            value: SupersedingMutationResult.unchanged(error),
                            restoreAuthorization: true
                        )
                    }
                } catch {
                    return (
                        value: SupersedingMutationResult.indeterminate(error),
                        restoreAuthorization: false
                    )
                }
                return (
                    value: SupersedingMutationResult.indeterminate(error),
                    restoreAuthorization: false
                )
            }
        }

        switch result {
        case .committed:
            readySelectionOwner = nil
        case .unchanged(let error):
            throw error
        case .indeterminate(let error):
            readySelectionOwner = nil
            throw error
        }
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
