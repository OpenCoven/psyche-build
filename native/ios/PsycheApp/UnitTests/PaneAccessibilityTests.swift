import Foundation
import PsycheCore
import XCTest
@testable import Psyche_Build

@MainActor
final class PaneAccessibilityTests: XCTestCase {

    // MARK: - Spoken labels

    func testLabelNamesPaneProjectStatusAndHost() {
        let label = PaneAccessibility.label(
            title: "homepage polish",
            projectTitle: "open-coven.dev",
            status: "waiting",
            agent: "Claude",
            hostName: "studio.local",
            needsAttention: true
        )

        XCTAssertEqual(
            label,
            "homepage polish, open-coven.dev, waiting, agent Claude, on studio.local, needs you"
        )
    }

    func testLabelOmitsAbsentContextRatherThanSpeakingEmptyFragments() {
        let label = PaneAccessibility.label(
            title: "shell",
            projectTitle: "psyche-build",
            status: "idle",
            agent: nil,
            hostName: nil,
            needsAttention: false
        )

        XCTAssertEqual(label, "shell, psyche-build, idle")
        XCTAssertFalse(label.contains(", ,"))
    }

    func testLabelTreatsEmptyAgentAndHostAsAbsent() {
        let label = PaneAccessibility.label(
            title: "shell",
            projectTitle: "psyche-build",
            status: "idle",
            agent: "",
            hostName: "",
            needsAttention: false
        )

        XCTAssertEqual(label, "shell, psyche-build, idle")
    }

    func testEveryFixturePaneIsSpokenWithProjectStatusAndHost() {
        let store = WorkspaceStore()
        store.applySnapshot(
            workspace: WorkspaceFixtures.workspace(named: WorkspaceFixtures.multiproject),
            sequence: 1
        )
        XCTAssertFalse(store.nowSections.isEmpty)

        for item in store.nowSections.flatMap(\.items) {
            let label = PaneAccessibility.label(for: item, hostName: "studio.local")
            XCTAssertTrue(label.contains(item.title), label)
            XCTAssertTrue(label.contains(item.projectTitle), label)
            XCTAssertTrue(label.contains(item.status), label)
            XCTAssertTrue(label.contains("on studio.local"), label)
        }
    }

    func testPaneSnapshotLabelFallsBackToThePaneIDWhenUntitled() throws {
        // Decoded rather than constructed: the memberwise initialiser is
        // internal to PsycheCore, and this is the shape the host actually sends.
        let pane = try decodePane("""
        {"id":"pane-7","cwd":"/repo","kind":"shell","status":"idle",
         "recoverability":"recoverable"}
        """)

        let label = PaneAccessibility.label(
            for: pane,
            projectTitle: "psyche-build",
            hostName: nil
        )

        XCTAssertEqual(label, "pane-7, psyche-build, idle")
    }

    // MARK: - Visible row text

    func testContextLinePrefersTheAgentOverTheRawStatus() {
        XCTAssertEqual(
            PaneAccessibility.contextLine(
                projectTitle: "psyche-build",
                agent: "Copilot",
                status: "working"
            ),
            "psyche-build · Copilot"
        )
        XCTAssertEqual(
            PaneAccessibility.contextLine(
                projectTitle: "psyche-build",
                agent: nil,
                status: "working"
            ),
            "psyche-build · working"
        )
    }

    // MARK: - Project rows

    func testProjectSubtitleHidesAZeroAttentionCount() {
        XCTAssertEqual(
            PaneAccessibility.projectSubtitle(branch: "main", runningCount: 2, attentionCount: 0),
            "main · 2 running"
        )
        XCTAssertEqual(
            PaneAccessibility.projectSubtitle(branch: "main", runningCount: 2, attentionCount: 1),
            "main · 2 running · 1 needs you"
        )
    }

    /// The subtitle hides a zero, but the spoken label must not — "0 needing
    /// attention" is the answer to the question a VoiceOver user just asked.
    func testProjectLabelAlwaysStatesBothCounts() {
        XCTAssertEqual(
            PaneAccessibility.projectLabel(
                title: "psyche-build",
                branch: "main",
                runningCount: 2,
                attentionCount: 0
            ),
            "psyche-build, branch main, 2 running, 0 needing attention"
        )
    }

    func testProjectLabelSurvivesADetachedWorktreeWithNoBranch() {
        XCTAssertEqual(
            PaneAccessibility.projectLabel(
                title: "psyche-build",
                branch: nil,
                runningCount: 0,
                attentionCount: 0
            ),
            "psyche-build, 0 running, 0 needing attention"
        )
    }

    // MARK: - Worktree state

    func testWorktreeStatesNameEveryConditionThatChangesWhatYouCanDo() throws {
        let worktree = try decodeWorktree(dirty: true, missing: true, locked: true, prunable: true, isMain: false)

        XCTAssertEqual(
            PaneAccessibility.worktreeStates(for: worktree),
            ["linked worktree", "uncommitted changes", "missing", "locked", "prunable"]
        )
    }

    func testCleanMainWorktreeSaysOnlyThat() throws {
        let worktree = try decodeWorktree(
            dirty: false, missing: false, locked: false, prunable: false, isMain: true
        )

        XCTAssertEqual(PaneAccessibility.worktreeStates(for: worktree), ["main worktree"])
    }

    // MARK: - Helpers

    private func decodePane(_ json: String) throws -> WorkspacePaneSnapshot {
        try JSONDecoder().decode(WorkspacePaneSnapshot.self, from: Data(json.utf8))
    }

    private func decodeWorktree(
        dirty: Bool,
        missing: Bool,
        locked: Bool,
        prunable: Bool,
        isMain: Bool
    ) throws -> WorkspaceWorktreeSnapshot {
        let json = """
        {"path":"/repo","head":"abc","branch":"feat/x","isMain":\(isMain),
         "detached":false,"bare":false,"locked":\(locked),"prunable":\(prunable),
         "dirty":\(dirty),"missing":\(missing),"panes":[],
         "runningCount":0,"attentionCount":0}
        """
        return try JSONDecoder().decode(
            WorkspaceWorktreeSnapshot.self,
            from: Data(json.utf8)
        )
    }
}
