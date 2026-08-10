import Foundation
import XCTest
@testable import PsycheCore

@MainActor
final class WorkspaceStoreCommandsTests: XCTestCase {
    private let projectID = "psyche"
    private let projectRoot = "/Users/demo/Code/psyche-build"
    private let worktreePath = "/Users/demo/Code/psyche-build/.worktrees/native-ios-cloud-terminal"
    private let publishedPane = "ios-cockpit"

    private func makeStore(
        _ requests: FakeControlRequests,
        connected: Bool = true
    ) -> WorkspaceStore {
        let store = WorkspaceStore(controlRequests: connected ? requests : nil)
        store.applySnapshot(
            workspace: WorkspaceFixtures.workspace(named: WorkspaceFixtures.multiproject),
            sequence: 1
        )
        return store
    }

    // MARK: - Disconnected

    func testEveryCommandFailsClearlyWhenDisconnected() async {
        let store = makeStore(FakeControlRequests(), connected: false)

        await assertThrows(.noControlRequests) {
            _ = try await store.createPane(kind: .terminal, projectID: self.projectID, cwd: self.projectRoot)
        }
        await assertThrows(.noControlRequests) {
            try await store.renamePane(self.publishedPane, title: "x")
        }
        await assertThrows(.noControlRequests) {
            try await store.stopPane(self.publishedPane)
        }
    }

    // MARK: - Scope

    func testCreateRefusesAnUnpublishedProject() async {
        let requests = FakeControlRequests()
        let store = makeStore(requests)

        await assertThrows(.unknownProject("nope")) {
            _ = try await store.createPane(kind: .agent, projectID: "nope", cwd: self.projectRoot)
        }
        let sent = await requests.sentCount
        XCTAssertEqual(sent, 0, "A rejected target must not reach the host")
    }

    func testCreateRefusesACwdOutsideTheProject() async {
        let requests = FakeControlRequests()
        let store = makeStore(requests)

        await assertThrows(.targetNotInProject("/somewhere/else")) {
            _ = try await store.createPane(
                kind: .agent,
                projectID: self.projectID,
                cwd: "/somewhere/else"
            )
        }
        let sent = await requests.sentCount
        XCTAssertEqual(sent, 0)
    }

    func testCreateAcceptsTheProjectRootAndItsWorktrees() async throws {
        let requests = FakeControlRequests()
        let store = makeStore(requests)

        for cwd in [projectRoot, worktreePath] {
            let result = try await store.createPane(kind: .terminal, projectID: projectID, cwd: cwd)
            XCTAssertEqual(result.id, "%99")
        }
    }

    func testRenameAndStopRefuseAnUnpublishedPane() async {
        let requests = FakeControlRequests()
        let store = makeStore(requests)

        await assertThrows(.unknownPane("%404")) {
            try await store.renamePane("%404", title: "x")
        }
        await assertThrows(.unknownPane("%404")) {
            try await store.stopPane("%404")
        }
        let sent = await requests.sentCount
        XCTAssertEqual(sent, 0)
    }

    // MARK: - Create kinds

    func testCreateSupportsEveryPaneKind() async throws {
        let requests = FakeControlRequests()
        let store = makeStore(requests)

        for kind in PaneCreateKind.allCases {
            _ = try await store.createPane(kind: kind, projectID: projectID, cwd: projectRoot)
        }

        let kinds = await requests.spawnKinds
        XCTAssertEqual(kinds, PaneCreateKind.allCases)
    }

    func testCreateCarriesTheLaunchDetailsItWasGiven() async throws {
        let requests = FakeControlRequests()
        let store = makeStore(requests)

        _ = try await store.createPane(
            kind: .agent,
            projectID: projectID,
            cwd: worktreePath,
            idempotencyKey: "key-1",
            branch: "feat/x",
            agent: "claude",
            title: "Fix the thing",
            prompt: "go"
        )

        let spawn = await requests.lastSpawn
        XCTAssertEqual(spawn?.idempotencyKey, "key-1")
        XCTAssertEqual(spawn?.projectID, projectID)
        XCTAssertEqual(spawn?.cwd, worktreePath)
        XCTAssertEqual(spawn?.branch, "feat/x")
        XCTAssertEqual(spawn?.agent, "claude")
        XCTAssertEqual(spawn?.title, "Fix the thing")
        XCTAssertEqual(spawn?.prompt, "go")
    }

    func testEachCreateUsesItsOwnIdempotencyKeyByDefault() async throws {
        let requests = FakeControlRequests()
        let store = makeStore(requests)

        _ = try await store.createPane(kind: .terminal, projectID: projectID, cwd: projectRoot)
        _ = try await store.createPane(kind: .terminal, projectID: projectID, cwd: projectRoot)

        let keys = await requests.spawnKeys
        XCTAssertEqual(Set(keys).count, 2, "Two creates must not collapse into one on the host")
    }

    // MARK: - Response validation

    /// The host answering with something else is not a success. Treating any
    /// response as one is how a refused command looks like it worked.
    func testAnUnexpectedResponseIsNeverTreatedAsSuccess() async {
        let requests = FakeControlRequests()
        await requests.setResponse(.ack(ControlAckResponse(requestID: "r", ok: true)))
        let store = makeStore(requests)

        await assertThrows(.unexpectedResponse) {
            _ = try await store.createPane(kind: .agent, projectID: self.projectID, cwd: self.projectRoot)
        }
    }

    func testARefusedAckIsAFailureNotASuccess() async {
        let requests = FakeControlRequests()
        await requests.setResponse(.ack(ControlAckResponse(requestID: "r", ok: false)))
        let store = makeStore(requests)

        await assertThrows(.rejected) {
            try await store.renamePane(self.publishedPane, title: "x")
        }
        await assertThrows(.rejected) {
            try await store.stopPane(self.publishedPane)
        }
    }

    func testRenameAndStopRejectANonAckResponse() async {
        let requests = FakeControlRequests()
        await requests.setResponse(.paneSpawned(PaneSpawnedResponse(
            requestID: "r",
            id: "%99",
            pane: nil,
            worktreePath: nil,
            branch: nil
        )))
        let store = makeStore(requests)

        await assertThrows(.unexpectedResponse) {
            try await store.renamePane(self.publishedPane, title: "x")
        }
        await assertThrows(.unexpectedResponse) {
            try await store.stopPane(self.publishedPane)
        }
    }

    func testATransportFailurePropagatesRatherThanLookingSuccessful() async {
        let requests = FakeControlRequests()
        await requests.setFailure(ControlRequestError.disconnected)
        let store = makeStore(requests)

        do {
            try await store.stopPane(publishedPane)
            XCTFail("Expected the transport failure to surface")
        } catch {
            XCTAssertEqual(error as? ControlRequestError, .disconnected)
        }
    }

    // MARK: - Helpers

    private func assertThrows(
        _ expected: WorkspaceStoreError,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ body: () async throws -> Void
    ) async {
        do {
            try await body()
            XCTFail("Expected \(expected)", file: file, line: line)
        } catch {
            XCTAssertEqual(error as? WorkspaceStoreError, expected, file: file, line: line)
        }
    }
}

private actor FakeControlRequests: ControlRequesting {
    private(set) var sentCount = 0
    private(set) var spawnKinds: [PaneCreateKind] = []
    private(set) var spawnKeys: [String] = []
    private(set) var lastSpawn: MobilePaneSpawnRequest?

    private var response: MobileControlResponse?
    private var failure: (any Error)?
    private var nextID = 0

    func setResponse(_ response: MobileControlResponse) { self.response = response }
    func setFailure(_ error: any Error) { failure = error }

    func nextRequestID() -> String {
        nextID += 1
        return "req-\(nextID)"
    }

    func send(_ request: MobileControlRequest) async throws -> MobileControlResponse {
        sentCount += 1
        if let failure { throw failure }

        if case let .spawnPane(spawn) = request {
            spawnKinds.append(spawn.kind)
            spawnKeys.append(spawn.idempotencyKey)
            lastSpawn = spawn
        }
        if let response { return response }

        // Default: the answer each command actually expects.
        switch request {
        case .spawnPane:
            return .paneSpawned(PaneSpawnedResponse(
                requestID: request.requestID ?? "",
                id: "%99",
                pane: nil,
                worktreePath: nil,
                branch: nil
            ))
        default:
            return .ack(ControlAckResponse(requestID: request.requestID ?? "", ok: true))
        }
    }
}

@MainActor
final class WorkspaceStoreRitualTests: XCTestCase {
    private func makeStore(
        _ requests: FakeRitualRequests,
        connected: Bool = true
    ) -> WorkspaceStore {
        let store = WorkspaceStore(controlRequests: connected ? requests : nil)
        store.applySnapshot(
            workspace: WorkspaceFixtures.workspace(named: WorkspaceFixtures.multiproject),
            sequence: 1
        )
        return store
    }

    func testLaunchesARitualInAPublishedProject() async throws {
        let requests = FakeRitualRequests()
        let store = makeStore(requests)

        try await store.launchRitual("daily-standup", inProject: "psyche", params: ["branch": "main"])

        let launch = await requests.lastLaunch
        XCTAssertEqual(launch?.projectID, "psyche")
        XCTAssertEqual(launch?.ritualID, "daily-standup")
        XCTAssertEqual(launch?.params, ["branch": "main"])
    }

    func testOmitsEmptyParamsRatherThanSendingAnEmptyObject() async throws {
        let requests = FakeRitualRequests()
        let store = makeStore(requests)

        try await store.launchRitual("r", inProject: "psyche")

        let launch = await requests.lastLaunch
        XCTAssertNil(launch?.params)
    }

    func testRefusesAnUnpublishedProjectWithoutSending() async {
        let requests = FakeRitualRequests()
        let store = makeStore(requests)

        do {
            try await store.launchRitual("r", inProject: "nope")
            XCTFail("Expected an unpublished project to be refused")
        } catch {
            XCTAssertEqual(error as? WorkspaceStoreError, .unknownProject("nope"))
        }
        let sent = await requests.sentCount
        XCTAssertEqual(sent, 0)
    }

    func testFailsClearlyWhenDisconnected() async {
        let store = makeStore(FakeRitualRequests(), connected: false)

        do {
            try await store.launchRitual("r", inProject: "psyche")
            XCTFail("Expected a disconnected store to refuse")
        } catch {
            XCTAssertEqual(error as? WorkspaceStoreError, .noControlRequests)
        }
    }

    func testARefusedAckIsNotASuccess() async {
        let requests = FakeRitualRequests()
        await requests.setResponse(.ack(ControlAckResponse(requestID: "r", ok: false)))
        let store = makeStore(requests)

        do {
            try await store.launchRitual("r", inProject: "psyche")
            XCTFail("Expected a refused ack to throw")
        } catch {
            XCTAssertEqual(error as? WorkspaceStoreError, .rejected)
        }
    }
}

private actor FakeRitualRequests: ControlRequesting {
    private(set) var sentCount = 0
    private(set) var lastLaunch: MobileRitualLaunchRequest?
    private var response: MobileControlResponse?
    private var nextID = 0

    func setResponse(_ response: MobileControlResponse) { self.response = response }

    func nextRequestID() -> String {
        nextID += 1
        return "req-\(nextID)"
    }

    func send(_ request: MobileControlRequest) async throws -> MobileControlResponse {
        sentCount += 1
        if case let .launchRitual(launch) = request { lastLaunch = launch }
        return response ?? .ack(ControlAckResponse(requestID: request.requestID ?? "", ok: true))
    }
}
