import PsycheCore
import XCTest
@testable import Psyche_Build

final class PaneControlsTests: XCTestCase {
    private let workspace = WorkspaceFixtures.workspace(
        named: WorkspaceFixtures.multiproject
    )

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
}
