import PsycheCore
import SwiftUI

/// Every project the host publishes, with the two counts that decide whether
/// you need to look: how much is running, and how much is waiting on you.
struct ProjectsView: View {
    @EnvironmentObject private var store: WorkspaceStore

    private var projects: [WorkspaceProjectSnapshot] {
        store.workspace?.projects ?? []
    }

    var body: some View {
        List {
            ForEach(projects) { project in
                NavigationLink {
                    ProjectDetailView(projectID: project.id)
                } label: {
                    ProjectRow(project: project)
                }
                .accessibilityIdentifier("project-\(project.id)")
            }
        }
        .listStyle(.insetGrouped)
        .overlay {
            if projects.isEmpty {
                ContentUnavailableView(
                    "No projects",
                    systemImage: "folder",
                    description: Text("Projects appear once a host publishes its workspace.")
                )
                .accessibilityIdentifier("projects-empty")
            }
        }
        .navigationTitle("Projects")
        .accessibilityIdentifier("projects-view")
    }
}

struct ProjectRow: View {
    let project: WorkspaceProjectSnapshot

    private var branch: String? {
        project.worktrees.first(where: \.isMain)?.branch ?? project.worktrees.first?.branch
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(project.title)
                .font(.body.weight(.semibold))
            Text(subtitle)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.vertical, 4)
        .frame(minHeight: PsycheTheme.minimumTapTarget, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
    }

    private var subtitle: String {
        PaneAccessibility.projectSubtitle(
            branch: branch,
            runningCount: project.runningCount,
            attentionCount: project.attentionCount
        )
    }

    private var accessibilityLabel: String {
        PaneAccessibility.projectLabel(
            title: project.title,
            branch: branch,
            runningCount: project.runningCount,
            attentionCount: project.attentionCount
        )
    }
}

/// Panes grouped under the worktree they belong to, because "which checkout is
/// this running in" is the question that actually disambiguates two panes with
/// the same name.
struct ProjectDetailView: View {
    @EnvironmentObject private var store: WorkspaceStore
    @EnvironmentObject private var model: AppModel
    let projectID: String

    private var project: WorkspaceProjectSnapshot? {
        store.workspace?.projects.first { $0.id == projectID }
    }

    var body: some View {
        List {
            if let project {
                ForEach(project.worktrees) { worktree in
                    Section {
                        if worktree.panes.isEmpty {
                            Text("No panes")
                                .foregroundStyle(.secondary)
                        } else {
                            ForEach(worktree.panes) { pane in
                                paneLink(pane, in: project)
                            }
                        }
                    } header: {
                        WorktreeHeader(worktree: worktree)
                    }
                }

                // Panes the host could not place in a worktree still have to be
                // reachable — hiding them would strand whatever is running there.
                if !project.projectPanes.isEmpty {
                    Section {
                        ForEach(project.projectPanes) { pane in
                            paneLink(pane, in: project)
                        }
                    } header: {
                        Text("Unattached panes")
                    } footer: {
                        Text("These panes are not associated with a worktree.")
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(project?.title ?? "Project")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("project-detail-\(projectID)")
    }

    private func paneLink(
        _ pane: WorkspacePaneSnapshot,
        in project: WorkspaceProjectSnapshot
    ) -> some View {
        NavigationLink(value: pane.id) {
            WorkspacePaneRow(
                pane: pane,
                projectTitle: project.title,
                hostName: model.hostName
            )
        }
        .accessibilityIdentifier("project-pane-\(pane.id)")
    }
}

struct WorktreeHeader: View {
    let worktree: WorkspaceWorktreeSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(worktree.branch ?? worktree.head)
            Text(states.joined(separator: " · "))
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "Worktree \(worktree.branch ?? worktree.head), \(states.joined(separator: ", "))"
        )
    }

    private var states: [String] {
        PaneAccessibility.worktreeStates(for: worktree)
    }
}

struct WorkspacePaneRow: View {
    let pane: WorkspacePaneSnapshot
    let projectTitle: String
    let hostName: String?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            WorkspaceStatusDot(
                status: pane.status,
                needsAttention: pane.needsAttention ?? false
            )
            .padding(.top, 6)
            VStack(alignment: .leading, spacing: 4) {
                Text(pane.title ?? pane.id)
                    .font(.body.weight(.semibold))
                    .lineLimit(2)
                Text([pane.agent, pane.status].compactMap { $0 }.joined(separator: " · "))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 6)
        .frame(minHeight: PsycheTheme.minimumTapTarget)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
    }

    private var accessibilityLabel: String {
        PaneAccessibility.label(for: pane, projectTitle: projectTitle, hostName: hostName)
    }
}
