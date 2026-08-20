import PsycheCore
import SwiftUI

protocol PaneControlsAlertError: LocalizedError {
    var alertTitle: String { get }
}

struct PaneRitualContext: Equatable {
    let projectID: String
    let projectTitle: String
    let rituals: [WorkspaceRitualSnapshot]

    static func resolve(
        paneID: String,
        in workspace: WorkspaceSnapshot?
    ) -> PaneRitualContext? {
        guard let match = paneProjectMatch(paneID: paneID, in: workspace) else {
            return nil
        }
        return PaneRitualContext(
            projectID: match.project.id,
            projectTitle: match.project.title,
            rituals: match.project.rituals
        )
    }
}

struct PaneControlsErrorPresentation: Equatable {
    let title: String
    let message: String

    init(_ error: any Error) {
        if let alertError = error as? any PaneControlsAlertError {
            title = alertError.alertTitle
            message = alertError.errorDescription ?? error.localizedDescription
        } else {
            title = "That did not work"
            message = error.localizedDescription
        }
    }
}

struct RitualLaunchRefreshFailure: PaneControlsAlertError, Equatable {
    let ritualName: String
    let refreshErrorDescription: String

    var alertTitle: String { "Workspace refresh failed" }

    var errorDescription: String? {
        "\(ritualName) launched, but the workspace refresh failed. The ritual may already be running, so avoid retrying it until the workspace updates. \(refreshErrorDescription)"
    }
}

/// Rename and stop for the pane on screen, plus the way in to creating one.
struct PaneControlsMenu: View {
    @EnvironmentObject private var store: WorkspaceStore
    @EnvironmentObject private var model: AppModel

    let paneID: String
    let paneTitle: String
    let ritualContext: PaneRitualContext?

    @State private var isCreating = false
    @State private var isRenaming = false
    @State private var isConfirmingStop = false
    @State private var isWorking = false
    @State private var renameText = ""
    @State private var errorPresentation: PaneControlsErrorPresentation?

    var body: some View {
        Menu {
            Button {
                isCreating = true
            } label: {
                Label("New pane", systemImage: "plus")
            }
            .accessibilityIdentifier("pane-new")
            if let ritualContext, !ritualContext.rituals.isEmpty {
                Menu {
                    ForEach(ritualContext.rituals) { ritual in
                        Button {
                            launch(ritual, inProject: ritualContext.projectID)
                        } label: {
                            Text(ritual.displayName)
                        }
                        .disabled(store.isStale || isWorking)
                        .accessibilityIdentifier("pane-ritual-\(ritual.id)")
                        .accessibilityHint(Text(ritual.description ?? ""))
                    }
                } label: {
                    Label("Rituals", systemImage: "wand.and.stars")
                }
                .disabled(store.isStale || isWorking)
                .accessibilityIdentifier("pane-rituals")
            }
            Button {
                renameText = paneTitle
                isRenaming = true
            } label: {
                Label("Rename", systemImage: "pencil")
            }
            Button(role: .destructive) {
                isConfirmingStop = true
            } label: {
                Label("Stop", systemImage: "stop.circle")
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .disabled(isWorking)
        .accessibilityLabel("Pane actions")
        .accessibilityIdentifier("pane-actions")
        .sheet(isPresented: $isCreating) { CreatePaneSheet() }
        .alert("Rename pane", isPresented: $isRenaming) {
            TextField("Title", text: $renameText)
                .accessibilityIdentifier("rename-pane-field")
            Button("Cancel", role: .cancel) {}
            Button("Rename") { rename() }
        }
        .confirmationDialog(
            StopPaneConfirmation.title(paneTitle: paneTitle),
            isPresented: $isConfirmingStop,
            titleVisibility: .visible
        ) {
            Button("Stop pane", role: .destructive) { stop() }
            Button("Cancel", role: .cancel) {}
        } message: {
            // Names what is about to stop and says the work survives, so this
            // cannot be mistaken for deleting the worktree.
            Text(StopPaneConfirmation.message(
                paneTitle: paneTitle,
                projectTitle: ritualContext?.projectTitle ?? "this project",
                hostName: model.hostName
            ))
        }
        .alert(
            errorPresentation?.title ?? "That did not work",
            isPresented: Binding(
                get: { errorPresentation != nil },
                set: { if !$0 { errorPresentation = nil } }
            )
        ) {
            Button("OK", role: .cancel) { errorPresentation = nil }
        } message: {
            Text(errorPresentation?.message ?? "")
        }
    }

    private func rename() {
        let title = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, title != paneTitle else { return }
        run { try await store.renamePane(paneID, title: title) }
    }

    private func stop() {
        run { try await store.stopPane(paneID) }
    }

    private func launch(_ ritual: WorkspaceRitualSnapshot, inProject projectID: String) {
        run {
            try await store.launchRitual(ritual.id, inProject: projectID)
            do {
                _ = try await store.requestFullSnapshot()
            } catch {
                throw RitualLaunchRefreshFailure(
                    ritualName: ritual.displayName,
                    refreshErrorDescription: error.localizedDescription
                )
            }
        }
    }

    /// Failures surface instead of being swallowed — a command that quietly
    /// did nothing is indistinguishable from one that worked.
    private func run(_ operation: @escaping () async throws -> Void) {
        isWorking = true
        Task {
            do {
                try await operation()
            } catch {
                errorPresentation = PaneControlsErrorPresentation(error)
            }
            isWorking = false
        }
    }
}

struct PaneWorkspaceToolbarTarget: Equatable {
    let paneID: String
    let paneTitle: String
    let ritualContext: PaneRitualContext?

    static func resolve(
        primaryPaneID: String?,
        secondaryPaneID: String?,
        focusedPaneID: String?,
        in workspace: WorkspaceSnapshot?
    ) -> PaneWorkspaceToolbarTarget? {
        let visiblePaneIDs = Set([primaryPaneID, secondaryPaneID].compactMap { $0 })
        let targetPaneID = focusedPaneID.flatMap { visiblePaneIDs.contains($0) ? $0 : nil }
            ?? primaryPaneID
        guard let targetPaneID,
              let match = paneProjectMatch(paneID: targetPaneID, in: workspace)
        else {
            return nil
        }
        return PaneWorkspaceToolbarTarget(
            paneID: match.pane.id,
            paneTitle: match.pane.title ?? match.pane.id,
            ritualContext: PaneRitualContext(
                projectID: match.project.id,
                projectTitle: match.project.title,
                rituals: match.project.rituals
            )
        )
    }
}

private struct PaneProjectMatch {
    let project: WorkspaceProjectSnapshot
    let pane: WorkspacePaneSnapshot
}

private func paneProjectMatch(
    paneID: String,
    in workspace: WorkspaceSnapshot?
) -> PaneProjectMatch? {
    guard let workspace else { return nil }
    for project in workspace.projects {
        if let pane = project.projectPanes.first(where: { $0.id == paneID }) {
            return PaneProjectMatch(project: project, pane: pane)
        }
        for worktree in project.worktrees {
            if let pane = worktree.panes.first(where: { $0.id == paneID }) {
                return PaneProjectMatch(project: project, pane: pane)
            }
        }
    }
    return nil
}
