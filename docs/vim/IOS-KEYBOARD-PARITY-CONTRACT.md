# iOS Keyboard Parity Contract — Vim Slice 4 (psyche-no8.4)

Status: contract for the iOS Vim keyboard conformance slice (OpenCoven/psyche-build#226,
canonical outcome gh-246). Design source:
[docs/superpowers/specs/2026-08-12-comprehensive-vim-support-design.md](../superpowers/specs/2026-08-12-comprehensive-vim-support-design.md).
This document states the contract; the working record
[`docs/working-records/issue-226-vim-slice4-ios-keyboard.md`](../working-records/issue-226-vim-slice4-ios-keyboard.md)
states exactly what was executed and what remains unproven.

## 1. Boundary invariants (non-negotiable)

- `PtyTerminal.sendInput`, `XtermWebView`, and the current bridge messages remain
  the only terminal input path. The Vim adapter never writes to the terminal
  transport, never synthesizes terminal bytes, and never alters bytes in flight.
  Nothing in this slice modifies either file; the adapter is additive.
- Raw platform events never invoke product actions. Every adapter performs:
  `raw event -> normalized key token -> semantic state machine -> action executor`.
- Dispositions:
  - `passthrough` — deliver the original, unmodified key to the focused surface.
    For terminal-attached keys that means the existing send path, unchanged.
  - `pending` — consume the key and show the pending sequence.
  - `action` — consume the key and execute exactly the returned semantic actions.
  - `unsupported` — consume the sequence, reset safely, and show a visible
    explanation. Never forwards anything to the focused surface.
- Consumed keys are never replayed to any surface. Pending keys dropped by
  reset, timeout, or mode-disable are never delivered anywhere.
- Entering application chrome mode — by hardware `F6` or by the software Chrome
  key — does not manufacture a terminal `F6` sequence.
- On `Escape`, terminal delivery resumes without synthesizing an extra escape byte.

## 2. Swift conformance adapter

The adapter is a pure Foundation module member in PsycheCore: no UIKit, SwiftUI,
PTY, xterm, or network imports, mirroring the shared TypeScript core
(`packages/vim-core`). It must produce identical semantic output to the shared
core for every shared trace (`TypeScript and Swift adapters must produce
identical semantic output for shared traces`).

Staged files (this slice, compile-only — see the working record for the
registration step that moves them into the compiled targets):

| File | Staged at | Target location at registration |
|---|---|---|
| Adapter | `native/ios/PsycheCore/Conformance/Vim/VimKeyboardAdapter.swift` | `native/ios/PsycheCore/Sources/PsycheCore/Vim/` (PsycheCore framework) |
| XCTest suite | `native/ios/PsycheCore/Conformance/Vim/VimKeyboardAdapterTests.swift` | `native/ios/PsycheCore/Tests/PsycheCoreTests/` |

Why staged outside the XcodeGen-scanned trees: `pnpm ios:project:check`
regenerates `Psyche.xcodeproj` from `project.yml` and fails on any drift. A
source file dropped into a scanned tree without regenerating the committed
project is drift by construction. This slice is forbidden from running
`pnpm ios:project:generate` and from touching `Psyche.xcodeproj/**`, so the
files are staged outside every scanned path (`PsycheCore/Sources`,
`PsycheCore/Tests`, `PsycheApp/Sources`, `PsycheApp/UnitTests`,
`PsycheApp/Tests`). Until registration they are referenced by no build target;
they cannot change any shipped behavior.

### 2.1 Normalized keys

A platform key event is reduced to the cross-platform fields the semantic core
consumes — the same reduction as `packages/vim-core/src/normalize.ts`:

- aliases: `Esc` → `Escape`, `Spacebar` → `" "`;
- single-character keys are case-folded (`H` → `h`); multi-character names
  (`F6`, `Escape`, `Enter`) keep their casing;
- modifiers are booleans: `ctrl`, `alt`, `shift`, `meta`.

Normalized key wire shape: `{"key": "F6", "ctrl": false, "alt": false, "shift": false, "meta": false}`.

### 2.2 Contexts, dispositions, and the result contract

Contexts (`VimContext`): `disabled`, `passthrough`, `chrome-normal`,
`chrome-search`, `editor`. Dispositions (`VimDisposition`): `passthrough`,
`pending`, `action`, `unsupported`. The chrome machine owns
disabled/passthrough/chrome-normal/chrome-search; the `editor` context belongs
to the embedded-editor machine and is never entered by the chrome machine
(a machine routed there passthroughs uncaptured, by contract).

Machine output is `VimResult { disposition, context, pending, actions }`.
`disposition == .passthrough` obligates the adapter to deliver the same key it
passed in; every other disposition is consumed.

### 2.3 Machine API

```swift
public struct VimChromeMachine: Sendable {
    public init(settings: VimKeyboardSettings) throws
    public init(enabled: Bool, triggerKey: VimNormalizedKey = .f6,
                timeoutMs: Int = VimKeyboardSettings.defaultSequenceTimeoutMs) throws
    public init(enabled: Bool, triggerChord: String,
                timeoutMs: Int = VimKeyboardSettings.defaultSequenceTimeoutMs) throws

    public mutating func handle(_ input: VimNormalizedKey, now: Duration) -> VimResult
    public mutating func reset(_ reason: VimResetReason) -> VimResult
    public mutating func focusLost() -> VimResult
    public func snapshot() -> VimResult
}
```

- Time is injected per call (`now: Duration`); the approved clamp is
  `250...3000` ms with default `1000`. Constructing a machine with an
  out-of-range timeout throws.
- Semantics mirror `chrome-machine.ts` exactly: `F6` (or the configured chord)
  enters chrome mode (`chrome.enter`); `Escape` exits (`chrome.exit`) to
  `passthrough` with no synthesized bytes; `g g` → `focus.first`; `G` →
  `focus.last`; `h/j/k/l` → `focus.move`; `Enter` → `focus.activate`; `/` →
  `search.open` (context `chrome-search`); `n` / `N` → `search.next` /
  `search.previous`; `x` → `target.close`; `r` → `target.refresh`; `?` →
  `help.open`; `Ctrl-w` prefixes → `pane.focus` (h/j/k/l), `pane.cycle` (w),
  `pane.resize` (`+`/`-` plain, `<`/`>` shifted), `pane.equalize` (=),
  `pane.split-horizontal` (s), `pane.split-vertical` (v). Exact modifier sets
  are required — supersets never match. Unknown or exhausted sequences return
  `unsupported`, are consumed, and reset safely.
- Pending sequences carry a monotonic deadline (`g`, `Ctrl-w`); expiry clears
  the pending sequence without changing chrome mode. `focusLost` and
  `reset(.sequenceCleared)` clear the pending sequence without leaving chrome
  mode; `reset(.modeDisabled)` additionally exits to `disabled` so native input
  resumes immediately.
- The machine never routes itself into the editor context; embedded-editor
  input remains owned by the editor slice.

### 2.4 v1 fixture conformance

The fixture vocabulary and bounds are fixed by the shared core
(`packages/vim-core/src/fixtures.ts`) and the stored document
`protocol-fixtures/vim/v1/chrome.json` (`version: "vim/v1"`):

- contexts: `disabled | passthrough | chrome-normal | chrome-search | editor`;
- dispositions: `passthrough | pending | action | unsupported`;
- action vocabulary (18): `chrome.enter`, `chrome.exit`, `focus.first`,
  `focus.last`, `focus.activate`, `focus.move`, `pane.focus`, `pane.cycle`,
  `pane.equalize`, `pane.split-horizontal`, `pane.split-vertical`,
  `pane.resize`, `search.open`, `search.next`, `search.previous`,
  `target.close`, `target.refresh`, `help.open`;
- directions: `left|down|up|right` for `focus.move`/`pane.focus`;
  `grow|shrink|narrow|widen` for `pane.resize`;
- bounds: ≤ 256 traces, ≤ 32 tokens per sequence, ≤ 32 actions per trace,
  strings ≤ 256 characters, unique trace ids, `vim/v1` version marker;
- validation rejects duplicate ids, unknown contexts/dispositions/actions/
  directions, missing dispositions, and unbounded sequences.

The Swift validator (`VimFixtures.validate`) enforces version, cardinality and
length bounds, and unique ids; unknown vocabulary and non-boolean modifiers are
rejected at decode time by strict `Codable` types. The conformance runner
(`VimFixtures.replay`) mirrors the shared harness
(`__tests__/vimContract.test.ts`): seed the starting context by replaying the
trigger (and `/` for `chrome-search`) at a fixed time, replay the token
sequence, and require the final result to equal the trace's expected
disposition, context, pending sequence, and actions. Parity gate: the same
fixture document passes through both the TypeScript harness and the Swift
runner with identical semantic output.

## 3. F6 hardware command

- `F6` is the default chrome trigger (`vimChromeTrigger`), configurable because
  function-key availability varies by device. Chords parse as
  `Ctrl-Alt-Shift-Meta`-prefixed, each modifier at most once, ending in a
  non-modifier key; malformed chords fall back to the default when read from
  persisted settings.
- The hardware `F6` observation is normalized into a `VimNormalizedKey` and fed
  to the machine before any surface delivery. While chrome mode is active the
  trigger chord is consumed like any other chrome input (it is not a mapping,
  so it resolves to `unsupported` — consumed, explained, never sent onward).
- Registered at the app layer through SwiftUI keyboard commands; PsycheCore
  itself has no SwiftUI imports. The machine API stays SwiftUI-free.

## 4. Accessible software Chrome key

- `CodingKeyRow` gains a `.chrome` control beside the terminal keys with
  accessibility identifier `coding-key-chrome`, label `Chrome navigation`, and
  the selected trait while chrome mode is active.
- The software key is the software-keyboard equivalent of `F6`: it normalizes
  to the same trigger token and routes through the same machine entry point.
  It must not manufacture a terminal `F6` sequence when entering application
  chrome mode (see §1).
- The control carries `accessibilityLabel("Chrome navigation")`, exposes its
  selected state, and participates in the existing accessibility ordering; the
  pending sequence is visible to assistive technology while a sequence is armed.

## 5. Settings (v1)

Five versioned settings, owned by the existing settings surface; the adapter
carries their semantics (`VimKeyboardSettings`) and the sanitization rule:

| Setting | Type | Default | Rule |
|---|---|---|---|
| `vimModeEnabled` | boolean | `false` | opt-in; enabling is an explicit user act |
| `vimChromeTrigger` | normalized key chord | `F6` | configurable; chords `Ctrl-Alt-Shift-Meta` + non-modifier key |
| `vimSequenceTimeoutMs` | integer | `1000` | clamped to `250..3000`; out-of-range refused by the machine |
| `vimRelativeLineNumbers` | boolean | `false` | editor-only preference, portable config |
| `vimClipboard` | `unnamed \| system` | `unnamed` | editor-only preference |

Missing or invalid persisted values fall back safely (never fail the read).
Persistence uses the platform's existing versioned settings/storage path
(iOS: `@AppStorage`-backed properties in the app target — not part of this
slice). Disabling the feature immediately resets pending sequences, exits
chrome/editor command state to native input behavior, clears visible mode
chrome, and does not send pending keys anywhere. Mappings are not
user-configurable in v1.

## 6. Semantic action routing

- Returned actions route to the current app model, pane, project, navigation,
  search, and guard APIs — the adapter maps actions onto existing controls; it
  does not create parallel commands or a second transport.
- Unsupported actions announce status visibly and never call the terminal send
  path.
- Input precedence (resolved in this order):
  1. OS accessibility and reserved system commands;
  2. active native modal/dialog controls;
  3. IME composition, dead keys, and native editable text controls;
  4. the configured chrome trigger;
  5. active Psyche chrome mode;
  6. active embedded-editor Vim mode;
  7. existing Psyche application shortcuts;
  8. unchanged terminal or focused-control passthrough.
- The adapter ignores composition updates until the platform reports committed
  text. Paste payloads are atomic and never parsed as Vim command sequences.
  Key-up events, mouse reporting, bracketed paste, function keys other than the
  configured trigger, and terminal escape/control sequences remain unchanged
  outside chrome mode.
- Modal and native text-input precedence wins over chrome handling: while a
  modal, sheet, dialog, or editable text control is first responder, hardware
  keys are delivered to it and the chrome machine is not consulted.

## 7. Focus restoration

Leaving chrome mode restores a stable semantic target (terminal, editor, input,
or accessible control) recorded on entry — never a raw view pointer. If the
recorded target no longer exists, focus moves to the nearest surviving pane or
navigation container. Focus loss clears an incomplete sequence without leaving
chrome mode (`VimChromeMachine.focusLost`); disabling the feature exits chrome
state entirely and never sends pending keys elsewhere.

## 8. XCTest / XCUITest expectations

Core (PsycheCoreTests, pure Foundation — no UIKit/SwiftUI):

- load `protocol-fixtures/vim/v1/chrome.json` relative to the source file, the
  same document the TypeScript harness reads, and validate it;
- replay every v1 trace through the Swift machine and require the exact
  expected disposition, context, pending sequence, and actions;
- machine semantics: enter/exit, disabled passthrough, `g g`, shifted `G`/`N`,
  `Ctrl-w h`, unsupported consumption, exact-modifier rejection, timeout and
  focus-loss resets, `modeDisabled` reset;
- normalization aliases and case folding without platform imports;
- software Chrome key equivalence with the hardware trigger (both consumed);
- configurable chords, malformed-chord rejection, settings sanitization
  fallbacks, timeout clamp enforcement;
- fixture validation bounds (duplicate ids, trace/sequence/action counts,
  string lengths) and decode-time vocabulary rejection.

App layer (PsycheAppTests / PsycheAppUITests, owned by the integration slice):

- F6 and the accessible Chrome key enter chrome mode without terminal bytes;
  Escape exits without bytes; passthrough uses the existing send path;
- modal/text-field precedence wins over chrome mode;
- semantic actions drive the current pane/project/navigation APIs; unsupported
  actions announce status and never call `sendInput`;
- a `coding-key-chrome` control carries label `Chrome navigation` and the
  selected trait while chrome mode is active; a `CHROME`/pending indicator is
  accessible with reduced-motion treatment;
- keyboard dismissal restores the nearest surviving focus target.

## 9. Physical-keyboard proof recording rule

Physical iOS hardware-keyboard evidence remains an explicit proof gap until run
on available hardware; simulator evidence does not substitute for it. When the
proof is taken, it is recorded as an acceptance record tied to immutable source
and artifacts: the exact commit SHA, the exact command, device and keyboard
hardware used, observed result, and any omission — per
[RELEASE-ACCEPTANCE.md](../RELEASE-ACCEPTANCE.md) and the repository AGENTS.md
evidence contract. `PSYCHE_AGENT_CHECK_IOS=1` may only be set on a compatible
macOS host with the repository-pinned Xcode, simulator, and XcodeGen. A skipped
or simulated check is never recorded as physical-keyboard evidence.

## 10. Proof gaps of this slice (explicit)

- No Swift toolchain exists on the authoring host: `swift`, `swiftc`,
  `xcodebuild`, and `xcodegen` are unavailable, so nothing Swift was compiled
  or run locally. The fork's `iOS Core` CI job (pinned Xcode 26.2, iPhone 16 Pro
  simulator) is the compile/test gate — after registration.
- The staged files are not referenced by the committed `Psyche.xcodeproj`;
  registration (move into `PsycheCore/Sources/PsycheCore/Vim/` and
  `PsycheCore/Tests/PsycheCoreTests/`, then `pnpm ios:project:generate` and
  `pnpm ios:project:check`) is owned by the integration change that wires
  chrome mode into the app. Until then the macOS compile gate has not run.
- XCUITest hardware-keyboard cases, physical-device evidence, and independent
  reviews remain open, per the slice plan and the design's parity gate.
