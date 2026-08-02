# Native iOS Workflows and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the native iOS coding workflows and prove them safe, accessible, performant, secure, and ready for TestFlight and App Store review.

**Architecture:** Use v3 host actions and the existing scoped Coven bridge as the authority for session, file, diff, merge, PR, and kill work. The iOS app renders structured state and approval challenges, while cloud push is a hint that triggers a host refresh; release evidence combines deterministic unit/UI tests, real tmux-host integration, fault injection, physical-device checks, and privacy/security artifacts.

**Tech Stack:** SwiftUI, SwiftData, XCTest/XCUITest, TypeScript, Vitest, tmux, git, GitHub CLI test fixtures, Cloudflare Queues/APNs, Xcode Instruments, Network Link Conditioner, TestFlight.

---

## File Structure

**Create**

- `native/ios/PsycheCore/Sources/PsycheCore/Domain/CovenStore.swift`, `ReviewStore.swift`, `ApprovalStore.swift`, `NotificationStore.swift`.
- `native/ios/PsycheApp/Sources/PsycheApp/Views/CovenSessionView.swift`, `FilesDiffView.swift`, `ApprovalView.swift`, `FinishWorkflowView.swift`, `NotificationPreferencesView.swift`.
- `native/ios/PsycheCore/Tests/PsycheCoreTests/CovenStoreTests.swift`, `ReviewStoreTests.swift`, `ApprovalStoreTests.swift`, `NotificationStoreTests.swift`.
- `native/ios/PsycheApp/Tests/PsycheAppUITests/ReviewApprovalUITests.swift`, `AccessibilityUITests.swift`, `ReconnectUITests.swift`.
- `__tests__/bridge/WorkflowActions.test.ts`, `__tests__/bridge/NotificationEvents.test.ts`, `__tests__/integration/nativeIosHost.test.ts`.
- `scripts/native-ios-performance.mjs`, `scripts/native-ios-release-check.mjs`.
- `docs/native-ios/TESTFLIGHT-CHECKLIST.md`, `PERFORMANCE-BASELINE.md`, `PRIVACY-AND-SECURITY.md`, `APP-STORE-REVIEW-NOTES.md`, `RELEASE-RUNBOOK.md`.

**Modify**

- `src/services/bridge/UnifiedProtocolGateway.ts` — map Coven, review, action, and notification v3 commands.
- `src/services/bridge/PolicyEngine.ts` — action-specific confirmation text and challenge expiry.
- `src/daemon/bridge.ts` — scoped git status/diff/action dependencies.
- `cloud/psyche-control-plane/src/stores/APNSNotificationSink.ts` — route structured host events without sensitive preview.
- `native/ios/PsycheApp/Sources/PsycheApp/PsycheApp.swift` — deep-link/push refresh and accessibility settings.
- `native/ios/project.yml` — privacy manifest, test targets, and release build settings.
- `README.md` and `docs/PRODUCT-SPEC.md` — supported native feature boundary.

### Task 1: Deliver Coven Sessions and Read-Only Native Files/Diffs

**Files:**
- Create: `native/ios/PsycheCore/Sources/PsycheCore/Domain/CovenStore.swift`
- Create: `native/ios/PsycheCore/Sources/PsycheCore/Domain/ReviewStore.swift`
- Create: `native/ios/PsycheApp/Sources/PsycheApp/Views/CovenSessionView.swift`
- Create: `native/ios/PsycheApp/Sources/PsycheApp/Views/FilesDiffView.swift`
- Create: `native/ios/PsycheCore/Tests/PsycheCoreTests/CovenStoreTests.swift`
- Create: `native/ios/PsycheCore/Tests/PsycheCoreTests/ReviewStoreTests.swift`
- Create: `native/ios/PsycheApp/Tests/PsycheAppUITests/ReviewApprovalUITests.swift`
- Modify: `src/services/bridge/UnifiedProtocolGateway.ts`
- Modify: `src/daemon/bridge.ts`

- [ ] **Step 1: Write failing host and Swift review tests**

```ts
it('returns a scoped truncated diff through the v3 gateway', async () => {
  const response = await gateway.handle(authenticatedSession, gitDiffRequest);
  expect(response).toMatchObject({
    type: 'git.diff.result',
    requestId: gitDiffRequest.requestId,
    payload: { truncated: false, text: 'diff --git' },
  });
});
```

```swift
func testReviewStoreMarksHostDiffAsStaleAfterDisconnect() async {
  let store = ReviewStore(client: FakeReviewClient(diff: .fixture()))
  await store.refresh(projectID: "project-1")
  await store.connectionChanged(to: .offline)
  XCTAssertEqual(store.diff?.freshness, .stale)
}
```

- [ ] **Step 2: Verify failure**

Run:

```sh
pnpm vitest --run __tests__/bridge/WorkflowActions.test.ts
xcodebuild test -project native/ios/Psyche.xcodeproj -scheme PsycheCore -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:PsycheCoreTests/CovenStoreTests -only-testing:PsycheCoreTests/ReviewStoreTests
```

Expected: FAIL because workflow gateway handlers and native stores do not exist.

- [ ] **Step 3: Implement scoped workflow read APIs**

Map v3 `coven.sessions.list`, `coven.sessions.launch`, `coven.sessions.input`,
`coven.sessions.kill`, `files.list`, `files.read`, `git.status`, and `git.diff`
to the host services from the protocol-host plan. Preserve the daemon’s
authoritative Coven project-root validation and `FileService` size/symlink
limits. Return status, attention, changed-file count, test summaries, and
bounded diff/file data; reject native write/edit requests with
`native_editing_unsupported`.

`CovenStore` and `ReviewStore` use opaque host/project/session IDs and retain
only bounded cached summaries. `FilesDiffView` offers directory navigation,
syntax-highlighted read-only content, unified diff rendering, inaccessible
file explanation, and stale labels. It must never show cloud metadata as live
host state.

- [ ] **Step 4: Pass host, core, and UI tests**

Run:

```sh
pnpm vitest --run __tests__/bridge/WorkflowActions.test.ts __tests__/daemon/bridge.test.ts
xcodebuild test -project native/ios/Psyche.xcodeproj -scheme PsycheCore -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:PsycheCoreTests/CovenStoreTests -only-testing:PsycheCoreTests/ReviewStoreTests
xcodebuild test -project native/ios/Psyche.xcodeproj -scheme PsycheApp -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M4)' -only-testing:PsycheAppUITests/ReviewApprovalUITests
```

Expected: PASS; scoped Covens/files/diffs work on iPad and a disconnected
review is visibly stale.

- [ ] **Step 5: Commit review workflow**

```sh
git add src/services/bridge/UnifiedProtocolGateway.ts src/daemon/bridge.ts __tests__/bridge/WorkflowActions.test.ts native/ios/PsycheCore/Sources/PsycheCore/Domain/CovenStore.swift native/ios/PsycheCore/Sources/PsycheCore/Domain/ReviewStore.swift native/ios/PsycheApp/Sources/PsycheApp/Views/CovenSessionView.swift native/ios/PsycheApp/Sources/PsycheApp/Views/FilesDiffView.swift native/ios/PsycheCore/Tests/PsycheCoreTests/CovenStoreTests.swift native/ios/PsycheCore/Tests/PsycheCoreTests/ReviewStoreTests.swift native/ios/PsycheApp/Tests/PsycheAppUITests/ReviewApprovalUITests.swift
git commit -m "feat: add native Coven and diff review workflow" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Add Explicit Approval, Merge, PR, and Finish Flows

**Files:**
- Create: `native/ios/PsycheCore/Sources/PsycheCore/Domain/ApprovalStore.swift`
- Create: `native/ios/PsycheApp/Sources/PsycheApp/Views/ApprovalView.swift`
- Create: `native/ios/PsycheApp/Sources/PsycheApp/Views/FinishWorkflowView.swift`
- Create: `native/ios/PsycheCore/Tests/PsycheCoreTests/ApprovalStoreTests.swift`
- Modify: `src/services/bridge/PolicyEngine.ts`
- Modify: `src/services/bridge/UnifiedProtocolGateway.ts`
- Modify: `__tests__/bridge/WorkflowActions.test.ts`

- [ ] **Step 1: Write failing approval-reconciliation tests**

```ts
it('does not merge until the same device approves an unexpired challenge once', async () => {
  const challenge = await gateway.handle(session, mergeRequest);
  expect(challenge.type).toBe('actions.challenge');
  await gateway.handle(session, approvalFor(challenge.payload.id));
  await expect(gateway.handle(session, approvalFor(challenge.payload.id)))
    .resolves.toMatchObject({ type: 'error', payload: { code: 'challenge_consumed' } });
});
```

```swift
func testUnknownMergeResultRequiresRefreshInsteadOfRetry() async {
  let store = ApprovalStore(client: FakeActionClient(disconnectAfterSend: true))
  await store.submit(.merge(branch: "feature/test"))
  XCTAssertEqual(store.state, .unknown)
  XCTAssertTrue(store.requiresReconciliation)
}
```

- [ ] **Step 2: Verify failure**

Run:

```sh
pnpm vitest --run __tests__/bridge/WorkflowActions.test.ts
xcodebuild test -project native/ios/Psyche.xcodeproj -scheme PsycheCore -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:PsycheCoreTests/ApprovalStoreTests
```

Expected: FAIL because action challenge presentation and reconciliation do not exist.

- [ ] **Step 3: Implement bounded action execution**

For `merge`, `push`, `pull-request`, `kill`, `delete`, `credential-use`, and
`policy-change`, `PolicyEngine` creates a challenge containing action class,
host name, selected project/branch, affected pane/session, requesting device,
expiry, and an idempotency key. `UnifiedProtocolGateway` emits
`actions.challenge`, accepts one matching `actions.approve` or
`actions.reject`, executes through the existing explicit host flow, journals
the final result, and returns a user-actionable error on stale, cross-device,
cross-project, consumed, or expired approval.

`ApprovalStore` exposes the exact action states `queued`, `sent`, `accepted`,
`running`, `succeeded`, `failed`, and `unknown`. `ApprovalView` requires a
clear confirm gesture, supports reject, displays the policy reason and expiry,
and never represents an interrupted request as success. `FinishWorkflowView`
offers Merge, Create PR, Keep branch, and Close terminal; destructive cleanup
is a separate challenged action.

- [ ] **Step 4: Pass approval tests**

Run:

```sh
pnpm vitest --run __tests__/bridge/WorkflowActions.test.ts __tests__/bridge/PolicyEngine.test.ts
xcodebuild test -project native/ios/Psyche.xcodeproj -scheme PsycheCore -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:PsycheCoreTests/ApprovalStoreTests
xcodebuild test -project native/ios/Psyche.xcodeproj -scheme PsycheApp -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:PsycheAppUITests/ReviewApprovalUITests
```

Expected: PASS; every dangerous action is challenged exactly once, and unknown
outcomes require authoritative reconciliation.

- [ ] **Step 5: Commit approval flows**

```sh
git add src/services/bridge/PolicyEngine.ts src/services/bridge/UnifiedProtocolGateway.ts __tests__/bridge/WorkflowActions.test.ts native/ios/PsycheCore/Sources/PsycheCore/Domain/ApprovalStore.swift native/ios/PsycheApp/Sources/PsycheApp/Views/ApprovalView.swift native/ios/PsycheApp/Sources/PsycheApp/Views/FinishWorkflowView.swift native/ios/PsycheCore/Tests/PsycheCoreTests/ApprovalStoreTests.swift
git commit -m "feat: add explicit native approval and finish flows" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Complete Notifications, Background Recovery, and Device Revocation

**Files:**
- Create: `native/ios/PsycheCore/Sources/PsycheCore/Domain/NotificationStore.swift`
- Create: `native/ios/PsycheApp/Sources/PsycheApp/Views/NotificationPreferencesView.swift`
- Create: `native/ios/PsycheCore/Tests/PsycheCoreTests/NotificationStoreTests.swift`
- Create: `native/ios/PsycheApp/Tests/PsycheAppUITests/ReconnectUITests.swift`
- Create: `__tests__/bridge/NotificationEvents.test.ts`
- Modify: `cloud/psyche-control-plane/src/stores/APNSNotificationSink.ts`
- Modify: `native/ios/PsycheApp/Sources/PsycheApp/PsycheApp.swift`

- [ ] **Step 1: Write failing notification privacy and refresh tests**

```ts
it('emits an attention notification intent with no terminal content', async () => {
  const intent = toNotificationIntent({ kind: 'attention', paneId: 'pane-1', summary: 'run tests' });
  expect(intent).toMatchObject({ kind: 'attention' });
  expect(JSON.stringify(intent)).not.toContain('run tests');
});
```

```swift
func testPushOpensAuthoritativeRefreshRatherThanTrustingPushPayload() async {
  let store = NotificationStore(client: FakeNotificationClient())
  await store.handlePush(["eventId": "event-1", "kind": "attention"])
  XCTAssertEqual(store.client.refreshCalls, 1)
}
```

- [ ] **Step 2: Verify failure**

Run:

```sh
pnpm vitest --run __tests__/bridge/NotificationEvents.test.ts
xcodebuild test -project native/ios/Psyche.xcodeproj -scheme PsycheCore -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:PsycheCoreTests/NotificationStoreTests
```

Expected: FAIL because notification conversion and refresh behavior do not exist.

- [ ] **Step 3: Implement hint-only notifications**

Convert journal attention/completion events to account-scoped notification
intents with event ID, opaque host/project/pane/session ID, and generic kind.
`APNSNotificationSink` obeys preferences, deduplicates event IDs, and uses
“Psyche activity — Open Psyche to review.” on the lock screen by default.
Detailed previews require explicit preference opt-in.

Register APNs tokens through the cloud registry, process deep links and push
in `PsycheApp`, then refresh host-authoritative state. On app foreground,
network handoff, or daemon restart, restore subscriptions/cursors before
enabling terminal input. Device revocation clears Keychain credentials,
disconnects transports, wipes protected caches selected by the user, and
renders `.blocked`.

- [ ] **Step 4: Pass notification, reconnect, and revocation tests**

Run:

```sh
pnpm vitest --run __tests__/bridge/NotificationEvents.test.ts
pnpm --dir cloud/psyche-control-plane vitest --run test/notifications.test.ts
xcodebuild test -project native/ios/Psyche.xcodeproj -scheme PsycheCore -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:PsycheCoreTests/NotificationStoreTests
xcodebuild test -project native/ios/Psyche.xcodeproj -scheme PsycheApp -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:PsycheAppUITests/ReconnectUITests
```

Expected: PASS; pushes reveal no content, refresh live data, disconnects
recover safely, and revocation immediately blocks access.

- [ ] **Step 5: Commit notification recovery**

```sh
git add src/services/bridge/UnifiedProtocolGateway.ts __tests__/bridge/NotificationEvents.test.ts cloud/psyche-control-plane/src/stores/APNSNotificationSink.ts native/ios/PsycheCore/Sources/PsycheCore/Domain/NotificationStore.swift native/ios/PsycheApp/Sources/PsycheApp/Views/NotificationPreferencesView.swift native/ios/PsycheCore/Tests/PsycheCoreTests/NotificationStoreTests.swift native/ios/PsycheApp/Tests/PsycheAppUITests/ReconnectUITests.swift native/ios/PsycheApp/Sources/PsycheApp/PsycheApp.swift
git commit -m "feat: add secure native notifications and recovery" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 4: Verify Accessibility, Performance, and Security Budgets

**Files:**
- Create: `native/ios/PsycheApp/Tests/PsycheAppUITests/AccessibilityUITests.swift`
- Create: `__tests__/integration/nativeIosHost.test.ts`
- Create: `scripts/native-ios-performance.mjs`
- Create: `docs/native-ios/PERFORMANCE-BASELINE.md`
- Create: `docs/native-ios/PRIVACY-AND-SECURITY.md`
- Modify: `native/ios/project.yml`

- [ ] **Step 1: Write failing accessibility and attack-path tests**

```swift
func testTerminalControlsExposeVoiceOverLabelsAndHardwareShortcuts() {
  let app = XCUIApplication()
  app.launch()
  XCTAssertTrue(app.buttons["terminal-key-escape"].isAccessibilityElement)
  XCTAssertEqual(app.buttons["terminal-key-escape"].label, "Escape")
  XCTAssertTrue(app.buttons["new-lane-command"].exists)
}
```

```ts
it('rejects cross-project file, approval, and relay frames during a real tmux host session', async () => {
  await expect(scenario.readForeignProjectFile()).rejects.toMatchObject({ code: 'path_outside_scope' });
  await expect(scenario.approveForeignProjectAction()).rejects.toMatchObject({ code: 'project_not_authorized' });
  await expect(scenario.relayForeignProjectFrame()).rejects.toMatchObject({ code: 'project_not_authorized' });
});
```

- [ ] **Step 2: Verify failure**

Run:

```sh
pnpm vitest --run __tests__/integration/nativeIosHost.test.ts
xcodebuild test -project native/ios/Psyche.xcodeproj -scheme PsycheApp -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:PsycheAppUITests/AccessibilityUITests
```

Expected: FAIL because integration evidence, accessibility tests, and baselines do not exist.

- [ ] **Step 3: Add measurable release instrumentation**

Use `XCTClockMetric`, `XCTMemoryMetric`, and `XCTOSSignpostMetric` to record
warm cached-list launch, terminal attach, output burst render, reconnect, and
memory use. `scripts/native-ios-performance.mjs` parses exported XCTest metrics
into `docs/native-ios/PERFORMANCE-BASELINE.md` and fails when warm list exceeds
500 ms, terminal attach p95 exceeds 3 s, short replay exceeds 2 s, input relay
addition p95 exceeds 250 ms, active-terminal memory exceeds 200 MB, or a
render main-thread stall exceeds 100 ms.

Test VoiceOver labels/actions, Dynamic Type chrome, contrast/status labels,
reduced motion, haptic toggle, external keyboard navigation, iPhone portrait/
landscape, iPad three-column layout, and focus mode. Test real tmux with a
fake agent under output burst, host restart, host sleep, relay interruption,
duplicate delivery, stale approval, symlink escape, device revocation, and
malformed frame faults. Document TLS 1.3, pinning, E2EE, Keychain, Data
Protection, retention defaults, redacted diagnostics, threat coverage, and
residual risks.

- [ ] **Step 4: Run performance/security gates**

Run:

```sh
pnpm vitest --run __tests__/integration/nativeIosHost.test.ts __tests__/bridge/FileService.test.ts __tests__/bridge/PolicyEngine.test.ts __tests__/relay/RelayConnector.test.ts
xcodebuild test -project native/ios/Psyche.xcodeproj -scheme PsycheApp -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -only-testing:PsycheAppUITests/AccessibilityUITests
node scripts/native-ios-performance.mjs --result-bundle native/ios/build/PsycheApp.xcresult
```

Expected: PASS; all security scenarios reject safely and the recorded metrics
meet every stated budget.

- [ ] **Step 5: Commit quality gates**

```sh
git add native/ios/PsycheApp/Tests/PsycheAppUITests/AccessibilityUITests.swift __tests__/integration/nativeIosHost.test.ts scripts/native-ios-performance.mjs docs/native-ios/PERFORMANCE-BASELINE.md docs/native-ios/PRIVACY-AND-SECURITY.md native/ios/project.yml
git commit -m "test: add native iOS security accessibility and performance gates" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 5: Produce TestFlight and App Store Release Evidence

**Files:**
- Create: `docs/native-ios/TESTFLIGHT-CHECKLIST.md`
- Create: `docs/native-ios/APP-STORE-REVIEW-NOTES.md`
- Create: `docs/native-ios/RELEASE-RUNBOOK.md`
- Create: `scripts/native-ios-release-check.mjs`
- Modify: `README.md`
- Modify: `docs/PRODUCT-SPEC.md`

- [ ] **Step 1: Write a failing release-evidence check**

```ts
const required = [
  'docs/native-ios/TESTFLIGHT-CHECKLIST.md',
  'docs/native-ios/PERFORMANCE-BASELINE.md',
  'docs/native-ios/PRIVACY-AND-SECURITY.md',
  'docs/native-ios/APP-STORE-REVIEW-NOTES.md',
  'docs/native-ios/RELEASE-RUNBOOK.md',
];
for (const file of required) assert.ok(existsSync(file), `${file} is required for TestFlight`);
```

- [ ] **Step 2: Verify failure**

Run:

```sh
node scripts/native-ios-release-check.mjs
```

Expected: FAIL because release evidence documents and checker do not exist.

- [ ] **Step 3: Write concrete release checklists**

`TESTFLIGHT-CHECKLIST.md` must require recorded success for LAN pairing,
cellular relay behind NAT, lane creation/attention push, five-minute
suspension/resume, ambiguous input reconciliation, diff/PR, immediate
revocation, cross-project/symlink rejection, software keyboard, hardware
keyboard, rotation, and memory pressure on physical iPhone and iPad.

`APP-STORE-REVIEW-NOTES.md` states that the app is a remote terminal control
client; it does not download or execute arbitrary code locally. Include the
local-network reason, account deletion path, generic notification behavior,
data collection disclosure, optional encrypted artifact behavior, and
reproducible reviewer pairing instructions.

`RELEASE-RUNBOOK.md` contains build signing, staged rollout, monitoring,
support diagnostics with redaction, host/cloud rollback, incident response,
credential/device revocation, APNs outage handling, and rollback acceptance
criteria. The checker requires nonempty sections for privacy manifest,
App Store privacy answers, TestFlight feedback contact, and every physical
device scenario.

- [ ] **Step 4: Run the final release gate**

Run:

```sh
pnpm run typecheck
pnpm vitest --run __tests__/integration/nativeIosHost.test.ts __tests__/bridge/WorkflowActions.test.ts __tests__/bridge/NotificationEvents.test.ts
pnpm --dir cloud/psyche-control-plane test
xcodegen generate --spec native/ios/project.yml
xcodebuild test -project native/ios/Psyche.xcodeproj -scheme PsycheCore -destination 'platform=iOS Simulator,name=iPhone 16 Pro'
xcodebuild test -project native/ios/Psyche.xcodeproj -scheme PsycheApp -destination 'platform=iOS Simulator,name=iPhone 16 Pro'
xcodebuild test -project native/ios/Psyche.xcodeproj -scheme PsycheApp -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M4)'
node scripts/native-ios-release-check.mjs
```

Expected: PASS; protocol/host/cloud/iPhone/iPad/release evidence gates all
succeed before uploading a TestFlight build.

- [ ] **Step 5: Commit release artifacts**

```sh
git add docs/native-ios/TESTFLIGHT-CHECKLIST.md docs/native-ios/APP-STORE-REVIEW-NOTES.md docs/native-ios/RELEASE-RUNBOOK.md scripts/native-ios-release-check.mjs README.md docs/PRODUCT-SPEC.md
git commit -m "docs: add native iOS TestFlight release runbook" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Acceptance Gates

- [ ] The full 30-minute remote session creates a lane, survives network handoff and suspension, reviews a diff, and completes an explicit merge or PR without lost input, duplicate action, or scope escape.
- [ ] Coven, files, diffs, approvals, merge/PR, push notifications, and device revocation are covered by deterministic host/core/UI tests.
- [ ] Accessibility and performance gates meet the product targets on iPhone and iPad; physical-device evidence is recorded in the TestFlight checklist.
- [ ] Privacy manifest, App Store disclosures, generic lock-screen push behavior, retention/deletion controls, and redacted diagnostics are reviewed.
- [ ] A TestFlight build is uploaded only after every final command passes and `git status --short` confirms unrelated dirty test files were not staged or modified.
