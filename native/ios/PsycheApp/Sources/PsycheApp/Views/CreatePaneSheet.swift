import PsycheCore
import SwiftUI

/// Creates a pane where you already are.
struct CreatePaneSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: WorkspaceStore

    @State private var form = CreatePaneForm()
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    private var targets: [CreatePaneForm.Target] { CreatePaneForm.targets(in: store.workspace) }

    /// Nothing is submittable against state we know is out of date — the
    /// project or worktree may not be there any more.
    private var canSubmit: Bool {
        form.isValid && !isSubmitting && !store.isStale
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Where") {
                    Picker("Target", selection: targetSelection) {
                        ForEach(targets) { target in
                            Text("\(target.projectTitle) · \(target.label)").tag(target.id)
                        }
                    }
                    .accessibilityIdentifier("create-pane-target")
                }

                Section("What") {
                    Picker("Kind", selection: $form.kind) {
                        ForEach(PaneCreateKind.allCases, id: \.self) { kind in
                            Text(label(for: kind)).tag(kind)
                        }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("create-pane-kind")

                    TextField("Title (optional)", text: $form.title)
                        .accessibilityIdentifier("create-pane-title")
                    if form.kind == .agent {
                        TextField("Agent (optional)", text: $form.agent)
                            .textInputAutocapitalization(.never)
                            .accessibilityIdentifier("create-pane-agent")
                        TextField("Prompt (optional)", text: $form.prompt, axis: .vertical)
                            .lineLimit(1...4)
                            .accessibilityIdentifier("create-pane-prompt")
                    }
                }

                if store.isStale {
                    Text("Reconnecting — creating a pane needs live state.")
                        .font(.footnote)
                        .foregroundStyle(PsycheTheme.amber)
                        .accessibilityIdentifier("create-pane-stale")
                }

                if let errorMessage {
                    Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(PsycheTheme.amber)
                        .accessibilityIdentifier("create-pane-error")
                }
            }
            .navigationTitle("New pane")
            .navigationBarTitleDisplayMode(.inline)
            .accessibilityIdentifier("create-pane-sheet")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create", action: submit)
                        .disabled(!canSubmit)
                        .accessibilityIdentifier("create-pane-submit")
                }
            }
            .onAppear {
                guard form.projectID.isEmpty else { return }
                form = CreatePaneForm.makeDefault(
                    workspace: store.workspace,
                    focusedPaneID: store.primaryPaneID,
                    selectedProjectID: store.selectedProjectID
                )
            }
        }
    }

    private var targetSelection: Binding<String> {
        Binding(
            get: { "\(form.projectID)|\(form.cwd)" },
            set: { id in
                guard let target = targets.first(where: { $0.id == id }) else { return }
                form.projectID = target.projectID
                form.cwd = target.cwd
            }
        )
    }

    private func label(for kind: PaneCreateKind) -> String {
        switch kind {
        case .agent: "Agent"
        case .terminal: "Terminal"
        case .covenSession: "Coven"
        }
    }

    private func submit() {
        guard canSubmit else { return }
        isSubmitting = true
        errorMessage = nil

        Task {
            do {
                _ = try await store.createPane(
                    kind: form.kind,
                    projectID: form.projectID,
                    cwd: form.cwd,
                    agent: form.trimmedAgent,
                    title: form.trimmedTitle,
                    prompt: form.trimmedPrompt
                )
                dismiss()
            } catch {
                // The sheet stays open with what was typed. Dismissing on
                // failure would look like the pane was created.
                errorMessage = error.localizedDescription
            }
            isSubmitting = false
        }
    }
}
