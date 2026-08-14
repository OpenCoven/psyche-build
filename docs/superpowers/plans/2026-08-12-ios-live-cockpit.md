# iOS Live Cockpit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate the existing Psyche iOS app for live same-LAN pairing, durable bounded multipane summaries, and deliberate pane management.

**Architecture:** Extend the existing authenticated bridge rather than adding a service: Bonjour supplies a validated locator and pinned fingerprint, `ConnectionManager` owns the awaitable pairing lifecycle, and the sequenced workspace snapshot remains the only durable mobile state. Summaries are normalized on the host from existing pane metadata, decoded as optional Swift fields for backward compatibility, and rendered through the existing Now/Projects/PaneWorkspace views. Existing mutation commands remain single-pane and receive stale-state guards.

**Tech Stack:** TypeScript 7, Vitest, Node TLS WebSocket/Bonjour bridge, Swift 6, SwiftUI, Network.framework, URLSession WebSocket, Keychain, XCTest/XCUITest, XcodeGen.

---

## File Responsibility Map

- `src/services/bridge/BridgeBonjour.ts`: advertise the host locator with the existing protocol, identity, and certificate metadata.
- `src/services/bridge/wireProtocol.ts`: keep bridge wire contracts bounded and backward-compatible.
- `src/workspace/snapshot.ts`: define the authoritative optional summary envelope.
- `src/workspace/tuiSnapshot.ts`: normalize pane metadata into safe summary snapshots.
- `src/index.ts`: continue supplying live `PsychePane` metadata to the workspace provider.
- `native/ios/PsycheCore/.../BonjourHostDiscovery.swift`: validate Bonjour identity and locator fields into a connectable `HostEndpoint`.
- `native/ios/PsycheCore/.../ConnectionManager.swift`: expose an awaitable, generation-safe pairing result and persist accepted identity.
- `native/ios/PsycheCore/.../BridgeMessages.swift`: decode the optional summary envelope and endpoint data.
- `native/ios/PsycheCore/.../WorkspaceStore.swift`: make summaries available to Now and reject mutations from stale state.
- `native/ios/PsycheApp/.../PairHostModel.swift`: own discovery, selection, manual fallback, pairing progress, and retryable errors.
- `native/ios/PsycheApp/.../PairHostSheet.swift`: render the real pairing states.
- `native/ios/PsycheApp/.../SettingsView.swift`: compose live pairing from `AppModel` without networking in fixture mode.
- `native/ios/PsycheApp/.../NowView.swift`: render concise summary and freshness context.
- `native/ios/PsycheApp/.../PaneAccessibility.swift`: include each summary once in VoiceOver output.
- `native/ios/PsycheApp/.../PaneControls.swift`: disable management while stale and preserve explicit confirmations.

## Task 1: Resolve a Connectable Bonjour Host

**Files:**
- Create: `native/ios/PsycheCore/Sources/PsycheCore/Pairing/BonjourServiceResolver.swift`
- Modify: `native/ios/PsycheCore/Sources/PsycheCore/Pairing/BonjourHostDiscovery.swift`
- Test: `native/ios/PsycheCore/Tests/PsycheCoreTests/BonjourHostDiscoveryTests.swift`

- [ ] **Step 1: Write failing Swift service-resolution tests**

Keep TXT parsing responsible only for identity/protocol metadata, then inject a
resolver that supplies the service's actual host and port:

```swift
let resolver = FakeBonjourServiceResolver(endpoint: .init(
    host: "studio.local",
    port: 47_123
))
let discovery = BonjourHostDiscovery(browser: browser, resolver: resolver)
let hosts = await firstBatch(from: await discovery.start())
XCTAssertEqual(hosts.first?.endpoint.host, "studio.local")
XCTAssertEqual(hosts.first?.endpoint.port, 47_123)
```

- [ ] **Step 2: Run the discovery test and confirm RED**

Run:

```bash
xcodebuild -project native/ios/Psyche.xcodeproj -scheme PsycheCore \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  -only-testing:PsycheCoreTests/BonjourHostDiscoveryTests test
```

Expected: compile failure because discovery has no resolver and
`DiscoveredHost` has no endpoint.

- [ ] **Step 3: Add an injectable Bonjour service resolver**

Define a small resolver contract:

```swift
public struct ResolvedBonjourEndpoint: Sendable, Equatable {
    public let host: String
    public let port: Int
}

public protocol BonjourServiceResolving: Sendable {
    func resolve(name: String, domain: String) async throws
        -> ResolvedBonjourEndpoint
}
```

Implement the live resolver with `NetService`, one delegate per request, a
bounded timeout, cancellation cleanup, normalized host name, and strict
`1...65535` port validation. It resolves the existing `_psyche._tcp` service;
the host advertisement and TXT fields remain unchanged.

- [ ] **Step 4: Add resolved endpoint and failure coverage**

Add `endpoint: HostEndpoint` to `DiscoveredHost`, composed from the resolved
locator and TXT certificate fingerprint. Cover resolver timeout/failure,
whitespace/empty hosts, zero/negative/out-of-range ports, deduplication, and a
batch where one malicious/unresolvable service does not hide valid hosts.

```swift
XCTAssertEqual(host.endpoint, HostEndpoint(
    host: "studio.local",
    port: 47_123,
    certificateFingerprint: fingerprint
))
```

- [ ] **Step 5: Run the full discovery test file**

Run:

```bash
xcodebuild -project native/ios/Psyche.xcodeproj -scheme PsycheCore \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  -only-testing:PsycheCoreTests/BonjourHostDiscoveryTests test
```

Expected: pass with no leaked delegate, timer, or continuation.

- [ ] **Step 6: Verify the host advertisement contract remains unchanged**

Run:

```bash
pnpm vitest --run __tests__/bridge/BridgeDaemon.test.ts
```

Expected: pass without adding host/port TXT fields. The service record itself
continues carrying the bound port through Bonjour resolution.

- [ ] **Step 7: Verify and commit**

```bash
git diff --check
git add native/ios/PsycheCore/Sources/PsycheCore/Pairing/BonjourServiceResolver.swift \
  native/ios/PsycheCore/Sources/PsycheCore/Pairing/BonjourHostDiscovery.swift \
  native/ios/PsycheCore/Tests/PsycheCoreTests/BonjourHostDiscoveryTests.swift
git diff --cached --check
git commit -S -m "feat(ios): resolve connectable Psyche hosts"
```

## Task 2: Make Pairing Awaitable and Generation-Safe

**Files:**
- Modify: `native/ios/PsycheCore/Sources/PsycheCore/Connection/ConnectionManager.swift`
- Modify: `native/ios/PsycheCore/Sources/PsycheCore/Connection/MobileAppComposition.swift`
- Modify: `native/ios/PsycheCore/Sources/PsycheCore/Pairing/PairedHostStore.swift`
- Test: `native/ios/PsycheCore/Tests/PsycheCoreTests/ConnectionManagerTests.swift`
- Test: `native/ios/PsycheCore/Tests/PsycheCoreTests/PairedHostStoreTests.swift`

- [ ] **Step 1: Write failing accepted/rejected pairing tests**

Specify an async API that returns the accepted host and throws precise errors:

```swift
async let result = composition.connectionManager.pair(code: "123456")
await fake.emit(.legacy(.pairAccepted(PairAcceptedPayload(token: "paired-token"))))
let host = try await result
XCTAssertEqual(host.token, "paired-token")
```

Add cases for rejected, expired, exhausted, disconnect-before-result,
superseded connection generation, and duplicate concurrent attempts.

- [ ] **Step 2: Run the focused ConnectionManager tests and confirm RED**

```bash
xcodebuild -project native/ios/Psyche.xcodeproj -scheme PsycheCore \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  -only-testing:PsycheCoreTests/ConnectionManagerTests test
```

Expected: compile failure because `pair(code:)` returns `Void` and does not
surface rejection.

- [ ] **Step 3: Add a single generation-bound pairing waiter**

Introduce explicit errors and a waiter owned by the active connection:

```swift
public enum PairingError: Error, Sendable, Equatable, LocalizedError {
    case notConnected
    case alreadyInProgress
    case rejected(String)
    case connectionChanged
}
```

Change `pair(code:)` to `async throws -> PairedHost`. The waiter must be
registered before sending, completed by `pairAccepted`/`pairRejected`, and
failed exactly once during teardown, cancellation, or generation replacement.

- [ ] **Step 4: Persist accepted hosts through the explicit re-pair path**

Add a generation-checked `replace(_:for:)` to `PairedHostStore`. Use it only
after an accepted pairing handshake so an intentionally re-paired server ID can
replace its certificate. Ordinary reconnect/token refresh continues using
`save` and must reject identity drift.

- [ ] **Step 5: Make accepted pairing request an authoritative snapshot**

After persistence and token installation, complete the waiter with the stored
host and invoke the existing initial snapshot request. A late accepted message
from an invalid generation must neither persist nor resolve the current waiter.

- [ ] **Step 6: Run ConnectionManager and PairedHostStore tests**

```bash
xcodebuild -project native/ios/Psyche.xcodeproj -scheme PsycheCore \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  -only-testing:PsycheCoreTests/ConnectionManagerTests \
  -only-testing:PsycheCoreTests/PairedHostStoreTests test
```

Expected: pass with no leaked continuations or concurrency warnings.

- [ ] **Step 7: Verify and commit**

```bash
git diff --check
git add native/ios/PsycheCore/Sources/PsycheCore/Connection/ConnectionManager.swift \
  native/ios/PsycheCore/Sources/PsycheCore/Connection/MobileAppComposition.swift \
  native/ios/PsycheCore/Sources/PsycheCore/Pairing/PairedHostStore.swift \
  native/ios/PsycheCore/Tests/PsycheCoreTests/ConnectionManagerTests.swift \
  native/ios/PsycheCore/Tests/PsycheCoreTests/PairedHostStoreTests.swift
git diff --cached --check
git commit -S -m "feat(ios): complete live host pairing"
```

## Task 3: Replace the Demo Pair Sheet with Live Discovery

**Files:**
- Create: `native/ios/PsycheApp/Sources/PsycheApp/PairHostModel.swift`
- Modify: `native/ios/PsycheApp/Sources/PsycheApp/Views/PairHostSheet.swift`
- Modify: `native/ios/PsycheApp/Sources/PsycheApp/Views/SettingsView.swift`
- Modify: `native/ios/PsycheApp/Sources/PsycheApp/AppModel.swift`
- Test: `native/ios/PsycheApp/UnitTests/PairHostModelTests.swift`
- Test: `native/ios/PsycheApp/UnitTests/AppModelTests.swift`
- Test: `native/ios/PsycheApp/Tests/PsycheAppUITests/PsycheAppUITests.swift`

- [ ] **Step 1: Write failing PairHostModel state tests**

Define observable states and dependency injection:

```swift
enum PairHostPhase: Equatable {
    case discovering
    case ready
    case connecting
    case awaitingCode
    case pairing
    case paired(String)
    case failed(String)
}
```

Tests must prove discovery start/stop, stable host ordering, selection,
successful pair, invalid six-digit input, retry after rejection, manual endpoint
validation, and cancellation preventing late success.

- [ ] **Step 2: Run PairHostModelTests and confirm RED**

```bash
xcodebuild -project native/ios/Psyche.xcodeproj -scheme PsycheApp \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  -only-testing:PsycheAppTests/PairHostModelTests test
```

Expected: compile failure because `PairHostModel` does not exist.

- [ ] **Step 3: Implement the minimal model**

Use one `@MainActor ObservableObject` with injected discovery, connection
manager, and paired-host store. Selecting a discovered host uses its validated
endpoint. Manual fallback requires host, port, and full normalized SHA-256
fingerprint; it never silently trusts an unpinned self-signed certificate.

- [ ] **Step 4: Write failing SwiftUI contract tests**

Assert the sheet includes:

- discovered-host list;
- manual connection disclosure;
- six-digit code only after an endpoint is selected;
- progress and retryable error text;
- no demo-only success copy;
- Done only after the pairing result returns.

- [ ] **Step 5: Replace PairHostSheet and Settings composition**

Render directly from `PairHostModel`. `AppModel` exposes a factory only in live
composition; fixture mode remains network-incapable. On success, set the host
name from the returned `PairedHost` and let the shared connection manager own
the live workspace.

- [ ] **Step 6: Run app unit and pairing UI tests**

```bash
xcodebuild -project native/ios/Psyche.xcodeproj -scheme PsycheApp \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  -only-testing:PsycheAppTests/PairHostModelTests \
  -only-testing:PsycheAppTests/AppModelTests \
  -only-testing:PsycheAppUITests/PsycheAppUITests test
```

Expected: pass; fixture tests make no network or Keychain calls.

- [ ] **Step 7: Regenerate the deterministic Xcode project**

```bash
pnpm ios:project:generate
pnpm ios:project:check
```

Expected: the generated project includes `PairHostModel.swift` and the new test,
then a second generation produces no diff.

- [ ] **Step 8: Verify and commit**

```bash
git diff --check
git add native/ios/project.yml native/ios/Psyche.xcodeproj \
  native/ios/PsycheApp/Sources/PsycheApp/PairHostModel.swift \
  native/ios/PsycheApp/Sources/PsycheApp/Views/PairHostSheet.swift \
  native/ios/PsycheApp/Sources/PsycheApp/Views/SettingsView.swift \
  native/ios/PsycheApp/Sources/PsycheApp/AppModel.swift \
  native/ios/PsycheApp/UnitTests/PairHostModelTests.swift \
  native/ios/PsycheApp/UnitTests/AppModelTests.swift \
  native/ios/PsycheApp/Tests/PsycheAppUITests/PsycheAppUITests.swift
git diff --cached --check
git commit -S -m "feat(ios): activate the host pairing sheet"
```

## Task 4: Publish Bounded Summaries in Workspace Snapshots

**Files:**
- Modify: `src/workspace/snapshot.ts`
- Modify: `src/workspace/tuiSnapshot.ts`
- Modify: `src/types.ts`
- Modify: `protocol-fixtures/workspace-snapshot.json`
- Modify: `protocol-fixtures/fixtures.ts`
- Test: `__tests__/workspaceSnapshot.test.ts`
- Test: `__tests__/workspaceTuiSnapshot.test.ts`
- Test: `__tests__/daemon/workspaceProtocolContract.test.ts`

- [ ] **Step 1: Write failing normalization tests**

Cover whitespace collapse, empty omission, Unicode-safe 280-code-point bound,
idle/waiting publication, working/analyzing clearing, timestamp normalization,
and `needsResponse`:

```ts
expect(snapshot.projects[0].worktrees[0].panes[0].summary).toEqual({
  text: 'Implemented pairing and needs approval.',
  updatedAt: '2026-08-12T12:00:00.000Z',
  state: 'waiting',
  needsResponse: true,
});
```

- [ ] **Step 2: Run workspace tests and confirm RED**

```bash
pnpm vitest --run __tests__/workspaceSnapshot.test.ts \
  __tests__/workspaceTuiSnapshot.test.ts \
  __tests__/daemon/workspaceProtocolContract.test.ts
```

Expected: type/assertion failure because pane snapshots do not contain summary.

- [ ] **Step 3: Add the summary contract and pure normalizer**

Define:

```ts
export interface PaneSummarySnapshot {
  text: string;
  updatedAt: string;
  state: 'working' | 'waiting' | 'idle' | 'failed' | 'unknown';
  needsResponse: boolean;
}
```

Export a pure `normalizePaneSummary` used by `projectPanes`. Use `Array.from`
for code-point-safe truncation, never terminal capture, and omit the field when
the pane state or content makes it invalid.

- [ ] **Step 4: Regenerate and inspect protocol fixtures**

```bash
pnpm fixtures:generate
git diff -- protocol-fixtures
```

Expected: only intentional optional summary fixture changes; no transcript or
environment material.

- [ ] **Step 5: Run the focused TypeScript tests and typecheck**

```bash
pnpm vitest --run __tests__/workspaceSnapshot.test.ts \
  __tests__/workspaceTuiSnapshot.test.ts \
  __tests__/daemon/workspaceProtocolContract.test.ts
pnpm typecheck
```

Expected: pass.

- [ ] **Step 6: Verify and commit**

```bash
git diff --check
git add src/workspace/snapshot.ts src/workspace/tuiSnapshot.ts src/types.ts \
  protocol-fixtures/workspace-snapshot.json protocol-fixtures/fixtures.ts \
  __tests__/workspaceSnapshot.test.ts __tests__/workspaceTuiSnapshot.test.ts \
  __tests__/daemon/workspaceProtocolContract.test.ts
git diff --cached --check
git commit -S -m "feat: publish bounded pane summaries"
```

## Task 5: Decode and Render Multipane Summaries on iOS

**Files:**
- Modify: `native/ios/PsycheCore/Sources/PsycheCore/Protocol/BridgeMessages.swift`
- Modify: `native/ios/PsycheCore/Sources/PsycheCore/State/NowItem.swift`
- Modify: `native/ios/PsycheCore/Sources/PsycheCore/State/WorkspaceStore.swift`
- Modify: `native/ios/PsycheCore/Sources/PsycheCore/Fixtures/WorkspaceFixtures.swift`
- Modify: `native/ios/PsycheApp/Sources/PsycheApp/Views/NowView.swift`
- Modify: `native/ios/PsycheApp/Sources/PsycheApp/Views/ProjectsView.swift`
- Modify: `native/ios/PsycheApp/Sources/PsycheApp/Views/PaneAccessibility.swift`
- Test: `native/ios/PsycheCore/Tests/PsycheCoreTests/BridgeMessagesTests.swift`
- Test: `native/ios/PsycheCore/Tests/PsycheCoreTests/WorkspaceStoreTests.swift`
- Test: `native/ios/PsycheApp/UnitTests/PaneAccessibilityTests.swift`
- Test: `native/ios/PsycheApp/Tests/PsycheAppUITests/PsycheAppUITests.swift`

- [ ] **Step 1: Write failing Swift decode/store tests**

Add `WorkspacePaneSummarySnapshot` with optional decoding on
`WorkspacePaneSnapshot`. Prove old fixtures decode without it, new fixtures
preserve it, sequence gaps do not apply late summaries, and authoritative
snapshots replace optimistic/old summaries.

- [ ] **Step 2: Run the core tests and confirm RED**

```bash
xcodebuild -project native/ios/Psyche.xcodeproj -scheme PsycheCore \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  -only-testing:PsycheCoreTests/BridgeMessagesTests \
  -only-testing:PsycheCoreTests/WorkspaceStoreTests test
```

Expected: compile failure for missing summary models.

- [ ] **Step 3: Implement optional decode and NowItem propagation**

Keep summary optional at every boundary. `NowItem` receives summary text,
summary time, and `needsResponse`; ordering remains based on authoritative pane
status/activity rather than summary wording.

- [ ] **Step 4: Write failing UI and accessibility tests**

Assert a summary renders at two lines maximum, freshness is visible, stale state
does not present it as live, and VoiceOver includes the summary exactly once.

- [ ] **Step 5: Render summaries in Now and project pane rows**

Use existing typography and spacing. Do not add dashboard cards. Prefer the
summary over the generic context line when present, then show project/agent/
status as secondary context.

- [ ] **Step 6: Run core, app-unit, and focused UI tests**

```bash
xcodebuild -project native/ios/Psyche.xcodeproj -scheme PsycheApp \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  -only-testing:PsycheCoreTests/BridgeMessagesTests \
  -only-testing:PsycheCoreTests/WorkspaceStoreTests \
  -only-testing:PsycheAppTests/PaneAccessibilityTests \
  -only-testing:PsycheAppUITests/PsycheAppUITests test
```

Expected: pass.

- [ ] **Step 7: Verify and commit**

```bash
git diff --check
git add native/ios/PsycheCore native/ios/PsycheApp
git diff --cached --check
git commit -S -m "feat(ios): show multipane summaries"
```

## Task 6: Harden Phone Management Against Stale State

**Files:**
- Modify: `native/ios/PsycheCore/Sources/PsycheCore/State/WorkspaceStore.swift`
- Modify: `native/ios/PsycheApp/Sources/PsycheApp/Views/PaneControls.swift`
- Modify: `native/ios/PsycheApp/Sources/PsycheApp/Views/CreatePaneSheet.swift`
- Modify: `native/ios/PsycheApp/Sources/PsycheApp/Views/PaneComposer.swift`
- Test: `native/ios/PsycheCore/Tests/PsycheCoreTests/WorkspaceStoreCommandsTests.swift`
- Test: `native/ios/PsycheApp/UnitTests/PaneComposerTests.swift`
- Test: `native/ios/PsycheApp/UnitTests/CreatePaneFormTests.swift`
- Test: `native/ios/PsycheApp/Tests/PsycheAppUITests/PsycheAppUITests.swift`

- [ ] **Step 1: Write failing stale-command tests**

For create, rename, stop, and ritual launch, mark the store stale and assert no
request is sent:

```swift
await XCTAssertThrowsErrorAsync {
    try await store.stopPane("pane-1")
} verify: { error in
    XCTAssertEqual(error as? WorkspaceStoreError, .staleWorkspace)
}
XCTAssertTrue(await requests.sentRequests.isEmpty)
```

- [ ] **Step 2: Run command tests and confirm RED**

```bash
xcodebuild -project native/ios/Psyche.xcodeproj -scheme PsycheCore \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  -only-testing:PsycheCoreTests/WorkspaceStoreCommandsTests test
```

Expected: failures because core mutation methods do not reject stale state.

- [ ] **Step 3: Add the core stale guard**

Add `.staleWorkspace` and call one `requireFreshWorkspace()` before request ID
allocation in every management method. This prevents even an attempted command
from appearing in request logs during stale state.

- [ ] **Step 4: Add UI-state tests**

Assert pane actions, create submission, and composer input are disabled with a
visible “Reconnecting…” or last-known-state explanation while stale, then
reenable after an authoritative snapshot.

- [ ] **Step 5: Apply consistent stale-state UI**

Disable the action menu with `isWorking || store.isStale`. Preserve stop's
destructive confirmation and existing failure alerts. Do not add batch merge,
cleanup, or deletion actions.

- [ ] **Step 6: Run management core/app tests**

```bash
xcodebuild -project native/ios/Psyche.xcodeproj -scheme PsycheApp \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build \
  -only-testing:PsycheCoreTests/WorkspaceStoreCommandsTests \
  -only-testing:PsycheAppTests/PaneComposerTests \
  -only-testing:PsycheAppTests/CreatePaneFormTests \
  -only-testing:PsycheAppUITests/PsycheAppUITests test
```

Expected: pass.

- [ ] **Step 7: Verify and commit**

```bash
git diff --check
git add native/ios/PsycheCore/Sources/PsycheCore/State/WorkspaceStore.swift \
  native/ios/PsycheApp/Sources/PsycheApp/Views/PaneControls.swift \
  native/ios/PsycheApp/Sources/PsycheApp/Views/CreatePaneSheet.swift \
  native/ios/PsycheApp/Sources/PsycheApp/Views/PaneComposer.swift \
  native/ios/PsycheCore/Tests/PsycheCoreTests/WorkspaceStoreCommandsTests.swift \
  native/ios/PsycheApp/UnitTests/PaneComposerTests.swift \
  native/ios/PsycheApp/UnitTests/CreatePaneFormTests.swift \
  native/ios/PsycheApp/Tests/PsycheAppUITests/PsycheAppUITests.swift
git diff --cached --check
git commit -S -m "fix(ios): block stale pane management"
```

## Task 7: Full Verification and Live Acceptance

**Files:**
- Modify only if evidence requires: `native/ios/README.md`
- Modify only if evidence requires: `docs/SMOKE.md`

- [ ] **Step 1: Confirm fixed HEAD, clean worktree, and signed commits**

```bash
git status --short --branch
git log --format='%h %G? %s' origin/main..HEAD
```

Expected: clean worktree and every feature commit reports `G`.

- [ ] **Step 2: Run TypeScript verification serially**

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm ios:project:check
git diff --check
```

Expected: all commands exit zero. If the host cannot allocate PTYs, rerun the
exact failing PTY test in isolation and report the environment failure rather
than claiming a clean suite.

- [ ] **Step 3: Run full Swift core tests**

```bash
xcodebuild -project native/ios/Psyche.xcodeproj -scheme PsycheCore \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build test
```

Expected: exit zero.

- [ ] **Step 4: Run full app unit and UI tests**

```bash
xcodebuild -project native/ios/Psyche.xcodeproj -scheme PsycheApp \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build test
```

Expected: exit zero.

- [ ] **Step 5: Build exact host and iOS artifacts**

```bash
pnpm build
xcodebuild -project native/ios/Psyche.xcodeproj -scheme PsycheApp \
  -configuration Release \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath native/ios/.release CODE_SIGNING_ALLOWED=NO build
```

Record exact commit SHA and artifact paths. Do not claim TestFlight publication
from a simulator build.

- [ ] **Step 6: Run same-LAN/simulator acceptance**

Start the exact host build in an isolated temporary project, open `:pair`, and
install the exact iOS build. Verify:

1. Bonjour discovery and successful code pairing;
2. Keychain-backed reconnect after app relaunch;
3. at least three panes across two worktrees in Now/Projects with bounded
   summaries and correct section placement;
4. focused-pane input isolation with two visible panes;
5. create, rename, confirmed stop, and surviving branch/worktree;
6. stale state disables commands and full snapshot restores them;
7. token revocation requires re-pairing; and
8. logs/wire evidence contain no code, token, transcript, or credential.

Use temporary projects and recoverable cleanup. Do not interrupt a host process
owned by another worktree.

- [ ] **Step 7: Update operational docs only with proven commands**

If live acceptance changes operator steps, document the exact `:pair`, iOS
install, reconnect, revoke, and troubleshooting commands in `native/ios/README.md`
and `docs/SMOKE.md`. Do not document unavailable TestFlight state as live.

- [ ] **Step 8: Re-run doc/project checks and commit legitimate doc changes**

```bash
pnpm ios:project:check
git diff --check
git status --short
```

If docs changed and checks pass:

```bash
git add native/ios/README.md docs/SMOKE.md
git diff --cached --check
git commit -S -m "docs: add iOS cockpit acceptance"
```

Create no empty verification commit.

- [ ] **Step 9: Run final requirement audit**

Read `docs/superpowers/specs/2026-08-12-ios-live-cockpit-design.md` line by
line and map every included requirement to code, an automated test, or live
evidence. Record any unmet item as a blocker rather than weakening the spec.

- [ ] **Step 10: Request final code review**

Review the complete `origin/main..HEAD` diff for protocol compatibility,
pairing identity safety, continuation/generation correctness, summary privacy,
stale mutation guards, accessibility, and unrelated changes. Fix every
important finding through a new RED/GREEN cycle and rerun the affected gates.
