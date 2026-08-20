# Mobile Ritual Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let mobile users discover and launch only the rituals published by the focused pane's canonical workspace project.

**Architecture:** The host already publishes a bounded, sanitized `rituals` array on each `ProjectSnapshot`. Complete the cross-language contract with a Swift model that defaults missing ritual metadata to an empty array, then feed the focused pane's project rituals into a nested pane-actions menu. Ritual launch uses the existing scoped `rituals.launch` command and requests an authoritative snapshot afterward; fixture launches simulate the same mutation and refresh path.

**Tech Stack:** TypeScript 7, Vitest 4, generated protocol fixtures, Swift 6, SwiftUI, XCTest/XCUITest, XcodeGen.

---

## Starting state

The rebased branch already contains the host-side publication work:

- `src/workspace/snapshot.ts` defines required `ProjectSnapshot.rituals`.
- `src/daemon/workspace.ts` publishes at most 50 entries with only `id`, `displayName`, and optional `description`.
- `__tests__/workspaceSnapshot.test.ts` proves the bound and excludes executable command data.

Do not recreate or weaken that work. The remaining tasks make the required field compile across fixtures, decode safely on iOS, expose the UI, and verify the full flow.

## File responsibilities

- `protocol-fixtures/fixtures.ts`: typed source of truth for the cross-language snapshot example.
- `protocol-fixtures/workspace-snapshot.json`: generated JSON consumed by Swift contract tests.
- `native/ios/PsycheCore/Sources/PsycheCore/Protocol/BridgeMessages.swift`: Swift mirror of canonical workspace snapshot types.
- `native/ios/PsycheCore/Sources/PsycheCore/Fixtures/WorkspaceFixtures.swift`: deterministic project/ritual data for unit and UI tests.
- `native/ios/PsycheApp/Sources/PsycheApp/Views/PaneControls.swift`: project-context resolution and the nested ritual launch menu.
- `native/ios/PsycheApp/Sources/PsycheApp/Views/PaneWorkspaceView.swift`: passes the focused pane's canonical project context into pane controls.
- `native/ios/PsycheCore/Sources/PsycheCore/Fixtures/FixtureControlRequests.swift`: deterministic ritual mutation and full-snapshot responses for `-uiFixture`.
- `native/ios/PsycheApp/Tests/PsycheAppUITests/PsycheAppUITests.swift`: external proof that the menu is scoped, launch refreshes state, and focus is preserved.

### Task 1: Round-trip ritual metadata through protocol fixtures and Swift

**Files:**
- Modify: `protocol-fixtures/fixtures.ts`
- Generate: `protocol-fixtures/workspace-snapshot.json`
- Generate: `protocol-fixtures/mobile-control.json`
- Modify: `__tests__/daemon/workspaceProtocolContract.test.ts`
- Modify: `native/ios/PsycheCore/Sources/PsycheCore/Protocol/BridgeMessages.swift`
- Modify: `native/ios/PsycheCore/Tests/PsycheCoreTests/WireProtocolContractTests.swift`

- [ ] **Step 1: Add failing host fixture assertions**

In `__tests__/daemon/workspaceProtocolContract.test.ts`, extend the first test with:

```ts
expect(response.workspace.projects[0].rituals).toEqual([
  {
    id: 'release-checklist',
    displayName: 'Release checklist',
    description: 'Prepare a release safely.',
  },
]);
expect(JSON.stringify(response.workspace.projects[0].rituals)).not.toContain('command');
```

- [ ] **Step 2: Run the host contract test and verify it fails**

Run:

```bash
pnpm exec vitest run __tests__/daemon/workspaceProtocolContract.test.ts
```

Expected: FAIL because the typed workspace fixture does not yet provide the required `rituals` field.

- [ ] **Step 3: Add ritual metadata to the typed fixture and regenerate JSON**

In `protocol-fixtures/fixtures.ts`, add this field to the project inside `WORKSPACE_SNAPSHOT_FIXTURE`:

```ts
rituals: [
  {
    id: 'release-checklist',
    displayName: 'Release checklist',
    description: 'Prepare a release safely.',
  },
],
```

Generate the checked-in JSON:

```bash
pnpm fixtures:generate
```

Expected: `workspace-snapshot.json` and the workspace-bearing entries in
`mobile-control.json` gain the sorted `rituals` array. Client and legacy server
fixtures remain unchanged.

- [ ] **Step 4: Add the Swift snapshot type and backward-compatible decoder**

In `native/ios/PsycheCore/Sources/PsycheCore/Protocol/BridgeMessages.swift`, add the focused metadata type before `WorkspaceProjectSnapshot`:

```swift
public struct WorkspaceRitualSnapshot: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let displayName: String
    public let description: String?

    public init(id: String, displayName: String, description: String? = nil) {
        self.id = id
        self.displayName = displayName
        self.description = description
    }
}
```

Replace the synthesized-only `WorkspaceProjectSnapshot` declaration with an explicit initializer and missing-field fallback:

```swift
public struct WorkspaceProjectSnapshot: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let root: String
    public let title: String
    public let rituals: [WorkspaceRitualSnapshot]
    public let worktrees: [WorkspaceWorktreeSnapshot]
    public let projectPanes: [WorkspacePaneSnapshot]
    public let runningCount: Int
    public let attentionCount: Int

    public init(
        id: String,
        root: String,
        title: String,
        rituals: [WorkspaceRitualSnapshot] = [],
        worktrees: [WorkspaceWorktreeSnapshot],
        projectPanes: [WorkspacePaneSnapshot],
        runningCount: Int,
        attentionCount: Int
    ) {
        self.id = id
        self.root = root
        self.title = title
        self.rituals = rituals
        self.worktrees = worktrees
        self.projectPanes = projectPanes
        self.runningCount = runningCount
        self.attentionCount = attentionCount
    }

    private enum CodingKeys: String, CodingKey {
        case id, root, title, rituals, worktrees, projectPanes, runningCount, attentionCount
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        root = try container.decode(String.self, forKey: .root)
        title = try container.decode(String.self, forKey: .title)
        rituals = try container.decodeIfPresent(
            [WorkspaceRitualSnapshot].self,
            forKey: .rituals
        ) ?? []
        worktrees = try container.decode([WorkspaceWorktreeSnapshot].self, forKey: .worktrees)
        projectPanes = try container.decode([WorkspacePaneSnapshot].self, forKey: .projectPanes)
        runningCount = try container.decode(Int.self, forKey: .runningCount)
        attentionCount = try container.decode(Int.self, forKey: .attentionCount)
    }
}
```

Do not alter the legacy `Ritual` or `RitualListPayload` types; protocol v2 stays unchanged.

- [ ] **Step 5: Add Swift contract assertions for present and omitted metadata**

In `WireProtocolContractTests.testWorkspaceSnapshotFixtureDecodesAndRoundTrips`, add:

```swift
XCTAssertEqual(
    snapshot.workspace.projects.first?.rituals,
    [
        WorkspaceRitualSnapshot(
            id: "release-checklist",
            displayName: "Release checklist",
            description: "Prepare a release safely."
        )
    ]
)
```

Add a separate compatibility test:

```swift
func testWorkspaceProjectWithoutRitualsDecodesAsEmpty() throws {
    let data = try XCTUnwrap(
        """
        {
          "revision": 1,
          "projects": [
            {
              "id": "project-1",
              "root": "/repo",
              "title": "psyche-build",
              "worktrees": [],
              "projectPanes": [],
              "runningCount": 0,
              "attentionCount": 0
            }
          ]
        }
        """.data(using: .utf8)
    )

    let workspace = try JSONDecoder().decode(WorkspaceSnapshot.self, from: data)

    XCTAssertEqual(workspace.projects.first?.rituals, [])
}
```

- [ ] **Step 6: Run the focused protocol gates**

Run:

```bash
pnpm exec vitest run \
  __tests__/workspaceSnapshot.test.ts \
  __tests__/daemon/workspaceProtocolContract.test.ts \
  __tests__/bridge/wireProtocolContract.test.ts
xcodebuild \
  -project native/ios/Psyche.xcodeproj \
  -scheme PsycheCore \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  -only-testing:PsycheCoreTests/WireProtocolContractTests \
  test
```

Expected: Vitest reports all selected files passing and Xcode reports `** TEST SUCCEEDED **`.

- [ ] **Step 7: Commit the cross-language contract**

```bash
git add \
  protocol-fixtures/fixtures.ts \
  protocol-fixtures/workspace-snapshot.json \
  protocol-fixtures/mobile-control.json \
  __tests__/daemon/workspaceProtocolContract.test.ts \
  native/ios/PsycheCore/Sources/PsycheCore/Protocol/BridgeMessages.swift \
  native/ios/PsycheCore/Tests/PsycheCoreTests/WireProtocolContractTests.swift
git commit -m "feat: round-trip project rituals over v3" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Resolve the focused pane's ritual context and render the menu

**Files:**
- Modify: `native/ios/PsycheCore/Sources/PsycheCore/Fixtures/WorkspaceFixtures.swift`
- Modify: `native/ios/PsycheApp/Sources/PsycheApp/Views/PaneControls.swift`
- Modify: `native/ios/PsycheApp/Sources/PsycheApp/Views/PaneWorkspaceView.swift`
- Create: `native/ios/PsycheApp/UnitTests/PaneControlsTests.swift`

- [ ] **Step 1: Publish one fixture project with rituals**

In `WorkspaceFixtures.multiprojectWorkspace`, add this argument to the `website` project only:

```swift
rituals: [
    WorkspaceRitualSnapshot(
        id: "review-site",
        displayName: "Review site",
        description: "Open a focused website review pane."
    )
],
```

Leave `psyche` and `infra` on the initializer's default empty list so tests can prove the affordance is hidden.

- [ ] **Step 2: Write failing pane-context unit tests**

Create `native/ios/PsycheApp/UnitTests/PaneControlsTests.swift`:

```swift
import PsycheCore
import XCTest
@testable import Psyche_Build

final class PaneControlsTests: XCTestCase {
    private let workspace = WorkspaceFixtures.workspace(
        named: WorkspaceFixtures.multiproject
    )

    func testFocusedPaneUsesItsCanonicalProjectRituals() {
        let context = PaneRitualContext.resolve(
            paneID: "web-home",
            in: workspace
        )

        XCTAssertEqual(context?.projectID, "website")
        XCTAssertEqual(context?.projectTitle, "open-coven.dev")
        XCTAssertEqual(context?.rituals.map(\.id), ["review-site"])
    }

    func testProjectWithoutRitualsPublishesNoActions() {
        let context = PaneRitualContext.resolve(
            paneID: "ios-cockpit",
            in: workspace
        )

        XCTAssertEqual(context?.projectID, "psyche")
        XCTAssertEqual(context?.rituals, [])
    }

    func testUnknownPaneHasNoRitualContext() {
        XCTAssertNil(
            PaneRitualContext.resolve(paneID: "%404", in: workspace)
        )
    }
}
```

- [ ] **Step 3: Run the new unit test and verify it fails**

Run:

```bash
xcodebuild \
  -project native/ios/Psyche.xcodeproj \
  -scheme PsycheApp \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  -only-testing:PsycheAppTests/PaneControlsTests \
  test
```

Expected: FAIL because `PaneRitualContext` does not exist.

- [ ] **Step 4: Add a single testable context resolver**

At the top of `PaneControls.swift`, after the imports, add:

```swift
struct PaneRitualContext: Equatable {
    let projectID: String
    let projectTitle: String
    let rituals: [WorkspaceRitualSnapshot]

    static func resolve(
        paneID: String,
        in workspace: WorkspaceSnapshot?
    ) -> PaneRitualContext? {
        guard let project = workspace?.projects.first(where: { project in
            project.projectPanes.contains { $0.id == paneID }
                || project.worktrees.contains { worktree in
                    worktree.panes.contains { $0.id == paneID }
                }
        }) else {
            return nil
        }

        return PaneRitualContext(
            projectID: project.id,
            projectTitle: project.title,
            rituals: project.rituals
        )
    }
}
```

This is the only pane-to-project resolver for ritual controls; do not duplicate the traversal in the menu.

- [ ] **Step 5: Pass canonical project context from the workspace view**

In `PaneWorkspaceView`, replace the existing `PaneControlsMenu` call with:

```swift
let ritualContext = PaneRitualContext.resolve(
    paneID: pane.id,
    in: store.workspace
)

PaneControlsMenu(
    paneID: pane.id,
    paneTitle: pane.title ?? pane.id,
    projectID: ritualContext?.projectID,
    projectTitle: ritualContext?.projectTitle ?? "this project",
    rituals: ritualContext?.rituals ?? []
)
```

Remove the now-redundant `projectTitle(forPane:)` helper from `PaneWorkspaceView`.

- [ ] **Step 6: Add the nested ritual menu and authoritative refresh**

Extend `PaneControlsMenu` inputs:

```swift
let paneID: String
let paneTitle: String
let projectID: String?
let projectTitle: String
let rituals: [WorkspaceRitualSnapshot]
```

Inside the existing outer `Menu`, place this block after **New pane** and before **Rename**:

```swift
if let projectID, !rituals.isEmpty {
    Menu {
        ForEach(rituals) { ritual in
            Button {
                launch(ritual, inProject: projectID)
            } label: {
                Label(ritual.displayName, systemImage: "sparkles")
            }
            .accessibilityHint(Text(ritual.description ?? ""))
            .accessibilityIdentifier("pane-ritual-\(ritual.id)")
        }
    } label: {
        Label("Rituals", systemImage: "sparkles")
    }
    .disabled(store.isStale || isWorking)
    .accessibilityIdentifier("pane-rituals")
}
```

Add this method beside `rename()` and `stop()`:

```swift
private func launch(
    _ ritual: WorkspaceRitualSnapshot,
    inProject projectID: String
) {
    run {
        try await store.launchRitual(ritual.id, inProject: projectID)
        _ = try await store.requestFullSnapshot()
    }
}
```

Do not assign `primaryPaneID` or `secondaryPaneID`. `WorkspaceStore.accept` already preserves valid selections while reconciling removed panes.

- [ ] **Step 7: Run focused app unit tests**

Run:

```bash
pnpm ios:project:generate
xcodebuild \
  -project native/ios/Psyche.xcodeproj \
  -scheme PsycheApp \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  -only-testing:PsycheAppTests/PaneControlsTests \
  -only-testing:PsycheAppTests/CreatePaneFormTests \
  test
```

Expected: XcodeGen adds `PaneControlsTests.swift` to the app test target and Xcode reports `** TEST SUCCEEDED **`.

- [ ] **Step 8: Commit the scoped ritual menu**

```bash
git add \
  native/ios/PsycheCore/Sources/PsycheCore/Fixtures/WorkspaceFixtures.swift \
  native/ios/PsycheApp/Sources/PsycheApp/Views/PaneControls.swift \
  native/ios/PsycheApp/Sources/PsycheApp/Views/PaneWorkspaceView.swift \
  native/ios/PsycheApp/UnitTests/PaneControlsTests.swift \
  native/ios/Psyche.xcodeproj
git commit -m "feat: add project-scoped mobile ritual menu" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Make fixture ritual launches mutate and refresh canonical state

**Files:**
- Modify: `native/ios/PsycheCore/Sources/PsycheCore/Fixtures/FixtureControlRequests.swift`
- Create: `native/ios/PsycheCore/Tests/PsycheCoreTests/FixtureControlRequestsTests.swift`
- Modify: `native/ios/PsycheApp/Tests/PsycheAppUITests/PsycheAppUITests.swift`

- [ ] **Step 1: Write the failing fixture-control test**

Create `native/ios/PsycheCore/Tests/PsycheCoreTests/FixtureControlRequestsTests.swift`:

```swift
import XCTest
@testable import PsycheCore

final class FixtureControlRequestsTests: XCTestCase {
    func testRitualLaunchPublishesAPaneAndPreservesRitualMetadata() async throws {
        let requests = FixtureControlRequests(
            workspace: WorkspaceFixtures.workspace(
                named: WorkspaceFixtures.multiproject
            )
        )

        let launch = try await requests.send(.launchRitual(
            MobileRitualLaunchRequest(
                requestID: "launch-1",
                projectID: "website",
                ritualID: "review-site",
                params: nil
            )
        ))
        XCTAssertEqual(
            launch,
            .ack(ControlAckResponse(requestID: "launch-1", ok: true))
        )

        let response = try await requests.send(.workspaceSnapshot(
            ControlRequestIDOnly(requestID: "snapshot-1")
        ))
        guard case let .workspaceSnapshot(snapshot) = response else {
            return XCTFail("Expected an authoritative workspace snapshot")
        }

        let website = try XCTUnwrap(
            snapshot.workspace.projects.first { $0.id == "website" }
        )
        XCTAssertEqual(website.rituals.map(\.id), ["review-site"])
        XCTAssertTrue(
            website.worktrees
                .flatMap(\.panes)
                .contains { $0.id == "ritual-review-site" }
        )
    }
}
```

- [ ] **Step 2: Run the fixture test and verify it fails**

Run:

```bash
pnpm ios:project:generate
xcodebuild \
  -project native/ios/Psyche.xcodeproj \
  -scheme PsycheCore \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  -only-testing:PsycheCoreTests/FixtureControlRequestsTests \
  test
```

Expected: FAIL because fixture requests currently ack ritual launch without mutating and do not return `MobileWorkspaceSnapshotResult`.

- [ ] **Step 3: Implement deterministic fixture launch and snapshot responses**

In `FixtureControlRequests.send`, add these cases before the existing mutation cases:

```swift
case .workspaceSnapshot:
    return .workspaceSnapshot(MobileWorkspaceSnapshotResult(
        requestID: requestID,
        sequence: sequence,
        workspace: workspace
    ))

case .launchRitual(let launch):
    guard let project = workspace.projects.first(where: { $0.id == launch.projectID }),
          let ritual = project.rituals.first(where: { $0.id == launch.ritualID })
    else {
        return .ack(ControlAckResponse(requestID: requestID, ok: false))
    }

    apply { workspace in
        Self.insertPane(
            WorkspacePaneSnapshot(
                id: "ritual-\(ritual.id)",
                cwd: project.root,
                title: ritual.displayName,
                kind: "agent",
                agent: "Coven",
                status: "starting",
                needsAttention: false,
                lastActivity: nil,
                recoverability: "recoverable"
            ),
            into: workspace,
            projectID: project.id,
            cwd: project.root
        )
    }
    return .ack(ControlAckResponse(requestID: requestID, ok: true))
```

Update `WorkspaceProjectSnapshot.replacing` so every fixture mutation retains published ritual metadata:

```swift
return WorkspaceProjectSnapshot(
    id: id,
    root: root,
    title: title,
    rituals: rituals,
    worktrees: worktrees,
    projectPanes: projectPanes,
    runningCount: runningCount,
    attentionCount: attentionCount
)
```

- [ ] **Step 4: Run the fixture test and verify it passes**

Run:

```bash
xcodebuild \
  -project native/ios/Psyche.xcodeproj \
  -scheme PsycheCore \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  -only-testing:PsycheCoreTests/FixtureControlRequestsTests \
  test
```

Expected: `** TEST SUCCEEDED **`.

- [ ] **Step 5: Add UI coverage for visibility, launch refresh, and focus preservation**

Add these tests under `// MARK: - Pane commands` in `PsycheAppUITests.swift`:

```swift
func testPaneWithoutPublishedRitualsHidesTheRitualMenu() throws {
    let app = launchApp()
    let paneRow = row("now-pane-ios-cockpit", in: app)
    XCTAssertTrue(paneRow.waitForExistence(timeout: 10))
    paneRow.tap()

    openPaneActions(in: app)

    XCTAssertFalse(
        app.buttons["pane-rituals"].exists,
        "Projects with no published rituals must not show an empty menu"
    )
}

func testLaunchingARitualRefreshesWorkspaceAndPreservesTheCurrentPane() throws {
    let app = launchApp()
    openWebHomePane(in: app)

    openPaneActions(in: app)
    let rituals = app.buttons["pane-rituals"]
    XCTAssertTrue(rituals.waitForExistence(timeout: 10))
    rituals.tap()

    let reviewSite = app.buttons["pane-ritual-review-site"]
    XCTAssertTrue(reviewSite.waitForExistence(timeout: 10))
    reviewSite.tap()

    XCTAssertTrue(
        element("pane-chip-ritual-review-site", in: app)
            .waitForExistence(timeout: 10),
        "The authoritative refresh should publish the ritual-created pane"
    )
    XCTAssertTrue(
        element("pane-workspace-web-home", in: app)
            .waitForExistence(timeout: 10),
        "A valid current pane selection must survive ritual refresh"
    )
}
```

- [ ] **Step 6: Run focused UI tests on iPhone and iPad**

Create the deterministic iPad destination once if it is not already listed:

```bash
xcrun simctl list devices available | grep -F "Psyche iPad Pro 13-inch" || \
  xcrun simctl create \
    "Psyche iPad Pro 13-inch" \
    com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4-8GB \
    com.apple.CoreSimulator.SimRuntime.iOS-18-6
```

Run:

```bash
xcodebuild \
  -project native/ios/Psyche.xcodeproj \
  -scheme PsycheApp \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  -only-testing:PsycheAppUITests/PsycheAppUITests/testPaneWithoutPublishedRitualsHidesTheRitualMenu \
  -only-testing:PsycheAppUITests/PsycheAppUITests/testLaunchingARitualRefreshesWorkspaceAndPreservesTheCurrentPane \
  test
xcodebuild \
  -project native/ios/Psyche.xcodeproj \
  -scheme PsycheApp \
  -destination 'platform=iOS Simulator,name=Psyche iPad Pro 13-inch' \
  -derivedDataPath native/ios/.build-ipad \
  -only-testing:PsycheAppUITests/PsycheAppUITests/testPaneWithoutPublishedRitualsHidesTheRitualMenu \
  -only-testing:PsycheAppUITests/PsycheAppUITests/testLaunchingARitualRefreshesWorkspaceAndPreservesTheCurrentPane \
  test
```

Expected: both destinations report `** TEST SUCCEEDED **`.

- [ ] **Step 7: Commit deterministic fixture and UI coverage**

```bash
git add \
  native/ios/PsycheCore/Sources/PsycheCore/Fixtures/FixtureControlRequests.swift \
  native/ios/PsycheCore/Tests/PsycheCoreTests/FixtureControlRequestsTests.swift \
  native/ios/PsycheApp/Tests/PsycheAppUITests/PsycheAppUITests.swift \
  native/ios/Psyche.xcodeproj
git commit -m "test: cover mobile ritual launch refresh" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 4: Run acceptance gates and close the completed beads

**Files:**
- Modify through Beads CLI: `.beads/interactions.jsonl`

- [ ] **Step 1: Run the targeted TypeScript and type-safety gates**

```bash
pnpm exec vitest run \
  __tests__/workspaceSnapshot.test.ts \
  __tests__/daemon/workspaceProtocolContract.test.ts \
  __tests__/bridge/wireProtocolContract.test.ts \
  __tests__/bridge/mobileControlGateway.test.ts
pnpm typecheck
```

Expected: all selected Vitest suites pass and TypeScript exits 0.

- [ ] **Step 2: Verify generated iOS project state**

```bash
pnpm ios:project:check
git diff --check
```

Expected: both commands exit 0 with no generated-project or whitespace diff.

- [ ] **Step 3: Run full iPhone core/app acceptance**

```bash
xcodebuild \
  -project native/ios/Psyche.xcodeproj \
  -scheme PsycheCore \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  test
xcodebuild \
  -project native/ios/Psyche.xcodeproj \
  -scheme PsycheApp \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  test
```

Expected: both schemes report `** TEST SUCCEEDED **` with zero assertion failures.

- [ ] **Step 4: Run full iPad app acceptance**

```bash
xcodebuild \
  -project native/ios/Psyche.xcodeproj \
  -scheme PsycheApp \
  -destination 'platform=iOS Simulator,name=Psyche iPad Pro 13-inch' \
  -derivedDataPath native/ios/.build-ipad \
  test
```

Expected: `** TEST SUCCEEDED **` with zero assertion failures. Record simulator infrastructure failures separately and rerun only after restoring the simulator; do not weaken assertions.

- [ ] **Step 5: Inspect the final scoped diff**

```bash
git status --short
git diff main...HEAD --stat
git diff main...HEAD -- \
  src/workspace/snapshot.ts \
  src/daemon/workspace.ts \
  protocol-fixtures \
  native/ios/PsycheCore \
  native/ios/PsycheApp
```

Expected: the branch contains only bounded snapshot metadata, Swift contract/fixtures, pane ritual controls, and their tests.

- [ ] **Step 6: Close the discovery task and Phase 6 parent with evidence**

```bash
bd close psyche-i7c.13 --reason "Protocol v3 workspace snapshots now publish bounded project ritual metadata. Mobile pane actions show only the focused project's rituals, launch through the scoped existing command, request authoritative refresh, preserve pane selection, and pass targeted TypeScript, PsycheCore, iPhone, and iPad verification."
bd close psyche-i7c.6 --reason "Pane creation and daily controls are complete end to end: scoped idempotent create, rename, confirmed stop, discoverable project rituals, visible failures, canonical workspace refresh, and targeted host/core/UI acceptance all pass."
bd show psyche-i7c.13 --json
bd show psyche-i7c.6 --json
```

Expected: both bead records report `status: "closed"` and retain the verification reason.

- [ ] **Step 7: Commit tracker closure if it changed tracked state**

```bash
git add .beads/interactions.jsonl
git commit -m "chore: close mobile pane controls beads" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

If `git status --short -- .beads/interactions.jsonl` is empty, skip this commit rather than creating an empty one.
