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
            ).firstMatch.waitForExistence(timeout: 20),
            "Fixture terminal output did not become accessible before the simulator timeout"
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

    func testOpenPaneOffersFileInspection() throws {
        let app = launchApp()
        openWebHomePane(in: app)

        let files = element("pane-files", in: app)
        XCTAssertTrue(files.waitForExistence(timeout: 10))
        XCTAssertTrue(files.isEnabled)
    }

    func testFileBrowserRoutesDeletedFileToNativeDiffWithSpokenSemantics() throws {
        let app = launchApp()
        openWebHomePane(in: app)
        let files = app.buttons["pane-files"]
        XCTAssertTrue(files.waitForExistence(timeout: 10))
        files.tap()

        XCTAssertTrue(element("file-browser", in: app).waitForExistence(timeout: 10))
        let sources = app.buttons["Sources"]
        XCTAssertTrue(sources.waitForExistence(timeout: 10))
        sources.tap()

        let deleted = row("file-Sources/Deleted.swift", in: app)
        XCTAssertTrue(deleted.waitForExistence(timeout: 10))
        XCTAssertTrue(deleted.label.contains("deleted"), deleted.label)
        deleted.tap()

        XCTAssertTrue(element("file-diff", in: app).waitForExistence(timeout: 10))
        let deletion = element("diff-line-1", in: app)
        let addition = element("diff-line-2", in: app)
        XCTAssertTrue(deletion.waitForExistence(timeout: 10))
        XCTAssertEqual(deletion.label, "Deleted: old")
        XCTAssertEqual(addition.label, "Added: new")
    }

    func testFilePreviewShowsTruncationBanner() throws {
        let app = launchApp()
        openWebHomePane(in: app)
        let files = app.buttons["pane-files"]
        XCTAssertTrue(files.waitForExistence(timeout: 10))
        files.tap()

        let sources = app.buttons["Sources"]
        XCTAssertTrue(sources.waitForExistence(timeout: 10))
        sources.tap()
        let file = row("file-Sources/App.swift", in: app)
        XCTAssertTrue(file.waitForExistence(timeout: 10))
        file.tap()

        XCTAssertTrue(
            element("file-preview-truncated", in: app).waitForExistence(timeout: 10)
        )
    }

    func testFileBrowserShowsHostInspectionErrors() throws {
        let app = launchApp(arguments: [
            "-uiFixture", "multiproject", "-uiInspectionFailure",
        ])
        openWebHomePane(in: app)
        let files = app.buttons["pane-files"]
        XCTAssertTrue(files.waitForExistence(timeout: 10))
        files.tap()

        XCTAssertTrue(
            app.staticTexts["Fixture inspection unavailable."].waitForExistence(timeout: 10)
        )
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

    // MARK: - Pane commands

    /// The sheet opens on the context you are already in, so creating a pane
    /// where you are looking takes no picking at all.
    func testCreatingAPaneAddsItToTheWorkspace() throws {
        let app = launchApp()
        openWebHomePane(in: app)

        openPaneActions(in: app)
        app.buttons["New pane"].tap()
        XCTAssertTrue(element("create-pane-sheet", in: app).waitForExistence(timeout: 10))

        let submit = app.buttons["create-pane-submit"]
        XCTAssertTrue(submit.waitForExistence(timeout: 10))
        XCTAssertTrue(submit.isEnabled, "The sheet should open ready to submit")
        submit.tap()

        // The sheet closes only on success, and the fixture host republishes
        // the workspace, so the new pane appears in the switcher.
        XCTAssertTrue(element("create-pane-sheet", in: app).waitForNonExistence(timeout: 10))
        XCTAssertTrue(element("pane-chip-pane-1", in: app).waitForExistence(timeout: 10))
    }

    func testRitualLessProjectsDoNotOfferARitualMenu() throws {
        let app = launchApp()

        let paneRow = row("now-pane-ios-cockpit", in: app)
        XCTAssertTrue(paneRow.waitForExistence(timeout: 10))
        paneRow.tap()
        XCTAssertTrue(element("pane-workspace-ios-cockpit", in: app).waitForExistence(timeout: 10))

        openPaneActions(in: app)

        XCTAssertTrue(app.buttons["pane-new"].waitForExistence(timeout: 10))
        XCTAssertFalse(element("pane-rituals", in: app).exists)
    }

    /// Launching a ritual republishes the workspace, but the pane you were
    /// reading stays selected while the new ritual pane joins the switcher.
    func testLaunchingARitualRefreshesTheWorkspaceWithoutLosingSelection() throws {
        let app = launchApp()
        openWebHomePane(in: app)
        XCTAssertTrue(element("pane-workspace-web-home", in: app).waitForExistence(timeout: 10))

        openPaneActions(in: app)
        let rituals = app.buttons["pane-rituals"]
        XCTAssertTrue(rituals.waitForExistence(timeout: 10))
        rituals.tap()

        let ritual = app.buttons["pane-ritual-review-site"]
        XCTAssertTrue(ritual.waitForExistence(timeout: 10))
        ritual.tap()

        XCTAssertTrue(element("pane-chip-ritual-review-site", in: app).waitForExistence(timeout: 10))
        XCTAssertTrue(element("pane-workspace-web-home", in: app).waitForExistence(timeout: 10))
    }

    func testRenamingAPaneUpdatesWhatTheWorkspaceShows() throws {
        let app = launchApp()
        openWebHomePane(in: app)

        openPaneActions(in: app)
        app.buttons["Rename"].tap()

        // An alert's fields and buttons live in the alert, not the app root.
        let alert = app.alerts.firstMatch
        XCTAssertTrue(alert.waitForExistence(timeout: 10))
        let field = alert.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText(" reviewed")
        alert.buttons["Rename"].tap()

        XCTAssertTrue(
            app.staticTexts["homepage polish reviewed"].waitForExistence(timeout: 10),
            "The workspace should refresh with the new title"
        )
    }

    /// Stopping is confirmed, names what is about to stop, and says the work
    /// survives.
    func testStoppingAPaneIsConfirmedAndRemovesIt() throws {
        let app = launchApp()
        openWebHomePane(in: app)

        openPaneActions(in: app)
        app.buttons["Stop"].tap()

        XCTAssertTrue(app.staticTexts["Stop homepage polish?"].waitForExistence(timeout: 10))
        let message = app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS[c] %@", "worktree")
        ).firstMatch
        XCTAssertTrue(message.waitForExistence(timeout: 10), "The confirmation must say the work survives")

        let dialog = app.sheets.firstMatch.exists ? app.sheets.firstMatch : app.alerts.firstMatch
        XCTAssertTrue(dialog.waitForExistence(timeout: 10))
        dialog.buttons["Stop pane"].tap()

        XCTAssertTrue(
            element("pane-chip-web-home", in: app).waitForNonExistence(timeout: 10),
            "The stopped pane should leave the workspace"
        )
    }

    // MARK: - Split layout and focus

    /// Regular width has room for two terminals, and both must be live rather
    /// than one being a picture of the other.
    func testRegularOpensASecondTerminalBesideTheFirst() throws {
        let app = launchApp()
        try requireRegularWidth(in: app)
        openWebHomePane(in: app)

        splitBeside("ios-cockpit", in: app)

        XCTAssertTrue(element("terminal-pane-web-home", in: app).waitForExistence(timeout: 10))
        XCTAssertTrue(element("terminal-pane-ios-cockpit", in: app).waitForExistence(timeout: 10))
    }

    /// Only one terminal owns the keystrokes, and tapping the other has to
    /// move that ownership — visibly.
    func testFocusMovesToWhicheverTerminalIsTapped() throws {
        let app = launchApp()
        try requireRegularWidth(in: app)
        openWebHomePane(in: app)
        splitBeside("ios-cockpit", in: app)

        let first = element("terminal-pane-web-home", in: app)
        let second = element("terminal-pane-ios-cockpit", in: app)
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        XCTAssertTrue(second.waitForExistence(timeout: 10))
        XCTAssertTrue(first.isSelected, "The pane that was opened should start focused")

        second.tap()

        XCTAssertTrue(
            element("terminal-focus-badge-ios-cockpit", in: app).waitForExistence(timeout: 10)
        )
        XCTAssertFalse(app.otherElements["terminal-focus-badge-web-home"].exists)
    }

    /// The cap is the point: a third terminal replaces one rather than joining.
    func testAThirdPaneReplacesOneOfTheTwoOnScreen() throws {
        let app = launchApp()
        try requireRegularWidth(in: app)
        openWebHomePane(in: app)
        splitBeside("ios-cockpit", in: app)
        XCTAssertTrue(element("terminal-pane-ios-cockpit", in: app).waitForExistence(timeout: 10))

        // Selecting a third pane takes the primary slot.
        let third = row("pane-chip-bridge-protocol", in: app)
        XCTAssertTrue(third.waitForExistence(timeout: 10))
        third.tap()

        XCTAssertTrue(
            element("terminal-pane-bridge-protocol", in: app).waitForExistence(timeout: 10)
        )
        XCTAssertFalse(
            app.otherElements["terminal-pane-web-home"].exists,
            "A third terminal must replace one, not join it"
        )
        XCTAssertEqual(renderedTerminalCount(in: app), 2, "More than two terminals are rendered")
    }

    /// Portrait has no room for two, but the choice is hidden rather than
    /// thrown away, so turning back restores the split.
    func testCompactSplitsInLandscapeAndCollapsesInPortrait() throws {
        defer { XCUIDevice.shared.orientation = .portrait }
        let app = launchApp()
        try requireCompactWidth(in: app)
        openWebHomePane(in: app)

        XCUIDevice.shared.orientation = .landscapeLeft
        try waitForLandscape(app)
        splitBeside("ios-cockpit", in: app)
        XCTAssertTrue(element("terminal-pane-ios-cockpit", in: app).waitForExistence(timeout: 10))
        XCTAssertTrue(element("terminal-pane-web-home", in: app).exists)

        XCUIDevice.shared.orientation = .portrait
        try waitForPortrait(app)

        XCTAssertTrue(element("terminal-pane-web-home", in: app).waitForExistence(timeout: 10))
        XCTAssertEqual(renderedTerminalCount(in: app), 1, "Portrait must show a single terminal")

        XCUIDevice.shared.orientation = .landscapeLeft
        try waitForLandscape(app)

        XCTAssertTrue(
            element("terminal-pane-ios-cockpit", in: app).waitForExistence(timeout: 10),
            "The secondary pane should have been hidden, not discarded"
        )
    }

    func testCompactCollapsedSecondaryChipPromotesThatPane() throws {
        defer { XCUIDevice.shared.orientation = .portrait }
        let app = launchApp()
        try requireCompactWidth(in: app)
        openWebHomePane(in: app)

        XCUIDevice.shared.orientation = .landscapeLeft
        try waitForLandscape(app)
        splitBeside("ios-cockpit", in: app)
        XCTAssertTrue(element("terminal-pane-ios-cockpit", in: app).waitForExistence(timeout: 10))

        XCUIDevice.shared.orientation = .portrait
        try waitForPortrait(app)

        let cockpitChip = row("pane-chip-ios-cockpit", in: app)
        XCTAssertTrue(cockpitChip.waitForExistence(timeout: 10))
        cockpitChip.tap()

        XCTAssertTrue(
            element("terminal-pane-ios-cockpit", in: app).waitForExistence(timeout: 10)
        )
        XCTAssertFalse(
            app.otherElements["terminal-pane-web-home"].exists,
            "Selecting the collapsed secondary should promote it into the single visible slot"
        )
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

    private func openPaneActions(in app: XCUIApplication) {
        let actions = app.buttons["pane-actions"]
        XCTAssertTrue(actions.waitForExistence(timeout: 10))
        actions.tap()
    }

    private func splitBeside(_ paneID: String, in app: XCUIApplication) {
        let split = row("pane-split-\(paneID)", in: app)
        XCTAssertTrue(split.waitForExistence(timeout: 10), "No split control for \(paneID)")
        split.tap()
    }

    /// Counts live terminals, which is how the two-session cap is observed
    /// from outside.
    private func renderedTerminalCount(in app: XCUIApplication) -> Int {
        ["web-home", "ios-cockpit", "bridge-protocol"].filter {
            app.otherElements["terminal-pane-\($0)"].exists
        }.count
    }

    private func waitForPortrait(
        _ app: XCUIApplication,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        let window = app.windows.firstMatch
        let portrait = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in window.frame.height > window.frame.width },
            object: window
        )
        guard XCTWaiter.wait(for: [portrait], timeout: 30) == .completed else {
            XCTFail(
                "Device never returned to portrait within 30s; last frame \(window.frame).",
                file: file,
                line: line
            )
            return
        }
    }

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
