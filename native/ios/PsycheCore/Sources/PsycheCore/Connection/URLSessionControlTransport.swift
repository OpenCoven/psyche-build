import Foundation

protocol ControlWebSocketTask: Sendable {
    func resume() async
    func cancel() async
    func send(_ message: URLSessionWebSocketTask.Message) async throws
    func receive() async throws -> URLSessionWebSocketTask.Message
}

protocol ControlWebSocketSession: Sendable {
    func makeWebSocketTask(with url: URL) async -> any ControlWebSocketTask
    func invalidateAndCancel() async
}

protocol ControlWebSocketSessionFactory: Sendable {
    func makeSession(delegate: PinnedCertificateDelegate) -> any ControlWebSocketSession
}

public enum URLSessionControlTransportError: Error, Sendable, Equatable, LocalizedError {
    case invalidEndpoint
    case notConnected
    case malformedInboundFrame
    case certificatePinRejected

    public var errorDescription: String? {
        switch self {
        case .invalidEndpoint:
            "The paired host address is invalid. Re-pair this device with the host."
        case .notConnected:
            "The control connection is not active."
        case .malformedInboundFrame:
            "The host sent a malformed control frame."
        case .certificatePinRejected:
            "The host certificate does not match the pinned fingerprint. Re-pair this device with the host."
        }
    }
}

public actor URLSessionControlTransport: PsycheTransport {
    private let sessionFactory: any ControlWebSocketSessionFactory

    private var generation: UInt64 = 0
    private var pinDelegate: PinnedCertificateDelegate?
    private var session: (any ControlWebSocketSession)?
    private var socket: (any ControlWebSocketTask)?
    private var receiveTask: Task<Void, Never>?
    private var messageStream: AsyncStream<MobileServerMessage>?
    private var messageContinuation: AsyncStream<MobileServerMessage>.Continuation?
    private var binaryStream: AsyncStream<TerminalBinaryFrame>?
    private var binaryContinuation: AsyncStream<TerminalBinaryFrame>.Continuation?
    private var storedLastFailure: URLSessionControlTransportError?

    public init() {
        sessionFactory = LiveControlWebSocketSessionFactory()
    }

    init(sessionFactory: any ControlWebSocketSessionFactory) {
        self.sessionFactory = sessionFactory
    }

    deinit {
        receiveTask?.cancel()
        messageContinuation?.finish()
        binaryContinuation?.finish()
    }

    public func connect(to endpoint: HostEndpoint) async throws {
        let delegate = try PinnedCertificateDelegate(
            certificateFingerprint: endpoint.certificateFingerprint
        )
        let url = try Self.webSocketURL(for: endpoint)

        generation &+= 1
        let connectionGeneration = generation
        await clearConnection()
        try ensureCurrent(connectionGeneration)
        storedLastFailure = nil

        let (messageStream, messageContinuation) = AsyncStream<MobileServerMessage>.makeStream()
        let (binaryStream, binaryContinuation) = AsyncStream<TerminalBinaryFrame>.makeStream()
        self.messageStream = messageStream
        self.messageContinuation = messageContinuation
        self.binaryStream = binaryStream
        self.binaryContinuation = binaryContinuation
        pinDelegate = delegate

        let session = sessionFactory.makeSession(delegate: delegate)
        self.session = session
        let socket = await session.makeWebSocketTask(with: url)
        guard generation == connectionGeneration else {
            await socket.cancel()
            throw CancellationError()
        }
        self.socket = socket

        await socket.resume()
        try ensureCurrent(connectionGeneration)

        receiveTask = Task { [weak self, socket] in
            do {
                while !Task.isCancelled {
                    let message = try await socket.receive()
                    try Task.checkCancellation()
                    guard let self,
                          try await self.route(message, for: connectionGeneration) else {
                        return
                    }
                }
            } catch is CancellationError {
                return
            } catch {
                await self?.terminateConnection(for: connectionGeneration)
            }
        }
    }

    public func disconnect() async {
        generation &+= 1
        await clearConnection()
    }

    public func send(_ message: MobileClientMessage) async throws {
        guard let socket else {
            throw URLSessionControlTransportError.notConnected
        }
        let data = try JSONEncoder().encode(message)
        try await socket.send(.string(String(decoding: data, as: UTF8.self)))
    }

    public func incomingMessages() async -> AsyncStream<MobileServerMessage> {
        messageStream ?? Self.finishedStream()
    }

    public func incomingBinaryFrames() async -> AsyncStream<TerminalBinaryFrame> {
        binaryStream ?? Self.finishedStream()
    }

    private func route(
        _ message: URLSessionWebSocketTask.Message,
        for connectionGeneration: UInt64
    ) throws -> Bool {
        guard generation == connectionGeneration else { return false }

        switch message {
        case .string(let string):
            let decoded = try JSONDecoder().decode(
                MobileServerMessage.self,
                from: Data(string.utf8)
            )
            messageContinuation?.yield(decoded)
        case .data(let data):
            if (try? JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed)) != nil {
                let decoded = try JSONDecoder().decode(MobileServerMessage.self, from: data)
                messageContinuation?.yield(decoded)
            } else {
                guard let frame = try? TerminalBinaryFrame.decode(data) else {
                    throw URLSessionControlTransportError.malformedInboundFrame
                }
                binaryContinuation?.yield(frame)
            }
        @unknown default:
            throw URLSessionControlTransportError.malformedInboundFrame
        }

        return true
    }

    /// The reason the last connection ended, when the transport can name one.
    /// A pin rejection arrives as an ordinary socket error, so the streams
    /// finish either way; this is what turns that silence into re-pair guidance.
    public func lastFailure() -> URLSessionControlTransportError? {
        storedLastFailure
    }

    private func terminateConnection(for connectionGeneration: UInt64) async {
        guard generation == connectionGeneration else { return }
        generation &+= 1
        let rejectedPin = pinDelegate?.didRejectPin == true
        if rejectedPin {
            storedLastFailure = .certificatePinRejected
        }
        await clearConnection()
    }

    private func clearConnection() async {
        let receiveTask = self.receiveTask
        let socket = self.socket
        let session = self.session
        let messageContinuation = self.messageContinuation
        let binaryContinuation = self.binaryContinuation

        self.receiveTask = nil
        self.socket = nil
        self.session = nil
        pinDelegate = nil
        messageStream = nil
        self.messageContinuation = nil
        binaryStream = nil
        self.binaryContinuation = nil

        receiveTask?.cancel()
        messageContinuation?.finish()
        binaryContinuation?.finish()
        await socket?.cancel()
        await session?.invalidateAndCancel()
    }

    private func ensureCurrent(_ connectionGeneration: UInt64) throws {
        guard generation == connectionGeneration else {
            throw CancellationError()
        }
    }

    private static func webSocketURL(for endpoint: HostEndpoint) throws -> URL {
        guard !endpoint.host.isEmpty, (1...65_535).contains(endpoint.port) else {
            throw URLSessionControlTransportError.invalidEndpoint
        }

        var host = endpoint.host
        if host.hasPrefix("["), host.hasSuffix("]") {
            host.removeFirst()
            host.removeLast()
        }

        var components = URLComponents()
        components.scheme = "wss"
        components.host = host.contains(":") ? "[\(host)]" : host
        components.port = endpoint.port
        guard let url = components.url else {
            throw URLSessionControlTransportError.invalidEndpoint
        }
        return url
    }

    private static func finishedStream<Element: Sendable>() -> AsyncStream<Element> {
        AsyncStream { continuation in
            continuation.finish()
        }
    }
}

private struct LiveControlWebSocketSessionFactory: ControlWebSocketSessionFactory {
    func makeSession(delegate: PinnedCertificateDelegate) -> any ControlWebSocketSession {
        let configuration = URLSessionConfiguration.ephemeral
        return LiveControlWebSocketSession(URLSession(
            configuration: configuration,
            delegate: delegate,
            delegateQueue: nil
        ))
    }
}

private final class LiveControlWebSocketSession: ControlWebSocketSession, @unchecked Sendable {
    private let session: URLSession

    init(_ session: URLSession) {
        self.session = session
    }

    func makeWebSocketTask(with url: URL) async -> any ControlWebSocketTask {
        LiveControlWebSocketTask(session.webSocketTask(with: url))
    }

    func invalidateAndCancel() async {
        session.invalidateAndCancel()
    }
}

private final class LiveControlWebSocketTask: ControlWebSocketTask, @unchecked Sendable {
    private let task: URLSessionWebSocketTask

    init(_ task: URLSessionWebSocketTask) {
        self.task = task
    }

    func resume() async {
        task.resume()
    }

    func cancel() async {
        task.cancel(with: .goingAway, reason: nil)
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        try await task.send(message)
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        try await task.receive()
    }
}
