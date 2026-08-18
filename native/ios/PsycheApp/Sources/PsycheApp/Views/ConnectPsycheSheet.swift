import PsycheCore
import SwiftUI

/// A deliberately narrow entry point for a phone invite. The invite itself is
/// transient input; only its parsed endpoint reaches the app model.
struct ConnectPsycheSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var inviteText = ""
    @State private var validationError: String?

    private let onAccept: (PsycheInvite) -> Void

    init(onAccept: @escaping (PsycheInvite) -> Void) {
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

                TextField("Open on phone invite", text: $inviteText, axis: .vertical)
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
                    Button("Connect", action: connect)
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
        onAccept(invite)
        dismiss()
    }
}
