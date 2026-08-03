import Foundation

public protocol PsycheTransport: Sendable {
    func connect(to endpoint: HostEndpoint) async throws
    func disconnect() async
    func send(_ message: ClientMessage) async throws
    func incomingMessages() async -> AsyncStream<ServerMessage>
}

public enum FakeTransportError: Error, Sendable, Equatable {
    case connectionFailed
}

public actor FakeTransport: PsycheTransport {
    public private(set) var connectionAttempts: [HostEndpoint] = []
    public private(set) var sentMessages: [ClientMessage] = []
    public private(set) var isConnected = false
    public private(set) var disconnectCount = 0
    public private(set) var incomingMessageStreamCount = 0

    private var continuations: [AsyncStream<ServerMessage>.Continuation] = []
    private var scriptedMessages: [ServerMessage]
    private let shouldFailConnection: Bool

    public init(scriptedMessages: [ServerMessage] = [], shouldFailConnection: Bool = false) {
        self.scriptedMessages = scriptedMessages
        self.shouldFailConnection = shouldFailConnection
    }

    public func connect(to endpoint: HostEndpoint) async throws {
        connectionAttempts.append(endpoint)
        guard !shouldFailConnection else { throw FakeTransportError.connectionFailed }
        isConnected = true
    }

    public func disconnect() async {
        isConnected = false
        disconnectCount += 1
        continuations.last?.finish()
    }

    public func send(_ message: ClientMessage) async throws {
        guard isConnected else { throw FakeTransportError.connectionFailed }
        sentMessages.append(message)
    }

    public func incomingMessages() async -> AsyncStream<ServerMessage> {
        var capturedContinuation: AsyncStream<ServerMessage>.Continuation?
        let stream = AsyncStream<ServerMessage> { capturedContinuation = $0 }
        let continuation = capturedContinuation!
        continuations.append(continuation)
        incomingMessageStreamCount += 1
        scriptedMessages.forEach { continuation.yield($0) }
        scriptedMessages.removeAll()
        return stream
    }

    public func emit(_ message: ServerMessage) {
        continuations.last?.yield(message)
    }

    public func emit(_ message: ServerMessage, onConnection index: Int) {
        guard continuations.indices.contains(index) else { return }
        continuations[index].yield(message)
    }

    public func finishIncomingMessages() {
        continuations.last?.finish()
    }
}
