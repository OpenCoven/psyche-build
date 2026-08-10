import XCTest

/// Shell coverage for the Now-first cockpit.
///
/// Every test launches the fixture root, so nothing here touches the network
/// or the device keychain. Tests that only make sense at one width guard on
/// the window and skip on the other device class rather than quietly asserting
/// something weaker.
final class PsycheAppUITests: XCTestCase {

    // MARK: - Both device classes

    func testLaunchesIntoNow() throws {
        let app = launchApp()

        XCTAssertTrue(app.otherElements["main-cockpit"].waitForExistence(timeout: 10))
        XCTAssertTrue(element("now-view", in: app).waitForExistence(timeout: 10))
    }

    func testNowGroupsPanesIntoTheThreeSections() throws {
        let app = launchApp()
        XCTAssertTrue(element("now-view", in: app).waitForExistence(timeout: 10))

        XCTAssertTrue(app.staticTexts["Needs You"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Running"].exists)
        XCTAssertTrue(app.staticTexts["Recent"].exists)
    }

    func testNoLegacyDrillDownRemains() throws {
        let app = launchApp()
        XCTAssertTrue(app.otherElements["main-cockpit"].waitForExistence(timeout: 10))

        // Narrow queries on purpose. Asking `descendants(matching: .any)` for
        // an identifier that does not exist walks the whole tree three times
        // and turned this into a 100-second test under load.
        XCTAssertFalse(app.buttons["cockpit-siderail-toggle"].exists)
        XCTAssertFalse(app.otherElements["pane-list"].exists)
        XCTAssertFalse(app.otherElements["terminal-output"].exists)
        XCTAssertFalse(app.collectionViews["pane-list"].exists)
    }

    /// The identifiers every other test steers by, asserted in one place.
    ///
    /// Renaming one otherwise scatters failures across the suite and reads as
    /// a product regression instead of a rename.
    func testCoreAccessibilityIdentifiersArePresent() throws {
        let app = launchApp()
        XCTAssertTrue(element("now-view", in: app).waitForExistence(timeout: 10))

        for identifier in ["main-cockpit", "now-view", "now-pane-web-home"] {
            XCTAssertTrue(
                element(identifier, in: app).waitForExistence(timeout: 5),
                "Missing identifier \(identifier)"
            )
        }

        // The shell itself is identified by what it presents rather than by an
        // identifier: SwiftUI does not surface one set on TabView or
        // NavigationSplitView as a queryable element.
        if app.windows.firstMatch.frame.width < 700 {
            XCTAssertTrue(app.tabBars.buttons["Now"].exists)
        } else {
            XCTAssertTrue(element("source-rail", in: app).exists)
        }
    }

    /// The status the fixture publishes is the one the row speaks, so a pane
    /// that needs you says so rather than only looking different.
    func testAttentionPaneIsLabelledAsNeedingYou() throws {
        let app = launchApp()
        let paneRow = row("now-pane-web-home", in: app)
        XCTAssertTrue(paneRow.waitForExistence(timeout: 10))

        let label = paneRow.label
        XCTAssertTrue(label.contains("homepage polish"), label)
        XCTAssertTrue(label.contains("open-coven.dev"), label)
        XCTAssertTrue(label.contains("waiting"), label)
        XCTAssertTrue(label.contains("needs you"), label)
    }

    // MARK: - Terminal workspace

    /// Opening a pane has to show its terminal, not an empty frame. The
    /// fixture client replays canned output so this asserts real content.
    func testOpeningAPaneRendersItsTerminalOutput() throws {
        let app = launchApp()
        openWebHomePane(in: app)

        XCTAssertTrue(element("terminal-pane-web-home", in: app).waitForExistence(timeout: 10))
        XCTAssertTrue(
            app.staticTexts.containing(
                NSPredicate(format: "label CONTAINS[c] %@", "Waiting for review input")
            ).firstMatch.waitForExistence(timeout: 10)
        )
    }

    /// With two terminals possible, "where does my typing go" has to be
    /// answerable without guessing.
    func testTheShownTerminalIsMarkedFocused() throws {
        let app = launchApp()
        openWebHomePane(in: app)

        let terminal = element("terminal-pane-web-home", in: app)
        XCTAssertTrue(terminal.waitForExistence(timeout: 10))
        XCTAssertTrue(
            element("terminal-focus-badge-web-home", in: app).waitForExistence(timeout: 10)
        )
        XCTAssertTrue(terminal.isSelected, "The focused terminal must carry the selected trait")
    }

    /// A pane that is not on screen must not have a terminal behind it — that
    /// would attach a stream nobody is looking at.
    func testHiddenPanesHaveNoTerminalView() throws {
        let app = launchApp()
        openWebHomePane(in: app)
        XCTAssertTrue(element("terminal-pane-web-home", in: app).waitForExistence(timeout: 10))

        XCTAssertFalse(app.otherElements["terminal-pane-ios-cockpit"].exists)
        XCTAssertFalse(app.otherElements["terminal-pane-bridge-protocol"].exists)
    }

    /// The switcher previews panes from the workspace snapshot, so every pane
    /// is reachable without any of them owning a terminal.
    func testPaneSwitcherOffersEveryPaneWithoutRenderingThem() throws {
        let app = launchApp()
        openWebHomePane(in: app)

        XCTAssertTrue(element("pane-switcher", in: app).waitForExistence(timeout: 10))
        XCTAssertTrue(element("pane-chip-ios-cockpit", in: app).waitForExistence(timeout: 10))
        XCTAssertTrue(element("pane-chip-bridge-protocol", in: app).exists)
        XCTAssertFalse(app.otherElements["terminal-pane-ios-cockpit"].exists)
    }

    /// Switching panes swaps which terminal exists rather than adding one.
    func testSwitchingPanesReplacesTheRenderedTerminal() throws {
        let app = launchApp()
        openWebHomePane(in: app)
        XCTAssertTrue(element("terminal-pane-web-home", in: app).waitForExistence(timeout: 10))

        let chip = row("pane-chip-ios-cockpit", in: app)
        XCTAssertTrue(chip.waitForExistence(timeout: 10))
        chip.tap()

        XCTAssertTrue(element("terminal-pane-ios-cockpit", in: app).waitForExistence(timeout: 10))
        XCTAssertFalse(app.otherElements["terminal-pane-web-home"].exists)
    }

    // MARK: - Composer

    func testComposerAndKeyRowAreAvailableOnAnOpenPane() throws {
        let app = launchApp()
        openWebHomePane(in: app)

        XCTAssertTrue(element("pane-composer", in: app).waitForExistence(timeout: 10))
        XCTAssertTrue(element("coding-key-row", in: app).waitForExistence(timeout: 10))
        for key in ["escape", "tab", "control", "alt", "up", "down", "left", "right", "enter"] {
            XCTAssertTrue(
                element("terminal-key-\(key)", in: app).exists,
                "Missing key \(key)"
            )
        }
    }

    func testControlAndAltButtonsExposeTheirArmedState() throws {
        let app = launchApp()
        openWebHomePane(in: app)
        let control = element("terminal-key-control", in: app)
        let alt = element("terminal-key-alt", in: app)
        XCTAssertTrue(control.waitForExistence(timeout: 10))
        XCTAssertTrue(alt.exists)

        control.tap()
        alt.tap()

        XCTAssertTrue(control.isSelected)
        XCTAssertTrue(alt.isSelected)
    }

    /// A half-typed command belongs to the terminal it was meant for. If it
    /// surfaced in another pane it could be sent to the wrong shell.
    func testADraftStaysWithItsOwnPane() throws {
        let app = launchApp()
        openWebHomePane(in: app)

        let field = app.textViews["pane-composer-field"].exists
            ? app.textViews["pane-composer-field"]
            : app.textFields["pane-composer-field"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText("rm -rf build")

        // Switch to another pane: its composer must be empty.
        let other = row("pane-chip-ios-cockpit", in: app)
        XCTAssertTrue(other.waitForExistence(timeout: 10))
        other.tap()
        XCTAssertTrue(element("terminal-pane-ios-cockpit", in: app).waitForExistence(timeout: 10))

        let otherField = app.textViews["pane-composer-field"].exists
            ? app.textViews["pane-composer-field"]
            : app.textFields["pane-composer-field"]
        XCTAssertTrue(otherField.waitForExistence(timeout: 10))
        XCTAssertFalse(
            (otherField.value as? String ?? "").contains("rm -rf build"),
            "A draft leaked into another pane"
        )

        // Back again: the original draft is still there.
        let back = row("pane-chip-web-home", in: app)
        XCTAssertTrue(back.waitForExistence(timeout: 10))
        back.tap()
        XCTAssertTrue(element("terminal-pane-web-home", in: app).waitForExistence(timeout: 10))

        let restored = app.textViews["pane-composer-field"].exists
            ? app.textViews["pane-composer-field"]
            : app.textFields["pane-composer-field"]
        XCTAssertTrue(restored.waitForExistence(timeout: 10))
        XCTAssertTrue(
            (restored.value as? String ?? "").contains("rm -rf build"),
            "The draft did not come back with its pane"
        )
    }

    func testFailedSendShowsAnErrorAndKeepsTheDraft() throws {
        let app = launchApp(arguments: [
            "-uiFixture", "multiproject", "-uiTerminalSendFailure",
        ])
        openWebHomePane(in: app)
        let field = app.textViews["pane-composer-field"].exists
            ? app.textViews["pane-composer-field"]
            : app.textFields["pane-composer-field"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText("preserve this")

        let send = element("pane-composer-send", in: app)
        XCTAssertTrue(send.exists)
        send.tap()

        XCTAssertTrue(element("pane-composer-error", in: app).waitForExistence(timeout: 10))
        XCTAssertTrue(element("pane-composer-error-dismiss", in: app).exists)
        XCTAssertTrue(
            (field.value as? String ?? "").contains("preserve this"),
            "A failed send silently cleared the draft"
        )
    }

    // MARK: - Compact width (iPhone)

    func testCompactOpensANeedsYouPaneFromNowInOneTap() throws {
        let app = launchApp()
        try requireCompactWidth(in: app)
        XCTAssertTrue(app.staticTexts["Needs You"].waitForExistence(timeout: 10))

        let paneRow = row("now-pane-web-home", in: app)
        XCTAssertTrue(paneRow.waitForExistence(timeout: 10))
        paneRow.tap()

        XCTAssertTrue(element("pane-workspace-web-home", in: app).waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["homepage polish"].waitForExistence(timeout: 10))
    }

    func testCompactUsesTabsRatherThanASidebar() throws {
        let app = launchApp()
        try requireCompactWidth(in: app)

        XCTAssertTrue(app.tabBars.buttons["Now"].waitForExistence(timeout: 10))
        XCTAssertFalse(element("source-rail", in: app).exists)
        XCTAssertTrue(app.tabBars.buttons["Projects"].exists)
        XCTAssertTrue(app.tabBars.buttons["Settings"].exists)
    }

    func testCompactTabsReachProjectsAndSettingsAndReturnToNow() throws {
        let app = launchApp()
        try requireCompactWidth(in: app)
        XCTAssertTrue(element("now-view", in: app).waitForExistence(timeout: 10))

        app.tabBars.buttons["Projects"].tap()
        XCTAssertTrue(element("projects-view", in: app).waitForExistence(timeout: 10))

        app.tabBars.buttons["Settings"].tap()
        XCTAssertTrue(element("settings-view", in: app).waitForExistence(timeout: 10))

        app.tabBars.buttons["Now"].tap()
        XCTAssertTrue(element("now-view", in: app).waitForExistence(timeout: 10))
    }

    /// Each tab keeps its own place, so leaving Now and coming back does not
    /// dump you out of the pane you were reading.
    func testCompactReturningToNowKeepsTheOpenPane() throws {
        let app = launchApp()
        try requireCompactWidth(in: app)

        let paneRow = row("now-pane-web-home", in: app)
        XCTAssertTrue(paneRow.waitForExistence(timeout: 10))
        paneRow.tap()
        XCTAssertTrue(element("pane-workspace-web-home", in: app).waitForExistence(timeout: 10))

        app.tabBars.buttons["Projects"].tap()
        XCTAssertTrue(element("projects-view", in: app).waitForExistence(timeout: 10))
        app.tabBars.buttons["Now"].tap()

        XCTAssertTrue(element("pane-workspace-web-home", in: app).waitForExistence(timeout: 10))
    }

    // MARK: - Regular width (iPad)

    func testRegularUsesASidebarRatherThanTabs() throws {
        let app = launchApp()
        try requireRegularWidth(in: app)

        XCTAssertTrue(element("source-rail", in: app).waitForExistence(timeout: 10))
        XCTAssertFalse(app.tabBars.buttons["Projects"].exists)
    }

    func testRegularSidebarOpensProjectDetailThenAPane() throws {
        let app = launchApp()
        try requireRegularWidth(in: app)

        let project = row("source-project-psyche", in: app)
        XCTAssertTrue(project.waitForExistence(timeout: 10))
        project.tap()

        XCTAssertTrue(element("project-detail-psyche", in: app).waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["feat/native-ios-cloud-terminal"].waitForExistence(timeout: 10))

        let pane = row("project-pane-ios-cockpit", in: app)
        XCTAssertTrue(pane.waitForExistence(timeout: 10))
        pane.tap()

        XCTAssertTrue(element("pane-workspace-ios-cockpit", in: app).waitForExistence(timeout: 10))
    }

    func testRegularSidebarReachesTheProjectsOverviewAndSettings() throws {
        let app = launchApp()
        try requireRegularWidth(in: app)

        let overview = row("source-projects", in: app)
        XCTAssertTrue(overview.waitForExistence(timeout: 10))
        overview.tap()
        XCTAssertTrue(element("projects-view", in: app).waitForExistence(timeout: 10))
        XCTAssertTrue(element("project-psyche", in: app).waitForExistence(timeout: 10))

        let settings = row("source-settings", in: app)
        XCTAssertTrue(settings.waitForExistence(timeout: 10))
        settings.tap()
        XCTAssertTrue(element("settings-view", in: app).waitForExistence(timeout: 10))

        let host = element("settings-host", in: app)
        XCTAssertTrue(host.waitForExistence(timeout: 10))
        XCTAssertTrue(host.label.contains("psyche-demo.local"), host.label)
    }

    func testRegularSidebarReturnsToNow() throws {
        let app = launchApp()
        try requireRegularWidth(in: app)

        row("source-settings", in: app).tap()
        XCTAssertTrue(element("settings-view", in: app).waitForExistence(timeout: 10))

        row("source-now", in: app).tap()
        XCTAssertTrue(element("now-view", in: app).waitForExistence(timeout: 10))
    }

    /// Rotation re-runs the layout. The open pane is navigation state, not
    /// layout state, so it has to survive.
    func testRegularKeepsTheOpenPaneAcrossRotation() throws {
        defer { XCUIDevice.shared.orientation = .portrait }
        let app = launchApp()
        try requireRegularWidth(in: app)

        let paneRow = row("now-pane-web-home", in: app)
        XCTAssertTrue(paneRow.waitForExistence(timeout: 10))
        paneRow.tap()
        XCTAssertTrue(element("pane-workspace-web-home", in: app).waitForExistence(timeout: 10))

        XCUIDevice.shared.orientation = .landscapeLeft
        try waitForLandscape(app)

        XCTAssertTrue(element("pane-workspace-web-home", in: app).waitForExistence(timeout: 10))
    }

    // MARK: - Helpers

    /// Reaches the terminal workspace from whichever shell is on screen.
    private func openWebHomePane(in app: XCUIApplication) {
        let paneRow = row("now-pane-web-home", in: app)
        XCTAssertTrue(paneRow.waitForExistence(timeout: 10))
        paneRow.tap()
    }

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

    private func requireCompactWidth(in app: XCUIApplication) throws {
        let window = app.windows.firstMatch
        XCTAssertTrue(window.waitForExistence(timeout: 10))
        if window.frame.width >= 700 {
            throw XCTSkip("Compact shell coverage requires an iPhone simulator.")
        }
    }

    private func requireRegularWidth(in app: XCUIApplication) throws {
        let window = app.windows.firstMatch
        XCTAssertTrue(window.waitForExistence(timeout: 10))
        if window.frame.width < 700 {
            throw XCTSkip("Regular shell coverage requires an iPad simulator.")
        }
    }

    /// Waits for the device to actually be in landscape.
    ///
    /// Setting `XCUIDevice.orientation` requests a rotation, it does not
    /// guarantee one, and this wait has to outlast a loaded machine.
    ///
    /// Deliberately does *not* retry the orientation request. That was tried
    /// before: forcing the first wait to time out showed the device then
    /// stayed portrait through every subsequent attempt, because re-issuing
    /// orientation changes in quick succession wedges the simulator. One
    /// patient wait recovers from a slow rotation; nothing inside the test
    /// recovers from a wedged device, so it is better to fail saying so.
    private func waitForLandscape(
        _ app: XCUIApplication,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        let window = app.windows.firstMatch
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
