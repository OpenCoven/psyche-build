import Combine
import Foundation
import PsycheCore

enum PairHostDiscriminatorFormatter {
    static func format(serverID: String, endpoint: HostEndpoint?) -> String {
        let suffix = serverIDSuffix(for: serverID)
        guard let endpoint else { return suffix }
        return "\(endpoint.host):\(endpoint.port) • \(suffix)"
    }

    static func format(host: PairedHost) -> String {
        format(serverID: host.serverID, endpoint: host.endpoint)
    }

    private static func serverIDSuffix(for serverID: String) -> String {
        let suffix = String(serverID.suffix(6))
        return suffix.count == serverID.count ? suffix : "…\(suffix)"
    }
}

@MainActor
final class PairHostModel: ObservableObject {
    actor SessionAuthority {
        private enum State {
            case idle
            case active(UInt64)
            case ending(UInt64)
        }

        private let beforeClaimActivation: (@Sendable () async -> Void)?
        private var nextSessionID: UInt64 = 0
        private var state: State = .idle
        private var endingWaiters: [CheckedContinuation<Void, Never>] = []

        init(beforeClaimActivation: (@Sendable () async -> Void)? = nil) {
            self.beforeClaimActivation = beforeClaimActivation
        }

        func claimSession() async -> UInt64 {
            while case .ending(_) = state {
                await withCheckedContinuation { continuation in
                    endingWaiters.append(continuation)
                }
            }

            if let beforeClaimActivation {
                await beforeClaimActivation()
            }
            nextSessionID &+= 1
            state = .active(nextSessionID)
            return nextSessionID
        }

        func relinquishIfCurrent(_ sessionID: UInt64) async {
            await endIfCurrent(sessionID) {}
        }

        func endIfCurrent(
            _ sessionID: UInt64,
            perform operation: @Sendable () async -> Void
        ) async {
            guard case let .active(currentSessionID) = state, currentSessionID == sessionID else { return }
            state = .ending(sessionID)
            await operation()
            guard case let .ending(endingSessionID) = state, endingSessionID == sessionID else { return }
            state = .idle
            let waiters = endingWaiters
            endingWaiters.removeAll()
            waiters.forEach { $0.resume() }
        }
    }

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
        var discriminator: String {
            PairHostDiscriminatorFormatter.format(serverID: serverID, endpoint: resolvedEndpoint)
        }

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

    private enum SubmitTarget: Equatable {
        case none
        case manual
        case selectedUnavailable
        case unavailable(Row)
        case paired(Row)
        case unpaired(Row)
        case requiresRePairing(Row)

        var row: Row? {
            switch self {
            case let .unavailable(row), let .paired(row), let .unpaired(row), let .requiresRePairing(row):
                return row
            case .none, .manual, .selectedUnavailable:
                return nil
            }
        }

        var actionTitle: String {
            switch self {
            case .none, .selectedUnavailable, .paired:
                return "Connect"
            case .manual, .unpaired:
                return "Pair"
            case .requiresRePairing:
                return "Review re-pair warning"
            case .unavailable:
                return "Address unavailable"
            }
        }

        var selectedMessage: String? {
            switch self {
            case .unavailable:
                return "This host was discovered, but its network address is unavailable right now."
            case let .paired(row):
                return "This device already trusts \(row.serverName)."
            case let .unpaired(row):
                return "Enter the six-digit code shown by \(row.serverName) to trust and connect to it."
            case .requiresRePairing:
                return "Enter a new code, then review the certificate-change warning before re-pairing."
            case .none, .manual, .selectedUnavailable:
                return nil
            }
        }

        var requiresPairingCode: Bool {
            switch self {
            case .manual, .unpaired, .requiresRePairing:
                return true
            case .none, .selectedUnavailable, .unavailable, .paired:
                return false
            }
        }

        var canSubmitWhenIdle: Bool {
            switch self {
            case .manual, .paired, .unpaired, .requiresRePairing:
                return true
            case .none, .selectedUnavailable, .unavailable:
                return false
            }
        }

        var showsRePairWarning: Bool {
            if case .requiresRePairing = self {
                return true
            }
            return false
        }
    }

    private struct DeinitCleanupPlan: Sendable {
        let authority: SessionAuthority
        let sessionID: UInt64?
        let shouldStopDiscovery: Bool
        let shouldDisconnect: Bool
        let stopDiscovery: @Sendable () async -> Void
        let disconnect: @Sendable () async -> Void

        func launchIfNeeded() {
            guard let sessionID, shouldStopDiscovery || shouldDisconnect else { return }
            Task.detached(
                priority: .utility,
                operation: { [authority, sessionID, shouldStopDiscovery, shouldDisconnect, stopDiscovery, disconnect] in
                    await authority.endIfCurrent(sessionID) {
                        if shouldStopDiscovery {
                            await stopDiscovery()
                        }
                        if shouldDisconnect {
                            await disconnect()
                        }
                    }
                }
            )
        }
    }

    @Published private(set) var rows: [Row] = []
    @Published private(set) var phase: Phase = .browsing
    @Published private(set) var errorMessage: String?
    @Published private(set) var readyHost: PairedHost?
    @Published private(set) var selectedServerID: String?
    @Published private(set) var showManualEntry = false
    @Published var manualHost = ""
    @Published var manualPort = ""
    @Published var manualFingerprint = ""
    @Published var pairingCode = ""
    @Published private(set) var retryingServerIDs: Set<String> = []

    var selectedRow: Row? { selectedSubmitTarget.row }
    var selectedRequiresPairingCode: Bool { selectedSubmitTarget.requiresPairingCode }
    var selectedActionMessage: String? { selectedSubmitTarget.selectedMessage }
    var selectedShowsRePairWarning: Bool { selectedSubmitTarget.showsRePairWarning }
    var showsPairingCodeField: Bool { primarySubmitTarget.requiresPairingCode }
    var canSubmitSelectedAction: Bool { !isActionInProgress && selectedSubmitTarget.canSubmitWhenIdle }
    var canSubmitPrimaryAction: Bool { !isActionInProgress && primarySubmitTarget.canSubmitWhenIdle }
    var primaryActionTitle: String { primarySubmitTarget.actionTitle }

    var isActionInProgress: Bool {
        switch phase {
        case .connecting, .pairing, .loadingWorkspace:
            return true
        case .browsing, .selected, .confirmingRePair, .ready, .failed:
            return false
        }
    }

    let dependencies: Dependencies

    private let sessionAuthority: SessionAuthority

    private enum FailureSource {
        case discovery
        case validation
        case action
    }

    private var observationTask: Task<Void, Never>?
    private var actionTask: Task<Void, Never>?
    private var startTask: Task<Void, Never>?
    private var stopTask: Task<Void, Never>?
    private var retryTasks: [String: Task<Void, Never>] = [:]
    private var hasStarted = false
    private var hasStopped = false
    private var observationGeneration: UInt64 = 0
    private var activeActionID: UUID?
    private var actionOwnedServerID: String?
    private var failureSource: FailureSource?
    private var ownsIncompleteConnection = false
    private var sessionID: UInt64?

    private var selectedSubmitTarget: SubmitTarget {
        guard let selectedServerID else { return .none }
        guard let row = rows.first(where: { $0.serverID == selectedServerID }) else { return .selectedUnavailable }
        if row.resolutionFailure != nil {
            return .unavailable(row)
        }
        switch row.pairingStatus {
        case .paired:
            return .paired(row)
        case .unpaired:
            return .unpaired(row)
        case .requiresRePairing:
            return .requiresRePairing(row)
        }
    }

    private var primarySubmitTarget: SubmitTarget {
        showManualEntry ? .manual : selectedSubmitTarget
    }

    var sessionAuthorityIdentity: ObjectIdentifier {
        ObjectIdentifier(sessionAuthority)
    }

    init(
        dependencies: Dependencies,
        authority: SessionAuthority = SessionAuthority()
    ) {
        self.dependencies = dependencies
        sessionAuthority = authority
    }

    static func fixture(authority: SessionAuthority = SessionAuthority()) -> PairHostModel {
        let entries = fixtureEntries()
        let entriesByServerID = Dictionary(uniqueKeysWithValues: entries.map { ($0.serverID, $0) })
        let statusByServerID: [String: PairingStatus] = [
            "studio": .paired,
            "new-host": .unpaired,
            "changed-host": .requiresRePairing,
            "offline-host": .unpaired
        ]
        let pendingPairing = FixturePendingPairing()

        return PairHostModel(dependencies: Dependencies(
            startDiscovery: {
                AsyncStream { continuation in
                    continuation.yield(entries)
                    continuation.finish()
                }
            },
            stopDiscovery: {},
            retryDiscovery: { _ in },
            pairingStatus: { serverID, _ in
                statusByServerID[serverID] ?? .unpaired
            },
            connectPaired: { serverID, endpoint in
                if let entry = entriesByServerID[serverID],
                   let resolvedEndpoint = fixtureResolvedEndpoint(for: entry) {
                    return fixturePairedHost(
                        serverID: serverID,
                        serverName: entry.serverName,
                        endpoint: endpoint ?? resolvedEndpoint
                    )
                }
                return fixturePairedHost(
                    serverID: serverID,
                    serverName: serverID,
                    endpoint: endpoint ?? fixtureManualEndpoint()
                )
            },
            connectForPairing: { endpoint in
                await pendingPairing.set(endpoint: endpoint)
            },
            pair: { _ in
                let endpoint = await pendingPairing.takeEndpoint() ?? fixtureResolvedEndpoint(
                    host: "new-host.local",
                    port: 4243,
                    fingerprint: String(repeating: "b", count: 64)
                )
                let identity = fixtureIdentity(forEndpoint: endpoint, entries: entries)
                return fixturePairedHost(
                    serverID: identity.serverID,
                    serverName: identity.serverName,
                    endpoint: endpoint
                )
            },
            waitForWorkspaceReady: {},
            disconnect: {
                await pendingPairing.clear()
            }
        ), authority: authority)
    }

    convenience init(
        composition: MobileAppComposition,
        authority: SessionAuthority = SessionAuthority()
    ) {
        let discovery = composition.bonjourHostDiscovery
        let store = composition.pairedHostStore
        let manager = composition.connectionManager
        self.init(dependencies: Dependencies(
            startDiscovery: {
                await discovery.start()
            },
            stopDiscovery: {
                await discovery.stop()
            },
            retryDiscovery: { serverID in
                await discovery.retry(serverID: serverID)
            },
            pairingStatus: { serverID, fingerprint in
                try await store.pairingStatus(
                    forServerID: serverID,
                    certificateFingerprint: fingerprint
                )
            },
            connectPaired: { serverID, endpoint in
                try await manager.connectToPairedHost(
                    serverID: serverID,
                    resolvedEndpoint: endpoint
                )
            },
            connectForPairing: { endpoint in
                try await manager.connectForPairing(to: endpoint)
            },
            pair: { code in
                try await manager.pair(code: code)
            },
            waitForWorkspaceReady: {
                try await manager.waitForWorkspaceReady()
            },
            disconnect: {
                await manager.disconnect()
            }
        ), authority: authority)
    }

    deinit {
        MainActor.assumeIsolated {
            let cleanupPlan = deinitCleanupPlan()
            cancelOwnedTasks()
            cleanupPlan.launchIfNeeded()
        }
    }

    nonisolated private static func fixtureEntries() -> [BonjourDiscoveryEntry] {
            [
                fixtureResolvedEntry(
                    serverID: "studio",
                    serverName: "Studio",
                    host: "studio.local",
                    port: 4242,
                    fingerprint: String(repeating: "a", count: 64)
                ),
                fixtureResolvedEntry(
                    serverID: "new-host",
                    serverName: "New Host",
                    host: "new-host.local",
                    port: 4243,
                    fingerprint: String(repeating: "b", count: 64)
                ),
                fixtureResolvedEntry(
                    serverID: "changed-host",
                    serverName: "Changed Host",
                    host: "changed-host.local",
                    port: 4244,
                    fingerprint: String(repeating: "c", count: 64)
                ),
                fixtureFailedEntry(
                    serverID: "offline-host",
                    serverName: "Offline Host",
                    fingerprint: String(repeating: "d", count: 64),
                    failure: .timedOut
                )
            ].sorted { $0.serverID < $1.serverID }
        }

    nonisolated private static func fixtureResolvedEntry(
            serverID: String,
            serverName: String,
            host: String,
            port: Int,
            fingerprint: String
        ) -> BonjourDiscoveryEntry {
            let identity = fixtureIdentity(
                serverID: serverID,
                serverName: serverName,
                fingerprint: fingerprint
            )
            return BonjourDiscoveryEntry(
                identity: identity,
                availability: .resolved(DiscoveredHost(
                    identity: identity,
                    endpoint: fixtureResolvedEndpoint(
                        host: host,
                        port: port,
                        fingerprint: fingerprint
                    )
                ))
            )
        }

    nonisolated private static func fixtureFailedEntry(
            serverID: String,
            serverName: String,
            fingerprint: String,
            failure: BonjourResolutionFailure
        ) -> BonjourDiscoveryEntry {
            BonjourDiscoveryEntry(
                identity: fixtureIdentity(
                    serverID: serverID,
                    serverName: serverName,
                    fingerprint: fingerprint
                ),
                availability: .resolutionFailed(failure)
            )
        }

    nonisolated private static func fixtureIdentity(
            serverID: String,
            serverName: String,
            fingerprint: String
        ) -> BonjourHostIdentity {
            BonjourHostIdentity(
                serverID: serverID,
                serverName: serverName,
                domain: "local.",
                certificateFingerprint: fingerprint,
                supportedVersions: [PsycheProtocolVersion.current]
            )
        }

    nonisolated private static func fixtureResolvedEndpoint(
            host: String,
            port: Int,
            fingerprint: String
        ) -> HostEndpoint {
            return HostEndpoint(
                host: host,
                port: port,
                certificateFingerprint: fingerprint
            )
        }

    nonisolated private static func fixtureResolvedEndpoint(for entry: BonjourDiscoveryEntry) -> HostEndpoint? {
            guard case let .resolved(host) = entry.availability else { return nil }
            return host.endpoint
        }

    nonisolated private static func fixtureManualEndpoint() -> HostEndpoint {
            HostEndpoint(
                host: "fixture.local",
                port: 4242,
                certificateFingerprint: String(repeating: "e", count: 64)
            )
        }

    nonisolated private static func fixtureIdentity(
            forEndpoint endpoint: HostEndpoint,
            entries: [BonjourDiscoveryEntry]
        ) -> (serverID: String, serverName: String) {
            if let match = entries.first(where: { fixtureResolvedEndpoint(for: $0) == endpoint }) {
                return (match.serverID, match.serverName)
            }
            return (endpoint.host, endpoint.host)
        }

    nonisolated private static func fixturePairedHost(
            serverID: String,
            serverName: String,
            endpoint: HostEndpoint
        ) -> PairedHost {
            PairedHost(
                serverID: serverID,
                serverName: serverName,
                endpoint: endpoint,
                clientID: "fixture-client",
                token: "fixture-token"
            )
        }

    private actor FixturePendingPairing {
        private var endpoint: HostEndpoint?

        func set(endpoint: HostEndpoint) {
            self.endpoint = endpoint
        }

        func takeEndpoint() -> HostEndpoint? {
            defer { endpoint = nil }
            return endpoint
        }

        func clear() {
            endpoint = nil
        }
    }

    func start() async {
        if let startTask {
            await startTask.value
            return
        }
        guard !hasStarted else { return }
        hasStarted = true
        hasStopped = false
        let authority = sessionAuthority
        let dependencies = self.dependencies
        let startTask = Task { [weak self, authority, dependencies] in
            let claimedSessionID = await authority.claimSession()
            guard let self else {
                await authority.relinquishIfCurrent(claimedSessionID)
                return
            }
            guard let generation = await self.prepareStartAfterClaim(sessionID: claimedSessionID) else {
                await authority.relinquishIfCurrent(claimedSessionID)
                return
            }

            let stream = await dependencies.startDiscovery()
            guard await self.canObserveClaimedSession(sessionID: claimedSessionID) else {
                await authority.endIfCurrent(claimedSessionID) {
                    await dependencies.stopDiscovery()
                }
                return
            }

            let observationTask = Task { [weak self, dependencies] in
                for await snapshot in stream {
                    guard !Task.isCancelled else { return }
                    do {
                        let rows = try await Self.makeRows(from: snapshot, dependencies: dependencies)
                        await self?.applyDiscoveryRowsIfCurrent(
                            rows,
                            snapshotServerIDs: Set(snapshot.map(\.serverID)),
                            generation: generation
                        )
                    } catch is CancellationError {
                        return
                    } catch {
                        await self?.applyDiscoveryFailureIfCurrent(error, generation: generation)
                    }
                }
            }
            await self.installObservationTaskIfCurrent(
                observationTask,
                sessionID: claimedSessionID
            )
        }
        self.startTask = startTask
        await awaitStartTask(startTask)
        if self.startTask != nil {
            self.startTask = nil
        }
    }

    func stop() async {
        if let stopTask {
            await stopTask.value
            return
        }
        guard hasStarted, !hasStopped else { return }
        hasStopped = true
        observationGeneration &+= 1
        let shouldDisconnect = ownsIncompleteConnection && phase != .ready
        if shouldDisconnect {
            ownsIncompleteConnection = false
        }
        let startTask = self.startTask
        cancelOwnedTasks()
        pairingCode = ""
        let dependencies = self.dependencies
        let authority = sessionAuthority
        let sessionID = self.sessionID
        let cleanupTask = Task.detached(priority: .utility) {
            [authority, dependencies, sessionID, shouldDisconnect, startTask] in
            if let sessionID {
                await authority.endIfCurrent(sessionID) {
                    await dependencies.stopDiscovery()
                    if shouldDisconnect {
                        await dependencies.disconnect()
                    }
                }
            }
            if let startTask {
                await startTask.value
            }
        }
        stopTask = cleanupTask
        await cleanupTask.value
        self.sessionID = nil
        stopTask = nil
    }

    func select(serverID: String) {
        guard activeActionID == nil else { return }
        guard rows.contains(where: { $0.serverID == serverID }) else { return }
        selectedServerID = serverID
        showManualEntry = false
        clearNonReadyError()
        if phase != .ready {
            phase = .selected
        }
    }

    func setManualEntrySelected(_ isSelected: Bool) {
        guard activeActionID == nil else { return }
        guard showManualEntry != isSelected || (isSelected && selectedServerID != nil) else { return }
        showManualEntry = isSelected
        if isSelected {
            selectedServerID = nil
        }
        clearNonReadyError()
        if phase != .ready {
            phase = selectedServerID == nil ? .browsing : .selected
        }
    }

    func retry(serverID: String) {
        guard retryTasks[serverID] == nil else { return }
        retryingServerIDs.insert(serverID)
        let dependencies = self.dependencies
        let task = Task { [weak self] in
            defer {
                Task { @MainActor [weak self] in
                    self?.finishRetry(serverID: serverID)
                }
            }
            await dependencies.retryDiscovery(serverID)
        }
        retryTasks[serverID] = task
    }

    func submit() async {
        switch primarySubmitTarget {
        case .manual:
            do {
                let endpoint = try validatedManualEndpoint()
                let code = try validatedPairingCode()
                await enqueuePairingFlow(
                    endpoint: endpoint,
                    code: code,
                    owningServerID: nil
                )
            } catch {
                applyFailure(error, source: .validation, clearPairingCode: shouldClearPairingCode(for: error))
            }
        case .none:
            applyFailure(PairHostModelError.chooseHostOrManual, source: .validation, clearPairingCode: false)
        case .selectedUnavailable:
            applyFailure(PairHostModelError.selectedHostUnavailable, source: .validation, clearPairingCode: false)
        case .unavailable:
            applyFailure(PairHostModelError.resolutionFailed, source: .validation, clearPairingCode: false)
        case let .paired(row):
            await enqueuePairedConnect(row: row)
        case let .unpaired(row):
            do {
                let code = try validatedPairingCode()
                guard let endpoint = row.resolvedEndpoint else {
                    applyFailure(PairHostModelError.selectedHostUnavailable, source: .validation, clearPairingCode: false)
                    return
                }
                await enqueuePairingFlow(
                    endpoint: endpoint,
                    code: code,
                    owningServerID: row.serverID
                )
            } catch {
                applyFailure(error, source: .validation, clearPairingCode: shouldClearPairingCode(for: error))
            }
        case .requiresRePairing:
            clearNonReadyError()
            phase = .confirmingRePair
        }
    }

    func confirmRePairing() async {
        guard phase == .confirmingRePair else { return }
        guard case let .requiresRePairing(row) = selectedSubmitTarget,
              let endpoint = row.resolvedEndpoint else {
            applyFailure(PairHostModelError.rePairingUnavailable, source: .validation, clearPairingCode: false)
            return
        }

        do {
            let code = try validatedPairingCode()
            await enqueuePairingFlow(
                endpoint: endpoint,
                code: code,
                owningServerID: row.serverID
            )
        } catch {
            applyFailure(error, source: .validation, clearPairingCode: shouldClearPairingCode(for: error))
        }
    }

    func cancelRePairingConfirmation() {
        guard phase == .confirmingRePair else { return }
        clearNonReadyError()
        phase = selectedServerID == nil ? .browsing : .selected
    }

    private static func makeRows(
        from snapshot: [BonjourDiscoveryEntry],
        dependencies: Dependencies
    ) async throws -> [Row] {
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

    private func enqueuePairedConnect(row: Row) async {
        guard actionTask == nil else { return }
        let actionID = UUID()
        beginQueuedAction(actionID: actionID, owningServerID: row.serverID, phase: .connecting)
        let dependencies = self.dependencies
        let task = Task { [weak self] in
            defer {
                Task { @MainActor [weak self] in
                    self?.finishAction(actionID: actionID)
                }
            }
            do {
                guard await self?.transitionAction(
                    actionID: actionID,
                    ownsIncompleteConnection: true
                ) == true else {
                    return
                }
                let host = try await dependencies.connectPaired(row.serverID, row.resolvedEndpoint)
                guard await self?.transitionAction(
                    actionID: actionID,
                    phase: .loadingWorkspace
                ) == true else {
                    return
                }
                try await dependencies.waitForWorkspaceReady()
                await self?.completeAction(
                    actionID: actionID,
                    host: host,
                    clearsPairingCode: false
                )
            } catch is CancellationError {
                return
            } catch {
                await self?.failActionIfCurrent(
                    actionID: actionID,
                    error: error,
                    clearPairingCode: false
                )
            }
        }
        actionTask = task
        await awaitActionTask(task)
    }

    private func enqueuePairingFlow(
        endpoint: HostEndpoint,
        code: String,
        owningServerID: String?
    ) async {
        guard actionTask == nil else { return }
        let actionID = UUID()
        beginQueuedAction(actionID: actionID, owningServerID: owningServerID, phase: .connecting)
        let dependencies = self.dependencies
        let task = Task { [weak self] in
            defer {
                Task { @MainActor [weak self] in
                    self?.finishAction(actionID: actionID)
                }
            }
            do {
                guard await self?.transitionAction(
                    actionID: actionID,
                    ownsIncompleteConnection: true
                ) == true else {
                    return
                }
                try await dependencies.connectForPairing(endpoint)
                guard await self?.transitionAction(
                    actionID: actionID,
                    phase: .pairing
                ) == true else {
                    return
                }
                let host = try await dependencies.pair(code)
                guard await self?.transitionAction(actionID: actionID, phase: .loadingWorkspace) == true else {
                    return
                }
                try await dependencies.waitForWorkspaceReady()
                await self?.completeAction(
                    actionID: actionID,
                    host: host,
                    clearsPairingCode: true
                )
            } catch is CancellationError {
                return
            } catch {
                await self?.failActionIfCurrent(
                    actionID: actionID,
                    error: error,
                    clearPairingCode: true
                )
            }
        }
        actionTask = task
        await awaitActionTask(task)
    }

    private func beginQueuedAction(
        actionID: UUID,
        owningServerID: String?,
        phase nextPhase: Phase
    ) {
        activeActionID = actionID
        actionOwnedServerID = owningServerID
        readyHost = nil
        errorMessage = nil
        failureSource = nil
        phase = nextPhase
    }

    private func awaitActionTask(_ task: Task<Void, Never>) async {
        await withTaskCancellationHandler {
            await task.value
        } onCancel: {
            task.cancel()
        }
    }

    private func awaitStartTask(_ task: Task<Void, Never>) async {
        await withTaskCancellationHandler {
            await task.value
        } onCancel: {
            task.cancel()
        }
    }

    private func transitionAction(
        actionID: UUID,
        phase nextPhase: Phase? = nil,
        ownsIncompleteConnection: Bool? = nil
    ) -> Bool {
        guard activeActionID == actionID else { return false }
        if let ownsIncompleteConnection {
            self.ownsIncompleteConnection = ownsIncompleteConnection
        }
        if let nextPhase {
            phase = nextPhase
        }
        return !Task.isCancelled
    }

    private func completeAction(
        actionID: UUID,
        host: PairedHost,
        clearsPairingCode: Bool
    ) {
        guard activeActionID == actionID else { return }
        ownsIncompleteConnection = false
        if clearsPairingCode {
            pairingCode = ""
        }
        readyHost = host
        phase = .ready
    }

    private func failActionIfCurrent(
        actionID: UUID,
        error: Error,
        clearPairingCode: Bool
    ) {
        guard activeActionID == actionID else { return }
        applyFailure(error, source: .action, clearPairingCode: clearPairingCode)
    }

    private func finishAction(actionID: UUID) {
        guard activeActionID == actionID else { return }
        actionTask = nil
        activeActionID = nil
        actionOwnedServerID = nil
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

    private func finishRetry(serverID: String) {
        retryTasks[serverID] = nil
        retryingServerIDs.remove(serverID)
    }

    private func applyDiscoveryRowsIfCurrent(
        _ rows: [Row],
        snapshotServerIDs: Set<String>,
        generation: UInt64
    ) {
        guard generation == observationGeneration else { return }
        applyDiscoveryRows(rows, snapshotServerIDs: snapshotServerIDs)
    }

    private func applyDiscoveryFailureIfCurrent(
        _ error: Error,
        generation: UInt64
    ) {
        guard generation == observationGeneration else { return }
        applyDiscoveryFailure(error)
    }

    private func deinitCleanupPlan() -> DeinitCleanupPlan {
        DeinitCleanupPlan(
            authority: sessionAuthority,
            sessionID: sessionID,
            shouldStopDiscovery: hasStarted && !hasStopped,
            shouldDisconnect: ownsIncompleteConnection && phase != .ready,
            stopDiscovery: dependencies.stopDiscovery,
            disconnect: dependencies.disconnect
        )
    }

    private func cancelOwnedTasks() {
        startTask?.cancel()
        startTask = nil
        observationTask?.cancel()
        observationTask = nil
        actionTask?.cancel()
        actionTask = nil
        activeActionID = nil
        actionOwnedServerID = nil
        retryTasks.values.forEach { $0.cancel() }
        retryTasks.removeAll()
        retryingServerIDs.removeAll()
    }

    private func prepareStartAfterClaim(sessionID claimedSessionID: UInt64) -> UInt64? {
        guard !hasStopped, !Task.isCancelled else { return nil }
        sessionID = claimedSessionID
        observationGeneration &+= 1
        return observationGeneration
    }

    private func canObserveClaimedSession(sessionID claimedSessionID: UInt64) -> Bool {
        guard !hasStopped, !Task.isCancelled else { return false }
        return sessionID == claimedSessionID
    }

    private func installObservationTaskIfCurrent(
        _ task: Task<Void, Never>,
        sessionID claimedSessionID: UInt64
    ) {
        guard canObserveClaimedSession(sessionID: claimedSessionID) else {
            task.cancel()
            return
        }
        observationTask = task
    }

    private func shouldClearPairingCode(for error: Error) -> Bool {
        guard let error = error as? PairHostModelError else { return false }
        guard case .pairingCodeInvalid = error else { return false }
        return true
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
