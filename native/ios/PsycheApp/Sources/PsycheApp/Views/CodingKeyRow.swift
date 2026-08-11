import SwiftUI

/// The keys a software keyboard does not offer but a terminal needs.
struct CodingKeyRow: View {
    let isEnabled: Bool
    let armed: TerminalModifiers
    let onKey: (TerminalKey) -> Void
    let onToggleModifier: (TerminalModifiers) -> Void

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 6) {
                ForEach(TerminalKey.allCases) { key in
                    button(for: key)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
        }
        .scrollIndicators(.hidden)
        .accessibilityIdentifier("coding-key-row")
    }

    private func button(for key: TerminalKey) -> some View {
        let modifier = Self.modifier(for: key)
        let isArmed = modifier.map(armed.contains) ?? false

        return Button {
            if let modifier {
                onToggleModifier(modifier)
            } else {
                onKey(key)
            }
        } label: {
            Text(key.label)
                .font(.system(.footnote, design: .monospaced).weight(.semibold))
                .frame(minWidth: 44, minHeight: PsycheTheme.minimumTapTarget)
                .background(
                    isArmed ? PsycheTheme.mint.opacity(0.22) : PsycheTheme.key,
                    in: RoundedRectangle(cornerRadius: 8)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(isArmed ? PsycheTheme.mint : PsycheTheme.border, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .accessibilityLabel(key.accessibilityLabel)
        .accessibilityIdentifier(key.accessibilityIdentifier)
        .accessibilityAddTraits(isArmed ? [.isSelected] : [])
    }

    private static func modifier(for key: TerminalKey) -> TerminalModifiers? {
        switch key {
        case .control: .control
        case .alt: .alt
        default: nil
        }
    }
}
