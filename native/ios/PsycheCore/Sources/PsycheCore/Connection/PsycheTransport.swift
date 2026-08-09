import Foundation

public protocol PsycheTransport: Sendable {
    func connect(to endpoint: HostEndpoint) async throws
    func disconnect() async
    func send(_ message: MobileClientMessage) async throws
    func incomingMessages() async -> AsyncStream<MobileServerMessage>
    func incomingBinaryFrames() async -> AsyncStream<TerminalBinaryFrame>
}

public struct TerminalBinaryFrame: Sendable, Equatable {
    public let streamID: String
    public let sequence: UInt64
    public let payload: Data

    public init(streamID: String, sequence: UInt64, payload: Data) {
        self.streamID = streamID
        self.sequence = sequence
        self.payload = payload
    }

    public static func decode(_ data: Data) throws -> TerminalBinaryFrame {
        guard let idLengthByte = data.first else {
            throw TerminalBinaryFrameError.truncatedHeader
        }

        let idLength = Int(idLengthByte)
        guard idLength > 0 else {
            throw TerminalBinaryFrameError.emptyStreamID
        }

        let sequenceOffset = 1 + idLength
        let payloadOffset = sequenceOffset + MemoryLayout<UInt64>.size
        guard data.count >= payloadOffset else {
            throw TerminalBinaryFrameError.truncatedHeader
        }

        let idRange = data.index(data.startIndex, offsetBy: 1)..<data.index(
            data.startIndex,
            offsetBy: sequenceOffset
        )
        guard let streamID = String(data: data[idRange], encoding: .utf8) else {
            throw TerminalBinaryFrameError.invalidStreamID
        }

        var sequence: UInt64 = 0
        for byte in data.dropFirst(sequenceOffset).prefix(MemoryLayout<UInt64>.size) {
            sequence = (sequence << 8) | UInt64(byte)
        }

        return TerminalBinaryFrame(
            streamID: streamID,
            sequence: sequence,
            payload: Data(data.dropFirst(payloadOffset))
        )
    }
}

public enum TerminalBinaryFrameError: Error, Sendable, Equatable {
    case emptyStreamID
    case truncatedHeader
    case invalidStreamID
}

public enum FakeTransportError: Error, Sendable, Equatable {
    case connectionFailed
}

public actor FakeTransport: PsycheTransport {
    public private(set) var connectionAttempts: [HostEndpoint] = []
    public private(set) var sentMessages: [MobileClientMessage] = []
    public private(set) var isConnected = false
    public private(set) var disconnectCount = 0
    public private(set) var incomingMessageStreamCount = 0
    public private(set) var incomingBinaryFrameStreamCount = 0

    private var connections: [FakeConnection] = []
    private var activeConnectionIndex: Int?
    private var scriptedMessages: [MobileServerMessage]
    private let shouldFailConnection: Bool

    public init(
        scriptedMessages: [MobileServerMessage] = [],
        shouldFailConnection: Bool = false
    ) {
        self.scriptedMessages = scriptedMessages
        self.shouldFailConnection = shouldFailConnection
    }

    public func connect(to endpoint: HostEndpoint) async throws {
        connectionAttempts.append(endpoint)
        guard !shouldFailConnection else { throw FakeTransportError.connectionFailed }

        finishActiveConnection()
        let (messageStream, messageContinuation) = AsyncStream<MobileServerMessage>.makeStream()
        let (binaryStream, binaryContinuation) = AsyncStream<TerminalBinaryFrame>.makeStream()
        connections.append(FakeConnection(
            messageStream: messageStream,
            messageContinuation: messageContinuation,
            binaryStream: binaryStream,
            binaryContinuation: binaryContinuation
        ))
        activeConnectionIndex = connections.index(before: connections.endIndex)
        isConnected = true

        scriptedMessages.forEach { messageContinuation.yield($0) }
        scriptedMessages.removeAll()
    }

    public func disconnect() async {
        isConnected = false
        disconnectCount += 1
        finishActiveConnection()
    }

    public func send(_ message: MobileClientMessage) async throws {
        guard isConnected else { throw FakeTransportError.connectionFailed }
        sentMessages.append(message)
    }

    public func incomingMessages() async -> AsyncStream<MobileServerMessage> {
        guard let connection = activeConnection else {
            return Self.finishedStream()
        }
        incomingMessageStreamCount += 1
        return connection.messageStream
    }

    public func incomingBinaryFrames() async -> AsyncStream<TerminalBinaryFrame> {
        guard let connection = activeConnection else {
            return Self.finishedStream()
        }
        incomingBinaryFrameStreamCount += 1
        return connection.binaryStream
    }

    public func emit(_ message: MobileServerMessage) {
        activeConnection?.messageContinuation.yield(message)
    }

    public func emit(_ message: MobileServerMessage, onConnection index: Int) {
        guard connections.indices.contains(index) else { return }
        connections[index].messageContinuation.yield(message)
    }

    public func emit(_ frame: TerminalBinaryFrame) {
        activeConnection?.binaryContinuation.yield(frame)
    }

    public func emit(_ frame: TerminalBinaryFrame, onConnection index: Int) {
        guard connections.indices.contains(index) else { return }
        connections[index].binaryContinuation.yield(frame)
    }

    public func finishIncomingMessages() {
        activeConnection?.messageContinuation.finish()
    }

    public func finishIncomingBinaryFrames() {
        activeConnection?.binaryContinuation.finish()
    }

    private var activeConnection: FakeConnection? {
        guard let activeConnectionIndex else { return nil }
        return connections[activeConnectionIndex]
    }

    private func finishActiveConnection() {
        guard let activeConnectionIndex else { return }
        connections[activeConnectionIndex].messageContinuation.finish()
        connections[activeConnectionIndex].binaryContinuation.finish()
        self.activeConnectionIndex = nil
    }

    private static func finishedStream<Element: Sendable>() -> AsyncStream<Element> {
        AsyncStream { continuation in
            continuation.finish()
        }
    }

    private struct FakeConnection {
        let messageStream: AsyncStream<MobileServerMessage>
        let messageContinuation: AsyncStream<MobileServerMessage>.Continuation
        let binaryStream: AsyncStream<TerminalBinaryFrame>
        let binaryContinuation: AsyncStream<TerminalBinaryFrame>.Continuation
    }
}
