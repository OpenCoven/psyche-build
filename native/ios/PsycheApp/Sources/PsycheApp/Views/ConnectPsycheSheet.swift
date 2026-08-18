import PsycheCore
import SwiftUI

/// A deliberately narrow entry point for a phone invite. The invite itself is
/// transient input; only its parsed endpoint reaches the app model.
struct ConnectPsycheSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var inviteText = ""
    @State private var validationError: String?

    @State private var isConnecting = false
    private let onAccept: (PsycheInvite) async -> Bool

    init(onAccept: @escaping (PsycheInvite) async -> Bool) {
        self.onAccept = onAccept
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 20) {
                Image(systemName: "iphone.and.arrow.forward")
                    .font(.system(size: 42))
                    .foregroundStyle(PsycheTheme.mint)
                Text("Connect to Psyche")
                    .font(.title2.weight(.bold))
                Text("On your Mac, open Psyche and choose Open on phone. Paste the invite here.")
                    .foregroundStyle(.secondary)

                SecureField("Open on phone invite", text: $inviteText)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textContentType(.URL)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("connect-psyche-invite")

                PasteButton(payloadType: String.self) { strings in
                    inviteText = strings.first ?? ""
                    validationError = nil
                }
                .accessibilityIdentifier("connect-psyche-paste")

                Button("Scan unavailable") { }
                    .disabled(true)
                    .accessibilityIdentifier("connect-psyche-scan-unavailable")
                Text("Scanning is not available on this device. Paste an Open on phone invite instead.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                if let validationError {
                    Label(validationError, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(PsycheTheme.amber)
                        .accessibilityIdentifier("connect-psyche-error")
                }
                Spacer()
            }
            .padding(24)
            .navigationTitle("New connection")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(isConnecting ? "Connecting…" : "Connect", action: connect)
                        .disabled(isConnecting)
                }
            }
        }
        .presentationDetents([.medium])
    }

    private func connect() {
        let text = inviteText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: text), let invite = PsycheInvite.parse(url) else {
            validationError = "That invite is not valid. Create a fresh Open on phone invite from Psyche."
            return
        }
        isConnecting = true
        Task {
            if await onAccept(invite) {
                dismiss()
            } else {
                validationError = "Could not connect. Create a fresh Open on phone invite and try again."
                isConnecting = false
            }
        }
    }
}
