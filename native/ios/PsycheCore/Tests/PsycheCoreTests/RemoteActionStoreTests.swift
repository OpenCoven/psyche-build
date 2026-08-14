import Foundation
import XCTest
@testable import PsycheCore

@MainActor
final class RemoteActionStoreTests: XCTestCase {
    private let workspace = WorkspaceFixtures.workspace(named: WorkspaceFixtures.multiproject)
    private let paneID = "ios-cockpit"

    func testStartSendsExactPaneAndActionAndKeepsInteractivePaneBusy() async {
        let requests = ActionControlRequests(responses: [
            .actionResult(actionResult(
                requestID: "req-1",
                sessionID: "session-1",
                type: "confirm"
            )),
        ])
        let store = RemoteActionStore(controlRequests: requests)

        await store.start(action: .merge, onPane: paneID, in: workspace)

        let starts = await requests.starts
        XCTAssertEqual(starts, [
            MobileActionStartRequest(
                requestID: "req-1",
                paneID: paneID,
                action: .merge
            ),
        ])
        XCTAssertTrue(store.isBusy(paneID))
        XCTAssertEqual(store.presentation?.sessionID, "session-1")
        XCTAssertEqual(
            store.presentation?.content,
            .confirm(confirmLabel: "Continue", cancelLabel: "Cancel")
        )
    }

    func testConfirmInputSuccessChainReplacesSessionAndContentUntilSuccess() async {
        let requests = ActionControlRequests(responses: [
            .actionResult(actionResult(
                requestID: "req-1",
                sessionID: "session-1",
                type: "confirm"
            )),
            .actionResult(actionResult(
                requestID: "req-2",
                sessionID: "session-2",
                type: "input",
                message: "Name the pull request"
            )),
            .actionResult(actionResult(
                requestID: "req-3",
                sessionID: nil,
                type: "success",
                message: "Pull request created"
            )),
        ])
        let store = RemoteActionStore(controlRequests: requests)

        await store.start(action: .createPR, onPane: paneID, in: workspace)
        await store.respond(.confirm)

        XCTAssertTrue(store.isBusy(paneID))
        XCTAssertEqual(store.presentation?.sessionID, "session-2")
        XCTAssertEqual(store.presentation?.message, "Name the pull request")
        XCTAssertEqual(
            store.presentation?.content,
            .input(RemoteActionInput(
                placeholder: "Type a response",
                defaultValue: "Draft",
                maxVisibleLines: 5
            ))
        )

        await store.respond(.input(value: "Ready to ship"), recoveryText: "Ready to ship")

        let responds = await requests.responds
        XCTAssertEqual(responds.map(\.sessionID), ["session-1", "session-2"])
        XCTAssertEqual(responds.map(\.response), [.confirm, .input(value: "Ready to ship")])
        XCTAssertFalse(store.isBusy(paneID))
        XCTAssertEqual(store.presentation?.message, "Pull request created")
        XCTAssertEqual(store.presentation?.content, .terminal(.success))
    }

    func testDuplicateResponseTapSendsExactlyOnceWhileFirstResponseIsBlocked() async {
        let gate = ActionResponseGate()
        let requests = ActionControlRequests(
            responses: [
                .actionResult(actionResult(
                    requestID: "req-1",
                    sessionID: "session-1",
                    type: "confirm"
                )),
            ],
            responseGate: gate
        )
        let store = RemoteActionStore(controlRequests: requests)
        await store.start(action: .close, onPane: paneID, in: workspace)

        async let first: Void = store.respond(.confirm)
        await gate.waitUntilBlocked()
        await store.respond(.confirm)

        let blockedRespondCount = await requests.responds.count
        XCTAssertEqual(blockedRespondCount, 1)
        XCTAssertTrue(store.isSubmitting)
        XCTAssertNil(store.presentation?.sessionID)

        await gate.release(with: .actionResult(actionResult(
            requestID: "req-2",
            sessionID: nil,
            type: "info"
        )))
        await first

        let finalRespondCount = await requests.responds.count
        XCTAssertEqual(finalRespondCount, 1)
        XCTAssertFalse(store.isSubmitting)
    }

    func testUnknownPaneFailsBeforeAnySend() async {
        let requests = ActionControlRequests()
        let store = RemoteActionStore(controlRequests: requests)

        await store.start(action: .merge, onPane: "%404", in: workspace)

        let sentCount = await requests.sentCount
        XCTAssertEqual(sentCount, 0)
        assertVisibleError(store.presentation)
        XCTAssertTrue(store.presentation?.message.contains("%404") == true)
        XCTAssertFalse(store.isBusy("%404"))
    }

    func testMissingInteractiveSessionIDFromHostBecomesVisibleErrorAndClearsBusy() async {
        let requests = ActionControlRequests(responses: [
            .actionResult(actionResult(
                requestID: "req-1",
                sessionID: nil,
                type: "choice"
            )),
        ])
        let store = RemoteActionStore(controlRequests: requests)

        await store.start(action: .merge, onPane: paneID, in: workspace)

        assertVisibleError(store.presentation)
        XCTAssertTrue(store.presentation?.message.contains("session ID") == true)
        XCTAssertFalse(store.isBusy(paneID))
    }

    func testTransportFailureAfterInputPreservesRecoveryTextAndClearsBusy() async {
        let requests = ActionControlRequests(responses: [
            .actionResult(actionResult(
                requestID: "req-1",
                sessionID: "session-1",
                type: "input"
            )),
        ])
        let store = RemoteActionStore(controlRequests: requests)
        await store.start(action: .rename, onPane: paneID, in: workspace)
        await requests.failNext(TestTransportError.disconnected)

        await store.respond(.input(value: "new title"), recoveryText: "new title")

        assertVisibleError(store.presentation)
        XCTAssertEqual(store.presentation?.message, TestTransportError.disconnected.localizedDescription)
        XCTAssertEqual(store.presentation?.recoveryText, "new title")
        XCTAssertFalse(store.isBusy(paneID))
        XCTAssertFalse(store.isSubmitting)
    }

    func testCancelSendsCancelThroughCurrentSessionAndTerminalResultClearsBusy() async {
        let requests = ActionControlRequests(responses: [
            .actionResult(actionResult(
                requestID: "req-1",
                sessionID: "session-1",
                type: "confirm"
            )),
            .actionResult(actionResult(
                requestID: "req-2",
                sessionID: nil,
                type: "info"
            )),
        ])
        let store = RemoteActionStore(controlRequests: requests)
        await store.start(action: .close, onPane: paneID, in: workspace)

        await store.respond(.cancel)

        let responds = await requests.responds
        XCTAssertEqual(
            responds,
            [
                MobileActionRespondRequest(
                    requestID: "req-2",
                    sessionID: "session-1",
                    response: .cancel
                ),
            ]
        )
        XCTAssertEqual(store.presentation?.content, .terminal(.info))
        XCTAssertFalse(store.isBusy(paneID))
    }

    func testProgressResultClearsRemoteSessionBusyState() async {
        let requests = ActionControlRequests(responses: [
            .actionResult(actionResult(
                requestID: "req-1",
                sessionID: nil,
                type: "progress"
            )),
        ])
        let store = RemoteActionStore(controlRequests: requests)

        await store.start(action: .runTest, onPane: paneID, in: workspace)

        XCTAssertEqual(store.presentation?.content, .progress(nil))
        XCTAssertFalse(store.isBusy(paneID))
    }

    func testNoTransportBecomesVisibleError() async {
        let store = RemoteActionStore()

        await store.start(action: .merge, onPane: paneID, in: workspace)

        assertVisibleError(store.presentation)
        XCTAssertTrue(store.presentation?.message.contains("connected") == true)
        XCTAssertFalse(store.isBusy(paneID))
    }

    func testUnexpectedResponseTypeBecomesVisibleError() async {
        let requests = ActionControlRequests(responses: [
            .ack(ControlAckResponse(requestID: "req-1", ok: true)),
        ])
        let store = RemoteActionStore(controlRequests: requests)

        await store.start(action: .merge, onPane: paneID, in: workspace)

        assertVisibleUnexpectedResponse(store)
    }

    func testMismatchedActionResultRequestIDBecomesVisibleError() async {
        let requests = ActionControlRequests(responses: [
            .actionResult(actionResult(
                requestID: "another-request",
                sessionID: nil,
                type: "success"
            )),
        ])
        let store = RemoteActionStore(controlRequests: requests)

        await store.start(action: .merge, onPane: paneID, in: workspace)

        assertVisibleUnexpectedResponse(store)
    }

    func testReturnedProtocolErrorBecomesVisibleError() async {
        let requests = ActionControlRequests(responses: [
            .error(MobileProtocolErrorResponse(
                requestID: "req-1",
                code: "action_session_not_found",
                message: "Action session expired"
            )),
        ])
        let store = RemoteActionStore(controlRequests: requests)

        await store.start(action: .merge, onPane: paneID, in: workspace)

        assertVisibleError(store.presentation)
        XCTAssertEqual(store.presentation?.message, "Action session expired")
        XCTAssertFalse(store.isBusy(paneID))
    }

    func testReducerFailureBecomesVisibleError() async {
        let requests = ActionControlRequests(responses: [
            .actionResult(actionResult(
                requestID: "req-1",
                sessionID: nil,
                type: "future_result"
            )),
        ])
        let store = RemoteActionStore(controlRequests: requests)

        await store.start(action: .merge, onPane: paneID, in: workspace)

        assertVisibleError(store.presentation)
        XCTAssertTrue(store.presentation?.message.contains("unsupported") == true)
        XCTAssertFalse(store.isBusy(paneID))
    }

    func testResponseProtocolFailurePreservesRecoveryTextAndClearsBusy() async {
        let requests = ActionControlRequests(responses: [
            .actionResult(actionResult(
                requestID: "req-1",
                sessionID: "session-1",
                type: "input"
            )),
            .error(MobileProtocolErrorResponse(
                requestID: "req-2",
                code: "action_session_not_found",
                message: "Action session expired"
            )),
        ])
        let store = RemoteActionStore(controlRequests: requests)
        await store.start(action: .rename, onPane: paneID, in: workspace)

        await store.respond(.input(value: "new title"), recoveryText: "new title")

        assertVisibleError(store.presentation)
        XCTAssertEqual(store.presentation?.message, "Action session expired")
        XCTAssertEqual(store.presentation?.recoveryText, "new title")
        XCTAssertFalse(store.isBusy(paneID))
    }

    func testDismissRefusesInteractivePresentation() async {
        let requests = ActionControlRequests(responses: [
            .actionResult(actionResult(
                requestID: "req-1",
                sessionID: "session-1",
                type: "confirm"
            )),
        ])
        let store = RemoteActionStore(controlRequests: requests)
        await store.start(action: .close, onPane: paneID, in: workspace)

        store.dismiss()

        XCTAssertNotNil(store.presentation)
        XCTAssertTrue(store.isBusy(paneID))
    }

    func testDismissRefusesNonDismissablePresentation() async {
        let requests = ActionControlRequests(responses: [
            .actionResult(actionResult(
                requestID: "req-1",
                sessionID: nil,
                type: "progress",
                dismissable: false
            )),
        ])
        let store = RemoteActionStore(controlRequests: requests)
        await store.start(action: .runTest, onPane: paneID, in: workspace)

        store.dismiss()

        XCTAssertNotNil(store.presentation)
        XCTAssertFalse(store.presentation?.dismissable == true)
    }

    func testDismissRefusesWhileSubmitting() async {
        let gate = ActionResponseGate()
        let requests = ActionControlRequests(
            responses: [
                .actionResult(actionResult(
                    requestID: "req-1",
                    sessionID: "session-1",
                    type: "confirm"
                )),
            ],
            responseGate: gate
        )
        let store = RemoteActionStore(controlRequests: requests)
        await store.start(action: .close, onPane: paneID, in: workspace)

        async let response: Void = store.respond(.confirm)
        await gate.waitUntilBlocked()
        store.dismiss()

        XCTAssertNotNil(store.presentation)
        XCTAssertTrue(store.isSubmitting)

        await gate.release(with: .actionResult(actionResult(
            requestID: "req-2",
            sessionID: nil,
            type: "success"
        )))
        await response
    }

    func testDismissClearsTerminalDismissablePresentation() async {
        let requests = ActionControlRequests(responses: [
            .actionResult(actionResult(
                requestID: "req-1",
                sessionID: nil,
                type: "success"
            )),
        ])
        let store = RemoteActionStore(controlRequests: requests)
        await store.start(action: .merge, onPane: paneID, in: workspace)

        store.dismiss()

        XCTAssertNil(store.presentation)
    }

    func testUnexpectedResponseErrorHasActionableDescription() {
        XCTAssertEqual(
            RemoteActionStoreError.unexpectedResponse.errorDescription,
            "The host returned an unexpected action response. Refresh the workspace and try again."
        )
    }
}

private extension RemoteActionStoreTests {
    func assertVisibleError(
        _ presentation: RemoteActionPresentation?,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertNotNil(presentation, file: file, line: line)
        XCTAssertEqual(presentation?.content, .terminal(.error), file: file, line: line)
        XCTAssertTrue(presentation?.dismissable == true, file: file, line: line)
    }

    func assertVisibleUnexpectedResponse(
        _ store: RemoteActionStore,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        assertVisibleError(store.presentation, file: file, line: line)
        XCTAssertEqual(
            store.presentation?.message,
            RemoteActionStoreError.unexpectedResponse.localizedDescription,
            file: file,
            line: line
        )
        XCTAssertFalse(store.isBusy(paneID), file: file, line: line)
    }
}

private enum TestTransportError: Error, LocalizedError {
    case disconnected

    var errorDescription: String? {
        "The test transport disconnected."
    }
}

private actor ActionControlRequests: ControlRequesting {
    private(set) var starts: [MobileActionStartRequest] = []
    private(set) var responds: [MobileActionRespondRequest] = []
    private(set) var sentCount = 0

    private var responses: [MobileControlResponse]
    private var failure: (any Error)?
    private var nextID = 0
    private let responseGate: ActionResponseGate?

    init(
        responses: [MobileControlResponse] = [],
        responseGate: ActionResponseGate? = nil
    ) {
        self.responses = responses
        self.responseGate = responseGate
    }

    func nextRequestID() -> String {
        nextID += 1
        return "req-\(nextID)"
    }

    func failNext(_ error: any Error) {
        failure = error
    }

    func send(_ request: MobileControlRequest) async throws -> MobileControlResponse {
        sentCount += 1
        if case let .startAction(start) = request {
            starts.append(start)
        }
        if case let .respondToAction(response) = request {
            responds.append(response)
            if let responseGate {
                return await responseGate.block()
            }
        }
        if let failure {
            self.failure = nil
            throw failure
        }
        return responses.removeFirst()
    }
}

private actor ActionResponseGate {
    private var blockedContinuation: CheckedContinuation<Void, Never>?
    private var responseContinuation: CheckedContinuation<MobileControlResponse, Never>?

    func block() async -> MobileControlResponse {
        blockedContinuation?.resume()
        blockedContinuation = nil
        return await withCheckedContinuation { continuation in
            responseContinuation = continuation
        }
    }

    func waitUntilBlocked() async {
        if responseContinuation != nil {
            return
        }
        await withCheckedContinuation { continuation in
            blockedContinuation = continuation
        }
    }

    func release(with response: MobileControlResponse) {
        responseContinuation?.resume(returning: response)
        responseContinuation = nil
    }
}

private func actionResult(
    requestID: String,
    sessionID: String?,
    type: String,
    message: String? = nil,
    dismissable: Bool? = nil
) -> MobileActionsResultResponse {
    MobileActionsResultResponse(
        requestID: requestID,
        sessionID: sessionID,
        result: MobileActionResult(
            type: type,
            message: message ?? "\(type) message",
            title: "\(type.capitalized) action",
            options: type == "choice"
                ? [MobileActionOption(id: "one", label: "One")]
                : nil,
            placeholder: type == "input" ? "Type a response" : nil,
            defaultValue: type == "input" ? "Draft" : nil,
            inputMaxVisibleLines: type == "input" ? 5 : nil,
            dismissable: dismissable
        )
    )
}
