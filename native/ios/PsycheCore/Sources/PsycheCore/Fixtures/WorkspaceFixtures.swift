import Foundation

/// Deterministic workspace snapshots for previews and UI tests.
///
/// These live beside the production types rather than in the app target so
/// their determinism can be asserted by unit tests. Nothing here touches the
/// network or the Keychain: a fixture launch composes state directly.
public enum WorkspaceFixtures {
    public static let multiproject = "multiproject"

    /// Unknown names trap rather than falling back. A UI test that asks for a
    /// scenario nobody built must fail loudly, not quietly assert against
    /// whatever the default happened to be.
    public static func workspace(named name: String) -> WorkspaceSnapshot {
        switch name {
        case multiproject:
            multiprojectWorkspace()
        default:
            preconditionFailure("Unknown workspace fixture '\(name)'")
        }
    }

    public static func names() -> [String] {
        [multiproject]
    }

    /// Three projects that between them populate every Now section — a waiting
    /// pane for Needs You, a working pane for Running, an idle pane for Recent
    /// — plus a project with no panes at all, so empty states stay covered.
    static func multiprojectWorkspace(revision: Int = 1) -> WorkspaceSnapshot {
        WorkspaceSnapshot(
            revision: revision,
            projects: [
                WorkspaceProjectSnapshot(
                    id: "psyche",
                    root: "/Users/demo/Code/psyche-build",
                    title: "psyche-build",
                    worktrees: [
                        worktree(
                            path: "/Users/demo/Code/psyche-build",
                            branch: "main",
                            isMain: true,
                            panes: [
                                pane(
                                    id: "bridge-protocol",
                                    cwd: "/Users/demo/Code/psyche-build",
                                    title: "bridge wire protocol",
                                    kind: "shell",
                                    agent: nil,
                                    status: "idle",
                                    needsAttention: false,
                                    lastActivity: "2026-08-09T17:40:00.000Z"
                                )
                            ]
                        ),
                        worktree(
                            path: "/Users/demo/Code/psyche-build/.worktrees/native-ios-cloud-terminal",
                            branch: "feat/native-ios-cloud-terminal",
                            isMain: false,
                            dirty: true,
                            panes: [
                                pane(
                                    id: "ios-cockpit",
                                    cwd: "/Users/demo/Code/psyche-build/.worktrees/native-ios-cloud-terminal",
                                    title: "native-ios-cloud-terminal",
                                    kind: "agent",
                                    agent: "Copilot",
                                    status: "working",
                                    needsAttention: false,
                                    lastActivity: "2026-08-09T17:45:00.000Z"
                                )
                            ]
                        )
                    ],
                    projectPanes: [],
                    runningCount: 1,
                    attentionCount: 0
                ),
                WorkspaceProjectSnapshot(
                    id: "website",
                    root: "/Users/demo/Code/open-coven.dev",
                    title: "open-coven.dev",
                    worktrees: [
                        worktree(
                            path: "/Users/demo/Code/open-coven.dev",
                            branch: "feat/home-polish",
                            isMain: true,
                            panes: [
                                pane(
                                    id: "web-home",
                                    cwd: "/Users/demo/Code/open-coven.dev",
                                    title: "homepage polish",
                                    kind: "agent",
                                    agent: "Claude",
                                    status: "waiting",
                                    needsAttention: true,
                                    lastActivity: "2026-08-09T17:50:00.000Z"
                                )
                            ]
                        )
                    ],
                    projectPanes: [],
                    runningCount: 0,
                    attentionCount: 1
                ),
                WorkspaceProjectSnapshot(
                    id: "infra",
                    root: "/Users/demo/Code/coven-infra",
                    title: "coven-infra",
                    worktrees: [
                        worktree(
                            path: "/Users/demo/Code/coven-infra",
                            branch: "main",
                            isMain: true,
                            panes: []
                        )
                    ],
                    projectPanes: [],
                    runningCount: 0,
                    attentionCount: 0
                )
            ]
        )
    }

    private static func worktree(
        path: String,
        branch: String,
        isMain: Bool,
        dirty: Bool = false,
        panes: [WorkspacePaneSnapshot]
    ) -> WorkspaceWorktreeSnapshot {
        WorkspaceWorktreeSnapshot(
            path: path,
            head: "0000000000000000000000000000000000000000",
            branch: branch,
            isMain: isMain,
            detached: false,
            bare: false,
            locked: false,
            lockReason: nil,
            prunable: false,
            pruneReason: nil,
            dirty: dirty,
            missing: false,
            panes: panes,
            runningCount: panes.filter { $0.status == "working" }.count,
            attentionCount: panes.filter { $0.needsAttention == true }.count
        )
    }

    private static func pane(
        id: String,
        cwd: String,
        title: String,
        kind: String,
        agent: String?,
        status: String,
        needsAttention: Bool,
        lastActivity: String
    ) -> WorkspacePaneSnapshot {
        WorkspacePaneSnapshot(
            id: id,
            cwd: cwd,
            title: title,
            kind: kind,
            agent: agent,
            status: status,
            needsAttention: needsAttention,
            lastActivity: lastActivity,
            recoverability: "recoverable"
        )
    }
}
