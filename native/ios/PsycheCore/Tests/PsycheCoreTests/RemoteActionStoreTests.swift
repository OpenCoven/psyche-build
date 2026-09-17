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
        XCTAssertFalse(store.canStartAction(onPane: paneID))
        XCTAssertEqual(store.presentation?.sessionID, "session-1")
        XCTAssertEqual(
            store.presentation?.content,
            .confirm(confirmLabel: "Continue", cancelLabel: "Cancel")
        )
    }

    func testBlockedStartShowsVisibleProgressUntilTheHostReplies() async {
        let gate = ActionStartGate()
        let requests = ActionControlRequests(
            responses: [
                .actionResult(actionResult(
                    requestID: "req-1",
                    sessionID: nil,
                    type: "success"
                )),
            ],
            startGate: gate
        )
        let store = RemoteActionStore(controlRequests: requests)
        let workspace = workspace
        let paneID = paneID

        async let start: Void = store.start(action: .merge, onPane: paneID, in: workspace)
        await gate.waitUntilBlocked()

        XCTAssertEqual(store.presentation?.actionLabel, "Merge")
        XCTAssertEqual(store.presentation?.title, "Working")
        XCTAssertEqual(store.presentation?.message, "Waiting for the host...")
        XCTAssertEqual(store.presentation?.content, .progress(nil))
        XCTAssertFalse(store.presentation?.dismissable == true)
        XCTAssertTrue(store.isBusy(paneID))
        XCTAssertFalse(store.canStartAction(onPane: paneID))

        await gate.release(with: .actionResult(actionResult(
            requestID: "req-1",
            sessionID: nil,
            type: "success"
        )))
        await start

        XCTAssertEqual(store.presentation?.content, .terminal(.success))
        XCTAssertFalse(store.isBusy(paneID))
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

    func testContinuationInheritsOmittedScopeAndRelatedFiles() async {
        let inheritedScope = [
            "host": "studio.local",
            "projectId": "psyche",
            "projectTitle": "Psyche",
            "worktreePath": "/repo/.worktrees/action-session-tests",
            "sourceBranch": "feature/action-session",
            "targetBranch": "main",
            "consequence": "Creates a pull request",
        ]
        let inheritedFiles = ["Sources/Action.swift", "Tests/ActionTests.swift"]
        let requests = ActionControlRequests(responses: [
            .actionResult(actionResult(
                requestID: "req-1",
                sessionID: "session-1",
                type: "confirm",
                data: inheritedScope,
                relatedFiles: inheritedFiles
            )),
            .actionResult(actionResult(
                requestID: "req-2",
                sessionID: "session-2",
                type: "input"
            )),
        ])
        let store = RemoteActionStore(controlRequests: requests)

        await store.start(action: .createPR, onPane: paneID, in: workspace)
        await store.respond(.confirm)

        XCTAssertEqual(store.presentation?.scope.rows, [
            RemoteActionScopeRow(key: "host", label: "Host", value: "studio.local"),
            RemoteActionScopeRow(key: "projectId", label: "Project ID", value: "psyche"),
            RemoteActionScopeRow(key: "projectTitle", label: "Project", value: "Psyche"),
            RemoteActionScopeRow(
                key: "worktreePath",
                label: "Worktree",
                value: "/repo/.worktrees/action-session-tests"
            ),
            RemoteActionScopeRow(
                key: "sourceBranch",
                label: "Source branch",
                value: "feature/action-session"
            ),
            RemoteActionScopeRow(key: "targetBranch", label: "Target branch", value: "main"),
        ])
        XCTAssertEqual(store.presentation?.scope.consequence, "Creates a pull request")
        XCTAssertEqual(store.presentation?.relatedFiles, inheritedFiles)
    }

    func testContinuationOverridesSuppliedScopeAndFilesWhileInheritingOmittedScope() async {
        let requests = ActionControlRequests(responses: [
            .actionResult(actionResult(
                requestID: "req-1",
                sessionID: "session-1",
                type: "confirm",
                data: [
                    "host": "studio.local",
                    "projectTitle": "Psyche",
                    "worktreePath": "/repo/.worktrees/action-session-tests",
                    "sourceBranch": "feature/action-session",
                    "targetBranch": "main",
                    "consequence": "Creates a pull request",
                ],
                relatedFiles: ["Sources/Old.swift"]
            )),
            .actionResult(actionResult(
                requestID: "req-2",
                sessionID: "session-2",
                type: "input",
                data: [
                    "host": "remote.example",
                    "targetBranch": "release",
                ],
                relatedFiles: ["Sources/New.swift"]
            )),
        ])
        let store = RemoteActionStore(controlRequests: requests)

        await store.start(action: .createPR, onPane: paneID, in: workspace)
        await store.respond(.confirm)

        XCTAssertEqual(store.presentation?.scope.rows, [
            RemoteActionScopeRow(key: "host", label: "Host", value: "remote.example"),
            RemoteActionScopeRow(key: "projectTitle", label: "Project", value: "Psyche"),
            RemoteActionScopeRow(
                key: "worktreePath",
                label: "Worktree",
                value: "/repo/.worktrees/action-session-tests"
            ),
            RemoteActionScopeRow(
                key: "sourceBranch",
                label: "Source branch",
                value: "feature/action-session"
            ),
            RemoteActionScopeRow(key: "targetBranch", label: "Target branch", value: "release"),
        ])
        XCTAssertEqual(store.presentation?.scope.consequence, "Creates a pull request")
        XCTAssertEqual(store.presentation?.relatedFiles, ["Sources/New.swift"])
    }

    func testSeparateStartDoesNotInheritPreviousWorkflowScopeOrFiles() async {
        let requests = ActionControlRequests(responses: [
            .actionResult(actionResult(
                requestID: "req-1",
                sessionID: "session-1",
                type: "confirm",
                data: [
                    "host": "studio.local",
                    "projectTitle": "Psyche",
                    "consequence": "Creates a pull request",
                ],
                relatedFiles: ["Sources/Previous.swift"]
            )),
            .actionResult(actionResult(
                requestID: "req-2",
                sessionID: nil,
                type: "success"
            )),
            .actionResult(actionResult(
                requestID: "req-3",
                sessionID: "session-3",
                type: "confirm"
            )),
        ])
        let store = RemoteActionStore(controlRequests: requests)

        await store.start(action: .createPR, onPane: paneID, in: workspace)
        await store.respond(.confirm)
        store.dismiss()
        await store.start(action: .close, onPane: "bridge-protocol", in: workspace)

        XCTAssertEqual(store.presentation?.scope, RemoteActionScope(rows: [], consequence: nil))
        XCTAssertEqual(store.presentation?.relatedFiles, [])
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

    func testDuplicateCancelTapSendsExactlyOnceWhileFirstCancelIsBlocked() async {
        let gate = ActionResponseGate()
        let requests = ActionControlRequests(
            responses: [
                .actionResult(actionResult(
                    requestID: "req-1",
                    sessionID: "session-1",
                    type: "choice"
                )),
            ],
            responseGate: gate
        )
        let store = RemoteActionStore(controlRequests: requests)
        await store.start(action: .merge, onPane: paneID, in: workspace)

        async let first: Void = store.respond(.choice(optionID: "cancel"))
        await gate.waitUntilBlocked()
        await store.respond(.choice(optionID: "cancel"))

        let blockedRespondCount = await requests.responds.count
        XCTAssertEqual(blockedRespondCount, 1)
        XCTAssertTrue(store.isSubmitting)
        XCTAssertNil(store.presentation?.sessionID)

        await gate.release(with: .actionResult(actionResult(
            requestID: "req-2",
            sessionID: nil,
            type: "info",
            message: "Merge cancelled"
        )))
        await first

        let finalRespondCount = await requests.responds.count
        XCTAssertEqual(finalRespondCount, 1)
        XCTAssertEqual(store.presentation?.message, "Merge cancelled")
        XCTAssertFalse(store.isSubmitting)
        XCTAssertFalse(store.isBusy(paneID))
    }

    func testSecondStartWhileFirstIsBlockedSendsNothingAndPreservesFirstWorkflow() async {
        let gate = ActionStartGate()
        let requests = ActionControlRequests(
            responses: [
                .actionResult(actionResult(
                    requestID: "req-2",
                    sessionID: nil,
                    type: "success"
                )),
            ],
            startGate: gate
        )
        let store = RemoteActionStore(controlRequests: requests)
        let workspace = workspace
        let paneID = paneID

        async let first: Void = store.start(action: .merge, onPane: paneID, in: workspace)
        await gate.waitUntilBlocked()
        await store.start(action: .close, onPane: "bridge-protocol", in: workspace)

        let blockedStarts = await requests.starts
        XCTAssertEqual(blockedStarts.count, 1)
        XCTAssertEqual(blockedStarts.first?.paneID, paneID)
        XCTAssertTrue(store.isBusy(paneID))
        XCTAssertFalse(store.isBusy("bridge-protocol"))

        await gate.release(with: .actionResult(actionResult(
            requestID: "req-1",
            sessionID: "session-1",
            type: "confirm"
        )))
        await first

        XCTAssertEqual(store.presentation?.paneID, paneID)
        XCTAssertEqual(store.presentation?.sessionID, "session-1")
        XCTAssertTrue(store.isBusy(paneID))
        XCTAssertFalse(store.isBusy("bridge-protocol"))
    }

    func testStartWhileInteractivePresentationIsVisiblePreservesCurrentSession() async {
        let requests = ActionControlRequests(responses: [
            .actionResult(actionResult(
                requestID: "req-1",
                sessionID: "session-1",
                type: "confirm"
            )),
            .actionResult(actionResult(
                requestID: "req-2",
                sessionID: nil,
                type: "success"
            )),
        ])
        let store = RemoteActionStore(controlRequests: requests)
        await store.start(action: .merge, onPane: paneID, in: workspace)
        let originalPresentation = store.presentation

        await store.start(action: .close, onPane: "bridge-protocol", in: workspace)

        let starts = await requests.starts
        XCTAssertEqual(starts.count, 1)
        XCTAssertEqual(store.presentation, originalPresentation)
        XCTAssertTrue(store.isBusy(paneID))
        XCTAssertFalse(store.isBusy("bridge-protocol"))
    }

    func testStartWhileResponseIsBlockedCannotReplaceOrCorruptContinuation() async {
        let gate = ActionResponseGate()
        let requests = ActionControlRequests(
            responses: [
                .actionResult(actionResult(
                    requestID: "req-1",
                    sessionID: "session-1",
                    type: "confirm"
                )),
                .actionResult(actionResult(
                    requestID: "req-3",
                    sessionID: "illicit-session",
                    type: "confirm"
                )),
            ],
            responseGate: gate
        )
        let store = RemoteActionStore(controlRequests: requests)
        await store.start(action: .merge, onPane: paneID, in: workspace)

        async let response: Void = store.respond(.confirm)
        await gate.waitUntilBlocked()
        let submittingPresentation = store.presentation
        await store.start(action: .close, onPane: "bridge-protocol", in: workspace)

        let startsWhileBlocked = await requests.starts
        XCTAssertEqual(startsWhileBlocked.count, 1)
        XCTAssertEqual(store.presentation, submittingPresentation)
        XCTAssertTrue(store.isSubmitting)
        XCTAssertFalse(store.isBusy("bridge-protocol"))

        await gate.release(with: .actionResult(actionResult(
            requestID: "req-2",
            sessionID: "session-2",
            type: "input"
        )))
        await response

        XCTAssertEqual(store.presentation?.paneID, paneID)
        XCTAssertEqual(store.presentation?.sessionID, "session-2")
        XCTAssertEqual(
            store.presentation?.content,
            .input(RemoteActionInput(
                placeholder: "Type a response",
                defaultValue: "Draft",
                maxVisibleLines: 5
            ))
        )
        XCTAssertTrue(store.isBusy(paneID))
        XCTAssertFalse(store.isBusy("bridge-protocol"))
        XCTAssertFalse(store.isSubmitting)
    }

    func testStartAfterDismissingTerminalPresentationIsAccepted() async {
        let requests = ActionControlRequests(responses: [
            .actionResult(actionResult(
                requestID: "req-1",
                sessionID: nil,
                type: "success"
            )),
            .actionResult(actionResult(
                requestID: "req-2",
                sessionID: "session-2",
                type: "confirm"
            )),
        ])
        let store = RemoteActionStore(controlRequests: requests)
        await store.start(action: .merge, onPane: paneID, in: workspace)
        let terminalPresentation = store.presentation

        await store.start(action: .close, onPane: "bridge-protocol", in: workspace)

        let startsBeforeDismiss = await requests.starts
        XCTAssertEqual(startsBeforeDismiss.count, 1)
        XCTAssertEqual(store.presentation, terminalPresentation)

        store.dismiss()

        XCTAssertTrue(store.canStartAction(onPane: "bridge-protocol"))

        await store.start(action: .close, onPane: "bridge-protocol", in: workspace)

        let starts = await requests.starts
        XCTAssertEqual(starts.map(\.paneID), [paneID, "bridge-protocol"])
        XCTAssertEqual(store.presentation?.paneID, "bridge-protocol")
        XCTAssertEqual(store.presentation?.sessionID, "session-2")
        XCTAssertTrue(store.isBusy("bridge-protocol"))
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

    /// Previously this asserted an ordinary dismissable failure with the pane
    /// released, and preserved the operator's draft. `rename` mutates host
    /// state, so a transport failure after dispatch is now an unknown outcome
    /// and the pane stays guarded. The draft is deliberately NOT carried into
    /// that state: an unknown outcome persists until resolved by hand, and raw
    /// operator input must not sit in published state for an unbounded time.
    func testTransportFailureAfterInputGuardsPaneWithoutRetainingTheDraft() async {
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

        XCTAssertEqual(store.presentation?.content, .reconciliationRequired)
        XCTAssertEqual(store.presentation?.message, TestTransportError.disconnected.localizedDescription)
        XCTAssertNil(store.presentation?.recoveryText)
        XCTAssertFalse(store.unknownOutcome(forPane: paneID).map {
            "\($0)".contains("new title")
        } ?? false)
        XCTAssertTrue(store.isBusy(paneID))
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

    func testHostNonDismissableProgressCanBeDismissedAndAllowsLaterStart() async {
        let requests = ActionControlRequests(responses: [
            .actionResult(actionResult(
                requestID: "req-1",
                sessionID: nil,
                type: "progress",
                dismissable: false
            )),
            .actionResult(actionResult(
                requestID: "req-2",
                sessionID: "session-2",
                type: "confirm"
            )),
        ])
        let store = RemoteActionStore(controlRequests: requests)
        await store.start(action: .runTest, onPane: paneID, in: workspace)

        XCTAssertTrue(store.presentation?.dismissable == true)
        XCTAssertFalse(store.isBusy(paneID))

        store.dismiss()

        XCTAssertNil(store.presentation)

        await store.start(action: .close, onPane: "bridge-protocol", in: workspace)

        let starts = await requests.starts
        XCTAssertEqual(starts.map(\.paneID), [paneID, "bridge-protocol"])
        XCTAssertEqual(store.presentation?.paneID, "bridge-protocol")
        XCTAssertEqual(store.presentation?.sessionID, "session-2")
        XCTAssertTrue(store.isBusy("bridge-protocol"))
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

extension RemoteActionStoreTests {
    private func storeAwaitingConfirm(
        action: PaneAction = .merge,
        failingWith error: any Error
    ) async -> (RemoteActionStore, ActionControlRequests) {
        let requests = ActionControlRequests(responses: [
            .actionResult(actionResult(
                requestID: "req-1",
                sessionID: "session-1",
                type: "confirm"
            )),
        ])
        let store = RemoteActionStore(controlRequests: requests)
        await store.start(action: action, onPane: paneID, in: workspace)
        await requests.failNext(error)
        return (store, requests)
    }

    // A control-request timeout does not cancel host execution, so a merge that
    // updated a branch and then waited on a hook cannot be reported as failed.
    func testTimeoutAfterConfirmLeavesTheOutcomeUnknown() async {
        let (store, _) = await storeAwaitingConfirm(
            failingWith: ControlRequestError.timedOut("req-2")
        )

        await store.respond(.confirm)

        XCTAssertEqual(store.presentation?.content, .reconciliationRequired)
        XCTAssertEqual(store.presentation?.title, "This may have taken effect")
        XCTAssertFalse(store.presentation?.dismissable == true)
        XCTAssertTrue(store.isBusy(paneID))
        XCTAssertNotNil(store.unknownOutcome(forPane: paneID))
    }

    func testDisconnectAfterConfirmLeavesTheOutcomeUnknown() async {
        let (store, _) = await storeAwaitingConfirm(
            failingWith: ControlRequestError.disconnected
        )

        await store.respond(.confirm)

        XCTAssertEqual(store.presentation?.content, .reconciliationRequired)
        XCTAssertNotNil(store.unknownOutcome(forPane: paneID))
    }

    func testUnknownOutcomePreservesReconciliationContext() async {
        let (store, _) = await storeAwaitingConfirm(
            failingWith: ControlRequestError.timedOut("req-2")
        )

        await store.respond(.confirm)

        let outcome = store.unknownOutcome(forPane: paneID)
        XCTAssertEqual(outcome?.paneID, paneID)
        XCTAssertEqual(outcome?.action, .merge)
        XCTAssertEqual(outcome?.sessionID, "session-1")
        XCTAssertEqual(outcome?.requestID, store.presentation?.requestID)
        // The scope carried from the confirm is retained for reconciliation.
        XCTAssertEqual(outcome?.scope, store.presentation?.scope)
    }

    func testDismissCannotClearAnUnknownOutcome() async {
        let (store, _) = await storeAwaitingConfirm(
            failingWith: ControlRequestError.timedOut("req-2")
        )
        await store.respond(.confirm)

        store.dismiss()

        XCTAssertEqual(store.presentation?.content, .reconciliationRequired)
        XCTAssertTrue(store.isBusy(paneID))
        XCTAssertNotNil(store.unknownOutcome(forPane: paneID))
    }

    func testUnknownOutcomeBlocksAFreshActionOnThatPane() async {
        let (store, requests) = await storeAwaitingConfirm(
            failingWith: ControlRequestError.timedOut("req-2")
        )
        await store.respond(.confirm)
        let sentBefore = await requests.sentCount

        XCTAssertFalse(store.canStartAction(onPane: paneID))
        await store.start(action: .merge, onPane: paneID, in: workspace)

        let sentAfter = await requests.sentCount
        XCTAssertEqual(sentAfter, sentBefore, "a retry must not be dispatched")
        XCTAssertEqual(store.presentation?.content, .reconciliationRequired)
    }

    func testOnlyAnExplicitResolutionReleasesThePane() async {
        let (store, _) = await storeAwaitingConfirm(
            failingWith: ControlRequestError.timedOut("req-2")
        )
        await store.respond(.confirm)

        store.resolveUnknownOutcome(forPane: paneID, as: .observedApplied)

        XCTAssertNil(store.unknownOutcome(forPane: paneID))
        XCTAssertFalse(store.isBusy(paneID))
        XCTAssertTrue(store.presentation?.message.contains("was applied") == true)
        // An action the host applied is not a failure, and must not be dressed
        // as one: "That did not work" invites the duplicate retry this guards.
        XCTAssertEqual(store.presentation?.content, .terminal(.success))
        XCTAssertEqual(store.presentation?.title, "Reconciled")
    }

    func testResolvingAsNotAppliedReportsItAsReconciledNotAsAnError() async {
        let (store, _) = await storeAwaitingConfirm(
            failingWith: ControlRequestError.timedOut("req-2")
        )
        await store.respond(.confirm)

        store.resolveUnknownOutcome(forPane: paneID, as: .observedNotApplied)

        XCTAssertEqual(store.presentation?.title, "Reconciled")
        XCTAssertEqual(store.presentation?.content, .terminal(.info))
        XCTAssertTrue(store.presentation?.message.contains("was not applied") == true)
        XCTAssertFalse(store.isBusy(paneID))
    }

    func testResolvingOnePaneDoesNotReleaseAnother() async {
        let (store, _) = await storeAwaitingConfirm(
            failingWith: ControlRequestError.timedOut("req-2")
        )
        await store.respond(.confirm)

        store.resolveUnknownOutcome(forPane: "some-other-pane", as: .observedApplied)

        XCTAssertNotNil(store.unknownOutcome(forPane: paneID))
        XCTAssertTrue(store.isBusy(paneID))
    }

    // The whole point of splitting `notConnected` out of `disconnected`: a
    // respond attempted with no connection at all was previously indistinguishable
    // from one whose connection died mid-flight, so it became a sticky unknown
    // outcome the operator had to acknowledge for an effect that never happened.
    func testRespondWithNoConnectionIsAnOrdinaryFailureNotAnUnknownOutcome() async {
        let (store, _) = await storeAwaitingConfirm(
            failingWith: ControlRequestError.notConnected
        )

        await store.respond(.confirm)

        assertVisibleError(store.presentation)
        XCTAssertFalse(store.isBusy(paneID))
        XCTAssertNil(store.unknownOutcome(forPane: paneID))
    }

    // Its sibling must keep the opposite treatment: an in-flight connection loss
    // cannot prove the host saw nothing.
    func testInFlightDisconnectRemainsAnUnknownOutcome() async {
        let (store, _) = await storeAwaitingConfirm(
            failingWith: ControlRequestError.disconnected
        )

        await store.respond(.confirm)

        XCTAssertEqual(store.presentation?.content, .reconciliationRequired)
        XCTAssertNotNil(store.unknownOutcome(forPane: paneID))
    }

    // A request the transport refused before handing it to the host is a known
    // outcome, and must stay an ordinary failure rather than becoming noise.
    func testPreDispatchRejectionStaysAnOrdinaryFailure() async {
        let (store, _) = await storeAwaitingConfirm(
            failingWith: ControlRequestError.duplicateRequestID("req-2")
        )

        await store.respond(.confirm)

        assertVisibleError(store.presentation)
        XCTAssertFalse(store.isBusy(paneID))
        XCTAssertNil(store.unknownOutcome(forPane: paneID))
    }

    // A host error raised before the action callback runs proves no effect.
    func testPreEffectHostErrorStaysAnOrdinaryFailure() async {
        for code in ["action_session_not_found", "invalid_action_response", "project_scope_violation"] {
            let (store, _) = await storeAwaitingConfirm(
                failingWith: MobileProtocolErrorResponse(
                    requestID: "req-2",
                    code: code,
                    message: "Refused before the action ran."
                )
            )

            await store.respond(.confirm)

            assertVisibleError(store.presentation)
            XCTAssertNil(store.unknownOutcome(forPane: paneID), code)
        }
    }

    // The daemon converts a throw from inside a running action into a generic
    // `internal_error`, so a host error is not by itself proof of no effect.
    func testGenericHostErrorLeavesTheOutcomeUnknown() async {
        let (store, _) = await storeAwaitingConfirm(
            failingWith: MobileProtocolErrorResponse(
                requestID: "req-2",
                code: "internal_error",
                message: "The host failed while running the action."
            )
        )

        await store.respond(.confirm)

        XCTAssertEqual(store.presentation?.content, .reconciliationRequired)
        XCTAssertNotNil(store.unknownOutcome(forPane: paneID))
    }

    func testUnrecognisedHostErrorCodeLeavesTheOutcomeUnknown() async {
        let (store, _) = await storeAwaitingConfirm(
            failingWith: MobileProtocolErrorResponse(
                requestID: "req-2",
                code: "some_code_this_client_has_never_seen",
                message: "Unknown to this client."
            )
        )

        await store.respond(.confirm)

        XCTAssertEqual(store.presentation?.content, .reconciliationRequired)
        XCTAssertNotNil(store.unknownOutcome(forPane: paneID))
    }

    // A read-only action carries no effect to reconcile, so it must not strand
    // a pane behind an acknowledgement the operator never needed.
    func testReadOnlyActionFailureStaysAnOrdinaryFailure() async {
        let (store, _) = await storeAwaitingConfirm(
            action: .openFileBrowser,
            failingWith: ControlRequestError.timedOut("req-2")
        )

        await store.respond(.confirm)

        assertVisibleError(store.presentation)
        XCTAssertFalse(store.isBusy(paneID))
        XCTAssertNil(store.unknownOutcome(forPane: paneID))
    }

    func testEveryMutatingActionIsTreatedAsConsequential() {
        for action in PaneAction.allCases {
            switch action {
            case .view, .copyPath, .openOutput, .openInEditor, .openFileBrowser:
                XCTAssertFalse(action.mayHaveConsequentialEffect, "\(action)")
            default:
                XCTAssertTrue(action.mayHaveConsequentialEffect, "\(action)")
            }
        }
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
    private let startGate: ActionStartGate?
    private let responseGate: ActionResponseGate?

    init(
        responses: [MobileControlResponse] = [],
        startGate: ActionStartGate? = nil,
        responseGate: ActionResponseGate? = nil
    ) {
        self.responses = responses
        self.startGate = startGate
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
            if let startGate,
               let response = await startGate.blockFirst()
            {
                return response
            }
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

private actor ActionStartGate {
    private var hasBlocked = false
    private var blockedContinuation: CheckedContinuation<Void, Never>?
    private var responseContinuation: CheckedContinuation<MobileControlResponse, Never>?

    func blockFirst() async -> MobileControlResponse? {
        guard !hasBlocked else {
            return nil
        }
        hasBlocked = true
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
    dismissable: Bool? = nil,
    data: [String: String]? = nil,
    relatedFiles: [String]? = nil
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
            data: data,
            relatedFiles: relatedFiles,
            dismissable: dismissable
        )
    )
}
