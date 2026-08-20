import Combine
import Foundation
import PsycheCore

@MainActor
final class PairHostModel: ObservableObject {
    enum Phase: Equatable {
        case browsing
        case selected
        case confirmingRePair
        case connecting
        case pairing
        case loadingWorkspace
        case ready
        case failed
    }

    struct Row: Identifiable, Equatable, Sendable {
        let entry: BonjourDiscoveryEntry
        let pairingStatus: PairingStatus

        var id: String { entry.serverID }
        var serverID: String { entry.serverID }
        var serverName: String { entry.serverName }

        var resolutionFailure: BonjourResolutionFailure? {
            guard case let .resolutionFailed(failure) = entry.availability else { return nil }
            return failure
        }

        var resolvedHost: DiscoveredHost? {
            guard case let .resolved(host) = entry.availability else { return nil }
            return host
        }

        var resolvedEndpoint: HostEndpoint? { resolvedHost?.endpoint }
        var resolvedAddress: String? { resolvedEndpoint?.host }
        var resolvedPort: Int? { resolvedEndpoint?.port }
    }

    struct Dependencies: Sendable {
        let startDiscovery: @Sendable () async -> AsyncStream<[BonjourDiscoveryEntry]>
        let stopDiscovery: @Sendable () async -> Void
        let retryDiscovery: @Sendable (String) async -> Void
        let pairingStatus: @Sendable (String, String) async throws -> PairingStatus
        let connectPaired: @Sendable (String, HostEndpoint?) async throws -> PairedHost
        let connectForPairing: @Sendable (HostEndpoint) async throws -> Void
        let pair: @Sendable (String) async throws -> PairedHost
        let waitForWorkspaceReady: @Sendable () async throws -> Void
        let disconnect: @Sendable () async -> Void
    }

    @Published private(set) var rows: [Row] = []
    @Published private(set) var phase: Phase = .browsing
    @Published private(set) var errorMessage: String?
    @Published private(set) var readyHost: PairedHost?
    @Published private(set) var selectedServerID: String?
    @Published var showManualEntry = false
    @Published var manualHost = ""
    @Published var manualPort = ""
    @Published var manualFingerprint = ""
    @Published var pairingCode = ""
    @Published private(set) var retryingServerIDs: Set<String> = []

    let dependencies: Dependencies

    private enum FailureSource {
        case discovery
        case validation
        case action
    }

    private var observationTask: Task<Void, Never>?
    private var actionTask: Task<Void, Never>?
    private var retryTasks: [String: Task<Void, Never>] = [:]
    private var hasStarted = false
    private var hasStopped = false
    private var observationGeneration: UInt64 = 0
    private var activeActionID: UUID?
    private var actionOwnedServerID: String?
    private var failureSource: FailureSource?
    private var ownsIncompleteConnection = false

    init(dependencies: Dependencies) {
        self.dependencies = dependencies
    }

    convenience init(composition: MobileAppComposition) {
        self.init(dependencies: Dependencies(
            startDiscovery: {
                await composition.bonjourHostDiscovery.start()
            },
            stopDiscovery: {
                await composition.bonjourHostDiscovery.stop()
            },
            retryDiscovery: { serverID in
                await composition.bonjourHostDiscovery.retry(serverID: serverID)
            },
            pairingStatus: { serverID, fingerprint in
                try await composition.pairedHostStore.pairingStatus(
                    forServerID: serverID,
                    certificateFingerprint: fingerprint
                )
            },
            connectPaired: { serverID, endpoint in
                try await composition.connectionManager.connectToPairedHost(
                    serverID: serverID,
                    resolvedEndpoint: endpoint
                )
            },
            connectForPairing: { endpoint in
                try await composition.connectionManager.connectForPairing(to: endpoint)
            },
            pair: { code in
                try await composition.connectionManager.pair(code: code)
            },
            waitForWorkspaceReady: {
                try await composition.connectionManager.waitForWorkspaceReady()
            },
            disconnect: {
                await composition.connectionManager.disconnect()
            }
        ))
    }

    deinit {
        observationTask?.cancel()
        actionTask?.cancel()
        retryTasks.values.forEach { $0.cancel() }
    }

    func start() async {
        guard !hasStarted else { return }
        hasStarted = true
        hasStopped = false
        observationGeneration &+= 1
        let generation = observationGeneration
        let stream = await dependencies.startDiscovery()
        observationTask = Task { [weak self] in
            await self?.observeDiscovery(stream, generation: generation)
        }
    }

    func stop() async {
        guard hasStarted, !hasStopped else { return }
        hasStopped = true
        observationGeneration &+= 1
        observationTask?.cancel()
        observationTask = nil

        actionTask?.cancel()
        actionTask = nil
        activeActionID = nil
        actionOwnedServerID = nil

        retryTasks.values.forEach { $0.cancel() }
        retryTasks.removeAll()
        retryingServerIDs.removeAll()

        pairingCode = ""

        let shouldDisconnect = ownsIncompleteConnection && phase != .ready
        if shouldDisconnect {
            await dependencies.disconnect()
            ownsIncompleteConnection = false
        }

        await dependencies.stopDiscovery()
    }

    func select(serverID: String) {
        guard rows.contains(where: { $0.serverID == serverID }) else { return }
        selectedServerID = serverID
        showManualEntry = false
        clearNonReadyError()
        if phase != .ready {
            phase = .selected
        }
    }

    func retry(serverID: String) {
        guard retryTasks[serverID] == nil else { return }
        retryingServerIDs.insert(serverID)
        let dependencies = self.dependencies
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                retryTasks[serverID] = nil
                retryingServerIDs.remove(serverID)
            }
            await dependencies.retryDiscovery(serverID)
        }
        retryTasks[serverID] = task
    }

    func submit() async {
        if showManualEntry {
            do {
                let endpoint = try validatedManualEndpoint()
                let code = try validatedPairingCode()
                await enqueueAction(owningServerID: nil) { [endpoint, code] actionID in
                    await self.performPairingFlow(
                        endpoint: endpoint,
                        code: code,
                        actionID: actionID
                    )
                }
            } catch {
                applyFailure(error, source: .validation, clearPairingCode: false)
            }
            return
        }

        guard let selectedServerID else {
            applyFailure(PairHostModelError.chooseHostOrManual, source: .validation, clearPairingCode: false)
            return
        }

        guard let row = rows.first(where: { $0.serverID == selectedServerID }) else {
            applyFailure(PairHostModelError.selectedHostUnavailable, source: .validation, clearPairingCode: false)
            return
        }

        guard row.resolutionFailure == nil else {
            applyFailure(PairHostModelError.resolutionFailed, source: .validation, clearPairingCode: false)
            return
        }

        switch row.pairingStatus {
        case .paired:
            await enqueueAction(owningServerID: row.serverID) { actionID in
                await self.performPairedConnect(row: row, actionID: actionID)
            }
        case .unpaired:
            do {
                let code = try validatedPairingCode()
                guard let endpoint = row.resolvedEndpoint else {
                    applyFailure(PairHostModelError.selectedHostUnavailable, source: .validation, clearPairingCode: false)
                    return
                }
                await enqueueAction(owningServerID: row.serverID) { [endpoint, code] actionID in
                    await self.performPairingFlow(
                        endpoint: endpoint,
                        code: code,
                        actionID: actionID
                    )
                }
            } catch {
                applyFailure(error, source: .validation, clearPairingCode: false)
            }
        case .requiresRePairing:
            clearNonReadyError()
            phase = .confirmingRePair
        }
    }

    func confirmRePairing() async {
        guard phase == .confirmingRePair else { return }
        guard let selectedServerID,
              let row = rows.first(where: { $0.serverID == selectedServerID }),
              let endpoint = row.resolvedEndpoint else {
            applyFailure(PairHostModelError.rePairingUnavailable, source: .validation, clearPairingCode: false)
            return
        }

        do {
            let code = try validatedPairingCode()
            await enqueueAction(owningServerID: row.serverID) { [endpoint, code] actionID in
                await self.performPairingFlow(
                    endpoint: endpoint,
                    code: code,
                    actionID: actionID
                )
            }
        } catch {
            applyFailure(error, source: .validation, clearPairingCode: false)
        }
    }

    func cancelRePairingConfirmation() {
        guard phase == .confirmingRePair else { return }
        clearNonReadyError()
        phase = selectedServerID == nil ? .browsing : .selected
    }

    private func observeDiscovery(
        _ stream: AsyncStream<[BonjourDiscoveryEntry]>,
        generation: UInt64
    ) async {
        for await snapshot in stream {
            guard !Task.isCancelled else { return }
            do {
                let rows = try await makeRows(from: snapshot)
                guard generation == observationGeneration else { return }
                applyDiscoveryRows(rows, snapshotServerIDs: Set(snapshot.map(\.serverID)))
            } catch is CancellationError {
                return
            } catch {
                guard generation == observationGeneration else { return }
                applyDiscoveryFailure(error)
            }
        }
    }

    private func makeRows(from snapshot: [BonjourDiscoveryEntry]) async throws -> [Row] {
        let dependencies = self.dependencies
        return try await withThrowingTaskGroup(of: Row.self) { group in
            for entry in snapshot {
                group.addTask {
                    let status = try await dependencies.pairingStatus(
                        entry.serverID,
                        entry.identity.certificateFingerprint
                    )
                    return Row(entry: entry, pairingStatus: status)
                }
            }

            var rows: [Row] = []
            for try await row in group {
                rows.append(row)
            }
            return rows.sorted { $0.serverID < $1.serverID }
        }
    }

    private func applyDiscoveryRows(
        _ rows: [Row],
        snapshotServerIDs: Set<String>
    ) {
        self.rows = rows

        if let selectedServerID,
           !snapshotServerIDs.contains(selectedServerID),
           !ownsSelectionDuringAction(selectedServerID) {
            self.selectedServerID = nil
            if phase != .ready {
                phase = .browsing
            }
        }

        if failureSource == .discovery, actionTask == nil, phase != .ready {
            errorMessage = nil
            failureSource = nil
            phase = self.selectedServerID == nil ? .browsing : .selected
        }
    }

    private func applyDiscoveryFailure(_ error: Error) {
        guard actionTask == nil else { return }
        errorMessage = sanitizedMessage(for: error)
        failureSource = .discovery
        phase = .failed
    }

    private func enqueueAction(
        owningServerID: String?,
        operation: @escaping @MainActor (UUID) async -> Void
    ) async {
        guard actionTask == nil else { return }
        let actionID = UUID()
        activeActionID = actionID
        actionOwnedServerID = owningServerID
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                if activeActionID == actionID {
                    actionTask = nil
                    activeActionID = nil
                    actionOwnedServerID = nil
                }
            }
            await operation(actionID)
        }
        actionTask = task
        await task.value
    }

    private func performPairedConnect(
        row: Row,
        actionID: UUID
    ) async {
        guard beginAction(actionID: actionID, phase: .connecting) else { return }
        do {
            let host = try await dependencies.connectPaired(row.serverID, row.resolvedEndpoint)
            guard continueAction(actionID) else { return }
            ownsIncompleteConnection = true
            phase = .loadingWorkspace
            try await dependencies.waitForWorkspaceReady()
            guard continueAction(actionID) else { return }
            ownsIncompleteConnection = false
            readyHost = host
            phase = .ready
        } catch is CancellationError {
            return
        } catch {
            guard continueAction(actionID) else { return }
            applyFailure(error, source: .action, clearPairingCode: false)
        }
    }

    private func performPairingFlow(
        endpoint: HostEndpoint,
        code: String,
        actionID: UUID
    ) async {
        guard beginAction(actionID: actionID, phase: .connecting) else { return }
        do {
            try await dependencies.connectForPairing(endpoint)
            guard continueAction(actionID) else { return }
            ownsIncompleteConnection = true
            phase = .pairing
            let host = try await dependencies.pair(code)
            guard continueAction(actionID) else { return }
            phase = .loadingWorkspace
            try await dependencies.waitForWorkspaceReady()
            guard continueAction(actionID) else { return }
            ownsIncompleteConnection = false
            pairingCode = ""
            readyHost = host
            phase = .ready
        } catch is CancellationError {
            return
        } catch {
            guard continueAction(actionID) else { return }
            applyFailure(error, source: .action, clearPairingCode: true)
        }
    }

    private func beginAction(
        actionID: UUID,
        phase nextPhase: Phase
    ) -> Bool {
        guard activeActionID == actionID else { return false }
        readyHost = nil
        errorMessage = nil
        failureSource = nil
        phase = nextPhase
        return true
    }

    private func continueAction(_ actionID: UUID) -> Bool {
        activeActionID == actionID && !Task.isCancelled
    }

    private func applyFailure(
        _ error: Error,
        source: FailureSource,
        clearPairingCode: Bool
    ) {
        if clearPairingCode {
            pairingCode = ""
        }
        readyHost = nil
        errorMessage = sanitizedMessage(for: error)
        failureSource = source
        phase = .failed
    }

    private func clearNonReadyError() {
        errorMessage = nil
        failureSource = nil
        if phase == .failed {
            phase = selectedServerID == nil ? .browsing : .selected
        }
    }

    private func ownsSelectionDuringAction(_ serverID: String) -> Bool {
        actionOwnedServerID == serverID && activeActionID != nil
    }

    private func validatedManualEndpoint() throws -> HostEndpoint {
        let host = manualHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !host.isEmpty else { throw PairHostModelError.manualHostRequired }
        guard !host.contains(where: \.isWhitespace) else {
            throw PairHostModelError.manualHostContainsWhitespace
        }

        let portText = manualPort.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let port = Int(portText), (1...65_535).contains(port) else {
            throw PairHostModelError.manualPortInvalid
        }

        let fingerprintText = manualFingerprint.trimmingCharacters(in: .whitespacesAndNewlines)
        let fingerprint: String
        do {
            fingerprint = try PinnedCertificateDelegate.normalizeFingerprint(fingerprintText)
        } catch {
            throw PairHostModelError.manualFingerprintInvalid
        }

        manualHost = host
        manualPort = String(port)
        manualFingerprint = fingerprint

        return HostEndpoint(
            host: host,
            port: port,
            certificateFingerprint: fingerprint
        )
    }

    private func validatedPairingCode() throws -> String {
        let code = pairingCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard code.count == 6, code.allSatisfy(\.isWholeNumber) else {
            throw PairHostModelError.pairingCodeInvalid
        }
        return code
    }

    private func sanitizedMessage(for error: Error) -> String {
        let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        return message.isEmpty ? PairHostModelError.generic.localizedDescription : message
    }
}

private enum PairHostModelError: LocalizedError {
    case chooseHostOrManual
    case selectedHostUnavailable
    case rePairingUnavailable
    case resolutionFailed
    case manualHostRequired
    case manualHostContainsWhitespace
    case manualPortInvalid
    case manualFingerprintInvalid
    case pairingCodeInvalid
    case generic

    var errorDescription: String? {
        switch self {
        case .chooseHostOrManual:
            "Choose a discovered host or enter a host manually."
        case .selectedHostUnavailable:
            "Choose a host that is still available, or use manual entry."
        case .rePairingUnavailable:
            "This host is no longer ready to re-pair. Retry discovery or use manual entry."
        case .resolutionFailed:
            "This host could not be resolved. Use Retry for this row or switch to manual entry."
        case .manualHostRequired:
            "Enter the host name or IP address."
        case .manualHostContainsWhitespace:
            "Host names and IP addresses cannot contain spaces."
        case .manualPortInvalid:
            "Enter a port number between 1 and 65535."
        case .manualFingerprintInvalid:
            "Enter the host certificate fingerprint exactly as shown by the host."
        case .pairingCodeInvalid:
            "The pairing code must contain exactly six digits."
        case .generic:
            "The host connection could not be completed."
        }
    }
}
