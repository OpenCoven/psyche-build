import Combine
import PsycheCore
import SwiftUI

@MainActor
final class PaneComposerModel: ObservableObject {
    @Published private(set) var modifiers: TerminalModifiers = []
    @Published private(set) var inputErrorMessage: String?

    var armedControl: Bool { modifiers.contains(.control) }
    var armedAlt: Bool { modifiers.contains(.alt) }

    func toggleControl() {
        toggle(.control)
    }

    func toggleAlt() {
        toggle(.alt)
    }

    func clearInputError() {
        inputErrorMessage = nil
    }

    func dismissError(registry: TerminalSessionRegistry) {
        inputErrorMessage = nil
        registry.clearError()
    }

    @discardableResult
    func submit(
        targetPaneID: String?,
        workspaceIsStale: Bool,
        store: WorkspaceStore,
        registry: TerminalSessionRegistry
    ) -> Task<Void, Never>? {
        guard canSend(
            targetPaneID: targetPaneID,
            workspaceIsStale: workspaceIsStale,
            registry: registry
        ), let targetPaneID else {
            return nil
        }

        let text = store.drafts[targetPaneID] ?? ""
        guard !text.isEmpty else { return nil }

        let data: Data
        if modifiers.isEmpty {
            data = TerminalInput.submission(of: text)
        } else {
            guard let modified = TerminalInput.characterSequence(
                for: text,
                modifiers: modifiers
            ) else {
                inputErrorMessage = modifierInputError(for: text)
                return nil
            }
            data = modified
        }

        beginSendAttempt()
        return Task {
            let accepted = await registry.send(data, toPane: targetPaneID)
            guard accepted, store.drafts[targetPaneID] == text else { return }
            store.setDraft(nil, forPane: targetPaneID)
        }
    }

    @discardableResult
    func press(
        _ key: TerminalKey,
        targetPaneID: String?,
        workspaceIsStale: Bool,
        registry: TerminalSessionRegistry
    ) -> Task<Void, Never>? {
        guard canSend(
            targetPaneID: targetPaneID,
            workspaceIsStale: workspaceIsStale,
            registry: registry
        ), let targetPaneID,
        let data = TerminalInput.sequence(for: key, modifiers: modifiers) else {
            return nil
        }

        beginSendAttempt()
        return Task {
            _ = await registry.send(data, toPane: targetPaneID)
        }
    }

    private func toggle(_ modifier: TerminalModifiers) {
        if modifiers.contains(modifier) {
            modifiers.remove(modifier)
        } else {
            modifiers.insert(modifier)
        }
    }

    private func canSend(
        targetPaneID: String?,
        workspaceIsStale: Bool,
        registry: TerminalSessionRegistry
    ) -> Bool {
        !workspaceIsStale
            && targetPaneID != nil
            && registry.focusedPaneID == targetPaneID
    }

    private func beginSendAttempt() {
        inputErrorMessage = nil
        modifiers = []
    }

    private func modifierInputError(for text: String) -> String {
        if text.count != 1 {
            return "Ctrl and Alt apply to one typed character at a time."
        }
        return "Control has no terminal code for that character."
    }
}

/// The input strip below the terminals: a draft field and the keys a phone
/// keyboard cannot produce.
///
/// Drafts are stored per pane in the workspace store, so switching focus
/// switches what is in the field. A half-typed command belongs to the terminal
/// it was meant for and must never surface in another one.
struct PaneComposer: View {
    @EnvironmentObject private var store: WorkspaceStore
    @EnvironmentObject private var registry: TerminalSessionRegistry

    @StateObject private var model = PaneComposerModel()

    private var targetPaneID: String? { registry.focusedPaneID }

    /// Nothing can be typed at state we know is out of date, or when no pane
    /// owns the keystrokes.
    private var isEnabled: Bool {
        targetPaneID != nil && !store.isStale
    }

    var body: some View {
        VStack(spacing: 0) {
            if let message = model.inputErrorMessage ?? registry.lastErrorMessage {
                errorBanner(message)
            }
            CodingKeyRow(
                isEnabled: isEnabled,
                armed: model.modifiers,
                onKey: press,
                onToggleModifier: toggle
            )
            Divider().overlay(PsycheTheme.border)
            field
        }
        .background(PsycheTheme.background)
        // `.contain` again: without it this identifier overrides the ones on
        // the key row, the field, and the send button, collapsing all three
        // into one ambiguous element.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("pane-composer")
    }

    private var field: some View {
        HStack(spacing: 8) {
            TextField(placeholder, text: draft, axis: .vertical)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .lineLimit(1...4)
                .font(.system(.body, design: .monospaced))
                .submitLabel(.send)
                .onSubmit(submit)
                .disabled(!isEnabled)
                // Re-created per pane so the field never animates one pane's
                // text into another's.
                .id(targetPaneID ?? "none")
                .accessibilityIdentifier("pane-composer-field")

            Button(action: submit) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.title2)
            }
            .disabled(!isEnabled || draft.wrappedValue.isEmpty)
            .frame(minWidth: PsycheTheme.minimumTapTarget, minHeight: PsycheTheme.minimumTapTarget)
            .accessibilityLabel("Send")
            .accessibilityIdentifier("pane-composer-send")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var placeholder: String {
        if store.isStale { return "Reconnecting…" }
        return targetPaneID == nil ? "No pane focused" : "Send to terminal"
    }

    private var draft: Binding<String> {
        Binding(
            get: {
                guard let targetPaneID else { return "" }
                return store.drafts[targetPaneID] ?? ""
            },
            set: { newValue in
                guard let targetPaneID else { return }
                store.drafts[targetPaneID] = newValue
                model.clearInputError()
            }
        )
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(PsycheTheme.amber)
            Text(message)
                .font(.caption)
                .lineLimit(2)
            Spacer(minLength: 0)
            Button("Dismiss") { model.dismissError(registry: registry) }
                .font(.caption.weight(.semibold))
                .accessibilityIdentifier("pane-composer-error-dismiss")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("pane-composer-error")
    }

    // MARK: - Sending

    private func submit() {
        model.submit(
            targetPaneID: targetPaneID,
            workspaceIsStale: store.isStale,
            store: store,
            registry: registry
        )
    }

    private func press(_ key: TerminalKey) {
        model.press(
            key,
            targetPaneID: targetPaneID,
            workspaceIsStale: store.isStale,
            registry: registry
        )
    }

    private func toggle(_ modifier: TerminalModifiers) {
        switch modifier {
        case .control:
            model.toggleControl()
        case .alt:
            model.toggleAlt()
        default:
            break
        }
    }
}
