import PsycheCore

enum ActionSheetSection: Equatable {
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

    static func inputLineRange(_ requestedMaximum: Int?) -> ClosedRange<Int> {
        1...min(max(requestedMaximum ?? 6, 1), 12)
    }

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
        switch action {
        case .view:
            "View"
        case .setSource:
            "Set Source"
        case .close:
            "Close"
        case .merge:
            "Merge"
        case .createPR:
            "Create Pull Request"
        case .rename:
            "Rename"
        case .duplicate:
            "Duplicate"
        case .runTest:
            "Run Tests"
        case .runDev:
            "Run Development Server"
        case .openOutput:
            "Open Output"
        case .copyPath:
            "Copy Path"
        case .openInEditor:
            "Open in Editor"
        case .toggleAutopilot:
            "Toggle Autopilot"
        case .attachAgent:
            "Attach Agent"
        case .createChildWorktree:
            "Create Child Worktree"
        case .openTerminalInWorktree:
            "Open Terminal in Worktree"
        case .openFileBrowser:
            "Open File Browser"
        }
    }

    static func defaultMarker(for option: MobileActionOption) -> String? {
        option.isDefault == true ? "Default" : nil
    }

    static func primaryInputLabel(for action: PaneAction) -> String {
        action == .createPR ? "Create Pull Request" : "Continue"
    }
}
