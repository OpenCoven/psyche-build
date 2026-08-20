import PsycheCore
import SwiftUI

struct PairHostSheet: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model: PairHostModel
    @State private var deliveredReadyServerID: String?

    private let onReady: (PairedHost) -> Void

    init(model: PairHostModel, onReady: @escaping (PairedHost) -> Void) {
        _model = StateObject(wrappedValue: model)
        self.onReady = onReady
    }

    var body: some View {
        NavigationStack {
            Form {
                nearbyHostsSection
                selectedHostSection
                manualConnectionSection
                progressSection
                errorSection
            }
            .navigationTitle("Connections")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .accessibilityIdentifier("pair-host-sheet")
        }
        .presentationDetents([.medium, .large])
        .task {
            await model.start()
        }
        .onDisappear {
            Task { await model.stop() }
        }
        .onChange(of: model.readyHost?.serverID) {
            deliverReadyHostIfNeeded()
        }
    }

    private var nearbyHostsSection: some View {
        Section("Nearby hosts") {
            if model.rows.isEmpty {
                Label("Looking for hosts on your local network…", systemImage: "dot.radiowaves.left.and.right")
                    .foregroundStyle(.secondary)
                    .frame(minHeight: PsycheTheme.minimumTapTarget, alignment: .leading)
            } else {
                ForEach(model.rows) { row in
                    PairHostRow(
                        row: row,
                        isSelected: model.selectedServerID == row.serverID && !model.showManualEntry,
                        isBusy: model.isActionInProgress,
                        isRetrying: model.retryingServerIDs.contains(row.serverID),
                        onSelect: { model.select(serverID: row.serverID) },
                        onRetry: { model.retry(serverID: row.serverID) }
                    )
                }
            }
        }
    }

    @ViewBuilder
    private var selectedHostSection: some View {
        if let row = model.selectedRow, !model.showManualEntry {
            switch model.phase {
            case .confirmingRePair:
                Section("Confirm certificate change") {
                    Label(
                        "This trusted host is presenting a different certificate.",
                        systemImage: "exclamationmark.triangle.fill"
                    )
                    .foregroundStyle(PsycheTheme.amber)

                    Text("Continue only if you expected this change and copied a new pairing code from Psyche.")
                        .foregroundStyle(.secondary)

                    Button("Continue to re-pair") {
                        Task { await model.confirmRePairing() }
                    }
                    .frame(minHeight: PsycheTheme.minimumTapTarget)
                    .tint(PsycheTheme.amber)
                    .accessibilityIdentifier("pair-host-repair-confirm")
                    .disabled(model.isActionInProgress)

                    Button("Back") {
                        model.cancelRePairingConfirmation()
                    }
                    .frame(minHeight: PsycheTheme.minimumTapTarget)
                    .accessibilityIdentifier("pair-host-repair-cancel")
                    .disabled(model.isActionInProgress)
                }
            default:
                Section(row.serverName) {
                    if let message = model.selectedActionMessage {
                        Text(message)
                            .foregroundStyle(.secondary)
                    }

                    if model.selectedRequiresPairingCode {
                        pairingCodeField
                    }

                    if model.selectedShowsRePairWarning {
                        Label(
                            "Re-pairing replaces the certificate previously trusted for this host.",
                            systemImage: "exclamationmark.shield.fill"
                        )
                        .foregroundStyle(PsycheTheme.amber)
                    }

                    Button(model.primaryActionTitle) {
                        Task { await model.submit() }
                    }
                    .frame(minHeight: PsycheTheme.minimumTapTarget)
                    .accessibilityIdentifier("pair-host-submit")
                    .disabled(!model.canSubmitSelectedAction)

                    if row.resolutionFailure != nil {
                        Text("Retry the row above or switch on manual connection below.")
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private var manualConnectionSection: some View {
        Section {
            Toggle(
                "Enter host details manually",
                isOn: Binding(
                    get: { model.showManualEntry },
                    set: { model.setManualEntrySelected($0) }
                )
            )
            .frame(minHeight: PsycheTheme.minimumTapTarget)
            .accessibilityIdentifier("pair-host-manual-toggle")
            .disabled(model.isActionInProgress)

            if model.showManualEntry {
                TextField("Host or IP address", text: $model.manualHost)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("pair-host-manual-host")

                TextField("Port", text: $model.manualPort)
                    .keyboardType(.numberPad)
                    .accessibilityIdentifier("pair-host-manual-port")

                TextField("Certificate fingerprint", text: $model.manualFingerprint)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("pair-host-manual-fingerprint")

                if model.showsPairingCodeField {
                    pairingCodeField
                }

                Button(model.primaryActionTitle) {
                    Task { await model.submit() }
                }
                .frame(minHeight: PsycheTheme.minimumTapTarget)
                .accessibilityIdentifier("pair-host-submit")
                .disabled(!model.canSubmitPrimaryAction)
            }
        } header: {
            Text("Manual connection")
        } footer: {
            Text("Copy the port and certificate fingerprint from Psyche. This app will not trust an unknown certificate automatically.")
        }
    }

    @ViewBuilder
    private var progressSection: some View {
        if let progressMessage {
            Section {
                ProgressView(progressMessage)
                    .tint(PsycheTheme.mint)
                    .accessibilityLabel(progressMessage)
                    .accessibilityIdentifier("pair-host-progress")
            }
        }
    }

    @ViewBuilder
    private var errorSection: some View {
        if let errorMessage = model.errorMessage {
            Section {
                Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(PsycheTheme.amber)
                    .accessibilityLabel("Connection warning. \(errorMessage)")
                    .accessibilityIdentifier("pair-host-error")
            }
        }
    }

    private var pairingCodeField: some View {
        TextField("Six-digit pairing code", text: $model.pairingCode)
            .keyboardType(.numberPad)
            .accessibilityIdentifier("pair-host-code")
    }

    private var progressMessage: String? {
        switch model.phase {
        case .connecting:
            return "Connecting to host…"
        case .pairing:
            return "Pairing with host…"
        case .loadingWorkspace:
            return "Loading workspace…"
        default:
            return nil
        }
    }

    private func deliverReadyHostIfNeeded() {
        guard model.phase == .ready,
              let host = model.readyHost,
              deliveredReadyServerID != host.serverID else {
            return
        }
        deliveredReadyServerID = host.serverID
        onReady(host)
        dismiss()
    }
}

private struct PairHostRow: View {
    let row: PairHostModel.Row
    let isSelected: Bool
    let isBusy: Bool
    let isRetrying: Bool
    let onSelect: () -> Void
    let onRetry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button(action: onSelect) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(row.serverName)
                        .foregroundStyle(.primary)
                    Spacer(minLength: 8)
                    if isSelected {
                        Image(systemName: "checkmark")
                            .foregroundStyle(PsycheTheme.mint)
                            .accessibilityHidden(true)
                    }
                }
                .frame(minHeight: PsycheTheme.minimumTapTarget, alignment: .leading)
            }
            .buttonStyle(.plain)
            .disabled(isBusy)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(row.serverName)
            .accessibilityHint(selectionHint)
            .accessibilityAddTraits(isSelected ? [.isSelected] : [])
            .accessibilityIdentifier("pair-host-row-\(row.serverID)")

            Label(status.text, systemImage: status.systemImage)
                .font(.footnote)
                .foregroundStyle(status.color)
                .accessibilityIdentifier("pair-host-status-\(row.serverID)")

            if row.resolutionFailure != nil {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Button(isRetrying ? "Retrying…" : "Retry", action: onRetry)
                        .frame(minHeight: PsycheTheme.minimumTapTarget)
                        .disabled(isBusy || isRetrying)
                        .accessibilityHint("Retry resolving this host's local network address.")
                        .accessibilityIdentifier("pair-host-retry-\(row.serverID)")

                    Text("If it stays unavailable, use manual connection below.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var status: PairHostStatusDescriptor {
        if row.resolutionFailure != nil {
            return .init(
                text: "Address unavailable",
                systemImage: "wifi.exclamationmark",
                color: PsycheTheme.amber
            )
        }

        switch row.pairingStatus {
        case .paired:
            return .init(
                text: "Paired",
                systemImage: "checkmark.shield.fill",
                color: PsycheTheme.mint
            )
        case .unpaired:
            return .init(
                text: "Pair",
                systemImage: "key.horizontal.fill",
                color: PsycheTheme.mint
            )
        case .requiresRePairing:
            return .init(
                text: "Requires re-pairing",
                systemImage: "exclamationmark.shield.fill",
                color: PsycheTheme.amber
            )
        }
    }

    private var selectionHint: String {
        if row.resolutionFailure != nil {
            return "Shows guidance for retrying or entering this host manually."
        }
        return "Selects this host for the next connection step."
    }
}

private struct PairHostStatusDescriptor {
    let text: String
    let systemImage: String
    let color: Color
}
