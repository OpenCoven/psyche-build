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
    case unsupportedProtocolVersion(Int)
    case messageProcessorEndedBeforeReady
    case connectionCancelled
    case unexpectedSnapshotResponse(String)
    /// Readiness refused to own this connection, so nothing on it may commit
    /// host identity or present a workspace as confirmed.
    case readinessUnavailable(String)
    /// The paired-host record did not survive, and rollback was proven.
    case hostIdentityNotCommitted(String?)
    /// Durable host state is indeterminate; readiness fails closed instead of
    /// guessing which side of the write survived.
    case hostIdentityIndeterminate(String)
    case workspaceNotAccepted(String?)
    case workspaceApplyIndeterminate(String)

    public var errorDescription: String? {
        switch self {
        case .missingWelcomeIdentity:
            "The host accepted pairing before identifying itself."
        case .unsupportedProtocolVersion(let version):
            "The host selected unsupported mobile protocol version \(version)."
        case .messageProcessorEndedBeforeReady:
            "The connection ended before its message processor became ready."
        case .connectionCancelled:
            "The connection was cancelled before its message processor became ready."
        case .unexpectedSnapshotResponse(let requestID):
            "The host returned an unexpected response to snapshot request \(requestID)."
        case .readinessUnavailable(let reason):
            "This connection cannot be made ready: \(reason)"
        case .hostIdentityNotCommitted(let reason):
            reason.map { "The paired host was not saved: \($0)" }
                ?? "The paired host was not saved."
        case .hostIdentityIndeterminate(let reason):
            "The stored pairing may be inconsistent, so this device fails closed: \(reason)"
        case .workspaceNotAccepted(let reason):
            reason.map { "The host's workspace was not accepted: \($0)" }
                ?? "The host's workspace was not accepted."
        case .workspaceApplyIndeterminate(let reason):
            "The workspace could not be confirmed, so this device fails closed: \(reason)"
        }
    }
}

private enum ReadyHostSelectionPublication {
    case finalized(UUID)
    case superseded
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
    /// The single authority for how ready this device's host connection is,
    /// and for what the workspace surface may present. Every host-identity
    /// commit and every readiness snapshot on this connection goes through it.
    public nonisolated let hostReadiness: HostReadinessMachine

    private let transport: any PsycheTransport
    private let workspaceStore: WorkspaceStore
    private let pairedHostStore: PairedHostStore
    private let messageProcessorStart: @Sendable () async -> Void
    private let snapshotRequestFailureStart: @Sendable () async -> Void
    private let readinessFlowPublicationStart: @Sendable () async -> Void
    private let readyHostSelectionFinalizationStart: @Sendable () async -> Void
    private let manualCredentials: ConnectionCredentials
    private var activeConnection: ConnectionConfiguration?
    private var readinessFlow: HostReadinessFlow?
    private var readinessAuthorization: HostReadinessFlowAuthorization?
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
        hostReadiness: HostReadinessMachine,
        clientID: String = UUID().uuidString,
        clientName: String = "Psyche iOS",
        token: String? = nil,
        messageProcessorStart: @escaping @Sendable () async -> Void = {},
        snapshotRequestFailureStart: @escaping @Sendable () async -> Void = {},
        readinessFlowPublicationStart: @escaping @Sendable () async -> Void = {},
        readyHostSelectionFinalizationStart: @escaping @Sendable () async -> Void = {}
    ) {
        self.transport = transport
        self.workspaceStore = workspaceStore
        self.requestClient = requestClient
        self.pairedHostStore = pairedHostStore
        self.hostReadiness = hostReadiness
        self.manualCredentials = ConnectionCredentials(
            clientID: clientID,
            token: token
        )
        self.clientName = clientName
        self.messageProcessorStart = messageProcessorStart
        self.snapshotRequestFailureStart = snapshotRequestFailureStart
        self.readinessFlowPublicationStart = readinessFlowPublicationStart
        self.readyHostSelectionFinalizationStart = readyHostSelectionFinalizationStart
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
        pairingWaiter?.continuation.resume(throwing: PairingError.connectionChanged)
        for continuation in teardownWaiters.values {
            continuation.resume()
        }
    }

    public func connectToStoredHost() async {
        let intentEpoch = lifecycleIntentEpoch
        guard canStartStoredReconnect(intentEpoch: intentEpoch) else { return }

        do {
            guard let host = try await pairedHostStore.selectedHost() else { return }
            guard canStartStoredReconnect(intentEpoch: intentEpoch) else { return }
            await connect(
                using: ConnectionConfiguration(
                    endpoint: host.endpoint,
                    credentials: ConnectionCredentials(
                        clientID: host.clientID,
                        token: host.token
                    ),
                    readinessIntent: .reconnection(host)
                ),
                intentEpoch: intentEpoch
            )
        } catch {
            guard canStartStoredReconnect(intentEpoch: intentEpoch) else { return }
            transition(to: .failed(error.localizedDescription))
        }
    }

    public func connect(to endpoint: HostEndpoint) async {
        lifecycleIntentEpoch &+= 1
        let intentEpoch = lifecycleIntentEpoch
        await connect(
            using: ConnectionConfiguration(
                endpoint: endpoint,
                credentials: manualCredentials,
                readinessIntent: .pairing
            ),
            intentEpoch: intentEpoch
        )
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

        await tearDownActiveConnection(
            readinessError: ConnectionManagerError.connectionCancelled
        )
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
        transition(to: .connecting)

        if let readinessError = await beginReadinessFlow(
            for: configuration,
            generation: generation
        ) {
            guard isActive(attempt: attempt, generation: generation) else { return }
            await tearDownActiveConnection(
                generation: generation,
                readinessError: readinessError,
                finalState: .failed(readinessError.localizedDescription)
            )
            return
        }
        guard isActive(attempt: attempt, generation: generation) else { return }

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
                finalState: .failed(error.localizedDescription)
            )
        } catch {
            guard isActive(attempt: attempt, generation: generation) else { return }
            await tearDownActiveConnection(
                generation: generation,
                readinessError: error,
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
        await tearDownActiveConnection(
            readinessError: ConnectionManagerError.connectionCancelled,
            finalState: .disconnected
        )
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
        // Captured now so cancellation can withdraw this flow's right to
        // publish synchronously, before a secure-store write already in
        // flight reaches its commit point.
        let readinessAuthorization = self.readinessAuthorization
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
            readinessAuthorization?.revoke()
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
            // A host that repeats its welcome on a live session is not a new
            // readiness flow, and must not disturb the one already running.
            if !hasNegotiatedV3 {
                guard await advanceReadinessAfterWelcome(
                    payload,
                    for: session,
                    generation: generation
                ) else {
                    return .ignored
                }
                guard isActive(session: session, generation: generation) else {
                    return .ignored
                }
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
            if error.code == "invalid_token" {
                await handleCredentialRevocation(
                    error,
                    for: session,
                    generation: generation
                )
                return .ignored
            }
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
                let committed = try await commitPairedHost(
                    host,
                    for: session,
                    generation: generation,
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
                    readinessError: PairingError.cancelled,
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
                    readinessError: error,
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
            if let readinessError = await applyReadinessSnapshot(
                result,
                for: session,
                generation: generation
            ) {
                await tearDownActiveConnection(
                    generation: generation,
                    readinessError: readinessError,
                    finalState: .failed(readinessError.localizedDescription)
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

    // MARK: - Host readiness

    /// Opens the readiness flow that owns this connection. Returns the reason
    /// readiness refused, if it did. A connection that readiness will not own
    /// must not proceed, because nothing on it may commit host identity or
    /// present a workspace as confirmed.
    private func beginReadinessFlow(
        for configuration: ConnectionConfiguration,
        generation: ConnectionGeneration
    ) async -> (any Error)? {
        let machine = hostReadiness
        let intent = configuration.readinessIntent
        do {
            let started = try await MainActor.run {
                () throws -> (HostReadinessFlow, HostReadinessFlowAuthorization?) in
                let flow: HostReadinessFlow
                switch intent {
                case .reconnection(let host):
                    try machine.adoptPersistedHost(host)
                    flow = try machine.beginReconnection()
                case .pairing:
                    // Selecting an endpoint by hand is the manual equivalent
                    // of discovery, and it is the only way back out of a
                    // resting state that refuses to start pairing directly.
                    switch machine.state {
                    case .reconnecting, .degraded, .revoked:
                        try machine.beginDiscovery()
                    default:
                        break
                    }
                    flow = try machine.beginPairing()
                }
                return (flow, machine.authorization(for: flow))
            }
            await readinessFlowPublicationStart()
            guard isActive(generation: generation), activeTeardown == nil else {
                started.1?.revoke()
                let reason = "The connection retired before readiness flow publication."
                await MainActor.run {
                    _ = try? machine.fail(.transport, reason: reason, for: started.0)
                }
                return nil
            }
            readinessFlow = started.0
            readinessAuthorization = started.1
            return nil
        } catch {
            clearReadinessFlow()
            return ConnectionManagerError.readinessUnavailable(error.localizedDescription)
        }
    }

    /// Moves readiness through authentication, and — when this connection was
    /// already authorized by a stored or supplied token — durably commits the
    /// host identity before any snapshot can be requested for it.
    ///
    /// Returns `false` once the connection has been torn down, so the caller
    /// stops handling the welcome.
    private func advanceReadinessAfterWelcome(
        _ payload: WelcomePayload,
        for session: UUID,
        generation: ConnectionGeneration
    ) async -> Bool {
        guard let flow = readinessFlow, let configuration = activeConnection else {
            await failReadiness(
                ConnectionManagerError.readinessUnavailable(
                    "No readiness flow owns this connection."
                ),
                generation: generation
            )
            return false
        }

        if let expected = flow.expectedServerID, expected != payload.serverID {
            let error = HostReadinessError.wrongHostIdentity(
                expected: expected,
                actual: payload.serverID
            )
            let machine = hostReadiness
            let reason = error.localizedDescription
            await MainActor.run { _ = try? machine.revoke(reason: reason) }
            clearReadinessFlow()
            await failReadiness(error, generation: generation)
            return false
        }

        do {
            let machine = hostReadiness
            try await MainActor.run { _ = try machine.markAuthenticated(for: flow) }
        } catch {
            clearReadinessFlow()
            await failReadiness(error, generation: generation)
            return false
        }
        guard isActive(session: session, generation: generation) else { return false }

        // A tokenless connection has no identity to commit yet; pairing does
        // that when the host accepts the code.
        guard configuration.credentials.token?.isEmpty == false else { return true }

        let host = PairedHost(
            serverID: payload.serverID,
            serverName: payload.serverName,
            endpoint: configuration.endpoint,
            clientID: configuration.credentials.clientID,
            token: configuration.credentials.token
        )
        do {
            guard try await commitReadinessHostIdentity(
                host,
                for: session,
                generation: generation
            ) else {
                return false
            }
            return true
        } catch {
            await failReadiness(error, generation: generation)
            return false
        }
    }

    /// Persists what an accepted pair code established.
    ///
    /// Which write that is depends on where readiness already stands. A
    /// connection still waiting on identity commits it through readiness. A
    /// connection whose identity readiness already committed — an
    /// already-authorized connection that paired again — is receiving a
    /// reissued token for a host this device already trusts, which is not an
    /// identity change and must not restart readiness.
    private func commitPairedHost(
        _ host: PairedHost,
        for session: UUID,
        generation: ConnectionGeneration,
        authorizedBy authorization: PairingPersistenceAuthorization
    ) async throws -> Bool {
        let machine = hostReadiness
        let disposition = await MainActor.run {
            (state: machine.state, authenticatedServerID: machine.authenticatedHost?.serverID)
        }
        guard isActive(session: session, generation: generation) else { return false }
        guard disposition.state != .authenticating else {
            return try await commitReadinessHostIdentity(
                host,
                for: session,
                generation: generation
            )
        }
        guard disposition.authenticatedServerID == host.serverID else {
            throw HostReadinessError.wrongHostIdentity(
                expected: disposition.authenticatedServerID ?? "",
                actual: host.serverID
            )
        }
        let result = try await pairedHostStore.reissueToken(
            host.token,
            clientID: host.clientID,
            forServerID: host.serverID,
            certificateFingerprint: host.certificateFingerprint,
            for: generation,
            authorizedBy: authorization
        )
        switch result {
        case .committed:
            return true
        case .notCommitted(let reason):
            guard let reason else { return false }
            throw ConnectionManagerError.hostIdentityNotCommitted(reason)
        case .indeterminate(let reason):
            let error = ConnectionManagerError.hostIdentityIndeterminate(reason)
            let machine = hostReadiness
            await MainActor.run {
                _ = try? machine.revoke(reason: error.localizedDescription)
            }
            clearReadinessFlow()
            throw error
        }
    }

    /// Publishes the host identity through readiness, which owns the ordering
    /// rule this whole path exists for: the paired-host record commits before
    /// any workspace snapshot may be applied.
    ///
    /// Throws when the commit is refused or indeterminate. Returns `false`
    /// when this flow no longer owns readiness, which is not a failure of the
    /// connection — a newer flow already holds authority.
    private func commitReadinessHostIdentity(
        _ host: PairedHost,
        for session: UUID,
        generation: ConnectionGeneration
    ) async throws -> Bool {
        guard let flow = readinessFlow else { return false }
        let machine = hostReadiness
        let result: HostReadinessTransactionResult
        do {
            result = try await machine.commitHostIdentity(host, for: flow)
        } catch let error as HostReadinessError {
            clearReadinessFlow()
            if case .supersededFlow = error { return false }
            throw error
        }
        guard isActive(session: session, generation: generation) else { return false }
        switch result {
        case .committed:
            return true
        case .notCommitted(let reason):
            clearReadinessFlow()
            throw ConnectionManagerError.hostIdentityNotCommitted(reason)
        case .indeterminate(let reason):
            clearReadinessFlow()
            throw ConnectionManagerError.hostIdentityIndeterminate(reason)
        }
    }

    /// Applies an authoritative snapshot. While a readiness flow owns the
    /// connection the snapshot must pass through readiness, so it can only
    /// become visible as confirmed state after the host identity committed and
    /// the snapshot validated. Once readiness has already confirmed this
    /// connection, later snapshots are sequence-gap recovery on live state and
    /// go through the connection-scoped path. Returns the error that must tear
    /// the connection down, or `nil` when the snapshot was accepted or
    /// harmlessly superseded.
    private func applyReadinessSnapshot(
        _ result: MobileWorkspaceSnapshotResult,
        for session: UUID,
        generation: ConnectionGeneration
    ) async -> (any Error)? {
        let machine = hostReadiness
        guard let flow = readinessFlow else {
            guard await machine.state == .ready else {
                // Nothing confirmed this connection, so this snapshot cannot
                // be presented as state the user can trust.
                return ConnectionManagerError.readinessUnavailable(
                    "No readiness flow owns this connection."
                )
            }
            guard isActive(session: session, generation: generation) else { return nil }
            await workspaceStore.applySnapshot(
                workspace: result.workspace,
                sequence: result.sequence,
                for: generation
            )
            return nil
        }
        let candidate = HostReadinessSnapshotCandidate(
            workspace: result.workspace,
            sequence: result.sequence
        )
        let outcome: HostReadinessTransactionResult
        do {
            outcome = try await machine.synchronizeWorkspace(candidate, for: flow)
        } catch let error as HostReadinessError {
            clearReadinessFlow()
            if case .supersededFlow = error { return nil }
            return error
        } catch {
            clearReadinessFlow()
            return error
        }
        guard isActive(session: session, generation: generation) else { return nil }
        switch outcome {
        case .committed:
            // The machine has closed the flow synchronously. Clear our mirror
            // before the store actor hop so teardown observes connection loss
            // instead of trying to fail a flow that no longer exists.
            clearReadinessFlow()
            guard let readyHostID = welcomeIdentity?.serverID else {
                return ConnectionManagerError.readinessUnavailable(
                    "Ready workspace has no committed host identity."
                )
            }
            let selection = await pairedHostStore.selectReadyHost(
                serverID: readyHostID,
                for: generation
            )
            switch selection.result {
            case .committed:
                guard let authorization = selection.authorization else {
                    return ConnectionManagerError.readinessUnavailable(
                        "Ready-host selection has no publication authorization."
                    )
                }
                guard isActive(session: session, generation: generation) else {
                    if let transaction = selection.transaction {
                        await compensateRetiredReadyHostSelection(
                            transaction,
                            authorizedBy: authorization,
                            selectedBy: generation
                        )
                    } else {
                        await pairedHostStore.cancelReadyHostSelection(
                            authorizedBy: authorization,
                            selectedBy: generation
                        )
                    }
                    return nil
                }
                await readyHostSelectionFinalizationStart()
                let publication: ReadyHostSelectionPublication?
                do {
                    publication = try await MainActor.run {
                        try generation.withValidity {
                            var finalizationID: UUID?
                            let finalized = try authorization.finalize {
                                finalizationID = try machine.finalizeReadyHostSelection(
                                    serverID: readyHostID
                                )
                            }
                            guard finalized, let finalizationID else {
                                return .superseded
                            }
                            return .finalized(finalizationID)
                        }
                    }
                    guard let publication else {
                        if let transaction = selection.transaction {
                            await compensateRetiredReadyHostSelection(
                                transaction,
                                authorizedBy: authorization,
                                selectedBy: generation
                            )
                        } else {
                            await pairedHostStore.cancelReadyHostSelection(
                                authorizedBy: authorization,
                                selectedBy: generation
                            )
                        }
                        return nil
                    }
                    guard case .finalized = publication else {
                        return ConnectionManagerError.hostIdentityNotCommitted(
                            "Ready-host selection was superseded before workspace publication."
                        )
                    }
                } catch {
                    if let transaction = selection.transaction {
                        await compensateRetiredReadyHostSelection(
                            transaction,
                            authorizedBy: authorization,
                            selectedBy: generation
                        )
                    } else {
                        await pairedHostStore.cancelReadyHostSelection(
                            authorizedBy: authorization,
                            selectedBy: generation
                        )
                    }
                    guard isActive(session: session, generation: generation) else {
                        return nil
                    }
                    return error
                }
                guard case .finalized(let finalizationID) = publication else {
                    return ConnectionManagerError.hostIdentityNotCommitted(
                        "Ready-host selection was superseded before workspace publication."
                    )
                }
                if let transaction = selection.transaction {
                    let completion = await pairedHostStore.completeReadyHostSelection(
                        transaction,
                        authorizedBy: authorization,
                        selectedBy: generation
                    )
                    switch completion {
                    case .committed:
                        await MainActor.run {
                            machine.acknowledgeReadyHostSelectionFinalization(
                                finalizationID
                            )
                        }
                    case .notCommitted:
                        await MainActor.run {
                            machine.acknowledgeReadyHostSelectionFinalization(
                                finalizationID
                            )
                        }
                    case .indeterminate(let reason):
                        let error = ConnectionManagerError
                            .hostIdentityIndeterminate(reason)
                        await MainActor.run {
                            _ = try? machine.quarantineReadyHostSelectionFinalization(
                                finalizationID,
                                reason: error.localizedDescription
                            )
                        }
                        return error
                    }
                } else {
                    await pairedHostStore.acknowledgeReadyHostSelection(
                        authorizedBy: authorization,
                        selectedBy: generation
                    )
                    await MainActor.run {
                        machine.acknowledgeReadyHostSelectionFinalization(
                            finalizationID
                        )
                    }
                }
                return nil
            case .notCommitted(let reason):
                guard let reason else { return nil }
                return ConnectionManagerError.hostIdentityNotCommitted(reason)
            case .indeterminate(let reason):
                let error = ConnectionManagerError.hostIdentityIndeterminate(reason)
                await MainActor.run {
                    _ = try? machine.revoke(reason: error.localizedDescription)
                }
                return error
            }
        case .notCommitted(let reason):
            clearReadinessFlow()
            return ConnectionManagerError.workspaceNotAccepted(reason)
        case .indeterminate(let reason):
            clearReadinessFlow()
            return ConnectionManagerError.workspaceApplyIndeterminate(reason)
        }
    }

    private func compensateRetiredReadyHostSelection(
        _ transaction: PairedHostStore.ReadyHostSelectionTransaction,
        authorizedBy authorization: ReadyHostSelectionAuthorization,
        selectedBy generation: ConnectionGeneration
    ) async {
        let result = await pairedHostStore.compensateReadyHostSelection(
            transaction,
            authorizedBy: authorization,
            selectedBy: generation
        )
        guard case .indeterminate(let reason) = result else { return }
        let machine = hostReadiness
        await MainActor.run {
            _ = try? machine.revoke(reason: reason)
        }
    }

    /// Ends the readiness flow that owned a connection which is going away.
    /// A live, already-ready connection has no flow to fail; losing it is
    /// reported as connection loss so its workspace survives, labeled stale.
    private func endReadinessFlow(reason: any Error) async {
        let machine = hostReadiness
        let description = reason.localizedDescription
        let flow = readinessFlow
        clearReadinessFlow()
        await MainActor.run {
            _ = try? machine.reconcileConnectionLoss(
                ownedFlow: flow,
                reason: description
            )
        }
    }

    private func clearReadinessFlow() {
        readinessFlow = nil
        readinessAuthorization = nil
    }

    private func failReadiness(
        _ error: any Error,
        generation: ConnectionGeneration
    ) async {
        await tearDownActiveConnection(
            generation: generation,
            readinessError: error,
            finalState: .failed(error.localizedDescription)
        )
    }

    private func handleCredentialRevocation(
        _ error: ProtocolError,
        for session: UUID,
        generation: ConnectionGeneration
    ) async {
        guard isActive(session: session, generation: generation) else { return }
        guard let activeConnection else { return }

        let persistedServerID: String?
        if let serverID = welcomeIdentity?.serverID {
            persistedServerID = serverID
        } else if case .reconnection(let host) = activeConnection.readinessIntent {
            persistedServerID = host.serverID
        } else {
            persistedServerID = nil
        }

        let persistence: HostReadinessTransactionResult
        if let persistedServerID {
            persistence = await pairedHostStore.revokeToken(
                forServerID: persistedServerID,
                expectedClientID: activeConnection.credentials.clientID,
                expectedToken: activeConnection.credentials.token
            )
        } else {
            persistence = .notCommitted(
                reason: "The rejected credential has no persisted host identity."
            )
        }
        guard isActive(session: session, generation: generation) else { return }

        let reason: String
        switch persistence {
        case .committed:
            reason = error.message
        case .notCommitted(let detail):
            reason = detail.map {
                "\(error.message) The rejected credential could not be cleared: \($0)"
            } ?? error.message
        case .indeterminate(let detail):
            reason = """
            \(error.message) Local credential revocation is indeterminate: \(detail)
            """
        }

        let machine = hostReadiness
        await MainActor.run {
            _ = try? machine.revoke(reason: reason)
        }
        clearReadinessFlow()
        await tearDownActiveConnection(
            generation: generation,
            readinessError: error,
            finalState: .failed(reason)
        )
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
        await tearDownActiveConnection(
            generation: generation,
            readinessError: error,
            finalState: .failed(error.localizedDescription)
        )
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
        await endReadinessFlow(reason: readinessError)
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
            readinessError: error,
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
            readinessError: PairingError.cancelled,
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

    private func messageProcessingEnded(
        for session: UUID,
        generation: ConnectionGeneration,
        reason: String
    ) async {
        guard isActive(session: session, generation: generation) else { return }

        transition(to: .disconnecting)
        await tearDownActiveConnection(
            generation: generation,
            readinessError: ConnectionManagerError.readinessUnavailable(reason),
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
        let readinessIntent: ReadinessIntent

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
                readinessIntent: readinessIntent
            )
        }
    }

    /// How a connection attempt relates to host authority. A stored host is a
    /// reconnection to the identity already committed, and must fail closed if
    /// the host that answers is not that identity. Anything else is a pairing
    /// flow, which owns no authority until an identity commits.
    private enum ReadinessIntent {
        case pairing
        case reconnection(PairedHost)
    }

    private enum MessageHandlingResult: Equatable {
        case ignored
        case processed
        case failed(String)
    }
}
