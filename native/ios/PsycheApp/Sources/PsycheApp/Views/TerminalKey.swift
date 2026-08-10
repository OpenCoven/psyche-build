import Foundation

/// The keys a phone keyboard cannot produce but a terminal needs.
///
/// The byte sequences are the contract with the PTY, so they live apart from
/// the buttons that send them and are asserted directly. A wrong escape here
/// does not look wrong on screen — it just makes the arrow keys do nothing.
enum TerminalKey: String, CaseIterable, Identifiable {
    case escape
    case tab
    case control
    case alt
    case up
    case down
    case left
    case right
    case enter

    var id: String { rawValue }

    var label: String {
        switch self {
        case .escape: "esc"
        case .tab: "tab"
        case .control: "ctrl"
        case .alt: "alt"
        case .up: "↑"
        case .down: "↓"
        case .left: "←"
        case .right: "→"
        case .enter: "return"
        }
    }

    /// Spoken names, because "↑" reads as nothing useful.
    var accessibilityLabel: String {
        switch self {
        case .escape: "Escape"
        case .tab: "Tab"
        case .control: "Control"
        case .alt: "Alt"
        case .up: "Up arrow"
        case .down: "Down arrow"
        case .left: "Left arrow"
        case .right: "Right arrow"
        case .enter: "Return"
        }
    }

    var accessibilityIdentifier: String { "terminal-key-\(rawValue)" }

    /// Modifiers arm the next character or key rather than sending anything
    /// themselves.
    var isModifier: Bool { self == .control || self == .alt }

    var bytes: Data? {
        switch self {
        case .escape: Data([0x1B])
        case .tab: Data([0x09])
        // Carriage return, not newline. A PTY in canonical mode treats CR as
        // "the user pressed return"; LF would insert a blank line instead.
        case .enter: Data([0x0D])
        case .up: Self.csi([0x41])
        case .down: Self.csi([0x42])
        case .right: Self.csi([0x43])
        case .left: Self.csi([0x44])
        case .control, .alt: nil
        }
    }

    /// ESC [ … — the escape sequence a terminal reads as a cursor key.
    private static func csi(_ trailing: [UInt8]) -> Data {
        Data([0x1B, 0x5B] + trailing)
    }
}

struct TerminalModifiers: OptionSet, Sendable {
    let rawValue: UInt8

    static let control = TerminalModifiers(rawValue: 1 << 0)
    static let alt = TerminalModifiers(rawValue: 1 << 1)
}

enum TerminalInput {
    /// Ctrl-<letter> is the letter with its top bits cleared: Ctrl-C is 0x03,
    /// Ctrl-D is 0x04. ASCII punctuation from @ through _ follows the same
    /// mapping, while Ctrl-? is DEL.
    static func controlSequence(for character: Character) -> Data? {
        guard character.unicodeScalars.count == 1,
              let scalar = character.unicodeScalars.first,
              scalar.value <= 0x7F else {
            return nil
        }

        var ascii = UInt8(scalar.value)
        if ascii >= 0x61, ascii <= 0x7A {
            ascii -= 0x20
        }
        if ascii == 0x3F {
            return Data([0x7F])
        }
        guard ascii >= 0x40, ascii <= 0x5F else { return nil }
        return Data([ascii - 0x40])
    }

    static func sequence(
        for key: TerminalKey,
        modifiers: TerminalModifiers = []
    ) -> Data? {
        guard !key.isModifier else { return nil }

        let base: Data?
        if modifiers.contains(.control) {
            base = controlSequence(for: key)
        } else {
            base = key.bytes
        }
        guard let base else { return nil }
        return modifiers.contains(.alt) ? Data([0x1B]) + base : base
    }

    static func characterSequence(
        for text: String,
        modifiers: TerminalModifiers
    ) -> Data? {
        guard text.count == 1, let character = text.first else { return nil }

        let base: Data?
        if modifiers.contains(.control) {
            base = controlSequence(for: character)
        } else {
            base = Data(String(character).utf8)
        }
        guard let base else { return nil }
        return modifiers.contains(.alt) ? Data([0x1B]) + base : base
    }

    /// A submitted line carries its own return, so the shell runs it rather
    /// than leaving it sitting at the prompt.
    static func submission(of text: String) -> Data {
        Data(text.utf8) + Data([0x0D])
    }

    private static func controlSequence(for key: TerminalKey) -> Data? {
        switch key {
        case .escape:
            Data([0x1B])
        case .tab:
            Data([0x09])
        case .enter:
            Data([0x0D])
        case .up:
            modifiedArrow(0x41)
        case .down:
            modifiedArrow(0x42)
        case .right:
            modifiedArrow(0x43)
        case .left:
            modifiedArrow(0x44)
        case .control, .alt:
            nil
        }
    }

    /// Xterm's modifier parameter 5 means Ctrl.
    private static func modifiedArrow(_ finalByte: UInt8) -> Data {
        Data([0x1B, 0x5B, 0x31, 0x3B, 0x35, finalByte])
    }
}
