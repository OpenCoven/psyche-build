import Foundation
import PsycheCore
import XCTest
@testable import Psyche_Build

@MainActor
final class CreatePaneFormTests: XCTestCase {
    private var workspace: WorkspaceSnapshot {
        WorkspaceFixtures.workspace(named: WorkspaceFixtures.multiproject)
    }

    // MARK: - Targets

    func testTargetsCoverEveryDistinctWorkingDirectory() {
        let targets = CreatePaneForm.targets(in: workspace)

        // Each project's main worktree is its root, so the fixture offers four
        // distinct directories rather than seven rows for four places.
        XCTAssertEqual(targets.count, 4)
        XCTAssertTrue(targets.contains { $0.cwd == "/Users/demo/Code/psyche-build" })
        XCTAssertTrue(targets.contains { $0.branch == "feat/native-ios-cloud-terminal" })
    }

    /// A project whose main worktree is its root must not offer that directory
    /// twice — duplicate rows also mean duplicate identities in a list.
    func testARootThatIsAlsoAWorktreeIsOfferedOnce() {
        let targets = CreatePaneForm.targets(in: workspace)
            .filter { $0.cwd == "/Users/demo/Code/psyche-build" }

        XCTAssertEqual(targets.count, 1)
        XCTAssertEqual(targets.first?.branch, "main", "The worktree label is more useful than 'project root'")
    }

    func testTargetsAreEmptyWithoutAWorkspace() {
        XCTAssertEqual(CreatePaneForm.targets(in: nil), [])
    }

    func testEachTargetHasAStableDistinctIdentity() {
        let targets = CreatePaneForm.targets(in: workspace)

        XCTAssertEqual(Set(targets.map(\.id)).count, targets.count)
        XCTAssertEqual(
            CreatePaneForm.targets(in: workspace).map(\.id),
            targets.map(\.id),
            "The target list must not reshuffle between openings"
        )
    }

    // MARK: - Defaults

    /// Opening where you already are is the whole point; making someone
    /// re-pick the context in front of them is the usual way this wastes time.
    func testDefaultsToTheWorktreeOfTheFocusedPane() {
        let form = CreatePaneForm.makeDefault(
            workspace: workspace,
            focusedPaneID: "ios-cockpit",
            selectedProjectID: nil
        )

        XCTAssertEqual(form.projectID, "psyche")
        XCTAssertEqual(
            form.cwd,
            "/Users/demo/Code/psyche-build/.worktrees/native-ios-cloud-terminal"
        )
    }

    func testFallsBackToTheSelectedProjectWithoutAFocusedPane() {
        let form = CreatePaneForm.makeDefault(
            workspace: workspace,
            focusedPaneID: nil,
            selectedProjectID: "website"
        )

        XCTAssertEqual(form.projectID, "website")
    }

    func testFallsBackToTheFirstPublishedTargetWithNoContextAtAll() {
        let form = CreatePaneForm.makeDefault(
            workspace: workspace,
            focusedPaneID: nil,
            selectedProjectID: nil
        )

        XCTAssertEqual(form.projectID, "psyche")
        XCTAssertFalse(form.cwd.isEmpty)
    }

    func testAnUnknownFocusedPaneStillYieldsAUsableTarget() {
        let form = CreatePaneForm.makeDefault(
            workspace: workspace,
            focusedPaneID: "%404",
            selectedProjectID: nil
        )

        XCTAssertTrue(form.isValid, "A stale pane id must not leave the form unusable")
    }

    func testWithoutAWorkspaceTheFormIsNotSubmittable() {
        let form = CreatePaneForm.makeDefault(
            workspace: nil,
            focusedPaneID: nil,
            selectedProjectID: nil
        )

        XCTAssertFalse(form.isValid)
    }

    // MARK: - Validation

    func testALaunchNeedsSomewhereToLand() {
        var form = CreatePaneForm()
        XCTAssertFalse(form.isValid)

        form.projectID = "psyche"
        XCTAssertFalse(form.isValid, "A project without a target directory is not enough")

        form.cwd = "/Users/demo/Code/psyche-build"
        XCTAssertTrue(form.isValid)
    }

    /// An agent pane with no prompt is a legitimate thing to want, so the
    /// optional fields stay optional.
    func testOptionalFieldsAreOptionalAndTrimmed() {
        var form = CreatePaneForm()
        form.projectID = "psyche"
        form.cwd = "/Users/demo/Code/psyche-build"
        XCTAssertTrue(form.isValid)
        XCTAssertNil(form.trimmedAgent)
        XCTAssertNil(form.trimmedTitle)
        XCTAssertNil(form.trimmedPrompt)

        form.agent = "  claude  "
        form.title = "  Fix it  "
        form.prompt = "   "
        XCTAssertEqual(form.trimmedAgent, "claude")
        XCTAssertEqual(form.trimmedTitle, "Fix it")
        XCTAssertNil(form.trimmedPrompt, "Whitespace is not a prompt")
    }

    func testDefaultKindIsAgent() {
        XCTAssertEqual(CreatePaneForm().kind, .agent)
    }

    // MARK: - Stop confirmation

    /// Naming what is about to stop is what lets someone notice it is the
    /// wrong pane.
    func testStopConfirmationNamesPaneProjectAndHost() {
        let message = StopPaneConfirmation.message(
            paneTitle: "homepage polish",
            projectTitle: "open-coven.dev",
            hostName: "studio.local"
        )

        XCTAssertTrue(message.contains("homepage polish"), message)
        XCTAssertTrue(message.contains("open-coven.dev"), message)
        XCTAssertTrue(message.contains("studio.local"), message)
        XCTAssertEqual(
            StopPaneConfirmation.title(paneTitle: "homepage polish"),
            "Stop homepage polish?"
        )
    }

    /// Stop keeps the worktree. Saying so is what stops this reading as a
    /// delete.
    func testStopConfirmationSaysTheWorkSurvives() {
        let message = StopPaneConfirmation.message(
            paneTitle: "p",
            projectTitle: "proj",
            hostName: nil
        )

        XCTAssertTrue(message.localizedCaseInsensitiveContains("worktree"), message)
        XCTAssertTrue(message.localizedCaseInsensitiveContains("branch"), message)
        XCTAssertTrue(message.localizedCaseInsensitiveContains("does not delete"), message)
    }

    func testStopConfirmationOmitsAnUnknownHostRatherThanSayingNil() {
        let message = StopPaneConfirmation.message(
            paneTitle: "p",
            projectTitle: "proj",
            hostName: nil
        )

        XCTAssertFalse(message.contains("nil"), message)
        XCTAssertFalse(message.contains(" on ."), message)
    }
}
