import SwiftUI
import PsycheCore

struct CockpitView: View {
    @EnvironmentObject private var store: DemoStore

    var body: some View {
        NavigationSplitView {
            projectSidebar
                .navigationTitle("Psyche")
        } content: {
            paneList
                .navigationTitle("Panes")
        } detail: {
            TerminalDetail(pane: store.selectedPane)
                .navigationTitle(store.selectedPane.snapshot.displayName)
        }
        .tint(PsycheTheme.mint)
        .background(PsycheTheme.background)
        .accessibilityIdentifier("main-cockpit")
        .sheet(isPresented: $store.isPairSheetPresented) {
            PairHostSheet()
        }
    }

    private var projectSidebar: some View {
        List(selection: $store.selectedProjectID) {
            Section("Projects") {
                ForEach(store.projects) { project in
                    HStack(spacing: 10) {
                        Image(systemName: "folder.fill")
                            .foregroundStyle(PsycheTheme.mint)
                        Text(project.displayName)
                        Spacer()
                        if project.attentionCount > 0 {
                            Text("\(project.attentionCount)")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(.black)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 3)
                                .background(PsycheTheme.amber, in: Capsule())
                        }
                    }
                    .tag(project.id)
                }
            }

            Section {
                Button {
                    store.isPairSheetPresented = true
                } label: {
                    Label("Pair a host", systemImage: "antenna.radiowaves.left.and.right")
                }
            }
        }
        .listStyle(.sidebar)
    }

    private var paneList: some View {
        List(selection: $store.selectedPaneID) {
            ForEach(store.panes(for: store.selectedProjectID)) { pane in
                PaneRow(pane: pane)
                    .tag(pane.id)
            }
        }
        .overlay {
            if store.panes(for: store.selectedProjectID).isEmpty {
                ContentUnavailableView("No panes", systemImage: "rectangle.stack")
            }
        }
    }
}

private struct PaneRow: View {
    let pane: DemoStore.DemoPane

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(pane.snapshot.displayName)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Spacer()
                StatusDot(status: pane.snapshot.status)
            }
            HStack(spacing: 6) {
                Image(systemName: "point.3.connected.trianglepath.dotted")
                Text(pane.snapshot.agent ?? pane.snapshot.kind)
                Text("·")
                Text(pane.branch)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        .padding(.vertical, 5)
    }
}

struct TerminalDetail: View {
    let pane: DemoStore.DemoPane

    var body: some View {
        VStack(spacing: 0) {
            terminalHeader
            Divider().overlay(PsycheTheme.border)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 5) {
                    ForEach(Array(pane.output.enumerated()), id: \.offset) { _, line in
                        Text(line.isEmpty ? " " : line)
                            .font(.system(.footnote, design: .monospaced))
                            .foregroundStyle(line.hasPrefix("✓") ? PsycheTheme.mint : PsycheTheme.terminalText)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(18)
            }
            .background(PsycheTheme.terminal)
            .accessibilityIdentifier("terminal-output")
            Divider().overlay(PsycheTheme.border)
            CodingKeyRow()
        }
        .background(PsycheTheme.background)
    }

    private var terminalHeader: some View {
        HStack(spacing: 12) {
            StatusDot(status: pane.snapshot.status)
            VStack(alignment: .leading, spacing: 2) {
                Text(pane.host)
                    .font(.caption.weight(.semibold))
                Text("\(pane.branch)  ·  \(pane.snapshot.agent ?? pane.snapshot.kind)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Text(pane.snapshot.status.rawValue.uppercased())
                .font(.caption2.weight(.bold))
                .foregroundStyle(statusColor)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(statusColor.opacity(0.16), in: Capsule())
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private var statusColor: Color {
        switch pane.snapshot.status {
        case .working: PsycheTheme.mint
        case .waiting: PsycheTheme.amber
        case .idle, .unknown: .secondary
        }
    }
}

struct CodingKeyRow: View {
    private let keys = ["Ctrl", "Alt", "Esc", "Tab", "←", "↑", "↓", "→", "↵"]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(keys, id: \.self) { key in
                    Button(key) {}
                        .font(.system(.caption, design: .monospaced).weight(.semibold))
                        .foregroundStyle(PsycheTheme.terminalText)
                        .frame(minWidth: key.count > 2 ? 42 : 34, minHeight: 32)
                        .background(PsycheTheme.key, in: RoundedRectangle(cornerRadius: 7))
                        .overlay {
                            RoundedRectangle(cornerRadius: 7)
                                .stroke(PsycheTheme.border, lineWidth: 1)
                        }
                        .accessibilityLabel(key == "↵" ? "Enter" : key)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
        }
        .background(PsycheTheme.background)
        .accessibilityIdentifier("coding-key-row")
    }
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

struct PairHostSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 20) {
                Image(systemName: "laptopcomputer.and.iphone")
                    .font(.system(size: 42))
                    .foregroundStyle(PsycheTheme.mint)
                Text("Pair a Psyche host")
                    .font(.title2.weight(.bold))
                Text("Enter the short code shown by your Psyche host. This runnable foundation uses demo data; live pairing arrives with the transport implementation.")
                    .foregroundStyle(.secondary)
                TextField("Six-digit pairing code", text: .constant(""))
                    .textFieldStyle(.roundedBorder)
                    .disabled(true)
                Spacer()
            }
            .padding(24)
            .navigationTitle("New connection")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium])
    }
}

enum PsycheTheme {
    static let background = Color(red: 0.045, green: 0.061, blue: 0.075)
    static let terminal = Color(red: 0.024, green: 0.035, blue: 0.045)
    static let terminalText = Color(red: 0.78, green: 0.84, blue: 0.82)
    static let key = Color(red: 0.10, green: 0.14, blue: 0.16)
    static let border = Color.white.opacity(0.11)
    static let mint = Color(red: 0.24, green: 0.91, blue: 0.69)
    static let amber = Color(red: 1.0, green: 0.71, blue: 0.27)
}
