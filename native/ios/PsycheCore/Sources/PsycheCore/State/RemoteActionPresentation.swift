import Foundation

public enum RemoteActionPresentationError: Error, Sendable, Equatable, LocalizedError {
    case missingSessionID(String)
    case missingOptions
    case missingReviewData
    case unsupportedResultType(String)

    public var errorDescription: String? {
        switch self {
        case .missingSessionID(let type):
            "The host returned \(type) without an action session ID."
        case .missingOptions:
            "The host returned a choice without any options."
        case .missingReviewData:
            "The host returned a pull request review without review details."
        case .unsupportedResultType(let type):
            "The host returned an unsupported action result: \(type)."
        }
    }
}

public struct RemoteActionScopeRow: Sendable, Equatable, Identifiable {
    public let key: String
    public let label: String
    public let value: String

    public var id: String { key }

    public init(key: String, label: String, value: String) {
        self.key = key
        self.label = label
        self.value = value
    }
}

public struct RemoteActionScope: Sendable, Equatable {
    public let rows: [RemoteActionScopeRow]
    public let consequence: String?

    public init(rows: [RemoteActionScopeRow], consequence: String?) {
        self.rows = rows
        self.consequence = consequence
    }

    static func make(data: [String: String]?) -> Self {
        let data = data ?? [:]
        let definitions = [
            ("host", "Host"),
            ("projectId", "Project ID"),
            ("projectTitle", "Project"),
            ("worktreePath", "Worktree"),
            ("sourceBranch", "Source branch"),
            ("targetBranch", "Target branch"),
        ]

        return Self(
            rows: definitions.compactMap { key, label in
                guard let value = data[key], !value.isEmpty else { return nil }
                return RemoteActionScopeRow(key: key, label: label, value: value)
            },
            consequence: data["consequence"].flatMap { $0.isEmpty ? nil : $0 }
        )
    }
}

public struct RemoteActionInput: Sendable, Equatable {
    public let placeholder: String?
    public let defaultValue: String
    public let maxVisibleLines: Int?

    public init(placeholder: String?, defaultValue: String, maxVisibleLines: Int?) {
        self.placeholder = placeholder
        self.defaultValue = defaultValue
        self.maxVisibleLines = maxVisibleLines
    }
}

public struct RemoteActionReview: Sendable, Equatable {
    public let details: MobileActionReviewData
    public let defaultSummary: String

    public init(details: MobileActionReviewData, defaultSummary: String) {
        self.details = details
        self.defaultSummary = defaultSummary
    }
}

public enum RemoteActionTerminalKind: Sendable, Equatable {
    case success
    case info
    case error
}

public struct RemoteActionPresentation: Sendable, Equatable, Identifiable {
    public enum Content: Sendable, Equatable {
        case confirm(confirmLabel: String, cancelLabel: String)
        case choice(options: [MobileActionOption])
        case input(RemoteActionInput)
        case pullRequestReview(RemoteActionReview)
        case progress(Double?)
        case terminal(RemoteActionTerminalKind)
        case navigation(targetPaneID: String?)
    }

    public let requestID: String
    public let paneID: String
    public let action: PaneAction
    public let title: String
    public let message: String
    public let sessionID: String?
    public let scope: RemoteActionScope
    public let relatedFiles: [String]
    public let dismissable: Bool
    public let content: Content
    public let recoveryText: String?

    public var id: String { requestID }

    public var isInteractive: Bool {
        switch content {
        case .confirm, .choice, .input, .pullRequestReview:
            true
        case .progress, .terminal, .navigation:
            false
        }
    }

    public static func make(
        response: MobileActionsResultResponse,
        paneID: String,
        action: PaneAction
    ) throws -> Self {
        let result = response.result
        let sessionID = response.sessionID.flatMap { $0.isEmpty ? nil : $0 }
        let content: Content

        switch result.type {
        case "confirm":
            guard sessionID != nil else {
                throw RemoteActionPresentationError.missingSessionID(result.type)
            }
            content = .confirm(
                confirmLabel: result.confirmLabel ?? "Continue",
                cancelLabel: result.cancelLabel ?? "Cancel"
            )
        case "choice":
            guard sessionID != nil else {
                throw RemoteActionPresentationError.missingSessionID(result.type)
            }
            guard let options = result.options, !options.isEmpty else {
                throw RemoteActionPresentationError.missingOptions
            }
            content = .choice(options: options)
        case "input":
            guard sessionID != nil else {
                throw RemoteActionPresentationError.missingSessionID(result.type)
            }
            content = .input(RemoteActionInput(
                placeholder: result.placeholder,
                defaultValue: result.defaultValue ?? "",
                maxVisibleLines: result.inputMaxVisibleLines
            ))
        case "pr_review":
            guard sessionID != nil else {
                throw RemoteActionPresentationError.missingSessionID(result.type)
            }
            guard let reviewData = result.reviewData else {
                throw RemoteActionPresentationError.missingReviewData
            }
            content = .pullRequestReview(RemoteActionReview(
                details: reviewData,
                defaultSummary: result.defaultValue ?? ""
            ))
        case "progress":
            content = .progress(result.progress.map { min(max($0, 0), 100) })
        case "success":
            content = .terminal(.success)
        case "info":
            content = .terminal(.info)
        case "error":
            content = .terminal(.error)
        case "navigation":
            content = .navigation(targetPaneID: result.targetPaneID)
        default:
            throw RemoteActionPresentationError.unsupportedResultType(result.type)
        }

        let dismissable: Bool
        switch content {
        case .confirm, .choice, .input, .pullRequestReview:
            dismissable = false
        case .progress:
            dismissable = result.dismissable ?? true
        case .terminal, .navigation:
            dismissable = true
        }

        return Self(
            requestID: response.requestID,
            paneID: paneID,
            action: action,
            title: result.title ?? "Action",
            message: result.message,
            sessionID: sessionID,
            scope: .make(data: result.data),
            relatedFiles: result.relatedFiles ?? [],
            dismissable: dismissable,
            content: content,
            recoveryText: nil
        )
    }

    public static func failure(
        requestID: String = UUID().uuidString,
        paneID: String,
        action: PaneAction,
        message: String,
        recoveryText: String? = nil
    ) -> Self {
        Self(
            requestID: requestID,
            paneID: paneID,
            action: action,
            title: "That did not work",
            message: message,
            sessionID: nil,
            scope: RemoteActionScope(rows: [], consequence: nil),
            relatedFiles: [],
            dismissable: true,
            content: .terminal(.error),
            recoveryText: recoveryText
        )
    }
}
