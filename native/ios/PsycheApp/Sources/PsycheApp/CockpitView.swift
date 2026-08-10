import PsycheCore
import SwiftUI

enum RootTab: String, Hashable, CaseIterable {
    case now
    case projects
    case settings

    var title: String {
        switch self {
        case .now: "Now"
        case .projects: "Projects"
        case .settings: "Settings"
        }
    }

    var systemImage: String {
        switch self {
        case .now: "tray.full.fill"
        case .projects: "folder.fill"
        case .settings: "gearshape.fill"
        }
    }
}

/// The app root: Now first on every device.
///
/// Compact width gets tabs, regular width gets a sidebar and a detail column.
/// Both shells share `tab`, `selectedProjectID`, and `panePath`, and this view
/// keeps its identity across a size-class change, so rotating an iPad does not
/// throw away where you were.
struct CockpitView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @EnvironmentObject private var store: WorkspaceStore

    @State private var tab: RootTab = .now
    @State private var selectedProjectID: String?
    /// The pane pushed on top of whichever root is showing. Shared by both
    /// shells so an open pane survives rotation.
    @State private var panePath: [String] = []

    var body: some View {
        Group {
            if horizontalSizeClass == .regular {
                regularShell
            } else {
                compactShell
            }
        }
        .tint(PsycheTheme.mint)
        .accessibilityIdentifier("main-cockpit")
    }

    // MARK: - Compact

    private var compactShell: some View {
        TabView(selection: $tab) {
            NavigationStack(path: $panePath) {
                NowView()
                    .navigationDestination(for: String.self) { paneID in
                        PaneWorkspaceView(primaryPaneID: paneID)
                    }
            }
            .tabItem { Label(RootTab.now.title, systemImage: RootTab.now.systemImage) }
            .tag(RootTab.now)

            NavigationStack {
                ProjectsView()
                    .navigationDestination(for: String.self) { paneID in
                        PaneWorkspaceView(primaryPaneID: paneID)
                    }
            }
            .tabItem { Label(RootTab.projects.title, systemImage: RootTab.projects.systemImage) }
            .tag(RootTab.projects)

            NavigationStack {
                SettingsView()
            }
            .tabItem { Label(RootTab.settings.title, systemImage: RootTab.settings.systemImage) }
            .tag(RootTab.settings)
        }
        .accessibilityIdentifier("compact-shell")
    }

    // MARK: - Regular

    private var regularShell: some View {
        NavigationSplitView {
            sourceRail
        } detail: {
            NavigationStack(path: $panePath) {
                detailRoot
                    .navigationDestination(for: String.self) { paneID in
                        PaneWorkspaceView(primaryPaneID: paneID)
                    }
            }
        }
        .accessibilityIdentifier("regular-shell")
    }

    /// Now first, then projects, then settings — the same order the tabs use,
    /// so the two shells read as one app.
    private var sourceRail: some View {
        List(selection: sourceSelection) {
            Section {
                Label(RootTab.now.title, systemImage: RootTab.now.systemImage)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("source-now")
                    .tag(SourceItem.tab(.now))
            }

            Section("Projects") {
                // The overview carries the running and attention counts, which
                // the rows below do not. Without a root for it, regular width
                // would be the only place you cannot scan them.
                Label("All projects", systemImage: RootTab.projects.systemImage)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("source-projects")
                    .tag(SourceItem.tab(.projects))

                ForEach(store.workspace?.projects ?? []) { project in
                    Label(project.title, systemImage: "folder.fill")
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("source-project-\(project.id)")
                        .tag(SourceItem.project(project.id))
                }
            }

            Section {
                Label(RootTab.settings.title, systemImage: RootTab.settings.systemImage)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("source-settings")
                    .tag(SourceItem.tab(.settings))
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("Psyche")
        .accessibilityIdentifier("source-rail")
    }

    @ViewBuilder
    private var detailRoot: some View {
        switch tab {
        case .now:
            NowView()
        case .projects:
            if let selectedProjectID {
                ProjectDetailView(projectID: selectedProjectID)
            } else {
                ProjectsView()
            }
        case .settings:
            SettingsView()
        }
    }

    /// Maps the sidebar's single selection onto the same `tab` and
    /// `selectedProjectID` the compact shell uses, so changing size class
    /// lands on the equivalent screen instead of resetting to Now.
    private var sourceSelection: Binding<SourceItem?> {
        Binding(
            get: {
                switch tab {
                case .now: .tab(.now)
                case .settings: .tab(.settings)
                case .projects: selectedProjectID.map(SourceItem.project) ?? .tab(.projects)
                }
            },
            set: { selection in
                guard let selection else { return }
                switch selection {
                case .tab(let newTab):
                    // Any root, including the projects overview, clears the
                    // per-project selection — that is what makes it a root.
                    tab = newTab
                    selectedProjectID = nil
                case .project(let projectID):
                    tab = .projects
                    selectedProjectID = projectID
                }
                // A new root replaces whatever pane was pushed on the old one.
                panePath.removeAll()
            }
        )
    }

    private enum SourceItem: Hashable {
        case tab(RootTab)
        case project(String)
    }
}
