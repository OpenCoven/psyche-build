import Foundation
import PsycheCore

enum ActionSheetSection: Equatable, Hashable {
    case scope
    case consequence
    case content
    case relatedFiles
    case controls
}

enum ActionSheetControlRole: Equatable {
    case normal
    case destructive
}

enum ActionSheetStatusTone: Equatable {
    case success
    case info
    case error
}

struct ActionSheetStatus: Equatable {
    let label: String
    let systemImage: String
    let tone: ActionSheetStatusTone
}

struct ActionSheetCancelControl: Equatable {
    let label: String
    let response: MobileActionResponse
}

struct ActionSheetPullRequestDraft: Equatable {
    let title: String
    let body: String
}

enum ActionSheetPresentation {
    static func sectionOrder(
        hasScope: Bool,
        hasConsequence: Bool,
        hasRelatedFiles: Bool
    ) -> [ActionSheetSection] {
        var sections: [ActionSheetSection] = []
        if hasScope {
            sections.append(.scope)
        }
        if hasConsequence {
            sections.append(.consequence)
        }
        sections.append(.content)
        if hasRelatedFiles {
            sections.append(.relatedFiles)
        }
        sections.append(.controls)
        return sections
    }

    static func confirmRole(for action: PaneAction) -> ActionSheetControlRole {
        action == .close ? .destructive : .normal
    }

    static func optionRole(_ option: MobileActionOption) -> ActionSheetControlRole {
        option.danger == true ? .destructive : .normal
    }

    static func visibleChoiceOptions(_ options: [MobileActionOption]) -> [MobileActionOption] {
        guard let cancelOption = cancelOption(in: options) else {
            return options
        }
        return options.filter { $0.id != cancelOption.id }
    }

    static func cancelControl(for options: [MobileActionOption]) -> ActionSheetCancelControl {
        if let cancelOption = cancelOption(in: options) {
            return ActionSheetCancelControl(
                label: cancelOption.label,
                response: .choice(optionID: cancelOption.id)
            )
        }
        return ActionSheetCancelControl(label: "Cancel", response: .cancel)
    }

    static func inputLineRange(_ requestedMaximum: Int?) -> ClosedRange<Int> {
        1...min(max(requestedMaximum ?? 6, 1), 12)
    }

    static func prefersMultilineInput(_ requestedMaximum: Int?) -> Bool {
        inputLineRange(requestedMaximum).upperBound > 1
    }

    static func editingDisabled(isSubmitting: Bool) -> Bool { isSubmitting }

    static func status(for kind: RemoteActionTerminalKind) -> ActionSheetStatus {
        switch kind {
        case .success:
            ActionSheetStatus(
                label: "Success",
                systemImage: "checkmark.circle.fill",
                tone: .success
            )
        case .info:
            ActionSheetStatus(
                label: "Information",
                systemImage: "info.circle.fill",
                tone: .info
            )
        case .error:
            ActionSheetStatus(
                label: "Error",
                systemImage: "exclamationmark.triangle.fill",
                tone: .error
            )
        }
    }

    static func actionLabel(for action: PaneAction) -> String {
        action.presentationLabel
    }

    static func defaultMarker(for option: MobileActionOption) -> String? {
        option.isDefault == true ? "Default" : nil
    }

    static func primaryInputLabel(for action: PaneAction) -> String {
        action == .createPR ? "Create Pull Request" : "Continue"
    }

    static func controlIdentifier(for label: String) -> String {
        let slug = label
            .lowercased()
            .map { character -> String in
                character.isLetter || character.isNumber ? String(character) : "-"
            }
            .joined()
            .split(separator: "-", omittingEmptySubsequences: true)
            .joined(separator: "-")
        return "remote-action-control-\(slug)"
    }

    static func pullRequestDraft(from summary: String) -> ActionSheetPullRequestDraft {
        let normalized = summary
            .replacingOccurrences(of: "\r\n", with: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else {
            return ActionSheetPullRequestDraft(title: "", body: "")
        }
        guard let newline = normalized.firstIndex(of: "\n") else {
            return ActionSheetPullRequestDraft(title: normalized, body: "")
        }

        let title = String(normalized[..<newline])
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let bodyStart = normalized.index(after: newline)
        let body = String(
            String(normalized[bodyStart...])
                .drop(while: { $0 == "\n" })
        )
            .trimmingCharacters(in: .whitespacesAndNewlines)

        return ActionSheetPullRequestDraft(title: title, body: body)
    }

    static func pullRequestSummary(title: String, body: String) -> String {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedBody = body
            .replacingOccurrences(of: "\r\n", with: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedBody.isEmpty else {
            return trimmedTitle
        }
        return "\(trimmedTitle)\n\n\(trimmedBody)"
    }

    private static func cancelOption(in options: [MobileActionOption]) -> MobileActionOption? {
        options.first { $0.id == "cancel" }
    }
}
