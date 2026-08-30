import XCTest
@testable import PsycheCore

/// Swift conformance suite for the v1 Vim chrome contract (issue 226).
///
/// The adapter is the Swift twin of `packages/vim-core/src/chrome-machine.ts`;
/// these tests mirror the shared harness `__tests__/vimContract.test.ts` and
/// read the SAME fixture document at `protocol-fixtures/vim/v1/chrome.json`,
/// located relative to this source file rather than a test bundle — no
/// project.yml resource wiring to keep in sync.
///
/// **Target location.** This file is written for the `PsycheCoreTests` unit
/// test target and is staged here (outside every XcodeGen-scanned path) so the
/// committed project stays clean until the owning integration change registers
/// it. Registration: move beside the other `PsycheCoreTests` sources, run
/// `pnpm ios:project:generate`, then `pnpm ios:project:check`; the `iOS Core`
/// CI job then compiles and runs this suite on macOS with the pinned Xcode.
final class VimKeyboardAdapterTests: XCTestCase {

    // MARK: Fixture plumbing

    /// Deliberately a failure, not an XCTSkip: a missing or malformed fixture
    /// file is exactly the contract breaking, and a skip would let it pass
    /// CI unnoticed — the silent-pass failure mode these tests exist to stop.
    private func loadSharedFixture() throws -> VimFixtureDocument {
        let fixtureURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // -> Vim/
            .deletingLastPathComponent()  // -> Conformance/
            .deletingLastPathComponent()  // -> PsycheCore/
            .deletingLastPathComponent()  // -> ios/
            .deletingLastPathComponent()  // -> native/
            .deletingLastPathComponent()  // -> repo root
            .appendingPathComponent("protocol-fixtures")
            .appendingPathComponent("vim")
            .appendingPathComponent("v1")
            .appendingPathComponent("chrome.json")
        let raw = try Data(contentsOf: fixtureURL)
        return try JSONDecoder().decode(VimFixtureDocument.self, from: raw)
    }

    private func key(_ key: String, ctrl: Bool = false, alt: Bool = false, shift: Bool = false, meta: Bool = false) -> VimNormalizedKey {
        VimKeyNormalizer.normalize(VimKeyboardEvent(
            key: key, ctrlKey: ctrl, altKey: alt, shiftKey: shift, metaKey: meta
        ))
    }

    /// Enabled machine already inside chrome-normal (trigger replayed at 0).
    private func makeChromeMachine() throws -> VimChromeMachine {
        var machine = try VimChromeMachine(enabled: true)
        _ = machine.handle(.f6, now: .zero)
        return machine
    }

    // MARK: Shared v1 fixture document

    func testLoadsAndValidatesTheSharedV1ChromeFixture() throws {
        let document = try loadSharedFixture()
        try VimFixtures.validate(document)
        XCTAssertEqual(document.version, "vim/v1")
        XCTAssertEqual(
            document.traces.map(\.id),
            ["chrome-enter-f6", "chrome-focus-first", "chrome-pane-focus-left"],
            "the v1 chrome trace set is fixed; a change here is a contract change"
        )
    }

    func testReplaysEveryV1ChromeTraceThroughTheSwiftMachine() throws {
        let document = try loadSharedFixture()
        let outcomes = VimFixtures.replay(document)
        XCTAssertEqual(outcomes.count, document.traces.count)
        for outcome in outcomes {
            XCTAssertTrue(outcome.matched, "\(outcome.id) mismatched: \(outcome.detail)")
        }
    }

    func testReplaysEachV1ChromeTraceWithItsExpectedSemanticResult() throws {
        let document = try loadSharedFixture()
        let outcomesByID = Dictionary(uniqueKeysWithValues: VimFixtures.replay(document).map { ($0.id, $0) })

        // chrome-enter-f6: F6 from passthrough consumes and enters chrome mode.
        XCTAssertTrue(try XCTUnwrap(outcomesByID["chrome-enter-f6"]).matched)
        // chrome-focus-first: g g from chrome-normal emits focus.first.
        XCTAssertTrue(try XCTUnwrap(outcomesByID["chrome-focus-first"]).matched)
        // chrome-pane-focus-left: Ctrl-w h from chrome-normal emits pane.focus left.
        XCTAssertTrue(try XCTUnwrap(outcomesByID["chrome-pane-focus-left"]).matched)
    }

    // MARK: Machine semantics (mirrors the shared contract suite)

    func testEntersChromeWithF6AndExitsOnEscape() throws {
        var machine = try VimChromeMachine(enabled: true)

        let enter = machine.handle(.f6, now: .zero)
        XCTAssertEqual(enter.disposition, .action)
        XCTAssertEqual(enter.context, .chromeNormal)
        XCTAssertEqual(enter.pending, "")
        XCTAssertEqual(enter.actions, [.chromeEnter])

        let exit = machine.handle(key("Esc"), now: .zero)
        XCTAssertEqual(exit.disposition, .action)
        XCTAssertEqual(exit.context, .passthrough)
        XCTAssertEqual(exit.pending, "")
        XCTAssertEqual(exit.actions, [.chromeExit])
    }

    func testDisabledMachinePassesEverythingThrough() throws {
        var machine = try VimChromeMachine(enabled: false)

        let f6 = machine.handle(.f6, now: .zero)
        XCTAssertEqual(f6.disposition, .passthrough)
        XCTAssertEqual(f6.context, .disabled)
        XCTAssertEqual(f6.actions, [])

        let other = machine.handle(key("x"), now: .zero)
        XCTAssertEqual(other.disposition, .passthrough)
        XCTAssertEqual(other.context, .disabled)
    }

    func testEmitsFocusFirstForGG() throws {
        var machine = try makeChromeMachine()

        XCTAssertEqual(machine.handle(key("g"), now: .zero).disposition, .pending)
        let second = machine.handle(key("g"), now: .zero)
        XCTAssertEqual(second.disposition, .action)
        XCTAssertEqual(second.pending, "")
        XCTAssertEqual(second.actions, [.focusFirst])
    }

    func testDistinguishesShiftedGAndNAfterNormalization() throws {
        var machine = try makeChromeMachine()

        let last = machine.handle(key("G", shift: true), now: .zero)
        XCTAssertEqual(last.actions, [.focusLast])

        _ = machine.handle(key("/"), now: .zero)
        let previous = machine.handle(key("N", shift: true), now: .zero)
        XCTAssertEqual(previous.actions, [.searchPrevious])
    }

    func testEmitsPaneFocusLeftForCtrlWH() throws {
        var machine = try makeChromeMachine()

        let prefix = machine.handle(VimNormalizedKey(key: "w", ctrl: true), now: .zero)
        XCTAssertEqual(prefix.disposition, .pending)
        XCTAssertEqual(prefix.pending, "Ctrl-w")

        let focus = machine.handle(key("h"), now: .zero)
        XCTAssertEqual(focus.disposition, .action)
        XCTAssertEqual(focus.pending, "")
        XCTAssertEqual(focus.actions, [.paneFocus(.left)])
    }

    func testConsumesUnsupportedChromePrefixes() throws {
        var machine = try makeChromeMachine()
        _ = machine.handle(key("g"), now: .zero)

        let unsupported = machine.handle(key("x"), now: .zero)
        XCTAssertEqual(unsupported.disposition, .unsupported)
        XCTAssertEqual(unsupported.context, .chromeNormal)
        XCTAssertEqual(unsupported.pending, "")
        XCTAssertEqual(unsupported.actions, [])
    }

    func testRequiresExactModifiers() throws {
        var machine = try makeChromeMachine()
        _ = machine.handle(key("g"), now: .zero)

        // A shifted g after a pending g is not focus.first: normalization
        // lowercases the letter and the machine requires exact modifiers.
        XCTAssertEqual(machine.handle(key("G", shift: true), now: .zero).disposition, .unsupported)
        XCTAssertEqual(machine.handle(key("H", shift: true), now: .zero).disposition, .unsupported)
        XCTAssertEqual(machine.handle(key("X", shift: true), now: .zero).disposition, .unsupported)
        XCTAssertEqual(
            machine.handle(key("w", ctrl: true, shift: true), now: .zero).disposition,
            .unsupported
        )
    }

    func testResetsPendingOnTimeoutAndFocusLoss() throws {
        var machine = try VimChromeMachine(enabled: true, timeoutMs: 1000)
        _ = machine.handle(.f6, now: .zero)
        _ = machine.handle(key("g"), now: .zero)

        // Expired prefixes are dropped before the next key is classified.
        let expired = machine.handle(key("g"), now: .milliseconds(1001))
        XCTAssertEqual(expired.disposition, .pending)
        XCTAssertEqual(expired.pending, "g")

        _ = machine.focusLost()
        XCTAssertEqual(machine.pending, "")
        let fresh = machine.handle(key("g"), now: .milliseconds(1001))
        XCTAssertEqual(fresh.disposition, .pending)
        XCTAssertEqual(fresh.pending, "g")
    }

    func testModeDisabledResetDropsPendingAndExitsChrome() throws {
        var machine = try makeChromeMachine()
        _ = machine.handle(key("g"), now: .zero)

        let reset = machine.reset(.modeDisabled)
        XCTAssertEqual(reset.context, .disabled)
        XCTAssertEqual(reset.pending, "")

        // Native input behavior resumes: even the trigger passes through.
        XCTAssertEqual(machine.handle(.f6, now: .zero).disposition, .passthrough)
    }

    func testFocusLostClearsPendingWithoutLeavingChrome() throws {
        var machine = try makeChromeMachine()
        _ = machine.handle(key("g"), now: .zero)

        let afterFocusLoss = machine.focusLost()
        XCTAssertEqual(afterFocusLoss.context, .chromeNormal)
        XCTAssertEqual(afterFocusLoss.pending, "")
        XCTAssertEqual(machine.handle(key("g"), now: .zero).pending, "g")
    }

    // MARK: Software Chrome key and normalization

    /// The accessible software Chrome key is the software-keyboard equivalent
    /// of the hardware trigger: it normalizes to the same token, produces the
    /// same `chrome.enter` result, and is consumed — entering application
    /// chrome mode never manufactures a terminal `F6` sequence.
    func testSoftwareChromeKeyMatchesHardwareF6() throws {
        var machine = try VimChromeMachine(enabled: true)
        let viaSoftwareKey = machine.handle(VimNormalizedKey.f6, now: .zero)
        XCTAssertEqual(viaSoftwareKey.actions, [.chromeEnter])
        XCTAssertNotEqual(viaSoftwareKey.disposition, .passthrough)

        var hardwarePath = try VimChromeMachine(enabled: true)
        let viaHardware = hardwarePath.handle(VimKeyNormalizer.normalize(VimKeyboardEvent(key: "F6")), now: .zero)
        XCTAssertEqual(viaHardware, viaSoftwareKey)
    }

    func testNormalizesHardwareKeyEventsWithoutPlatformImports() {
        XCTAssertEqual(
            VimKeyNormalizer.normalize(VimKeyboardEvent(key: "H", ctrlKey: true, shiftKey: true)),
            VimNormalizedKey(key: "h", ctrl: true, alt: false, shift: true, meta: false)
        )
        XCTAssertEqual(VimKeyNormalizer.normalize(VimKeyboardEvent(key: "Esc")).key, "Escape")
        XCTAssertEqual(VimKeyNormalizer.normalize(VimKeyboardEvent(key: "Spacebar")).key, " ")
        XCTAssertEqual(VimKeyNormalizer.normalize(VimKeyboardEvent(key: "F6")).key, "F6")
    }

    // MARK: Trigger configuration

    func testConfigurableTriggerChordReplacesF6() throws {
        var machine = try VimChromeMachine(enabled: true, triggerChord: "Ctrl-Alt-F6")

        XCTAssertEqual(machine.handle(.f6, now: .zero).disposition, .passthrough)
        let enter = machine.handle(VimNormalizedKey(key: "F6", ctrl: true, alt: true), now: .zero)
        XCTAssertEqual(enter.actions, [.chromeEnter])
    }

    func testRejectsMalformedTriggerChords() {
        XCTAssertThrowsError(try VimChromeTrigger(chord: "Ctrl-Ctrl-F6"))
        XCTAssertThrowsError(try VimChromeTrigger(chord: "Ctrl-Hyper-F6"))
        XCTAssertThrowsError(try VimChromeTrigger(chord: "Ctrl"))
        XCTAssertThrowsError(try VimChromeTrigger(chord: ""))
    }

    func testSettingsSanitizationFallsBackSafely() {
        let sanitized = VimKeyboardSettings.sanitizing(
            enabled: nil,
            triggerChord: "Ctrl-Hyper-F6",
            timeoutMs: 99_999,
            relativeLineNumbers: nil,
            clipboard: nil
        )
        XCTAssertEqual(sanitized.vimModeEnabled, false)
        XCTAssertEqual(sanitized.vimChromeTrigger, VimNormalizedKey.f6)
        XCTAssertEqual(sanitized.vimSequenceTimeoutMs, 3000)

        let defaults = VimKeyboardSettings.sanitizing(
            enabled: nil, triggerChord: nil, timeoutMs: nil, relativeLineNumbers: nil, clipboard: nil
        )
        XCTAssertEqual(defaults, VimKeyboardSettings.default)
    }

    func testMachineRefusesOutOfRangeTimeout() {
        XCTAssertThrowsError(try VimChromeMachine(enabled: true, timeoutMs: 249))
        XCTAssertThrowsError(try VimChromeMachine(enabled: true, timeoutMs: 3001))
        XCTAssertNoThrow(try VimChromeMachine(enabled: true, timeoutMs: 250))
        XCTAssertNoThrow(try VimChromeMachine(enabled: true, timeoutMs: 3000))
    }

    // MARK: Fixture validation bounds

    func testFixtureValidationRejectsDuplicateIDsAndOversizedDocuments() throws {
        let document = try loadSharedFixture()
        let first = try XCTUnwrap(document.traces.first)

        XCTAssertThrowsError(try VimFixtures.validate(
            VimFixtureDocument(version: document.version, traces: [first, first])
        )) { error in
            XCTAssertTrue("\(error)".contains("duplicate"), "unexpected error: \(error)")
        }

        let oversized = VimFixtureDocument(
            version: document.version,
            traces: Array(repeating: first, count: VimFixtures.maxTraceCount + 1)
        )
        XCTAssertThrowsError(try VimFixtures.validate(oversized)) { error in
            XCTAssertTrue("\(error)".contains("trace count"), "unexpected error: \(error)")
        }

        let longToken = VimFixtureToken(key: "g")
        XCTAssertThrowsError(try VimFixtures.validate(
            VimFixtureDocument(
                version: document.version,
                traces: [trace(from: first, sequence: Array(repeating: longToken, count: VimFixtures.maxSequenceLength + 1))]
            )
        )) { error in
            XCTAssertTrue("\(error)".contains("32"), "unexpected error: \(error)")
        }

        let tooManyActions = VimFixtureDocument(
            version: document.version,
            traces: [trace(from: first, actions: Array(repeating: VimAction.focusFirst, count: VimFixtures.maxActionCount + 1))]
        )
        XCTAssertThrowsError(try VimFixtures.validate(tooManyActions)) { error in
            XCTAssertTrue("\(error)".contains("action count"), "unexpected error: \(error)")
        }

        let longID = VimFixtureDocument(
            version: document.version,
            traces: [trace(from: first, id: String(repeating: "x", count: VimFixtures.maxStringLength + 1))]
        )
        XCTAssertThrowsError(try VimFixtures.validate(longID)) { error in
            XCTAssertTrue("\(error)".contains("invalid string"), "unexpected error: \(error)")
        }
    }

    func testFixtureDecodeRejectsUnknownVocabulary() {
        for (name, json) in Self.invalidDocuments {
            XCTAssertThrowsError(
                try JSONDecoder().decode(VimFixtureDocument.self, from: Data(json.utf8)),
                "\(name) must fail to decode"
            )
        }
    }

    func testVimResultRoundTripsThroughTheWireShape() throws {
        let result = VimResult(
            disposition: .action,
            context: .chromeNormal,
            pending: "",
            actions: [.paneFocus(.left), .paneResize(.widen)]
        )
        let encoded = try JSONEncoder().encode(result)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertEqual(object["disposition"] as? String, "action")
        XCTAssertEqual(object["pending"] as? String, "")

        let actions = try XCTUnwrap(object["actions"] as? [[String: Any]])
        XCTAssertEqual(actions.count, 2)
        XCTAssertEqual(actions[0]["type"] as? String, "pane.focus")
        XCTAssertEqual(actions[0]["direction"] as? String, "left")
        XCTAssertEqual(actions[1]["type"] as? String, "pane.resize")
        XCTAssertEqual(actions[1]["direction"] as? String, "widen")

        let decoded = try JSONDecoder().decode(VimResult.self, from: encoded)
        XCTAssertEqual(decoded, result)
    }

    // MARK: Helpers

    private func trace(
        from base: VimFixtureTrace,
        id: String? = nil,
        sequence: [VimFixtureToken]? = nil,
        actions: [VimAction]? = nil
    ) -> VimFixtureTrace {
        VimFixtureTrace(
            id: id ?? base.id,
            context: base.context,
            sequence: sequence ?? base.sequence,
            disposition: base.disposition,
            expected: base.expected,
            actions: actions ?? base.actions
        )
    }

    /// Invalid documents that must be rejected at decode time (strict Codable
    /// vocabulary), keyed by a readable label for the failure message.
    private static let invalidDocuments: [(name: String, json: String)] = [
        (
            "unknown context",
            """
            {"version":"vim/v1","traces":[{"id":"t1","context":"unknown","sequence":[{"key":"g"}],"disposition":"action","expected":{"context":"chrome-normal","pending":""},"actions":[{"type":"focus.first"}]}]}
            """
        ),
        (
            "unknown disposition",
            """
            {"version":"vim/v1","traces":[{"id":"t1","context":"passthrough","sequence":[{"key":"F6"}],"disposition":"exploded","expected":{"context":"chrome-normal","pending":""},"actions":[{"type":"chrome.enter"}]}]}
            """
        ),
        (
            "unknown action type",
            """
            {"version":"vim/v1","traces":[{"id":"t1","context":"passthrough","sequence":[{"key":"F6"}],"disposition":"action","expected":{"context":"chrome-normal","pending":""},"actions":[{"type":"hyper.jump"}]}]}
            """
        ),
        (
            "missing direction",
            """
            {"version":"vim/v1","traces":[{"id":"t1","context":"chrome-normal","sequence":[{"key":"w","ctrl":true},{"key":"h"}],"disposition":"action","expected":{"context":"chrome-normal","pending":""},"actions":[{"type":"pane.focus"}]}]}
            """
        ),
        (
            "string modifier",
            """
            {"version":"vim/v1","traces":[{"id":"t1","context":"passthrough","sequence":[{"key":"g","ctrl":"true"}],"disposition":"pending","expected":{"context":"chrome-normal","pending":"g"},"actions":[]}]}
            """
        ),
    ]
}
