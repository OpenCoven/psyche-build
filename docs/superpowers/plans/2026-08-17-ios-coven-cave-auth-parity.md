# iOS Coven Cave Authentication Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace six-digit pairing with a Psyche-specific expiring invite that exchanges once for an endpoint-bound durable device credential.

**Architecture:** This matches Coven Cave's invite procedure, not its protocol: Cave's HTTP bearer cannot authenticate Psyche's WebSocket bridge. Psyche mints, redeems, and scopes its own invite; the daemon returns its existing durable device token after one valid redemption; iOS stores only that durable token in its device-only keychain record.

**Tech Stack:** TypeScript, Node crypto, ws, Swift, SwiftUI, XCTest, Keychain, XcodeGen.

---

### Task 1: One-time bridge invite exchange

**Files:** Create `src/services/bridge/MobileInviteStore.ts` and `src/services/bridge/MobileInviteStore.test.ts`; modify `src/services/bridge/{BridgeDaemon,wireProtocol}.ts`; test `src/services/bridge/BridgeDaemon.test.ts`.

- [ ] **Step 1: Write the failing store test.**

```ts
it("redeems an unexpired invite exactly once", () => {
  const store = new MobileInviteStore({ now: () => new Date("2026-08-17T12:00:00Z") });
  const invite = store.issue({ endpoint: "wss://psyche.example:4242" });
  expect(store.redeem(invite.token)).toEqual({ endpoint: "wss://psyche.example:4242" });
  expect(store.redeem(invite.token)).toBeNull();
});
```

- [ ] **Step 2: Verify RED.** Run `pnpm exec vitest run src/services/bridge/MobileInviteStore.test.ts`; expected FAIL because `MobileInviteStore` is absent.

- [ ] **Step 3: Implement minimally.** `MobileInviteStore.issue({ endpoint, ttlMs? })` must create a random-nonce, HMAC-signed, expiry-bound opaque token; `redeem(token)` must verify with `timingSafeEqual`, expire and consume the nonce, and return only the endpoint. Keep bounded nonce hashes only in memory. Add optional `invite` to hello and `authAccepted { token }` to server messages. `BridgeDaemon.openMobileInvite()` returns a Psyche deep link/HTTPS QR payload. Reject token-plus-invite. A valid invite issues `TokenStore.issue`, authenticates the session, and sends `authAccepted`; invalid, used, or expired input sends `invalid_invite` and stays unauthenticated.

- [ ] **Step 4: Verify GREEN.** Run `pnpm exec vitest run src/services/bridge/MobileInviteStore.test.ts src/services/bridge/BridgeDaemon.test.ts src/services/bridge/wireProtocol.test.ts`; expected PASS.

- [ ] **Step 5: Commit.** `git add src/services/bridge/MobileInviteStore.ts src/services/bridge/MobileInviteStore.test.ts src/services/bridge/BridgeDaemon.ts src/services/bridge/BridgeDaemon.test.ts src/services/bridge/wireProtocol.ts src/services/bridge/wireProtocol.test.ts && git commit -m "feat: add expiring mobile invites"`.

### Task 2: Desktop Open-on-phone surface

**Files:** Modify `src/actions/implementations/pairAction.ts`, `src/components/ui/PairBanner.tsx`, and `src/PsycheApp.tsx`; update their focused tests.

- [ ] **Step 1: Write the failing action test.**

```ts
it("opens a QR-safe invite instead of exposing a six-digit code", async () => {
  const showInvite = vi.fn();
  await runPairAction({ bridgeDaemon: { openMobileInvite: vi.fn().mockResolvedValue({ url: "psyche://connect?host=mac&psyche_invite=test" }) }, showInvite });
  expect(showInvite).toHaveBeenCalledWith({ url: "psyche://connect?host=mac&psyche_invite=test" });
});
```

- [ ] **Step 2: Verify RED.** Run `pnpm exec vitest run src/actions/implementations/pairAction.test.ts`; expected FAIL because `openMobileInvite`/`showInvite` are absent.

- [ ] **Step 3: Implement and verify GREEN.** Replace `openPairWindow` with `openMobileInvite`; render QR only, never raw URL in terminal/status logs; change copy to **Open on phone**. Run `pnpm exec vitest run src/actions/implementations/pairAction.test.ts src/components/ui/PairBanner.test.tsx`; expected PASS.

- [ ] **Step 4: Commit.** `git add src/actions/implementations/pairAction.ts src/components/ui/PairBanner.tsx src/PsycheApp.tsx && git commit -m "feat: open mobile with Psyche invite"`.

### Task 3: iOS parser and secure store

**Files:** Create `native/ios/PsycheCore/Sources/PsycheCore/Connection/{PsycheInvite,MobileCredentialStore}.swift`; create matching test files in `native/ios/PsycheCore/Tests/PsycheCoreTests`; modify `native/ios/project.yml`.

- [ ] **Step 1: Write failing parser tests.**

```swift
func testAcceptsPsycheInvite() {
    XCTAssertEqual(PsycheInvite.parse("psyche://connect?host=mac.tailnet.ts.net&psyche_invite=one-time"), PsycheInvite(host: "mac.tailnet.ts.net", invite: "one-time"))
}
func testRejectsTokenlessAndCovenCaveLinks() {
    XCTAssertNil(PsycheInvite.parse("psyche://connect?host=mac.tailnet.ts.net"))
    XCTAssertNil(PsycheInvite.parse("covencave://connect?host=mac&token=value"))
}
```

- [ ] **Step 2: Verify RED.** Run `xcodebuild -project native/ios/Psyche.xcodeproj -scheme PsycheCore -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -derivedDataPath native/ios/.build test -only-testing:PsycheCoreTests/PsycheInviteTests`; expected FAIL because `PsycheInvite` is absent.

- [ ] **Step 3: Implement and test endpoint binding.** Accept only `psyche://connect` and HTTPS inputs with host and `psyche_invite`; never persist the invite. `MobileCredentialStore.save(endpoint:token:)`, `credential(for:)`, and `clear()` use one Codable Keychain record with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`; credentials return only for exact normalized host/port/fingerprint equality. Add and run a failing-then-passing mismatch test that saves `a.local` and requests `b.local`.

- [ ] **Step 4: Regenerate and commit.** Run `pnpm ios:project:generate && pnpm ios:project:check`; expected clean. Then `git add native/ios/PsycheCore native/ios/project.yml native/ios/Psyche.xcodeproj && git commit -m "feat: store iOS mobile credentials securely"`.

### Task 4: iOS hello exchange and reconnect

**Files:** Modify `native/ios/PsycheCore/Sources/PsycheCore/Protocol/BridgeMessages.swift`, `Connection/ConnectionManager.swift`, and `Connection/MobileAppComposition.swift`; update `BridgeMessagesTests.swift` and `ConnectionManagerTests.swift`.

- [ ] **Step 1: Write failing exchange tests.**

```swift
func testInviteHelloPersistsOnlyReturnedDeviceCredential() async throws {
    await manager.connect(using: invite)
    await fake.emit(.legacy(.authAccepted(AuthAcceptedPayload(token: "durable-token"))))
    XCTAssertEqual(try await store.credential(for: invite.endpoint), "durable-token")
}
func testReconnectSendsTokenNotOriginalInvite() async throws {
    try await store.save(endpoint: endpoint, token: "durable-token")
    await manager.connectToStoredHost()
    XCTAssertEqual(await fake.sentHello()?.token, "durable-token")
    XCTAssertNil(await fake.sentHello()?.invite)
}
```

- [ ] **Step 2: Verify RED.** Run `xcodebuild -project native/ios/Psyche.xcodeproj -scheme PsycheCore -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -derivedDataPath native/ios/.build test -only-testing:PsycheCoreTests/ConnectionManagerTests`; expected FAIL because invite hello and `authAccepted` are absent.

- [ ] **Step 3: Implement and verify GREEN.** Encode/decode optional hello `invite` and `authAccepted`; transmit one stored token or one ephemeral invite; save only `authAccepted.token`; retain all current cancellation/generation fences. Run focused BridgeMessages/ConnectionManager tests; expected PASS. Commit with `git add native/ios/PsycheCore && git commit -m "feat: exchange Psyche invites on iOS"`.

### Task 5: Invite-only iOS UI and legacy deletion

**Files:** Create `native/ios/PsycheApp/Sources/PsycheApp/Views/ConnectPsycheSheet.swift`; modify `SettingsView.swift`, `AppModel.swift`, and `PsycheAppUITests.swift`; delete `PairHostSheet.swift` and obsolete pairing sources/tests after migration.

- [ ] **Step 1: Write the failing UI test.**

```swift
func testSettingsAcceptsOnlyAuthenticatedPsycheInvites() throws {
    let app = launchApp()
    app.buttons["settings-connect-psyche"].tap()
    let field = app.textFields["connect-psyche-invite"]
    field.tap(); field.typeText("psyche://connect?host=mac.local&psyche_invite=one-time")
    app.buttons["Connect"].tap()
    XCTAssertFalse(app.textFields["pair-code-field"].exists)
}
```

- [ ] **Step 2: Verify RED.** Run the PsycheApp UI test filter for this method; expected FAIL because `ConnectPsycheSheet` is absent.

- [ ] **Step 3: Implement and verify GREEN.** Add one invite input plus explicit Paste/Scan actions; recovery says create a new **Open on phone** invite; display only sanitized host identity; fixtures stay offline. Delete six-digit UI and production pairing path. Run `! rg -n 'PairHostSheet|pairingCode|Six-digit pairing code' native/ios/PsycheApp native/ios/PsycheCore/Sources` plus the UI test; expected no matches and PASS. Commit with `git add native/ios/PsycheApp native/ios/PsycheCore native/ios/project.yml native/ios/Psyche.xcodeproj && git commit -m "feat: replace iOS pairing with mobile invites"`.

### Task 6: End-to-end gate

- [ ] **Step 1: Run validation.** `pnpm run typecheck && pnpm exec vitest run src/services/bridge && xcodebuild -project native/ios/Psyche.xcodeproj -scheme PsycheCore -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -derivedDataPath native/ios/.build test && xcodebuild -project native/ios/Psyche.xcodeproj -scheme PsycheApp -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -derivedDataPath native/ios/.build test`; expected PASS.

- [ ] **Step 2: Build/install/launch.** `xcodebuild -project native/ios/Psyche.xcodeproj -scheme PsycheApp -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -derivedDataPath native/ios/.build build && xcrun simctl install 'iPhone 16 Pro' "$PWD/native/ios/.build/Build/Products/Debug-iphonesimulator/Psyche Build.app" && xcrun simctl launch 'iPhone 16 Pro' ai.opencoven.psyche-ios`; expected bundle ID and PID.

- [ ] **Step 3: Clean-diff gate.** `git diff --check && git status --short && git log --oneline main..HEAD`; expected no whitespace errors and only planned commits.
