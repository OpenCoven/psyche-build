import PsycheCore
import SwiftUI

/// Chooses which pane the workspace shows.
///
/// Every chip is drawn from the workspace snapshot — a title, a status dot —
/// never from a terminal view. Previewing a pane by instantiating its terminal
/// would attach a stream for something nobody is looking at, which is exactly
/// what the two-session cap exists to prevent.
struct PaneSwitcher: View {
    let panes: [PaneChoice]
    let primaryPaneID: String?
    let secondaryPaneID: String?
    let canSplit: Bool
    let onSelect: (String) -> Void
    let onSplit: (String) -> Void

    struct PaneChoice: Identifiable, Equatable {
        let id: String
        let title: String
        let status: String
        let needsAttention: Bool
    }

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(panes) { pane in
                    chip(for: pane)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .scrollIndicators(.hidden)
        .background(PsycheTheme.background)
        .accessibilityIdentifier("pane-switcher")
    }

    private func chip(for pane: PaneChoice) -> some View {
        let isPrimary = pane.id == primaryPaneID
        let isSecondary = pane.id == secondaryPaneID
        let isShown = isPrimary || isSecondary

        return Button {
            onSelect(pane.id)
        } label: {
            HStack(spacing: 6) {
                WorkspaceStatusDot(status: pane.status, needsAttention: pane.needsAttention)
                Text(pane.title)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
            }
            .padding(.horizontal, 12)
            .frame(minHeight: PsycheTheme.minimumTapTarget)
            .background(
                isShown ? PsycheTheme.mint.opacity(0.16) : Color.white.opacity(0.06),
                in: Capsule()
            )
            .overlay(
                Capsule().stroke(isShown ? PsycheTheme.mint : Color.clear, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("pane-chip-\(pane.id)")
        .accessibilityLabel(chipLabel(pane, isPrimary: isPrimary, isSecondary: isSecondary))
        .accessibilityAddTraits(isShown ? [.isSelected] : [])
        .contextMenu {
            if canSplit, !isShown {
                Button("Open beside") { onSplit(pane.id) }
            }
        }
    }

    private func chipLabel(_ pane: PaneChoice, isPrimary: Bool, isSecondary: Bool) -> String {
        var parts = [pane.title, pane.status]
        if isPrimary { parts.append("shown") }
        if isSecondary { parts.append("shown beside") }
        if pane.needsAttention { parts.append("needs you") }
        return parts.joined(separator: ", ")
    }
}
