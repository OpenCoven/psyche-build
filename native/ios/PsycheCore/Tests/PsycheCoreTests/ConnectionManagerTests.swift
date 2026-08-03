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
        await manager.waitForMessageProcessorReadiness()

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
        await manager.waitForEventDrain(after: 3)

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

    func testTokenlessConnectionPairsBeforeRequestingSnapshots() async {
        let fake = FakeTransport()
        let manager = ConnectionManager(transport: fake)

        await manager.connect(to: HostEndpoint(host: "psyche.local", port: 4242))
        await manager.waitForMessageProcessorReadiness()

        let helloOnly = await fake.sentMessages
        XCTAssertEqual(helloOnly.count, 1)
        guard case let .hello(hello) = helloOnly[0] else {
            return XCTFail("Tokenless connection should begin with hello")
        }
        XCTAssertNil(hello.token)

        await manager.pair(code: "123456", clientID: "pairing-device", clientName: "Psyche Pairing")

        let pairingRequest = await fake.sentMessages
        XCTAssertEqual(pairingRequest.count, 2)
        guard case let .pair(payload) = pairingRequest[1] else {
            return XCTFail("Expected typed pair request")
        }
        XCTAssertEqual(payload, PairRequestPayload(
            code: "123456",
            clientID: "pairing-device",
            clientName: "Psyche Pairing"
        ))

        await fake.emit(.pairAccepted(PairAcceptedPayload(token: "paired-token")))
        await manager.waitForEventDrain(after: 1)

        let paired = await fake.sentMessages
        XCTAssertEqual(paired.count, 4)
        guard case .listProjects = paired[2], case .listPanes = paired[3] else {
            return XCTFail("Pair acceptance should request initial snapshots")
        }
    }

    func testReconnectCancelsPriorReaderBeforeProcessingNewStream() async {
        let fake = FakeTransport()
        let manager = ConnectionManager(transport: fake, token: "token")
        let firstEndpoint = HostEndpoint(host: "first", port: 4242)
        let secondEndpoint = HostEndpoint(host: "second", port: 4242)

        await manager.connect(to: firstEndpoint)
        await manager.waitForMessageProcessorReadiness()
        await manager.connect(to: secondEndpoint)
        await manager.waitForMessageProcessorReadiness()

        let connectionAttempts = await fake.connectionAttempts
        let disconnectCount = await fake.disconnectCount
        let streamCount = await fake.incomingMessageStreamCount
        XCTAssertEqual(connectionAttempts, [firstEndpoint, secondEndpoint])
        XCTAssertEqual(disconnectCount, 1)
        XCTAssertEqual(streamCount, 2)

        await fake.emit(.paneList([makePane(id: "stale")]), onConnection: 0)
        await fake.emit(.paneList([makePane(id: "current")]), onConnection: 1)
        await manager.waitForEventDrain(after: 1)

        let paneIDs = await manager.panes.map(\.id)
        XCTAssertEqual(paneIDs, ["current"])
    }

    func testUnexpectedIncomingMessageClosureFailsConnection() async {
        let fake = FakeTransport()
        let manager = ConnectionManager(transport: fake, token: "token")

        await manager.connect(to: HostEndpoint(host: "psyche.local", port: 4242))
        await manager.waitForMessageProcessorReadiness()
        await fake.finishIncomingMessages()

        await manager.waitForState(.failed("Connection closed unexpectedly"))

        guard case let .failed(reason) = await manager.state else {
            return XCTFail("Unexpected stream closure should fail the connection")
        }
        XCTAssertEqual(reason, "Connection closed unexpectedly")
        let disconnectCount = await fake.disconnectCount
        XCTAssertEqual(disconnectCount, 1)
    }

    func testProtocolFailureStopsReaderAndDisconnectsTransport() async {
        let fake = FakeTransport()
        let manager = ConnectionManager(transport: fake, token: "token")

        await manager.connect(to: HostEndpoint(host: "psyche.local", port: 4242))
        await manager.waitForMessageProcessorReadiness()
        await fake.emit(.error(ProtocolError(code: "unauthorized", message: "token rejected")))

        await manager.waitForState(.failed("token rejected"))

        let disconnectCount = await fake.disconnectCount
        XCTAssertEqual(disconnectCount, 1)
    }

    private func makePane(id: String) -> PaneSnapshot {
        PaneSnapshot(
            id: id,
            displayName: id,
            kind: "shell",
            projectID: "project",
            projectName: "Psyche",
            worktreePath: nil,
            agent: nil,
            status: .idle
        )
    }
}
