# Working record — issue 226: Vim Slice 4, iOS keyboard parity (psyche-no8.4)

Issue: OpenCoven/psyche-build#226 (Beads mirror `psyche-no8.4`, P2, blocked-by-family;
canonical outcome gh-246). Branch: `psyche/issue-226-vim-slice4-ios-keyboard`.
Canonical outcome notice: earlier broad prose references for this Vim family are
historical/superseded; gh-246 is the source of truth for the post-release track.

## Outcome

Compile-only, additive slice for iOS keyboard parity:

1. **Contract** — `docs/vim/IOS-KEYBOARD-PARITY-CONTRACT.md`: the Swift conformance
   adapter contract (transport boundary unchanged, F6 hardware command, accessible
   software Chrome key, settings, semantic action routing, focus restoration,
   XCTest/XCUITest expectations, physical-keyboard proof recording rule, explicit gaps).
2. **Adapter** — `native/ios/PsycheCore/Conformance/Vim/VimKeyboardAdapter.swift`: pure
   Foundation Swift twin of the shared v1 chrome contract
   (`packages/vim-core/src/{types,normalize,chrome-machine,fixtures}.ts`): normalized
   keys, contexts/dispositions, the 18-action wire vocabulary with Codable wire names,
   the chrome machine (`handle(_:now:)`, `reset(_:)`, `focusLost()`, `snapshot()`),
   configurable trigger chords, the five sanitized settings, and v1 fixture
   validation + conformance replay mirroring `__tests__/vimContract.test.ts`.
3. **Tests** — `native/ios/PsycheCore/Conformance/Vim/VimKeyboardAdapterTests.swift`:
   XCTest suite written for the existing `PsycheCoreTests` unit-test target convention
   (24 test methods): shared-fixture load/validate, per-trace replay, machine semantics,
   normalization, software-Chrome-key/hardware-F6 equivalence, trigger chords, settings
   sanitization, validation bounds, decode-time vocabulary rejection, wire round-trip.
4. **Working record** — this file.

No existing file was modified; no generated output was touched.

## Scope and boundaries

- Did NOT modify `PtyTerminal.sendInput` / `XtermWebView` or any transport file —
  neither file exists as a Swift/TS source in this tree yet; the contract names them
  as the design's terminal transport boundary and the adapter never touches a
  terminal transport (no UIKit/SwiftUI/PTY/network imports in PsycheCore).
- Did NOT modify `native/ios/project.yml`, `native/ios/Psyche.xcodeproj/**`, or
  `PsycheApp/Resources/Info.plist`, and did NOT run `pnpm ios:project:generate` /
  `pnpm ios:project:check` (both forbidden for this slice; generated outputs).
- Did NOT add app-layer integration (no changes to `AppModel`, `CockpitView`,
  `PaneWorkspaceView`, `PaneComposer`, `CodingKeyRow`, `SettingsView`): hardware
  chord registration, the `coding-key-chrome` control, settings UI, action routing,
  and focus restoration are owned by the integration slice that registers the adapter.
- Did NOT add fixture JSON or project resources: the Swift suite reads the existing
  shared `protocol-fixtures/vim/v1/chrome.json` via the repo's `#filePath` convention.
- Dependencies: blocked-by-family (issue 227 owns cross-platform acceptance; issue 222
  the semantic contract). Calibrated against current `main`: `packages/vim-core`,
  `protocol-fixtures/vim/v1/chrome.json`, and `__tests__/vimContract.test.ts` are
  identical on `main` and on `feat/comprehensive-vim-support` (diffed; see evidence).

## Placement decision (why `native/ios/PsycheCore/Conformance/Vim/`)

The natural compiled locations per the slice-4 plan would be
`PsycheCore/Sources/PsycheCore/Vim/` and `PsycheCore/Tests/PsycheCoreTests/`. Both are
XcodeGen-scanned target source paths (`project.yml`: `PsycheCore/Sources`,
`PsycheCore/Tests`, ...). The fork's `iOS Core` CI job runs `pnpm ios:project:check`
(= `xcodegen generate && git diff --exit-code -- native/ios/Psyche.xcodeproj
native/ios/PsycheApp/Resources/Info.plist`) whenever `native/ios/*` changes. A new
.swift file dropped into a scanned path without regenerating the committed project is
project drift by construction: XcodeGen enumerates every source file under those
directories, so the regenerated project would reference files the committed one does
not, and the check would fail red. This slice is forbidden from running
`ios:project:generate` and from touching `Psyche.xcodeproj/**`, so the files are
staged one level outside every scanned path, inside the PsycheCore module directory:
`native/ios/PsycheCore/Conformance/Vim/`. Registration (owned by the integration
change): move the adapter to `PsycheCore/Sources/PsycheCore/Vim/VimKeyboardAdapter.swift`,
move the test beside the other `PsycheCoreTests` sources, run
`pnpm ios:project:generate`, verify with `pnpm ios:project:check`. Until then the
files are referenced by no build target and cannot affect shipped behavior.

## Risk class

**R1** (documentation or isolated tests) — per AGENTS.md R1–R4 with the narrow-contract
exception for `native/ios/**`: the change is 100% additive (no tracked file modified),
introduces no new dependency, is referenced by no build target (verified: committed
`Psyche.xcodeproj/project.pbxproj` is unchanged and `project.yml` scans fixed paths),
and therefore cannot change any product behavior, transport, authority, persistence,
or recovery surface. The registration/integration change that wires chrome mode into
the app is the R2/R3 review point and does not exist in this PR. Reviewers may
re-classify; the PR is marked draft for that review.

## Exact commands and observed results

All commands run in `/home/node/trees/issue-226` on this host (no tmux, no Swift
toolchain, no sudo). Environment: Node v24, pnpm 10.34.5 via `npx pnpm`.

| # | Command | Observed result |
|---|---|---|
| 1 | `git fetch origin && git merge --ff-only origin/main` | fast-forwarded `a4546f4` → `63667f3` ("Report pane recovery failures visibly (#283)"); working tree clean before changes |
| 2 | `npx pnpm install --frozen-lockfile` | `Done in 739ms using pnpm v10.34.5`, exit 0 |
| 3 | `npx pnpm exec vitest --run __tests__/vimContract.test.ts` | `Test Files 1 passed (1)`, `Tests 18 passed (18)` — the shared v1 fixture harness this slice's Swift runner mirrors |
| 4 | `npx pnpm exec tsc --noEmit` | exit 0, no output |
| 5 | `npx pnpm exec tsc -p tsconfig.test.json --noEmit` | exit 0, no output |
| 6 | `git diff --check` | exit 0, no output |
| 7 | `git status --short` | only new untracked paths `docs/vim/` and `native/ios/PsycheCore/Conformance/` — purely additive |
| 8 | `diff <(git show FETCH_HEAD:packages/vim-core/src/chrome-machine.ts) packages/vim-core/src/chrome-machine.ts` and same for `protocol-fixtures/vim/v1/chrome.json`, `__tests__/vimContract.test.ts` | all identical between `feat/comprehensive-vim-support` and `main` — calibration is against current `main` |
| 9 | `command -v swift swiftc xcodebuild xcodegen tmux` | all MISSING — no local Swift/iOS/tmux tooling |

Deliverables commit: `fdbe98a` (`feat(vim): iOS keyboard conformance adapter and
parity contract (#226)`, 3 files, +1586). This record is committed in a follow-up
commit so it cannot contain its own hash; the PR head SHA is the authoritative
final head and is recorded on the PR and in the status comment.

## Test counts

- Local TypeScript: **18 passed, 0 failed** (`__tests__/vimContract.test.ts`, the
  shared fixture harness; this slice adds no TypeScript code or tests).
- Swift: **24 XCTest methods written** in `VimKeyboardAdapterTests.swift` — **0
  executed** (no Swift toolchain on this host; see gaps). Test methods:
  testLoadsAndValidatesTheSharedV1ChromeFixture, testReplaysEveryV1ChromeTraceThroughTheSwiftMachine,
  testReplaysEachV1ChromeTraceWithItsExpectedSemanticResult, testEntersChromeWithF6AndExitsOnEscape,
  testDisabledMachinePassesEverythingThrough, testEmitsFocusFirstForGG,
  testDistinguishesShiftedGAndNAfterNormalization, testEmitsPaneFocusLeftForCtrlWH,
  testConsumesUnsupportedChromePrefixes, testRequiresExactModifiers,
  testResetsPendingOnTimeoutAndFocusLoss, testModeDisabledResetDropsPendingAndExitsChrome,
  testFocusLostClearsPendingWithoutLeavingChrome, testSoftwareChromeKeyMatchesHardwareF6,
  testNormalizesHardwareKeyEventsWithoutPlatformImports, testConfigurableTriggerChordReplacesF6,
  testRejectsMalformedTriggerChords, testSettingsSanitizationFallsBackSafely,
  testMachineRefusesOutOfRangeTimeout, testFixtureValidationRejectsDuplicateIDsAndOversizedDocuments,
  testFixtureDecodeRejectsUnknownVocabulary, testVimResultRoundTripsThroughTheWireShape.

## Proof gaps (explicit, none hidden)

1. **No Swift compile anywhere yet.** `swift`, `swiftc`, `xcodebuild`, `xcodegen` are
   absent on this host. The Swift adapter and tests were hand-verified (mirror-checked
   against `packages/vim-core/src/chrome-machine.ts` line by line; brace/paren balance
   checked) but never compiled. **The fork's `iOS Core` CI job (pinned Xcode 26.2,
   iPhone 16 Pro simulator) is the compile gate — and it can only compile the adapter
   after the registration step above, which this slice is forbidden to perform.** Until
   registration, even a green `iOS Core` job proves nothing about these files.
2. **Swift tests not executed** (24 written, 0 run) — same cause; XCTest execution
   requires the simulator run on macOS after registration.
3. **No XcodeGen regeneration** — the committed `Psyche.xcodeproj` does not reference
   the staged files (intentional; see placement decision). `pnpm ios:project:check`
   not run locally (forbidden + no xcodegen); the CI job runs it against the unchanged
   committed project.
4. **No XCUITest / app-layer evidence** — hardware-chord registration, the accessible
   `coding-key-chrome` control, modal precedence, and focus restoration are app-layer
   and owned by the integration slice; no UI test exists yet.
5. **No physical iOS hardware-keyboard evidence** — per the design and the contract
   doc's recording rule, this remains an explicit gap until run on available hardware
   and recorded as an acceptance record tied to immutable source and artifacts.
   Simulator evidence never substitutes for physical-keyboard evidence.
6. **Independent reviews not yet obtained** — the PR is a draft pending review; issue
   acceptance requires independent approval.
7. **tmux absent** — `scripts/agent-bootstrap` / `scripts/agent-check` were NOT run
   (they require tmux; runbook forbids running them here).

## Verification coverage statement

What local evidence DOES establish: the shared v1 fixture document is valid and its
TypeScript harness is green on this exact tree (18/18), the repository TypeScript
gates are green with this change present, and the change is purely additive (no
tracked file modified — `git status --short` shows only new paths). What it does NOT
establish: any Swift compilation, any Swift test execution, or any iOS behavior.

## Rollback notes

Purely additive: `git revert` of the two slice commits (or branch deletion) restores
the exact prior tree; no generated output, schema, persisted format, public command,
or transport path is touched, so no data migration or compatibility rollback applies.
The only cross-agent coordination point is the `docs/vim/` namespace name required by
the task; no other slice's files are referenced or modified.
