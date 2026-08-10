import PsycheCore
import SwiftUI

/// First compiling stage of the pane workspace. Phase 5 replaces the body with
/// the terminal registry and the adaptive one/two-pane layout; what matters
/// here is that a Now row or a project row reaches a pane in one tap and that
/// the selection lands in the store.
struct PaneWorkspaceView: View {
    @EnvironmentObject private var store: WorkspaceStore
    private let requestedPrimaryPaneID: String?

    init(primaryPaneID: String? = nil) {
        requestedPrimaryPaneID = primaryPaneID
    }

    private var pane: WorkspacePaneSnapshot? {
        guard let paneID = store.primaryPaneID, let workspace = store.workspace else {
            return nil
        }
        for project in workspace.projects {
            for worktree in project.worktrees {
                if let match = worktree.panes.first(where: { $0.id == paneID }) {
                    return match
                }
            }
            if let match = project.projectPanes.first(where: { $0.id == paneID }) {
                return match
            }
        }
        return nil
    }

    var body: some View {
        Group {
            if let pane {
                VStack(alignment: .leading, spacing: 8) {
                    Text(pane.title ?? pane.id)
                        .font(.title3.weight(.semibold))
                    Text(pane.status)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Text(pane.cwd)
                        .font(.caption.monospaced())
                        .foregroundStyle(.tertiary)
                    Spacer()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .padding()
                .accessibilityIdentifier("pane-workspace-\(pane.id)")
            } else {
                ContentUnavailableView(
                    "No pane selected",
                    systemImage: "rectangle.stack"
                )
                .accessibilityIdentifier("no-pane-detail")
            }
        }
        .navigationTitle(pane?.title ?? "Pane")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("pane-workspace")
        .onAppear {
            if let requestedPrimaryPaneID {
                store.primaryPaneID = requestedPrimaryPaneID
            }
        }
    }
}
