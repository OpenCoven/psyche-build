import Foundation

/// A control client that answers commands from a fixture workspace instead of
/// a host.
///
/// A `-uiFixture` launch has no connection, so every command would fail with
/// "not connected" and the create, rename and stop flows could not be
/// exercised at all. This answers them and republishes the changed workspace
/// the way a host's `workspaceChanged` broadcast would, so the fixture shell
/// shows the same refresh the live app does.
public actor FixtureControlRequests: ControlRequesting {
    public private(set) var sentRequests: [MobileControlRequest] = []

    private var workspace: WorkspaceSnapshot
    private var sequence: UInt64
    private var nextID = 0
    private var nextActionSession = 0
    private let inspectionFails: Bool
    private let updates: AsyncStream<WorkspaceUpdate>
    private let continuation: AsyncStream<WorkspaceUpdate>.Continuation
    private var pendingActions: [String: FixturePendingAction] = [:]

    public struct WorkspaceUpdate: Sendable {
        public let workspace: WorkspaceSnapshot
        public let sequence: UInt64
    }

    public init(
        workspace: WorkspaceSnapshot,
        sequence: UInt64 = 1,
        inspectionFails: Bool = false
    ) {
        self.workspace = workspace
        self.sequence = sequence
        self.inspectionFails = inspectionFails
        let stream = AsyncStream<WorkspaceUpdate>.makeStream()
        updates = stream.stream
        continuation = stream.continuation
    }

    /// Mirrors the host's workspace broadcast, so a fixture launch refreshes
    /// through the same path the live app uses.
    public func workspaceUpdates() -> AsyncStream<WorkspaceUpdate> {
        updates
    }

    public func nextRequestID() -> String {
        nextID += 1
        return "fixture-\(nextID)"
    }

    public func send(_ request: MobileControlRequest) async throws -> MobileControlResponse {
        sentRequests.append(request)
        let requestID = request.requestID ?? ""

        switch request {
        case .listFiles(let list):
            try requireInspection()
            return .filesList(MobileFilesListResult(
                requestID: requestID,
                paneID: list.paneID,
                snapshot: Self.inspectionSnapshot
            ))

        case .readFile(let read):
            try requireInspection()
            return .filesRead(MobileFilesReadResult(
                requestID: requestID,
                paneID: read.paneID,
                path: read.path,
                content: "struct App {}\n",
                truncated: true
            ))

        case .diffFile(let diff):
            try requireInspection()
            return .filesDiff(MobileFilesDiffResult(
                requestID: requestID,
                paneID: diff.paneID,
                path: diff.path,
                diff: "@@ -1 +1 @@\n-old\n+new"
            ))

        case .spawnPane(let spawn):
            let paneID = "pane-\(nextID)"
            apply { workspace in
                Self.insertPane(
                    WorkspacePaneSnapshot(
                        id: paneID,
                        cwd: spawn.cwd,
                        title: spawn.title ?? "new \(spawn.kind.rawValue)",
                        kind: spawn.kind.rawValue,
                        agent: spawn.agent,
                        status: "starting",
                        needsAttention: false,
                        lastActivity: nil,
                        recoverability: "recoverable"
                    ),
                    into: workspace,
                    projectID: spawn.projectID,
                    cwd: spawn.cwd
                )
            }
            return .paneSpawned(PaneSpawnedResponse(
                requestID: requestID,
                id: paneID,
                pane: nil,
                worktreePath: spawn.cwd,
                branch: spawn.branch
            ))

        case .killPane(let kill):
            apply { Self.removePane(kill.paneID, from: $0) }
            return .ack(ControlAckResponse(requestID: requestID, ok: true))

        case .paneMeta(let meta):
            apply { Self.retitlePane(meta.id, to: meta.title, in: $0) }
            return .ack(ControlAckResponse(requestID: requestID, ok: true))

        case .launchRitual(let launch):
            let paneID = "ritual-\(nextID)"
            apply {
                Self.insertPane(
                    WorkspacePaneSnapshot(
                        id: paneID,
                        cwd: Self.ritualLaunchPath(in: $0, projectID: launch.projectID),
                        title: launch.ritualID,
                        kind: "ritual",
                        agent: nil,
                        status: "starting",
                        needsAttention: false,
                        lastActivity: nil,
                        recoverability: "recoverable"
                    ),
                    into: $0,
                    projectID: launch.projectID,
                    cwd: Self.ritualLaunchPath(in: $0, projectID: launch.projectID)
                )
            }
            return .ack(ControlAckResponse(requestID: requestID, ok: true))

        case .startAction(let start):
            return startAction(start, requestID: requestID)

        case .respondToAction(let response):
            return respondToAction(response, requestID: requestID)

        default:
            return .ack(ControlAckResponse(requestID: requestID, ok: true))
        }
    }

    private func requireInspection() throws {
        guard !inspectionFails else {
            throw FixtureControlRequestError.inspectionUnavailable
        }
    }

    private static let inspectionSnapshot = BrowserSnapshot(
        rootPath: "/fixture",
        files: [
            BrowserFile(
                path: "Sources/App.swift",
                name: "App.swift",
                parentPath: "Sources",
                exists: true,
                changed: true,
                statusCode: " M",
                statusLabel: "M"
            ),
            BrowserFile(
                path: "Sources/Deleted.swift",
                name: "Deleted.swift",
                parentPath: "Sources",
                exists: false,
                changed: true,
                statusCode: " D",
                statusLabel: "D"
            ),
        ]
    )

    private func apply(_ transform: (WorkspaceSnapshot) -> WorkspaceSnapshot) {
        workspace = transform(workspace)
        sequence += 1
        continuation.yield(WorkspaceUpdate(workspace: workspace, sequence: sequence))
    }

    private func startAction(
        _ request: MobileActionStartRequest,
        requestID: String
    ) -> MobileControlResponse {
        guard let context = paneContext(for: request.paneID) else {
            return .error(MobileProtocolErrorResponse(
                requestID: requestID,
                code: "unknown_pane",
                message: "Pane \(request.paneID) is not published by this fixture."
            ))
        }

        switch request.action {
        case .merge:
            return startMergeAction(for: context, requestID: requestID)

        case .createPR:
            return startCreatePullRequestAction(for: context, requestID: requestID)

        case .rename:
            let sessionID = nextActionSessionID()
            pendingActions[sessionID] = .rename(paneID: request.paneID)
            return .actionResult(MobileActionsResultResponse(
                requestID: requestID,
                sessionID: sessionID,
                result: MobileActionResult(
                    type: "input",
                    message: "Rename \(context.paneTitle). Leave blank to keep the current name.",
                    title: "Rename Pane",
                    placeholder: "Pane title",
                    defaultValue: context.paneTitle,
                    inputMaxVisibleLines: 1,
                    data: actionScope(
                        for: context,
                        consequence: "Updates the pane name shown on this device."
                    )
                )
            ))

        case .close:
            let sessionID = nextActionSessionID()
            pendingActions[sessionID] = .close(paneID: request.paneID)
            return .actionResult(MobileActionsResultResponse(
                requestID: requestID,
                sessionID: sessionID,
                result: MobileActionResult(
                    type: "choice",
                    message: "Choose how to close \(context.paneTitle).",
                    title: "Close Pane",
                    options: [
                        MobileActionOption(
                            id: "kill_only",
                            label: "Just close pane",
                            description: "Keep worktree and branch",
                            isDefault: true
                        ),
                        MobileActionOption(
                            id: "kill_and_clean",
                            label: "Close and remove worktree",
                            description: "Delete worktree but keep branch",
                            danger: true
                        ),
                        MobileActionOption(
                            id: "kill_clean_branch",
                            label: "Close and delete everything",
                            description: "Remove worktree and delete branch",
                            danger: true
                        ),
                    ],
                    data: actionScope(
                        for: context,
                        consequence: "Closes the pane and can remove its worktree or branch."
                    )
                )
            ))

        default:
            return .error(MobileProtocolErrorResponse(
                requestID: requestID,
                code: "command_not_supported",
                message: "Fixture action \(request.action.rawValue) is not supported."
            ))
        }
    }

    private func startMergeAction(
        for context: FixturePaneContext,
        requestID: String
    ) -> MobileControlResponse {
        if context.paneID == "web-home" {
            let sessionID = nextActionSessionID()
            pendingActions[sessionID] = .mergeSiblingConfirmation(paneID: context.paneID)
            return .actionResult(MobileActionsResultResponse(
                requestID: requestID,
                sessionID: sessionID,
                result: MobileActionResult(
                    type: "confirm",
                    message: "1 other agent (homepage preview) is using this worktree. Merging will close it. Proceed?",
                    title: "Sibling Agents Active",
                    confirmLabel: "Continue",
                    cancelLabel: "Cancel",
                    data: actionScope(
                        for: context,
                        consequence: "Closes sibling panes before the host merges this branch into main."
                    )
                )
            ))
        }

        let sessionID = nextActionSessionID()
        pendingActions[sessionID] = .mergeUncommittedChoice(paneID: context.paneID)
        return .actionResult(MobileActionsResultResponse(
            requestID: requestID,
            sessionID: sessionID,
            result: MobileActionResult(
                type: "choice",
                message: "This worktree has uncommitted changes that must be committed before merging.",
                title: "Worktree Has Uncommitted Changes",
                options: [
                    MobileActionOption(
                        id: "commit_automatic",
                        label: "AI commit (automatic)",
                        description: "Auto-generate and commit immediately",
                        isDefault: true
                    ),
                    MobileActionOption(
                        id: "commit_manual",
                        label: "Manual commit message",
                        description: "Write your own commit message"
                    ),
                    MobileActionOption(
                        id: "cancel",
                        label: "Cancel merge",
                        description: "Resolve manually later"
                    ),
                ],
                data: actionScope(
                    for: context,
                    consequence: "Requires the host to commit these changes before merging into main."
                ),
                relatedFiles: Self.mergeFiles
            )
        ))
    }

    private func startCreatePullRequestAction(
        for context: FixturePaneContext,
        requestID: String
    ) -> MobileControlResponse {
        let sessionID = nextActionSessionID()
        pendingActions[sessionID] = .createPullRequestConfirm(paneID: context.paneID)
        return .actionResult(MobileActionsResultResponse(
            requestID: requestID,
            sessionID: sessionID,
            result: MobileActionResult(
                type: "confirm",
                message: "Push \(context.paneTitle) and create a GitHub pull request into \(context.targetBranch ?? "main")?",
                title: "Create Pull Request",
                confirmLabel: "Create PR",
                cancelLabel: "Cancel",
                data: actionScope(
                    for: context,
                    consequence: "Pushes the branch and creates a pull request on the paired host."
                ),
                relatedFiles: Self.pullRequestFiles
            )
        ))
    }

    private func respondToAction(
        _ request: MobileActionRespondRequest,
        requestID: String
    ) -> MobileControlResponse {
        guard let pending = pendingActions.removeValue(forKey: request.sessionID) else {
            return .error(MobileProtocolErrorResponse(
                requestID: requestID,
                code: "action_session_not_found",
                message: "Action session expired."
            ))
        }

        switch (pending, request.response) {
        case let (.mergeSiblingConfirmation(paneID), .confirm):
            guard let context = paneContext(for: paneID) else {
                return .error(MobileProtocolErrorResponse(
                    requestID: requestID,
                    code: "unknown_pane",
                    message: "Pane \(paneID) is not published by this fixture."
                ))
            }
            let sessionID = nextActionSessionID()
            pendingActions[sessionID] = .mergeFallbackConfirmation(paneID: paneID)
            return .actionResult(MobileActionsResultResponse(
                requestID: requestID,
                sessionID: sessionID,
                result: MobileActionResult(
                    type: "confirm",
                    message: "feat/home-preview is no longer available. Merge \"\(context.paneTitle)\" directly into \(context.targetBranch ?? "main") instead?",
                    title: "Parent Merge Target Unavailable",
                    confirmLabel: "Continue",
                    cancelLabel: "Cancel",
                    data: actionScope(
                        for: context,
                        consequence: "Confirms a fallback merge target before the host continues."
                    )
                )
            ))

        case (.mergeSiblingConfirmation, .cancel):
            return .actionResult(MobileActionsResultResponse(
                requestID: requestID,
                sessionID: nil,
                result: MobileActionResult(
                    type: "info",
                    message: "Merge cancelled",
                    title: "Sibling Agents Active"
                )
            ))

        case let (.mergeFallbackConfirmation(paneID), .confirm):
            guard let context = paneContext(for: paneID) else {
                return .error(MobileProtocolErrorResponse(
                    requestID: requestID,
                    code: "unknown_pane",
                    message: "Pane \(paneID) is not published by this fixture."
                ))
            }
            let sessionID = nextActionSessionID()
            pendingActions[sessionID] = .mergeFinalConfirmation(paneID: paneID)
            return .actionResult(MobileActionsResultResponse(
                requestID: requestID,
                sessionID: sessionID,
                result: MobileActionResult(
                    type: "confirm",
                    message: "Merge \"\(context.paneTitle)\" into \(context.targetBranch ?? "main")?",
                    title: "Merge Worktree",
                    confirmLabel: "Merge",
                    cancelLabel: "Cancel",
                    data: actionScope(
                        for: context,
                        consequence: "The host performs the merge and reports the terminal result."
                    )
                )
            ))

        case (.mergeFallbackConfirmation, .cancel):
            return .actionResult(MobileActionsResultResponse(
                requestID: requestID,
                sessionID: nil,
                result: MobileActionResult(
                    type: "info",
                    message: "Merge cancelled",
                    title: "Parent Merge Target Unavailable"
                )
            ))

        case let (.mergeFinalConfirmation(paneID), .confirm):
            let paneTitle = paneContext(for: paneID)?.paneTitle ?? paneID
            return .actionResult(MobileActionsResultResponse(
                requestID: requestID,
                sessionID: nil,
                result: MobileActionResult(
                    type: "success",
                    message: "Merged \"\(paneTitle)\" into main.",
                    title: "Merge Worktree"
                )
            ))

        case (.mergeFinalConfirmation, .cancel):
            return .actionResult(MobileActionsResultResponse(
                requestID: requestID,
                sessionID: nil,
                result: MobileActionResult(
                    type: "info",
                    message: "Merge cancelled",
                    title: "Merge Worktree"
                )
            ))

        case let (.mergeUncommittedChoice(paneID), .choice(optionID)):
            let paneTitle = paneContext(for: paneID)?.paneTitle ?? paneID
            switch optionID {
            case "commit_automatic":
                return .actionResult(MobileActionsResultResponse(
                    requestID: requestID,
                    sessionID: nil,
                    result: MobileActionResult(
                        type: "error",
                        message: "Fixture host could not auto-commit the changes for \"\(paneTitle)\".",
                        title: "Merge Failed"
                    )
                ))
            case "commit_manual":
                return .actionResult(MobileActionsResultResponse(
                    requestID: requestID,
                    sessionID: nil,
                    result: MobileActionResult(
                        type: "error",
                        message: "Fixture host needs a manual commit before it can merge \"\(paneTitle)\".",
                        title: "Merge Failed"
                    )
                ))
            case "cancel":
                return .actionResult(MobileActionsResultResponse(
                    requestID: requestID,
                    sessionID: nil,
                    result: MobileActionResult(
                        type: "info",
                        message: "Merge cancelled",
                        title: "Worktree Has Uncommitted Changes"
                    )
                ))
            default:
                return .error(MobileProtocolErrorResponse(
                    requestID: requestID,
                    code: "invalid_action_response",
                    message: "Merge option \(optionID) is not supported by this fixture."
                ))
            }

        case let (.rename(paneID), .input(value)):
            let title = value.trimmingCharacters(in: .whitespacesAndNewlines)
            apply { Self.retitlePane(paneID, to: title.isEmpty ? nil : title, in: $0) }
            let savedTitle = paneContext(for: paneID)?.paneTitle ?? (title.isEmpty ? paneID : title)
            return .actionResult(MobileActionsResultResponse(
                requestID: requestID,
                sessionID: nil,
                result: MobileActionResult(
                    type: "success",
                    message: "Renamed pane to \(savedTitle).",
                    title: "Rename Pane"
                )
            ))

        case (.rename, .cancel):
            return cancelledActionResult(requestID: requestID, title: "Rename Pane")

        case let (.createPullRequestConfirm(paneID), .confirm):
            guard let context = paneContext(for: paneID) else {
                return .error(MobileProtocolErrorResponse(
                    requestID: requestID,
                    code: "unknown_pane",
                    message: "Pane \(paneID) is not published by this fixture."
                ))
            }
            let sessionID = nextActionSessionID()
            pendingActions[sessionID] = .createPullRequestReview(paneID: paneID)
            return .actionResult(MobileActionsResultResponse(
                requestID: requestID,
                sessionID: sessionID,
                result: MobileActionResult(
                    type: "pr_review",
                    message: "Review the pull request title and body before sending it.",
                    title: "Create Pull Request",
                    defaultValue: "feat(website): ship \(context.paneTitle)\n\n## Summary\n- Publish the reviewed homepage polish changes.\n\n## Changes\n- Refresh the launch copy and supporting assets.",
                    reviewData: MobileActionReviewData(
                        repoPath: context.worktreePath ?? "/fixture",
                        sourceBranch: context.sourceBranch ?? "feature",
                        targetBranch: context.targetBranch ?? "main",
                        files: Self.pullRequestFiles,
                        aiFailed: false
                    ),
                    data: actionScope(
                        for: context,
                        consequence: "Creates a pull request on the paired host."
                    ),
                    relatedFiles: Self.pullRequestFiles
                )
            ))

        case (.createPullRequestConfirm, .cancel):
            return cancelledActionResult(requestID: requestID, title: "Create Pull Request")

        case let (.createPullRequestReview(paneID), .input(summary)):
            let parsed = Self.parsePullRequestSummary(summary)
            guard !parsed.title.isEmpty else {
                return .actionResult(MobileActionsResultResponse(
                    requestID: requestID,
                    sessionID: nil,
                    result: MobileActionResult(
                        type: "error",
                        message: "PR title cannot be empty",
                        title: "Create Pull Request"
                    )
                ))
            }
            let paneTitle = paneContext(for: paneID)?.paneTitle ?? paneID
            let message = parsed.body.isEmpty
                ? "Created PR \"\(parsed.title)\" for \(paneTitle): https://github.com/OpenCoven/psyche-build/pull/903"
                : "Created PR \"\(parsed.title)\" with your edited summary: https://github.com/OpenCoven/psyche-build/pull/903"
            return .actionResult(MobileActionsResultResponse(
                requestID: requestID,
                sessionID: nil,
                result: MobileActionResult(
                    type: "success",
                    message: message,
                    title: "Create Pull Request"
                )
            ))

        case (.createPullRequestReview, .cancel):
            return cancelledActionResult(requestID: requestID, title: "Create Pull Request")

        case let (.close(paneID), .choice(optionID)):
            let paneTitle = paneContext(for: paneID)?.paneTitle ?? paneID
            apply { Self.removePane(paneID, from: $0) }
            let message: String
            switch optionID {
            case "kill_only":
                message = "Closed \(paneTitle)."
            case "kill_and_clean":
                message = "Closed \(paneTitle) and started worktree cleanup."
            case "kill_clean_branch":
                message = "Closed \(paneTitle) and started worktree and branch cleanup."
            default:
                return .error(MobileProtocolErrorResponse(
                    requestID: requestID,
                    code: "invalid_action_response",
                    message: "Cleanup option \(optionID) is not supported by this fixture."
                ))
            }
            return .actionResult(MobileActionsResultResponse(
                requestID: requestID,
                sessionID: nil,
                result: MobileActionResult(
                    type: "success",
                    message: message,
                    title: "Close Pane"
                )
            ))

        case (.close, .cancel):
            return cancelledActionResult(requestID: requestID, title: "Close Pane")

        default:
            return .error(MobileProtocolErrorResponse(
                requestID: requestID,
                code: "invalid_action_response",
                message: "Fixture action response did not match the current action state."
            ))
        }
    }

    private func nextActionSessionID() -> String {
        nextActionSession += 1
        return "fixture-action-\(nextActionSession)"
    }

    private func paneContext(for paneID: String) -> FixturePaneContext? {
        for project in workspace.projects {
            if let pane = project.projectPanes.first(where: { $0.id == paneID }) {
                return FixturePaneContext(
                    projectID: project.id,
                    projectTitle: project.title,
                    paneID: pane.id,
                    paneTitle: pane.title ?? pane.id,
                    worktreePath: nil,
                    sourceBranch: nil,
                    targetBranch: nil
                )
            }
            for worktree in project.worktrees {
                guard let pane = worktree.panes.first(where: { $0.id == paneID }) else { continue }
                let sourceBranch = worktree.branch
                let targetBranch = sourceBranch == "main" ? nil : "main"
                return FixturePaneContext(
                    projectID: project.id,
                    projectTitle: project.title,
                    paneID: pane.id,
                    paneTitle: pane.title ?? pane.id,
                    worktreePath: worktree.path,
                    sourceBranch: sourceBranch,
                    targetBranch: targetBranch
                )
            }
        }
        return nil
    }

    private func actionScope(
        for context: FixturePaneContext,
        consequence: String
    ) -> [String: String] {
        var data: [String: String] = [
            "host": Self.fixtureHostName,
            "projectId": context.projectID,
            "projectTitle": context.projectTitle,
            "consequence": consequence,
        ]
        if let worktreePath = context.worktreePath {
            data["worktreePath"] = worktreePath
        }
        if let sourceBranch = context.sourceBranch {
            data["sourceBranch"] = sourceBranch
        }
        if let targetBranch = context.targetBranch {
            data["targetBranch"] = targetBranch
        }
        return data
    }

    private func cancelledActionResult(requestID: String, title: String) -> MobileControlResponse {
        .actionResult(MobileActionsResultResponse(
            requestID: requestID,
            sessionID: nil,
            result: MobileActionResult(
                type: "info",
                message: "Action cancelled.",
                title: title
            )
        ))
    }

    private static func parsePullRequestSummary(_ input: String) -> (title: String, body: String) {
        let normalized = input
            .replacingOccurrences(of: "\r\n", with: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else {
            return ("", "")
        }
        guard let newline = normalized.firstIndex(of: "\n") else {
            return (normalized, "")
        }

        let title = String(normalized[..<newline]).trimmingCharacters(in: .whitespacesAndNewlines)
        let bodyStart = normalized.index(after: newline)
        let body = String(
            String(normalized[bodyStart...])
                .drop(while: { $0 == "\n" })
        )
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (title, body)
    }

    // MARK: - Snapshot edits

    private static let fixtureHostName = "psyche-demo.local"
    private static let mergeFiles = ["Sources/App.swift", "Sources/Deleted.swift"]
    private static let pullRequestFiles = ["Sources/App.swift", "Sources/Deleted.swift"]

    private static func ritualLaunchPath(
        in workspace: WorkspaceSnapshot,
        projectID: String
    ) -> String {
        workspace.projects.first(where: { $0.id == projectID })?.worktrees.first?.path ?? "/fixture"
    }

    private static func insertPane(
        _ pane: WorkspacePaneSnapshot,
        into workspace: WorkspaceSnapshot,
        projectID: String,
        cwd: String
    ) -> WorkspaceSnapshot {
        WorkspaceSnapshot(
            revision: workspace.revision + 1,
            projects: workspace.projects.map { project in
                guard project.id == projectID else { return project }
                var inserted = false
                let worktrees = project.worktrees.map { worktree -> WorkspaceWorktreeSnapshot in
                    guard worktree.path == cwd, !inserted else { return worktree }
                    inserted = true
                    return worktree.replacingPanes(worktree.panes + [pane])
                }
                return project.replacing(
                    worktrees: worktrees,
                    projectPanes: inserted ? project.projectPanes : project.projectPanes + [pane]
                )
            }
        )
    }

    private static func removePane(
        _ paneID: String,
        from workspace: WorkspaceSnapshot
    ) -> WorkspaceSnapshot {
        WorkspaceSnapshot(
            revision: workspace.revision + 1,
            projects: workspace.projects.map { project in
                project.replacing(
                    worktrees: project.worktrees.map { worktree in
                        worktree.replacingPanes(worktree.panes.filter { $0.id != paneID })
                    },
                    projectPanes: project.projectPanes.filter { $0.id != paneID }
                )
            }
        )
    }

    private static func retitlePane(
        _ paneID: String,
        to title: String?,
        in workspace: WorkspaceSnapshot
    ) -> WorkspaceSnapshot {
        func retitled(_ pane: WorkspacePaneSnapshot) -> WorkspacePaneSnapshot {
            guard pane.id == paneID else { return pane }
            return WorkspacePaneSnapshot(
                id: pane.id,
                cwd: pane.cwd,
                title: title ?? pane.title,
                kind: pane.kind,
                agent: pane.agent,
                status: pane.status,
                needsAttention: pane.needsAttention,
                lastActivity: pane.lastActivity,
                recoverability: pane.recoverability
            )
        }

        return WorkspaceSnapshot(
            revision: workspace.revision + 1,
            projects: workspace.projects.map { project in
                project.replacing(
                    worktrees: project.worktrees.map { $0.replacingPanes($0.panes.map(retitled)) },
                    projectPanes: project.projectPanes.map(retitled)
                )
            }
        )
    }
}

private enum FixtureControlRequestError: LocalizedError {
    case inspectionUnavailable

    var errorDescription: String? {
        "Fixture inspection unavailable."
    }
}

private enum FixturePendingAction {
    case mergeSiblingConfirmation(paneID: String)
    case mergeFallbackConfirmation(paneID: String)
    case mergeFinalConfirmation(paneID: String)
    case mergeUncommittedChoice(paneID: String)
    case rename(paneID: String)
    case createPullRequestConfirm(paneID: String)
    case createPullRequestReview(paneID: String)
    case close(paneID: String)
}

private struct FixturePaneContext {
    let projectID: String
    let projectTitle: String
    let paneID: String
    let paneTitle: String
    let worktreePath: String?
    let sourceBranch: String?
    let targetBranch: String?
}

extension WorkspaceProjectSnapshot {
    func replacing(
        worktrees: [WorkspaceWorktreeSnapshot],
        projectPanes: [WorkspacePaneSnapshot]
    ) -> WorkspaceProjectSnapshot {
        WorkspaceProjectSnapshot(
            id: id,
            root: root,
            title: title,
            worktrees: worktrees,
            projectPanes: projectPanes,
            runningCount: runningCount,
            attentionCount: attentionCount
        )
    }
}

extension WorkspaceWorktreeSnapshot {
    func replacingPanes(_ panes: [WorkspacePaneSnapshot]) -> WorkspaceWorktreeSnapshot {
        WorkspaceWorktreeSnapshot(
            path: path,
            head: head,
            branch: branch,
            isMain: isMain,
            detached: detached,
            bare: bare,
            locked: locked,
            lockReason: lockReason,
            prunable: prunable,
            pruneReason: pruneReason,
            dirty: dirty,
            missing: missing,
            panes: panes,
            runningCount: runningCount,
            attentionCount: attentionCount
        )
    }
}
