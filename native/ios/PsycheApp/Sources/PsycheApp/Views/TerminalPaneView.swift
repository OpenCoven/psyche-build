import PsycheCore
import SwiftUI

/// One live terminal. Renders only the registry buffer for its own pane, so a
/// pane that is not on screen has no view and no subscription behind it.
struct TerminalPaneView: View {
    @EnvironmentObject private var registry: TerminalSessionRegistry
    let paneID: String
    let title: String
    let isFocused: Bool
    let onFocus: () -> Void

    private var output: String {
        String(decoding: registry.outputByPaneID[paneID] ?? Data(), as: UTF8.self)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(PsycheTheme.border)
            ScrollViewReader { proxy in
                ScrollView {
                    Text(output)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(PsycheTheme.terminalText)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                        .padding(10)
                        .id("terminal-end-\(paneID)")
                }
                .onChange(of: registry.outputByPaneID[paneID]?.count ?? 0) {
                    proxy.scrollTo("terminal-end-\(paneID)", anchor: .bottom)
                }
            }
            .background(PsycheTheme.terminal)
        }
        .overlay(alignment: .top) {
            // A border rather than a tint: the focused pane has to be obvious
            // at a glance when two terminals are side by side.
            Rectangle()
                .fill(isFocused ? PsycheTheme.mint : Color.clear)
                .frame(height: 2)
        }
        .contentShape(Rectangle())
        .onTapGesture(perform: onFocus)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("terminal-pane-\(paneID)")
        .accessibilityLabel("\(title) terminal")
        .accessibilityAddTraits(isFocused ? [.isSelected] : [])
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text(title)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
            if isFocused {
                Text("Focused")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(PsycheTheme.mint)
                    .accessibilityIdentifier("terminal-focus-badge-\(paneID)")
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(minHeight: 32)
        .background(PsycheTheme.background)
    }
}
