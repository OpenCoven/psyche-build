import Foundation
import XCTest
@testable import PsycheCore

@MainActor
final class WorkspaceFixturesTests: XCTestCase {
    func testEveryAdvertisedNameResolves() {
        for name in WorkspaceFixtures.names() {
            XCTAssertFalse(
                WorkspaceFixtures.workspace(named: name).projects.isEmpty,
                "Fixture \(name) resolved to an empty workspace"
            )
        }
    }

    func testMultiprojectFixtureIsByteForByteRepeatable() throws {
        let first = WorkspaceFixtures.workspace(named: WorkspaceFixtures.multiproject)
        let second = WorkspaceFixtures.workspace(named: WorkspaceFixtures.multiproject)

        XCTAssertEqual(first, second)

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        XCTAssertEqual(try encoder.encode(first), try encoder.encode(second))
    }

    func testMultiprojectFixturePopulatesEveryNowSection() {
        let store = WorkspaceStore()

        store.applySnapshot(
            workspace: WorkspaceFixtures.workspace(named: WorkspaceFixtures.multiproject),
            sequence: 1
        )

        XCTAssertEqual(store.nowSections.map(\.kind), [.needsYou, .running, .recent])
        XCTAssertEqual(
            store.nowSections.first(where: { $0.kind == .needsYou })?.items.map(\.paneID),
            ["web-home"]
        )
        XCTAssertEqual(
            store.nowSections.first(where: { $0.kind == .running })?.items.map(\.paneID),
            ["ios-cockpit"]
        )
        XCTAssertEqual(
            store.nowSections.first(where: { $0.kind == .recent })?.items.map(\.paneID),
            ["bridge-protocol"]
        )
    }

    func testFixtureOrderingIsStableAcrossRepeatedApplication() {
        let store = WorkspaceStore()
        let workspace = WorkspaceFixtures.workspace(named: WorkspaceFixtures.multiproject)

        store.applySnapshot(workspace: workspace, sequence: 1)
        let first = store.nowSections.flatMap(\.items).map(\.paneID)
        store.applySnapshot(workspace: workspace, sequence: 2)
        let second = store.nowSections.flatMap(\.items).map(\.paneID)

        XCTAssertEqual(first, second)
    }

    func testFixtureTimestampsParse() {
        let store = WorkspaceStore()

        store.applySnapshot(
            workspace: WorkspaceFixtures.workspace(named: WorkspaceFixtures.multiproject),
            sequence: 1
        )

        for item in store.nowSections.flatMap(\.items) {
            XCTAssertNotNil(
                item.lastActivity,
                "\(item.paneID) has an unparseable fixture timestamp, which would collapse ordering"
            )
        }
    }

    func testFixtureCoversAProjectWithNoPanes() {
        let workspace = WorkspaceFixtures.workspace(named: WorkspaceFixtures.multiproject)

        let infra = workspace.projects.first { $0.id == "infra" }
        XCTAssertNotNil(infra)
        XCTAssertTrue(infra?.worktrees.allSatisfy { $0.panes.isEmpty } == true)
        XCTAssertTrue(infra?.projectPanes.isEmpty == true)
    }

    func testFixturePublishesWebsiteRituals() {
        let workspace = WorkspaceFixtures.workspace(named: WorkspaceFixtures.multiproject)

        XCTAssertEqual(
            workspace.projects.first { $0.id == "website" }?.rituals.map(\.id),
            ["review-site"]
        )
    }

    func testFixtureSpansMultipleProjectsAndWorktrees() {
        let workspace = WorkspaceFixtures.workspace(named: WorkspaceFixtures.multiproject)

        XCTAssertEqual(workspace.projects.map(\.id), ["psyche", "website", "infra"])
        XCTAssertEqual(workspace.projects.first?.worktrees.count, 2)
        XCTAssertEqual(
            workspace.projects.first?.worktrees.map(\.isMain),
            [true, false],
            "The multiproject fixture must cover a main worktree and a feature worktree"
        )
    }

    func testProjectReplacingPreservesRituals() {
        let ritual = WorkspaceRitualSnapshot(
            id: "release-checklist",
            displayName: "Release checklist",
            description: "Prepare a release safely."
        )
        let original = WorkspaceProjectSnapshot(
            id: "psyche",
            root: "/repos/psyche",
            title: "Psyche Build",
            rituals: [ritual],
            worktrees: [],
            projectPanes: [],
            runningCount: 0,
            attentionCount: 0
        )

        let replaced = original.replacing(
            worktrees: [
                WorkspaceWorktreeSnapshot(
                    path: "/repos/psyche",
                    head: "abc123",
                    branch: "main",
                    isMain: true,
                    detached: false,
                    bare: false,
                    locked: false,
                    lockReason: nil,
                    prunable: false,
                    pruneReason: nil,
                    dirty: false,
                    missing: false,
                    panes: [],
                    runningCount: 0,
                    attentionCount: 0
                )
            ],
            projectPanes: []
        )

        XCTAssertEqual(replaced.rituals, [ritual])
    }
}
