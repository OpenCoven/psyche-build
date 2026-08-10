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

public enum ConnectionManagerError: Error, Sendable, Equatable, LocalizedError {
    case missingWelcomeIdentity
    case unsupportedProtocolVersion(Int)
    case messageProcessorEndedBeforeReady
    case connectionCancelled

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
    private var clientID: String
    private let clientName: String
    private var token: String?
    private var activeEndpoint: HostEndpoint?
    private var welcomeIdentity: WelcomeIdentity?
    private var messageTask: Task<Void, Never>?
    private var snapshotRequestTask: Task<Void, Never>?
    private var nextConnectionGeneration: UInt64 = 0
    private var activeGeneration: ConnectionGeneration?
    private var activeConnectAttempt: UUID?
    private var activeMessageSession: UUID?
    private var activeSnapshotRequestID: String?
    private var hasActiveTransport = false
    private var isConnectInFlight = false
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
        messageProcessorStart: @escaping @Sendable () async -> Void = {}
    ) {
        self.transport = transport
        self.workspaceStore = workspaceStore
        self.requestClient = requestClient
        self.pairedHostStore = pairedHostStore
        self.clientID = clientID
        self.clientName = clientName
        self.token = token
        self.messageProcessorStart = messageProcessorStart
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
    }

    public func connectToStoredHost() async {
        do {
            guard let host = try await pairedHostStore.hosts().first else { return }
            clientID = host.clientID
            token = host.token
            await connect(to: host.endpoint)
        } catch {
            await tearDownActiveConnection()
            transition(to: .failed(error.localizedDescription))
        }
    }

    public func connect(to endpoint: HostEndpoint) async {
        // Guard on execution, not on state. connect() keeps awaiting past the
        // .authenticating transition and the actor yields at every await.
        guard !isConnectInFlight else { return }
        guard state != .disconnecting else { return }
        isConnectInFlight = true
        let attempt = UUID()
        defer {
            isConnectInFlight = false
        }

        await tearDownActiveConnection()
        guard !Task.isCancelled else {
            transition(to: .failed(ConnectionManagerError.connectionCancelled.localizedDescription))
            return
        }
        nextConnectionGeneration &+= 1
        let generation = ConnectionGeneration(id: nextConnectionGeneration)
        activeGeneration = generation
        activeConnectAttempt = attempt
        transition(to: .connecting)

        do {
            try await withTaskCancellationHandler {
                try Task.checkCancellation()
                try await transport.connect(to: endpoint)
                guard isActive(attempt: attempt, generation: generation) else { return }
                hasActiveTransport = true
                try Task.checkCancellation()
                await requestClient.beginGeneration(generation)
                guard isActive(attempt: attempt, generation: generation) else { return }
                await workspaceStore.beginConnection(for: generation)
                guard isActive(attempt: attempt, generation: generation) else { return }
                activeEndpoint = endpoint
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
                    clientID: clientID,
                    clientName: clientName,
                    protocolVersion: PsycheProtocolVersion.current,
                    token: token
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
                readinessError: error
            )
            transition(to: .failed(error.localizedDescription))
        } catch {
            guard isActive(attempt: attempt, generation: generation) else { return }
            await tearDownActiveConnection(
                generation: generation,
                readinessError: error
            )
            transition(to: .failed(error.localizedDescription))
        }
    }

    public func disconnect() async {
        guard state != .disconnected else {
            await resetPerConnectionState()
            return
        }
        transition(to: .disconnecting)
        await tearDownActiveConnection()
        transition(to: .disconnected)
    }

    /// Defaults to the identity already announced in `hello`. Passing a
    /// different one is possible but binds the token to an identity the server
    /// never saw during the handshake, which is painful to debug.
    public func pair(
        code: String,
        clientID: String? = nil,
        clientName: String? = nil
    ) async {
        guard hasActiveTransport else { return }

        do {
            try await transport.send(.legacy(.pair(PairRequestPayload(
                code: code,
                clientID: clientID ?? self.clientID,
                clientName: clientName ?? self.clientName
            ))))
        } catch {
            await tearDownActiveConnection()
            transition(to: .failed(error.localizedDescription))
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
            hasNegotiatedV3 = true
            transition(to: .connected)
            completeNegotiation(for: session, with: .success(()))
            await requestInitialSnapshotIfAuthorized(
                for: session,
                generation: generation
            )
        case .projectList(let projects):
            self.projects = projects
        case .paneList(let panes), .paneListChanged(let panes):
            self.panes = panes
        case .paneOutput(let output):
            latestOutputByPane[output.paneID] = output
        case .error(let error):
            return .failed(error.message)
        case .pairAccepted(let payload):
            guard let welcomeIdentity, let activeEndpoint else {
                return .failed(ConnectionManagerError.missingWelcomeIdentity.localizedDescription)
            }
            guard isActive(session: session, generation: generation),
                  !Task.isCancelled else {
                return .ignored
            }
            do {
                let committed = try await pairedHostStore.save(PairedHost(
                    serverID: welcomeIdentity.serverID,
                    serverName: welcomeIdentity.serverName,
                    endpoint: activeEndpoint,
                    clientID: clientID,
                    token: payload.token
                ), for: generation)
                guard committed else { return .ignored }
            } catch is CancellationError {
                return .ignored
            } catch {
                return .failed(error.localizedDescription)
            }
            guard isActive(session: session, generation: generation),
                  !Task.isCancelled else {
                return .ignored
            }
            token = payload.token
            await requestInitialSnapshotIfAuthorized(
                for: session,
                generation: generation
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
        if case .workspaceSnapshot = response, !hasNegotiatedV3 {
            return .ignored
        }
        let wasHandled = await requestClient.handle(response, for: generation)
        guard isActive(session: session, generation: generation) else { return .ignored }

        switch response {
        case .workspaceSnapshot(let result):
            guard activeSnapshotRequestID == result.requestID else {
                return .ignored
            }
            isSnapshotRecoveryInFlight = false
            activeSnapshotRequestID = nil
            snapshotRequestTask = nil
            await workspaceStore.applySnapshot(
                workspace: result.workspace,
                sequence: result.sequence,
                for: generation
            )
        case .error(let error) where !wasHandled:
            return .failed(error.message)
        default:
            break
        }
        return .processed
    }

    private func requestInitialSnapshotIfAuthorized(
        for session: UUID,
        generation: ConnectionGeneration
    ) async {
        guard isActive(session: session, generation: generation) else { return }
        guard token?.isEmpty == false, !requestedInitialSnapshot else { return }
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
              token?.isEmpty == false,
              !isSnapshotRecoveryInFlight else {
            return
        }

        isSnapshotRecoveryInFlight = true
        let requestID = await requestClient.nextRequestID()
        guard isActive(session: session, generation: generation),
              hasActiveTransport else {
            return
        }

        activeSnapshotRequestID = requestID
        let requestClient = self.requestClient
        snapshotRequestTask = Task { [weak self, requestClient] in
            do {
                _ = try await requestClient.send(
                    .workspaceSnapshot(ControlRequestIDOnly(requestID: requestID)),
                    for: generation
                )
            } catch is CancellationError {
                return
            } catch {
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
              activeSnapshotRequestID == requestID else {
            return
        }
        isSnapshotRecoveryInFlight = false
        activeSnapshotRequestID = nil
        snapshotRequestTask = nil
        await tearDownActiveConnection(generation: generation)
        transition(to: .failed(error.localizedDescription))
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
        readinessError: any Error = ConnectionManagerError.messageProcessorEndedBeforeReady
    ) async {
        guard let generation = activeGeneration,
              expectedGeneration == nil || generation === expectedGeneration else {
            return
        }
        let session = activeMessageSession
        generation.invalidate()
        activeGeneration = nil
        activeConnectAttempt = nil
        activeMessageSession = nil
        completeMessageProcessorReadiness(for: session, with: .failure(readinessError))
        completeNegotiation(for: session, with: .failure(readinessError))
        messageTask?.cancel()
        messageTask = nil
        let shouldDisconnectTransport = hasActiveTransport
        hasActiveTransport = false
        await resetPerConnectionState(generation: generation)
        if shouldDisconnectTransport {
            await transport.disconnect()
        }
    }

    private func resetPerConnectionState(
        generation: ConnectionGeneration? = nil
    ) async {
        snapshotRequestTask?.cancel()
        snapshotRequestTask = nil
        activeSnapshotRequestID = nil
        requestedInitialSnapshot = false
        isSnapshotRecoveryInFlight = false
        activeEndpoint = nil
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
            readinessError: error
        )
        transition(to: .failed(error.localizedDescription))
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
        await tearDownActiveConnection(generation: generation)
        transition(to: .failed(reason))
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

    private enum MessageHandlingResult: Equatable {
        case ignored
        case processed
        case failed(String)
    }
}
