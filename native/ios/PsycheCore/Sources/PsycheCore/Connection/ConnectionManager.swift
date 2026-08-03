import Foundation

public actor ConnectionManager {
    public private(set) var state: ConnectionState = .disconnected
    public private(set) var stateHistory: [ConnectionState] = [.disconnected]
    public private(set) var projects: [Project] = []
    public private(set) var panes: [PaneSnapshot] = []
    public private(set) var latestOutputByPane: [String: PaneOutputPayload] = [:]

    private let transport: any PsycheTransport
    private let clientID: String
    private let clientName: String
    private var token: String?
    private var messageTask: Task<Void, Never>?
    private var activeMessageSession: UUID?
    private var hasActiveTransport = false
    private var requestedInitialSnapshots = false
    private var isMessageProcessorReady = false
    private var messageProcessorReadyWaiters: [CheckedContinuation<Void, Never>] = []
    private var processedMessageCount = 0
    private var eventDrainWaiters: [UUID: (count: Int, continuation: CheckedContinuation<Void, Never>)] = [:]
    private var stateWaiters: [UUID: (state: ConnectionState, continuation: CheckedContinuation<Void, Never>)] = [:]

    public init(
        transport: any PsycheTransport,
        clientID: String = UUID().uuidString,
        clientName: String = "Psyche iOS",
        token: String? = nil
    ) {
        self.transport = transport
        self.clientID = clientID
        self.clientName = clientName
        self.token = token
    }

    deinit {
        messageTask?.cancel()
    }

    public func connect(to endpoint: HostEndpoint) async {
        guard state != .connecting && state != .disconnecting else { return }
        await tearDownActiveConnection()
        transition(to: .connecting)

        do {
            try await transport.connect(to: endpoint)
            hasActiveTransport = true
            requestedInitialSnapshots = false
            transition(to: .authenticating)
            let messages = await transport.incomingMessages()
            isMessageProcessorReady = false
            let session = UUID()
            activeMessageSession = session
            messageTask = Task { [weak self] in
                await self?.markMessageProcessorReady()
                for await message in messages {
                    guard !Task.isCancelled else { return }
                    guard let result = await self?.handle(message, for: session) else { return }
                    if case let .failed(reason) = result {
                        await self?.messageProcessingEnded(for: session, reason: reason)
                        return
                    }
                }
                guard !Task.isCancelled else { return }
                await self?.messageProcessingEnded(for: session, reason: "Connection closed unexpectedly")
            }
            await waitForMessageProcessorReadiness()
            try await transport.send(.hello(HelloPayload(
                clientID: clientID,
                clientName: clientName,
                token: token
            )))
            try await requestInitialSnapshotsIfAuthorized()
        } catch {
            await tearDownActiveConnection()
            transition(to: .failed(error.localizedDescription))
        }
    }

    public func disconnect() async {
        guard state != .disconnected else { return }
        transition(to: .disconnecting)
        await tearDownActiveConnection()
        transition(to: .disconnected)
    }

    public func pair(code: String, clientID: String, clientName: String) async {
        guard hasActiveTransport else { return }

        do {
            try await transport.send(.pair(PairRequestPayload(
                code: code,
                clientID: clientID,
                clientName: clientName
            )))
        } catch {
            await tearDownActiveConnection()
            transition(to: .failed(error.localizedDescription))
        }
    }

    func waitForMessageProcessorReadiness() async {
        guard !isMessageProcessorReady else { return }
        await withCheckedContinuation { continuation in
            messageProcessorReadyWaiters.append(continuation)
        }
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

    private func markMessageProcessorReady() {
        isMessageProcessorReady = true
        messageProcessorReadyWaiters.forEach { $0.resume() }
        messageProcessorReadyWaiters.removeAll()
    }

    private func handle(_ message: ServerMessage, for session: UUID) async -> MessageHandlingResult {
        guard activeMessageSession == session else { return .ignored }

        switch message {
        case .welcome:
            transition(to: .connected)
        case .projectList(let projects):
            self.projects = projects
        case .paneList(let panes), .paneListChanged(let panes):
            self.panes = panes
        case .paneOutput(let output):
            latestOutputByPane[output.paneID] = output
        case .error(let error):
            return .failed(error.message)
        case .pairAccepted(let payload):
            token = payload.token
            do {
                try await requestInitialSnapshotsIfAuthorized()
            } catch {
                return .failed(error.localizedDescription)
            }
        default:
            break
        }
        processedMessageCount += 1
        let completedWaiters = eventDrainWaiters.filter { processedMessageCount >= $0.value.count }
        completedWaiters.forEach { waiterID, waiter in
            eventDrainWaiters.removeValue(forKey: waiterID)
            waiter.continuation.resume()
        }
        return .processed
    }

    private func requestInitialSnapshotsIfAuthorized() async throws {
        guard token?.isEmpty == false, !requestedInitialSnapshots else { return }
        try await transport.send(.listProjects(EmptyPayload()))
        try await transport.send(.listPanes(EmptyPayload()))
        requestedInitialSnapshots = true
    }

    private func tearDownActiveConnection() async {
        activeMessageSession = nil
        let task = messageTask
        messageTask = nil
        task?.cancel()
        if let task {
            await task.value
        }
        if hasActiveTransport {
            await transport.disconnect()
            hasActiveTransport = false
        }
    }

    private func messageProcessingEnded(for session: UUID, reason: String) async {
        guard activeMessageSession == session else { return }

        activeMessageSession = nil
        messageTask = nil
        transition(to: .disconnecting)
        if hasActiveTransport {
            await transport.disconnect()
            hasActiveTransport = false
        }
        transition(to: .failed(reason))
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

    private enum MessageHandlingResult {
        case ignored
        case processed
        case failed(String)
    }
}
