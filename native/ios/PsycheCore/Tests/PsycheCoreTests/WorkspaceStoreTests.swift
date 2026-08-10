import Foundation
import XCTest
@testable import PsycheCore

@MainActor
final class WorkspaceStoreTests: XCTestCase {

    // MARK: - Sequencing

    func testStartsStaleAndWantingASnapshot() {
        let store = WorkspaceStore()

        XCTAssertNil(store.workspace)
        XCTAssertTrue(store.isStale)
        XCTAssertTrue(store.needsFullSnapshot)
        XCTAssertNil(store.lastConfirmedAt)
        XCTAssertEqual(store.nowSections, [])
    }

    func testAppliesConsecutiveEvents() {
        let store = WorkspaceStore()
        store.applySnapshot(workspace: Fixtures.workspace(revision: 1), sequence: 1)

        store.applyEvent(workspace: Fixtures.workspace(revision: 2), sequence: 2)
        store.applyEvent(workspace: Fixtures.workspace(revision: 3), sequence: 3)

        XCTAssertEqual(store.workspace?.revision, 3)
        XCTAssertEqual(store.sequence, 3)
        XCTAssertFalse(store.isStale)
        XCTAssertFalse(store.needsFullSnapshot)
    }

    func testFirstEventBootstrapsWhenThereIsNoStateToProtect() {
        let store = WorkspaceStore()

        store.applyEvent(workspace: Fixtures.workspace(revision: 7), sequence: 7)

        XCTAssertEqual(store.workspace?.revision, 7)
        XCTAssertEqual(store.sequence, 7)
        XCTAssertFalse(store.needsFullSnapshot)
    }

    func testSequenceGapMarksStateStaleAndRequestsSnapshot() {
        let store = WorkspaceStore()
        store.applySnapshot(workspace: Fixtures.workspace(revision: 1), sequence: 1)

        store.applyEvent(workspace: Fixtures.workspace(revision: 3), sequence: 3)

        XCTAssertTrue(store.isStale)
        XCTAssertTrue(store.needsFullSnapshot)
        XCTAssertEqual(store.workspace?.revision, 1, "A gap must not replace known-good state")
        XCTAssertEqual(store.sequence, 1)
    }

    func testStaleEventIsIgnoredEntirely() {
        let store = WorkspaceStore()
        store.applySnapshot(workspace: Fixtures.workspace(revision: 5), sequence: 5)

        store.applyEvent(workspace: Fixtures.workspace(revision: 2), sequence: 2)

        XCTAssertEqual(store.workspace?.revision, 5)
        XCTAssertEqual(store.sequence, 5)
        XCTAssertFalse(store.isStale, "An old event is noise, not evidence of a gap")
        XCTAssertFalse(store.needsFullSnapshot)
    }

    func testDuplicateEventIsIgnored() {
        let store = WorkspaceStore()
        store.applySnapshot(workspace: Fixtures.workspace(revision: 1), sequence: 1)

        store.applyEvent(workspace: Fixtures.workspace(revision: 99), sequence: 1)

        XCTAssertEqual(store.workspace?.revision, 1)
        XCTAssertEqual(store.sequence, 1)
    }

    func testFullSnapshotRecoversAcrossASequenceGap() {
        let store = WorkspaceStore()
        store.applySnapshot(workspace: Fixtures.workspace(revision: 1), sequence: 1)
        store.applyEvent(workspace: Fixtures.workspace(revision: 3), sequence: 3)

        store.applySnapshot(workspace: Fixtures.workspace(revision: 4), sequence: 4)

        XCTAssertFalse(store.isStale)
        XCTAssertFalse(store.needsFullSnapshot)
        XCTAssertEqual(store.workspace?.revision, 4)
        XCTAssertEqual(store.sequence, 4)
    }

    func testEventsResumeAfterSnapshotRecovery() {
        let store = WorkspaceStore()
        store.applySnapshot(workspace: Fixtures.workspace(revision: 1), sequence: 1)
        store.applyEvent(workspace: Fixtures.workspace(revision: 3), sequence: 3)
        store.applySnapshot(workspace: Fixtures.workspace(revision: 4), sequence: 4)

        store.applyEvent(workspace: Fixtures.workspace(revision: 5), sequence: 5)

        XCTAssertEqual(store.workspace?.revision, 5)
        XCTAssertFalse(store.needsFullSnapshot)
    }

    func testStaleSnapshotIsIgnored() {
        let store = WorkspaceStore()
        store.applySnapshot(workspace: Fixtures.workspace(revision: 5), sequence: 5)

        store.applySnapshot(workspace: Fixtures.workspace(revision: 2), sequence: 2)

        XCTAssertEqual(store.workspace?.revision, 5)
        XCTAssertEqual(store.sequence, 5)
    }

    func testConnectionBoundaryWaitsForAuthoritativeSnapshot() {
        let store = WorkspaceStore()
        store.applySnapshot(workspace: Fixtures.workspace(revision: 50), sequence: 50)

        store.beginConnection()
        store.applyEvent(workspace: Fixtures.workspace(revision: 1), sequence: 1)

        XCTAssertEqual(store.workspace?.revision, 50, "Last-known state stays readable")
        XCTAssertEqual(store.sequence, 0, "Events cannot establish a new connection baseline")
        XCTAssertTrue(store.isStale)
        XCTAssertTrue(store.needsFullSnapshot)

        store.applySnapshot(workspace: Fixtures.workspace(revision: 1), sequence: 1)

        XCTAssertEqual(store.workspace?.revision, 1)
        XCTAssertEqual(store.sequence, 1)
        XCTAssertFalse(store.isStale)
        XCTAssertFalse(store.needsFullSnapshot)
    }

    func testSnapshotAtTheSameSequenceRefreshesState() {
        let store = WorkspaceStore()
        store.applySnapshot(workspace: Fixtures.workspace(revision: 5), sequence: 5)

        store.applySnapshot(workspace: Fixtures.workspace(revision: 6), sequence: 5)

        XCTAssertEqual(store.workspace?.revision, 6)
    }

    // MARK: - Stale and last-confirmed state

    func testDisconnectKeepsStateButMarksItStale() {
        let clock = TestClock()
        let store = WorkspaceStore(now: clock.now)
        store.applySnapshot(workspace: Fixtures.workspace(revision: 1), sequence: 1)
        let confirmedAt = store.lastConfirmedAt

        store.markDisconnected()

        XCTAssertTrue(store.isStale)
        XCTAssertEqual(store.workspace?.revision, 1, "Offline state stays visible")
        XCTAssertEqual(store.lastConfirmedAt, confirmedAt, "The confirmation time must not move")
    }

    func testLastConfirmedAtAdvancesWithEveryAcceptedUpdate() {
        let clock = TestClock()
        let store = WorkspaceStore(now: clock.now)

        store.applySnapshot(workspace: Fixtures.workspace(revision: 1), sequence: 1)
        let first = store.lastConfirmedAt
        clock.advance(by: 60)
        store.applyEvent(workspace: Fixtures.workspace(revision: 2), sequence: 2)
        let second = store.lastConfirmedAt

        XCTAssertEqual(first, Date(timeIntervalSince1970: 1_000))
        XCTAssertEqual(second, Date(timeIntervalSince1970: 1_060))
    }

    func testRejectedEventDoesNotAdvanceLastConfirmedAt() {
        let clock = TestClock()
        let store = WorkspaceStore(now: clock.now)
        store.applySnapshot(workspace: Fixtures.workspace(revision: 1), sequence: 1)
        let confirmedAt = store.lastConfirmedAt

        clock.advance(by: 60)
        store.applyEvent(workspace: Fixtures.workspace(revision: 3), sequence: 3)

        XCTAssertEqual(store.lastConfirmedAt, confirmedAt)
    }

    // MARK: - Now sections

    func testGroupsAttentionBeforeRunningAndRecent() {
        let store = WorkspaceStore()

        store.applySnapshot(workspace: Fixtures.workspace(revision: 1, panes: [
            Fixtures.pane(id: "waiting", status: "waiting"),
            Fixtures.pane(id: "running", status: "running"),
            Fixtures.pane(id: "idle", status: "idle")
        ]), sequence: 1)

        XCTAssertEqual(store.nowSections.map(\.kind), [.needsYou, .running, .recent])
        XCTAssertEqual(
            store.nowSections.flatMap(\.items).map(\.paneID),
            ["waiting", "running", "idle"]
        )
        XCTAssertEqual(store.nowSections.map(\.title), ["Needs You", "Running", "Recent"])
    }

    func testNeedsAttentionOverridesARunningStatus() {
        let store = WorkspaceStore()

        store.applySnapshot(workspace: Fixtures.workspace(revision: 1, panes: [
            Fixtures.pane(id: "busy", status: "running", needsAttention: true)
        ]), sequence: 1)

        XCTAssertEqual(store.nowSections.map(\.kind), [.needsYou])
    }

    func testFailedAndBlockedPanesNeedYou() {
        let store = WorkspaceStore()

        store.applySnapshot(workspace: Fixtures.workspace(revision: 1, panes: [
            Fixtures.pane(id: "failed", status: "failed"),
            Fixtures.pane(id: "blocked", status: "blocked")
        ]), sequence: 1)

        XCTAssertEqual(store.nowSections.map(\.kind), [.needsYou])
        XCTAssertEqual(store.nowSections[0].items.count, 2)
    }

    func testEveryRunningStatusLandsInRunning() {
        let store = WorkspaceStore()

        store.applySnapshot(workspace: Fixtures.workspace(revision: 1, panes: [
            Fixtures.pane(id: "a", status: "starting"),
            Fixtures.pane(id: "b", status: "running"),
            Fixtures.pane(id: "c", status: "working"),
            Fixtures.pane(id: "d", status: "analyzing")
        ]), sequence: 1)

        XCTAssertEqual(store.nowSections.map(\.kind), [.running])
        XCTAssertEqual(store.nowSections[0].items.count, 4)
    }

    func testStatusMatchingIsCaseInsensitive() {
        let store = WorkspaceStore()

        store.applySnapshot(workspace: Fixtures.workspace(revision: 1, panes: [
            Fixtures.pane(id: "shouty", status: "WAITING"),
            Fixtures.pane(id: "mixed", status: "Running")
        ]), sequence: 1)

        XCTAssertEqual(store.nowSections.map(\.kind), [.needsYou, .running])
    }

    func testUnknownStatusFallsToRecentRatherThanDisappearing() {
        let store = WorkspaceStore()

        store.applySnapshot(workspace: Fixtures.workspace(revision: 1, panes: [
            Fixtures.pane(id: "from-the-future", status: "hibernating")
        ]), sequence: 1)

        XCTAssertEqual(store.nowSections.map(\.kind), [.recent])
        XCTAssertEqual(store.nowSections[0].items.map(\.paneID), ["from-the-future"])
    }

    func testEmptySectionsAreOmitted() {
        let store = WorkspaceStore()

        store.applySnapshot(workspace: Fixtures.workspace(revision: 1, panes: [
            Fixtures.pane(id: "only", status: "running")
        ]), sequence: 1)

        XCTAssertEqual(store.nowSections.map(\.kind), [.running])
    }

    func testEmptyWorkspaceProducesNoSections() {
        let store = WorkspaceStore()

        store.applySnapshot(workspace: WorkspaceSnapshot(revision: 1, projects: []), sequence: 1)

        XCTAssertEqual(store.nowSections, [])
    }

    // MARK: - Ordering

    func testMostRecentActivityComesFirst() {
        let store = WorkspaceStore()

        store.applySnapshot(workspace: Fixtures.workspace(revision: 1, panes: [
            Fixtures.pane(id: "old", status: "idle", lastActivity: "2026-08-09T10:00:00.000Z"),
            Fixtures.pane(id: "newest", status: "idle", lastActivity: "2026-08-09T12:00:00.000Z"),
            Fixtures.pane(id: "middle", status: "idle", lastActivity: "2026-08-09T11:00:00.000Z")
        ]), sequence: 1)

        XCTAssertEqual(
            store.nowSections[0].items.map(\.paneID),
            ["newest", "middle", "old"]
        )
    }

    func testFractionalAndPlainTimestampsBothParse() {
        let store = WorkspaceStore()

        store.applySnapshot(workspace: Fixtures.workspace(revision: 1, panes: [
            Fixtures.pane(id: "plain", status: "idle", lastActivity: "2026-08-09T10:00:00Z"),
            Fixtures.pane(id: "fractional", status: "idle", lastActivity: "2026-08-09T11:00:00.500Z")
        ]), sequence: 1)

        let items = store.nowSections[0].items
        XCTAssertEqual(items.map(\.paneID), ["fractional", "plain"])
        XCTAssertNotNil(items.first?.lastActivity)
        XCTAssertNotNil(items.last?.lastActivity)
    }

    func testPanesWithNoActivitySortAfterPanesWithActivity() {
        let store = WorkspaceStore()

        store.applySnapshot(workspace: Fixtures.workspace(revision: 1, panes: [
            Fixtures.pane(id: "never", status: "idle", lastActivity: nil),
            Fixtures.pane(id: "seen", status: "idle", lastActivity: "2026-08-09T10:00:00.000Z")
        ]), sequence: 1)

        XCTAssertEqual(store.nowSections[0].items.map(\.paneID), ["seen", "never"])
    }

    func testOrderingIsDeterministicAcrossProjects() {
        let store = WorkspaceStore()
        let workspace = WorkspaceSnapshot(revision: 1, projects: [
            Fixtures.project(id: "p-z", title: "Zebra", panes: [
                Fixtures.pane(id: "z-1", status: "idle")
            ]),
            Fixtures.project(id: "p-a", title: "Alpha", panes: [
                Fixtures.pane(id: "a-1", status: "idle")
            ])
        ])

        store.applySnapshot(workspace: workspace, sequence: 1)

        XCTAssertEqual(
            store.nowSections[0].items.map(\.paneID),
            ["a-1", "z-1"],
            "Equal activity must fall back to project title, not snapshot order"
        )
    }

    func testIdenticalPanesStillGetATotalOrder() {
        let store = WorkspaceStore()
        // Same project, same title, same (absent) activity: only the pane ID
        // distinguishes them, and the order must not vary between runs.
        let workspace = Fixtures.workspace(revision: 1, panes: [
            Fixtures.pane(id: "pane-c", status: "idle", title: "Shell"),
            Fixtures.pane(id: "pane-a", status: "idle", title: "Shell"),
            Fixtures.pane(id: "pane-b", status: "idle", title: "Shell")
        ])

        store.applySnapshot(workspace: workspace, sequence: 1)
        let first = store.nowSections[0].items.map(\.paneID)

        store.applySnapshot(workspace: workspace, sequence: 2)
        let second = store.nowSections[0].items.map(\.paneID)

        XCTAssertEqual(first, ["pane-a", "pane-b", "pane-c"])
        XCTAssertEqual(first, second)
    }

    func testProjectAndWorktreePanesAreBothIncluded() {
        let store = WorkspaceStore()
        let workspace = WorkspaceSnapshot(revision: 1, projects: [
            Fixtures.project(
                id: "p-1",
                title: "Alpha",
                panes: [Fixtures.pane(id: "worktree-pane", status: "idle")],
                projectPanes: [Fixtures.pane(id: "project-pane", status: "idle")]
            )
        ])

        store.applySnapshot(workspace: workspace, sequence: 1)

        XCTAssertEqual(
            Set(store.nowSections.flatMap(\.items).map(\.paneID)),
            ["worktree-pane", "project-pane"]
        )
    }

    func testItemsCarryTheirProjectIdentity() {
        let store = WorkspaceStore()

        store.applySnapshot(workspace: Fixtures.workspace(
            revision: 1,
            projectID: "p-1",
            projectTitle: "Alpha",
            panes: [Fixtures.pane(id: "pane-1", status: "idle", title: "Shell", agent: "claude")]
        ), sequence: 1)

        let item = store.nowSections[0].items[0]
        XCTAssertEqual(item.projectID, "p-1")
        XCTAssertEqual(item.projectTitle, "Alpha")
        XCTAssertEqual(item.title, "Shell")
        XCTAssertEqual(item.agent, "claude")
    }

    func testItemTitleFallsBackToThePaneID() {
        let store = WorkspaceStore()

        store.applySnapshot(workspace: Fixtures.workspace(revision: 1, panes: [
            Fixtures.pane(id: "pane-1", status: "idle", title: nil)
        ]), sequence: 1)

        XCTAssertEqual(store.nowSections[0].items[0].title, "pane-1")
    }

    // MARK: - Selection and drafts

    func testFirstPaneIsSelectedWhenNothingIsSelectedYet() {
        let store = WorkspaceStore()

        store.applySnapshot(workspace: Fixtures.workspace(revision: 1, panes: [
            Fixtures.pane(id: "pane-1", status: "idle"),
            Fixtures.pane(id: "pane-2", status: "idle")
        ]), sequence: 1)

        XCTAssertEqual(store.primaryPaneID, "pane-1")
        XCTAssertNil(store.secondaryPaneID)
    }

    func testExistingSelectionIsPreservedAcrossUpdates() {
        let store = WorkspaceStore()
        store.applySnapshot(workspace: Fixtures.workspace(revision: 1, panes: [
            Fixtures.pane(id: "pane-1", status: "idle"),
            Fixtures.pane(id: "pane-2", status: "idle")
        ]), sequence: 1)
        store.primaryPaneID = "pane-2"

        store.applyEvent(workspace: Fixtures.workspace(revision: 2, panes: [
            Fixtures.pane(id: "pane-1", status: "idle"),
            Fixtures.pane(id: "pane-2", status: "running")
        ]), sequence: 2)

        XCTAssertEqual(store.primaryPaneID, "pane-2")
    }

    func testRemovedPaneClearsSelectionAndFallsBack() {
        let store = WorkspaceStore()
        store.applySnapshot(workspace: Fixtures.workspace(revision: 1, panes: [
            Fixtures.pane(id: "pane-1", status: "idle"),
            Fixtures.pane(id: "pane-2", status: "idle")
        ]), sequence: 1)
        store.primaryPaneID = "pane-2"
        store.secondaryPaneID = "pane-1"

        store.applyEvent(workspace: Fixtures.workspace(revision: 2, panes: [
            Fixtures.pane(id: "pane-1", status: "idle")
        ]), sequence: 2)

        XCTAssertEqual(store.primaryPaneID, "pane-1")
        XCTAssertNil(store.secondaryPaneID, "The survivor must not occupy both slots")
    }

    func testSelectionClearsWhenEveryPaneDisappears() {
        let store = WorkspaceStore()
        store.applySnapshot(workspace: Fixtures.workspace(revision: 1, panes: [
            Fixtures.pane(id: "pane-1", status: "idle")
        ]), sequence: 1)

        store.applyEvent(workspace: WorkspaceSnapshot(revision: 2, projects: []), sequence: 2)

        XCTAssertNil(store.primaryPaneID)
        XCTAssertNil(store.secondaryPaneID)
    }

    func testRemovedProjectClearsProjectSelection() {
        let store = WorkspaceStore()
        store.applySnapshot(workspace: Fixtures.workspace(revision: 1, projectID: "p-1"), sequence: 1)
        store.selectedProjectID = "p-1"

        store.applyEvent(workspace: Fixtures.workspace(revision: 2, projectID: "p-2"), sequence: 2)

        XCTAssertNil(store.selectedProjectID)
    }

    func testSurvivingProjectSelectionIsPreserved() {
        let store = WorkspaceStore()
        store.applySnapshot(workspace: Fixtures.workspace(revision: 1, projectID: "p-1"), sequence: 1)
        store.selectedProjectID = "p-1"

        store.applyEvent(workspace: Fixtures.workspace(revision: 2, projectID: "p-1"), sequence: 2)

        XCTAssertEqual(store.selectedProjectID, "p-1")
    }

    func testDraftsSurviveForPanesThatStillExist() {
        let store = WorkspaceStore()
        store.applySnapshot(workspace: Fixtures.workspace(revision: 1, panes: [
            Fixtures.pane(id: "pane-1", status: "idle"),
            Fixtures.pane(id: "pane-2", status: "idle")
        ]), sequence: 1)
        store.setDraft("half-typed command", forPane: "pane-1")
        store.setDraft("another", forPane: "pane-2")

        store.applyEvent(workspace: Fixtures.workspace(revision: 2, panes: [
            Fixtures.pane(id: "pane-1", status: "running"),
            Fixtures.pane(id: "pane-2", status: "idle")
        ]), sequence: 2)

        XCTAssertEqual(store.drafts["pane-1"], "half-typed command")
        XCTAssertEqual(store.drafts["pane-2"], "another")
    }

    func testRemovedPaneDropsItsDraft() {
        let store = WorkspaceStore()
        store.applySnapshot(workspace: Fixtures.workspace(revision: 1, panes: [
            Fixtures.pane(id: "pane-1", status: "idle"),
            Fixtures.pane(id: "pane-2", status: "idle")
        ]), sequence: 1)
        store.setDraft("keep me", forPane: "pane-1")
        store.setDraft("discard me", forPane: "pane-2")

        store.applyEvent(workspace: Fixtures.workspace(revision: 2, panes: [
            Fixtures.pane(id: "pane-1", status: "idle")
        ]), sequence: 2)

        XCTAssertEqual(store.drafts, ["pane-1": "keep me"])
    }

    func testARejectedEventLeavesSelectionAndDraftsAlone() {
        let store = WorkspaceStore()
        store.applySnapshot(workspace: Fixtures.workspace(revision: 1, panes: [
            Fixtures.pane(id: "pane-1", status: "idle")
        ]), sequence: 1)
        store.setDraft("keep me", forPane: "pane-1")

        store.applyEvent(workspace: WorkspaceSnapshot(revision: 3, projects: []), sequence: 3)

        XCTAssertEqual(store.primaryPaneID, "pane-1")
        XCTAssertEqual(store.drafts, ["pane-1": "keep me"])
    }

    // MARK: - Snapshot recovery over the control client

    func testRequestFullSnapshotAppliesTheHostAnswer() async throws {
        let transport = FakeTransport()
        try await transport.connect(to: Fixtures.endpoint)
        let client = ControlRequestClient(transport: transport)
        let store = WorkspaceStore(controlRequests: client)
        store.applySnapshot(workspace: Fixtures.workspace(revision: 1), sequence: 1)
        store.applyEvent(workspace: Fixtures.workspace(revision: 3), sequence: 3)
        XCTAssertTrue(store.needsFullSnapshot)

        async let recovered = store.requestFullSnapshot()
        let requestID = try await waitForRequestID(on: transport)
        await client.handle(.workspaceSnapshot(MobileWorkspaceSnapshotResult(
            requestID: requestID,
            sequence: 9,
            workspace: Fixtures.workspace(revision: 9)
        )))

        let workspace = try await recovered
        XCTAssertEqual(workspace.revision, 9)
        XCTAssertEqual(store.workspace?.revision, 9)
        XCTAssertEqual(store.sequence, 9)
        XCTAssertFalse(store.isStale)
        XCTAssertFalse(store.needsFullSnapshot)
    }

    func testRequestFullSnapshotRejectsTheWrongAnswer() async throws {
        let transport = FakeTransport()
        try await transport.connect(to: Fixtures.endpoint)
        let client = ControlRequestClient(transport: transport)
        let store = WorkspaceStore(controlRequests: client)

        async let recovered = store.requestFullSnapshot()
        let requestID = try await waitForRequestID(on: transport)
        await client.handle(.ack(ControlAckResponse(requestID: requestID)))

        do {
            _ = try await recovered
            XCTFail("Expected the mismatched response to be rejected")
        } catch {
            XCTAssertEqual(error as? WorkspaceStoreError, .unexpectedResponse)
        }
        XCTAssertNil(store.workspace)
    }

    func testRequestFullSnapshotWithoutAHostFails() async {
        let store = WorkspaceStore()

        do {
            _ = try await store.requestFullSnapshot()
            XCTFail("Expected an unconnected store to refuse")
        } catch {
            XCTAssertEqual(error as? WorkspaceStoreError, .noControlRequests)
        }
    }

    private func waitForRequestID(
        on transport: FakeTransport,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws -> String {
        for _ in 0..<1_000 {
            let sent = await transport.sentMessages
            if case let .control(request)? = sent.first, let id = request.requestID {
                return id
            }
            await Task.yield()
        }
        XCTFail("Timed out waiting for the snapshot request", file: file, line: line)
        return ""
    }
}

private final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = Date(timeIntervalSince1970: 1_000)

    var now: @Sendable () -> Date {
        { [self] in lock.withLock { current } }
    }

    func advance(by seconds: TimeInterval) {
        lock.withLock { current = current.addingTimeInterval(seconds) }
    }
}

private enum Fixtures {
    static let endpoint = HostEndpoint(
        host: "psyche.local",
        port: 4242,
        certificateFingerprint: String(repeating: "a", count: 64)
    )

    static func workspace(
        revision: Int,
        projectID: String = "p-1",
        projectTitle: String = "Alpha",
        panes: [WorkspacePaneSnapshot] = []
    ) -> WorkspaceSnapshot {
        WorkspaceSnapshot(
            revision: revision,
            projects: [project(id: projectID, title: projectTitle, panes: panes)]
        )
    }

    static func project(
        id: String,
        title: String,
        panes: [WorkspacePaneSnapshot] = [],
        projectPanes: [WorkspacePaneSnapshot] = []
    ) -> WorkspaceProjectSnapshot {
        WorkspaceProjectSnapshot(
            id: id,
            root: "/repos/\(id)",
            title: title,
            worktrees: [
                WorkspaceWorktreeSnapshot(
                    path: "/repos/\(id)",
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
                    panes: panes,
                    runningCount: 0,
                    attentionCount: 0
                )
            ],
            projectPanes: projectPanes,
            runningCount: 0,
            attentionCount: 0
        )
    }

    static func pane(
        id: String,
        status: String,
        needsAttention: Bool = false,
        lastActivity: String? = nil,
        title: String? = nil,
        agent: String? = nil
    ) -> WorkspacePaneSnapshot {
        WorkspacePaneSnapshot(
            id: id,
            cwd: "/repos/p-1",
            title: title,
            kind: "terminal",
            agent: agent,
            status: status,
            needsAttention: needsAttention,
            lastActivity: lastActivity,
            recoverability: "recoverable"
        )
    }
}
