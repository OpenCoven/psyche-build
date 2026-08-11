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
    private let updates: AsyncStream<WorkspaceUpdate>
    private let continuation: AsyncStream<WorkspaceUpdate>.Continuation

    public struct WorkspaceUpdate: Sendable {
        public let workspace: WorkspaceSnapshot
        public let sequence: UInt64
    }

    public init(workspace: WorkspaceSnapshot, sequence: UInt64 = 1) {
        self.workspace = workspace
        self.sequence = sequence
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

        default:
            return .ack(ControlAckResponse(requestID: requestID, ok: true))
        }
    }

    private func apply(_ transform: (WorkspaceSnapshot) -> WorkspaceSnapshot) {
        workspace = transform(workspace)
        sequence += 1
        continuation.yield(WorkspaceUpdate(workspace: workspace, sequence: sequence))
    }

    // MARK: - Snapshot edits

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
