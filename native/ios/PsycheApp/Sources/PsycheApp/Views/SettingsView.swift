import PsycheCore
import SwiftUI

/// Where the connection itself is visible: which host, how fresh the state is,
/// and what to do about it when it is not fresh.
struct SettingsView: View {
    @EnvironmentObject private var store: WorkspaceStore
    @EnvironmentObject private var model: AppModel
    @State private var isConnectSheetPresented = false

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
                    Text(model.hostName ?? "Not connected")
                        .foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Host, \(model.hostName ?? "not connected")")
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

            Section {
                Button("Connect to Psyche") { isConnectSheetPresented = true }
                    .frame(minHeight: PsycheTheme.minimumTapTarget)
                    .accessibilityIdentifier("settings-connect-psyche")
            } footer: {
                Text("Open Psyche on your Mac, then choose Open on phone to create an invite.")
            }

            if model.hostName != nil {
                Section {
                    Button("Clear connection", role: .destructive) {
                        Task { await model.clearConnection() }
                    }
                    .frame(minHeight: PsycheTheme.minimumTapTarget)
                    .accessibilityIdentifier("settings-clear-connection")
                } footer: {
                    Text("Removes this device’s saved connection and credential.")
                }
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
        .sheet(isPresented: $isConnectSheetPresented) {
            ConnectPsycheSheet { invite in
                await model.connect(using: invite)
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
