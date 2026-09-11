import PsycheCore
import SwiftUI

/// Pane-scoped actions from the toolbar.
struct PaneControlsMenu: View {
    @EnvironmentObject private var store: WorkspaceStore
    @EnvironmentObject private var model: AppModel

    let paneID: String
    let paneTitle: String
    let projectTitle: String

    @State private var isCreating = false
    @State private var isConfirmingStop = false
    @State private var isConfirmingCleanup = false
    @State private var isWorking = false
    @State private var errorMessage: String?
    @State private var inspectionTarget: PaneInspectionTarget?

    var body: some View {
        Menu {
            Button {
                isCreating = true
            } label: {
                Label("New pane", systemImage: "plus")
            }

            if hasWorktree {
                remoteActionButton(.merge, systemImage: PaneControlsMenuAction.merge.systemImage)
                remoteActionButton(
                    .createPR,
                    systemImage: PaneControlsMenuAction.createPullRequest.systemImage
                )
            }

            remoteActionButton(.rename, systemImage: PaneControlsMenuAction.rename.systemImage)

            Button {
                inspectionTarget = PaneInspectionTarget(paneID: paneID)
            } label: {
                Label(PaneControlsMenuAction.files.label, systemImage: PaneControlsMenuAction.files.systemImage)
            }
            .disabled(PaneControlsPresentation.filesDisabled(
                hasInspectableWorktree: hasInspectableWorktree,
                isStale: store.isStale,
                isBusy: localActionBusy
            ))

            ritualsMenu

            Divider()

            Button(role: .destructive) {
                isConfirmingStop = true
            } label: {
                Label(PaneControlsMenuAction.stop.label, systemImage: PaneControlsMenuAction.stop.systemImage)
            }
            .disabled(PaneControlsPresentation.hostActionDisabled(
                isStale: store.isStale,
                isBusy: localActionBusy
            ))

            Button(role: .destructive) {
                isConfirmingCleanup = true
            } label: {
                Label(PaneControlsMenuAction.cleanup.label, systemImage: PaneControlsMenuAction.cleanup.systemImage)
            }
            .disabled(PaneControlsPresentation.hostActionDisabled(
                isStale: store.isStale,
                isBusy: remoteActionBusy
            ))
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("Pane actions")
        .accessibilityIdentifier("pane-actions")
        .sheet(isPresented: $isCreating) { CreatePaneSheet() }
        .sheet(item: $inspectionTarget) { target in
            NavigationStack {
                FileBrowserView(paneID: target.paneID)
            }
        }
        .confirmationDialog(
            StopPaneConfirmation.title(paneTitle: paneTitle),
            isPresented: $isConfirmingStop,
            titleVisibility: .visible
        ) {
            Button("Stop pane", role: .destructive) { stop() }
            Button("Keep pane open") {}
            Button("Cancel", role: .cancel) {}
        } message: {
            // The consequence comes first so the destructive button is never
            // separated from what it will do.
            Text(StopPaneConfirmation.message(
                paneTitle: paneTitle,
                projectTitle: resolvedProjectTitle,
                hostName: model.hostName
            ))
        }
        .confirmationDialog(
            CleanupPaneConfirmation.title(paneTitle: paneTitle),
            isPresented: $isConfirmingCleanup,
            titleVisibility: .visible
        ) {
            Button("Continue to cleanup", role: .destructive) {
                startRemoteAction(.close)
            }
            Button("Keep pane open") {}
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(CleanupPaneConfirmation.message(
                paneTitle: paneTitle,
                projectTitle: resolvedProjectTitle,
                hostName: model.hostName
            ))
        }
        .alert(
            "That did not work",
            isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )
        ) {
            Button("OK", role: .cancel) { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "")
        }
    }

    private var paneContext: PaneWorkspaceContext? {
        guard let workspace = store.workspace else { return nil }
        for project in workspace.projects {
            if project.projectPanes.contains(where: { $0.id == paneID }) {
                return PaneWorkspaceContext(project: project, worktree: nil)
            }
            for worktree in project.worktrees where worktree.panes.contains(where: { $0.id == paneID }) {
                return PaneWorkspaceContext(project: project, worktree: worktree)
            }
        }
        return nil
    }

    private var resolvedProjectTitle: String {
        paneContext?.project.title ?? projectTitle
    }

    private var hasWorktree: Bool {
        paneContext?.worktree != nil
    }

    private var hasInspectableWorktree: Bool {
        guard let worktree = paneContext?.worktree else { return false }
        return !worktree.missing && !worktree.bare && !worktree.prunable
    }

    private var remoteActionBusy: Bool {
        isWorking || !model.remoteActionStore.canStartAction(onPane: paneID)
    }

    private var localActionBusy: Bool {
        isWorking
            || model.remoteActionStore.isBusy(paneID)
            || model.remoteActionStore.isSubmitting
    }

    @ViewBuilder
    private var ritualsMenu: some View {
        let menu = RitualMenuPresentation.make(
            project: paneContext?.project,
            isStaleWorkspace: store.isStale
        )

        Menu {
            switch menu {
            case .status(let label, let systemImage):
                Button {} label: {
                    Label(label, systemImage: systemImage)
                }
                .disabled(true)
            }
        } label: {
            Label(PaneControlsMenuAction.rituals.label, systemImage: PaneControlsMenuAction.rituals.systemImage)
        }
    }

    @ViewBuilder
    private func remoteActionButton(_ action: PaneAction, systemImage: String) -> some View {
        Button {
            startRemoteAction(action)
        } label: {
            Label(ActionSheetPresentation.actionLabel(for: action), systemImage: systemImage)
        }
        .disabled(PaneControlsPresentation.hostActionDisabled(
            isStale: store.isStale,
            isBusy: remoteActionBusy
        ))
    }

    private func startRemoteAction(_ action: PaneAction) {
        guard let workspace = store.workspace else {
            errorMessage = WorkspaceStoreError.staleWorkspace.localizedDescription
            return
        }
        Task {
            await model.remoteActionStore.start(action: action, onPane: paneID, in: workspace)
        }
    }

    private func stop() {
        run {
            try await store.stopPane(paneID)
        }
    }

    /// Failures surface instead of being swallowed - a command that quietly
    /// did nothing is indistinguishable from one that worked.
    private func run(_ operation: @escaping @MainActor () async throws -> Void) {
        guard !isWorking else { return }
        isWorking = true
        Task { @MainActor in
            defer { isWorking = false }
            do {
                try await operation()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

enum PaneControlsMenuAction: CaseIterable, Equatable {
    case merge
    case createPullRequest
    case rename
    case files
    case rituals
    case stop
    case cleanup

    var label: String {
        switch self {
        case .merge:
            "Merge"
        case .createPullRequest:
            "Create Pull Request"
        case .rename:
            "Rename"
        case .files:
            "Browse Files"
        case .rituals:
            "Rituals"
        case .stop:
            "Stop"
        case .cleanup:
            "Close and Cleanup"
        }
    }

    var systemImage: String {
        switch self {
        case .merge:
            "arrow.triangle.merge"
        case .createPullRequest:
            "arrow.up.right.square"
        case .rename:
            "pencil"
        case .files:
            "folder"
        case .rituals:
            "sparkles"
        case .stop:
            "stop.circle"
        case .cleanup:
            "trash"
        }
    }
}

enum PaneControlsPresentation {
    static func hostActionDisabled(isStale: Bool, isBusy: Bool) -> Bool {
        isStale || isBusy
    }

    static func filesDisabled(
        hasInspectableWorktree: Bool,
        isStale: Bool,
        isBusy: Bool
    ) -> Bool {
        !hasInspectableWorktree || hostActionDisabled(isStale: isStale, isBusy: isBusy)
    }
}

enum RitualMenuPresentation: Equatable {
    case status(label: String, systemImage: String)

    static func make(
        project: WorkspaceProjectSnapshot?,
        isStaleWorkspace: Bool
    ) -> Self {
        guard !isStaleWorkspace else {
            return .status(label: "Refresh the workspace to load rituals", systemImage: "clock.arrow.trianglehead.2.counterclockwise.rotate.90")
        }
        guard let project else {
            return .status(label: "This pane is no longer published by the host", systemImage: "exclamationmark.triangle")
        }
        guard let publication = project.rituals else {
            return .status(label: "This host did not publish rituals for \(project.title)", systemImage: "questionmark.circle")
        }

        switch publication.state {
        case .available:
            if publication.rituals.isEmpty {
                return .status(label: "No rituals are published for \(project.title)", systemImage: "sparkles")
            }
            // Publication does not advertise an execution capability (#242).
            return .status(
                label: "Ritual execution is not available on mobile yet",
                systemImage: "sparkles"
            )
        case .empty:
            return .status(label: "No rituals are published for \(project.title)", systemImage: "sparkles")
        case .stale:
            return .status(label: "Rituals are out of date; reconnect and refresh first", systemImage: "clock.badge.exclamationmark")
        case .incompatible:
            return .status(label: "This host does not support ritual publication", systemImage: "exclamationmark.arrow.trianglehead.2.clockwise.rotate.90")
        case .limitExceeded:
            return .status(label: "Too many rituals were published to show on mobile", systemImage: "list.bullet.clipboard")
        case .permissionDenied:
            return .status(label: "Ritual publication is not permitted for this project", systemImage: "lock.slash")
        case .unavailable:
            return .status(label: "Rituals are currently unavailable for \(project.title)", systemImage: "questionmark.circle")
        }
    }
}

private struct PaneWorkspaceContext {
    let project: WorkspaceProjectSnapshot
    let worktree: WorkspaceWorktreeSnapshot?
}

private struct PaneInspectionTarget: Identifiable {
    let paneID: String

    var id: String { paneID }
}
