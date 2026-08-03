import SwiftUI
import PsycheCore

struct CockpitView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @EnvironmentObject private var store: DemoStore
    @State private var columnVisibility: NavigationSplitViewVisibility = .detailOnly
    @State private var preferredCompactColumn: NavigationSplitViewColumn = .detail
    @State private var didApplyInitialColumnVisibility = false

    var body: some View {
        NavigationSplitView(
            columnVisibility: $columnVisibility,
            preferredCompactColumn: $preferredCompactColumn
        ) {
            projectSidebar
                .navigationTitle("Psyche")
        } content: {
            paneList
                .navigationTitle("Panes")
        } detail: {
            Group {
                if let pane = selectedProjectPane {
                    TerminalDetail(pane: pane)
                        .navigationTitle(pane.snapshot.displayName)
                } else {
                    ContentUnavailableView(
                        "No pane selected",
                        systemImage: "rectangle.stack",
                        description: Text("Choose a project with an active pane.")
                    )
                    .accessibilityIdentifier("no-pane-detail")
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    siderailToggleButton
                }
            }
        }
        .tint(PsycheTheme.mint)
        .background(PsycheTheme.background)
        .accessibilityIdentifier("main-cockpit")
        .sheet(isPresented: $store.isPairSheetPresented) {
            PairHostSheet()
        }
        .onAppear {
            guard !didApplyInitialColumnVisibility else { return }
            columnVisibility = horizontalSizeClass == .regular ? .all : .detailOnly
            didApplyInitialColumnVisibility = true
        }
    }

    private var selectedProjectPane: DemoStore.DemoPane? {
        guard store.selectedProjectID != nil else { return nil }
        return store.panes(for: store.selectedProjectID)
            .first(where: { $0.id == store.selectedPaneID })
    }

    private var projectSidebar: some View {
        List(selection: projectSelection) {
            Section("Projects") {
                ForEach(store.projects) { project in
                    let isSelected = store.selectedProjectID == project.id

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
                    .listRowBackground(isSelected ? PsycheTheme.mint.opacity(0.12) : Color.clear)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("project-\(project.id)")
                    .accessibilityAddTraits(isSelected ? .isSelected : [])
                }
            }

            Section {
                Button {
                    store.isPairSheetPresented = true
                } label: {
                    Label("Pair a host", systemImage: "antenna.radiowaves.left.and.right")
                }
            }

            if let pairedHost = store.pairedHost {
                Section("Connection") {
                    Label("Paired with \(pairedHost.host)", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(PsycheTheme.mint)
                        .accessibilityIdentifier("paired-host-status")
                }
            }
        }
        .listStyle(.sidebar)
        .accessibilityIdentifier("project-sidebar")
        .toolbar {
            if horizontalSizeClass == .compact {
                ToolbarItem(placement: .topBarLeading) {
                    siderailToggleButton
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Panes") {
                        preferredCompactColumn = .content
                    }
                }
            }
        }
    }

    private var paneList: some View {
        List(selection: paneSelection) {
            ForEach(store.panes(for: store.selectedProjectID)) { pane in
                let isSelected = store.selectedPaneID == pane.id

                PaneRow(pane: pane)
                    .tag(pane.id)
                    .listRowBackground(isSelected ? PsycheTheme.mint.opacity(0.12) : Color.clear)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("pane-\(pane.id)")
                    .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
        .overlay {
            if store.panes(for: store.selectedProjectID).isEmpty {
                ContentUnavailableView("No panes", systemImage: "rectangle.stack")
            }
        }
        .accessibilityIdentifier("pane-list")
        .toolbar {
            if horizontalSizeClass == .compact {
                ToolbarItem(placement: .topBarLeading) {
                    siderailToggleButton
                }
            }
        }
    }

    /// Shared by every column that can be on screen in compact width.
    ///
    /// The detail column alone used to carry it, which made the control
    /// one-way: it could reveal the siderails but never collapse them again,
    /// because once a siderail was showing the button was no longer on screen.
    private var siderailToggleButton: some View {
        Button(action: toggleSiderails) {
            Image(systemName: "sidebar.left")
        }
        .accessibilityLabel(siderailToggleAccessibilityLabel)
        .accessibilityIdentifier("cockpit-siderail-toggle")
    }

    private var siderailToggleAccessibilityLabel: String {
        if horizontalSizeClass == .compact {
            return preferredCompactColumn == .detail ? "Show siderails" : "Hide siderails"
        }
        return columnVisibility == .detailOnly ? "Show siderails" : "Hide siderails"
    }

    private var paneSelection: Binding<String?> {
        Binding(
            get: {
                horizontalSizeClass == .compact && preferredCompactColumn != .detail
                    ? nil
                    : store.selectedPaneID
            },
            set: { selection in
                guard selection != nil || preferredCompactColumn == .detail else { return }
                store.selectedPaneID = selection
                if horizontalSizeClass == .compact, selection != nil {
                    preferredCompactColumn = .detail
                }
            }
        )
    }

    private var projectSelection: Binding<String?> {
        Binding(
            get: {
                horizontalSizeClass == .compact && preferredCompactColumn == .sidebar
                    ? nil
                    : store.selectedProjectID
            },
            set: { selection in
                guard selection != nil || preferredCompactColumn != .sidebar else { return }
                store.selectedProjectID = selection
                if let selection {
                    let panes = store.panes(for: selection)
                    if !panes.contains(where: { $0.id == store.selectedPaneID }) {
                        store.selectedPaneID = panes.first?.id
                    }
                }
                if horizontalSizeClass == .compact, selection != nil {
                    preferredCompactColumn = .content
                }
            }
        )
    }

    private func toggleSiderails() {
        if horizontalSizeClass == .compact {
            // .detailOnly keeps the sidebar column unavailable, so pointing
            // preferredCompactColumn at it does nothing until this is lifted.
            // Without this the toggle is inert in compact width, which also
            // strands the pair-a-host button that lives in the sidebar.
            if columnVisibility == .detailOnly { columnVisibility = .automatic }
            preferredCompactColumn = preferredCompactColumn == .detail ? .sidebar : .detail
        } else {
            if columnVisibility == .detailOnly {
                columnVisibility = .automatic
                Task { @MainActor in
                    await Task.yield()
                    guard columnVisibility != .detailOnly else { return }
                    columnVisibility = .all
                }
            } else {
                columnVisibility = .detailOnly
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
    @EnvironmentObject private var store: DemoStore
    @State private var host = ""
    @State private var pairingCode = ""
    @State private var pairedResult: String?

    private var trimmedHost: String {
        host.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var isHostValid: Bool {
        !trimmedHost.isEmpty && !trimmedHost.contains(where: \.isWhitespace)
    }

    private var isPairingCodeValid: Bool {
        pairingCode.count == 6 && pairingCode.allSatisfy(\.isWholeNumber)
    }

    private var isPairingValid: Bool {
        isHostValid && isPairingCodeValid
    }

    private var validationMessage: String? {
        if host.isEmpty {
            return "Enter the host name or address."
        }
        if !isHostValid {
            return "Host names cannot contain spaces."
        }
        if pairingCode.isEmpty {
            return "Enter the six-digit pairing code."
        }
        if !isPairingCodeValid {
            return "The pairing code must contain exactly six digits."
        }
        return nil
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 20) {
                Image(systemName: "laptopcomputer.and.iphone")
                    .font(.system(size: 42))
                    .foregroundStyle(PsycheTheme.mint)
                Text("Pair a Psyche host")
                    .font(.title2.weight(.bold))
                Text("Enter the host and short code shown by Psyche. This demo records the paired host locally; live pairing arrives with the transport implementation.")
                    .foregroundStyle(.secondary)
                TextField("Host name or address", text: $host)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("pair-host-field")
                TextField("Six-digit pairing code", text: $pairingCode)
                    .keyboardType(.numberPad)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("pair-code-field")
                if let pairedResult {
                    Label(pairedResult, systemImage: "checkmark.circle.fill")
                        .foregroundStyle(PsycheTheme.mint)
                        .accessibilityIdentifier("pairing-result")
                } else if let validationMessage {
                    Text(validationMessage)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("pairing-validation")
                }
                Spacer()
            }
            .padding(24)
            .navigationTitle("New connection")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    if pairedResult == nil {
                        Button("Pair", action: pair)
                            .disabled(!isPairingValid)
                    } else {
                        Button("Done") { dismiss() }
                    }
                }
            }
        }
        .presentationDetents([.medium])
    }

    private func pair() {
        guard isPairingValid else { return }
        store.recordPairing(host: trimmedHost, pairingCode: pairingCode)
        pairedResult = "Paired with \(trimmedHost)"
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
