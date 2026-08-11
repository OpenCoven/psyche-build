import Foundation

/// A terminal client that never opens a socket.
///
/// A `-uiFixture` launch has no host, so the workspace it renders would show
/// empty terminals. This replays canned output per pane instead, which keeps
/// the fixture shell exercising the same registry the live app uses.
public actor FixtureTerminalClient: TerminalControlling {
    private let outputByPaneID: [String: String]
    private let sendFails: Bool
    private let frames: AsyncStream<TerminalBinaryFrame>
    private let continuation: AsyncStream<TerminalBinaryFrame>.Continuation
    private var sequenceByPaneID: [String: UInt64] = [:]

    public init(
        outputByPaneID: [String: String] = FixtureTerminalClient.defaultOutput,
        sendFails: Bool = false
    ) {
        self.outputByPaneID = outputByPaneID
        self.sendFails = sendFails
        let stream = AsyncStream<TerminalBinaryFrame>.makeStream()
        frames = stream.stream
        continuation = stream.continuation
    }

    public static let defaultOutput: [String: String] = [
        "ios-cockpit": """
        › Implement the native iOS cockpit foundation

        • Modeling typed Swift envelopes
        • Building PsycheCore

        ▸ Ready for simulator
        """,
        "bridge-protocol": """
        $ pnpm test wireProtocol
        PASS __tests__/bridge/wireProtocol.test.ts
        """,
        "web-home": """
        Waiting for review input…
        """,
    ]

    public func attach(paneID: String, sinceSequence: UInt64?) async throws -> TerminalSession {
        let sequence = (sequenceByPaneID[paneID] ?? 0) + 1
        sequenceByPaneID[paneID] = sequence

        // Replay lands after the caller has recorded the session, exactly as a
        // host would send it: the attach answers first, output follows.
        let payload = Data((outputByPaneID[paneID] ?? "").utf8)
        if !payload.isEmpty {
            let frame = TerminalBinaryFrame(
                streamID: "fixture-\(paneID)",
                sequence: sequence,
                payload: payload
            )
            Task { [continuation] in continuation.yield(frame) }
        }

        return TerminalSession(
            paneID: paneID,
            streamID: "fixture-\(paneID)",
            latestSequence: sequence,
            hasReplay: !payload.isEmpty,
            // Always a replace: each attach republishes the whole canned buffer
            // rather than pretending to continue one.
            replayMode: .replace
        )
    }

    public func detach(streamID: String) async throws {}

    public func send(_ data: Data, toStream streamID: String) async throws {
        if sendFails {
            throw TerminalControlError.unexpectedResponse
        }
    }

    public func resize(streamID: String, columns: Int, rows: Int) async throws {}

    public func incomingFrames() async -> AsyncStream<TerminalBinaryFrame> {
        frames
    }
}
