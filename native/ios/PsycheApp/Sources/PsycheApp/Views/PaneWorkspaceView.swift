import PsycheCore
import SwiftUI

/// The terminal workspace: one pane, or two side by side when there is room.
///
/// Only the panes actually on screen get a `TerminalPaneView`, and the
/// registry attaches exactly those. Portrait hides the secondary rather than
/// discarding it, so rotating back restores the split instead of making you
/// pick the pane again.
struct PaneWorkspaceView: View {
    @EnvironmentObject private var appModel: AppModel
    @EnvironmentObject private var store: WorkspaceStore
    @EnvironmentObject private var registry: TerminalSessionRegistry
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    private let requestedPrimaryPaneID: String?
    /// The pane this view was opened with is honoured once. Re-applying it on
    /// every change would let the pushed pane overrule the switcher, so
    /// choosing another pane would snap straight back.
    @State private var didApplyRequestedPane = false
    @State private var inspectionTarget: InspectionTarget?

    init(primaryPaneID: String? = nil) {
        requestedPrimaryPaneID = primaryPaneID
    }

    var body: some View {
        GeometryReader { proxy in
            // Room for two and having two are different questions. Conflating
            // them made the split control depend on a secondary already being
            // chosen, so it could never appear.
            let hasRoomForTwo = hasRoomForTwo(proxy.size)
            let showsSplit = hasRoomForTwo && secondaryPane != nil
            VStack(spacing: 0) {
                if let primary = primaryPane {
                    // The terminals are the greedy part; the switcher and the
                    // composer keep their intrinsic height instead of being
                    // squeezed to nothing by the scroll views above them.
                    terminals(primary: primary, showsSplit: showsSplit)
                        .frame(maxHeight: .infinity)
                        .layoutPriority(1)
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
                        canSplit: hasRoomForTwo,
                        onSelect: select,
                        onSplit: splitBeside
                    )
                }
                if primaryPane != nil {
                    Divider().overlay(PsycheTheme.border)
                    PaneComposer(sendAttempts: appModel.paneComposerSendAttempts)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .toolbar {
                if let target = toolbarTarget(showsSplit: showsSplit) {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            inspectionTarget = InspectionTarget(
                                paneID: target.paneID
                            )
                        } label: {
                            Label("Browse files", systemImage: "folder")
                        }
                        .disabled(store.isStale)
                        .accessibilityIdentifier("pane-files")
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        PaneControlsMenu(
                            paneID: target.paneID,
                            paneTitle: target.paneTitle,
                            ritualContext: target.ritualContext
                        )
                    }
                }
            }
            .task(id: workspaceKey(hasRoomForTwo: hasRoomForTwo, showsSplit: showsSplit)) {
                if !didApplyRequestedPane {
                    didApplyRequestedPane = true
                    if let requestedPrimaryPaneID, store.primaryPaneID != requestedPrimaryPaneID {
                        store.primaryPaneID = requestedPrimaryPaneID
                    }
                }
                await syncRegistry(showsSplit: showsSplit)
            }
        }
        .navigationTitle(primaryPane?.title ?? primaryPane?.id ?? "Pane")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $inspectionTarget) { target in
            NavigationStack {
                FileBrowserView(paneID: target.paneID)
            }
        }
        // `.contain` matters: an identifier on this container otherwise masks
        // the ones on the terminals and the switcher inside it, leaving them
        // unqueryable — and untestable.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(
            primaryPane.map { "pane-workspace-\($0.id)" } ?? "pane-workspace"
        )
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

    private func select(_ selection: PaneSwitcher.Selection) {
        if selection.isVisibleSecondary {
            registry.focus(selection.paneID)
            return
        }
        store.primaryPaneID = selection.paneID
        if store.secondaryPaneID == selection.paneID {
            store.secondaryPaneID = nil
        }
    }

    private func splitBeside(_ paneID: String) {
        guard paneID != store.primaryPaneID else { return }
        store.secondaryPaneID = paneID
    }

    // MARK: - Registry

    /// Re-runs whenever the shown panes change, so the registry attaches
    /// exactly what is on screen and nothing else.
    private func workspaceKey(hasRoomForTwo: Bool, showsSplit: Bool) -> String {
        [
            requestedPrimaryPaneID ?? "",
            store.primaryPaneID ?? "",
            store.secondaryPaneID ?? "",
            hasRoomForTwo ? "room" : "tight",
            showsSplit ? "split" : "single",
        ].joined(separator: "|")
    }

    private func syncRegistry(showsSplit: Bool) async {
        await registry.show(
            primary: store.primaryPaneID,
            secondary: showsSplit ? secondaryPane?.id : nil
        )
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

    private func toolbarTarget(showsSplit: Bool) -> PaneWorkspaceToolbarTarget? {
        PaneWorkspaceToolbarTarget.resolve(
            primaryPaneID: primaryPane?.id,
            secondaryPaneID: showsSplit ? secondaryPane?.id : nil,
            focusedPaneID: registry.focusedPaneID,
            in: store.workspace
        )
    }

    private func pane(_ paneID: String?) -> WorkspacePaneSnapshot? {
        guard let paneID else { return nil }
        return panes.first { $0.id == paneID }
    }

    /// Two terminals need real width. Regular width qualifies; compact only
    /// does in landscape, where the window is wider than it is tall.
    private func hasRoomForTwo(_ size: CGSize) -> Bool {
        if horizontalSizeClass == .regular { return size.width >= 700 }
        return size.width > size.height && size.width >= 640
    }
}

private struct InspectionTarget: Identifiable {
    let paneID: String

    var id: String { paneID }
}
