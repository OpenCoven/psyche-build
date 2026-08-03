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
        project.tap()
        XCTAssertTrue(element("pane-list", in: app).waitForExistence(timeout: 5))

        XCTAssertTrue(bridgePane.waitForExistence(timeout: 5))
        XCTAssertTrue(bridgePane.isSelected)
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
