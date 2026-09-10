# Psyche Build for iOS

Psyche Build is a runnable, demo-first native cockpit with product and display
name `Psyche Build` and bundle identifier `ai.opencoven.psyche-ios`. Production
launches compose one shared protocol v3 transport, request client, workspace
store, remote-action store, paired-host store, and connection manager, then
attempt to reconnect to the stored host. The demo store remains available to
previews and UI tests, so those fixtures do not require a live host.

Remote pane actions remain host-owned: the native `RemoteActionStore` uses the
same request client as `WorkspaceStore`, and `AppModel` exposes that one store
through the SwiftUI environment. Native action surfaces must use this shared
store rather than constructing a second transport or bypassing the host's
validation, confirmation, choice, and review sessions. Fixture roots use a
disconnected store so action-state UI can be tested without network access.

## Workspace persistence and recovery

The host-keyed workspace cache is presentation data, never readiness or action
authority. Restored state stays stale until a fresh host snapshot is accepted.
Credentials remain in the secure paired-host store, not the cache. Drafts and
workspace metadata are sensitive; neither cache bytes nor preserved records
belong in diagnostics, logs, or support uploads.

Reads consume at most the configured encoded limit (256 KiB by default) plus
one detection byte, using a no-follow regular-file handle. Missing, unsafe,
unreadable, malformed, and oversized records remain distinct failure cases.
Settings displays sanitized saving failures independently of connection errors.
A missing workspace is not permission to delete a host's saved drafts.

A fresh authoritative snapshot may recover malformed, unsupported-version, or
oversized cache data only after preserving and verifying the original bytes
locally. The app keeps up to three preservation records, each at most 1 MiB,
with the same complete-until-first-authentication protection as the cache and
excluded from backup. It does not evict or truncate old drafts to make room.
Larger records, unsafe paths, unreadable files, exhausted preservation slots,
or failed preservation leave the original cache untouched and require help
preserving the app data before retrying. Removing a host record is not a
recovery operation.

After a successful save the saving error clears; a separate Settings notice
explains that preserved drafts were not restored. That notice alone is not
proof that saving resumed. Dismissing it never deletes preserved data;
the notice returns on relaunch while preserved records exist. There is no
automatic import, deletion, or upload of those records. Keep the installation
and app data when requesting operator-assisted recovery; do not reinstall to
clear an error. Simulator tests exercise these flows and protection API usage,
not physical-device at-rest protection, locked-device behavior, or distribution.

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

`ExportOptions.plist` is intentionally restricted to internal TestFlight
testing and automatic signing. No Apple development team ID is checked in;
provide signing-team configuration only in the authorized release environment.
This repository does not claim live TestFlight availability.
