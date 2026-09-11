import Combine
import Foundation
import PsycheCore

/// Fixture data, and nothing else.
///
/// The demo drill-down this used to back is gone; production views read a
/// `WorkspaceStore`. What remains is the bridge a `-uiFixture` launch uses to
/// turn a named scenario into deterministic state.
@MainActor
enum DemoStore {
    struct FixtureWorkspaceComposition {
        let workspaceStore: WorkspaceStore
        let controlRequests: FixtureControlRequests
    }

    /// Builds the deterministic store a `-uiFixture` launch runs against.
    static func makeFixtureWorkspace(
        fixture name: String,
        inspectionFails: Bool = false
    ) -> FixtureWorkspaceComposition {
        let workspace = WorkspaceFixtures.workspace(named: name)
        // A fixture control client, so create/rename/stop actually run and
        // republish the workspace the way a host broadcast would. Without it
        // every command would fail with "not connected" and those flows could
        // not be exercised at all.
        let requests = FixtureControlRequests(
            workspace: workspace,
            inspectionFails: inspectionFails
        )
        let store = WorkspaceStore(controlRequests: requests)
        if name == WorkspaceFixtures.staleRecovery {
            store.restoreCachedState(CachedWorkspaceState(
                workspace: workspace,
                sequence: 40,
                lastConfirmedAt: Date(timeIntervalSince1970: 1_786_286_400),
                selectedProjectID: nil,
                primaryPaneID: "cached-pane",
                secondaryPaneID: nil,
                drafts: ["cached-pane": "do not send while stale"]
            ))
            Task { @MainActor [weak store] in
                try? await Task.sleep(for: .seconds(10))
                store?.applySnapshot(
                    workspace: WorkspaceFixtures.staleRecoveryLiveWorkspace(),
                    sequence: 41
                )
            }
        } else {
            store.applySnapshot(workspace: workspace, sequence: 1)
        }

        Task { @MainActor [weak store] in
            for await update in await requests.workspaceUpdates() {
                guard let store else { return }
                store.applySnapshot(workspace: update.workspace, sequence: update.sequence)
            }
        }
        return FixtureWorkspaceComposition(
            workspaceStore: store,
            controlRequests: requests
        )
    }
}
