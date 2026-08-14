import PsycheCore
import XCTest
@testable import Psyche_Build

final class ActionSheetPresentationTests: XCTestCase {
    func testSectionOrderKeepsContextBeforeContentAndControls() {
        XCTAssertEqual(
            ActionSheetPresentation.sectionOrder(
                hasScope: true,
                hasConsequence: true,
                hasRelatedFiles: true
            ),
            [.scope, .consequence, .content, .relatedFiles, .controls]
        )
    }

    func testSectionOrderOmitsUnavailableContextWithoutReordering() {
        XCTAssertEqual(
            ActionSheetPresentation.sectionOrder(
                hasScope: false,
                hasConsequence: true,
                hasRelatedFiles: false
            ),
            [.consequence, .content, .controls]
        )
        XCTAssertEqual(
            ActionSheetPresentation.sectionOrder(
                hasScope: true,
                hasConsequence: false,
                hasRelatedFiles: true
            ),
            [.scope, .content, .relatedFiles, .controls]
        )
        XCTAssertEqual(
            ActionSheetPresentation.sectionOrder(
                hasScope: false,
                hasConsequence: false,
                hasRelatedFiles: false
            ),
            [.content, .controls]
        )
    }

    func testOnlyCloseConfirmIsDestructive() {
        for action in PaneAction.allCases {
            let expected: ActionSheetControlRole = action == .close ? .destructive : .normal
            XCTAssertEqual(ActionSheetPresentation.confirmRole(for: action), expected)
        }

        XCTAssertEqual(ActionSheetPresentation.confirmRole(for: .merge), .normal)
        XCTAssertEqual(ActionSheetPresentation.confirmRole(for: .createPR), .normal)
    }

    func testChoiceDangerControlsButtonRole() {
        XCTAssertEqual(
            ActionSheetPresentation.optionRole(
                MobileActionOption(id: "delete", label: "Delete", danger: true)
            ),
            .destructive
        )
        XCTAssertEqual(
            ActionSheetPresentation.optionRole(
                MobileActionOption(id: "keep", label: "Keep", danger: false)
            ),
            .normal
        )
        XCTAssertEqual(
            ActionSheetPresentation.optionRole(
                MobileActionOption(id: "later", label: "Later")
            ),
            .normal
        )
    }

    func testInputLineRangeUsesDefaultsAndClampsBounds() {
        XCTAssertEqual(ActionSheetPresentation.inputLineRange(nil), 1...6)
        XCTAssertEqual(ActionSheetPresentation.inputLineRange(0), 1...1)
        XCTAssertEqual(ActionSheetPresentation.inputLineRange(99), 1...12)
        XCTAssertEqual(ActionSheetPresentation.inputLineRange(8), 1...8)
    }

    func testTerminalStatusesHaveDistinctAccessibleSemantics() {
        let success = ActionSheetPresentation.status(for: .success)
        let info = ActionSheetPresentation.status(for: .info)
        let error = ActionSheetPresentation.status(for: .error)

        XCTAssertEqual(success, ActionSheetStatus(
            label: "Success",
            systemImage: "checkmark.circle.fill",
            tone: .success
        ))
        XCTAssertEqual(info, ActionSheetStatus(
            label: "Information",
            systemImage: "info.circle.fill",
            tone: .info
        ))
        XCTAssertEqual(error, ActionSheetStatus(
            label: "Error",
            systemImage: "exclamationmark.triangle.fill",
            tone: .error
        ))
        XCTAssertEqual(Set([success.label, info.label, error.label]).count, 3)
        XCTAssertEqual(Set([success.systemImage, info.systemImage, error.systemImage]).count, 3)
    }

    func testEveryPaneActionHasReadableLabel() {
        for action in PaneAction.allCases {
            let label = ActionSheetPresentation.actionLabel(for: action)
            XCTAssertFalse(label.isEmpty, "\(action) needs a label")
            XCTAssertFalse(label.contains("_"), "\(action) label should be readable")
        }
    }

    func testDefaultOptionMarkerIsVisibleWithoutChoosingAnOption() {
        let defaultOption = MobileActionOption(
            id: "recommended",
            label: "Recommended",
            isDefault: true
        )
        let normalOption = MobileActionOption(
            id: "manual",
            label: "Manual",
            isDefault: false
        )

        XCTAssertEqual(ActionSheetPresentation.defaultMarker(for: defaultOption), "Default")
        XCTAssertNil(ActionSheetPresentation.defaultMarker(for: normalOption))
        XCTAssertNil(ActionSheetPresentation.defaultMarker(
            for: MobileActionOption(id: "unset", label: "Unset")
        ))
    }

    func testPullRequestPrimaryLabelIsSpecificAndStable() {
        XCTAssertEqual(
            ActionSheetPresentation.primaryInputLabel(for: .createPR),
            "Create Pull Request"
        )
        XCTAssertEqual(ActionSheetPresentation.primaryInputLabel(for: .rename), "Continue")
    }
}
