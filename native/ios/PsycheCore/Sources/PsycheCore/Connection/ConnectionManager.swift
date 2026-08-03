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
    private let token: String?
    private var messageTask: Task<Void, Never>?

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
        guard state == .disconnected || isFailed else { return }
        transition(to: .connecting)

        do {
            try await transport.connect(to: endpoint)
            transition(to: .authenticating)
            let messages = await transport.incomingMessages()
            messageTask = Task { [weak self] in
                for await message in messages {
                    guard !Task.isCancelled else { return }
                    await self?.handle(message)
                }
            }
            try await transport.send(.hello(HelloPayload(
                clientID: clientID,
                clientName: clientName,
                token: token
            )))
            try await transport.send(.listProjects(EmptyPayload()))
            try await transport.send(.listPanes(EmptyPayload()))
        } catch {
            transition(to: .failed(error.localizedDescription))
        }
    }

    public func disconnect() async {
        guard state != .disconnected else { return }
        transition(to: .disconnecting)
        messageTask?.cancel()
        messageTask = nil
        await transport.disconnect()
        transition(to: .disconnected)
    }

    private var isFailed: Bool {
        if case .failed = state { return true }
        return false
    }

    private func handle(_ message: ServerMessage) {
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
            transition(to: .failed(error.message))
        default:
            break
        }
    }

    private func transition(to newState: ConnectionState) {
        state = newState
        stateHistory.append(newState)
    }
}
