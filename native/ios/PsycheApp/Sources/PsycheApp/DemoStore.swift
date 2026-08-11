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
    /// Builds the deterministic store a `-uiFixture` launch runs against.
    static func makeWorkspaceStore(fixture name: String) -> WorkspaceStore {
        let workspace = WorkspaceFixtures.workspace(named: name)
        // A fixture control client, so create/rename/stop actually run and
        // republish the workspace the way a host broadcast would. Without it
        // every command would fail with "not connected" and those flows could
        // not be exercised at all.
        let requests = FixtureControlRequests(workspace: workspace)
        let store = WorkspaceStore(controlRequests: requests)
        store.applySnapshot(workspace: workspace, sequence: 1)

        Task { @MainActor [weak store] in
            for await update in await requests.workspaceUpdates() {
                guard let store else { return }
                store.applySnapshot(workspace: update.workspace, sequence: update.sequence)
            }
        }
        return store
    }
}
