import Foundation
import XCTest
@testable import PsycheCore

final class RemoteActionPresentationTests: XCTestCase {
    func testEveryInteractiveResultRejectsNilAndEmptySessionIDs() {
        for type in ["confirm", "choice", "input", "pr_review"] {
            for sessionID: String? in [nil, ""] {
                XCTAssertThrowsError(
                    try make(type: type, sessionID: sessionID),
                    "\(type) should reject \(sessionID == nil ? "nil" : "empty") session IDs"
                ) { error in
                    XCTAssertEqual(
                        error as? RemoteActionPresentationError,
                        .missingSessionID(type)
                    )
                }
            }
        }
    }

    func testScopeRowsHaveStableOrderAndConsequenceIsSeparate() throws {
        let presentation = try make(
            result: makeResult(
                type: "confirm",
                data: [
                    "targetBranch": "main",
                    "unknown": "not rendered",
                    "host": "studio.local",
                    "consequence": "Deletes the pane process",
                    "projectTitle": "psyche-build",
                    "sourceBranch": "feat/actions",
                    "projectId": "psyche",
                    "worktreePath": "/repo-actions",
                ]
            ),
            sessionID: "session-1"
        )

        XCTAssertEqual(
            presentation.scope.rows,
            [
                RemoteActionScopeRow(key: "host", label: "Host", value: "studio.local"),
                RemoteActionScopeRow(key: "projectId", label: "Project ID", value: "psyche"),
                RemoteActionScopeRow(key: "projectTitle", label: "Project", value: "psyche-build"),
                RemoteActionScopeRow(key: "worktreePath", label: "Worktree", value: "/repo-actions"),
                RemoteActionScopeRow(key: "sourceBranch", label: "Source branch", value: "feat/actions"),
                RemoteActionScopeRow(key: "targetBranch", label: "Target branch", value: "main"),
            ]
        )
        XCTAssertEqual(presentation.scope.rows.map(\.id), presentation.scope.rows.map(\.key))
        XCTAssertEqual(presentation.scope.consequence, "Deletes the pane process")
    }

    func testScopeOmitsAbsentAndEmptyValues() throws {
        let presentation = try make(
            result: makeResult(
                type: "confirm",
                data: [
                    "host": "",
                    "projectTitle": "psyche-build",
                    "consequence": "",
                ]
            ),
            sessionID: "session-1"
        )

        XCTAssertEqual(presentation.scope.rows.map(\.key), ["projectTitle"])
        XCTAssertNil(presentation.scope.consequence)
    }

    func testEverySupportedResultMapsToExactTypedContent() throws {
        XCTAssertEqual(try content(type: "success"), .terminal(.success))
        XCTAssertEqual(try content(type: "info"), .terminal(.info))
        XCTAssertEqual(try content(type: "error"), .terminal(.error))
        XCTAssertEqual(try content(type: "progress"), .progress(25))
        XCTAssertEqual(try content(type: "navigation"), .navigation(targetPaneID: "%9"))
        XCTAssertEqual(
            try content(type: "confirm", sessionID: "session-1"),
            .confirm(confirmLabel: "Continue", cancelLabel: "Cancel")
        )
        XCTAssertEqual(
            try content(type: "choice", sessionID: "session-1"),
            .choice(options: [MobileActionOption(id: "one", label: "One")])
        )
        XCTAssertEqual(
            try content(type: "input", sessionID: "session-1"),
            .input(RemoteActionInput(
                placeholder: "Type a response",
                defaultValue: "Draft",
                maxVisibleLines: 5
            ))
        )
        XCTAssertEqual(
            try content(type: "pr_review", sessionID: "session-1"),
            .pullRequestReview(RemoteActionReview(
                details: reviewData(),
                defaultSummary: "Ready to merge"
            ))
        )
    }

    func testPresentationDefaultsAndWireFieldsArePreserved() throws {
        let presentation = try make(
            result: MobileActionResult(
                type: "input",
                message: "Respond",
                relatedFiles: nil
            ),
            sessionID: "session-1"
        )

        XCTAssertEqual(presentation.id, "request-1")
        XCTAssertEqual(presentation.requestID, "request-1")
        XCTAssertEqual(presentation.paneID, "pane-1")
        XCTAssertEqual(presentation.action, .merge)
        XCTAssertEqual(presentation.title, "Action")
        XCTAssertEqual(presentation.message, "Respond")
        XCTAssertEqual(presentation.sessionID, "session-1")
        XCTAssertEqual(presentation.relatedFiles, [])
        XCTAssertNil(presentation.recoveryText)
        XCTAssertEqual(
            presentation.content,
            .input(RemoteActionInput(
                placeholder: nil,
                defaultValue: "",
                maxVisibleLines: nil
            ))
        )
    }

    func testProgressClampsBelowZeroAndAboveOneHundred() throws {
        XCTAssertEqual(
            try make(
                result: MobileActionResult(type: "progress", message: "Starting", progress: -1),
                sessionID: nil
            ).content,
            .progress(0)
        )
        XCTAssertEqual(
            try make(
                result: MobileActionResult(type: "progress", message: "Finishing", progress: 101),
                sessionID: nil
            ).content,
            .progress(100)
        )
        XCTAssertEqual(
            try make(
                result: MobileActionResult(type: "progress", message: "Working"),
                sessionID: nil
            ).content,
            .progress(nil)
        )
    }

    func testChoiceMissingOptionsThrowsExactError() {
        for options: [MobileActionOption]? in [nil, []] {
            XCTAssertThrowsError(try make(
                result: MobileActionResult(
                    type: "choice",
                    message: "Choose",
                    options: options
                ),
                sessionID: "session-1"
            )) { error in
                XCTAssertEqual(error as? RemoteActionPresentationError, .missingOptions)
            }
        }
    }

    func testPullRequestReviewMissingReviewDataThrowsExactError() {
        XCTAssertThrowsError(try make(
            result: MobileActionResult(type: "pr_review", message: "Review"),
            sessionID: "session-1"
        )) { error in
            XCTAssertEqual(error as? RemoteActionPresentationError, .missingReviewData)
        }
    }

    func testUnknownTypeThrowsExactUnsupportedError() {
        XCTAssertThrowsError(try make(type: "future_result", sessionID: nil)) { error in
            XCTAssertEqual(
                error as? RemoteActionPresentationError,
                .unsupportedResultType("future_result")
            )
        }
    }

    func testTerminalResultsAreDismissableAndInteractiveResultsAreNot() throws {
        for type in ["success", "info", "error"] {
            let presentation = try make(
                result: makeResult(type: type, dismissable: false),
                sessionID: nil
            )
            XCTAssertTrue(presentation.dismissable)
            XCTAssertFalse(presentation.isInteractive)
        }

        for type in ["confirm", "choice", "input", "pr_review"] {
            let presentation = try make(
                result: makeResult(type: type, dismissable: true),
                sessionID: "session-1"
            )
            XCTAssertFalse(presentation.dismissable)
            XCTAssertTrue(presentation.isInteractive)
        }
    }

    func testProgressAndNavigationAreAlwaysDismissable() throws {
        XCTAssertTrue(try make(
            result: makeResult(type: "progress", dismissable: false),
            sessionID: nil
        ).dismissable)
        XCTAssertTrue(try make(
            result: makeResult(type: "progress", dismissable: nil),
            sessionID: nil
        ).dismissable)
        XCTAssertTrue(try make(
            result: makeResult(type: "navigation", dismissable: false),
            sessionID: nil
        ).dismissable)
    }

    func testFailureFactoryReturnsTerminalErrorAndPreservesRecoveryText() {
        let presentation = RemoteActionPresentation.failure(
            requestID: "failure-1",
            paneID: "pane-1",
            action: .merge,
            message: "The host disconnected.",
            recoveryText: "Unsaved review summary"
        )

        XCTAssertEqual(presentation.id, "failure-1")
        XCTAssertEqual(presentation.title, "That did not work")
        XCTAssertEqual(presentation.message, "The host disconnected.")
        XCTAssertNil(presentation.sessionID)
        XCTAssertEqual(presentation.scope, RemoteActionScope(rows: [], consequence: nil))
        XCTAssertEqual(presentation.relatedFiles, [])
        XCTAssertTrue(presentation.dismissable)
        XCTAssertEqual(presentation.content, .terminal(.error))
        XCTAssertEqual(presentation.recoveryText, "Unsaved review summary")
        XCTAssertFalse(presentation.isInteractive)

        let generatedID = RemoteActionPresentation.failure(
            paneID: "pane-1",
            action: .merge,
            message: "Failed"
        ).requestID
        XCTAssertNotNil(UUID(uuidString: generatedID))
    }

    func testReducerErrorsHaveActionableDescriptions() {
        XCTAssertEqual(
            RemoteActionPresentationError.missingSessionID("confirm").errorDescription,
            "The host returned confirm without an action session ID."
        )
        XCTAssertEqual(
            RemoteActionPresentationError.missingOptions.errorDescription,
            "The host returned a choice without any options."
        )
        XCTAssertEqual(
            RemoteActionPresentationError.missingReviewData.errorDescription,
            "The host returned a pull request review without review details."
        )
        XCTAssertEqual(
            RemoteActionPresentationError.unsupportedResultType("future").errorDescription,
            "The host returned an unsupported action result: future."
        )
    }
}

private extension RemoteActionPresentationTests {
    func makeResult(
        type: String,
        data: [String: String]? = nil,
        dismissable: Bool? = nil
    ) -> MobileActionResult {
        MobileActionResult(
            type: type,
            message: "Message",
            options: type == "choice"
                ? [MobileActionOption(id: "one", label: "One")]
                : nil,
            placeholder: type == "input" ? "Type a response" : nil,
            defaultValue: type == "input"
                ? "Draft"
                : type == "pr_review" ? "Ready to merge" : nil,
            inputMaxVisibleLines: type == "input" ? 5 : nil,
            progress: type == "progress" ? 25 : nil,
            targetPaneID: type == "navigation" ? "%9" : nil,
            reviewData: type == "pr_review" ? reviewData() : nil,
            data: data,
            dismissable: dismissable
        )
    }

    func reviewData() -> MobileActionReviewData {
        MobileActionReviewData(
            repoPath: "/repo",
            sourceBranch: "feat/actions",
            targetBranch: "main",
            files: ["ActionSheetView.swift"]
        )
    }

    func make(
        type: String,
        sessionID: String?
    ) throws -> RemoteActionPresentation {
        try make(result: makeResult(type: type), sessionID: sessionID)
    }

    func make(
        result: MobileActionResult,
        sessionID: String?
    ) throws -> RemoteActionPresentation {
        try RemoteActionPresentation.make(
            response: MobileActionsResultResponse(
                requestID: "request-1",
                sessionID: sessionID,
                result: result
            ),
            paneID: "pane-1",
            action: .merge
        )
    }

    func content(
        type: String,
        sessionID: String? = nil
    ) throws -> RemoteActionPresentation.Content {
        try make(type: type, sessionID: sessionID).content
    }
}
