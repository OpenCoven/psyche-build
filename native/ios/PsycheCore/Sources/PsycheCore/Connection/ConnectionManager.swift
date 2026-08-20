import Foundation

final class ConnectionGeneration: @unchecked Sendable {
    let id: UInt64

    private let lock = NSLock()
    private var isValid = true

    init(id: UInt64) {
        self.id = id
    }

    func invalidate() {
        lock.withLock {
            isValid = false
        }
    }

    func withValidity<T>(_ operation: () throws -> T) rethrows -> T? {
        try lock.withLock {
            guard isValid else { return nil }
            return try operation()
        }
    }
}

/// Revocable authority for the one secure-store write associated with a
/// pairing attempt. It is deliberately separate from a connection generation:
/// a cancelled attempt must not be able to commit while that connection is
/// still otherwise live.
final class PairingPersistenceAuthorization: @unchecked Sendable {
    private let lock = NSLock()
    private var isAuthorized = true

    func revoke() {
        lock.withLock {
            isAuthorized = false
        }
    }

    var authorized: Bool {
        lock.withLock { isAuthorized }
    }

    func withAuthorization<T>(_ operation: () throws -> T) rethrows -> T? {
        try lock.withLock {
            guard isAuthorized else { return nil }
            return try operation()
        }
    }
}

public enum ConnectionManagerError: Error, Sendable, Equatable, LocalizedError {
    case missingWelcomeIdentity
    case selectedHostUnavailable(serverID: String)
    case connectionFailed(reason: String)
    case workspaceReadinessUnavailable
    case unsupportedProtocolVersion(Int)
    case messageProcessorEndedBeforeReady
    case connectionCancelled
    case unexpectedSnapshotResponse(String)

    public var errorDescription: String? {
        switch self {
        case .missingWelcomeIdentity:
            "The host accepted pairing before identifying itself."
        case .selectedHostUnavailable(let serverID):
            "The paired host \(serverID) is no longer available on this device. Choose another paired host or pair it again."
        case .connectionFailed(let reason):
            "The connection failed: \(reason)"
        case .workspaceReadinessUnavailable:
            "This connection no longer has a workspace snapshot. Reconnect to the host and wait for it to finish loading."
        case .unsupportedProtocolVersion(let version):
            "The host selected unsupported mobile protocol version \(version)."
        case .messageProcessorEndedBeforeReady:
            "The connection ended before its message processor became ready."
        case .connectionCancelled:
            "The connection was cancelled before its message processor became ready."
        case .unexpectedSnapshotResponse(let requestID):
            "The host returned an unexpected response to snapshot request \(requestID)."
        }
    }
}

public enum PairingError: Error, Sendable, Equatable, LocalizedError {
    case notConnected
    case alreadyInProgress
    case rejected(reason: String)
    case connectionChanged
    case cancelled
    case reconnectRequired

    public var errorDescription: String? {
        switch self {
        case .notConnected:
            "Connect to a host before pairing."
        case .alreadyInProgress:
            "A pairing request is already in progress."
        case .rejected(let reason):
            "The host rejected pairing: \(reason)"
        case .connectionChanged:
            "The connection changed before pairing completed."
        case .cancelled:
            "Pairing was cancelled."
        case .reconnectRequired:
            "Reconnect to the host before pairing again."
        }
    }
}

public actor ConnectionManager {
    public private(set) var state: ConnectionState = .disconnected
    public private(set) var stateHistory: [ConnectionState] = [.disconnected]
    public private(set) var projects: [Project] = []
    public private(set) var panes: [PaneSnapshot] = []
    public private(set) var latestOutputByPane: [String: PaneOutputPayload] = [:]
    public nonisolated let requestClient: ControlRequestClient

    private let transport: any PsycheTransport
    private let workspaceStore: WorkspaceStore
    private let pairedHostStore: PairedHostStore
    private let messageProcessorStart: @Sendable () async -> Void
    private let snapshotRequestFailureStart: @Sendable () async -> Void
    private let manualCredentials: ConnectionCredentials
    private var activeConnection: ConnectionConfiguration?
    private var pendingReadyHost: PairedHost?
    private var workspaceReadyGeneration: ConnectionGeneration?
    private var workspaceReadinessWaiters: [UUID: (
        generation: ConnectionGeneration,
        continuation: CheckedContinuation<Void, any Error>
    )] = [:]
    private let clientName: String
    private var welcomeIdentity: WelcomeIdentity?
    private var pairingWaiter: PairingWaiter?
    private var pairingRequiresReconnect = false
    private var messageTask: Task<Void, Never>?
    private var snapshotRequestTask: Task<Void, Never>?
    private var nextConnectionGeneration: UInt64 = 0
    private var activeGeneration: ConnectionGeneration?
    private var activeConnectAttempt: UUID?
    private var connectExecutionOwner: UUID?
    private var activeTeardown: UUID?
    private var teardownWaiters: [UUID: CheckedContinuation<Void, Never>] = [:]
    private var lifecycleIntentEpoch: UInt64 = 0
    private var teardownFinalStateOverride: ConnectionState?
    private var activeMessageSession: UUID?
    private var activeSnapshotRequest: SnapshotRequestState?
    private var transportCleanupGeneration: ConnectionGeneration?
    private var hasActiveTransport = false
    private var requestedInitialSnapshot = false
    private var isSnapshotRecoveryInFlight = false
    private var isMessageProcessorReady = false
    private var hasNegotiatedV3 = false
    private var messageProcessorReadyWaiters:
        [UUID: [CheckedContinuation<Void, any Error>]] = [:]
    private var negotiationWaiters:
        [UUID: [CheckedContinuation<Void, any Error>]] = [:]
    private var processedMessageCount = 0
    private var eventDrainWaiters: [UUID: (count: Int, continuation: CheckedContinuation<Void, Never>)] = [:]
    private var stateWaiters: [UUID: (state: ConnectionState, continuation: CheckedContinuation<Void, Never>)] = [:]

    public init(
        transport: any PsycheTransport,
        workspaceStore: WorkspaceStore,
        requestClient: ControlRequestClient,
        pairedHostStore: PairedHostStore,
        clientID: String = UUID().uuidString,
        clientName: String = "Psyche iOS",
        token: String? = nil,
        messageProcessorStart: @escaping @Sendable () async -> Void = {},
        snapshotRequestFailureStart: @escaping @Sendable () async -> Void = {}
    ) {
        self.transport = transport
        self.workspaceStore = workspaceStore
        self.requestClient = requestClient
        self.pairedHostStore = pairedHostStore
        self.manualCredentials = ConnectionCredentials(
            clientID: clientID,
            token: token
        )
        self.clientName = clientName
        self.messageProcessorStart = messageProcessorStart
        self.snapshotRequestFailureStart = snapshotRequestFailureStart
    }

    deinit {
        messageTask?.cancel()
        snapshotRequestTask?.cancel()
        for continuation in messageProcessorReadyWaiters.values.flatMap({ $0 }) {
            continuation.resume(
                throwing: ConnectionManagerError.messageProcessorEndedBeforeReady
            )
        }
        for continuation in negotiationWaiters.values.flatMap({ $0 }) {
            continuation.resume(
                throwing: ConnectionManagerError.messageProcessorEndedBeforeReady
            )
        }
        for waiter in workspaceReadinessWaiters.values {
            waiter.continuation.resume(
                throwing: ConnectionManagerError.workspaceReadinessUnavailable
            )
        }
        pairingWaiter?.continuation.resume(throwing: PairingError.connectionChanged)
        for continuation in teardownWaiters.values {
            continuation.resume()
        }
    }

    public func connectToStoredHost() async {
        await connectToLastConnectedHost()
    }

    public func connectToLastConnectedHost() async {
        let intentEpoch = lifecycleIntentEpoch
        guard canStartStoredReconnect(intentEpoch: intentEpoch) else { return }

        do {
            guard let host = try await pairedHostStore.lastConnectedHost() else { return }
            guard canStartStoredReconnect(intentEpoch: intentEpoch) else { return }
            let (_, configuration) = try await storedConnectionConfiguration(for: host)
            let generation = try await connectAndRequireConnected(
                using: configuration,
                intentEpoch: intentEpoch
            )
            guard lifecycleIntentEpoch == intentEpoch else { return }
            try await waitForWorkspaceReady(for: generation)
        } catch {
            guard lifecycleIntentEpoch == intentEpoch else { return }
            transition(to: .failed(error.localizedDescription))
        }
    }

    @discardableResult
    public func connectToPairedHost(
        serverID: String,
        resolvedEndpoint: HostEndpoint? = nil
    ) async throws -> PairedHost {
        lifecycleIntentEpoch &+= 1
        let intentEpoch = lifecycleIntentEpoch
        let (host, configuration) = try await exactStoredConnectionConfiguration(
            serverID: serverID,
            resolvedEndpoint: resolvedEndpoint
        )
        _ = try await connectAndRequireConnected(
            using: configuration,
            intentEpoch: intentEpoch
        )
        return host
    }

    public func connectForPairing(to endpoint: HostEndpoint) async throws {
        lifecycleIntentEpoch &+= 1
        let intentEpoch = lifecycleIntentEpoch
        _ = try await connectAndRequireConnected(
            using: ConnectionConfiguration(
                endpoint: endpoint,
                credentials: manualCredentials,
                readyHost: nil
            ),
            intentEpoch: intentEpoch
        )
    }

    public func connect(to endpoint: HostEndpoint) async {
        lifecycleIntentEpoch &+= 1
        let intentEpoch = lifecycleIntentEpoch
        await connect(
            using: ConnectionConfiguration(
                endpoint: endpoint,
                credentials: manualCredentials,
                readyHost: nil
            ),
            intentEpoch: intentEpoch
        )
    }

    public func waitForWorkspaceReady() async throws {
        guard let generation = activeGeneration else {
            throw ConnectionManagerError.workspaceReadinessUnavailable
        }
        try await waitForWorkspaceReady(for: generation)
    }

    private func exactStoredConnectionConfiguration(
        serverID: String,
        resolvedEndpoint: HostEndpoint?
    ) async throws -> (host: PairedHost, configuration: ConnectionConfiguration) {
        guard let host = try await pairedHostStore.host(withServerID: serverID) else {
            throw ConnectionManagerError.selectedHostUnavailable(serverID: serverID)
        }
        return try await storedConnectionConfiguration(
            for: host,
            resolvedEndpoint: resolvedEndpoint
        )
    }

    private func storedConnectionConfiguration(
        for host: PairedHost,
        resolvedEndpoint: HostEndpoint? = nil
    ) async throws -> (host: PairedHost, configuration: ConnectionConfiguration) {
        let exactHost: PairedHost
        if let resolvedEndpoint {
            switch try await pairedHostStore.pairingStatus(
                forServerID: host.serverID,
                certificateFingerprint: resolvedEndpoint.certificateFingerprint
            ) {
            case .paired:
                exactHost = host.withEndpoint(resolvedEndpoint)
            case .requiresRePairing:
                throw PairedHostStoreError.identityChanged(serverID: host.serverID)
            case .unpaired:
                throw ConnectionManagerError.selectedHostUnavailable(
                    serverID: host.serverID
                )
            }
        } else {
            exactHost = host
        }

        return (
            exactHost,
            ConnectionConfiguration(
                endpoint: exactHost.endpoint,
                credentials: ConnectionCredentials(
                    clientID: exactHost.clientID,
                    token: exactHost.token
                ),
                readyHost: exactHost
            )
        )
    }

    private func connectAndRequireConnected(
        using configuration: ConnectionConfiguration,
        intentEpoch: UInt64
    ) async throws -> ConnectionGeneration {
        await connect(using: configuration, intentEpoch: intentEpoch)
        guard lifecycleIntentEpoch == intentEpoch else {
            throw ConnectionManagerError.workspaceReadinessUnavailable
        }
        guard let generation = activeGeneration,
              isActive(generation: generation),
              state == .connected else {
            throw connectionOutcomeError()
        }
        return generation
    }

    private func connectionOutcomeError() -> ConnectionManagerError {
        if case let .failed(reason) = state {
            return .connectionFailed(reason: reason)
        }
        return .workspaceReadinessUnavailable
    }

    private func connect(
        using configuration: ConnectionConfiguration,
        intentEpoch: UInt64
    ) async {
        guard await waitForTeardownCompletionUnlessCancelled() else { return }
        guard lifecycleIntentEpoch == intentEpoch else { return }
        // Guard on execution, not on state. connect() keeps awaiting past the
        // .authenticating transition and the actor yields at every await.
        guard connectExecutionOwner == nil else { return }
        guard state != .disconnecting else { return }
        let attempt = UUID()
        connectExecutionOwner = attempt
        defer {
            if connectExecutionOwner == attempt {
                connectExecutionOwner = nil
            }
        }

        await tearDownActiveConnection()
        guard lifecycleIntentEpoch == intentEpoch else { return }
        guard !Task.isCancelled else {
            transition(to: .failed(ConnectionManagerError.connectionCancelled.localizedDescription))
            return
        }
        nextConnectionGeneration &+= 1
        let generation = ConnectionGeneration(id: nextConnectionGeneration)
        activeGeneration = generation
        pairingRequiresReconnect = false
        activeConnectAttempt = attempt
        activeConnection = configuration
        pendingReadyHost = configuration.readyHost
        workspaceReadyGeneration = nil
        transition(to: .connecting)

        do {
            try await withTaskCancellationHandler {
                try Task.checkCancellation()
                transportCleanupGeneration = generation
                try await transport.connect(to: configuration.endpoint)
                guard isActive(attempt: attempt, generation: generation) else { return }
                hasActiveTransport = true
                try Task.checkCancellation()
                await workspaceStore.beginConnection(for: generation)
                guard isActive(attempt: attempt, generation: generation) else { return }
                transition(to: .authenticating)
                let messages = await transport.incomingMessages()
                guard isActive(attempt: attempt, generation: generation) else { return }
                try Task.checkCancellation()
                isMessageProcessorReady = false
                let session = UUID()
                activeMessageSession = session
                let messageProcessorStart = self.messageProcessorStart
                messageTask = Task { [weak self, messageProcessorStart] in
                    await messageProcessorStart()
                    guard !Task.isCancelled else { return }
                    await self?.markMessageProcessorReady(
                        for: session,
                        generation: generation
                    )
                    for await message in messages {
                        guard !Task.isCancelled else { return }
                        guard let result = await self?.handle(
                            message,
                            for: session,
                            generation: generation
                        ) else { return }
                        if case let .failed(reason) = result {
                            await self?.messageProcessingEnded(
                                for: session,
                                generation: generation,
                                reason: reason
                            )
                            return
                        }
                    }
                    guard !Task.isCancelled else { return }
                    await self?.messageProcessingEnded(
                        for: session,
                        generation: generation,
                        reason: "Connection closed unexpectedly"
                    )
                }
                try await waitForMessageProcessorReadiness(
                    for: session,
                    generation: generation
                )
                try Task.checkCancellation()
                guard isActive(
                    attempt: attempt,
                    session: session,
                    generation: generation
                ), hasActiveTransport else {
                    throw ConnectionManagerError.messageProcessorEndedBeforeReady
                }
                try await transport.send(.legacy(.hello(HelloPayload(
                    clientID: configuration.credentials.clientID,
                    clientName: clientName,
                    protocolVersion: PsycheProtocolVersion.current,
                    token: configuration.credentials.token
                ))))
                try Task.checkCancellation()
                try await waitForV3Negotiation(
                    for: session,
                    generation: generation
                )
                try Task.checkCancellation()
                guard isActive(
                    attempt: attempt,
                    session: session,
                    generation: generation
                ),
                      hasActiveTransport,
                      hasNegotiatedV3 else {
                    throw ConnectionManagerError.messageProcessorEndedBeforeReady
                }
                activeConnectAttempt = nil
            } onCancel: {
                Task { [weak self] in
                    await self?.cancelConnectAttempt(attempt)
                }
            }
        } catch is CancellationError {
            guard isActive(attempt: attempt, generation: generation) else { return }
            let error = ConnectionManagerError.connectionCancelled
            await tearDownActiveConnection(
                generation: generation,
                readinessError: error,
                workspaceReadinessError: error,
                finalState: .failed(error.localizedDescription)
            )
        } catch {
            guard isActive(attempt: attempt, generation: generation) else { return }
            await tearDownActiveConnection(
                generation: generation,
                readinessError: error,
                workspaceReadinessError: error,
                finalState: .failed(error.localizedDescription)
            )
        }
    }

    public func disconnect() async {
        lifecycleIntentEpoch &+= 1
        if activeTeardown != nil {
            transition(to: .disconnecting)
            teardownFinalStateOverride = .disconnected
            return
        }
        guard state != .disconnected else {
            await resetPerConnectionState()
            return
        }
        transition(to: .disconnecting)
        await tearDownActiveConnection(finalState: .disconnected)
    }

    /// Defaults to the identity already announced in `hello`. Passing a
    /// different one is possible but binds the token to an identity the server
    /// never saw during the handshake, which is painful to debug.
    public func pair(
        code: String,
        clientID: String? = nil,
        clientName: String? = nil
    ) async throws -> PairedHost {
        guard !pairingRequiresReconnect else {
            throw PairingError.reconnectRequired
        }
        guard hasActiveTransport,
              let generation = activeGeneration,
              let activeConnection,
              welcomeIdentity != nil,
              hasNegotiatedV3 else {
            throw PairingError.notConnected
        }
        guard pairingWaiter == nil else { throw PairingError.alreadyInProgress }

        let pairingID = UUID()
        let authorization = PairingPersistenceAuthorization()
        let request = PairRequestPayload(
            code: code,
            clientID: clientID ?? activeConnection.credentials.clientID,
            clientName: clientName ?? self.clientName
        )

        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                guard isActive(generation: generation), pairingWaiter == nil else {
                    continuation.resume(throwing: PairingError.connectionChanged)
                    return
                }
                pairingWaiter = PairingWaiter(
                    id: pairingID,
                    generation: generation,
                    request: request,
                    authorization: authorization,
                    continuation: continuation
                )
                let transport = self.transport
                Task { [weak self, transport] in
                    do {
                        guard authorization.authorized else { return }
                        try await transport.send(.legacy(.pair(request)))
                    } catch {
                        await self?.pairRequestSendFailed(
                            pairingID: pairingID,
                            generation: generation,
                            error: error
                        )
                    }
                }
            }
        } onCancel: {
            authorization.revoke()
            Task { [weak self] in
                await self?.cancelPairing(
                    pairingID: pairingID,
                    generation: generation
                )
            }
        }
    }

    func waitForMessageProcessorReadiness() async {
        guard let session = activeMessageSession,
              let generation = activeGeneration else {
            return
        }
        try? await waitForMessageProcessorReadiness(
            for: session,
            generation: generation
        )
    }

    func waitForEventDrain(after eventCount: Int) async {
        guard processedMessageCount < eventCount else { return }
        let waiterID = UUID()
        await withCheckedContinuation { continuation in
            eventDrainWaiters[waiterID] = (eventCount, continuation)
        }
    }

    func waitForState(_ expectedState: ConnectionState) async {
        guard state != expectedState else { return }
        let waiterID = UUID()
        await withCheckedContinuation { continuation in
            stateWaiters[waiterID] = (expectedState, continuation)
        }
    }

    private func waitForWorkspaceReady(
        for generation: ConnectionGeneration
    ) async throws {
        guard activeGeneration === generation else {
            throw ConnectionManagerError.workspaceReadinessUnavailable
        }
        guard workspaceReadyGeneration !== generation else { return }

        let waiterID = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation {
                (continuation: CheckedContinuation<Void, any Error>) in
                guard activeGeneration === generation else {
                    continuation.resume(
                        throwing: ConnectionManagerError.workspaceReadinessUnavailable
                    )
                    return
                }
                guard workspaceReadyGeneration !== generation else {
                    continuation.resume()
                    return
                }
                workspaceReadinessWaiters[waiterID] = (generation, continuation)
            }
        } onCancel: {
            Task { [weak self] in
                await self?.cancelWorkspaceReadinessWaiter(waiterID)
            }
        }
    }

    private func waitForMessageProcessorReadiness(
        for session: UUID,
        generation: ConnectionGeneration
    ) async throws {
        guard isActive(session: session, generation: generation) else {
            throw ConnectionManagerError.messageProcessorEndedBeforeReady
        }
        guard !isMessageProcessorReady else { return }

        try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<Void, any Error>) in
            guard isActive(session: session, generation: generation) else {
                continuation.resume(
                    throwing: ConnectionManagerError.messageProcessorEndedBeforeReady
                )
                return
            }
            guard !isMessageProcessorReady else {
                continuation.resume()
                return
            }
            messageProcessorReadyWaiters[session, default: []].append(continuation)
        }
    }

    private func markMessageProcessorReady(
        for session: UUID,
        generation: ConnectionGeneration
    ) {
        guard isActive(session: session, generation: generation) else { return }
        isMessageProcessorReady = true
        completeMessageProcessorReadiness(for: session, with: .success(()))
    }

    private func waitForV3Negotiation(
        for session: UUID,
        generation: ConnectionGeneration
    ) async throws {
        guard isActive(session: session, generation: generation) else {
            throw ConnectionManagerError.messageProcessorEndedBeforeReady
        }
        guard !hasNegotiatedV3 else { return }

        try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<Void, any Error>) in
            guard isActive(session: session, generation: generation) else {
                continuation.resume(
                    throwing: ConnectionManagerError.messageProcessorEndedBeforeReady
                )
                return
            }
            guard !hasNegotiatedV3 else {
                continuation.resume()
                return
            }
            negotiationWaiters[session, default: []].append(continuation)
        }
    }

    private func handle(
        _ message: MobileServerMessage,
        for session: UUID,
        generation: ConnectionGeneration
    ) async -> MessageHandlingResult {
        guard isActive(session: session, generation: generation) else { return .ignored }

        let result: MessageHandlingResult
        switch message {
        case .legacy(let message):
            result = await handle(message, for: session, generation: generation)
        case .control(let response):
            result = await handle(response, for: session, generation: generation)
        case .workspaceChanged(let event):
            guard hasNegotiatedV3 else { return .ignored }
            await workspaceStore.applyEvent(
                workspace: event.workspace,
                sequence: event.sequence,
                for: generation
            )
            guard isActive(session: session, generation: generation) else { return .ignored }
            if await workspaceStore.needsFullSnapshot {
                await requestSnapshotIfNeeded(
                    for: session,
                    generation: generation
                )
            }
            result = .processed
        }

        if result == .processed {
            recordProcessedMessage()
        }
        return result
    }

    private func handle(
        _ message: ServerMessage,
        for session: UUID,
        generation: ConnectionGeneration
    ) async -> MessageHandlingResult {
        guard isActive(session: session, generation: generation) else { return .ignored }

        switch message {
        case .welcome(let payload):
            if payload.protocolVersion == PsycheProtocolVersion.legacy,
               payload.supportedVersions?.contains(PsycheProtocolVersion.current) == true {
                return .ignored
            }
            guard payload.protocolVersion == PsycheProtocolVersion.current else {
                return .failed(
                    ConnectionManagerError
                        .unsupportedProtocolVersion(payload.protocolVersion)
                        .localizedDescription
                )
            }
            welcomeIdentity = WelcomeIdentity(
                serverID: payload.serverID,
                serverName: payload.serverName
            )
            await requestClient.beginGeneration(generation)
            guard isActive(session: session, generation: generation) else {
                return .ignored
            }
            hasNegotiatedV3 = true
            transition(to: .connected)
            completeNegotiation(for: session, with: .success(()))
            await requestInitialSnapshotIfAuthorized(
                for: session,
                generation: generation
            )
        case .projectList(let projects):
            guard hasNegotiatedV3 else { return .ignored }
            self.projects = projects
        case .paneList(let panes), .paneListChanged(let panes):
            guard hasNegotiatedV3 else { return .ignored }
            self.panes = panes
        case .paneOutput(let output):
            guard hasNegotiatedV3 else { return .ignored }
            latestOutputByPane[output.paneID] = output
        case .error(let error):
            return .failed(error.message)
        case .pairAccepted(let payload):
            guard let pairingWaiter,
                  pairingWaiter.generation === generation,
                  pairingWaiter.authorization.authorized,
                  let welcomeIdentity,
                  let activeConnection,
                  isActive(session: session, generation: generation),
                  !Task.isCancelled else {
                return .ignored
            }
            let host = PairedHost(
                serverID: welcomeIdentity.serverID,
                serverName: welcomeIdentity.serverName,
                endpoint: activeConnection.endpoint,
                clientID: pairingWaiter.request.clientID,
                token: payload.token
            )
            do {
                let committed = try await pairedHostStore.replace(
                    host,
                    for: generation,
                    authorizedBy: pairingWaiter.authorization
                )
                guard committed else {
                    return .ignored
                }
            } catch is CancellationError {
                pairingRequiresReconnect = true
                completePairing(
                    id: pairingWaiter.id,
                    generation: generation,
                    with: .failure(PairingError.cancelled)
                )
                await tearDownActiveConnection(
                    generation: generation,
                    finalState: .disconnected
                )
                return .ignored
            } catch {
                pairingRequiresReconnect = true
                completePairing(
                    id: pairingWaiter.id,
                    generation: generation,
                    with: .failure(error)
                )
                await tearDownActiveConnection(
                    generation: generation,
                    finalState: .failed(error.localizedDescription)
                )
                return .ignored
            }
            guard isActive(session: session, generation: generation),
                  pairingWaiter.id == self.pairingWaiter?.id,
                  pairingWaiter.authorization.authorized,
                  !Task.isCancelled else {
                return .ignored
            }
            self.activeConnection = activeConnection.withPairingCredentials(
                clientID: pairingWaiter.request.clientID,
                token: payload.token
            )
            pendingReadyHost = host
            completePairing(
                id: pairingWaiter.id,
                generation: generation,
                with: .success(host)
            )
            await requestInitialSnapshotIfAuthorized(
                for: session,
                generation: generation
            )
        case .pairRejected(let payload):
            guard let pairingWaiter,
                  pairingWaiter.generation === generation else {
                return .ignored
            }
            completePairing(
                id: pairingWaiter.id,
                generation: generation,
                with: .failure(PairingError.rejected(reason: payload.reason))
            )
        default:
            break
        }
        return .processed
    }

    private func handle(
        _ response: MobileControlResponse,
        for session: UUID,
        generation: ConnectionGeneration
    ) async -> MessageHandlingResult {
        guard isActive(session: session, generation: generation) else { return .ignored }
        guard hasNegotiatedV3 else { return .ignored }
        let wasHandled = await requestClient.handle(response, for: generation)
        guard isActive(session: session, generation: generation) else { return .ignored }

        switch response {
        case .workspaceSnapshot(let result):
            guard wasHandled,
                  activeSnapshotRequest == .awaiting(result.requestID) else {
                return .ignored
            }
            isSnapshotRecoveryInFlight = false
            activeSnapshotRequest = nil
            snapshotRequestTask = nil
            do {
                let finalized = try await finalizeWorkspaceReadiness(
                    with: result,
                    session: session,
                    generation: generation
                )
                return finalized ? .processed : .ignored
            } catch {
                let failure = ConnectionManagerError.connectionFailed(
                    reason: error.localizedDescription
                )
                await tearDownActiveConnection(
                    generation: generation,
                    workspaceReadinessError: failure,
                    finalState: .failed(failure.localizedDescription)
                )
                return .ignored
            }
        case .error(let error):
            if !claimSnapshotFailure(for: response, wasHandled: wasHandled),
               !wasHandled {
                return .failed(error.message)
            }
        default:
            _ = claimSnapshotFailure(for: response, wasHandled: wasHandled)
        }
        return .processed
    }

    private func claimSnapshotFailure(
        for response: MobileControlResponse,
        wasHandled: Bool
    ) -> Bool {
        guard wasHandled,
              let requestID = response.requestID,
              activeSnapshotRequest == .awaiting(requestID) else {
            return false
        }
        activeSnapshotRequest = .failing(requestID)
        return true
    }

    private func requestInitialSnapshotIfAuthorized(
        for session: UUID,
        generation: ConnectionGeneration
    ) async {
        guard isActive(session: session, generation: generation) else { return }
        guard activeConnection?.credentials.token?.isEmpty == false,
              !requestedInitialSnapshot else {
            return
        }
        requestedInitialSnapshot = true
        await requestSnapshotIfNeeded(for: session, generation: generation)
    }

    private func requestSnapshotIfNeeded(
        for session: UUID,
        generation: ConnectionGeneration
    ) async {
        guard isActive(session: session, generation: generation),
              hasActiveTransport,
              welcomeIdentity != nil,
              activeConnection?.credentials.token?.isEmpty == false,
              !isSnapshotRecoveryInFlight else {
            return
        }

        isSnapshotRecoveryInFlight = true
        let requestID = await requestClient.nextRequestID()
        guard isActive(session: session, generation: generation),
              hasActiveTransport else {
            return
        }

        activeSnapshotRequest = .awaiting(requestID)
        let requestClient = self.requestClient
        let snapshotRequestFailureStart = self.snapshotRequestFailureStart
        snapshotRequestTask = Task { [weak self, requestClient, snapshotRequestFailureStart] in
            do {
                let response = try await requestClient.send(
                    .workspaceSnapshot(ControlRequestIDOnly(requestID: requestID)),
                    for: generation
                )
                guard case let .workspaceSnapshot(result) = response,
                      result.requestID == requestID else {
                    throw ConnectionManagerError.unexpectedSnapshotResponse(requestID)
                }
            } catch is CancellationError {
                return
            } catch {
                await snapshotRequestFailureStart()
                guard !Task.isCancelled else { return }
                await self?.snapshotRequestFailed(
                    requestID: requestID,
                    session: session,
                    generation: generation,
                    error: error
                )
            }
        }
    }

    private func snapshotRequestFailed(
        requestID: String,
        session: UUID,
        generation: ConnectionGeneration,
        error: any Error
    ) async {
        guard isActive(session: session, generation: generation),
              activeSnapshotRequest?.requestID == requestID else {
            return
        }
        isSnapshotRecoveryInFlight = false
        activeSnapshotRequest = nil
        snapshotRequestTask = nil
        let failure = ConnectionManagerError.connectionFailed(
            reason: error.localizedDescription
        )
        await tearDownActiveConnection(
            generation: generation,
            workspaceReadinessError: failure,
            finalState: .failed(error.localizedDescription)
        )
    }

    private func finalizeWorkspaceReadiness(
        with result: MobileWorkspaceSnapshotResult,
        session: UUID,
        generation: ConnectionGeneration
    ) async throws -> Bool {
        await workspaceStore.applySnapshot(
            workspace: result.workspace,
            sequence: result.sequence,
            for: generation
        )
        guard isActive(session: session, generation: generation) else { return false }

        if let readyHost = pendingReadyHost {
            let committed = try await pairedHostStore.recordSuccessfulConnection(
                readyHost,
                for: generation
            )
            guard committed else { return false }
            guard isActive(session: session, generation: generation) else {
                return false
            }
            pendingReadyHost = nil
        }

        workspaceReadyGeneration = generation
        completeWorkspaceReadiness(for: generation, with: .success(()))
        return true
    }

    private func recordProcessedMessage() {
        processedMessageCount += 1
        let completedWaiters = eventDrainWaiters.filter {
            processedMessageCount >= $0.value.count
        }
        completedWaiters.forEach { waiterID, waiter in
            eventDrainWaiters.removeValue(forKey: waiterID)
            waiter.continuation.resume()
        }
    }

    private func tearDownActiveConnection(
        generation expectedGeneration: ConnectionGeneration? = nil,
        readinessError: any Error = ConnectionManagerError.messageProcessorEndedBeforeReady,
        workspaceReadinessError: any Error = ConnectionManagerError.workspaceReadinessUnavailable,
        finalState: ConnectionState? = nil
    ) async {
        if activeTeardown != nil {
            await waitForTeardownCompletion()
            return
        }
        guard let generation = activeGeneration else {
            if expectedGeneration == nil, let finalState {
                transition(to: finalState)
            }
            return
        }
        guard expectedGeneration == nil || generation === expectedGeneration else {
            return
        }
        let teardown = UUID()
        activeTeardown = teardown
        let session = activeMessageSession
        let attempt = activeConnectAttempt
        completePairing(for: generation, with: .failure(PairingError.connectionChanged))
        generation.invalidate()
        activeGeneration = nil
        activeConnectAttempt = nil
        if connectExecutionOwner == attempt {
            connectExecutionOwner = nil
        }
        activeMessageSession = nil
        completeMessageProcessorReadiness(for: session, with: .failure(readinessError))
        completeNegotiation(for: session, with: .failure(readinessError))
        completeWorkspaceReadiness(
            for: generation,
            with: .failure(workspaceReadinessError)
        )
        messageTask?.cancel()
        messageTask = nil
        let shouldDisconnectTransport = transportCleanupGeneration === generation
        if shouldDisconnectTransport {
            transportCleanupGeneration = nil
        }
        hasActiveTransport = false
        await resetPerConnectionState(generation: generation)
        if shouldDisconnectTransport {
            await transport.disconnect()
        }
        let resolvedFinalState = teardownFinalStateOverride ?? finalState
        teardownFinalStateOverride = nil
        if let resolvedFinalState {
            transition(to: resolvedFinalState)
        }
        completeTeardown(teardown)
    }

    private func waitForTeardownCompletion() async {
        while activeTeardown != nil {
            let waiter = UUID()
            await withCheckedContinuation { continuation in
                guard activeTeardown != nil else {
                    continuation.resume()
                    return
                }
                teardownWaiters[waiter] = continuation
            }
        }
    }

    private func waitForTeardownCompletionUnlessCancelled() async -> Bool {
        while activeTeardown != nil {
            guard !Task.isCancelled else { return false }
            let waiter = UUID()
            await withTaskCancellationHandler {
                await withCheckedContinuation { continuation in
                    guard activeTeardown != nil, !Task.isCancelled else {
                        continuation.resume()
                        return
                    }
                    teardownWaiters[waiter] = continuation
                }
            } onCancel: {
                Task { [weak self] in
                    await self?.cancelTeardownWaiter(waiter)
                }
            }
        }
        return !Task.isCancelled
    }

    private func cancelTeardownWaiter(_ waiter: UUID) {
        teardownWaiters.removeValue(forKey: waiter)?.resume()
    }

    private func completeTeardown(_ teardown: UUID) {
        guard activeTeardown == teardown else { return }
        activeTeardown = nil
        let waiting = teardownWaiters.values
        teardownWaiters.removeAll()
        waiting.forEach { $0.resume() }
    }

    private func resetPerConnectionState(
        generation: ConnectionGeneration? = nil
    ) async {
        snapshotRequestTask?.cancel()
        snapshotRequestTask = nil
        activeSnapshotRequest = nil
        requestedInitialSnapshot = false
        isSnapshotRecoveryInFlight = false
        pendingReadyHost = nil
        workspaceReadyGeneration = nil
        activeConnection = nil
        welcomeIdentity = nil
        isMessageProcessorReady = false
        hasNegotiatedV3 = false
        if let generation {
            await workspaceStore.markDisconnected(for: generation)
            await requestClient.endGeneration(generation)
        } else {
            await workspaceStore.markDisconnected()
            await requestClient.failAll(with: ControlRequestError.disconnected)
        }
    }

    private func cancelConnectAttempt(_ attempt: UUID) async {
        guard activeConnectAttempt == attempt,
              let generation = activeGeneration else {
            return
        }
        let error = ConnectionManagerError.connectionCancelled
        await tearDownActiveConnection(
            generation: generation,
            readinessError: error,
            workspaceReadinessError: error,
            finalState: .failed(error.localizedDescription)
        )
    }

    private func pairRequestSendFailed(
        pairingID: UUID,
        generation: ConnectionGeneration,
        error: any Error
    ) async {
        guard pairingWaiter?.id == pairingID,
              pairingWaiter?.generation === generation else {
            return
        }
        pairingRequiresReconnect = true
        guard completePairing(
            id: pairingID,
            generation: generation,
            with: .failure(error)
        ) else { return }
        await tearDownActiveConnection(
            generation: generation,
            finalState: .failed(error.localizedDescription)
        )
    }

    private func cancelPairing(
        pairingID: UUID,
        generation: ConnectionGeneration
    ) async {
        guard pairingWaiter?.id == pairingID,
              pairingWaiter?.generation === generation else {
            return
        }
        pairingRequiresReconnect = true
        guard completePairing(
            id: pairingID,
            generation: generation,
            with: .failure(PairingError.cancelled)
        ) else { return }
        await tearDownActiveConnection(
            generation: generation,
            finalState: .disconnected
        )
    }

    @discardableResult
    private func completePairing(
        id: UUID,
        generation: ConnectionGeneration,
        with result: Result<PairedHost, any Error>
    ) -> Bool {
        guard let pairingWaiter,
              pairingWaiter.id == id,
              pairingWaiter.generation === generation else {
            return false
        }
        self.pairingWaiter = nil
        pairingWaiter.authorization.revoke()
        pairingWaiter.continuation.resume(with: result)
        return true
    }

    private func completePairing(
        for generation: ConnectionGeneration,
        with result: Result<PairedHost, any Error>
    ) {
        guard let pairingWaiter, pairingWaiter.generation === generation else { return }
        _ = completePairing(id: pairingWaiter.id, generation: generation, with: result)
    }

    private func completeMessageProcessorReadiness(
        for session: UUID?,
        with result: Result<Void, any Error>
    ) {
        let sessions = session.map { [$0] } ?? Array(messageProcessorReadyWaiters.keys)
        for session in sessions {
            let continuations = messageProcessorReadyWaiters.removeValue(forKey: session) ?? []
            continuations.forEach { $0.resume(with: result) }
        }
    }

    private func completeNegotiation(
        for session: UUID?,
        with result: Result<Void, any Error>
    ) {
        let sessions = session.map { [$0] } ?? Array(negotiationWaiters.keys)
        for session in sessions {
            let continuations = negotiationWaiters.removeValue(forKey: session) ?? []
            continuations.forEach { $0.resume(with: result) }
        }
    }

    private func cancelWorkspaceReadinessWaiter(_ waiterID: UUID) {
        workspaceReadinessWaiters.removeValue(forKey: waiterID)?
            .continuation
            .resume(throwing: CancellationError())
    }

    private func completeWorkspaceReadiness(
        for generation: ConnectionGeneration?,
        with result: Result<Void, any Error>
    ) {
        let waiterIDs = workspaceReadinessWaiters.compactMap { entry -> UUID? in
            let (waiterID, waiter) = entry
            if let generation, waiter.generation !== generation {
                return nil
            }
            return waiterID
        }
        for waiterID in waiterIDs {
            workspaceReadinessWaiters.removeValue(forKey: waiterID)?
                .continuation
                .resume(with: result)
        }
    }

    private func messageProcessingEnded(
        for session: UUID,
        generation: ConnectionGeneration,
        reason: String
    ) async {
        guard isActive(session: session, generation: generation) else { return }

        transition(to: .disconnecting)
        let failure = ConnectionManagerError.connectionFailed(reason: reason)
        await tearDownActiveConnection(
            generation: generation,
            workspaceReadinessError: failure,
            finalState: .failed(reason)
        )
    }

    private func isActive(
        attempt: UUID? = nil,
        session: UUID? = nil,
        generation: ConnectionGeneration
    ) -> Bool {
        guard activeGeneration === generation else { return false }
        if let attempt, activeConnectAttempt != attempt { return false }
        if let session, activeMessageSession != session { return false }
        return true
    }

    private func canStartStoredReconnect(intentEpoch: UInt64) -> Bool {
        lifecycleIntentEpoch == intentEpoch
            && connectExecutionOwner == nil
            && activeGeneration == nil
            && activeTeardown == nil
            && state == .disconnected
    }

    private func transition(to newState: ConnectionState) {
        state = newState
        stateHistory.append(newState)
        let completedWaiters = stateWaiters.filter { newState == $0.value.state }
        completedWaiters.forEach { waiterID, waiter in
            stateWaiters.removeValue(forKey: waiterID)
            waiter.continuation.resume()
        }
    }

    private struct WelcomeIdentity {
        let serverID: String
        let serverName: String
    }

    private struct PairingWaiter {
        let id: UUID
        let generation: ConnectionGeneration
        let request: PairRequestPayload
        let authorization: PairingPersistenceAuthorization
        let continuation: CheckedContinuation<PairedHost, any Error>
    }

    private struct ConnectionCredentials {
        let clientID: String
        let token: String?
    }

    private enum SnapshotRequestState: Equatable {
        case awaiting(String)
        case failing(String)

        var requestID: String {
            switch self {
            case .awaiting(let requestID), .failing(let requestID):
                requestID
            }
        }
    }

    private struct ConnectionConfiguration {
        let endpoint: HostEndpoint
        let credentials: ConnectionCredentials
        let readyHost: PairedHost?

        func withPairingCredentials(
            clientID: String,
            token: String?
        ) -> ConnectionConfiguration {
            ConnectionConfiguration(
                endpoint: endpoint,
                credentials: ConnectionCredentials(
                    clientID: clientID,
                    token: token
                ),
                readyHost: readyHost
            )
        }
    }

    private enum MessageHandlingResult: Equatable {
        case ignored
        case processed
        case failed(String)
    }
}
