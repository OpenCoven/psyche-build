import Foundation
import PsycheCore

/// The decisions behind the create sheet, kept apart from the sheet so the
/// defaults and the validation are testable without driving a UI.
struct CreatePaneForm: Equatable {
    struct Target: Identifiable, Equatable {
        let projectID: String
        let projectTitle: String
        let cwd: String
        /// Branch for a worktree, nil for the project root.
        let branch: String?

        var id: String { "\(projectID)|\(cwd)" }

        var label: String { branch ?? "project root" }
    }

    var kind: PaneCreateKind = .agent
    var projectID: String = ""
    var cwd: String = ""
    var agent: String = ""
    var title: String = ""
    var prompt: String = ""

    /// Every distinct place a pane can be created, ordered as the workspace
    /// publishes them so the list does not reshuffle between openings.
    ///
    /// A project's main worktree usually *is* its root, so listing both would
    /// offer the same directory twice — and give two rows the same identity,
    /// which a SwiftUI list does not survive.
    static func targets(in workspace: WorkspaceSnapshot?) -> [Target] {
        guard let workspace else { return [] }
        return workspace.projects.flatMap { project -> [Target] in
            var seen = Set<String>()
            var targets: [Target] = []

            for worktree in project.worktrees where seen.insert(worktree.path).inserted {
                targets.append(Target(
                    projectID: project.id,
                    projectTitle: project.title,
                    cwd: worktree.path,
                    branch: worktree.branch ?? worktree.head
                ))
            }
            if seen.insert(project.root).inserted {
                targets.append(Target(
                    projectID: project.id,
                    projectTitle: project.title,
                    cwd: project.root,
                    branch: nil
                ))
            }
            return targets
        }
    }

    /// Opens where you already are: the worktree of the pane in front of you,
    /// falling back to its project, then to whatever the workspace publishes
    /// first. Making someone re-pick the context they are looking at is the
    /// most common way a create sheet wastes their time.
    static func makeDefault(
        workspace: WorkspaceSnapshot?,
        focusedPaneID: String?,
        selectedProjectID: String?
    ) -> CreatePaneForm {
        let targets = targets(in: workspace)
        var form = CreatePaneForm()

        let preferred = targets.first { $0.cwd == cwdOfPane(focusedPaneID, in: workspace) }
            ?? targets.first { $0.projectID == projectOfPane(focusedPaneID, in: workspace) }
            ?? targets.first { $0.projectID == selectedProjectID }
            ?? targets.first

        if let preferred {
            form.projectID = preferred.projectID
            form.cwd = preferred.cwd
        }
        return form
    }

    /// A launch needs somewhere to land. Everything else is optional, and an
    /// agent pane without a prompt is a legitimate thing to want.
    var isValid: Bool {
        !projectID.isEmpty && !cwd.isEmpty
    }

    var trimmedAgent: String? { nonEmpty(agent) }
    var trimmedTitle: String? { nonEmpty(title) }
    var trimmedPrompt: String? { nonEmpty(prompt) }

    private func nonEmpty(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func cwdOfPane(_ paneID: String?, in workspace: WorkspaceSnapshot?) -> String? {
        guard let paneID, let workspace else { return nil }
        for project in workspace.projects {
            for worktree in project.worktrees where worktree.panes.contains(where: { $0.id == paneID }) {
                return worktree.path
            }
        }
        return nil
    }

    private static func projectOfPane(
        _ paneID: String?,
        in workspace: WorkspaceSnapshot?
    ) -> String? {
        guard let paneID, let workspace else { return nil }
        return workspace.projects.first { project in
            project.projectPanes.contains { $0.id == paneID }
                || project.worktrees.contains { worktree in
                    worktree.panes.contains { $0.id == paneID }
                }
        }?.id
    }
}

/// The words shown before a pane is stopped.
///
/// Naming the host, the project and the pane is what makes it possible to
/// notice you are about to stop the wrong one, and saying the worktree
/// survives is what stops this reading as a delete.
enum StopPaneConfirmation {
    static func title(paneTitle: String) -> String {
        "Stop \(paneTitle)?"
    }

    static func message(
        paneTitle: String,
        projectTitle: String,
        hostName: String?
    ) -> String {
        var parts = ["Stops \(paneTitle) in \(projectTitle)"]
        if let hostName, !hostName.isEmpty {
            parts.append("on \(hostName)")
        }
        return parts.joined(separator: " ")
            + ". The worktree and its branch are kept — this does not delete any work."
    }
}
