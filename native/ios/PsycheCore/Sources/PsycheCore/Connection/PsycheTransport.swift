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

    private let stream: AsyncStream<ServerMessage>
    private let continuation: AsyncStream<ServerMessage>.Continuation
    private var scriptedMessages: [ServerMessage]
    private let shouldFailConnection: Bool

    public init(scriptedMessages: [ServerMessage] = [], shouldFailConnection: Bool = false) {
        var capturedContinuation: AsyncStream<ServerMessage>.Continuation?
        stream = AsyncStream { capturedContinuation = $0 }
        continuation = capturedContinuation!
        self.scriptedMessages = scriptedMessages
        self.shouldFailConnection = shouldFailConnection
    }

    public func connect(to endpoint: HostEndpoint) async throws {
        connectionAttempts.append(endpoint)
        guard !shouldFailConnection else { throw FakeTransportError.connectionFailed }
        isConnected = true
        scriptedMessages.forEach { continuation.yield($0) }
        scriptedMessages.removeAll()
    }

    public func disconnect() async {
        isConnected = false
    }

    public func send(_ message: ClientMessage) async throws {
        guard isConnected else { throw FakeTransportError.connectionFailed }
        sentMessages.append(message)
    }

    public func incomingMessages() async -> AsyncStream<ServerMessage> {
        stream
    }

    public func emit(_ message: ServerMessage) {
        continuation.yield(message)
    }
}
