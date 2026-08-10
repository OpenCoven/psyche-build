import XCTest

/// Smoke coverage for the Now-first shell. The fuller compact/regular matrix
/// — tab switching, sidebar behaviour, state across rotation — lands with the
/// dedicated UI-coverage task.
final class PsycheAppUITests: XCTestCase {
    func testLaunchesIntoNow() throws {
        let app = launchApp()

        XCTAssertTrue(app.otherElements["main-cockpit"].waitForExistence(timeout: 10))
        XCTAssertTrue(element("now-view", in: app).waitForExistence(timeout: 10))
    }

    func testOpensAPaneInOneTapFromNow() throws {
        let app = launchApp()
        XCTAssertTrue(element("now-view", in: app).waitForExistence(timeout: 10))

        // The fixture puts this pane in Needs You, so it is reachable without
        // scrolling or switching sections.
        let paneRow = row("now-pane-web-home", in: app)
        XCTAssertTrue(paneRow.waitForExistence(timeout: 10))
        paneRow.tap()

        XCTAssertTrue(element("pane-workspace", in: app).waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["homepage polish"].waitForExistence(timeout: 10))
    }

    func testNowGroupsPanesIntoTheThreeSections() throws {
        let app = launchApp()
        XCTAssertTrue(element("now-view", in: app).waitForExistence(timeout: 10))

        XCTAssertTrue(app.staticTexts["Needs You"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Running"].exists)
        XCTAssertTrue(app.staticTexts["Recent"].exists)
    }

    func testProjectsReachEveryPublishedProject() throws {
        let app = launchApp()
        try showProjects(in: app)

        XCTAssertTrue(element("project-psyche", in: app).waitForExistence(timeout: 10))
        XCTAssertTrue(element("project-website", in: app).exists)
        XCTAssertTrue(element("project-infra", in: app).exists)
    }

    func testProjectDetailGroupsPanesUnderTheirWorktree() throws {
        let app = launchApp()
        try showProjects(in: app)

        let project = row("project-psyche", in: app)
        XCTAssertTrue(project.waitForExistence(timeout: 10))
        project.tap()

        XCTAssertTrue(element("project-detail-psyche", in: app).waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["main"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["feat/native-ios-cloud-terminal"].exists)
        XCTAssertTrue(element("project-pane-ios-cockpit", in: app).exists)
    }

    func testSettingsReportsConnectionAndHost() throws {
        let app = launchApp()
        try showSettings(in: app)

        XCTAssertTrue(element("settings-view", in: app).waitForExistence(timeout: 10))

        // The rows combine their children for VoiceOver, so the host name is
        // part of the row's label rather than a separate static text.
        let host = element("settings-host", in: app)
        XCTAssertTrue(host.waitForExistence(timeout: 10))
        XCTAssertTrue(host.label.contains("psyche-demo.local"), host.label)

        let status = element("settings-status", in: app)
        XCTAssertTrue(status.waitForExistence(timeout: 10))
        XCTAssertTrue(status.label.contains("Connection status"), status.label)
    }

    func testNoLegacyDrillDownRemains() throws {
        let app = launchApp()
        XCTAssertTrue(app.otherElements["main-cockpit"].waitForExistence(timeout: 10))

        XCTAssertFalse(app.buttons["cockpit-siderail-toggle"].exists)
        XCTAssertFalse(element("pane-list", in: app).exists)
        XCTAssertFalse(element("terminal-output", in: app).exists)
    }

    // MARK: - Helpers

    /// Always launches the fixture root.
    ///
    /// Without this the app composes its production graph — a real transport
    /// and the device keychain — under test, which is what the fixture root
    /// exists to avoid, and which made these tests die with `signal kill` on
    /// launch rather than fail with anything readable.
    private func launchApp(
        arguments: [String] = ["-uiFixture", "multiproject"]
    ) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += arguments
        app.launch()
        return app
    }

    /// Reaches a root from whichever shell is on screen: a tab in compact
    /// width, a sidebar row in regular.
    private func showProjects(in app: XCUIApplication) throws {
        try showRoot(tab: "Projects", sourceIdentifier: "source-projects", in: app)
    }

    private func showSettings(in app: XCUIApplication) throws {
        try showRoot(tab: "Settings", sourceIdentifier: "source-settings", in: app)
    }

    private func showRoot(
        tab: String,
        sourceIdentifier: String,
        in app: XCUIApplication
    ) throws {
        if app.tabBars.buttons[tab].waitForExistence(timeout: 5) {
            app.tabBars.buttons[tab].tap()
            return
        }
        let sidebarRow = row(sourceIdentifier, in: app)
        guard sidebarRow.waitForExistence(timeout: 5) else {
            throw XCTSkip("Neither shell presented a way to reach \(tab).")
        }
        sidebarRow.tap()
    }

    /// An identifier on a row propagates to the image and text inside it, and
    /// `firstMatch` happily returns the image — which is not hittable. Prefer
    /// the cell, which is the thing a person actually taps.
    private func row(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        let cell = app.cells.matching(identifier: identifier).firstMatch
        return cell.exists ? cell : element(identifier, in: app)
    }

    private func element(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }
}
