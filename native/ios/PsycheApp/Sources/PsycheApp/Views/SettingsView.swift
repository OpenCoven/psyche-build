import PsycheCore
import SwiftUI

/// Where the connection itself is visible: which host, how fresh the state is,
/// and what to do about it when it is not fresh.
struct SettingsView: View {
    @EnvironmentObject private var store: WorkspaceStore
    @EnvironmentObject private var model: AppModel
    @State private var isPairSheetPresented = false

    var body: some View {
        List {
            Section("Connection") {
                LabeledContent("Status") {
                    Text(statusText)
                        .foregroundStyle(store.isStale ? PsycheTheme.amber : PsycheTheme.mint)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Connection status, \(statusText)")
                .accessibilityIdentifier("settings-status")

                LabeledContent("Host") {
                    Text(model.hostName ?? "Not paired")
                        .foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Host, \(model.hostName ?? "not paired")")
                .accessibilityIdentifier("settings-host")

                if let lastConfirmedAt = store.lastConfirmedAt {
                    LabeledContent("Last confirmed") {
                        Text(lastConfirmedAt, style: .relative)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if let connectionError = model.connectionError {
                Section {
                    Label(connectionError, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(PsycheTheme.amber)
                        .accessibilityIdentifier("connection-error")
                }
            }

            if let cacheError = model.workspaceCacheError {
                Section("Workspace saving") {
                    Label(cacheError, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(PsycheTheme.amber)
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("workspace-cache-error")
                    Button("Retry saving") {
                        Task { await model.retryWorkspaceCachePersistence() }
                    }
                    .frame(minHeight: PsycheTheme.minimumTapTarget)
                    .accessibilityIdentifier("workspace-cache-retry")
                }
            }

            if let notice = model.workspaceCacheRecoveryNotice {
                Section("Preserved workspace data") {
                    Text(notice)
                        .accessibilityIdentifier("workspace-cache-recovery-notice")
                    Button("Dismiss notice (keep preserved data)") {
                        model.dismissWorkspaceCacheRecoveryNotice()
                    }
                    .frame(minHeight: PsycheTheme.minimumTapTarget)
                    .accessibilityIdentifier("workspace-cache-dismiss-notice")
                }
            }

            Section {
                Button("Pair a host") { isPairSheetPresented = true }
                    .frame(minHeight: PsycheTheme.minimumTapTarget)
                    .accessibilityIdentifier("settings-pair-host")
            } footer: {
                Text("Pairing exchanges a token with a host on your local network.")
            }

            Section("Diagnostics") {
                LabeledContent("Workspace revision") {
                    Text(store.workspace.map { "\($0.revision)" } ?? "—")
                        .foregroundStyle(.secondary)
                }
                LabeledContent("Sequence") {
                    Text("\(store.sequence)")
                        .foregroundStyle(.secondary)
                }
                LabeledContent("Mode") {
                    Text(model.isFixture ? "Fixture" : "Live")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Settings")
        .accessibilityIdentifier("settings-view")
        .sheet(isPresented: $isPairSheetPresented) {
            PairHostSheet { host, _ in
                model.recordPairedHostName(host)
            }
        }
    }

    private var statusText: String {
        if store.isStale {
            store.workspace == nil ? "Not connected" : "Showing last known state"
        } else {
            "Live"
        }
    }
}
