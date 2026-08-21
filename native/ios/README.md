# Psyche Build for iOS

Psyche Build is a runnable, demo-first native cockpit with product and display
name `Psyche Build` and bundle identifier `ai.opencoven.psyche-ios`. Production
launches compose one shared protocol v3 transport, request client, workspace
store, paired-host store, and connection manager, then attempt to reconnect to
the stored host. The demo store remains available to previews and UI tests, so
those fixtures do not require a live host.

The `v0.0.1` release identity is `Psyche Build` `0.0.1 (1)`. Distribution is
internal TestFlight only for authorized OpenCoven testers. It is not an
external TestFlight or public App Store release, and installation is possible
only if that exact build is available to the tester's account.

`project.yml` is the authoritative Xcode project and app metadata source.
XcodeGen writes the committed `PsycheApp/Resources/Info.plist`, including the
`$(PSYCHE_RELEASE_SHA)` placeholder, and the committed `Psyche.xcodeproj`.
Xcode substitutes the build setting when it processes the plist. Ordinary
builds may record empty provenance; a production archive must pass and validate
the exact commit SHA. Both generated outputs must remain deterministic under
XcodeGen 2.45.4. The pinned distribution SHA-256 is
`090ec29491aad50aec10631bf6e62253fed733c50f3aab0f5ffc86bc170bdbef`.

From the repository root, regenerate or verify the project with:

```sh
pnpm ios:project:generate
pnpm ios:project:check
```

Build, test, install, and launch from the repository root with:

```sh
xcodebuild -project native/ios/Psyche.xcodeproj -scheme PsycheCore -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -derivedDataPath native/ios/.build test
xcodebuild -project native/ios/Psyche.xcodeproj -scheme PsycheApp -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -derivedDataPath native/ios/.build build
xcrun simctl boot "iPhone 16 Pro"
xcrun simctl install "iPhone 16 Pro" "$PWD/native/ios/.build/Build/Products/Debug-iphonesimulator/Psyche Build.app"
xcrun simctl launch "iPhone 16 Pro" ai.opencoven.psyche-ios
```

Run the UI test with:

```sh
xcodebuild -project native/ios/Psyche.xcodeproj -scheme PsycheApp -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -derivedDataPath native/ios/.build test
```

### Bonjour connection acceptance

Use this as the manual same-LAN acceptance checklist:

1. Launch the exact host build under test and run `:pair`.
2. Open Settings > Connections on the iOS device while both are on the same LAN.
3. Select the advertised host, enter the six-digit code, and confirm the sheet closes only after the workspace is populated.
4. Relaunch the iOS app and confirm it reconnects to the exact last-connected host.
5. Pair a second host and confirm a deliberate switch changes the next launch target.
6. Advertise a known server ID with a changed fingerprint and confirm a warning-gated re-pair flow appears instead of Connect.
7. Force Bonjour service-resolution failure and confirm the failed row persists with Retry plus manual host/port/fingerprint fallback.

Record the host commit, iOS commit, device model, OS version, server IDs, pass/fail result, and any environmental failures separately from the acceptance result. This document does not claim that live physical-device acceptance has been performed.

`ExportOptions.plist` is intentionally restricted to internal TestFlight
testing and automatic signing. No Apple development team ID is checked in;
provide signing-team configuration only in the authorized release environment.
This repository does not claim live TestFlight availability.
