import Foundation
import PsycheCore
import XCTest
@testable import Psyche_Build

@MainActor
final class PaneComposerTests: XCTestCase {

    func testSuccessfulSubmissionSendsTextAndCarriageReturnAndClearsOnlyItsDraft() async {
        let client = ComposerTerminalClient()
        let registry = TerminalSessionRegistry(client: client)
        let store = makeLiveStore()
        let model = PaneComposerModel()
        await registry.show(primary: "web-home", secondary: "ios-cockpit")
        registry.focus("web-home")
        store.drafts = [
            "web-home": "git status",
            "ios-cockpit": "keep this",
        ]

        let task = model.submit(
            targetPaneID: "web-home",
            workspaceIsStale: false,
            store: store,
            registry: registry
        )
        await task?.value

        let sends = await client.sends
        XCTAssertEqual(sends.count, 1)
        XCTAssertEqual(sends.first?.streamID, "stream-web-home")
        XCTAssertEqual(sends.first?.data, Data("git status\r".utf8))
        XCTAssertNil(store.drafts["web-home"])
        XCTAssertEqual(store.drafts["ios-cockpit"], "keep this")
    }

    func testMismatchedResponseRetainsTheExactDraftAndExposesThePaneError() async {
        let client = ComposerTerminalClient(sendError: TerminalControlError.unexpectedResponse)
        let registry = TerminalSessionRegistry(client: client)
        let store = makeLiveStore()
        let model = PaneComposerModel()
        await registry.show(primary: "web-home")
        store.drafts["web-home"] = "  echo keep spacing  "

        let task = model.submit(
            targetPaneID: "web-home",
            workspaceIsStale: false,
            store: store,
            registry: registry
        )
        await task?.value

        XCTAssertEqual(store.drafts["web-home"], "  echo keep spacing  ")
        XCTAssertEqual(
            model.errorMessage(forPane: "web-home", registry: registry),
            TerminalControlError.unexpectedResponse.localizedDescription
        )
    }

    func testNegativeAcknowledgementRetainsTheExactDraftAndExposesThePaneError() async {
        let client = ComposerTerminalClient(sendError: TerminalControlError.inputRejected)
        let registry = TerminalSessionRegistry(client: client)
        let store = makeLiveStore()
        let model = PaneComposerModel()
        await registry.show(primary: "web-home")
        store.drafts["web-home"] = "do not lose this"

        let task = model.submit(
            targetPaneID: "web-home",
            workspaceIsStale: false,
            store: store,
            registry: registry
        )
        await task?.value

        XCTAssertEqual(store.drafts["web-home"], "do not lose this")
        XCTAssertEqual(
            model.errorMessage(forPane: "web-home", registry: registry),
            "The host rejected the terminal input."
        )
    }

    func testStaleOrUnfocusedComposerDoesNotSendTextOrKeys() async {
        let client = ComposerTerminalClient()
        let registry = TerminalSessionRegistry(client: client)
        let store = makeLiveStore()
        let model = PaneComposerModel()
        await registry.show(primary: "web-home", secondary: "ios-cockpit")
        store.drafts["web-home"] = "pwd"
        store.drafts["ios-cockpit"] = "wrong target"

        XCTAssertNil(model.submit(
            targetPaneID: "web-home",
            workspaceIsStale: true,
            store: store,
            registry: registry
        ))
        XCTAssertNil(model.press(
            .escape,
            targetPaneID: "web-home",
            workspaceIsStale: true,
            registry: registry
        ))
        XCTAssertNil(model.submit(
            targetPaneID: nil,
            workspaceIsStale: false,
            store: store,
            registry: registry
        ))
        XCTAssertNil(model.press(
            .enter,
            targetPaneID: nil,
            workspaceIsStale: false,
            registry: registry
        ))
        XCTAssertNil(model.submit(
            targetPaneID: "ios-cockpit",
            workspaceIsStale: false,
            store: store,
            registry: registry
        ))
        XCTAssertNil(model.press(
            .tab,
            targetPaneID: "ios-cockpit",
            workspaceIsStale: false,
            registry: registry
        ))

        let sends = await client.sends
        XCTAssertEqual(sends.count, 0)
        XCTAssertEqual(store.drafts["web-home"], "pwd")
        XCTAssertEqual(store.drafts["ios-cockpit"], "wrong target")
    }

    func testFocusChangeDuringSendCannotRedirectOrClearAnotherPane() async {
        let client = ComposerTerminalClient(gateSends: true)
        let registry = TerminalSessionRegistry(client: client)
        let store = makeLiveStore()
        let model = PaneComposerModel()
        await registry.show(primary: "web-home", secondary: "ios-cockpit")
        registry.focus("web-home")
        store.drafts = [
            "web-home": "first",
            "ios-cockpit": "second",
        ]

        let task = try! XCTUnwrap(model.submit(
            targetPaneID: "web-home",
            workspaceIsStale: false,
            store: store,
            registry: registry
        ))
        await client.waitUntilSendStarts()
        registry.focus("ios-cockpit")
        await client.releaseSend()
        await task.value

        let sends = await client.sends
        XCTAssertEqual(sends.first?.streamID, "stream-web-home")
        XCTAssertNil(store.drafts["web-home"])
        XCTAssertEqual(store.drafts["ios-cockpit"], "second")
    }

    func testFocusChangeDuringFailedSendDoesNotMoveTheErrorToTheNewPane() async {
        let client = ComposerTerminalClient(
            sendError: TerminalControlError.unexpectedResponse,
            gateSends: true
        )
        let registry = TerminalSessionRegistry(client: client)
        let store = makeLiveStore()
        let model = PaneComposerModel()
        await registry.show(primary: "web-home", secondary: "ios-cockpit")
        registry.focus("web-home")
        store.drafts["web-home"] = "fail here"

        let task = try! XCTUnwrap(model.submit(
            targetPaneID: "web-home",
            workspaceIsStale: false,
            store: store,
            registry: registry
        ))
        await client.waitUntilSendStarts()
        registry.focus("ios-cockpit")
        await client.releaseSend()
        await task.value

        XCTAssertNil(model.errorMessage(forPane: "ios-cockpit", registry: registry))
        XCTAssertEqual(
            model.errorMessage(forPane: "web-home", registry: registry),
            TerminalControlError.unexpectedResponse.localizedDescription
        )
    }

    func testSuccessfulSendDoesNotClearNewerTextInTheInitiatingPane() async {
        let client = ComposerTerminalClient(gateSends: true)
        let registry = TerminalSessionRegistry(client: client)
        let store = makeLiveStore()
        let model = PaneComposerModel()
        await registry.show(primary: "web-home")
        store.drafts["web-home"] = "old"

        let task = try! XCTUnwrap(model.submit(
            targetPaneID: "web-home",
            workspaceIsStale: false,
            store: store,
            registry: registry
        ))
        await client.waitUntilSendStarts()
        store.drafts["web-home"] = "new"
        await client.releaseSend()
        await task.value

        XCTAssertEqual(store.drafts["web-home"], "new")
    }

    func testControlAndAltApplyToTypedInputAndResetWhenSendStarts() async {
        let client = ComposerTerminalClient()
        let registry = TerminalSessionRegistry(client: client)
        let store = makeLiveStore()
        let model = PaneComposerModel()
        await registry.show(primary: "web-home")
        store.drafts["web-home"] = "c"
        model.toggleControl()
        model.toggleAlt()

        let task = model.submit(
            targetPaneID: "web-home",
            workspaceIsStale: false,
            store: store,
            registry: registry
        )

        XCTAssertFalse(model.armedControl)
        XCTAssertFalse(model.armedAlt)
        await task?.value
        let sends = await client.sends
        XCTAssertEqual(sends.first?.data, Data([0x1B, 0x03]))
        XCTAssertNil(store.drafts["web-home"])
    }

    func testModifiersApplyToCodingKeysAndResetWhenSendStarts() async {
        let client = ComposerTerminalClient()
        let registry = TerminalSessionRegistry(client: client)
        let model = PaneComposerModel()
        await registry.show(primary: "web-home")
        model.toggleControl()
        model.toggleAlt()

        let task = model.press(
            .up,
            targetPaneID: "web-home",
            workspaceIsStale: false,
            registry: registry
        )

        XCTAssertFalse(model.armedControl)
        XCTAssertFalse(model.armedAlt)
        await task?.value
        let sends = await client.sends
        XCTAssertEqual(
            sends.first?.data,
            Data([0x1B, 0x1B, 0x5B, 0x31, 0x3B, 0x35, 0x41])
        )
    }

    func testUnsupportedControlCharacterIsVisibleAndDoesNotAttemptASend() async {
        let client = ComposerTerminalClient()
        let registry = TerminalSessionRegistry(client: client)
        let store = makeLiveStore()
        let model = PaneComposerModel()
        await registry.show(primary: "web-home")
        store.drafts["web-home"] = "1"
        model.toggleControl()

        let task = model.submit(
            targetPaneID: "web-home",
            workspaceIsStale: false,
            store: store,
            registry: registry
        )

        XCTAssertNil(task)
        XCTAssertTrue(model.armedControl)
        XCTAssertNotNil(model.inputErrorMessage)
        let sends = await client.sends
        XCTAssertEqual(sends.count, 0)
        XCTAssertEqual(store.drafts["web-home"], "1")
    }

    func testModifierTogglesAreIndependentAndDismissClearsVisibleErrors() async {
        let client = ComposerTerminalClient(sendError: TerminalControlError.unexpectedResponse)
        let registry = TerminalSessionRegistry(client: client)
        let store = makeLiveStore()
        let model = PaneComposerModel()
        await registry.show(primary: "web-home")
        store.drafts["web-home"] = "x"

        model.toggleControl()
        XCTAssertTrue(model.armedControl)
        XCTAssertFalse(model.armedAlt)
        model.toggleAlt()
        XCTAssertTrue(model.armedControl)
        XCTAssertTrue(model.armedAlt)
        model.toggleControl()
        XCTAssertFalse(model.armedControl)
        XCTAssertTrue(model.armedAlt)

        let task = model.submit(
            targetPaneID: "web-home",
            workspaceIsStale: false,
            store: store,
            registry: registry
        )
        await task?.value
        XCTAssertNotNil(registry.lastErrorMessage)
        XCTAssertEqual(store.drafts["web-home"], "x")
        XCTAssertFalse(model.armedControl)
        XCTAssertFalse(model.armedAlt)

        model.dismissError(forPane: "web-home", registry: registry)

        XCTAssertNil(model.inputErrorMessage)
        XCTAssertNil(registry.lastErrorMessage)
    }

    func testDismissingTheFocusedPanesErrorLeavesAnotherPanesErrorVisible() async {
        let client = ComposerTerminalClient(sendError: TerminalControlError.unexpectedResponse)
        let registry = TerminalSessionRegistry(client: client)
        let store = makeLiveStore()
        let model = PaneComposerModel()
        await registry.show(primary: "web-home", secondary: "ios-cockpit")
        store.drafts = [
            "web-home": "first",
            "ios-cockpit": "second",
        ]

        let first = model.submit(
            targetPaneID: "web-home",
            workspaceIsStale: false,
            store: store,
            registry: registry
        )
        await first?.value
        registry.focus("ios-cockpit")
        let second = model.submit(
            targetPaneID: "ios-cockpit",
            workspaceIsStale: false,
            store: store,
            registry: registry
        )
        await second?.value

        model.dismissError(forPane: "ios-cockpit", registry: registry)

        XCTAssertNil(model.errorMessage(forPane: "ios-cockpit", registry: registry))
        XCTAssertEqual(
            model.errorMessage(forPane: "web-home", registry: registry),
            TerminalControlError.unexpectedResponse.localizedDescription
        )
    }

    private func makeLiveStore() -> WorkspaceStore {
        let store = WorkspaceStore()
        store.applySnapshot(
            workspace: WorkspaceFixtures.workspace(named: WorkspaceFixtures.multiproject),
            sequence: 1
        )
        return store
    }
}

private actor ComposerTerminalClient: TerminalControlling {
    struct Send: Sendable {
        let data: Data
        let streamID: String
    }

    private(set) var sends: [Send] = []
    private let sendError: (any Error)?
    private let gateSends: Bool
    private var didStartSend = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseContinuation: CheckedContinuation<Void, Never>?

    private let frames: AsyncStream<TerminalBinaryFrame>

    init(sendError: (any Error)? = nil, gateSends: Bool = false) {
        self.sendError = sendError
        self.gateSends = gateSends
        frames = AsyncStream { _ in }
    }

    func attach(paneID: String, sinceSequence: UInt64?) async throws -> TerminalSession {
        TerminalSession(
            paneID: paneID,
            streamID: "stream-\(paneID)",
            latestSequence: 0,
            hasReplay: false,
            replayMode: .append
        )
    }

    func detach(streamID: String) async throws {}

    func send(_ data: Data, toStream streamID: String) async throws {
        sends.append(Send(data: data, streamID: streamID))
        didStartSend = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        if gateSends {
            await withCheckedContinuation { continuation in
                releaseContinuation = continuation
            }
        }
        if let sendError { throw sendError }
    }

    func resize(streamID: String, columns: Int, rows: Int) async throws {}

    func incomingFrames() async -> AsyncStream<TerminalBinaryFrame> {
        frames
    }

    func waitUntilSendStarts() async {
        if didStartSend { return }
        await withCheckedContinuation { continuation in
            startWaiters.append(continuation)
        }
    }

    func releaseSend() {
        releaseContinuation?.resume()
        releaseContinuation = nil
    }
}
