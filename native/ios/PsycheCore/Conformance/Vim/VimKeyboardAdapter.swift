import Foundation

// MARK: - iOS keyboard conformance adapter (issue 226, psyche-no8.4)
//
// Swift twin of the shared v1 Vim chrome contract:
//   - `packages/vim-core/src/types.ts`   (wire types)
//   - `packages/vim-core/src/normalize.ts`
//   - `packages/vim-core/src/chrome-machine.ts` (executable reference machine)
//   - `packages/vim-core/src/fixtures.ts` (v1 fixture validation)
//   - `protocol-fixtures/vim/v1/chrome.json` (the shared traces)
//
// The TypeScript core is the executable reference. This Swift machine must
// produce identical semantic output for the shared traces, and the v1 fixture
// document at `protocol-fixtures/vim/v1/` is the parity gate: the same file
// must replay green through both the TypeScript harness
// (`__tests__/vimContract.test.ts`) and the Swift harness in
// `VimKeyboardAdapterTests.swift`.
//
// **Staging location.** This file sits inside the PsycheCore module directory
// but outside every XcodeGen-scanned source path (`PsycheCore/Sources`,
// `PsycheCore/Tests`, `PsycheApp/Sources`, `PsycheApp/UnitTests`,
// `PsycheApp/Tests`), so the committed Xcode project and
// `pnpm ios:project:check` remain clean until the owning integration change
// registers it. It is additive: no existing transport or app file changes.
//
// **Registration (follow-up integration change).** Move this file to
// `native/ios/PsycheCore/Sources/PsycheCore/Vim/VimKeyboardAdapter.swift` and
// the sibling test file to `native/ios/PsycheCore/Tests/PsycheCoreTests/`, then
// run `pnpm ios:project:generate` and `pnpm ios:project:check`. The fork's
// `iOS Core` CI job then compiles this module and runs the XCTest suite on
// macOS with the pinned Xcode — the compile gate this compile-only slice
// cannot satisfy on its authoring host.
//
// **Transport boundary.** This adapter never touches a terminal transport.
// `PtyTerminal.sendInput`, `XtermWebView`, and the current bridge messages
// remain the only terminal input path; nothing here imports UIKit/SwiftUI,
// opens a socket, or synthesizes terminal bytes. A `.passthrough` result
// tells the app layer to deliver the same key through the surfaces it already
// uses; consumed results are never replayed.

// MARK: - Normalized keys

/// A platform key event reduced to the cross-platform fields the semantic core
/// consumes. Wire-compatible with `NormalizedKey` in the shared core.
public struct VimNormalizedKey: Codable, Equatable, Sendable {
    public var key: String
    public var ctrl: Bool
    public var alt: Bool
    public var shift: Bool
    public var meta: Bool

    public init(
        key: String,
        ctrl: Bool = false,
        alt: Bool = false,
        shift: Bool = false,
        meta: Bool = false
    ) {
        self.key = key
        self.ctrl = ctrl
        self.alt = alt
        self.shift = shift
        self.meta = meta
    }

    /// The default chrome trigger. The accessible software Chrome key
    /// normalizes to this same token; entering application chrome mode never
    /// manufactures a terminal `F6` sequence.
    public static let f6 = VimNormalizedKey(key: "F6")
}

/// The subset of a raw platform keyboard event the contract needs. Mirrors
/// `KeyboardEventLike` in the shared core; app-layer code fills it from
/// hardware-key observations or the software Chrome key.
public struct VimKeyboardEvent: Equatable, Sendable {
    public var key: String
    public var ctrlKey: Bool
    public var altKey: Bool
    public var shiftKey: Bool
    public var metaKey: Bool

    public init(
        key: String,
        ctrlKey: Bool = false,
        altKey: Bool = false,
        shiftKey: Bool = false,
        metaKey: Bool = false
    ) {
        self.key = key
        self.ctrlKey = ctrlKey
        self.altKey = altKey
        self.shiftKey = shiftKey
        self.metaKey = metaKey
    }
}

/// Shared normalization rules with `packages/vim-core/src/normalize.ts`:
/// alias legacy names, case-fold single characters, keep modifiers boolean.
public enum VimKeyNormalizer {
    private static let aliases = ["Esc": "Escape", "Spacebar": " "]

    public static func normalize(_ event: VimKeyboardEvent) -> VimNormalizedKey {
        let aliased = Self.aliases[event.key] ?? event.key
        let key = aliased.count == 1 ? aliased.lowercased() : aliased
        return VimNormalizedKey(
            key: key,
            ctrl: event.ctrlKey,
            alt: event.altKey,
            shift: event.shiftKey,
            meta: event.metaKey
        )
    }
}

// MARK: - Contexts and dispositions

/// Semantic input context. Wire-compatible with `VimContext`.
public enum VimContext: String, Codable, Sendable, CaseIterable {
    case disabled
    case passthrough
    case chromeNormal = "chrome-normal"
    case chromeSearch = "chrome-search"
    case editor
}

/// What an adapter must do with a key. Mirrors `VimDisposition` in the shared
/// core. `passthrough` delivers the original key to the focused surface; every
/// other disposition is consumed and must never be replayed to any surface.
public enum VimDisposition: String, Codable, Sendable, CaseIterable {
    case passthrough
    case pending
    case action
    case unsupported
}

// MARK: - Semantic actions

/// Direction payload of `focus.move` and `pane.focus`.
public enum VimFocusDirection: String, Codable, Sendable, CaseIterable {
    case left, down, up, right
}

/// Direction payload of `pane.resize`.
public enum VimResizeDirection: String, Codable, Sendable, CaseIterable {
    case grow, shrink, narrow, widen
}

/// One semantic action. Wire-compatible with the `VimAction` union of the
/// shared core: JSON is `{"type": "pane.focus", "direction": "left"}` and the
/// wire type names are the fixed vocabulary of the v1 contract.
public enum VimAction: Equatable, Sendable {
    case chromeEnter
    case chromeExit
    case focusFirst
    case focusLast
    case focusActivate
    case focusMove(VimFocusDirection)
    case paneFocus(VimFocusDirection)
    case paneCycle
    case paneEqualize
    case paneSplitHorizontal
    case paneSplitVertical
    case paneResize(VimResizeDirection)
    case searchOpen
    case searchNext
    case searchPrevious
    case targetClose
    case targetRefresh
    case helpOpen

    public var wireType: String {
        switch self {
        case .chromeEnter: "chrome.enter"
        case .chromeExit: "chrome.exit"
        case .focusFirst: "focus.first"
        case .focusLast: "focus.last"
        case .focusActivate: "focus.activate"
        case .focusMove: "focus.move"
        case .paneFocus: "pane.focus"
        case .paneCycle: "pane.cycle"
        case .paneEqualize: "pane.equalize"
        case .paneSplitHorizontal: "pane.split-horizontal"
        case .paneSplitVertical: "pane.split-vertical"
        case .paneResize: "pane.resize"
        case .searchOpen: "search.open"
        case .searchNext: "search.next"
        case .searchPrevious: "search.previous"
        case .targetClose: "target.close"
        case .targetRefresh: "target.refresh"
        case .helpOpen: "help.open"
        }
    }
}

extension VimAction: Codable {
    private enum CodingKeys: String, CodingKey {
        case type
        case direction
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        let direction = try container.decodeIfPresent(String.self, forKey: .direction)

        switch type {
        case "chrome.enter": self = .chromeEnter
        case "chrome.exit": self = .chromeExit
        case "focus.first": self = .focusFirst
        case "focus.last": self = .focusLast
        case "focus.activate": self = .focusActivate
        case "focus.move": self = .focusMove(try Self.focusDirection(direction, forKey: type, codingPath: decoder.codingPath))
        case "pane.focus": self = .paneFocus(try Self.focusDirection(direction, forKey: type, codingPath: decoder.codingPath))
        case "pane.cycle": self = .paneCycle
        case "pane.equalize": self = .paneEqualize
        case "pane.split-horizontal": self = .paneSplitHorizontal
        case "pane.split-vertical": self = .paneSplitVertical
        case "pane.resize": self = .paneResize(try Self.resizeDirection(direction, codingPath: decoder.codingPath))
        case "search.open": self = .searchOpen
        case "search.next": self = .searchNext
        case "search.previous": self = .searchPrevious
        case "target.close": self = .targetClose
        case "target.refresh": self = .targetRefresh
        case "help.open": self = .helpOpen
        default:
            throw DecodingError.dataCorrupted(.init(
                codingPath: decoder.codingPath,
                debugDescription: "unknown action \(type)"
            ))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(wireType, forKey: .type)
        switch self {
        case .focusMove(let direction): try container.encode(direction.rawValue, forKey: .direction)
        case .paneFocus(let direction): try container.encode(direction.rawValue, forKey: .direction)
        case .paneResize(let direction): try container.encode(direction.rawValue, forKey: .direction)
        default: break
        }
    }

    private static func focusDirection(
        _ raw: String?,
        forKey type: String,
        codingPath: [CodingKey]
    ) throws -> VimFocusDirection {
        guard let raw, let value = VimFocusDirection(rawValue: raw) else {
            throw DecodingError.dataCorrupted(.init(
                codingPath: codingPath,
                debugDescription: "trace has an invalid direction for \(type)"
            ))
        }
        return value
    }

    private static func resizeDirection(_ raw: String?, codingPath: [CodingKey]) throws -> VimResizeDirection {
        guard let raw, let value = VimResizeDirection(rawValue: raw) else {
            throw DecodingError.dataCorrupted(.init(
                codingPath: codingPath,
                debugDescription: "trace has an invalid direction for pane.resize"
            ))
        }
        return value
    }
}

// MARK: - Semantic result

/// The machine's semantic output. Wire-compatible with `VimResult` in the
/// shared core. Invariant: `disposition == .passthrough` means the adapter
/// delivers the SAME key it passed in to the focused surface, unchanged; all
/// other dispositions are consumed.
public struct VimResult: Codable, Equatable, Sendable {
    public let disposition: VimDisposition
    public let context: VimContext
    public let pending: String
    public let actions: [VimAction]

    public init(
        disposition: VimDisposition,
        context: VimContext,
        pending: String,
        actions: [VimAction]
    ) {
        self.disposition = disposition
        self.context = context
        self.pending = pending
        self.actions = actions
    }
}

// MARK: - Settings

/// Clipboard preference (`vimClipboard`).
public enum VimClipboardMode: String, Codable, Sendable, CaseIterable {
    case unnamed
    case system
}

/// The five versioned settings of the design, with the sanitization rule the
/// app layer must apply: missing or invalid persisted values fall back safely.
/// Persistence stays with the existing settings surface (`@AppStorage` in the
/// app target); this type owns the semantics so the core stays SwiftUI-free.
public struct VimKeyboardSettings: Equatable, Sendable {
    /// Opt-in: the feature starts disabled and enabling is an explicit user act.
    public let vimModeEnabled: Bool
    /// Configurable trigger chord (function-key availability varies by device).
    public let vimChromeTrigger: VimNormalizedKey
    /// Sequence timeout in milliseconds, clamped to 250...3000.
    public let vimSequenceTimeoutMs: Int
    public let vimRelativeLineNumbers: Bool
    public let vimClipboard: VimClipboardMode

    public static let defaultSequenceTimeoutMs = 1000
    public static let allowedSequenceTimeoutMs = 250...3000

    public static let `default` = VimKeyboardSettings()

    public init(
        vimModeEnabled: Bool = false,
        vimChromeTrigger: VimNormalizedKey = .f6,
        vimSequenceTimeoutMs: Int = VimKeyboardSettings.defaultSequenceTimeoutMs,
        vimRelativeLineNumbers: Bool = false,
        vimClipboard: VimClipboardMode = .unnamed
    ) {
        self.vimModeEnabled = vimModeEnabled
        self.vimChromeTrigger = vimChromeTrigger
        // The setting itself is clamped into the approved range; the machine
        // additionally refuses an out-of-range timeout outright.
        self.vimSequenceTimeoutMs = min(max(vimSequenceTimeoutMs, Self.allowedSequenceTimeoutMs.lowerBound), Self.allowedSequenceTimeoutMs.upperBound)
        self.vimRelativeLineNumbers = vimRelativeLineNumbers
        self.vimClipboard = vimClipboard
    }

    /// Rebuilds settings from raw persisted values. Missing or invalid values
    /// fall back safely to the defaults instead of failing the read.
    public static func sanitizing(
        enabled: Bool?,
        triggerChord: String?,
        timeoutMs: Int?,
        relativeLineNumbers: Bool?,
        clipboard: VimClipboardMode?
    ) -> VimKeyboardSettings {
        let timeout = timeoutMs.map {
            min(max($0, VimKeyboardSettings.allowedSequenceTimeoutMs.lowerBound), VimKeyboardSettings.allowedSequenceTimeoutMs.upperBound)
        } ?? VimKeyboardSettings.defaultSequenceTimeoutMs
        let trigger = triggerChord.flatMap { try? VimChromeTrigger(chord: $0) }?.key ?? VimNormalizedKey.f6
        return VimKeyboardSettings(
            vimModeEnabled: enabled ?? false,
            vimChromeTrigger: trigger,
            vimSequenceTimeoutMs: timeout,
            vimRelativeLineNumbers: relativeLineNumbers ?? false,
            vimClipboard: clipboard ?? .unnamed
        )
    }
}

// MARK: - Chrome trigger

public enum VimConfigurationError: Error, Equatable {
    case trigger(String)
    case timeoutOutOfRange(Int)
}

/// The configurable chrome trigger (`vimChromeTrigger`), default `F6`.
public struct VimChromeTrigger: Equatable, Sendable {
    private static let modifierNames: Set<String> = ["Ctrl", "Alt", "Shift", "Meta"]

    public let key: VimNormalizedKey

    /// Direct normalized-key trigger (software Chrome key, programmable chords).
    public init(key: VimNormalizedKey) throws {
        guard !key.key.isEmpty else {
            throw VimConfigurationError.trigger("Chrome trigger object must contain a key and boolean modifiers")
        }
        self.key = VimKeyNormalizer.normalize(VimKeyboardEvent(
            key: key.key,
            ctrlKey: key.ctrl,
            altKey: key.alt,
            shiftKey: key.shift,
            metaKey: key.meta
        ))
    }

    /// Parses a `"Ctrl-Alt-F6"` style chord. Modifiers are Ctrl/Alt/Shift/Meta,
    /// at most once each, and the chord must end in a non-modifier key.
    /// Error messages mirror the shared TypeScript trigger parser.
    public init(chord: String) throws {
        let parts = chord.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
        guard let keyPart = parts.last, !keyPart.isEmpty, !Self.modifierNames.contains(keyPart) else {
            throw VimConfigurationError.trigger("Chrome trigger must include a non-modifier key")
        }
        var seen = Set<String>()
        for modifier in parts.dropLast() {
            guard Self.modifierNames.contains(modifier) else {
                throw VimConfigurationError.trigger("Chrome trigger has unknown modifier \(modifier)")
            }
            guard !seen.contains(modifier) else {
                throw VimConfigurationError.trigger("Chrome trigger has duplicate modifier \(modifier)")
            }
            seen.insert(modifier)
        }
        key = VimKeyNormalizer.normalize(VimKeyboardEvent(
            key: keyPart,
            ctrlKey: seen.contains("Ctrl"),
            altKey: seen.contains("Alt"),
            shiftKey: seen.contains("Shift"),
            metaKey: seen.contains("Meta")
        ))
    }

    /// The default trigger of the v1 contract.
    public static let f6 = try! VimChromeTrigger(key: VimNormalizedKey.f6)
}

// MARK: - Chrome machine

/// Why a pending sequence is being dropped. `modeDisabled` also exits chrome
/// mode: disabling the feature immediately returns the surface to native input
/// and pending keys are never delivered anywhere.
public enum VimResetReason: Equatable, Sendable {
    case focusLost
    case sequenceCleared
    case modeDisabled
}

/// Pure Swift twin of the reference chrome machine
/// (`packages/vim-core/src/chrome-machine.ts`): one window's chrome-mode state.
///
/// No UIKit, SwiftUI, PTY, or network imports; time is injected by the caller
/// per call so sequences die on monotonic deadlines, not wall-clock changes.
/// Platform adapters decide where a returned `.passthrough` key goes; they must
/// deliver it through the existing surfaces (for terminal-attached keys, the
/// `PtyTerminal.sendInput` / `XtermWebView` transport path) without
/// synthesizing or altering bytes.
public struct VimChromeMachine: Sendable {
    public private(set) var context: VimContext
    public private(set) var pending: String

    private let trigger: VimNormalizedKey
    private let timeout: Duration
    private var pendingStartedAt: Duration?

    /// Input direction keys, mirroring the shared focus-direction map.
    private static let focusDirectionByKey: [String: VimFocusDirection] = [
        "h": .left, "j": .down, "k": .up, "l": .right,
    ]

    /// Resize keys: `+` grow, `-` shrink, `<` narrow, `>` widen (shifted).
    private static let paneResizeByKey: [String: VimResizeDirection] = [
        "+": .grow, "-": .shrink, "<": .narrow, ">": .widen,
    ]

    public init(settings: VimKeyboardSettings) throws {
        try self.init(
            enabled: settings.vimModeEnabled,
            triggerKey: settings.vimChromeTrigger,
            timeoutMs: settings.vimSequenceTimeoutMs
        )
    }

    public init(
        enabled: Bool,
        triggerKey: VimNormalizedKey = .f6,
        timeoutMs: Int = VimKeyboardSettings.defaultSequenceTimeoutMs
    ) throws {
        guard VimKeyboardSettings.allowedSequenceTimeoutMs.contains(timeoutMs) else {
            throw VimConfigurationError.timeoutOutOfRange(timeoutMs)
        }
        guard !triggerKey.key.isEmpty else {
            throw VimConfigurationError.trigger("Chrome trigger object must contain a key and boolean modifiers")
        }
        context = enabled ? .passthrough : .disabled
        trigger = triggerKey
        timeout = Duration.milliseconds(Int64(timeoutMs))
        pending = ""
        pendingStartedAt = nil
    }

    /// Chord-form initializer; the trigger key is the normalized chord tail.
    public init(
        enabled: Bool,
        triggerChord: String,
        timeoutMs: Int = VimKeyboardSettings.defaultSequenceTimeoutMs
    ) throws {
        try self.init(enabled: enabled, triggerKey: VimChromeTrigger(chord: triggerChord).key, timeoutMs: timeoutMs)
    }

    /// Feeds one normalized key at the given monotonic time.
    ///
    /// - `.passthrough`: deliver the SAME key to the focused surface unchanged.
    /// - `.pending`: consume the key and show the pending sequence.
    /// - `.action`: consume the key and execute exactly the returned actions.
    /// - `.unsupported`: consume the sequence, reset safely, and show a visible
    ///   explanation. Never forwards anything to the surface.
    public mutating func handle(_ input: VimNormalizedKey, now: Duration) -> VimResult {
        if context == .disabled {
            return passthroughResult()
        }
        if let started = pendingStartedAt, now - started >= timeout {
            clearPending()
        }
        switch context {
        case .passthrough:
            if input == trigger {
                context = .chromeNormal
                return actionResult(.chromeEnter)
            }
            return passthroughResult()
        case .chromeNormal:
            return handleChromeNormal(input, now: now)
        case .chromeSearch:
            return handleChromeSearch(input)
        case .editor, .disabled:
            // Unreachable through the public API (the machine never routes
            // itself into the editor context; embedded-editor state is a
            // separate machine owned by the editor slice). Uncaptured is the
            // safe default: editor input stays on its own path.
            return passthroughResult()
        }
    }

    /// Clears an incomplete sequence without changing chrome mode.
    public mutating func focusLost() -> VimResult {
        reset(.focusLost)
    }

    /// Applies a reset reason and returns the resulting state.
    public mutating func reset(_ reason: VimResetReason) -> VimResult {
        switch reason {
        case .modeDisabled:
            clearPending()
            context = .disabled
        case .focusLost, .sequenceCleared:
            clearPending()
        }
        return snapshot()
    }

    /// Current semantic state without consuming input.
    public func snapshot() -> VimResult {
        VimResult(
            disposition: pending.isEmpty ? .unsupported : .pending,
            context: context,
            pending: pending,
            actions: []
        )
    }

    // MARK: Chrome-normal handling (mirrors the shared machine, order included)

    private mutating func handleChromeNormal(_ input: VimNormalizedKey, now: Duration) -> VimResult {
        if input.key == "Escape" && input.hasExactModifiers(.plain) {
            clearPending()
            context = .passthrough
            return actionResult(.chromeExit)
        }

        if pending == "g" {
            if input.key == "g" && input.hasExactModifiers(.plain) {
                clearPending()
                return actionResult(.focusFirst)
            }
            return unsupported()
        }

        if pending == "Ctrl-w" {
            if let direction = Self.focusDirectionByKey[input.key], input.hasExactModifiers(.plain) {
                clearPending()
                return actionResult(.paneFocus(direction))
            }
            if input.key == "w" && input.hasExactModifiers(.plain) {
                clearPending()
                return actionResult(.paneCycle)
            }
            if let resize = Self.paneResizeByKey[input.key],
               input.hasExactModifiers(.plain) || input.hasExactModifiers(.shiftOnly) {
                clearPending()
                return actionResult(.paneResize(resize))
            }
            if input.key == "=" && input.hasExactModifiers(.plain) {
                clearPending()
                return actionResult(.paneEqualize)
            }
            if input.key == "s" && input.hasExactModifiers(.plain) {
                clearPending()
                return actionResult(.paneSplitHorizontal)
            }
            if input.key == "v" && input.hasExactModifiers(.plain) {
                clearPending()
                return actionResult(.paneSplitVertical)
            }
            return unsupported()
        }

        if input.key == "w" && input.hasExactModifiers(.ctrlOnly) { return setPending("Ctrl-w", now: now) }
        if input.key == "g" && input.hasExactModifiers(.shiftOnly) {
            return actionResult(.focusLast)
        }
        if input.key == "g" && input.hasExactModifiers(.plain) {
            return setPending("g", now: now)
        }
        if let direction = Self.focusDirectionByKey[input.key], input.hasExactModifiers(.plain) {
            return actionResult(.focusMove(direction))
        }
        if input.key == "Enter" && input.hasExactModifiers(.plain) {
            return actionResult(.focusActivate)
        }
        if input.key == "/" && input.hasExactModifiers(.plain) {
            context = .chromeSearch
            return actionResult(.searchOpen)
        }
        if input.key == "x" && input.hasExactModifiers(.plain) {
            return actionResult(.targetClose)
        }
        if input.key == "r" && input.hasExactModifiers(.plain) {
            return actionResult(.targetRefresh)
        }
        if input.key == "?" && input.hasExactModifiers(.shiftOnly) {
            return actionResult(.helpOpen)
        }
        return unsupported()
    }

    private mutating func handleChromeSearch(_ input: VimNormalizedKey) -> VimResult {
        if input.key == "Escape" && input.hasExactModifiers(.plain) {
            clearPending()
            context = .passthrough
            return actionResult(.chromeExit)
        }
        if input.key == "n" && input.hasExactModifiers(.plain) {
            return actionResult(.searchNext)
        }
        if input.key == "n" && input.hasExactModifiers(.shiftOnly) {
            return actionResult(.searchPrevious)
        }
        return unsupported()
    }

    // MARK: State helpers

    private mutating func clearPending() {
        pending = ""
        pendingStartedAt = nil
    }

    private func passthroughResult() -> VimResult {
        VimResult(disposition: .passthrough, context: context, pending: "", actions: [])
    }

    private func actionResult(_ action: VimAction) -> VimResult {
        VimResult(disposition: .action, context: context, pending: "", actions: [action])
    }

    /// Consumed, reset safely, no action: the adapter shows a visible
    /// explanation and never replays the sequence to the focused surface.
    private mutating func unsupported() -> VimResult {
        clearPending()
        return VimResult(disposition: .unsupported, context: context, pending: "", actions: [])
    }

    private mutating func setPending(_ sequence: String, now: Duration) -> VimResult {
        pending = sequence
        pendingStartedAt = now
        return VimResult(disposition: .pending, context: context, pending: pending, actions: [])
    }
}

/// The exact modifier shapes the chrome mappings accept.
enum VimModifierSet {
    case plain
    case shiftOnly
    case ctrlOnly
}

extension VimNormalizedKey {
    /// Exact-modifier matching mirror: chrome mappings fire only on the exact
    /// recorded modifier set, never on supersets (e.g. ctrl+shift+w is not a
    /// `Ctrl-w` prefix, mirroring `hasExactModifiers` in the shared machine).
    fileprivate func hasExactModifiers(_ expected: VimModifierSet) -> Bool {
        switch expected {
        case .plain: return !ctrl && !alt && !shift && !meta
        case .shiftOnly: return !ctrl && !alt && shift && !meta
        case .ctrlOnly: return ctrl && !alt && !shift && !meta
        }
    }
}

// MARK: - v1 conformance fixtures

/// One replay token of a conformance trace. Modifier fields decode as optional
/// booleans so a non-boolean persisted value is rejected at decode time,
/// exactly like the shared validator rejects non-boolean modifiers.
public struct VimFixtureToken: Codable, Equatable, Sendable {
    public let key: String
    public let ctrl: Bool?
    public let alt: Bool?
    public let shift: Bool?
    public let meta: Bool?

    public init(key: String, ctrl: Bool? = nil, alt: Bool? = nil, shift: Bool? = nil, meta: Bool? = nil) {
        self.key = key
        self.ctrl = ctrl
        self.alt = alt
        self.shift = shift
        self.meta = meta
    }
}

public struct VimFixtureExpected: Codable, Equatable, Sendable {
    public let context: VimContext
    public let pending: String

    public init(context: VimContext, pending: String) {
        self.context = context
        self.pending = pending
    }
}

public struct VimFixtureTrace: Codable, Equatable, Sendable {
    public let id: String
    public let context: VimContext
    public let sequence: [VimFixtureToken]
    public let disposition: VimDisposition
    public let expected: VimFixtureExpected
    public let actions: [VimAction]

    public init(
        id: String,
        context: VimContext,
        sequence: [VimFixtureToken],
        disposition: VimDisposition,
        expected: VimFixtureExpected,
        actions: [VimAction]
    ) {
        self.id = id
        self.context = context
        self.sequence = sequence
        self.disposition = disposition
        self.expected = expected
        self.actions = actions
    }
}

/// The `vim/v1` fixture document stored at `protocol-fixtures/vim/v1/`.
public struct VimFixtureDocument: Codable, Equatable, Sendable {
    public static let expectedVersion = "vim/v1"
    public let version: String
    public let traces: [VimFixtureTrace]

    public init(version: String, traces: [VimFixtureTrace]) {
        self.version = version
        self.traces = traces
    }
}

/// Validation and conformance replay for the `vim/v1` fixture document.
///
/// Bounded input contract (mirrors `validateVimFixtures` in the shared core):
/// unknown contexts, dispositions, action types, and directions, and
/// non-boolean modifiers are rejected at decode time by the strict Codable
/// types above; this validator enforces the version marker, cardinality and
/// length bounds, and unique trace ids before a platform replays anything.
public enum VimFixtures {
    public static let maxTraceCount = 256
    public static let maxSequenceLength = 32
    public static let maxActionCount = 32
    public static let maxStringLength = 256

    public struct ValidationError: Error, Equatable, CustomStringConvertible {
        public let message: String
        public init(_ message: String) { self.message = message }
        public var description: String { "Invalid Vim fixture: \(message)" }
    }

    /// Result of replaying one trace through the Swift machine.
    public struct TraceOutcome: Equatable, Sendable, CustomStringConvertible {
        public let id: String
        public let matched: Bool
        public let detail: String
        public init(id: String, matched: Bool, detail: String) {
            self.id = id
            self.matched = matched
            self.detail = detail
        }
        public var description: String { "\(id): \(matched ? "ok" : "MISMATCH") — \(detail)" }
    }

    /// Validates bounded, versioned conformance traces before a platform
    /// consumes them.
    public static func validate(_ document: VimFixtureDocument) throws {
        guard document.version == VimFixtureDocument.expectedVersion else {
            throw ValidationError("document must declare version \(VimFixtureDocument.expectedVersion)")
        }
        guard document.traces.count <= maxTraceCount else {
            throw ValidationError("trace count exceeds \(maxTraceCount)")
        }
        var seenIDs = Set<String>()
        for trace in document.traces {
            guard !trace.id.isEmpty, trace.id.count <= maxStringLength else {
                throw ValidationError("trace id has an invalid string")
            }
            guard !seenIDs.contains(trace.id) else {
                throw ValidationError("duplicate id \(trace.id)")
            }
            seenIDs.insert(trace.id)
            for token in trace.sequence {
                guard !token.key.isEmpty, token.key.count <= maxStringLength else {
                    throw ValidationError("\(trace.id) token key has an invalid string")
                }
            }
            guard trace.sequence.count <= maxSequenceLength else {
                throw ValidationError("\(trace.id) sequence exceeds \(maxSequenceLength) tokens")
            }
            guard trace.actions.count <= maxActionCount else {
                throw ValidationError("\(trace.id) action count exceeds \(maxActionCount)")
            }
        }
    }

    /// Replays every trace through the Swift machine exactly like the shared
    /// conformance harness (`__tests__/vimContract.test.ts`): seed the starting
    /// context (trigger, then `/`, for the chrome contexts), replay the token
    /// sequence at a fixed time, and compare the final result to the trace's
    /// expected disposition, context, pending sequence, and actions.
    public static func replay(_ document: VimFixtureDocument) -> [TraceOutcome] {
        document.traces.map { trace in
            do {
                var machine = try prepareMachine(for: trace.context)
                var result = machine.snapshot()
                for token in trace.sequence {
                    result = machine.handle(
                        VimNormalizedKey(
                            key: token.key,
                            ctrl: token.ctrl ?? false,
                            alt: token.alt ?? false,
                            shift: token.shift ?? false,
                            meta: token.meta ?? false
                        ),
                        now: .zero
                    )
                }
                let expected = VimResult(
                    disposition: trace.disposition,
                    context: trace.expected.context,
                    pending: trace.expected.pending,
                    actions: trace.actions
                )
                if result == expected {
                    return TraceOutcome(id: trace.id, matched: true, detail: "replayed \(trace.sequence.count) token(s)")
                }
                return TraceOutcome(id: trace.id, matched: false, detail: "expected \(expected), got \(result)")
            } catch {
                return TraceOutcome(id: trace.id, matched: false, detail: "machine error: \(error)")
            }
        }
    }

    /// Mirrors `prepareTraceMachine` in the shared harness: the machine starts
    /// in disabled/passthrough and the chrome contexts are reached by replaying
    /// the trigger (and `/` for the search context) at a fixed time.
    private static func prepareMachine(for context: VimContext) throws -> VimChromeMachine {
        var machine = try VimChromeMachine(
            enabled: context != .disabled,
            timeoutMs: VimKeyboardSettings.defaultSequenceTimeoutMs
        )
        switch context {
        case .chromeNormal:
            _ = machine.handle(.f6, now: .zero)
        case .chromeSearch:
            _ = machine.handle(.f6, now: .zero)
            _ = machine.handle(VimNormalizedKey(key: "/"), now: .zero)
        case .disabled, .passthrough, .editor:
            break
        }
        return machine
    }
}
