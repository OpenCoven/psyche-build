import PsycheCore
import SwiftUI

struct ActionSheetView: View {
    @ObservedObject var store: RemoteActionStore

    @State private var draft = ""
    @State private var pullRequestTitle = ""
    @State private var pullRequestBody = ""

    var body: some View {
        NavigationStack {
            Form {
                if let presentation = store.presentation {
                    headerSection(for: presentation)
                    ForEach(
                        ActionSheetPresentation.sectionOrder(
                            hasScope: !presentation.scope.rows.isEmpty,
                            hasConsequence: presentation.scope.consequence != nil,
                            hasRelatedFiles: standaloneRelatedFiles(for: presentation).isEmpty == false
                        ),
                        id: \.self
                    ) { section in
                        sectionView(section, presentation: presentation)
                    }
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
            Text(presentation.actionLabel)
                .font(.headline)
            LabeledContent("Pane", value: presentation.paneID)
        }
    }

    @ViewBuilder
    private func scopeSection(for presentation: RemoteActionPresentation) -> some View {
        Section("Scope") {
            ForEach(presentation.scope.rows) { row in
                LabeledContent {
                    Text(row.value)
                        .multilineTextAlignment(.trailing)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("remote-action-scope-\(row.key)")
                } label: {
                    Text(row.label)
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
                inputField(for: input)
            }
        case .pullRequestReview(let review):
            pullRequestReviewSection(
                review,
                paneID: presentation.paneID,
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

    @ViewBuilder
    private func inputField(for input: RemoteActionInput) -> some View {
        if ActionSheetPresentation.prefersMultilineInput(input.maxVisibleLines) {
            TextField(
                input.placeholder ?? "Response",
                text: $draft,
                axis: .vertical
            )
            .lineLimit(ActionSheetPresentation.inputLineRange(input.maxVisibleLines))
            .disabled(ActionSheetPresentation.editingDisabled(isSubmitting: store.isSubmitting))
            .accessibilityIdentifier("remote-action-input")
        } else {
            TextField(input.placeholder ?? "Response", text: $draft)
                .lineLimit(1)
                .disabled(ActionSheetPresentation.editingDisabled(isSubmitting: store.isSubmitting))
                .accessibilityIdentifier("remote-action-input")
        }
    }

    private func pullRequestReviewSection(
        _ review: RemoteActionReview,
        paneID: String,
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

            TextField("Title", text: $pullRequestTitle)
                .lineLimit(1)
                .disabled(ActionSheetPresentation.editingDisabled(isSubmitting: store.isSubmitting))
                .accessibilityIdentifier("remote-action-pr-title")

            TextField("Summary", text: $pullRequestBody, axis: .vertical)
                .lineLimit(3...12)
                .disabled(ActionSheetPresentation.editingDisabled(isSubmitting: store.isSubmitting))
                .accessibilityIdentifier("remote-action-pr-body")

            if !review.details.files.isEmpty {
                ForEach(review.details.files, id: \.self) { path in
                    relatedFileLink(
                        path,
                        paneID: paneID,
                        accessibilityIdentifier: "remote-action-pr-file-\(path)"
                    )
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
        Section("Related Files") {
            ForEach(standaloneRelatedFiles(for: presentation), id: \.self) { path in
                relatedFileLink(
                    path,
                    paneID: presentation.paneID,
                    accessibilityIdentifier: "remote-action-file-\(path)"
                )
            }
        }
    }

    @ViewBuilder
    private func sectionView(
        _ section: ActionSheetSection,
        presentation: RemoteActionPresentation
    ) -> some View {
        switch section {
        case .scope:
            scopeSection(for: presentation)
        case .consequence:
            consequenceSection(for: presentation)
        case .content:
            contentSections(for: presentation)
        case .relatedFiles:
            relatedFilesSection(for: presentation)
        case .controls:
            controlsSection(for: presentation)
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
                ForEach(ActionSheetPresentation.visibleChoiceOptions(options)) { option in
                    Button(
                        role: ActionSheetPresentation.optionRole(option).buttonRole,
                        action: { respond(.choice(optionID: option.id)) }
                    ) {
                        choiceLabel(for: option)
                    }
                    .disabled(store.isSubmitting)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(option.label)
                    .accessibilityValue(option.description ?? "")
                    .accessibilityIdentifier(ActionSheetPresentation.controlIdentifier(for: option.label))
                }
                let cancelControl = ActionSheetPresentation.cancelControl(for: options)
                responseButton(cancelControl.label, response: cancelControl.response)
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
                    response: .input(value: pullRequestSummary),
                    recoveryText: pullRequestSummary
                )
            }
        case .progress:
            Section("Controls") {
                dismissButton("Dismiss")
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
        Button(role: role.buttonRole, action: { respond(response, recoveryText: recoveryText) }) {
            Text(label)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .disabled(store.isSubmitting)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityIdentifier(ActionSheetPresentation.controlIdentifier(for: label))
    }

    private func dismissButton(_ label: String) -> some View {
        Button(label) {
            store.dismiss()
        }
        .disabled(store.isSubmitting)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityIdentifier(ActionSheetPresentation.controlIdentifier(for: label))
    }

    private func choiceLabel(for option: MobileActionOption) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(option.label)
                    .accessibilityIdentifier("remote-action-choice-label-\(option.id)")
                if let description = option.description {
                    Text(description)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("remote-action-choice-description-\(option.id)")
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
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("remote-action-choice-\(option.id)")
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
            pullRequestTitle = ""
            pullRequestBody = ""
            return
        }

        switch presentation.content {
        case .input(let input):
            draft = input.defaultValue
            pullRequestTitle = ""
            pullRequestBody = ""
        case .pullRequestReview(let review):
            let reviewDraft = ActionSheetPresentation.pullRequestDraft(from: review.defaultSummary)
            draft = ""
            pullRequestTitle = reviewDraft.title
            pullRequestBody = reviewDraft.body
        default:
            draft = ""
            pullRequestTitle = ""
            pullRequestBody = ""
        }
    }

    private func standaloneRelatedFiles(for presentation: RemoteActionPresentation) -> [String] {
        switch presentation.content {
        case .pullRequestReview(let review):
            let reviewFiles = Set(review.details.files)
            return presentation.relatedFiles.filter { !reviewFiles.contains($0) }
        default:
            return presentation.relatedFiles
        }
    }

    private func relatedFileLink(
        _ path: String,
        paneID: String,
        accessibilityIdentifier: String
    ) -> some View {
        NavigationLink {
            ActionSheetRelatedFileView(paneID: paneID, path: path)
        } label: {
            Label(path, systemImage: "doc")
        }
        .accessibilityIdentifier(accessibilityIdentifier)
    }

    private var pullRequestSummary: String {
        ActionSheetPresentation.pullRequestSummary(
            title: pullRequestTitle,
            body: pullRequestBody
        )
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
