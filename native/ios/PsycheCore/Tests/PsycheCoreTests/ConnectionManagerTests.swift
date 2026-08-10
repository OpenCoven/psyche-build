import XCTest
@testable import PsycheCore

private let testCertificateFingerprint = String(repeating: "a", count: 64)

@MainActor
final class ConnectionManagerTests: XCTestCase {

    /// Fails cleanly instead of trapping when a message list is shorter than a
    /// test expects. XCTAssertEqual on `.count` does not halt execution, so the
    /// following subscript would still crash the whole test process and take
    /// every other case in the file with it.
    private func requireCount<T>(
        _ messages: [T],
        _ minimum: Int,
        _ context: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> Bool {
        guard messages.count >= minimum else {
            XCTFail(
                "\(context): expected at least \(minimum) message(s), got \(messages.count)",
                file: file,
                line: line
            )
            return false
        }
        return true
    }
    func testConnectSendsV3HelloThenRequestsOneCanonicalSnapshotAfterWelcome() async throws {
        let fake = FakeTransport()
        let composition = makeComposition(
            transport: fake,
            clientID: "ios-device",
            clientName: "Psyche Tests",
            token: "token"
        )
        let manager = composition.manager
        let endpoint = HostEndpoint(
            host: "psyche.local",
            port: 4242,
            certificateFingerprint: testCertificateFingerprint
        )

        await manager.connect(to: endpoint)
        await manager.waitForMessageProcessorReadiness()

        let sent = await fake.sentMessages
        XCTAssertEqual(sent.count, 1)
        let attempts = await fake.connectionAttempts
        XCTAssertEqual(attempts, [endpoint])
        guard requireCount(sent, 1, "connect handshake") else { return }
        guard case let .legacy(.hello(hello)) = sent[0] else {
            return XCTFail("First request should be hello")
        }
        XCTAssertEqual(hello.clientID, "ios-device")
        XCTAssertEqual(hello.protocolVersion, 3)
        XCTAssertEqual(hello.token, "token")

        await fake.emit(.legacy(.welcome(WelcomePayload(
            serverID: "host",
            serverName: "Host",
            protocolVersion: 3,
            projectName: nil
        ))))
        await fake.emit(.legacy(.welcome(WelcomePayload(
            serverID: "host",
            serverName: "Host",
            protocolVersion: 3,
            projectName: nil
        ))))
        let snapshotRequestID = try await waitForSnapshotRequest(on: fake)
        let afterWelcome = await fake.sentMessages
        XCTAssertEqual(
            afterWelcome.filter(\.isWorkspaceSnapshotRequest).count,
            1,
            "Repeated authorization messages must not duplicate bootstrap"
        )
        await fake.emit(.control(.workspaceSnapshot(MobileWorkspaceSnapshotResult(
            requestID: snapshotRequestID,
            sequence: 1,
            workspace: makeWorkspace(revision: 1)
        ))))
        await fake.emit(.legacy(.projectList([
            Project(id: "project", displayName: "Psyche", attentionCount: 0)
        ])))
        await fake.emit(.legacy(.paneList([PaneSnapshot(
            id: "pane",
            displayName: "Terminal",
            kind: "shell",
            projectID: "project",
            projectName: "Psyche",
            worktreePath: nil,
            agent: nil,
            status: .idle
        )])))
        await manager.waitForEventDrain(after: 5)

        let connectedState = await manager.state
        let projectIDs = await manager.projects.map(\.id)
        let paneIDs = await manager.panes.map(\.id)
        XCTAssertEqual(connectedState, .connected)
        XCTAssertEqual(projectIDs, ["project"])
        XCTAssertEqual(paneIDs, ["pane"])
        XCTAssertEqual(composition.workspaceStore.workspace?.revision, 1)
        XCTAssertFalse(composition.workspaceStore.isStale)

        await manager.disconnect()
        let disconnectedState = await manager.state
        let connected = await fake.isConnected
        XCTAssertEqual(disconnectedState, .disconnected)
        XCTAssertFalse(connected)
    }

    func testFailedTransportMovesToFailedState() async {
        let manager = makeComposition(
            transport: FakeTransport(shouldFailConnection: true)
        ).manager

        await manager.connect(to: HostEndpoint(
            host: "offline",
            port: 1,
            certificateFingerprint: testCertificateFingerprint
        ))

        guard case .failed = await manager.state else {
            return XCTFail("Expected failed state")
        }
    }

    func testPairAcceptancePersistsHostAfterWelcomeThenRequestsSnapshot() async throws {
        let fake = FakeTransport()
        let composition = makeComposition(transport: fake)
        let manager = composition.manager
        let endpoint = HostEndpoint(
            host: "psyche.local",
            port: 4242,
            certificateFingerprint: testCertificateFingerprint
        )

        await manager.connect(to: endpoint)
        await manager.waitForMessageProcessorReadiness()

        let helloOnly = await fake.sentMessages
        XCTAssertEqual(helloOnly.count, 1)
        guard requireCount(helloOnly, 1, "tokenless connect") else { return }
        guard case let .legacy(.hello(hello)) = helloOnly[0] else {
            return XCTFail("Tokenless connection should begin with hello")
        }
        XCTAssertNil(hello.token)

        await fake.emit(.legacy(.welcome(WelcomePayload(
            serverID: "server-1",
            serverName: "Host",
            protocolVersion: 3,
            projectName: nil
        ))))
        await manager.waitForEventDrain(after: 1)
        let hostsBeforeAcceptance = try await composition.pairedHostStore.hosts()
        XCTAssertEqual(hostsBeforeAcceptance, [])

        await manager.pair(code: "123456")

        let pairingRequest = await fake.sentMessages
        XCTAssertEqual(pairingRequest.count, 2)
        guard requireCount(pairingRequest, 2, "pair request") else { return }
        guard case let .legacy(.pair(payload)) = pairingRequest[1] else {
            return XCTFail("Expected typed pair request")
        }
        XCTAssertEqual(payload, PairRequestPayload(
            code: "123456",
            clientID: "test-client",
            clientName: "Psyche Tests"
        ))

        await fake.emit(.legacy(.pairAccepted(PairAcceptedPayload(token: "paired-token"))))
        await manager.waitForEventDrain(after: 2)
        _ = try await waitForSnapshotRequest(on: fake)

        let paired = await fake.sentMessages
        XCTAssertEqual(paired.filter(\.isWorkspaceSnapshotRequest).count, 1)
        let persistedHosts = try await composition.pairedHostStore.hosts()
        XCTAssertEqual(persistedHosts, [
            PairedHost(
                serverID: "server-1",
                serverName: "Host",
                endpoint: endpoint,
                clientID: "test-client",
                token: "paired-token"
            )
        ])
    }

    func testPairAcceptanceWithoutWelcomeFailsWithoutPersistingHost() async throws {
        let fake = FakeTransport()
        let composition = makeComposition(transport: fake)

        await composition.manager.connect(to: HostEndpoint(
            host: "psyche.local",
            port: 4242,
            certificateFingerprint: testCertificateFingerprint
        ))
        await composition.manager.waitForMessageProcessorReadiness()
        await fake.emit(.legacy(.pairAccepted(PairAcceptedPayload(token: "paired-token"))))

        await composition.manager.waitForState(.failed(
            ConnectionManagerError.missingWelcomeIdentity.localizedDescription
        ))

        let persistedHosts = try await composition.pairedHostStore.hosts()
        XCTAssertEqual(persistedHosts, [])
        XCTAssertTrue(composition.workspaceStore.isStale)
    }

    func testStoredHostReconnectRestoresClientIdentityAndToken() async throws {
        let fake = FakeTransport()
        let composition = makeComposition(
            transport: fake,
            clientID: "new-install-id",
            token: nil
        )
        let stored = PairedHost(
            serverID: "server-1",
            serverName: "Stored Host",
            endpoint: HostEndpoint(
                host: "stored.local",
                port: 5151,
                certificateFingerprint: testCertificateFingerprint
            ),
            clientID: "original-client-id",
            token: "issued-token"
        )
        try await composition.pairedHostStore.save(stored)

        await composition.manager.connectToStoredHost()
        await composition.manager.waitForMessageProcessorReadiness()

        let connectionAttempts = await fake.connectionAttempts
        XCTAssertEqual(connectionAttempts, [stored.endpoint])
        let messages = await fake.sentMessages
        guard case let .legacy(.hello(hello)) = messages.first else {
            return XCTFail("Stored host reconnect should send hello")
        }
        XCTAssertEqual(hello.clientID, "original-client-id")
        XCTAssertEqual(hello.token, "issued-token")
        XCTAssertEqual(hello.protocolVersion, 3)
    }

    func testReconnectCancelsPriorReaderBeforeProcessingNewStream() async {
        let fake = FakeTransport()
        let manager = makeComposition(transport: fake, token: "token").manager
        let firstEndpoint = HostEndpoint(
            host: "first",
            port: 4242,
            certificateFingerprint: testCertificateFingerprint
        )
        let secondEndpoint = HostEndpoint(
            host: "second",
            port: 4242,
            certificateFingerprint: testCertificateFingerprint
        )

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

        await fake.emit(.legacy(.paneList([makePane(id: "stale")])), onConnection: 0)
        await fake.emit(.legacy(.paneList([makePane(id: "current")])), onConnection: 1)
        await manager.waitForEventDrain(after: 1)

        let paneIDs = await manager.panes.map(\.id)
        XCTAssertEqual(paneIDs, ["current"])
    }

    func testUnexpectedIncomingMessageClosureFailsRequestsAndMarksWorkspaceStale() async throws {
        let fake = FakeTransport()
        let composition = makeComposition(transport: fake, token: "token")
        let manager = composition.manager

        await manager.connect(to: HostEndpoint(
            host: "psyche.local",
            port: 4242,
            certificateFingerprint: testCertificateFingerprint
        ))
        await manager.waitForMessageProcessorReadiness()
        let pending = Task {
            try await composition.requestClient.send(.killPane(PaneIDControlRequest(
                requestID: "pending-during-failure",
                paneID: "pane"
            )))
        }
        try await waitForPendingRequest(on: composition.requestClient)
        await fake.finishIncomingMessages()

        await manager.waitForState(.failed("Connection closed unexpectedly"))

        guard case let .failed(reason) = await manager.state else {
            return XCTFail("Unexpected stream closure should fail the connection")
        }
        XCTAssertEqual(reason, "Connection closed unexpectedly")
        let disconnectCount = await fake.disconnectCount
        XCTAssertEqual(disconnectCount, 1)
        XCTAssertTrue(composition.workspaceStore.isStale)
        do {
            _ = try await pending.value
            XCTFail("Transport failure should fail pending requests")
        } catch {
            XCTAssertEqual(error as? ControlRequestError, .disconnected)
        }
    }

    func testProtocolFailureStopsReaderAndDisconnectsTransport() async {
        let fake = FakeTransport()
        let manager = makeComposition(transport: fake, token: "token").manager

        await manager.connect(to: HostEndpoint(
            host: "psyche.local",
            port: 4242,
            certificateFingerprint: testCertificateFingerprint
        ))
        await manager.waitForMessageProcessorReadiness()
        await fake.emit(.legacy(.error(ProtocolError(code: "unauthorized", message: "token rejected"))))

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

    // MARK: - Review follow-ups from #4

    // The guard used to allow re-entry while .authenticating. Because connect()
    // keeps awaiting past that transition, a second call tore down the first
    // one's transport and the original resumed sending hello onto the
    // replacement — two connections' worth of traffic on one transport.
    func testConcurrentConnectDoesNotDuplicateHandshake() async {
        let fake = FakeTransport()
        let manager = makeComposition(
            transport: fake,
            clientID: "ios-device",
            clientName: "Psyche Tests",
            token: "token"
        ).manager
        let endpoint = HostEndpoint(
            host: "psyche.local",
            port: 4242,
            certificateFingerprint: testCertificateFingerprint
        )

        async let first: Void = manager.connect(to: endpoint)
        async let second: Void = manager.connect(to: endpoint)
        _ = await (first, second)
        await manager.waitForMessageProcessorReadiness()

        let sent = await fake.sentMessages
        let helloCount = sent.filter {
            if case .legacy(.hello) = $0 { return true }
            return false
        }.count
        XCTAssertEqual(helloCount, 1, "A concurrent connect must not repeat the handshake")

        let streams = await fake.incomingMessageStreamCount
        XCTAssertEqual(streams, 1, "A concurrent connect must not open a second reader")
    }

    // pair() previously required an explicit identity, which let callers bind a
    // token to a clientID the server never saw in hello.
    func testPairDefaultsToTheIdentityAnnouncedInHello() async {
        let fake = FakeTransport()
        let manager = makeComposition(
            transport: fake,
            clientID: "ios-device",
            clientName: "Psyche Tests"
        ).manager

        await manager.connect(to: HostEndpoint(
            host: "psyche.local",
            port: 4242,
            certificateFingerprint: testCertificateFingerprint
        ))
        await manager.waitForMessageProcessorReadiness()
        await manager.pair(code: "123456")

        let sent = await fake.sentMessages
        guard requireCount(sent, 2, "pair defaults") else { return }
        guard case let .legacy(.pair(payload)) = sent[1] else {
            return XCTFail("Expected typed pair request")
        }
        XCTAssertEqual(payload.clientID, "ios-device")
        XCTAssertEqual(payload.clientName, "Psyche Tests")
    }

    func testControlSnapshotAndOrderedWorkspaceEventsUpdateSharedStore() async throws {
        let fake = FakeTransport()
        let composition = makeComposition(transport: fake, token: "token")
        let manager = composition.manager

        await manager.connect(to: testEndpoint())
        await manager.waitForMessageProcessorReadiness()
        await fake.emit(.legacy(.welcome(makeWelcome())))
        let requestID = try await waitForSnapshotRequest(on: fake)
        await fake.emit(.control(.workspaceSnapshot(MobileWorkspaceSnapshotResult(
            requestID: requestID,
            sequence: 1,
            workspace: makeWorkspace(revision: 1)
        ))))
        await fake.emit(.workspaceChanged(WorkspaceChangedEvent(
            revision: 2,
            sequence: 2,
            workspace: makeWorkspace(revision: 2)
        )))
        await fake.emit(.workspaceChanged(WorkspaceChangedEvent(
            revision: 3,
            sequence: 3,
            workspace: makeWorkspace(revision: 3)
        )))
        await manager.waitForEventDrain(after: 4)

        XCTAssertEqual(composition.workspaceStore.workspace?.revision, 3)
        XCTAssertEqual(composition.workspaceStore.sequence, 3)
        XCTAssertFalse(composition.workspaceStore.isStale)
        let pendingRequestCount = await composition.requestClient.pendingRequestCount
        XCTAssertEqual(pendingRequestCount, 0)
    }

    func testBurstOfGappedEventsCoalescesRecoveryUntilSnapshotArrives() async throws {
        let fake = FakeTransport()
        let composition = makeComposition(transport: fake, token: "token")
        let manager = composition.manager

        await manager.connect(to: testEndpoint())
        await manager.waitForMessageProcessorReadiness()
        await fake.emit(.legacy(.welcome(makeWelcome())))
        let initialID = try await waitForSnapshotRequest(on: fake)
        await fake.emit(.control(.workspaceSnapshot(MobileWorkspaceSnapshotResult(
            requestID: initialID,
            sequence: 1,
            workspace: makeWorkspace(revision: 1)
        ))))
        await manager.waitForEventDrain(after: 2)

        await fake.emit(.workspaceChanged(WorkspaceChangedEvent(
            revision: 3,
            sequence: 3,
            workspace: makeWorkspace(revision: 3)
        )))
        await fake.emit(.workspaceChanged(WorkspaceChangedEvent(
            revision: 4,
            sequence: 4,
            workspace: makeWorkspace(revision: 4)
        )))
        await manager.waitForEventDrain(after: 4)
        let recoveryID = try await waitForSnapshotRequest(on: fake, occurrence: 2)
        let messagesAfterGap = await fake.sentMessages
        XCTAssertEqual(
            messagesAfterGap.filter(\.isWorkspaceSnapshotRequest).count,
            2,
            "A burst of gaps should add only one recovery request"
        )

        await fake.emit(.control(.workspaceSnapshot(MobileWorkspaceSnapshotResult(
            requestID: recoveryID,
            sequence: 4,
            workspace: makeWorkspace(revision: 4)
        ))))
        await fake.emit(.workspaceChanged(WorkspaceChangedEvent(
            revision: 6,
            sequence: 6,
            workspace: makeWorkspace(revision: 6)
        )))
        await manager.waitForEventDrain(after: 6)
        _ = try await waitForSnapshotRequest(on: fake, occurrence: 3)
        let messagesAfterRecovery = await fake.sentMessages
        XCTAssertEqual(messagesAfterRecovery.filter(\.isWorkspaceSnapshotRequest).count, 3)
    }

    func testDisconnectFailsPendingRequestsAndMarksWorkspaceStale() async throws {
        let fake = FakeTransport()
        let composition = makeComposition(transport: fake, token: "token")
        let manager = composition.manager

        await manager.connect(to: testEndpoint())
        await manager.waitForMessageProcessorReadiness()
        await fake.emit(.legacy(.welcome(makeWelcome())))
        let initialID = try await waitForSnapshotRequest(on: fake)
        await fake.emit(.control(.workspaceSnapshot(MobileWorkspaceSnapshotResult(
            requestID: initialID,
            sequence: 1,
            workspace: makeWorkspace(revision: 1)
        ))))
        await manager.waitForEventDrain(after: 2)

        let pending = Task {
            try await composition.requestClient.send(.killPane(PaneIDControlRequest(
                requestID: "pending",
                paneID: "pane"
            )))
        }
        try await waitForPendingRequest(on: composition.requestClient)
        await manager.disconnect()

        do {
            _ = try await pending.value
            XCTFail("Disconnect should fail pending requests")
        } catch {
            XCTAssertEqual(error as? ControlRequestError, .disconnected)
        }
        XCTAssertTrue(composition.workspaceStore.isStale)
        let pendingRequestCount = await composition.requestClient.pendingRequestCount
        XCTAssertEqual(pendingRequestCount, 0)
    }

    func testReconnectResetsBootstrapAndCanRequestSnapshotAgain() async throws {
        let fake = FakeTransport()
        let composition = makeComposition(transport: fake, token: "token")
        let manager = composition.manager

        await manager.connect(to: testEndpoint())
        await manager.waitForMessageProcessorReadiness()
        await fake.emit(.legacy(.welcome(makeWelcome())))
        let firstID = try await waitForSnapshotRequest(on: fake)
        await fake.emit(.control(.workspaceSnapshot(MobileWorkspaceSnapshotResult(
            requestID: firstID,
            sequence: 1,
            workspace: makeWorkspace(revision: 1)
        ))))
        await manager.waitForEventDrain(after: 2)
        await manager.disconnect()

        await manager.connect(to: testEndpoint())
        await manager.waitForMessageProcessorReadiness()
        await fake.emit(.legacy(.welcome(makeWelcome())))

        _ = try await waitForSnapshotRequest(on: fake, occurrence: 2)
        let messages = await fake.sentMessages
        XCTAssertEqual(messages.filter(\.isWorkspaceSnapshotRequest).count, 2)
    }

    // Synthesized Codable throws on an unrecognized raw value, so one new
    // status on the host would fail the entire message decode on an older
    // client rather than degrading to .unknown.
    func testPaneStatusDecodesUnrecognizedServerValueAsUnknown() throws {
        let data = Data("\"quantum-entangled\"".utf8)
        let decoded = try JSONDecoder().decode(PaneStatus.self, from: data)
        XCTAssertEqual(decoded, .unknown)
    }

    func testPaneStatusStillDecodesKnownValues() throws {
        for status in PaneStatus.allCases {
            let data = Data("\"\(status.rawValue)\"".utf8)
            XCTAssertEqual(try JSONDecoder().decode(PaneStatus.self, from: data), status)
        }
    }

    private func makeComposition(
        transport: FakeTransport,
        clientID: String = "test-client",
        clientName: String = "Psyche Tests",
        token: String? = nil
    ) -> TestComposition {
        let requestClient = ControlRequestClient(transport: transport)
        let workspaceStore = WorkspaceStore(controlRequests: requestClient)
        let pairedHostStore = PairedHostStore(secureStore: InMemorySecureStore())
        let manager = ConnectionManager(
            transport: transport,
            workspaceStore: workspaceStore,
            requestClient: requestClient,
            pairedHostStore: pairedHostStore,
            clientID: clientID,
            clientName: clientName,
            token: token
        )
        XCTAssertTrue(manager.requestClient === requestClient)
        return TestComposition(
            manager: manager,
            workspaceStore: workspaceStore,
            requestClient: requestClient,
            pairedHostStore: pairedHostStore
        )
    }

    private func testEndpoint() -> HostEndpoint {
        HostEndpoint(
            host: "psyche.local",
            port: 4242,
            certificateFingerprint: testCertificateFingerprint
        )
    }

    private func makeWelcome() -> WelcomePayload {
        WelcomePayload(
            serverID: "host",
            serverName: "Host",
            protocolVersion: 3,
            projectName: nil
        )
    }

    private func makeWorkspace(revision: Int) -> WorkspaceSnapshot {
        WorkspaceSnapshot(revision: revision, projects: [])
    }

    private func waitForSnapshotRequest(
        on transport: FakeTransport,
        occurrence: Int = 1,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws -> String {
        for _ in 0..<1_000 {
            let requests = await transport.sentMessages.compactMap { message -> String? in
                guard case let .control(.workspaceSnapshot(payload)) = message else { return nil }
                return payload.requestID
            }
            if requests.count >= occurrence {
                return requests[occurrence - 1]
            }
            await Task.yield()
        }
        XCTFail("Timed out waiting for snapshot request \(occurrence)", file: file, line: line)
        throw TestError.timedOut
    }

    private func waitForPendingRequest(
        on client: ControlRequestClient,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws {
        for _ in 0..<1_000 {
            if await client.pendingRequestCount > 0 { return }
            await Task.yield()
        }
        XCTFail("Timed out waiting for pending request", file: file, line: line)
        throw TestError.timedOut
    }

}

private struct TestComposition {
    let manager: ConnectionManager
    let workspaceStore: WorkspaceStore
    let requestClient: ControlRequestClient
    let pairedHostStore: PairedHostStore
}

private enum TestError: Error {
    case timedOut
}

private extension MobileClientMessage {
    var isWorkspaceSnapshotRequest: Bool {
        if case .control(.workspaceSnapshot) = self { return true }
        return false
    }
}
