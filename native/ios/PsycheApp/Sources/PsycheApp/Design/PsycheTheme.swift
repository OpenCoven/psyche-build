import PsycheCore
import SwiftUI

/// One palette, one accent. Mint is the only accent colour in the app; amber
/// is reserved for "this needs you" and never used decoratively, so a warm dot
/// anywhere in the UI always means the same thing.
///
/// The terminal tokens have no caller yet — the pane workspace that used them
/// was removed with the demo drill-down and is rebuilt in the terminal phase.
/// They stay because they define the palette, not because something reads them.
enum PsycheTheme {
    static let background = Color(red: 0.045, green: 0.061, blue: 0.075)
    static let terminal = Color(red: 0.024, green: 0.035, blue: 0.045)
    static let terminalText = Color(red: 0.78, green: 0.84, blue: 0.82)
    static let key = Color(red: 0.10, green: 0.14, blue: 0.16)
    static let border = Color.white.opacity(0.11)
    static let mint = Color(red: 0.24, green: 0.91, blue: 0.69)
    static let amber = Color(red: 1.0, green: 0.71, blue: 0.27)

    /// The minimum tappable edge Apple's HIG requires. Rows that carry their
    /// own layout state it explicitly rather than hoping padding adds up.
    static let minimumTapTarget: CGFloat = 44
}

/// What a pane's dot is saying.
///
/// Kept separate from the colour so the rule is testable, and derived from the
/// same status sets the Now sections group by — a pane in Running and a pane
/// showing a live dot must never disagree.
enum PaneIndicator: Equatable {
    case needsAttention
    case running
    case quiet

    static func forStatus(_ status: String, needsAttention: Bool) -> PaneIndicator {
        let status = status.lowercased()
        if needsAttention || NowSectionKind.attentionStatuses.contains(status) {
            return .needsAttention
        }
        if NowSectionKind.runningStatuses.contains(status) {
            return .running
        }
        return .quiet
    }

    var color: Color {
        switch self {
        case .needsAttention: PsycheTheme.amber
        case .running: PsycheTheme.mint
        case .quiet: .gray
        }
    }
}

/// The dot beside a pane. Hidden from VoiceOver on purpose: the row's combined
/// label already states the status, so exposing it again would say it twice.
struct WorkspaceStatusDot: View {
    let status: String
    let needsAttention: Bool

    private var indicator: PaneIndicator {
        PaneIndicator.forStatus(status, needsAttention: needsAttention)
    }

    var body: some View {
        Circle()
            .fill(indicator.color)
            .frame(width: 9, height: 9)
            .accessibilityHidden(true)
    }
}
