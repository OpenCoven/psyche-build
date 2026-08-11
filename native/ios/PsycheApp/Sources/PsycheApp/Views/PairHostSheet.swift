import PsycheCore
import SwiftUI

/// Reports the paired host through a closure rather than reaching for a store,
/// so Settings can present it in a live build without dragging demo data into
/// production.
struct PairHostSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var host = ""
    @State private var pairingCode = ""
    @State private var pairedResult: String?

    private let onPair: (String, String) -> Void

    init(onPair: @escaping (String, String) -> Void) {
        self.onPair = onPair
    }

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
        onPair(trimmedHost, pairingCode)
        pairedResult = "Paired with \(trimmedHost)"
    }
}
