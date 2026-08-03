# iOS Full-Height Cockpit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the native iOS cockpit and terminal consume the full safe-area height, with terminal output expanding into the available vertical space.

**Architecture:** Keep the existing `NavigationSplitView` and `TerminalDetail` composition. Add flexible maximum-height frames at the cockpit and detail boundaries, and let the terminal output `ScrollView` absorb remaining space while fixed chrome retains intrinsic height.

**Tech Stack:** Swift 6, SwiftUI, XCTest/XCUITest, XcodeGen, `xcodebuild`

---

## File Structure

- Modify `native/ios/PsycheApp/Sources/PsycheApp/CockpitView.swift` to make the cockpit, terminal detail, and terminal output explicitly flexible in the vertical axis.
- Modify `native/ios/PsycheApp/Tests/PsycheAppUITests/PsycheAppUITests.swift` to assert the cockpit and terminal output occupy the iPhone window height without relying on a device-specific fixed pixel size.

### Task 1: Expand the Cockpit to Full Height

**Files:**
- Modify: `native/ios/PsycheApp/Tests/PsycheAppUITests/PsycheAppUITests.swift`
- Modify: `native/ios/PsycheApp/Sources/PsycheApp/CockpitView.swift:11-53,255-282`

- [ ] **Step 1: Add a failing full-height UI assertion**

Extend `testLaunchesMainCockpitWithCollapsedSiderails` after the existing toggle
assertions:

```swift
let window = app.windows.firstMatch
let cockpit = app.otherElements["main-cockpit"]
let terminal = element("terminal-output", in: app)
XCTAssertTrue(window.waitForExistence(timeout: 5))
XCTAssertTrue(cockpit.waitForExistence(timeout: 5))
XCTAssertTrue(terminal.waitForExistence(timeout: 5))

XCTAssertLessThanOrEqual(abs(cockpit.frame.minY - window.frame.minY), 1)
XCTAssertLessThanOrEqual(abs(cockpit.frame.maxY - window.frame.maxY), 1)
XCTAssertGreaterThan(terminal.frame.height, window.frame.height * 0.5)
```

The frame comparisons prove the root cockpit fills the window, while the
relative terminal assertion avoids hard-coding a device height.

- [ ] **Step 2: Run the focused test to verify the current layout fails**

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

Expected: FAIL on at least one frame assertion because the current views do
not explicitly claim the full vertical proposal.

- [ ] **Step 3: Make the cockpit accept the full container height**

Add the flexible frame immediately after the `NavigationSplitView` closure and
before `.tint`:

```swift
}
.frame(maxWidth: .infinity, maxHeight: .infinity)
.tint(PsycheTheme.mint)
```

This makes the split-view root expand without bypassing safe areas.

- [ ] **Step 4: Make terminal output absorb remaining height**

Add a flexible frame to the terminal output `ScrollView` before its background:

```swift
ScrollView {
    LazyVStack(alignment: .leading, spacing: 5) {
        ForEach(Array(pane.output.enumerated()), id: \.offset) { _, line in
            Text(line.isEmpty ? " " : line)
                .font(.system(.footnote, design: .monospaced))
                .foregroundStyle(line.hasPrefix("✓") ? PsycheTheme.mint : PsycheTheme.terminalText)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    .padding(18)
}
.frame(maxWidth: .infinity, maxHeight: .infinity)
.background(PsycheTheme.terminal)
```

Add the same flexible boundary to the enclosing terminal detail after its
background:

```swift
}
.background(PsycheTheme.background)
.frame(maxWidth: .infinity, maxHeight: .infinity)
```

The header and coding-key row retain their intrinsic heights because only the
middle `ScrollView` receives the flexible remaining space.

- [ ] **Step 5: Run the focused compact test**

Run:

```sh
cd native/ios
xcodebuild \
  -project Psyche.xcodeproj \
  -scheme PsycheApp \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath .build \
  -only-testing:PsycheAppUITests/PsycheAppUITests/testLaunchesMainCockpitWithCollapsedSiderails \
  test
```

Expected: PASS; the cockpit frame matches the app window and terminal output
uses more than half of the available height.

- [ ] **Step 6: Run complete iPhone and iPad schemes**

Run:

```sh
cd native/ios
xcodebuild \
  -project Psyche.xcodeproj \
  -scheme PsycheApp \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath .build \
  test

xcodebuild \
  -project Psyche.xcodeproj \
  -scheme PsycheApp \
  -destination 'platform=iOS Simulator,id=104E9408-B20F-45BE-B9D7-F315D9364AF9' \
  -derivedDataPath .build-ipad \
  test
```

Expected: PASS with zero failures on both devices. Width-specific tests may
report their existing expected skips.

- [ ] **Step 7: Commit**

```sh
git add \
  native/ios/PsycheApp/Sources/PsycheApp/CockpitView.swift \
  native/ios/PsycheApp/Tests/PsycheAppUITests/PsycheAppUITests.swift
git commit -m "fix: expand the iOS cockpit height" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```
