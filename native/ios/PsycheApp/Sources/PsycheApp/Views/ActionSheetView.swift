import PsycheCore
import SwiftUI

struct ActionSheetView: View {
    @ObservedObject var store: RemoteActionStore

    @State private var draft = ""

    var body: some View {
        NavigationStack {
            Form {
                if let presentation = store.presentation {
                    headerSection(for: presentation)

                    // Keep context ahead of every control, especially destructive choices.
                    scopeSection(for: presentation)
                    consequenceSection(for: presentation)
                    contentSections(for: presentation)
                    relatedFilesSection(for: presentation)
                    controlsSection(for: presentation)
                } else {
                    Section {
                        ContentUnavailableView(
                            "No action available",
                            systemImage: "rectangle.and.hand.point.up.left",
                            description: Text("Choose an action from a pane to continue.")
                        )
                    }
                }
            }
            .navigationTitle(store.presentation?.title ?? "Remote Action")
            .navigationBarTitleDisplayMode(.inline)
            .accessibilityIdentifier("remote-action-sheet")
            .interactiveDismissDisabled(preventsInteractiveDismissal)
            .onChange(of: store.presentation?.requestID, initial: true) {
                resetDraft()
            }
        }
    }

    private var preventsInteractiveDismissal: Bool {
        guard let presentation = store.presentation else {
            return store.isSubmitting
        }
        return presentation.isInteractive
            || !presentation.dismissable
            || store.isSubmitting
    }

    @ViewBuilder
    private func headerSection(for presentation: RemoteActionPresentation) -> some View {
        Section {
            Text(ActionSheetPresentation.actionLabel(for: presentation.action))
                .font(.headline)
            LabeledContent("Pane", value: presentation.paneID)
        }
    }

    @ViewBuilder
    private func scopeSection(for presentation: RemoteActionPresentation) -> some View {
        if !presentation.scope.rows.isEmpty {
            Section("Scope") {
                ForEach(presentation.scope.rows) { row in
                    LabeledContent {
                        Text(row.value)
                            .multilineTextAlignment(.trailing)
                            .textSelection(.enabled)
                    } label: {
                        Text(row.label)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func consequenceSection(for presentation: RemoteActionPresentation) -> some View {
        if let consequence = presentation.scope.consequence {
            Section("Consequence") {
                Label(consequence, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(PsycheTheme.amber)
                    .accessibilityLabel("Consequence: \(consequence)")
            }
        }
    }

    @ViewBuilder
    private func contentSections(for presentation: RemoteActionPresentation) -> some View {
        switch presentation.content {
        case .confirm:
            messageSection(presentation.message)
        case .choice:
            messageSection(presentation.message)
        case .input(let input):
            Section("Details") {
                Text(presentation.message)
                TextField(
                    input.placeholder ?? "Response",
                    text: $draft,
                    axis: .vertical
                )
                .lineLimit(ActionSheetPresentation.inputLineRange(input.maxVisibleLines))
            }
        case .pullRequestReview(let review):
            pullRequestReviewSection(
                review,
                message: presentation.message
            )
        case .progress(let progress):
            progressSection(progress, message: presentation.message)
        case .terminal(let kind):
            terminalSection(
                kind,
                message: presentation.message,
                recoveryText: presentation.recoveryText
            )
        case .navigation(let targetPaneID):
            navigationSection(
                message: presentation.message,
                targetPaneID: targetPaneID
            )
        }
    }

    private func messageSection(_ message: String) -> some View {
        Section("Details") {
            Text(message)
        }
    }

    private func pullRequestReviewSection(
        _ review: RemoteActionReview,
        message: String
    ) -> some View {
        Section("Pull Request Review") {
            Text(message)
            LabeledContent("Repository", value: review.details.repoPath)
            LabeledContent {
                Text("\(review.details.sourceBranch) → \(review.details.targetBranch)")
                    .multilineTextAlignment(.trailing)
            } label: {
                Text("Branches")
            }

            if review.details.aiFailed == true {
                Label(
                    "AI summary was unavailable. Review the summary before continuing.",
                    systemImage: "exclamationmark.triangle.fill"
                )
                .foregroundStyle(PsycheTheme.amber)
            }

            TextField("Summary", text: $draft, axis: .vertical)
                .lineLimit(1...12)

            if !review.details.files.isEmpty {
                LabeledContent("Review files") {
                    VStack(alignment: .trailing, spacing: 8) {
                        ForEach(review.details.files.indices, id: \.self) { index in
                            Label(review.details.files[index], systemImage: "doc")
                                .multilineTextAlignment(.trailing)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func progressSection(_ progress: Double?, message: String) -> some View {
        Section("Progress") {
            Text(message)
            if let progress {
                ProgressView(value: progress, total: 100)
                    .tint(PsycheTheme.mint)
                    .accessibilityLabel("Progress")
                    .accessibilityValue("\(Int(progress.rounded())) percent")
            } else {
                ProgressView()
                    .tint(PsycheTheme.mint)
                    .accessibilityLabel("In progress")
            }
        }
    }

    private func terminalSection(
        _ kind: RemoteActionTerminalKind,
        message: String,
        recoveryText: String?
    ) -> some View {
        let status = ActionSheetPresentation.status(for: kind)

        return Section("Result") {
            Label(status.label, systemImage: status.systemImage)
                .foregroundStyle(color(for: status.tone))
            Text(message)
            if let recoveryText {
                Text(recoveryText)
                    .foregroundStyle(PsycheTheme.terminalText)
                    .textSelection(.enabled)
                    .accessibilityLabel("Recovery text: \(recoveryText)")
            }
        }
    }

    @ViewBuilder
    private func navigationSection(message: String, targetPaneID: String?) -> some View {
        Section("Navigation") {
            Text(message)
            if let targetPaneID {
                LabeledContent("Target pane", value: targetPaneID)
            }
        }
    }

    @ViewBuilder
    private func relatedFilesSection(for presentation: RemoteActionPresentation) -> some View {
        if !presentation.relatedFiles.isEmpty {
            Section("Related Files") {
                ForEach(presentation.relatedFiles.indices, id: \.self) { index in
                    Label(presentation.relatedFiles[index], systemImage: "doc")
                }
            }
        }
    }

    @ViewBuilder
    private func controlsSection(for presentation: RemoteActionPresentation) -> some View {
        switch presentation.content {
        case .confirm(let confirmLabel, let cancelLabel):
            Section("Controls") {
                submittingIndicator
                responseButton(cancelLabel, response: .cancel)
                responseButton(
                    confirmLabel,
                    role: ActionSheetPresentation.confirmRole(for: presentation.action),
                    response: .confirm
                )
            }
        case .choice(let options):
            Section("Controls") {
                submittingIndicator
                ForEach(options) { option in
                    Button(
                        role: ActionSheetPresentation.optionRole(option).buttonRole,
                        action: { respond(.choice(optionID: option.id)) }
                    ) {
                        choiceLabel(for: option)
                    }
                    .disabled(store.isSubmitting)
                }
                responseButton("Cancel", response: .cancel)
            }
        case .input:
            Section("Controls") {
                submittingIndicator
                responseButton("Cancel", response: .cancel)
                responseButton(
                    ActionSheetPresentation.primaryInputLabel(for: presentation.action),
                    response: .input(value: draft),
                    recoveryText: draft
                )
            }
        case .pullRequestReview:
            Section("Controls") {
                submittingIndicator
                responseButton("Cancel", response: .cancel)
                responseButton(
                    ActionSheetPresentation.primaryInputLabel(for: presentation.action),
                    response: .input(value: draft),
                    recoveryText: draft
                )
            }
        case .progress:
            if presentation.dismissable {
                Section("Controls") {
                    dismissButton("Dismiss")
                }
            }
        case .terminal, .navigation:
            Section("Controls") {
                dismissButton("Done")
            }
        }
    }

    @ViewBuilder
    private var submittingIndicator: some View {
        if store.isSubmitting {
            ProgressView("Sending…")
        }
    }

    private func responseButton(
        _ label: String,
        role: ActionSheetControlRole = .normal,
        response: MobileActionResponse,
        recoveryText: String? = nil
    ) -> some View {
        Button(
            label,
            role: role.buttonRole,
            action: { respond(response, recoveryText: recoveryText) }
        )
        .disabled(store.isSubmitting)
    }

    private func dismissButton(_ label: String) -> some View {
        Button(label) {
            store.dismiss()
        }
        .disabled(store.isSubmitting)
    }

    private func choiceLabel(for option: MobileActionOption) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(option.label)
                if let description = option.description {
                    Text(description)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            if let marker = ActionSheetPresentation.defaultMarker(for: option) {
                Text(marker)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(PsycheTheme.mint)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    private func respond(
        _ response: MobileActionResponse,
        recoveryText: String? = nil
    ) {
        Task {
            await store.respond(response, recoveryText: recoveryText)
        }
    }

    private func resetDraft() {
        guard let presentation = store.presentation else {
            draft = ""
            return
        }

        switch presentation.content {
        case .input(let input):
            draft = input.defaultValue
        case .pullRequestReview(let review):
            draft = review.defaultSummary
        default:
            draft = ""
        }
    }

    private func color(for tone: ActionSheetStatusTone) -> Color {
        switch tone {
        case .success:
            PsycheTheme.mint
        case .info:
            PsycheTheme.terminalText
        case .error:
            PsycheTheme.amber
        }
    }
}

private extension ActionSheetControlRole {
    var buttonRole: ButtonRole? {
        switch self {
        case .normal:
            nil
        case .destructive:
            .destructive
        }
    }
}
