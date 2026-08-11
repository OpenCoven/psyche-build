import Foundation
import XCTest
@testable import Psyche_Build

@MainActor
final class TerminalKeyTests: XCTestCase {

    // MARK: - Byte sequences

    func testEveryKeySendsTheSequenceATerminalExpects() {
        let expected: [TerminalKey: [UInt8]?] = [
            .escape: [0x1B],
            .tab: [0x09],
            .control: nil,
            .alt: nil,
            .up: [0x1B, 0x5B, 0x41],
            .down: [0x1B, 0x5B, 0x42],
            .right: [0x1B, 0x5B, 0x43],
            .left: [0x1B, 0x5B, 0x44],
            .enter: [0x0D],
        ]

        XCTAssertEqual(Set(expected.keys), Set(TerminalKey.allCases))
        for (key, bytes) in expected {
            XCTAssertEqual(
                key.bytes.map(Array.init),
                bytes,
                "\(key.rawValue) sends the wrong sequence"
            )
        }
    }

    /// A modifier arms the next key rather than sending anything itself.
    func testControlAndAltAreModifiersAndSendNothingOnTheirOwn() {
        for key in [TerminalKey.control, .alt] {
            XCTAssertTrue(key.isModifier, key.rawValue)
            XCTAssertNil(key.bytes, key.rawValue)
        }
        for key in TerminalKey.allCases where ![.control, .alt].contains(key) {
            XCTAssertFalse(key.isModifier, key.rawValue)
            XCTAssertNotNil(key.bytes, key.rawValue)
        }
    }

    /// Return is a carriage return. A newline would insert a blank line
    /// instead of running the line, which looks like the terminal ignoring you.
    func testReturnIsCarriageReturnNotNewline() {
        XCTAssertEqual(TerminalKey.enter.bytes.map(Array.init), [0x0D])
        XCTAssertNotEqual(TerminalKey.enter.bytes.map(Array.init), [0x0A])
    }

    func testArrowKeysAreDistinctSequences() {
        let arrows = [TerminalKey.up, .down, .left, .right].compactMap(\.bytes)
        XCTAssertEqual(Set(arrows).count, 4, "Two arrow keys share a sequence")
    }

    func testEveryKeyHasASpokenNameThatIsNotItsGlyph() {
        for key in TerminalKey.allCases {
            XCTAssertFalse(key.accessibilityLabel.isEmpty, key.rawValue)
            XCTAssertFalse(
                key.accessibilityLabel.contains("↑") || key.accessibilityLabel.contains("→"),
                "\(key.rawValue) would be read out as a glyph"
            )
        }
    }

    func testEveryKeyHasAStableAccessibilityIdentifier() {
        for key in TerminalKey.allCases {
            XCTAssertEqual(key.accessibilityIdentifier, "terminal-key-\(key.rawValue)")
        }
    }

    // MARK: - Control sequences

    func testControlLettersMapToTheirControlCodes() {
        XCTAssertEqual(TerminalInput.controlSequence(for: "c").map(Array.init), [0x03])
        XCTAssertEqual(TerminalInput.controlSequence(for: "C").map(Array.init), [0x03])
        XCTAssertEqual(TerminalInput.controlSequence(for: "d").map(Array.init), [0x04])
        XCTAssertEqual(TerminalInput.controlSequence(for: "z").map(Array.init), [0x1A])
        XCTAssertEqual(TerminalInput.controlSequence(for: "l").map(Array.init), [0x0C])
    }

    func testControlPunctuationMapsToItsTerminalControlCode() {
        XCTAssertEqual(TerminalInput.controlSequence(for: "@").map(Array.init), [0x00])
        XCTAssertEqual(TerminalInput.controlSequence(for: "[").map(Array.init), [0x1B])
        XCTAssertEqual(TerminalInput.controlSequence(for: "\\").map(Array.init), [0x1C])
        XCTAssertEqual(TerminalInput.controlSequence(for: "]").map(Array.init), [0x1D])
        XCTAssertEqual(TerminalInput.controlSequence(for: "^").map(Array.init), [0x1E])
        XCTAssertEqual(TerminalInput.controlSequence(for: "_").map(Array.init), [0x1F])
        XCTAssertEqual(TerminalInput.controlSequence(for: "?").map(Array.init), [0x7F])
    }

    /// Anything without a control form is refused rather than sent as some
    /// other byte the terminal would act on.
    func testCharactersWithNoControlFormAreRefused() {
        for character: Character in ["1", "€", " ", "\u{0301}"] {
            XCTAssertNil(
                TerminalInput.controlSequence(for: character),
                "\(character) should have no control form"
            )
        }
    }

    func testControlArrowsUseXtermModifierSequences() {
        let expected: [TerminalKey: [UInt8]] = [
            .up: [0x1B, 0x5B, 0x31, 0x3B, 0x35, 0x41],
            .down: [0x1B, 0x5B, 0x31, 0x3B, 0x35, 0x42],
            .right: [0x1B, 0x5B, 0x31, 0x3B, 0x35, 0x43],
            .left: [0x1B, 0x5B, 0x31, 0x3B, 0x35, 0x44],
        ]

        for (key, bytes) in expected {
            XCTAssertEqual(
                TerminalInput.sequence(for: key, modifiers: [.control]).map(Array.init),
                bytes,
                "\(key.rawValue) does not carry the Ctrl modifier"
            )
        }
    }

    func testControlAppliesToTerminalKeysWithControlCodeEquivalents() {
        XCTAssertEqual(
            TerminalInput.sequence(for: .escape, modifiers: [.control]).map(Array.init),
            [0x1B]
        )
        XCTAssertEqual(
            TerminalInput.sequence(for: .tab, modifiers: [.control]).map(Array.init),
            [0x09]
        )
        XCTAssertEqual(
            TerminalInput.sequence(for: .enter, modifiers: [.control]).map(Array.init),
            [0x0D]
        )
    }

    // MARK: - Alt and combined modifiers

    func testAltPrefixesEveryNonModifierKeyWithEscape() {
        for key in TerminalKey.allCases where !key.isModifier {
            let plain = try! XCTUnwrap(key.bytes)
            XCTAssertEqual(
                TerminalInput.sequence(for: key, modifiers: [.alt]),
                Data([0x1B]) + plain,
                "\(key.rawValue) did not receive the Alt escape prefix"
            )
        }
    }

    func testControlAndAltCombineDeterministically() {
        XCTAssertEqual(
            TerminalInput.sequence(for: .up, modifiers: [.control, .alt]).map(Array.init),
            [0x1B, 0x1B, 0x5B, 0x31, 0x3B, 0x35, 0x41]
        )
        XCTAssertEqual(
            TerminalInput.characterSequence(for: "c", modifiers: [.control, .alt])
                .map(Array.init),
            [0x1B, 0x03]
        )
    }

    func testAltPrefixesTypedCharactersWithEscape() {
        XCTAssertEqual(
            TerminalInput.characterSequence(for: "x", modifiers: [.alt]).map(Array.init),
            [0x1B, 0x78]
        )
        XCTAssertEqual(
            TerminalInput.characterSequence(for: "é", modifiers: [.alt]).map(Array.init),
            [0x1B] + Array("é".utf8)
        )
    }

    func testModifiedTypedInputMustBeExactlyOneSupportedCharacter() {
        XCTAssertNil(TerminalInput.characterSequence(for: "", modifiers: [.alt]))
        XCTAssertNil(TerminalInput.characterSequence(for: "ab", modifiers: [.alt]))
        XCTAssertNil(TerminalInput.characterSequence(for: "1", modifiers: [.control]))
        XCTAssertNil(TerminalInput.characterSequence(for: "€", modifiers: [.control, .alt]))
    }

    // MARK: - Submission

    func testASubmittedLineCarriesItsOwnReturn() {
        let data = TerminalInput.submission(of: "ls -la")

        XCTAssertEqual(Array(data), Array("ls -la".utf8) + [0x0D])
    }

    func testSubmissionPreservesNonASCIIText() {
        let data = TerminalInput.submission(of: "echo é")

        XCTAssertEqual(Array(data), Array("echo é".utf8) + [0x0D])
    }
}
