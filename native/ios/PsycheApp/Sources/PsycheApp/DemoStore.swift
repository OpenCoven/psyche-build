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
        let store = WorkspaceStore()
        store.applySnapshot(workspace: WorkspaceFixtures.workspace(named: name), sequence: 1)
        return store
    }
}
