import Combine
import Foundation
import PsycheCore

@MainActor
final class DemoStore: ObservableObject {
    struct DemoPane: Identifiable, Equatable {
        let snapshot: PaneSnapshot
        let host: String
        let branch: String
        let output: [String]

        var id: String { snapshot.id }
    }

    @Published var selectedProjectID: String?
    @Published var selectedPaneID: String?
    @Published var isPairSheetPresented = false
    @Published private(set) var pairedHost: PairedHost?

    struct PairedHost: Equatable {
        let host: String
        let pairingCode: String
    }

    let projects = [
        Project(id: "psyche", displayName: "psyche-build", attentionCount: 1),
        Project(id: "website", displayName: "open-coven.dev", attentionCount: 0),
        Project(id: "infra", displayName: "coven-infra", attentionCount: 0)
    ]

    let panes = [
        DemoPane(
            snapshot: PaneSnapshot(
                id: "ios-cockpit",
                displayName: "native-ios-cloud-terminal",
                kind: "agent",
                projectID: "psyche",
                projectName: "psyche-build",
                worktreePath: "~/Code/psyche-build/.worktrees/native-ios-cloud-terminal",
                agent: "Copilot",
                status: .working
            ),
            host: "buns-mbp.local",
            branch: "feat/native-ios-cloud-terminal",
            output: [
                "› Implement the native iOS cockpit foundation",
                "",
                "• Scanning bridge protocol v2",
                "• Modeling typed Swift envelopes",
                "• Building PsycheCore",
                "",
                "PsycheCoreTests",
                "  ✓ decodes representative server messages",
                "  ✓ records fake transport requests",
                "",
                "▸ Ready for simulator"
            ]
        ),
        DemoPane(
            snapshot: PaneSnapshot(
                id: "bridge-protocol",
                displayName: "bridge wire protocol",
                kind: "shell",
                projectID: "psyche",
                projectName: "psyche-build",
                worktreePath: "~/Code/psyche-build",
                agent: nil,
                status: .idle
            ),
            host: "buns-mbp.local",
            branch: "main",
            output: ["$ pnpm test wireProtocol", "PASS __tests__/bridge/wireProtocol.test.ts"]
        ),
        DemoPane(
            snapshot: PaneSnapshot(
                id: "web-home",
                displayName: "homepage polish",
                kind: "agent",
                projectID: "website",
                projectName: "open-coven.dev",
                worktreePath: "~/Code/open-coven.dev",
                agent: "Claude",
                status: .waiting
            ),
            host: "studio-mini.local",
            branch: "feat/home-polish",
            output: ["Waiting for review input…"]
        )
    ]

    init() {
        selectedProjectID = projects.first?.id
        selectedPaneID = panes.first?.id
    }

    var selectedPane: DemoPane {
        panes.first(where: { $0.id == selectedPaneID }) ?? panes[0]
    }

    func panes(for projectID: String?) -> [DemoPane] {
        guard let projectID else { return panes }
        return panes.filter { $0.snapshot.projectID == projectID }
    }

    func recordPairing(host: String, pairingCode: String) {
        pairedHost = PairedHost(host: host, pairingCode: pairingCode)
    }
}
