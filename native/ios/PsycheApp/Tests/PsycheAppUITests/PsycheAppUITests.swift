import XCTest

final class PsycheAppUITests: XCTestCase {
    func testLaunchesMainCockpitWithCollapsedSiderails() {
        let app = launchApp()

        XCTAssertTrue(app.otherElements["main-cockpit"].waitForExistence(timeout: 5))
        XCTAssertTrue(element("terminal-output", in: app).waitForExistence(timeout: 5))
        XCTAssertFalse(element("project-sidebar", in: app).exists)

        let toggle = app.buttons["cockpit-siderail-toggle"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        XCTAssertEqual(toggle.label, "Show siderails")
    }

    func testSiderailToggleRevealsBothNavigationLevelsAndCollapsesAgain() {
        let app = launchApp()

        showProjectSidebar(in: app)
        let project = element("project-psyche", in: app)
        XCTAssertTrue(project.waitForExistence(timeout: 5))
        XCTAssertTrue(project.isSelected)
        project.tap()
        XCTAssertTrue(element("pane-list", in: app).waitForExistence(timeout: 5))

        let initialPane = element("pane-ios-cockpit", in: app)
        XCTAssertTrue(initialPane.waitForExistence(timeout: 5))
        XCTAssertTrue(initialPane.isSelected)

        let bridgePane = element("pane-bridge-protocol", in: app)
        XCTAssertTrue(bridgePane.waitForExistence(timeout: 5))
        bridgePane.tap()

        let toggle = app.buttons["cockpit-siderail-toggle"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        XCTAssertEqual(toggle.label, "Show siderails")
        XCTAssertTrue(element("terminal-output", in: app).exists)
        XCTAssertTrue(app.staticTexts["$ pnpm test wireProtocol"].waitForExistence(timeout: 5))

        showProjectSidebar(in: app)
        XCTAssertTrue(project.waitForExistence(timeout: 5))
        XCTAssertTrue(project.isSelected)
        let panesButton = app.buttons["Panes"]
        XCTAssertTrue(panesButton.waitForExistence(timeout: 5))
        panesButton.tap()
        XCTAssertTrue(element("pane-list", in: app).waitForExistence(timeout: 5))

        XCTAssertTrue(bridgePane.waitForExistence(timeout: 5))
        XCTAssertTrue(bridgePane.isSelected)
    }

    func testSelectingProjectReconcilesPaneSelection() {
        let app = launchApp()

        showProjectSidebar(in: app)
        let websiteProject = element("project-website", in: app)
        XCTAssertTrue(websiteProject.waitForExistence(timeout: 5))
        websiteProject.tap()

        XCTAssertTrue(element("pane-list", in: app).waitForExistence(timeout: 5))
        let websitePane = element("pane-web-home", in: app)
        XCTAssertTrue(websitePane.waitForExistence(timeout: 5))
        XCTAssertTrue(websitePane.isSelected)
        websitePane.tap()

        XCTAssertTrue(element("terminal-output", in: app).waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Waiting for review input…"].waitForExistence(timeout: 5))
    }

    func testRegularWidthSiderailsCollapseAndRestoreTogether() throws {
        XCUIDevice.shared.orientation = .portrait
        let app = launchApp()
        let window = app.windows.firstMatch
        XCTAssertTrue(window.waitForExistence(timeout: 5))
        if window.frame.width < 700 {
            throw XCTSkip("Regular-width siderail coverage requires an iPad simulator.")
        }

        app.terminate()
        XCUIDevice.shared.orientation = .landscapeLeft
        app.launch()
        let landscapeExpectation = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in window.frame.width > window.frame.height },
            object: window
        )
        XCTAssertEqual(XCTWaiter.wait(for: [landscapeExpectation], timeout: 5), .completed)

        let projectSidebar = element("project-sidebar", in: app)
        let paneList = element("pane-list", in: app)
        XCTAssertTrue(projectSidebar.waitForExistence(timeout: 5))
        XCTAssertTrue(paneList.waitForExistence(timeout: 5))

        let toggle = app.buttons["cockpit-siderail-toggle"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        XCTAssertEqual(toggle.label, "Hide siderails")
        toggle.tap()

        XCTAssertTrue(projectSidebar.waitForNonExistence(timeout: 5))
        XCTAssertTrue(paneList.waitForNonExistence(timeout: 5))
        XCTAssertEqual(toggle.label, "Show siderails")
        toggle.tap()

        XCTAssertTrue(projectSidebar.waitForExistence(timeout: 5))
        XCTAssertTrue(paneList.waitForExistence(timeout: 5))
        XCTAssertEqual(toggle.label, "Hide siderails")
    }

    func testPairsHostWithValidSixDigitCode() {
        let app = launchApp()

        showProjectSidebar(in: app)
        XCTAssertTrue(app.buttons["Pair a host"].waitForExistence(timeout: 5))
        app.buttons["Pair a host"].tap()

        let hostField = app.textFields["pair-host-field"]
        let codeField = app.textFields["pair-code-field"]
        XCTAssertTrue(hostField.waitForExistence(timeout: 5))
        codeField.tap()
        codeField.typeText("12345")
        XCTAssertFalse(app.buttons["Pair"].isEnabled)

        codeField.typeText("6")
        XCTAssertFalse(app.buttons["Pair"].isEnabled)
        hostField.tap()
        hostField.typeText("psyche.local")
        XCTAssertTrue(app.buttons["Pair"].isEnabled)
        app.buttons["Pair"].tap()

        XCTAssertTrue(app.staticTexts["Paired with psyche.local"].waitForExistence(timeout: 5))
    }

    private func launchApp() -> XCUIApplication {
        let app = XCUIApplication()
        app.launch()
        return app
    }

    private func showProjectSidebar(in app: XCUIApplication) {
        let toggle = app.buttons["cockpit-siderail-toggle"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        toggle.tap()
        XCTAssertTrue(element("project-sidebar", in: app).waitForExistence(timeout: 5))
    }

    private func element(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)[identifier]
    }
}
