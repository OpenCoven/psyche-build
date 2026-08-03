import XCTest
@testable import PsycheCore

final class ConnectionManagerTests: XCTestCase {
    func testConnectSendsInitialRequestsAndCollectsSnapshots() async {
        let fake = FakeTransport()
        let manager = ConnectionManager(
            transport: fake,
            clientID: "ios-device",
            clientName: "Psyche Tests",
            token: "token"
        )
        let endpoint = HostEndpoint(host: "psyche.local", port: 4242)

        await manager.connect(to: endpoint)

        let sent = await fake.sentMessages
        XCTAssertEqual(sent.count, 3)
        let attempts = await fake.connectionAttempts
        XCTAssertEqual(attempts, [endpoint])
        guard case let .hello(hello) = sent[0] else {
            return XCTFail("First request should be hello")
        }
        XCTAssertEqual(hello.clientID, "ios-device")
        guard case .listProjects = sent[1], case .listPanes = sent[2] else {
            return XCTFail("Expected initial list requests")
        }

        await fake.emit(.welcome(WelcomePayload(
            serverID: "host",
            serverName: "Host",
            protocolVersion: 2,
            projectName: nil
        )))
        await fake.emit(.projectList([Project(id: "project", displayName: "Psyche", attentionCount: 0)]))
        await fake.emit(.paneList([PaneSnapshot(
            id: "pane",
            displayName: "Terminal",
            kind: "shell",
            projectID: "project",
            projectName: "Psyche",
            worktreePath: nil,
            agent: nil,
            status: .idle
        )]))
        await settle()

        let connectedState = await manager.state
        let projectIDs = await manager.projects.map(\.id)
        let paneIDs = await manager.panes.map(\.id)
        XCTAssertEqual(connectedState, .connected)
        XCTAssertEqual(projectIDs, ["project"])
        XCTAssertEqual(paneIDs, ["pane"])

        await manager.disconnect()
        let disconnectedState = await manager.state
        let connected = await fake.isConnected
        XCTAssertEqual(disconnectedState, .disconnected)
        XCTAssertFalse(connected)
    }

    func testFailedTransportMovesToFailedState() async {
        let manager = ConnectionManager(transport: FakeTransport(shouldFailConnection: true))

        await manager.connect(to: HostEndpoint(host: "offline", port: 1))

        guard case .failed = await manager.state else {
            return XCTFail("Expected failed state")
        }
    }

    private func settle() async {
        for _ in 0..<10 {
            await Task.yield()
        }
    }
}
