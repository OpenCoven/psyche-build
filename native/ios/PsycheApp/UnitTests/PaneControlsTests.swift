import PsycheCore
import XCTest
@testable import Psyche_Build

final class PaneControlsTests: XCTestCase {
    private let workspace = WorkspaceFixtures.workspace(
        named: WorkspaceFixtures.multiproject
    )

    func testToolbarTargetPrefersTheFocusedVisiblePane() {
        let target = PaneWorkspaceToolbarTarget.resolve(
            primaryPaneID: "bridge-protocol",
            secondaryPaneID: "web-home",
            focusedPaneID: "web-home",
            in: workspace
        )

        XCTAssertEqual(target?.paneID, "web-home")
        XCTAssertEqual(target?.paneTitle, "homepage polish")
        XCTAssertEqual(target?.ritualContext?.projectID, "website")
        XCTAssertEqual(target?.ritualContext?.rituals.map(\.id), ["review-site"])
    }

    func testToolbarTargetFallsBackToThePrimaryPane() {
        let target = PaneWorkspaceToolbarTarget.resolve(
            primaryPaneID: "bridge-protocol",
            secondaryPaneID: "web-home",
            focusedPaneID: nil,
            in: workspace
        )

        XCTAssertEqual(target?.paneID, "bridge-protocol")
        XCTAssertEqual(target?.ritualContext?.projectID, "psyche")
    }

    func testFocusedPaneUsesItsCanonicalProjectRituals() {
        let context = PaneRitualContext.resolve(
            paneID: "web-home",
            in: workspace
        )

        XCTAssertEqual(context?.projectID, "website")
        XCTAssertEqual(context?.projectTitle, "open-coven.dev")
        XCTAssertEqual(context?.rituals.map(\.id), ["review-site"])
    }

    func testProjectWithoutRitualsPublishesNoActions() {
        let context = PaneRitualContext.resolve(
            paneID: "ios-cockpit",
            in: workspace
        )

        XCTAssertEqual(context?.projectID, "psyche")
        XCTAssertEqual(context?.rituals, [])
    }

    func testUnknownPaneHasNoRitualContext() {
        XCTAssertNil(
            PaneRitualContext.resolve(paneID: "%404", in: workspace)
        )
    }

    func testRefreshFailurePresentationCallsOutThatTheRitualAlreadyLaunched() {
        let presentation = PaneControlsErrorPresentation(
            RitualLaunchRefreshFailure(
                ritualName: "Review site",
                refreshErrorDescription: WorkspaceStoreError.noControlRequests.localizedDescription
            )
        )

        XCTAssertEqual(presentation.title, "Workspace refresh failed")
        XCTAssertTrue(presentation.message.contains("Review site launched"), presentation.message)
        XCTAssertTrue(
            presentation.message.localizedCaseInsensitiveContains("avoid retrying"),
            presentation.message
        )
        XCTAssertTrue(
            presentation.message.contains(WorkspaceStoreError.noControlRequests.localizedDescription),
            presentation.message
        )
    }

    func testLaunchFailureKeepsTheExistingGenericErrorPresentation() {
        let presentation = PaneControlsErrorPresentation(WorkspaceStoreError.rejected)

        XCTAssertEqual(presentation.title, "That did not work")
        XCTAssertEqual(presentation.message, WorkspaceStoreError.rejected.localizedDescription)
    }
}
