import PsycheCore
import SwiftUI

struct PaneRitualContext: Equatable {
    let projectID: String
    let projectTitle: String
    let rituals: [WorkspaceRitualSnapshot]

    static func resolve(
        paneID: String,
        in workspace: WorkspaceSnapshot?
    ) -> PaneRitualContext? {
        guard let project = workspace?.projects.first(where: { project in
            project.projectPanes.contains { $0.id == paneID }
                || project.worktrees.contains { worktree in
                    worktree.panes.contains { $0.id == paneID }
                }
        }) else {
            return nil
        }
        return PaneRitualContext(
            projectID: project.id,
            projectTitle: project.title,
            rituals: project.rituals
        )
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
    @State private var errorMessage: String?

    var body: some View {
        Menu {
            Button {
                isCreating = true
            } label: {
                Label("New pane", systemImage: "plus")
            }
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
            _ = try await store.requestFullSnapshot()
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
                errorMessage = error.localizedDescription
            }
            isWorking = false
        }
    }
}
