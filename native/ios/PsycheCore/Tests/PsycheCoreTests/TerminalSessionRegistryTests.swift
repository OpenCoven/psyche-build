import Foundation
import XCTest
@testable import PsycheCore

@MainActor
final class TerminalSessionRegistryTests: XCTestCase {

    // MARK: - The two-session cap

    func testShowingTwoPanesAttachesExactlyTwo() async {
        let client = FakeTerminalClient()
        let registry = TerminalSessionRegistry(client: client)

        await registry.show(primary: "%1", secondary: "%2")

        let attached = await client.attachedPaneIDs
        let detached = await client.detachedStreamIDs
        XCTAssertEqual(registry.attachedPaneIDs, ["%1", "%2"])
        XCTAssertEqual(attached, ["%1", "%2"])
        XCTAssertEqual(detached, [])
    }

    func testShowingAThirdPaneDetachesTheOneItReplaces() async {
        let client = FakeTerminalClient()
        let registry = TerminalSessionRegistry(client: client)
        await registry.show(primary: "%1", secondary: "%2")

        await registry.show(primary: "%3", secondary: "%2")

        let detached = await client.detachedStreamIDs
        XCTAssertEqual(Set(registry.attachedPaneIDs), ["%2", "%3"])
        XCTAssertEqual(registry.attachedSessionCount, 2)
        XCTAssertEqual(detached, ["stream-%1"])
    }

    func testAThirdPaneIsNeverAttachedEvenIfAskedFor() async {
        let client = FakeTerminalClient()
        let registry = TerminalSessionRegistry(client: client)

        await registry.show(primary: "%1", secondary: "%2")
        await registry.show(primary: "%1", secondary: "%2")

        let attached = await client.attachedPaneIDs
        XCTAssertEqual(registry.attachedSessionCount, 2)
        XCTAssertEqual(
            attached,
            ["%1", "%2"],
            "An already-attached pane must not be attached twice"
        )
    }

    func testDuplicatePaneIDCollapsesToOneSession() async {
        let client = FakeTerminalClient()
        let registry = TerminalSessionRegistry(client: client)

        await registry.show(primary: "%1", secondary: "%1")

        let attached = await client.attachedPaneIDs
        XCTAssertEqual(registry.attachedPaneIDs, ["%1"])
        XCTAssertEqual(attached, ["%1"])
    }

    func testShowingNothingDetachesEverything() async {
        let client = FakeTerminalClient()
        let registry = TerminalSessionRegistry(client: client)
        await registry.show(primary: "%1", secondary: "%2")

        await registry.show(primary: nil)

        let detached = await client.detachedStreamIDs
        XCTAssertEqual(registry.attachedPaneIDs, [])
        XCTAssertEqual(registry.attachedSessionCount, 0)
        XCTAssertEqual(Set(detached), ["stream-%1", "stream-%2"])
    }

    // MARK: - Frame routing

    func testFramedOutputRoutesByStream() async {
        let client = FakeTerminalClient()
        let registry = TerminalSessionRegistry(client: client)
        registry.start()
        await registry.show(primary: "%1", secondary: "%2")

        await client.emit(streamID: "stream-%2", sequence: 1, text: "ready")
        await client.emit(streamID: "stream-%1", sequence: 1, text: "other")
        await drain(registry) { $0.outputByPaneID["%1"] != nil && $0.outputByPaneID["%2"] != nil }

        XCTAssertEqual(registry.outputByPaneID["%2"], Data("ready".utf8))
        XCTAssertEqual(registry.outputByPaneID["%1"], Data("other".utf8))
    }

    func testFramesForAnUnknownStreamAreDropped() async {
        let client = FakeTerminalClient()
        let registry = TerminalSessionRegistry(client: client)
        registry.start()
        await registry.show(primary: "%1")

        await client.emit(streamID: "stream-%9", sequence: 1, text: "not ours")
        await client.emit(streamID: "stream-%1", sequence: 1, text: "ours")
        await drain(registry) { $0.outputByPaneID["%1"] != nil }

        XCTAssertEqual(registry.outputByPaneID["%1"], Data("ours".utf8))
        XCTAssertNil(registry.outputByPaneID["%9"])
    }

    func testOutputAccumulatesInSequenceOrder() async {
        let client = FakeTerminalClient()
        let registry = TerminalSessionRegistry(client: client)
        registry.start()
        await registry.show(primary: "%1")

        await client.emit(streamID: "stream-%1", sequence: 1, text: "one ")
        await client.emit(streamID: "stream-%1", sequence: 2, text: "two ")
        await client.emit(streamID: "stream-%1", sequence: 3, text: "three")
        await drain(registry) { ($0.outputByPaneID["%1"]?.count ?? 0) >= 13 }

        XCTAssertEqual(registry.outputByPaneID["%1"], Data("one two three".utf8))
        XCTAssertEqual(registry.resumeSequence(forPane: "%1"), 3)
    }

    func testDuplicateAndStaleFramesAreIgnored() async {
        let client = FakeTerminalClient()
        let registry = TerminalSessionRegistry(client: client)
        registry.start()
        await registry.show(primary: "%1")

        await client.emit(streamID: "stream-%1", sequence: 2, text: "live")
        await drain(registry) { $0.outputByPaneID["%1"] != nil }
        await client.emit(streamID: "stream-%1", sequence: 2, text: "duplicate")
        await client.emit(streamID: "stream-%1", sequence: 1, text: "stale")
        await client.emit(streamID: "stream-%1", sequence: 3, text: "!")
        await drain(registry) { ($0.outputByPaneID["%1"]?.count ?? 0) > 4 }

        XCTAssertEqual(registry.outputByPaneID["%1"], Data("live!".utf8))
    }

    func testOutputIsBoundedFromTheFront() async {
        let client = FakeTerminalClient()
        let registry = TerminalSessionRegistry(client: client, outputLimit: 8)
        registry.start()
        await registry.show(primary: "%1")

        await client.emit(streamID: "stream-%1", sequence: 1, text: "aaaaaa")
        await client.emit(streamID: "stream-%1", sequence: 2, text: "bbbbbb")
        await drain(registry) { ($0.outputByPaneID["%1"]?.count ?? 0) == 8 }

        XCTAssertEqual(registry.outputByPaneID["%1"], Data("aabbbbbb".utf8))
    }

    // MARK: - Resume and replay

    func testReattachResumesFromTheSequenceAlreadySeen() async {
        let client = FakeTerminalClient()
        let registry = TerminalSessionRegistry(client: client)
        registry.start()
        await registry.show(primary: "%1")
        await client.emit(streamID: "stream-%1", sequence: 5, text: "seen")
        await drain(registry) { $0.outputByPaneID["%1"] != nil }

        await registry.show(primary: nil)
        await registry.show(primary: "%1")

        let resumePoints = await client.resumePoints
        XCTAssertEqual(resumePoints, [nil, 5])
    }

    /// The replay frame carries the sequence the attach reported. Seeding the
    /// cursor from the attach response would drop that very frame.
    func testTheReplayFrameItselfIsNotMistakenForADuplicate() async {
        let client = FakeTerminalClient()
        await client.setLatestSequence(9)
        let registry = TerminalSessionRegistry(client: client)
        registry.start()

        await registry.show(primary: "%1")
        await client.emit(streamID: "stream-%1", sequence: 9, text: "replayed")
        await drain(registry) { $0.outputByPaneID["%1"] != nil }

        XCTAssertEqual(registry.outputByPaneID["%1"], Data("replayed".utf8))
    }

    func testReplaceModeDiscardsWhatCannotBeContinued() async {
        let client = FakeTerminalClient()
        let registry = TerminalSessionRegistry(client: client)
        registry.start()
        await registry.show(primary: "%1")
        await client.emit(streamID: "stream-%1", sequence: 4, text: "old scrollback")
        await drain(registry) { $0.outputByPaneID["%1"] != nil }

        await registry.show(primary: nil)
        await client.setReplayMode(.replace)
        await registry.show(primary: "%1")
        await client.emit(streamID: "stream-%1", sequence: 1, text: "fresh")
        await drain(registry) { $0.outputByPaneID["%1"] == Data("fresh".utf8) }

        XCTAssertEqual(
            registry.outputByPaneID["%1"],
            Data("fresh".utf8),
            "A replace must not splice unrelated output onto what we held"
        )
    }

    func testAppendModeKeepsWhatWeAlreadyHold() async {
        let client = FakeTerminalClient()
        let registry = TerminalSessionRegistry(client: client)
        registry.start()
        await registry.show(primary: "%1")
        await client.emit(streamID: "stream-%1", sequence: 4, text: "kept ")
        await drain(registry) { $0.outputByPaneID["%1"] != nil }

        await registry.show(primary: nil)
        await registry.show(primary: "%1")
        await client.emit(streamID: "stream-%1", sequence: 5, text: "added")
        await drain(registry) { ($0.outputByPaneID["%1"]?.count ?? 0) > 5 }

        XCTAssertEqual(registry.outputByPaneID["%1"], Data("kept added".utf8))
    }

    // MARK: - Disconnect

    func testDisconnectClearsSessionsButKeepsTheResumeCursor() async {
        let client = FakeTerminalClient()
        let registry = TerminalSessionRegistry(client: client)
        registry.start()
        await registry.show(primary: "%1", secondary: "%2")
        await client.emit(streamID: "stream-%1", sequence: 7, text: "before")
        await drain(registry) { $0.outputByPaneID["%1"] != nil }

        registry.markDisconnected()

        XCTAssertEqual(registry.attachedPaneIDs, [])
        XCTAssertEqual(registry.attachedSessionCount, 0)
        XCTAssertNil(registry.focusedPaneID)
        XCTAssertEqual(registry.resumeSequence(forPane: "%1"), 7)
        XCTAssertEqual(registry.outputByPaneID["%1"], Data("before".utf8))
    }

    func testReconnectAfterDisconnectResumesFromTheKeptCursor() async {
        let client = FakeTerminalClient()
        let registry = TerminalSessionRegistry(client: client)
        registry.start()
        await registry.show(primary: "%1")
        await client.emit(streamID: "stream-%1", sequence: 7, text: "before")
        await drain(registry) { $0.outputByPaneID["%1"] != nil }
        registry.markDisconnected()

        await registry.show(primary: "%1")

        let resumePoints = await client.resumePoints
        XCTAssertEqual(resumePoints, [nil, 7])
    }

    func testFramesArrivingAfterDisconnectAreDropped() async {
        let client = FakeTerminalClient()
        let registry = TerminalSessionRegistry(client: client)
        registry.start()
        await registry.show(primary: "%1")
        registry.markDisconnected()

        await client.emit(streamID: "stream-%1", sequence: 9, text: "orphan")
        await Task.yield()

        XCTAssertNil(registry.outputByPaneID["%1"])
    }

    // MARK: - Focus and input

    func testFirstAttachedPaneTakesFocus() async {
        let client = FakeTerminalClient()
        let registry = TerminalSessionRegistry(client: client)

        await registry.show(primary: "%1", secondary: "%2")

        XCTAssertEqual(registry.focusedPaneID, "%1")
    }

    func testSendTargetsTheExplicitFocusedPane() async {
        let client = FakeTerminalClient()
        let registry = TerminalSessionRegistry(client: client)
        await registry.show(primary: "%1", secondary: "%2")

        registry.focus("%2")
        await registry.send(Data("ls\r".utf8), toPane: "%2")

        let inputStreamID = await client.lastInputStreamID
        let inputText = await client.lastInputText
        XCTAssertEqual(registry.focusedPaneID, "%2")
        XCTAssertEqual(inputStreamID, "stream-%2")
        XCTAssertEqual(inputText, "ls\r")
    }

    func testExplicitSendTargetDoesNotDriftWithFocus() async {
        let client = FakeTerminalClient()
        let registry = TerminalSessionRegistry(client: client)
        await registry.show(primary: "%1", secondary: "%2")

        registry.focus("%1")
        let accepted = await registry.send(Data("pwd\r".utf8), toPane: "%2")

        let inputStreamID = await client.lastInputStreamID
        XCTAssertTrue(accepted)
        XCTAssertEqual(registry.focusedPaneID, "%1")
        XCTAssertEqual(inputStreamID, "stream-%2")
    }

    func testFocusIgnoresAPaneThatIsNotAttached() async {
        let client = FakeTerminalClient()
        let registry = TerminalSessionRegistry(client: client)
        await registry.show(primary: "%1")

        registry.focus("%9")

        XCTAssertEqual(registry.focusedPaneID, "%1")
    }

    func testDetachingTheFocusedPaneMovesFocusToTheSurvivor() async {
        let client = FakeTerminalClient()
        let registry = TerminalSessionRegistry(client: client)
        await registry.show(primary: "%1", secondary: "%2")
        registry.focus("%2")

        await registry.show(primary: "%1")

        XCTAssertEqual(registry.attachedPaneIDs, ["%1"])
        XCTAssertEqual(registry.focusedPaneID, "%1")
    }

    func testInputToAnUnattachedPaneReportsRatherThanGuessing() async {
        let client = FakeTerminalClient()
        let registry = TerminalSessionRegistry(client: client)
        await registry.show(primary: "%1")

        let accepted = await registry.send(Data("ls\r".utf8), toPane: "%9")

        let inputStreamID = await client.lastInputStreamID
        XCTAssertFalse(accepted)
        XCTAssertNil(inputStreamID)
        XCTAssertNotNil(registry.lastErrorMessage)
    }

    func testResizeTargetsThePanesOwnStream() async {
        let client = FakeTerminalClient()
        let registry = TerminalSessionRegistry(client: client)
        await registry.show(primary: "%1", secondary: "%2")

        await registry.resize(paneID: "%2", columns: 100, rows: 40)

        let resize = await client.lastResize
        XCTAssertEqual(resize?.streamID, "stream-%2")
        XCTAssertEqual(resize?.columns, 100)
        XCTAssertEqual(resize?.rows, 40)
    }

    func testSendReportsWhetherTheHostTookIt() async {
        let client = FakeTerminalClient()
        let registry = TerminalSessionRegistry(client: client)
        await registry.show(primary: "%1")

        let accepted = await registry.send(Data("ok\r".utf8), toPane: "%1")
        XCTAssertTrue(accepted)

        await client.setSendFailure(TerminalControlError.unexpectedResponse)
        let refused = await registry.send(Data("lost\r".utf8), toPane: "%1")

        // A composer clears its draft on true and keeps it on false, so this
        // is the difference between losing what someone typed and not.
        XCTAssertFalse(refused)
        XCTAssertNotNil(registry.lastErrorMessage)
    }

    func testSendWithNoAttachedTargetReportsFailureRatherThanSuccess() async {
        let client = FakeTerminalClient()
        let registry = TerminalSessionRegistry(client: client)

        let accepted = await registry.send(Data("ls\r".utf8), toPane: "%1")

        XCTAssertFalse(accepted)
    }

    func testSuccessfulSendClearsAStaleSendError() async {
        let client = FakeTerminalClient()
        let registry = TerminalSessionRegistry(client: client)
        await registry.show(primary: "%1")
        await client.setSendFailure(TerminalControlError.unexpectedResponse)
        _ = await registry.send(Data("lost".utf8), toPane: "%1")
        XCTAssertNotNil(registry.lastErrorMessage)

        await client.setSendFailure(nil)
        let accepted = await registry.send(Data("ok".utf8), toPane: "%1")

        XCTAssertTrue(accepted)
        XCTAssertNil(registry.lastErrorMessage)
    }

    // MARK: - Errors

    func testAFailedAttachIsReportedAndLeavesNoSession() async {
        let client = FakeTerminalClient()
        await client.setAttachFailure(TerminalControlError.unexpectedResponse)
        let registry = TerminalSessionRegistry(client: client)

        await registry.show(primary: "%1")

        XCTAssertEqual(registry.attachedPaneIDs, [])
        XCTAssertEqual(registry.attachedSessionCount, 0)
        XCTAssertNotNil(registry.lastErrorMessage)
    }

    // MARK: - Helpers

    /// The frame reader is its own task, so poll rather than sleep.
    private func drain(
        _ registry: TerminalSessionRegistry,
        until condition: (TerminalSessionRegistry) -> Bool,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        for _ in 0..<2_000 {
            if condition(registry) { return }
            await Task.yield()
        }
        XCTFail("Timed out waiting for the registry to catch up", file: file, line: line)
    }
}

private actor FakeTerminalClient: TerminalControlling {
    private(set) var attachedPaneIDs: [String] = []
    private(set) var detachedStreamIDs: [String] = []
    private(set) var resumePoints: [UInt64?] = []
    private(set) var lastInputStreamID: String?
    private(set) var lastInputText: String?
    private(set) var lastResize: (streamID: String, columns: Int, rows: Int)?

    private var replayMode: TerminalReplayMode = .append
    private var latestSequence: UInt64 = 0
    private var attachFailure: (any Error)?
    private var sendFailure: (any Error)?

    private let frames: AsyncStream<TerminalBinaryFrame>
    private let continuation: AsyncStream<TerminalBinaryFrame>.Continuation

    init() {
        let stream = AsyncStream<TerminalBinaryFrame>.makeStream()
        frames = stream.stream
        continuation = stream.continuation
    }

    func setReplayMode(_ mode: TerminalReplayMode) { replayMode = mode }
    func setLatestSequence(_ sequence: UInt64) { latestSequence = sequence }
    func setAttachFailure(_ error: (any Error)?) { attachFailure = error }
    func setSendFailure(_ error: (any Error)?) { sendFailure = error }

    func attach(paneID: String, sinceSequence: UInt64?) async throws -> TerminalSession {
        resumePoints.append(sinceSequence)
        if let attachFailure { throw attachFailure }
        attachedPaneIDs.append(paneID)
        return TerminalSession(
            paneID: paneID,
            streamID: "stream-\(paneID)",
            latestSequence: latestSequence,
            hasReplay: latestSequence > 0,
            replayMode: replayMode
        )
    }

    func detach(streamID: String) async throws {
        detachedStreamIDs.append(streamID)
    }

    func send(_ data: Data, toStream streamID: String) async throws {
        if let sendFailure { throw sendFailure }
        lastInputStreamID = streamID
        lastInputText = String(decoding: data, as: UTF8.self)
    }

    func resize(streamID: String, columns: Int, rows: Int) async throws {
        lastResize = (streamID, columns, rows)
    }

    func incomingFrames() async -> AsyncStream<TerminalBinaryFrame> {
        frames
    }

    func emit(streamID: String, sequence: UInt64, text: String) {
        continuation.yield(TerminalBinaryFrame(
            streamID: streamID,
            sequence: sequence,
            payload: Data(text.utf8)
        ))
    }
}
