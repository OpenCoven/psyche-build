# Swift Remote Action Reducer and Sheet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tested `RemoteActionStore` and adaptive SwiftUI `ActionSheetView` for confirm, choice, input, PR-review, progress, navigation, and terminal mobile action results.

**Architecture:** PsycheCore owns a pure typed presentation reducer and the `@MainActor` async store that sends `actions.start` and `actions.respond`. PsycheApp owns only display policy and SwiftUI rendering; it accepts a store directly and does not add pane-menu launch wiring in this bead.

**Tech Stack:** Swift 6, Combine, SwiftUI, XCTest, protocol-v3 mobile control messages, XcodeGen, `xcodebuild`

---

## File Structure

- Modify `native/ios/PsycheCore/Sources/PsycheCore/Protocol/ControlMessages.swift`
  - Add public convenience initializers for action payload models so production
    code and cross-module tests can construct complete typed results.
- Modify `native/ios/PsycheCore/Tests/PsycheCoreTests/ControlMessagesTests.swift`
  - Prove the constructors preserve all optional action fields.
- Create `native/ios/PsycheCore/Sources/PsycheCore/State/RemoteActionPresentation.swift`
  - Convert wire-level string result types into typed, validated presentation
    state and ordered scope metadata.
- Create `native/ios/PsycheCore/Tests/PsycheCoreTests/RemoteActionPresentationTests.swift`
  - Cover every result type, missing session IDs, scope order, defaults, and
    malformed payloads.
- Create `native/ios/PsycheCore/Sources/PsycheCore/State/RemoteActionStore.swift`
  - Own action requests, busy panes, single-use continuation state, terminal
    error presentation, and dismissal.
- Create `native/ios/PsycheCore/Tests/PsycheCoreTests/RemoteActionStoreTests.swift`
  - Cover start/respond traffic, chained sessions, cancellation, duplicate tap
    suppression, and every failure path.
- Create `native/ios/PsycheApp/Sources/PsycheApp/Views/ActionSheetPresentation.swift`
  - Define app-only labels, control roles, status treatment, and input sizing.
- Create `native/ios/PsycheApp/Sources/PsycheApp/Views/ActionSheetView.swift`
  - Render the adaptive sheet and delegate all transitions to the core store.
- Create `native/ios/PsycheApp/UnitTests/ActionSheetPresentationTests.swift`
  - Test destructive roles, scope/consequence ordering, status semantics,
    action labels, and input bounds without pixel snapshots.
- Modify `native/ios/Psyche.xcodeproj/project.pbxproj`
  - Regenerate after adding Swift files.

### Task 1: Add Constructible Mobile Action Payloads

**Files:**
- Modify: `native/ios/PsycheCore/Sources/PsycheCore/Protocol/ControlMessages.swift:334-377`
- Modify: `native/ios/PsycheCore/Tests/PsycheCoreTests/ControlMessagesTests.swift`

- [ ] **Step 1: Write the failing constructor round-trip test**

Add this test to `ControlMessagesTests`:

```swift
func testConstructedActionResultPreservesEveryPresentationField() throws {
    let result = MobileActionResult(
        type: "pr_review",
        message: "Review the pull request",
        title: "Create PR",
        confirmLabel: "Create",
        cancelLabel: "Cancel",
        options: [
            MobileActionOption(
                id: "force",
                label: "Force",
                description: "Replace the remote branch",
                danger: true,
                isDefault: false
            ),
        ],
        placeholder: "Summary",
        defaultValue: "Ship mobile actions",
        inputMaxVisibleLines: 8,
        progress: 45,
        targetPaneID: "%7",
        reviewData: MobileActionReviewData(
            repoPath: "/repo",
            sourceBranch: "feat/actions",
            targetBranch: "main",
            files: ["ActionSheetView.swift"],
            aiFailed: true
        ),
        data: [
            "host": "studio.local",
            "projectTitle": "psyche-build",
            "consequence": "Creates a public pull request",
        ],
        relatedFiles: ["ActionSheetView.swift"],
        dismissable: false
    )
    let response = MobileServerMessage.control(.actionResult(
        MobileActionsResultResponse(
            requestID: "action-1",
            sessionID: "session-1",
            result: result
        )
    ))

    let decoded = try JSONDecoder().decode(
        MobileServerMessage.self,
        from: JSONEncoder().encode(response)
    )
    guard case let .control(.actionResult(payload)) = decoded else {
        return XCTFail("Expected actions.result")
    }

    XCTAssertEqual(payload.sessionID, "session-1")
    XCTAssertEqual(payload.result, result)
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
xcodebuild -project native/ios/Psyche.xcodeproj \
  -scheme PsycheCore \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  -only-testing:PsycheCoreTests/ControlMessagesTests/testConstructedActionResultPreservesEveryPresentationField \
  test
```

Expected: FAIL at compile time because the three action payload structs do not
expose public initializers.

- [ ] **Step 3: Add explicit public initializers**

Add these initializers beside the existing properties:

```swift
public struct MobileActionOption: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let label: String
    public let description: String?
    public let danger: Bool?
    public let isDefault: Bool?

    public init(
        id: String,
        label: String,
        description: String? = nil,
        danger: Bool? = nil,
        isDefault: Bool? = nil
    ) {
        self.id = id
        self.label = label
        self.description = description
        self.danger = danger
        self.isDefault = isDefault
    }

    enum CodingKeys: String, CodingKey {
        case id, label, description, danger
        case isDefault = "default"
    }
}

public struct MobileActionReviewData: Codable, Sendable, Equatable {
    public let repoPath: String
    public let sourceBranch: String
    public let targetBranch: String
    public let files: [String]
    public let aiFailed: Bool?

    public init(
        repoPath: String,
        sourceBranch: String,
        targetBranch: String,
        files: [String],
        aiFailed: Bool? = nil
    ) {
        self.repoPath = repoPath
        self.sourceBranch = sourceBranch
        self.targetBranch = targetBranch
        self.files = files
        self.aiFailed = aiFailed
    }
}
```

Add this initializer to `MobileActionResult`:

```swift
public init(
    type: String,
    message: String,
    title: String? = nil,
    confirmLabel: String? = nil,
    cancelLabel: String? = nil,
    options: [MobileActionOption]? = nil,
    placeholder: String? = nil,
    defaultValue: String? = nil,
    inputMaxVisibleLines: Int? = nil,
    progress: Double? = nil,
    targetPaneID: String? = nil,
    reviewData: MobileActionReviewData? = nil,
    data: [String: String]? = nil,
    relatedFiles: [String]? = nil,
    dismissable: Bool? = nil
) {
    self.type = type
    self.message = message
    self.title = title
    self.confirmLabel = confirmLabel
    self.cancelLabel = cancelLabel
    self.options = options
    self.placeholder = placeholder
    self.defaultValue = defaultValue
    self.inputMaxVisibleLines = inputMaxVisibleLines
    self.progress = progress
    self.targetPaneID = targetPaneID
    self.reviewData = reviewData
    self.data = data
    self.relatedFiles = relatedFiles
    self.dismissable = dismissable
}
```

- [ ] **Step 4: Run the focused protocol test**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit the protocol construction seam**

```bash
git add \
  native/ios/PsycheCore/Sources/PsycheCore/Protocol/ControlMessages.swift \
  native/ios/PsycheCore/Tests/PsycheCoreTests/ControlMessagesTests.swift
git commit -m "test: construct mobile action payloads" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Build the Typed Presentation Reducer

**Files:**
- Create: `native/ios/PsycheCore/Sources/PsycheCore/State/RemoteActionPresentation.swift`
- Create: `native/ios/PsycheCore/Tests/PsycheCoreTests/RemoteActionPresentationTests.swift`
- Modify: `native/ios/Psyche.xcodeproj/project.pbxproj`

- [ ] **Step 1: Write failing reducer tests for interaction validation and scope order**

Create `RemoteActionPresentationTests.swift`:

```swift
import XCTest
@testable import PsycheCore

final class RemoteActionPresentationTests: XCTestCase {
    func testInteractiveResultsRequireANonemptySessionID() {
        for type in ["confirm", "choice", "input", "pr_review"] {
            let result = makeResult(type: type)
            XCTAssertThrowsError(
                try RemoteActionPresentation.make(
                    response: MobileActionsResultResponse(
                        requestID: "request-1",
                        sessionID: nil,
                        result: result
                    ),
                    paneID: "pane-1",
                    action: .merge
                )
            ) { error in
                XCTAssertEqual(
                    error as? RemoteActionPresentationError,
                    .missingSessionID(type)
                )
            }
        }
    }

    func testScopeRowsAreStableAndConsequenceIsSeparate() throws {
        let presentation = try RemoteActionPresentation.make(
            response: response(
                type: "confirm",
                sessionID: "session-1",
                data: [
                    "targetBranch": "main",
                    "host": "studio.local",
                    "consequence": "Deletes the pane process",
                    "projectTitle": "psyche-build",
                    "sourceBranch": "feat/actions",
                    "worktreePath": "/repo-actions",
                    "ignored": "not rendered",
                ]
            ),
            paneID: "pane-1",
            action: .close
        )

        XCTAssertEqual(presentation.scope.rows.map(\.key), [
            "host", "projectTitle", "worktreePath", "sourceBranch", "targetBranch",
        ])
        XCTAssertEqual(presentation.scope.consequence, "Deletes the pane process")
    }

    func testEverySupportedResultBecomesTypedContent() throws {
        XCTAssertEqual(try content(type: "success"), .terminal(.success))
        XCTAssertEqual(try content(type: "info"), .terminal(.info))
        XCTAssertEqual(try content(type: "error"), .terminal(.error))
        XCTAssertEqual(try content(type: "progress"), .progress(25))
        XCTAssertEqual(try content(type: "navigation"), .navigation(targetPaneID: "%9"))
        XCTAssertEqual(
            try content(type: "confirm", sessionID: "s"),
            .confirm(confirmLabel: "Continue", cancelLabel: "Cancel")
        )
        XCTAssertEqual(
            try content(type: "choice", sessionID: "s"),
            .choice(options: [MobileActionOption(id: "one", label: "One")])
        )
        XCTAssertEqual(
            try content(type: "input", sessionID: "s"),
            .input(RemoteActionInput(
                placeholder: nil,
                defaultValue: "",
                maxVisibleLines: nil
            ))
        )
        XCTAssertEqual(
            try content(type: "pr_review", sessionID: "s"),
            .pullRequestReview(RemoteActionReview(
                details: MobileActionReviewData(
                    repoPath: "/repo",
                    sourceBranch: "feat/actions",
                    targetBranch: "main",
                    files: ["ActionSheetView.swift"]
                ),
                defaultSummary: ""
            ))
        )
    }

    func testChoiceAndReviewRejectMissingRequiredPayloads() {
        XCTAssertThrowsError(try make(
            result: MobileActionResult(type: "choice", message: "Choose"),
            sessionID: "s"
        )) {
            XCTAssertEqual($0 as? RemoteActionPresentationError, .missingOptions)
        }
        XCTAssertThrowsError(try make(
            result: MobileActionResult(type: "pr_review", message: "Review"),
            sessionID: "s"
        )) {
            XCTAssertEqual($0 as? RemoteActionPresentationError, .missingReviewData)
        }
    }

    func testUnknownTypeFailsVisibly() {
        XCTAssertThrowsError(try make(type: "future_result")) {
            XCTAssertEqual(
                $0 as? RemoteActionPresentationError,
                .unsupportedResultType("future_result")
            )
        }
    }

    func testTerminalMessagesRemainUserDismissable() throws {
        let presentation = try make(
            result: MobileActionResult(
                type: "error",
                message: "Failed",
                dismissable: false
            ),
            sessionID: nil
        )

        XCTAssertTrue(presentation.dismissable)
    }
}
```

In the same test file, add concrete helpers rather than shared global fixtures:

```swift
private extension RemoteActionPresentationTests {
    func makeResult(
        type: String,
        data: [String: String]? = nil
    ) -> MobileActionResult {
        MobileActionResult(
            type: type,
            message: "Message",
            confirmLabel: type == "confirm" ? "Continue" : nil,
            options: type == "choice"
                ? [MobileActionOption(id: "one", label: "One")]
                : nil,
            progress: type == "progress" ? 25 : nil,
            targetPaneID: type == "navigation" ? "%9" : nil,
            reviewData: type == "pr_review"
                ? MobileActionReviewData(
                    repoPath: "/repo",
                    sourceBranch: "feat/actions",
                    targetBranch: "main",
                    files: ["ActionSheetView.swift"]
                )
                : nil,
            data: data
        )
    }

    func response(
        type: String,
        sessionID: String?,
        data: [String: String]? = nil
    ) -> MobileActionsResultResponse {
        MobileActionsResultResponse(
            requestID: "request-1",
            sessionID: sessionID,
            result: makeResult(type: type, data: data)
        )
    }

    func make(type: String, sessionID: String? = nil) throws -> RemoteActionPresentation {
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
```

- [ ] **Step 2: Regenerate the project and run the new test to verify failure**

```bash
pnpm ios:project:generate
xcodebuild -project native/ios/Psyche.xcodeproj \
  -scheme PsycheCore \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  -only-testing:PsycheCoreTests/RemoteActionPresentationTests \
  test
```

Expected: FAIL because the reducer types do not exist.

- [ ] **Step 3: Implement the presentation value types and reducer**

Create `RemoteActionPresentation.swift` with these public types:

```swift
import Foundation

public enum RemoteActionPresentationError: Error, Sendable, Equatable, LocalizedError {
    case missingSessionID(String)
    case missingOptions
    case missingReviewData
    case unsupportedResultType(String)

    public var errorDescription: String? {
        switch self {
        case .missingSessionID(let type):
            "The host returned \(type) without an action session ID."
        case .missingOptions:
            "The host returned a choice without any options."
        case .missingReviewData:
            "The host returned a pull request review without review details."
        case .unsupportedResultType(let type):
            "The host returned an unsupported action result: \(type)."
        }
    }
}

public struct RemoteActionScopeRow: Sendable, Equatable, Identifiable {
    public let key: String
    public let label: String
    public let value: String
    public var id: String { key }
}

public struct RemoteActionScope: Sendable, Equatable {
    public let rows: [RemoteActionScopeRow]
    public let consequence: String?

    static func make(data: [String: String]?) -> Self {
        let data = data ?? [:]
        let definitions = [
            ("host", "Host"),
            ("projectId", "Project ID"),
            ("projectTitle", "Project"),
            ("worktreePath", "Worktree"),
            ("sourceBranch", "Source branch"),
            ("targetBranch", "Target branch"),
        ]
        return Self(
            rows: definitions.compactMap { key, label in
                guard let value = data[key], !value.isEmpty else { return nil }
                return RemoteActionScopeRow(key: key, label: label, value: value)
            },
            consequence: data["consequence"].flatMap { $0.isEmpty ? nil : $0 }
        )
    }
}

public struct RemoteActionInput: Sendable, Equatable {
    public let placeholder: String?
    public let defaultValue: String
    public let maxVisibleLines: Int?
}

public struct RemoteActionReview: Sendable, Equatable {
    public let details: MobileActionReviewData
    public let defaultSummary: String
}

public enum RemoteActionTerminalKind: Sendable, Equatable {
    case success
    case info
    case error
}

public struct RemoteActionPresentation: Sendable, Equatable, Identifiable {
    public enum Content: Sendable, Equatable {
        case confirm(confirmLabel: String, cancelLabel: String)
        case choice(options: [MobileActionOption])
        case input(RemoteActionInput)
        case pullRequestReview(RemoteActionReview)
        case progress(Double?)
        case terminal(RemoteActionTerminalKind)
        case navigation(targetPaneID: String?)
    }

    public let requestID: String
    public let paneID: String
    public let action: PaneAction
    public let title: String
    public let message: String
    public let sessionID: String?
    public let scope: RemoteActionScope
    public let relatedFiles: [String]
    public let dismissable: Bool
    public let content: Content
    public let recoveryText: String?

    public var id: String { requestID }
    public var isInteractive: Bool {
        switch content {
        case .confirm, .choice, .input, .pullRequestReview: true
        case .progress, .terminal, .navigation: false
        }
    }

    public static func make(
        response: MobileActionsResultResponse,
        paneID: String,
        action: PaneAction
    ) throws -> Self {
        let result = response.result
        let sessionID = response.sessionID.flatMap { $0.isEmpty ? nil : $0 }
        let content: Content

        switch result.type {
        case "confirm":
            guard sessionID != nil else {
                throw RemoteActionPresentationError.missingSessionID(result.type)
            }
            content = .confirm(
                confirmLabel: result.confirmLabel ?? "Continue",
                cancelLabel: result.cancelLabel ?? "Cancel"
            )
        case "choice":
            guard sessionID != nil else {
                throw RemoteActionPresentationError.missingSessionID(result.type)
            }
            guard let options = result.options, !options.isEmpty else {
                throw RemoteActionPresentationError.missingOptions
            }
            content = .choice(options: options)
        case "input":
            guard sessionID != nil else {
                throw RemoteActionPresentationError.missingSessionID(result.type)
            }
            content = .input(RemoteActionInput(
                placeholder: result.placeholder,
                defaultValue: result.defaultValue ?? "",
                maxVisibleLines: result.inputMaxVisibleLines
            ))
        case "pr_review":
            guard sessionID != nil else {
                throw RemoteActionPresentationError.missingSessionID(result.type)
            }
            guard let review = result.reviewData else {
                throw RemoteActionPresentationError.missingReviewData
            }
            content = .pullRequestReview(RemoteActionReview(
                details: review,
                defaultSummary: result.defaultValue ?? ""
            ))
        case "progress":
            content = .progress(result.progress.map { min(max($0, 0), 100) })
        case "success":
            content = .terminal(.success)
        case "info":
            content = .terminal(.info)
        case "error":
            content = .terminal(.error)
        case "navigation":
            content = .navigation(targetPaneID: result.targetPaneID)
        default:
            throw RemoteActionPresentationError.unsupportedResultType(result.type)
        }

        let dismissable: Bool
        switch content {
        case .confirm, .choice, .input, .pullRequestReview:
            dismissable = false
        case .progress:
            dismissable = result.dismissable ?? true
        case .terminal, .navigation:
            dismissable = true
        }

        return Self(
            requestID: response.requestID,
            paneID: paneID,
            action: action,
            title: result.title ?? "Action",
            message: result.message,
            sessionID: sessionID,
            scope: .make(data: result.data),
            relatedFiles: result.relatedFiles ?? [],
            dismissable: dismissable,
            content: content,
            recoveryText: nil
        )
    }
}

private extension RemoteActionPresentation.Content {
    var isInteractive: Bool {
        switch self {
        case .confirm, .choice, .input, .pullRequestReview: true
        case .progress, .terminal, .navigation: false
        }
    }
}
```

Also add a factory used by the store for failures:

```swift
public extension RemoteActionPresentation {
    static func failure(
        requestID: String = UUID().uuidString,
        paneID: String,
        action: PaneAction,
        message: String,
        recoveryText: String? = nil
    ) -> Self {
        Self(
            requestID: requestID,
            paneID: paneID,
            action: action,
            title: "That did not work",
            message: message,
            sessionID: nil,
            scope: RemoteActionScope(rows: [], consequence: nil),
            relatedFiles: [],
            dismissable: true,
            content: .terminal(.error),
            recoveryText: recoveryText
        )
    }
}
```

- [ ] **Step 4: Run the reducer test suite**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit the reducer**

```bash
git add \
  native/ios/PsycheCore/Sources/PsycheCore/State/RemoteActionPresentation.swift \
  native/ios/PsycheCore/Tests/PsycheCoreTests/RemoteActionPresentationTests.swift \
  native/ios/Psyche.xcodeproj/project.pbxproj
git commit -m "feat: reduce remote action presentations" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Implement RemoteActionStore Workflows

**Files:**
- Create: `native/ios/PsycheCore/Sources/PsycheCore/State/RemoteActionStore.swift`
- Create: `native/ios/PsycheCore/Tests/PsycheCoreTests/RemoteActionStoreTests.swift`
- Modify: `native/ios/Psyche.xcodeproj/project.pbxproj`

- [ ] **Step 1: Write failing tests for start, chaining, and busy lifetime**

Create `RemoteActionStoreTests.swift`:

```swift
import XCTest
@testable import PsycheCore

@MainActor
final class RemoteActionStoreTests: XCTestCase {
    private let workspace = WorkspaceFixtures.workspace(named: WorkspaceFixtures.multiproject)
    private let paneID = "ios-cockpit"

    func testStartSendsThePaneAndActionAndKeepsInteractivePaneBusy() async {
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
        XCTAssertEqual(starts.first?.paneID, paneID)
        XCTAssertEqual(starts.first?.action, .merge)
        XCTAssertTrue(store.isBusy(paneID))
        XCTAssertTrue(store.presentation?.isInteractive == true)
    }

    func testContinuationReplacesTheSheetAndStaysBusyUntilTerminalResult() async {
        let requests = ActionControlRequests(responses: [
            .actionResult(actionResult(
                requestID: "req-1",
                sessionID: "session-1",
                type: "confirm"
            )),
            .actionResult(actionResult(
                requestID: "req-2",
                sessionID: "session-2",
                type: "input"
            )),
            .actionResult(actionResult(
                requestID: "req-3",
                sessionID: nil,
                type: "success"
            )),
        ])
        let store = RemoteActionStore(controlRequests: requests)

        await store.start(action: .createPR, onPane: paneID, in: workspace)
        await store.respond(.confirm)
        XCTAssertTrue(store.isBusy(paneID))
        XCTAssertEqual(store.presentation?.sessionID, "session-2")

        await store.respond(.input(value: "Ready to ship"), recoveryText: "Ready to ship")
        XCTAssertFalse(store.isBusy(paneID))
        XCTAssertEqual(store.presentation?.content, .terminal(.success))
    }

    func testDuplicateResponseTapSendsOnlyOnce() async {
        let gate = ActionResponseGate()
        let requests = ActionControlRequests(
            responses: [
                .actionResult(actionResult(
                    requestID: "req-1",
                    sessionID: "session-1",
                    type: "confirm"
                )),
            ],
            gate: gate
        )
        let store = RemoteActionStore(controlRequests: requests)
        await store.start(action: .close, onPane: paneID, in: workspace)

        async let first: Void = store.respond(.confirm)
        await gate.waitUntilBlocked()
        await store.respond(.confirm)
        await gate.release(with: .actionResult(actionResult(
            requestID: "req-2",
            sessionID: nil,
            type: "info"
        )))
        await first

        let responseCount = await requests.responds.count
        XCTAssertEqual(responseCount, 1)
    }
}
```

Add explicit failure tests in the same class:

```swift
func testUnpublishedPaneFailsBeforeSending() async {
    let requests = ActionControlRequests()
    let store = RemoteActionStore(controlRequests: requests)

    await store.start(action: .merge, onPane: "%404", in: workspace)

    let sentCount = await requests.sentCount
    XCTAssertEqual(sentCount, 0)
    XCTAssertEqual(store.presentation?.content, .terminal(.error))
    XCTAssertFalse(store.isBusy("%404"))
}

func testMissingSessionIDBecomesVisibleError() async {
    let requests = ActionControlRequests(responses: [
        .actionResult(actionResult(
            requestID: "req-1",
            sessionID: nil,
            type: "choice"
        )),
    ])
    let store = RemoteActionStore(controlRequests: requests)

    await store.start(action: .merge, onPane: paneID, in: workspace)

    XCTAssertEqual(store.presentation?.content, .terminal(.error))
    XCTAssertTrue(store.presentation?.message.contains("session ID") == true)
    XCTAssertFalse(store.isBusy(paneID))
}

func testTransportFailureKeepsSubmittedTextForRecovery() async {
    let requests = ActionControlRequests(responses: [
        .actionResult(actionResult(
            requestID: "req-1",
            sessionID: "session-1",
            type: "input"
        )),
    ])
    let store = RemoteActionStore(controlRequests: requests)
    await store.start(action: .rename, onPane: paneID, in: workspace)
    await requests.failNext(ControlRequestError.disconnected)

    await store.respond(.input(value: "new title"), recoveryText: "new title")

    XCTAssertEqual(store.presentation?.content, .terminal(.error))
    XCTAssertEqual(store.presentation?.recoveryText, "new title")
    XCTAssertFalse(store.isBusy(paneID))
}

func testCancelTravelsThroughTheCurrentSession() async {
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

    let sentResponse = await requests.responds.first?.response
    XCTAssertEqual(sentResponse, .cancel)
    XCTAssertFalse(store.isBusy(paneID))
}

func testProgressPresentationEndsTheRemoteSessionBusyState() async {
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

func testDisconnectedUnexpectedAndProtocolErrorsStayVisible() async {
    let disconnected = RemoteActionStore()
    await disconnected.start(action: .merge, onPane: paneID, in: workspace)
    XCTAssertEqual(disconnected.presentation?.content, .terminal(.error))

    let unexpectedRequests = ActionControlRequests(responses: [
        .ack(ControlAckResponse(requestID: "req-1", ok: true)),
    ])
    let unexpected = RemoteActionStore(controlRequests: unexpectedRequests)
    await unexpected.start(action: .merge, onPane: paneID, in: workspace)
    XCTAssertEqual(unexpected.presentation?.content, .terminal(.error))

    let protocolRequests = ActionControlRequests(responses: [
        .error(MobileProtocolErrorResponse(
            requestID: "req-1",
            code: "action_session_not_found",
            message: "Action session expired"
        )),
    ])
    let protocolFailure = RemoteActionStore(controlRequests: protocolRequests)
    await protocolFailure.start(action: .merge, onPane: paneID, in: workspace)
    XCTAssertEqual(protocolFailure.presentation?.message, "Action session expired")
}
```

Add these deterministic actors and helpers to the test file:

```swift
private actor ActionControlRequests: ControlRequesting {
    private(set) var starts: [MobileActionStartRequest] = []
    private(set) var responds: [MobileActionRespondRequest] = []
    private(set) var sentCount = 0
    private var responses: [MobileControlResponse]
    private var failure: (any Error)?
    private var nextID = 0
    private let gate: ActionResponseGate?

    init(
        responses: [MobileControlResponse] = [],
        gate: ActionResponseGate? = nil
    ) {
        self.responses = responses
        self.gate = gate
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
        if case let .startAction(start) = request { starts.append(start) }
        if case let .respondToAction(response) = request {
            responds.append(response)
            if let gate { return await gate.block() }
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
        if responseContinuation != nil { return }
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
    type: String
) -> MobileActionsResultResponse {
    MobileActionsResultResponse(
        requestID: requestID,
        sessionID: sessionID,
        result: MobileActionResult(
            type: type,
            message: "\(type) message",
            options: type == "choice"
                ? [MobileActionOption(id: "one", label: "One")]
                : nil,
            reviewData: type == "pr_review"
                ? MobileActionReviewData(
                    repoPath: "/repo",
                    sourceBranch: "feat/actions",
                    targetBranch: "main",
                    files: ["ActionSheetView.swift"]
                )
                : nil
        )
    )
}
```

- [ ] **Step 2: Regenerate and run the store tests to verify failure**

```bash
pnpm ios:project:generate
xcodebuild -project native/ios/Psyche.xcodeproj \
  -scheme PsycheCore \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  -only-testing:PsycheCoreTests/RemoteActionStoreTests \
  test
```

Expected: FAIL because `RemoteActionStore` does not exist.

- [ ] **Step 3: Implement the store and visible error reduction**

Create `RemoteActionStore.swift`:

```swift
import Combine
import Foundation

public enum RemoteActionStoreError: Error, Sendable, Equatable, LocalizedError {
    case unexpectedResponse

    public var errorDescription: String? {
        "The host answered the action request with something else."
    }
}

@MainActor
public final class RemoteActionStore: ObservableObject {
    @Published public private(set) var presentation: RemoteActionPresentation?
    @Published public private(set) var busyPaneIDs: Set<String> = []
    @Published public private(set) var isSubmitting = false

    private let controlRequests: (any ControlRequesting)?

    public init(controlRequests: (any ControlRequesting)? = nil) {
        self.controlRequests = controlRequests
    }

    public func isBusy(_ paneID: String) -> Bool {
        busyPaneIDs.contains(paneID)
    }

    public func start(
        action: PaneAction,
        onPane paneID: String,
        in workspace: WorkspaceSnapshot
    ) async {
        guard containsPane(paneID, in: workspace) else {
            fail(paneID: paneID, action: action, message: "Pane \(paneID) is not published by this host.")
            return
        }
        guard let controlRequests else {
            fail(paneID: paneID, action: action, message: "This action is not connected to a host.")
            return
        }

        busyPaneIDs.insert(paneID)
        let requestID = await controlRequests.nextRequestID()
        do {
            let response = try await controlRequests.send(.startAction(
                MobileActionStartRequest(
                    requestID: requestID,
                    paneID: paneID,
                    action: action
                )
            ))
            try apply(
                response,
                expectedRequestID: requestID,
                paneID: paneID,
                action: action
            )
        } catch {
            fail(paneID: paneID, action: action, message: error.localizedDescription)
        }
    }

    public func respond(
        _ response: MobileActionResponse,
        recoveryText: String? = nil
    ) async {
        guard !isSubmitting,
              let current = presentation,
              current.isInteractive,
              let sessionID = current.sessionID,
              let controlRequests
        else {
            return
        }

        isSubmitting = true
        presentation = current.consumingSession()
        let requestID = await controlRequests.nextRequestID()
        defer { isSubmitting = false }

        do {
            let result = try await controlRequests.send(.respondToAction(
                MobileActionRespondRequest(
                    requestID: requestID,
                    sessionID: sessionID,
                    response: response
                )
            ))
            try apply(
                result,
                expectedRequestID: requestID,
                paneID: current.paneID,
                action: current.action
            )
        } catch {
            fail(
                paneID: current.paneID,
                action: current.action,
                message: error.localizedDescription,
                recoveryText: recoveryText
            )
        }
    }

    public func dismiss() {
        guard let presentation,
              !presentation.isInteractive,
              presentation.dismissable,
              !isSubmitting
        else {
            return
        }
        self.presentation = nil
    }
}
```

Add these private helpers in the same file:

```swift
private extension RemoteActionStore {
    func apply(
        _ response: MobileControlResponse,
        expectedRequestID: String,
        paneID: String,
        action: PaneAction
    ) throws {
        switch response {
        case .actionResult(let payload):
            guard payload.requestID == expectedRequestID else {
                throw RemoteActionStoreError.unexpectedResponse
            }
            let next = try RemoteActionPresentation.make(
                response: payload,
                paneID: paneID,
                action: action
            )
            presentation = next
            if !next.isInteractive { busyPaneIDs.remove(paneID) }
        case .error(let error):
            throw error
        default:
            throw RemoteActionStoreError.unexpectedResponse
        }
    }

    func fail(
        paneID: String,
        action: PaneAction,
        message: String,
        recoveryText: String? = nil
    ) {
        busyPaneIDs.remove(paneID)
        presentation = .failure(
            paneID: paneID,
            action: action,
            message: message,
            recoveryText: recoveryText
        )
    }

    func containsPane(_ paneID: String, in workspace: WorkspaceSnapshot) -> Bool {
        workspace.projects.contains { project in
            project.projectPanes.contains { $0.id == paneID }
                || project.worktrees.contains { worktree in
                    worktree.panes.contains { $0.id == paneID }
                }
        }
    }
}
```

Add the local single-use mutation helper to
`RemoteActionPresentation.swift`:

```swift
extension RemoteActionPresentation {
    func consumingSession() -> Self {
        Self(
            requestID: requestID,
            paneID: paneID,
            action: action,
            title: title,
            message: message,
            sessionID: nil,
            scope: scope,
            relatedFiles: relatedFiles,
            dismissable: dismissable,
            content: content,
            recoveryText: recoveryText
        )
    }
}
```

- [ ] **Step 4: Run the store tests and then all action protocol tests**

```bash
xcodebuild -project native/ios/Psyche.xcodeproj \
  -scheme PsycheCore \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  -only-testing:PsycheCoreTests/RemoteActionStoreTests \
  -only-testing:PsycheCoreTests/RemoteActionPresentationTests \
  -only-testing:PsycheCoreTests/ControlMessagesTests \
  test
```

Expected: PASS.

- [ ] **Step 5: Commit the core action workflow**

```bash
git add \
  native/ios/PsycheCore/Sources/PsycheCore/State/RemoteActionPresentation.swift \
  native/ios/PsycheCore/Sources/PsycheCore/State/RemoteActionStore.swift \
  native/ios/PsycheCore/Tests/PsycheCoreTests/RemoteActionStoreTests.swift \
  native/ios/Psyche.xcodeproj/project.pbxproj
git commit -m "feat: add Swift remote action store" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 4: Build the Adaptive Action Sheet

**Files:**
- Create: `native/ios/PsycheApp/Sources/PsycheApp/Views/ActionSheetPresentation.swift`
- Create: `native/ios/PsycheApp/Sources/PsycheApp/Views/ActionSheetView.swift`
- Create: `native/ios/PsycheApp/UnitTests/ActionSheetPresentationTests.swift`
- Modify: `native/ios/Psyche.xcodeproj/project.pbxproj`

- [ ] **Step 1: Write failing app presentation tests**

Create `ActionSheetPresentationTests.swift`:

```swift
import PsycheCore
import XCTest
@testable import Psyche_Build

@MainActor
final class ActionSheetPresentationTests: XCTestCase {
    func testConsequenceAlwaysPrecedesContentAndControls() {
        let sections = ActionSheetPresentation.sectionOrder(
            hasScope: true,
            hasConsequence: true,
            hasRelatedFiles: true
        )
        XCTAssertEqual(sections, [
            .scope, .consequence, .content, .relatedFiles, .controls,
        ])
    }

    func testOnlyCloseConfirmationUsesDestructiveRole() {
        XCTAssertEqual(ActionSheetPresentation.confirmRole(for: .close), .destructive)
        XCTAssertEqual(ActionSheetPresentation.confirmRole(for: .merge), .normal)
        XCTAssertEqual(ActionSheetPresentation.confirmRole(for: .createPR), .normal)
    }

    func testDangerousChoiceUsesDestructiveRole() {
        XCTAssertEqual(
            ActionSheetPresentation.optionRole(
                MobileActionOption(id: "delete", label: "Delete", danger: true)
            ),
            .destructive
        )
        XCTAssertEqual(
            ActionSheetPresentation.optionRole(
                MobileActionOption(id: "keep", label: "Keep")
            ),
            .normal
        )
    }

    func testInputLineBoundsAreClamped() {
        XCTAssertEqual(ActionSheetPresentation.inputLineRange(nil), 1...6)
        XCTAssertEqual(ActionSheetPresentation.inputLineRange(0), 1...1)
        XCTAssertEqual(ActionSheetPresentation.inputLineRange(50), 1...12)
    }

    func testTerminalKindsHaveDistinctAccessibleSemantics() {
        XCTAssertEqual(
            ActionSheetPresentation.status(for: .success),
            .init(label: "Succeeded", systemImage: "checkmark.circle.fill", tone: .success)
        )
        XCTAssertEqual(
            ActionSheetPresentation.status(for: .info),
            .init(label: "Information", systemImage: "info.circle.fill", tone: .info)
        )
        XCTAssertEqual(
            ActionSheetPresentation.status(for: .error),
            .init(label: "Failed", systemImage: "exclamationmark.triangle.fill", tone: .error)
        )
    }

    func testEveryPaneActionHasAReadableLabel() {
        for action in PaneAction.allCases {
            XCTAssertFalse(ActionSheetPresentation.actionLabel(for: action).isEmpty)
            XCTAssertFalse(ActionSheetPresentation.actionLabel(for: action).contains("_"))
        }
    }
}
```

- [ ] **Step 2: Regenerate and run the app tests to verify failure**

```bash
pnpm ios:project:generate
xcodebuild -project native/ios/Psyche.xcodeproj \
  -scheme PsycheApp \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  -only-testing:PsycheAppTests/ActionSheetPresentationTests \
  test
```

Expected: FAIL because the action sheet presentation helpers do not exist.

- [ ] **Step 3: Implement the app-side presentation policy**

Create `ActionSheetPresentation.swift`:

```swift
import PsycheCore

enum ActionSheetSection: Equatable {
    case scope
    case consequence
    case content
    case relatedFiles
    case controls
}

enum ActionSheetControlRole: Equatable {
    case normal
    case destructive
}

enum ActionSheetStatusTone: Equatable {
    case success
    case info
    case error
}

struct ActionSheetStatus: Equatable {
    let label: String
    let systemImage: String
    let tone: ActionSheetStatusTone
}

enum ActionSheetPresentation {
    static func sectionOrder(
        hasScope: Bool,
        hasConsequence: Bool,
        hasRelatedFiles: Bool
    ) -> [ActionSheetSection] {
        (hasScope ? [.scope] : [])
            + (hasConsequence ? [.consequence] : [])
            + [.content]
            + (hasRelatedFiles ? [.relatedFiles] : [])
            + [.controls]
    }

    static func confirmRole(for action: PaneAction) -> ActionSheetControlRole {
        action == .close ? .destructive : .normal
    }

    static func optionRole(_ option: MobileActionOption) -> ActionSheetControlRole {
        option.danger == true ? .destructive : .normal
    }

    static func inputLineRange(_ requested: Int?) -> ClosedRange<Int> {
        1...min(max(requested ?? 6, 1), 12)
    }

    static func status(for kind: RemoteActionTerminalKind) -> ActionSheetStatus {
        switch kind {
        case .success:
            .init(label: "Succeeded", systemImage: "checkmark.circle.fill", tone: .success)
        case .info:
            .init(label: "Information", systemImage: "info.circle.fill", tone: .info)
        case .error:
            .init(label: "Failed", systemImage: "exclamationmark.triangle.fill", tone: .error)
        }
    }

    static func actionLabel(for action: PaneAction) -> String {
        switch action {
        case .view: "View"
        case .setSource: "Set Source"
        case .close: "Close"
        case .merge: "Merge"
        case .createPR: "Create Pull Request"
        case .rename: "Rename"
        case .duplicate: "Duplicate"
        case .runTest: "Run Tests"
        case .runDev: "Run Dev App"
        case .openOutput: "Open Output"
        case .copyPath: "Copy Path"
        case .openInEditor: "Open in Editor"
        case .toggleAutopilot: "Toggle Autopilot"
        case .attachAgent: "Attach Agent"
        case .createChildWorktree: "Create Child Worktree"
        case .openTerminalInWorktree: "Open Terminal in Worktree"
        case .openFileBrowser: "Open File Browser"
        }
    }
}
```

- [ ] **Step 4: Implement the adaptive SwiftUI sheet**

Create `ActionSheetView.swift`. Use an observed store parameter so this bead
does not wire a launch menu or global sheet:

```swift
import PsycheCore
import SwiftUI

struct ActionSheetView: View {
    @ObservedObject var store: RemoteActionStore
    @State private var draft = ""

    var body: some View {
        NavigationStack {
            Group {
                if let presentation = store.presentation {
                    Form {
                        header(presentation)
                        scope(presentation)
                        consequence(presentation)
                        content(presentation)
                        relatedFiles(presentation)
                        controls(presentation)
                    }
                    .navigationTitle(presentation.title)
                    .navigationBarTitleDisplayMode(.inline)
                    .interactiveDismissDisabled(
                        presentation.isInteractive
                            || !presentation.dismissable
                            || store.isSubmitting
                    )
                    .onChange(of: presentation.requestID, initial: true) {
                        draft = initialDraft(for: presentation)
                    }
                } else {
                    ContentUnavailableView(
                        "No action",
                        systemImage: "bolt.slash",
                        description: Text("There is no remote action to display.")
                    )
                }
            }
        }
        .accessibilityIdentifier("remote-action-sheet")
    }
}
```

Implement the sections in the same file in the exact order used above:

```swift
private extension ActionSheetView {
    func header(_ presentation: RemoteActionPresentation) -> some View {
        Section {
            LabeledContent(
                "Action",
                value: ActionSheetPresentation.actionLabel(for: presentation.action)
            )
            LabeledContent("Pane", value: presentation.paneID)
        }
    }

    @ViewBuilder
    func scope(_ presentation: RemoteActionPresentation) -> some View {
        if !presentation.scope.rows.isEmpty {
            Section("Scope") {
                ForEach(presentation.scope.rows) { row in
                    LabeledContent(row.label, value: row.value)
                }
            }
        }
    }

    @ViewBuilder
    func consequence(_ presentation: RemoteActionPresentation) -> some View {
        if let consequence = presentation.scope.consequence {
            Section("Consequence") {
                Label(consequence, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(PsycheTheme.amber)
            }
        }
    }

    @ViewBuilder
    func content(_ presentation: RemoteActionPresentation) -> some View {
        Section {
            Text(presentation.message)
            switch presentation.content {
            case .confirm:
                EmptyView()
            case .choice(let options):
                ForEach(options) { option in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(option.label)
                        if let description = option.description {
                            Text(description)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            case .input(let input):
                TextField(input.placeholder ?? "Value", text: $draft, axis: .vertical)
                    .lineLimit(ActionSheetPresentation.inputLineRange(input.maxVisibleLines))
            case .pullRequestReview(let review):
                LabeledContent("Branches") {
                    Text("\(review.details.sourceBranch) → \(review.details.targetBranch)")
                }
                if review.details.aiFailed == true {
                    Label(
                        "AI summary generation failed. Review the text before submitting.",
                        systemImage: "exclamationmark.triangle.fill"
                    )
                    .foregroundStyle(PsycheTheme.amber)
                }
                TextField("Pull request summary", text: $draft, axis: .vertical)
                    .lineLimit(ActionSheetPresentation.inputLineRange(8))
                ForEach(review.details.files, id: \.self) { file in
                    Label(file, systemImage: "doc.text")
                }
            case .progress(let value):
                if let value {
                    ProgressView(value: value, total: 100)
                } else {
                    ProgressView()
                }
            case .terminal(let kind):
                let status = ActionSheetPresentation.status(for: kind)
                Label(status.label, systemImage: status.systemImage)
                    .foregroundStyle(statusColor(status.tone))
                if let recoveryText = presentation.recoveryText {
                    Text(recoveryText)
                        .textSelection(.enabled)
                        .accessibilityLabel("Recoverable submitted text")
                }
            case .navigation(let targetPaneID):
                if let targetPaneID {
                    LabeledContent("Target pane", value: targetPaneID)
                }
            }
        }
    }

    @ViewBuilder
    func relatedFiles(_ presentation: RemoteActionPresentation) -> some View {
        if !presentation.relatedFiles.isEmpty {
            Section("Related files") {
                ForEach(presentation.relatedFiles, id: \.self) { file in
                    Label(file, systemImage: "doc.text")
                }
            }
        }
    }
}
```

Add controls and response delegation:

```swift
private extension ActionSheetView {
    @ViewBuilder
    func controls(_ presentation: RemoteActionPresentation) -> some View {
        Section {
            switch presentation.content {
            case .confirm(let confirmLabel, let cancelLabel):
                Button(cancelLabel) { submit(.cancel) }
                    .disabled(store.isSubmitting)
                actionButton(
                    confirmLabel,
                    role: ActionSheetPresentation.confirmRole(for: presentation.action)
                ) {
                    submit(.confirm)
                }
            case .choice(let options):
                ForEach(options) { option in
                    actionButton(
                        option.label,
                        role: ActionSheetPresentation.optionRole(option)
                    ) {
                        submit(.choice(optionID: option.id))
                    }
                }
                Button("Cancel") { submit(.cancel) }
                    .disabled(store.isSubmitting)
            case .input:
                Button("Cancel") { submit(.cancel) }
                    .disabled(store.isSubmitting)
                Button("Submit") {
                    submit(.input(value: draft), recoveryText: draft)
                }
                .disabled(store.isSubmitting)
            case .pullRequestReview:
                Button("Cancel") { submit(.cancel) }
                    .disabled(store.isSubmitting)
                Button("Submit Review") {
                    submit(.input(value: draft), recoveryText: draft)
                }
                .disabled(store.isSubmitting)
            case .progress:
                if presentation.dismissable {
                    Button("Dismiss") { store.dismiss() }
                }
            case .terminal, .navigation:
                Button("Done") { store.dismiss() }
                    .disabled(!presentation.dismissable)
            }

            if store.isSubmitting {
                ProgressView("Sending…")
            }
        }
    }

    func actionButton(
        _ title: String,
        role: ActionSheetControlRole,
        action: @escaping () -> Void
    ) -> some View {
        Button(
            title,
            role: role == .destructive ? .destructive : nil,
            action: action
        )
        .disabled(store.isSubmitting)
    }

    func submit(
        _ response: MobileActionResponse,
        recoveryText: String? = nil
    ) {
        Task {
            await store.respond(response, recoveryText: recoveryText)
        }
    }

    func initialDraft(for presentation: RemoteActionPresentation) -> String {
        switch presentation.content {
        case .input(let input): input.defaultValue
        case .pullRequestReview(let review): review.defaultSummary
        default: ""
        }
    }

    func statusColor(_ tone: ActionSheetStatusTone) -> Color {
        switch tone {
        case .success: PsycheTheme.mint
        case .info: PsycheTheme.terminalText
        case .error: PsycheTheme.amber
        }
    }
}
```

- [ ] **Step 5: Run focused app tests and build the app**

```bash
pnpm ios:project:generate
xcodebuild -project native/ios/Psyche.xcodeproj \
  -scheme PsycheApp \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  -only-testing:PsycheAppTests/ActionSheetPresentationTests \
  test
xcodebuild -project native/ios/Psyche.xcodeproj \
  -scheme PsycheApp \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  build
```

Expected: the focused tests PASS and the PsycheApp build succeeds.

- [ ] **Step 6: Commit the reusable sheet**

```bash
git add \
  native/ios/PsycheApp/Sources/PsycheApp/Views/ActionSheetPresentation.swift \
  native/ios/PsycheApp/Sources/PsycheApp/Views/ActionSheetView.swift \
  native/ios/PsycheApp/UnitTests/ActionSheetPresentationTests.swift \
  native/ios/Psyche.xcodeproj/project.pbxproj
git commit -m "feat: add native remote action sheet" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 5: Run the Complete iOS Action Gate

**Files:**
- Verify: `native/ios/PsycheCore/Sources/PsycheCore/Protocol/ControlMessages.swift`
- Verify: `native/ios/PsycheCore/Sources/PsycheCore/State/RemoteActionPresentation.swift`
- Verify: `native/ios/PsycheCore/Sources/PsycheCore/State/RemoteActionStore.swift`
- Verify: `native/ios/PsycheApp/Sources/PsycheApp/Views/ActionSheetPresentation.swift`
- Verify: `native/ios/PsycheApp/Sources/PsycheApp/Views/ActionSheetView.swift`
- Verify: `native/ios/Psyche.xcodeproj/project.pbxproj`

- [ ] **Step 1: Confirm XcodeGen is deterministic**

```bash
pnpm ios:project:check
```

Expected: PASS with no generated project diff.

- [ ] **Step 2: Run all PsycheCore tests**

```bash
xcodebuild -project native/ios/Psyche.xcodeproj \
  -scheme PsycheCore \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  test
```

Expected: PASS.

- [ ] **Step 3: Run all PsycheApp unit tests without the UI-test bundle**

```bash
xcodebuild -project native/ios/Psyche.xcodeproj \
  -scheme PsycheApp \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  -only-testing:PsycheAppTests \
  test
```

Expected: PASS.

- [ ] **Step 4: Check the exact diff**

```bash
git --no-pager diff --check
git --no-pager status --short
```

Expected: no whitespace errors and no uncommitted implementation files. Ignore
pre-existing unrelated `.gitignore` and `.swp` changes; do not stage or modify
them.

- [ ] **Step 5: Close the bead with concrete evidence**

```bash
bd close psyche-i7c.8.3 --reason \
  "Implemented the Swift RemoteActionStore reducer and adaptive ActionSheetView for confirm, choice, input, PR review, progress, navigation, and terminal results. Interactive results require session IDs, chained sessions retain busy pane state, scoped consequences precede destructive controls, and transport/protocol failures remain visible. Verified deterministic XcodeGen plus full PsycheCore and PsycheApp unit test gates."
bd dolt push
```

Expected: `psyche-i7c.8.3` is closed and Beads synchronization succeeds.
