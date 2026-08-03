# iOS Collapsible Siderails Implementation Plan

> **For agentic workers:** Implement this plan task-by-task and keep progress tracked with checkbox (`- [ ]`) syntax.

**Goal:** Make the Projects and Panes rails collapse together so an iPhone terminal opens at full width and can restore navigation from one accessible toolbar control.

**Architecture:** Keep the existing three-column `NavigationSplitView` and bind it to local visibility and preferred-compact-column state in `CockpitView`. Initialize compact-width devices to the detail column, initialize regular-width devices to `.all`, and expose navigation through one toolbar control — carried by every column that can be on screen in compact width, so it collapses as well as reveals — without changing project, pane, or connection state.

**Tech Stack:** Swift 6, SwiftUI, XCTest/XCUITest, XcodeGen, `xcodebuild`

---

## File Structure

- Modify `native/ios/PsycheApp/Sources/PsycheApp/CockpitView.swift` to own split-view visibility, apply the device-width default, expose the toolbar toggle, and identify the two rail views for UI automation.
- Modify `native/ios/PsycheApp/Tests/PsycheAppUITests/PsycheAppUITests.swift` to cover the compact launch state, reveal both navigation levels, collapse back to terminal-only mode, and preserve pairing access.

### Task 1: Add Compact Siderail Behavior

**Files:**
- Modify: `native/ios/PsycheApp/Tests/PsycheAppUITests/PsycheAppUITests.swift`
- Modify: `native/ios/PsycheApp/Sources/PsycheApp/CockpitView.swift:4-69`

- [ ] **Step 1: Write the failing compact-layout UI test**

Replace `PsycheAppUITests` with the following test structure. The helper uses
the custom toggle instead of relying on whichever automatic split-view back
button a simulator version happens to expose.

```swift
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
        XCTAssertTrue(app.buttons["Panes"].waitForExistence(timeout: 5))
        app.buttons["Panes"].tap()
        XCTAssertTrue(element("pane-list", in: app).waitForExistence(timeout: 5))

        app.staticTexts["native-ios-cloud-terminal"].tap()
        let toggle = app.buttons["cockpit-siderail-toggle"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        XCTAssertEqual(toggle.label, "Show siderails")
        XCTAssertTrue(element("terminal-output", in: app).exists)
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
```

- [ ] **Step 2: Regenerate the project and run the new test to verify it fails**

Run:

```sh
cd native/ios
xcodegen generate
xcodebuild \
  -project Psyche.xcodeproj \
  -scheme PsycheApp \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath .build \
  -only-testing:PsycheAppUITests/PsycheAppUITests/testLaunchesMainCockpitWithCollapsedSiderails \
  test
```

Expected: FAIL because `cockpit-siderail-toggle` and `project-sidebar` do not
exist and the current split view does not explicitly prefer the detail column.

- [ ] **Step 3: Bind the native split view to local visibility state**

At the top of `CockpitView`, add the size-class environment value, split-view
state, and one-time initialization flag:

```swift
struct CockpitView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @EnvironmentObject private var store: DemoStore
    @State private var columnVisibility: NavigationSplitViewVisibility = .detailOnly
    @State private var preferredCompactColumn: NavigationSplitViewColumn = .detail
    @State private var didApplyInitialColumnVisibility = false
```

Change the split-view declaration and detail column to:

```swift
NavigationSplitView(
    columnVisibility: $columnVisibility,
    preferredCompactColumn: $preferredCompactColumn
) {
    projectSidebar
        .navigationTitle("Psyche")
} content: {
    paneList
        .navigationTitle("Panes")
} detail: {
    TerminalDetail(pane: store.selectedPane)
        .navigationTitle(store.selectedPane.snapshot.displayName)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button(action: toggleSiderails) {
                    Image(systemName: "sidebar.left")
                }
                .accessibilityLabel(
                    preferredCompactColumn == .detail ? "Show siderails" : "Hide siderails"
                )
                .accessibilityIdentifier("cockpit-siderail-toggle")
            }
        }
}
```

After the existing `.sheet` modifier, apply the initial visibility once:

```swift
.onAppear {
    guard !didApplyInitialColumnVisibility else { return }
    columnVisibility = horizontalSizeClass == .regular ? .all : .detailOnly
    didApplyInitialColumnVisibility = true
}
```

Add the toggle method inside `CockpitView`:

```swift
private func toggleSiderails() {
    if horizontalSizeClass == .compact {
        preferredCompactColumn = preferredCompactColumn == .detail ? .sidebar : .detail
    } else {
        columnVisibility = columnVisibility == .detailOnly ? .all : .detailOnly
    }
}
```

This keeps compact devices terminal-first and gives SwiftUI an explicit compact
navigation destination while preserving the current three-column default on
regular-width iPads. SwiftUI updates `preferredCompactColumn` to `.detail` when
the user selects a pane, so the button label returns to "Show siderails".

- [ ] **Step 4: Add stable identifiers to both navigation rails**

Add the identifier after the project list's existing `.listStyle(.sidebar)`:

```swift
.listStyle(.sidebar)
.accessibilityIdentifier("project-sidebar")
```

Add the identifier after the pane list's existing `.overlay`:

```swift
.overlay {
    if store.panes(for: store.selectedProjectID).isEmpty {
        ContentUnavailableView("No panes", systemImage: "rectangle.stack")
    }
}
.accessibilityIdentifier("pane-list")
```

- [ ] **Step 5: Run the focused UI coverage**

Run:

```sh
cd native/ios
xcodegen generate
xcodebuild \
  -project Psyche.xcodeproj \
  -scheme PsycheApp \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath .build \
  -only-testing:PsycheAppUITests/PsycheAppUITests/testLaunchesMainCockpitWithCollapsedSiderails \
  -only-testing:PsycheAppUITests/PsycheAppUITests/testSiderailToggleRevealsBothNavigationLevelsAndCollapsesAgain \
  -only-testing:PsycheAppUITests/PsycheAppUITests/testPairsHostWithValidSixDigitCode \
  test
```

Expected: PASS. The initial terminal is visible, the project and pane rails are
reachable through the toggle and native compact navigation, selecting a pane
returns to the detail column, and pairing remains reachable.

- [ ] **Step 6: Run the complete iOS app test scheme**

Run:

```sh
cd native/ios
xcodebuild \
  -project Psyche.xcodeproj \
  -scheme PsycheApp \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath .build \
  test
```

Expected: PASS for `PsycheCoreTests` and `PsycheAppUITests`.

- [ ] **Step 7: Commit the implementation**

```sh
git add \
  native/ios/PsycheApp/Sources/PsycheApp/CockpitView.swift \
  native/ios/PsycheApp/Tests/PsycheAppUITests/PsycheAppUITests.swift
git commit -m "fix: collapse iOS cockpit siderails" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```
