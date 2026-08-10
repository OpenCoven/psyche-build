import Foundation

/// A terminal stream the host has attached for this connection.
public struct TerminalSession: Sendable, Equatable {
    public let paneID: String
    public let streamID: String
    public let latestSequence: UInt64
    public let hasReplay: Bool
    public let replayMode: TerminalReplayMode

    public init(
        paneID: String,
        streamID: String,
        latestSequence: UInt64,
        hasReplay: Bool,
        replayMode: TerminalReplayMode
    ) {
        self.paneID = paneID
        self.streamID = streamID
        self.latestSequence = latestSequence
        self.hasReplay = hasReplay
        self.replayMode = replayMode
    }
}

public enum TerminalControlError: Error, Sendable, Equatable, LocalizedError {
    case unexpectedResponse
    case inputRejected
    case notAttached(String)

    public var errorDescription: String? {
        switch self {
        case .unexpectedResponse:
            "The host answered a terminal request with something else."
        case .inputRejected:
            "The host rejected the terminal input."
        case .notAttached(let paneID):
            "Pane \(paneID) is not attached."
        }
    }
}

/// The terminal half of the control protocol, kept narrow so the registry can
/// be tested without a transport.
public protocol TerminalControlling: Sendable {
    func attach(paneID: String, sinceSequence: UInt64?) async throws -> TerminalSession
    func detach(streamID: String) async throws
    func send(_ data: Data, toStream streamID: String) async throws
    func resize(streamID: String, columns: Int, rows: Int) async throws
    func incomingFrames() async -> AsyncStream<TerminalBinaryFrame>
}

public actor TerminalControlClient: TerminalControlling {
    private let requests: any ControlRequesting
    private let transport: any PsycheTransport

    public init(requests: any ControlRequesting, transport: any PsycheTransport) {
        self.requests = requests
        self.transport = transport
    }

    public func attach(paneID: String, sinceSequence: UInt64?) async throws -> TerminalSession {
        let requestID = await requests.nextRequestID()
        let response = try await requests.send(.attachPane(MobilePaneAttachRequest(
            requestID: requestID,
            id: paneID,
            columns: nil,
            rows: nil,
            sinceSequence: sinceSequence
        )))
        guard case let .attachPane(result) = response else {
            throw TerminalControlError.unexpectedResponse
        }
        return TerminalSession(
            paneID: result.id,
            streamID: result.streamID,
            latestSequence: result.latestSequence,
            hasReplay: result.hasReplay,
            replayMode: result.replayMode
        )
    }

    public func detach(streamID: String) async throws {
        let requestID = await requests.nextRequestID()
        _ = try await requests.send(.detachPane(PaneDetachRequest(
            requestID: requestID,
            streamID: streamID
        )))
    }

    public func send(_ data: Data, toStream streamID: String) async throws {
        let requestID = await requests.nextRequestID()
        // The host decodes this with a strict base64 reader and refuses
        // anything it cannot read, rather than typing mangled bytes.
        let response = try await requests.send(.inputPane(PaneInputRequest(
            requestID: requestID,
            streamID: streamID,
            data: data.base64EncodedString()
        )))
        guard case let .ack(ack) = response else {
            throw TerminalControlError.unexpectedResponse
        }
        guard ack.ok else {
            throw TerminalControlError.inputRejected
        }
    }

    public func resize(streamID: String, columns: Int, rows: Int) async throws {
        let requestID = await requests.nextRequestID()
        _ = try await requests.send(.resizePane(PaneResizeRequest(
            requestID: requestID,
            streamID: streamID,
            cols: columns,
            rows: rows
        )))
    }

    public func incomingFrames() async -> AsyncStream<TerminalBinaryFrame> {
        await transport.incomingBinaryFrames()
    }
}
