import PsycheCore
import SwiftUI

/// The cross-project inbox the app opens into: what needs you, what is
/// running, what happened recently — every project at once, one tap to any
/// pane.
struct NowView: View {
    @EnvironmentObject private var store: WorkspaceStore
    @EnvironmentObject private var model: AppModel

    var body: some View {
        List {
            if store.isStale {
                StaleStateNotice(lastConfirmedAt: store.lastConfirmedAt)
            }

            ForEach(store.nowSections) { section in
                Section(section.title) {
                    ForEach(section.items) { item in
                        NavigationLink(value: item.paneID) {
                            NowPaneRow(item: item, hostName: model.hostName)
                        }
                        .accessibilityIdentifier("now-pane-\(item.paneID)")
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .overlay {
            if store.nowSections.isEmpty {
                ContentUnavailableView(
                    "Nothing running",
                    systemImage: "moon.zzz",
                    description: Text("Panes appear here as soon as your host reports them.")
                )
                .accessibilityIdentifier("now-empty")
            }
        }
        .navigationTitle("Now")
        .accessibilityIdentifier("now-view")
    }
}

/// A calm, message-like row rather than a dashboard card: title, one line of
/// context, and a timestamp. No nested chrome competing for attention.
struct NowPaneRow: View {
    let item: NowItem
    let hostName: String?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            WorkspaceStatusDot(status: item.status, needsAttention: item.needsAttention)
                .padding(.top, 6)
            VStack(alignment: .leading, spacing: 4) {
                Text(item.title)
                    .font(.body.weight(.semibold))
                    .lineLimit(2)
                Text(contextLine)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if let lastActivity = item.lastActivity {
                    Text(lastActivity, style: .relative)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
            Spacer(minLength: 8)
        }
        .padding(.vertical, 6)
        .frame(minHeight: PsycheTheme.minimumTapTarget)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
    }

    private var contextLine: String {
        PaneAccessibility.contextLine(
            projectTitle: item.projectTitle,
            agent: item.agent,
            status: item.status
        )
    }

    private var accessibilityLabel: String {
        PaneAccessibility.label(for: item, hostName: hostName)
    }
}

/// Offline state stays on screen but must never read as live.
struct StaleStateNotice: View {
    let lastConfirmedAt: Date?

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text("Showing last known state")
                    .font(.subheadline.weight(.semibold))
                if let lastConfirmedAt {
                    Text("Confirmed \(lastConfirmedAt, style: .relative) ago")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text("Not yet confirmed by a host")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        } icon: {
            Image(systemName: "wifi.exclamationmark")
                .foregroundStyle(PsycheTheme.amber)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("stale-state-notice")
    }
}
