import Foundation
import PsycheCore

/// Row text, built where it can be tested.
///
/// The spoken label is not the visible text combined: a row shows project and
/// status but not which host it came from, and with several hosts paired that
/// is the difference between two identically named panes. So the label is
/// spelled out rather than synthesised from the subviews.
enum PaneAccessibility {
    static func contextLine(projectTitle: String, agent: String?, status: String) -> String {
        [projectTitle, agent ?? status]
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
    }

    static func label(
        title: String,
        projectTitle: String,
        status: String,
        agent: String?,
        hostName: String?,
        needsAttention: Bool
    ) -> String {
        var parts = [title, projectTitle, status]
        if let agent, !agent.isEmpty {
            parts.append("agent \(agent)")
        }
        if let hostName, !hostName.isEmpty {
            parts.append("on \(hostName)")
        }
        if needsAttention {
            parts.append("needs you")
        }
        return parts.joined(separator: ", ")
    }

    static func label(for item: NowItem, hostName: String?) -> String {
        label(
            title: item.title,
            projectTitle: item.projectTitle,
            status: item.status,
            agent: item.agent,
            hostName: hostName,
            needsAttention: item.needsAttention
        )
    }

    static func label(
        for pane: WorkspacePaneSnapshot,
        projectTitle: String,
        hostName: String?
    ) -> String {
        label(
            title: pane.title ?? pane.id,
            projectTitle: projectTitle,
            status: pane.status,
            agent: pane.agent,
            hostName: hostName,
            needsAttention: pane.needsAttention ?? false
        )
    }

    static func projectSubtitle(
        branch: String?,
        runningCount: Int,
        attentionCount: Int
    ) -> String {
        var parts: [String] = []
        if let branch, !branch.isEmpty { parts.append(branch) }
        parts.append("\(runningCount) running")
        if attentionCount > 0 {
            parts.append("\(attentionCount) needs you")
        }
        return parts.joined(separator: " · ")
    }

    static func projectLabel(
        title: String,
        branch: String?,
        runningCount: Int,
        attentionCount: Int
    ) -> String {
        var parts = [title]
        if let branch, !branch.isEmpty { parts.append("branch \(branch)") }
        parts.append("\(runningCount) running")
        parts.append("\(attentionCount) needing attention")
        return parts.joined(separator: ", ")
    }

    static func worktreeStates(for worktree: WorkspaceWorktreeSnapshot) -> [String] {
        var parts = [worktree.isMain ? "main worktree" : "linked worktree"]
        if worktree.dirty { parts.append("uncommitted changes") }
        if worktree.missing { parts.append("missing") }
        if worktree.locked { parts.append("locked") }
        if worktree.prunable { parts.append("prunable") }
        return parts
    }
}
