import XCTest

final class PsycheAppUITests: XCTestCase {
    func testLaunchesMainCockpitWithCollapsedSiderails() throws {
        let app = launchApp()
        try requireCompactWidth(in: app)

        XCTAssertTrue(app.otherElements["main-cockpit"].waitForExistence(timeout: 5))
        XCTAssertTrue(element("terminal-output", in: app).waitForExistence(timeout: 5))
        XCTAssertFalse(element("project-sidebar", in: app).exists)

        let toggle = app.buttons["cockpit-siderail-toggle"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        XCTAssertEqual(toggle.label, "Show siderails")

        let window = app.windows.firstMatch
        let cockpit = app.otherElements["main-cockpit"]
        let terminal = element("terminal-output", in: app)
        XCTAssertTrue(window.waitForExistence(timeout: 5))
        XCTAssertTrue(cockpit.waitForExistence(timeout: 5))
        XCTAssertTrue(terminal.waitForExistence(timeout: 5))

        let windowFrame = window.frame
        let cockpitFrame = cockpit.frame
        let terminalFrame = terminal.frame
        let frames = "window \(windowFrame), cockpit \(cockpitFrame), terminal \(terminalFrame)"
        XCTAssertLessThanOrEqual(abs(cockpitFrame.minY - windowFrame.minY), 1, frames)
        XCTAssertLessThanOrEqual(abs(cockpitFrame.maxY - windowFrame.maxY), 1, frames)
        let remainingContentHeight = cockpitFrame.maxY - terminalFrame.minY
        XCTAssertGreaterThan(terminalFrame.height, remainingContentHeight * 0.5, frames)
    }

    /// The reveal direction was covered; this covers the return trip.
    ///
    /// The neighbouring test reads as though it collapses again, but it walks
    /// forward through the columns and stops at the pane list — so a toggle that
    /// could only ever reveal still passed. Tapping it from each siderail is what
    /// actually pins the control down as two-way.
    func testSiderailToggleReturnsToDetailFromEitherNavigationLevel() throws {
        let app = launchApp()
        try requireCompactWidth(in: app)

        showProjectSidebar(in: app)
        let sidebarToggle = app.buttons["cockpit-siderail-toggle"]
        XCTAssertTrue(sidebarToggle.waitForExistence(timeout: 5))
        XCTAssertEqual(sidebarToggle.label, "Hide siderails")
        sidebarToggle.tap()
        XCTAssertTrue(element("terminal-output", in: app).waitForExistence(timeout: 5))
        XCTAssertFalse(element("project-sidebar", in: app).exists)

        // One level deeper: the pane list must offer the same way back.
        showProjectSidebar(in: app)
        let panesButton = app.buttons["Panes"]
        XCTAssertTrue(panesButton.waitForExistence(timeout: 5))
        panesButton.tap()
        XCTAssertTrue(element("pane-list", in: app).waitForExistence(timeout: 5))

        let paneListToggle = app.buttons["cockpit-siderail-toggle"]
        XCTAssertTrue(paneListToggle.waitForExistence(timeout: 5))
        paneListToggle.tap()
        XCTAssertTrue(element("terminal-output", in: app).waitForExistence(timeout: 5))
        XCTAssertFalse(element("pane-list", in: app).exists)
    }

    func testSiderailToggleRevealsBothNavigationLevelsAndCollapsesAgain() throws {
        let app = launchApp()
        try requireCompactWidth(in: app)

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

    func testSelectingProjectReconcilesPaneSelection() throws {
        let app = launchApp()
        try requireCompactWidth(in: app)

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
        defer { XCUIDevice.shared.orientation = .portrait }
        XCUIDevice.shared.orientation = .portrait
        let app = launchApp()
        try requireRegularWidth(in: app)

        app.terminate()
        XCUIDevice.shared.orientation = .landscapeLeft
        app.launch()
        rotateToLandscape(app)

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

    func testEmptyProjectShowsNoPaneDetailAtRegularWidth() throws {
        defer { XCUIDevice.shared.orientation = .portrait }
        XCUIDevice.shared.orientation = .portrait
        let app = launchApp()
        try requireRegularWidth(in: app)

        app.terminate()
        XCUIDevice.shared.orientation = .landscapeLeft
        app.launch()
        rotateToLandscape(app)

        let infraProject = element("project-infra", in: app)
        XCTAssertTrue(infraProject.waitForExistence(timeout: 5))
        infraProject.tap()

        XCTAssertTrue(element("no-pane-detail", in: app).waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["No pane selected"].exists)
        XCTAssertFalse(element("terminal-output", in: app).exists)
    }

    func testPairsHostWithValidSixDigitCode() throws {
        let app = launchApp()
        try requireCompactWidth(in: app)

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

    /// Always launches the fixture root.
    ///
    /// Without this the app composes its production graph — a real transport
    /// and the device keychain — under test, which is what the fixture root
    /// exists to avoid. It also made four of these tests die with `signal
    /// kill` on launch rather than fail with anything readable.
    private func launchApp(arguments: [String] = ["-uiFixture", "multiproject"]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += arguments
        app.launch()
        return app
    }

    private func requireCompactWidth(in app: XCUIApplication) throws {
        let window = app.windows.firstMatch
        XCTAssertTrue(window.waitForExistence(timeout: 5))
        if window.frame.width >= 700 {
            throw XCTSkip("Compact siderail coverage requires an iPhone simulator.")
        }
    }

    /// Waits for the device to actually be in landscape.
    ///
    /// Setting `XCUIDevice.orientation` requests a rotation, it does not
    /// guarantee one, and both regular-width tests failed repeatedly against
    /// code that was fine because the original 5s wait was too short under
    /// load. This waits longer and says what went wrong when it still fails.
    ///
    /// Deliberately does *not* retry the orientation request. That was tried:
    /// forcing the first wait to time out showed the device then stayed
    /// portrait through every subsequent attempt, because re-issuing
    /// orientation changes in quick succession wedges the simulator — the same
    /// wedge that originally needed a reboot to clear. One patient wait
    /// recovers from a slow rotation; nothing inside the test recovers from a
    /// wedged device, so it is better to fail saying so.
    private func rotateToLandscape(
        _ app: XCUIApplication,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let window = app.windows.firstMatch
        // Callers reach here straight after a cold relaunch, where the window
        // may not exist yet and reports a zero frame. Zero is not landscape, so
        // without this the wait below would spend its full 30s and then blame
        // the rotation for what was really a window that never appeared.
        guard window.waitForExistence(timeout: 15) else {
            XCTFail(
                "No window appeared within 15s of launch, so rotation was never attempted.",
                file: file,
                line: line
            )
            return
        }
        let landscape = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in window.frame.width > window.frame.height },
            object: window
        )
        guard XCTWaiter.wait(for: [landscape], timeout: 30) == .completed else {
            XCTFail(
                "Device never entered landscape within 30s; last frame \(window.frame). "
                    + "This is a simulator-state failure rather than a product failure — "
                    + "reboot the simulator (xcrun simctl shutdown/boot) and re-run.",
                file: file,
                line: line
            )
            return
        }
    }

    private func requireRegularWidth(in app: XCUIApplication) throws {
        let window = app.windows.firstMatch
        XCTAssertTrue(window.waitForExistence(timeout: 5))
        if window.frame.width < 700 {
            throw XCTSkip("Regular-width siderail coverage requires an iPad simulator.")
        }
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
