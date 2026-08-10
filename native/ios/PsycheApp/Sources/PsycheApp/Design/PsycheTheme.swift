import PsycheCore
import SwiftUI

/// One palette, one accent. Mint is the only accent colour in the app; amber
/// is reserved for "this needs you" and never used decoratively, so a warm dot
/// anywhere in the UI always means the same thing.
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

struct StatusDot: View {
    let status: PaneStatus

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .shadow(color: color.opacity(0.8), radius: status == .working ? 4 : 0)
            .accessibilityLabel(status.rawValue)
    }

    private var color: Color {
        switch status {
        case .working: PsycheTheme.mint
        case .waiting: PsycheTheme.amber
        case .idle, .unknown: .gray
        }
    }
}

/// The same dot for the live workspace types, which carry status as the raw
/// host string rather than the legacy enum.
struct WorkspaceStatusDot: View {
    let status: String
    let needsAttention: Bool

    var body: some View {
        Circle()
            .fill(needsAttention ? PsycheTheme.amber : PsycheTheme.mint)
            .frame(width: 9, height: 9)
            .accessibilityHidden(true)
    }
}
