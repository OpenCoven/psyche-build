# Vim Slice 4: iOS Keyboard Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement v1 Vim chrome behavior for iOS hardware keyboards and an accessible software Chrome key without changing terminal transport.

**Architecture:** A pure Swift machine mirrors the JSON fixture contract. SwiftUI commands and `CodingKeyRow` normalize into it, while semantic actions reuse AppModel/navigation controls and passthrough remains on `PtyTerminal.sendInput`/`XtermWebView`.

**Tech Stack:** Swift 6, SwiftUI, XCTest/XCUITest, XcodeGen

**Tracking:** Claim `psyche-no8.4` after `psyche-no8.3` closes.

---

### Task 1: Implement Swift conformance and settings

**Files:** Create `native/ios/PsycheCore/Sources/PsycheCore/Vim/{VimTypes,VimChromeMachine,VimFixtures}.swift`, `native/ios/PsycheCore/Tests/PsycheCoreTests/VimChromeMachineTests.swift`; modify `native/ios/project.yml`.

- [ ] Copy the v1 fixture JSON into the PsycheCore test resources through `project.yml`; write RED fixture tests asserting exact context/disposition/pending/actions.
- [ ] Implement Codable enums matching the TypeScript wire names and:

```swift
public mutating func handle(_ key: VimNormalizedKey, now: Duration) -> VimResult
public mutating func reset(_ reason: VimResetReason) -> VimResult
```

- [ ] Use injected monotonic time, the approved 250...3000 ms clamp, and no UIKit/SwiftUI imports in PsycheCore. Run PsycheCore tests GREEN.
- [ ] Add all five `@AppStorage`-backed sanitized opt-in settings in the existing SettingsView ownership, retaining editor-only preferences for portable configuration. Run `pnpm ios:project:check`. Commit: `Add Vim conformance core to iOS`.

### Task 2: Route hardware and software keyboard actions

**Files:** Modify `native/ios/PsycheApp/Sources/PsycheApp/{AppModel.swift,CockpitView.swift}` and `Views/{PaneWorkspaceView,PaneComposer,CodingKeyRow,SettingsView}.swift`; add `UnitTests/VimKeyboardTests.swift` and UI tests.

- [ ] Write RED tests proving F6/Chrome key enter without terminal bytes, Escape exits without bytes, passthrough uses existing `sendInput`, modal/text-field precedence wins, and disappearance restores nearest focus.
- [ ] Add `VimChromeController` as app-window state. Register F6 through SwiftUI keyboard commands; add a `.chrome` control beside terminal keys with identifier `coding-key-chrome`, label `Chrome navigation`, and selected trait while active.
- [ ] Map semantic actions to current pane/project/navigation/guard APIs. Unsupported actions announce status and never call `sendInput`.
- [ ] Add an accessible `CHROME` indicator/pending sequence and reduced-motion focus treatment.
- [ ] Run `pnpm ios:project:generate`, PsycheCore and PsycheApp simulator tests, XCUITest keyboard/accessibility cases, and `git diff --check`. Record physical hardware-keyboard evidence or the explicit gap.
- [ ] Obtain independent reviews; close `psyche-no8.4`. Commit: `Add Vim chrome navigation to iOS`.
