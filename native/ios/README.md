# Psyche iOS

The app is a runnable, demo-first native cockpit. `PsycheCore` models bridge
protocol v2 behind Swift transport interfaces; no live host is required.

From `native/ios`:

```sh
xcodegen generate
xcodebuild -project Psyche.xcodeproj -scheme PsycheCore -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -derivedDataPath .build test
xcodebuild -project Psyche.xcodeproj -scheme PsycheApp -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -derivedDataPath .build build
xcrun simctl boot "iPhone 16 Pro"
xcrun simctl install "iPhone 16 Pro" "$PWD/.build/Build/Products/Debug-iphonesimulator/PsycheApp.app"
xcrun simctl launch "iPhone 16 Pro" build.psyche.ios
```

Run the UI test with:

```sh
xcodebuild -project Psyche.xcodeproj -scheme PsycheApp -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -derivedDataPath .build test
```
