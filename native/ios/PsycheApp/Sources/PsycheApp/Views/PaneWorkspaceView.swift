import PsycheCore
import SwiftUI

/// The terminal workspace: one pane, or two side by side when there is room.
///
/// Only the panes actually on screen get a `TerminalPaneView`, and the
/// registry attaches exactly those. Portrait hides the secondary rather than
/// discarding it, so rotating back restores the split instead of making you
/// pick the pane again.
struct PaneWorkspaceView: View {
    @EnvironmentObject private var store: WorkspaceStore
    @EnvironmentObject private var registry: TerminalSessionRegistry
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    private let requestedPrimaryPaneID: String?

    init(primaryPaneID: String? = nil) {
        requestedPrimaryPaneID = primaryPaneID
    }

    var body: some View {
        GeometryReader { proxy in
            let showsSplit = supportsSplit(proxy.size)
            VStack(spacing: 0) {
                if let primary = primaryPane {
                    terminals(primary: primary, showsSplit: showsSplit)
                } else {
                    ContentUnavailableView("No pane selected", systemImage: "rectangle.stack")
                        .accessibilityIdentifier("no-pane-detail")
                }
                if choices.count > 1 {
                    Divider().overlay(PsycheTheme.border)
                    PaneSwitcher(
                        panes: choices,
                        primaryPaneID: store.primaryPaneID,
                        secondaryPaneID: showsSplit ? store.secondaryPaneID : nil,
                        canSplit: showsSplit,
                        onSelect: select,
                        onSplit: splitBeside
                    )
                }
            }
        }
        .navigationTitle(primaryPane?.title ?? primaryPane?.id ?? "Pane")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier(
            primaryPane.map { "pane-workspace-\($0.id)" } ?? "pane-workspace"
        )
        .task(id: workspaceKey) {
            if let requestedPrimaryPaneID, store.primaryPaneID != requestedPrimaryPaneID {
                store.primaryPaneID = requestedPrimaryPaneID
            }
            await syncRegistry()
        }
    }

    @ViewBuilder
    private func terminals(primary: WorkspacePaneSnapshot, showsSplit: Bool) -> some View {
        if showsSplit, let secondary = secondaryPane {
            HStack(spacing: 1) {
                terminal(for: primary).frame(width: nil)
                Divider().overlay(PsycheTheme.border)
                terminal(for: secondary)
            }
        } else {
            terminal(for: primary)
        }
    }

    private func terminal(for pane: WorkspacePaneSnapshot) -> some View {
        TerminalPaneView(
            paneID: pane.id,
            title: pane.title ?? pane.id,
            isFocused: registry.focusedPaneID == pane.id,
            onFocus: { registry.focus(pane.id) }
        )
    }

    // MARK: - Selection

    private func select(_ paneID: String) {
        if store.secondaryPaneID == paneID {
            registry.focus(paneID)
            return
        }
        store.primaryPaneID = paneID
        if store.secondaryPaneID == paneID { store.secondaryPaneID = nil }
    }

    private func splitBeside(_ paneID: String) {
        guard paneID != store.primaryPaneID else { return }
        store.secondaryPaneID = paneID
    }

    // MARK: - Registry

    /// Re-runs whenever the shown panes change, so the registry attaches
    /// exactly what is on screen and nothing else.
    private var workspaceKey: String {
        [
            requestedPrimaryPaneID ?? "",
            store.primaryPaneID ?? "",
            store.secondaryPaneID ?? "",
            horizontalSizeClass == .regular ? "regular" : "compact",
        ].joined(separator: "|")
    }

    private func syncRegistry() async {
        await registry.show(primary: store.primaryPaneID, secondary: store.secondaryPaneID)
    }

    // MARK: - Data

    private var panes: [WorkspacePaneSnapshot] {
        guard let workspace = store.workspace else { return [] }
        return workspace.projects.flatMap { project in
            project.worktrees.flatMap(\.panes) + project.projectPanes
        }
    }

    private var choices: [PaneSwitcher.PaneChoice] {
        panes.map {
            PaneSwitcher.PaneChoice(
                id: $0.id,
                title: $0.title ?? $0.id,
                status: $0.status,
                needsAttention: $0.needsAttention ?? false
            )
        }
    }

    private var primaryPane: WorkspacePaneSnapshot? {
        pane(store.primaryPaneID)
    }

    private var secondaryPane: WorkspacePaneSnapshot? {
        guard let secondary = pane(store.secondaryPaneID), secondary.id != primaryPane?.id else {
            return nil
        }
        return secondary
    }

    private func pane(_ paneID: String?) -> WorkspacePaneSnapshot? {
        guard let paneID else { return nil }
        return panes.first { $0.id == paneID }
    }

    /// Two terminals need real width. Regular width always qualifies; compact
    /// only does in landscape, where the window is wider than it is tall.
    private func supportsSplit(_ size: CGSize) -> Bool {
        guard store.secondaryPaneID != nil else { return false }
        if horizontalSizeClass == .regular { return size.width >= 700 }
        return size.width > size.height && size.width >= 640
    }
}
