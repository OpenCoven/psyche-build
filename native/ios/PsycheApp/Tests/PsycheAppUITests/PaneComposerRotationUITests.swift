import XCTest
import UIKit

/// Actual layout/composer integration for #538/#539. The fixture graph has no
/// live daemon, network connection, credentials or real terminal commands.
@MainActor
final class PaneComposerRotationUITests: XCTestCase {
    func testHiddenSecondaryCannotOwnComposerAndSplitRetainsItsDraft() throws {
        XCUIDevice.shared.orientation = .portrait
        defer { XCUIDevice.shared.orientation = .portrait }
        let app = XCUIApplication()
        app.launchArguments = ["-uiFixture", "multiproject"]
        app.launch()
        defer { app.terminate() }
        XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 10))
        guard app.windows.firstMatch.frame.width < 700 else {
            throw XCTSkip("Split collapse requires the compact iPhone layout.")
        }

        let row = app.cells.containing(.any, identifier: "now-pane-web-home").firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        row.tap()
        try requireFocus("web-home", in: app)
        let primaryDraft = "primary fixture draft"
        let secondaryDraft = "secondary fixture draft"
        let primaryInput = textInput(in: app)
        primaryInput.tap()
        primaryInput.typeText(primaryDraft)
        try requireValue(primaryDraft, in: app)

        try rotate(.landscapeLeft, app: app, landscape: true)
        let split = element("pane-split-ios-cockpit", in: app)
        try requireHittable(split)
        split.tap()
        XCTAssertTrue(element("terminal-pane-ios-cockpit", in: app).waitForExistence(timeout: 10))
        let secondaryChip = element("pane-chip-ios-cockpit", in: app)
        try requireHittable(secondaryChip)
        secondaryChip.tap()
        try requireFocus("ios-cockpit", in: app)
        let secondaryInput = textInput(in: app)
        secondaryInput.tap()
        secondaryInput.typeText(secondaryDraft)
        try requireValue(secondaryDraft, in: app)
        record(app, name: "secondary-focused-in-split")

        // Stored secondary selection survives, but the rendered pane and
        // composer must both move to primary. Before the fix the hidden
        // secondary remained focused and its draft stayed in this field.
        try rotate(.portrait, app: app, landscape: false)
        XCTAssertTrue(element("terminal-pane-ios-cockpit", in: app).waitForNonExistence(timeout: 10))
        try requireFocus("web-home", in: app)
        try requireValue(primaryDraft, in: app)
        XCTAssertFalse((textInput(in: app).value as? String ?? "").contains(secondaryDraft))
        record(app, name: "collapsed-primary-composer")

        // A successful fixture send clears only the visible primary's draft.
        let send = element("pane-composer-send", in: app)
        try requireHittable(send)
        XCTAssertTrue(send.isEnabled)
        send.tap()
        try requirePredicate("NOT (value CONTAINS %@)", argument: primaryDraft, target: textInput(in: app))

        // Restore the split and prove the hidden pane never lost its draft.
        try rotate(.landscapeLeft, app: app, landscape: true)
        XCTAssertTrue(element("terminal-pane-ios-cockpit", in: app).waitForExistence(timeout: 10))
        let restoredChip = element("pane-chip-ios-cockpit", in: app)
        try requireHittable(restoredChip)
        restoredChip.tap()
        try requireFocus("ios-cockpit", in: app)
        try requireValue(secondaryDraft, in: app)
        record(app, name: "restored-secondary-draft")

        // Selecting the retained secondary from portrait must show it as the
        // primary terminal, not focus the still-hidden terminal in place.
        try rotate(.portrait, app: app, landscape: false)
        try requireFocus("web-home", in: app)
        let hiddenChip = element("pane-chip-ios-cockpit", in: app)
        try requireHittable(hiddenChip)
        hiddenChip.tap()
        XCTAssertTrue(element("pane-workspace-ios-cockpit", in: app).waitForExistence(timeout: 10))
        try requireFocus("ios-cockpit", in: app)
        try requireValue(secondaryDraft, in: app)
        XCTAssertFalse(element("terminal-pane-web-home", in: app).exists)
        record(app, name: "selected-secondary-now-visible")
    }

    private func rotate(_ orientation: UIDeviceOrientation, app: XCUIApplication, landscape: Bool) throws {
        // Request once, then observe the real window rather than sleeping or
        // repeatedly forcing orientation on a busy simulator.
        XCUIDevice.shared.orientation = orientation
        let window = app.windows.firstMatch
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in
                landscape ? window.frame.width > window.frame.height : window.frame.height > window.frame.width
            },
            object: window
        )
        guard XCTWaiter.wait(for: [expectation], timeout: 30) == .completed else {
            record(app, name: "orientation-timeout")
            XCTFail("Requested orientation did not settle; actual window: \(window.frame)")
            throw TestFailure.expectedStateMissing
        }
    }

    private func requireFocus(_ pane: String, in app: XCUIApplication) throws {
        guard element("terminal-focus-badge-\(pane)", in: app).waitForExistence(timeout: 10) else {
            record(app, name: "focus-timeout-\(pane)")
            XCTFail("Rendered pane \(pane) never acquired composer focus")
            throw TestFailure.expectedStateMissing
        }
    }

    private func requireValue(_ value: String, in app: XCUIApplication) throws {
        try requirePredicate("value == %@", argument: value, target: textInput(in: app))
    }

    private func requireHittable(_ target: XCUIElement) throws {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == true AND hittable == true"), object: target
        )
        guard XCTWaiter.wait(for: [expectation], timeout: 10) == .completed else {
            XCTFail("Required fixture control is not hittable: \(target.identifier)")
            throw TestFailure.expectedStateMissing
        }
    }

    private func requirePredicate(_ format: String, argument: String, target: XCUIElement) throws {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: format, argument), object: target)
        guard XCTWaiter.wait(for: [expectation], timeout: 10) == .completed else {
            XCTFail("Composer value did not reach expected state: \(target.value ?? "<nil>")")
            throw TestFailure.expectedStateMissing
        }
    }

    private func textInput(in app: XCUIApplication) -> XCUIElement {
        let view = app.textViews["pane-composer-field"]
        if view.exists || view.waitForExistence(timeout: 1) { return view }
        return app.textFields["pane-composer-field"]
    }

    private func element(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    private func record(_ app: XCUIApplication, name: String) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    private enum TestFailure: Error { case expectedStateMissing }
}
