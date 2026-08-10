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

        let connectTask = Task {
            await manager.connect(to: endpoint)
        }
        try await waitForHello(on: fake)
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
        await connectTask.value
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

    func testRealHostProvisionalV2WelcomeWaitsForNegotiatedV3Welcome() async throws {
        let fake = FakeTransport()
        let composition = makeComposition(transport: fake, token: "token")
        let manager = composition.manager
        let connectTask = Task {
            await manager.connect(to: testEndpoint())
        }

        try await waitForHello(on: fake)
        await fake.emit(.legacy(.welcome(WelcomePayload(
            serverID: "host",
            serverName: "Host",
            protocolVersion: PsycheProtocolVersion.legacy,
            projectName: "psyche",
            supportedVersions: [
                PsycheProtocolVersion.legacy,
                PsycheProtocolVersion.current
            ]
        ))))
        await fake.emit(.workspaceChanged(WorkspaceChangedEvent(
            revision: 1,
            sequence: 1,
            workspace: makeWorkspace(revision: 1)
        )))
        for _ in 0..<100 {
            await Task.yield()
        }

        let provisionalState = await manager.state
        XCTAssertEqual(provisionalState, .authenticating)
        let beforeNegotiatedWelcome = await fake.sentMessages
        XCTAssertEqual(beforeNegotiatedWelcome.filter(\.isWorkspaceSnapshotRequest).count, 0)

        await fake.emit(.legacy(.welcome(WelcomePayload(
            serverID: "host",
            serverName: "Host",
            protocolVersion: PsycheProtocolVersion.current,
            projectName: "psyche",
            supportedVersions: [
                PsycheProtocolVersion.legacy,
                PsycheProtocolVersion.current
            ]
        ))))
        await connectTask.value

        _ = try await waitForSnapshotRequest(on: fake)

        let state = await manager.state
        XCTAssertEqual(state, .connected)
        let messages = await fake.sentMessages
        XCTAssertEqual(messages.filter(\.isWorkspaceSnapshotRequest).count, 1)
    }

    func testPreV3SnapshotAndEventAreIgnoredUntilNegotiationCompletes() async throws {
        let fake = FakeTransport()
        let composition = makeComposition(transport: fake, token: "token")
        let manager = composition.manager
        let connectTask = Task {
            await manager.connect(to: testEndpoint())
        }

        try await waitForHello(on: fake)
        await fake.emit(.legacy(.welcome(WelcomePayload(
            serverID: "host",
            serverName: "Host",
            protocolVersion: PsycheProtocolVersion.legacy,
            projectName: "psyche",
            supportedVersions: [
                PsycheProtocolVersion.legacy,
                PsycheProtocolVersion.current
            ]
        ))))
        await fake.emit(.control(.workspaceSnapshot(MobileWorkspaceSnapshotResult(
            requestID: "pre-v3",
            sequence: 1,
            workspace: makeWorkspace(revision: 1)
        ))))
        await fake.emit(.workspaceChanged(WorkspaceChangedEvent(
            revision: 2,
            sequence: 2,
            workspace: makeWorkspace(revision: 2)
        )))
        for _ in 0..<100 {
            await Task.yield()
        }

        XCTAssertNil(composition.workspaceStore.workspace)
        XCTAssertEqual(composition.workspaceStore.sequence, 0)
        XCTAssertTrue(composition.workspaceStore.isStale)

        await fake.emit(.legacy(.welcome(makeWelcome())))
        await connectTask.value
        let requestID = try await waitForSnapshotRequest(on: fake)
        await fake.emit(.control(.workspaceSnapshot(MobileWorkspaceSnapshotResult(
            requestID: requestID,
            sequence: 1,
            workspace: makeWorkspace(revision: 10)
        ))))
        await fake.emit(.workspaceChanged(WorkspaceChangedEvent(
            revision: 11,
            sequence: 2,
            workspace: makeWorkspace(revision: 11)
        )))
        try await waitForWorkspaceRevision(11, in: composition.workspaceStore)

        XCTAssertEqual(composition.workspaceStore.sequence, 2)
        XCTAssertFalse(composition.workspaceStore.isStale)
    }

    func testPreV3ControlResponsesCannotCompleteWaitersBeforeActiveGeneration() async throws {
        let fake = FakeTransport()
        let composition = makeComposition(transport: fake)
        let manager = composition.manager
        let connectTask = Task {
            await manager.connect(to: testEndpoint())
        }

        try await waitForHello(on: fake)
        let ackProbe = RequestCompletionProbe()
        let errorProbe = RequestCompletionProbe()
        let otherProbe = RequestCompletionProbe()
        let ackWaiter = controlRequest(
            .killPane(PaneIDControlRequest(requestID: "pre-v3-ack", paneID: "pane")),
            on: composition.requestClient,
            probe: ackProbe
        )
        let errorWaiter = controlRequest(
            .killPane(PaneIDControlRequest(requestID: "pre-v3-error", paneID: "pane")),
            on: composition.requestClient,
            probe: errorProbe
        )
        let otherWaiter = controlRequest(
            .killPane(PaneIDControlRequest(requestID: "pre-v3-other", paneID: "pane")),
            on: composition.requestClient,
            probe: otherProbe
        )
        try await waitForPendingRequest(on: composition.requestClient, count: 3)

        await fake.emit(.legacy(.welcome(WelcomePayload(
            serverID: "host",
            serverName: "Host",
            protocolVersion: PsycheProtocolVersion.legacy,
            projectName: "psyche",
            supportedVersions: [
                PsycheProtocolVersion.legacy,
                PsycheProtocolVersion.current
            ]
        ))))
        await fake.emit(.control(.ack(ControlAckResponse(requestID: "pre-v3-ack"))))
        await fake.emit(.control(.error(MobileProtocolErrorResponse(
            requestID: "pre-v3-error",
            code: "too_early",
            message: "Not negotiated"
        ))))
        await fake.emit(.control(.unknown(UnknownControlResponse(
            type: "future.result",
            requestID: "pre-v3-other"
        ))))
        await fake.emit(.legacy(.projectList([])))
        await manager.waitForEventDrain(after: 1)

        let ackCompletedBeforeV3 = await ackProbe.isComplete
        let errorCompletedBeforeV3 = await errorProbe.isComplete
        let otherCompletedBeforeV3 = await otherProbe.isComplete
        let pendingBeforeV3 = await composition.requestClient.pendingRequestCount
        let stateBeforeV3 = await manager.state
        XCTAssertFalse(ackCompletedBeforeV3)
        XCTAssertFalse(errorCompletedBeforeV3)
        XCTAssertFalse(otherCompletedBeforeV3)
        XCTAssertEqual(pendingBeforeV3, 3)
        XCTAssertEqual(stateBeforeV3, .authenticating)

        await fake.emit(.legacy(.welcome(makeWelcome())))
        await connectTask.value

        let postV3Probe = RequestCompletionProbe()
        let postV3Waiter = controlRequest(
            .killPane(PaneIDControlRequest(requestID: "post-v3", paneID: "pane")),
            on: composition.requestClient,
            probe: postV3Probe
        )
        try await waitForPendingRequest(on: composition.requestClient, count: 4)
        await fake.emit(.control(.ack(ControlAckResponse(requestID: "post-v3"))))

        let postV3Result = await postV3Waiter.value
        XCTAssertEqual(
            try postV3Result.get(),
            .ack(ControlAckResponse(requestID: "post-v3"))
        )
        let postV3Completed = await postV3Probe.isComplete
        XCTAssertTrue(postV3Completed)

        await manager.disconnect()
        for waiter in [ackWaiter, errorWaiter, otherWaiter] {
            do {
                _ = try await waiter.value.get()
                XCTFail("Pre-v3 response must not complete its waiter")
            } catch {
                XCTAssertEqual(error as? ControlRequestError, .disconnected)
            }
        }
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

        let connectTask = Task {
            await manager.connect(to: endpoint)
        }
        try await waitForHello(on: fake)
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
        await connectTask.value
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

        let connectTask = Task {
            await composition.manager.connect(to: HostEndpoint(
                host: "psyche.local",
                port: 4242,
                certificateFingerprint: testCertificateFingerprint
            ))
        }
        try await waitForHello(on: fake)
        await composition.manager.waitForMessageProcessorReadiness()
        await fake.emit(.legacy(.pairAccepted(PairAcceptedPayload(token: "paired-token"))))
        await connectTask.value

        await composition.manager.waitForState(.failed(
            ConnectionManagerError.missingWelcomeIdentity.localizedDescription
        ))

        let persistedHosts = try await composition.pairedHostStore.hosts()
        XCTAssertEqual(persistedHosts, [])
        XCTAssertTrue(composition.workspaceStore.isStale)
    }

    func testRetiredSessionPairAcceptanceCannotPersistOrReplaceToken() async throws {
        let fake = FakeTransport()
        let secureStore = BlockingReadSecureStore()
        let pairedHostStore = PairedHostStore(secureStore: secureStore)
        let requestClient = ControlRequestClient(transport: fake)
        let workspaceStore = WorkspaceStore(controlRequests: requestClient)
        let manager = ConnectionManager(
            transport: fake,
            workspaceStore: workspaceStore,
            requestClient: requestClient,
            pairedHostStore: pairedHostStore,
            clientID: "test-client",
            clientName: "Psyche Tests",
            token: "original-token"
        )
        let firstEndpoint = testEndpoint()
        let secondEndpoint = HostEndpoint(
            host: "second.local",
            port: 4242,
            certificateFingerprint: testCertificateFingerprint
        )

        let firstConnect = Task {
            await manager.connect(to: firstEndpoint)
        }
        try await waitForHello(on: fake)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await firstConnect.value
        _ = try await waitForSnapshotRequest(on: fake)

        secureStore.blockNextRead()
        await fake.emit(.legacy(.pairAccepted(PairAcceptedPayload(token: "stale-token"))))
        try await secureStore.waitUntilReadBegins()

        let reconnect = Task {
            await manager.connect(to: secondEndpoint)
        }
        try await waitForConnectionAttempts(2, on: fake)
        secureStore.releaseRead()
        try await waitForHello(on: fake, occurrence: 2)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await reconnect.value

        let persistedHosts = try await pairedHostStore.hosts()
        XCTAssertEqual(persistedHosts, [])

        let hellos = await fake.sentMessages.compactMap { message -> HelloPayload? in
            guard case let .legacy(.hello(payload)) = message else { return nil }
            return payload
        }
        XCTAssertEqual(hellos.count, 2)
        XCTAssertEqual(hellos.last?.token, "original-token")
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

        let connectTask = Task {
            await composition.manager.connectToStoredHost()
        }
        try await waitForHello(on: fake)
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
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await connectTask.value
    }

    func testAppCompositionSharesItsGraphAndStartsStoredHostReconnectOnlyOnce() async throws {
        let fake = FakeTransport()
        let pairedHostStore = PairedHostStore(secureStore: InMemorySecureStore())
        let stored = PairedHost(
            serverID: "server-1",
            serverName: "Stored Host",
            endpoint: HostEndpoint(
                host: "stored.local",
                port: 5151,
                certificateFingerprint: testCertificateFingerprint
            ),
            clientID: "stored-client",
            token: "stored-token"
        )
        try await pairedHostStore.save(stored)
        let composition = MobileAppComposition(
            transport: fake,
            pairedHostStore: pairedHostStore,
            clientID: "unused-install-id"
        )

        XCTAssertTrue(composition.connectionManager.requestClient === composition.requestClient)

        let startTask = Task {
            await composition.start()
        }
        try await waitForHello(on: fake)
        await composition.start()

        let attempts = await fake.connectionAttempts
        XCTAssertEqual(attempts, [stored.endpoint])
        let sent = await fake.sentMessages
        guard case let .legacy(.hello(hello)) = sent.first else {
            return XCTFail("Stored-host launch should send hello through the shared transport")
        }
        XCTAssertEqual(hello.clientID, stored.clientID)
        XCTAssertEqual(hello.token, stored.token)
        XCTAssertEqual(hello.protocolVersion, PsycheProtocolVersion.current)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await startTask.value
    }

    func testReconnectCancelsPriorReaderBeforeProcessingNewStream() async throws {
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

        let firstConnect = Task {
            await manager.connect(to: firstEndpoint)
        }
        try await waitForHello(on: fake)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await firstConnect.value
        let secondConnect = Task {
            await manager.connect(to: secondEndpoint)
        }
        try await waitForHello(on: fake, occurrence: 2)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await secondConnect.value

        let connectionAttempts = await fake.connectionAttempts
        let disconnectCount = await fake.disconnectCount
        let streamCount = await fake.incomingMessageStreamCount
        XCTAssertEqual(connectionAttempts, [firstEndpoint, secondEndpoint])
        XCTAssertEqual(disconnectCount, 1)
        XCTAssertEqual(streamCount, 2)

        await fake.emit(.legacy(.paneList([makePane(id: "stale")])), onConnection: 0)
        await fake.emit(.legacy(.paneList([makePane(id: "current")])), onConnection: 1)
        try await waitForPaneIDs(["current"], in: manager)

        let paneIDs = await manager.panes.map(\.id)
        XCTAssertEqual(paneIDs, ["current"])
    }

    func testUnexpectedIncomingMessageClosureFailsRequestsAndMarksWorkspaceStale() async throws {
        let fake = FakeTransport()
        let composition = makeComposition(transport: fake, token: "token")
        let manager = composition.manager

        let connectTask = Task {
            await manager.connect(to: HostEndpoint(
                host: "psyche.local",
                port: 4242,
                certificateFingerprint: testCertificateFingerprint
            ))
        }
        try await waitForHello(on: fake)
        await manager.waitForMessageProcessorReadiness()
        let pending = Task {
            try await composition.requestClient.send(.killPane(PaneIDControlRequest(
                requestID: "pending-during-failure",
                paneID: "pane"
            )))
        }
        try await waitForPendingRequest(on: composition.requestClient)
        await fake.finishIncomingMessages()
        await connectTask.value

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

        let connectTask = Task {
            await manager.connect(to: HostEndpoint(
                host: "psyche.local",
                port: 4242,
                certificateFingerprint: testCertificateFingerprint
            ))
        }
        try? await waitForHello(on: fake)
        await manager.waitForMessageProcessorReadiness()
        await fake.emit(.legacy(.error(ProtocolError(code: "unauthorized", message: "token rejected"))))
        await connectTask.value

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
        try? await waitForHello(on: fake)
        await fake.emit(.legacy(.welcome(makeWelcome())))
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

    func testDisconnectBeforeReaderReadinessCompletesConnectAndAllowsReconnect() async throws {
        let fake = FakeTransport()
        let startGate = MessageProcessorStartGate()
        let manager = makeComposition(
            transport: fake,
            token: "token",
            messageProcessorStart: startGate.wait
        ).manager

        let connectTask = Task {
            await manager.connect(to: testEndpoint())
        }
        await startGate.waitUntilEntered()

        await manager.disconnect()
        let connectFinished = expectation(description: "connect completed after disconnect")
        Task {
            await connectTask.value
            connectFinished.fulfill()
        }
        await fulfillment(of: [connectFinished], timeout: 1)
        await startGate.release()

        let disconnectedState = await manager.state
        XCTAssertEqual(disconnectedState, .disconnected)

        let reconnectTask = Task {
            await manager.connect(to: testEndpoint())
        }
        try await waitForHello(on: fake)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await reconnectTask.value
        _ = try await waitForSnapshotRequest(on: fake)
        let reconnectedState = await manager.state
        XCTAssertEqual(reconnectedState, .connected)
    }

    func testDisconnectDuringTransportConnectCleansOwnedResourceAndAllowsReconnect() async throws {
        let fake = FakeTransport()
        let transport = AllocatedConnectSuspensionTransport(base: fake)
        let composition = makeComposition(transport: transport, token: "token")
        let manager = composition.manager
        let firstConnect = Task {
            await manager.connect(to: testEndpoint())
        }

        await transport.waitUntilFirstConnectSuspends()
        let connectedResource = await fake.isConnected
        XCTAssertTrue(connectedResource)
        let pending = Task {
            try await composition.requestClient.send(.killPane(PaneIDControlRequest(
                requestID: "disconnect-during-connect",
                paneID: "pane"
            )))
        }
        try await waitForPendingRequest(on: composition.requestClient)

        await manager.disconnect()
        let disconnectCount = await fake.disconnectCount
        let connectedAfterDisconnect = await fake.isConnected
        let disconnectedState = await manager.state
        let pendingRequestCount = await composition.requestClient.pendingRequestCount
        XCTAssertEqual(disconnectCount, 1)
        XCTAssertFalse(connectedAfterDisconnect)
        XCTAssertTrue(composition.workspaceStore.isStale)
        XCTAssertEqual(disconnectedState, .disconnected)
        XCTAssertEqual(pendingRequestCount, 0)
        if pendingRequestCount > 0 {
            pending.cancel()
        }
        do {
            _ = try await pending.value
            XCTFail("Disconnect should fail a request started during transport connect")
        } catch {
            XCTAssertEqual(error as? ControlRequestError, .disconnected)
        }

        let reconnect = Task {
            await manager.connect(to: testEndpoint())
        }
        try await waitForHello(on: fake)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await reconnect.value
        let reconnectedState = await manager.state
        let reconnectDisconnectCount = await fake.disconnectCount
        XCTAssertEqual(reconnectedState, .connected)
        XCTAssertEqual(reconnectDisconnectCount, 1)

        await transport.releaseFirstConnect()
        await firstConnect.value
        let stateAfterLateReturn = await manager.state
        let connectedAfterLateReturn = await fake.isConnected
        let finalDisconnectCount = await fake.disconnectCount
        XCTAssertEqual(stateAfterLateReturn, .connected)
        XCTAssertTrue(connectedAfterLateReturn)
        XCTAssertEqual(finalDisconnectCount, 1)

        await manager.disconnect()
    }

    func testCancellationBeforeReaderReadinessCompletesConnectAndAllowsReconnect() async throws {
        let fake = FakeTransport()
        let startGate = MessageProcessorStartGate()
        let manager = makeComposition(
            transport: fake,
            token: "token",
            messageProcessorStart: startGate.wait
        ).manager

        let connectTask = Task {
            await manager.connect(to: testEndpoint())
        }
        await startGate.waitUntilEntered()

        connectTask.cancel()
        let connectFinished = expectation(description: "connect completed after cancellation")
        Task {
            await connectTask.value
            connectFinished.fulfill()
        }
        await fulfillment(of: [connectFinished], timeout: 1)
        await startGate.release()

        let expectedCancellation = ConnectionState.failed(
            ConnectionManagerError.connectionCancelled.localizedDescription
        )
        await manager.waitForState(expectedCancellation)
        let cancelledState = await manager.state
        XCTAssertEqual(cancelledState, expectedCancellation)

        let reconnectTask = Task {
            await manager.connect(to: testEndpoint())
        }
        try await waitForHello(on: fake)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await reconnectTask.value
        _ = try await waitForSnapshotRequest(on: fake)
        let reconnectedState = await manager.state
        XCTAssertEqual(reconnectedState, .connected)
    }

    func testCancellationDuringTransportConnectCleansOwnedResourceAndAllowsReconnect() async throws {
        let fake = FakeTransport()
        let transport = AllocatedConnectSuspensionTransport(base: fake)
        let composition = makeComposition(transport: transport, token: "token")
        let manager = composition.manager
        let firstConnect = Task {
            await manager.connect(to: testEndpoint())
        }

        await transport.waitUntilFirstConnectSuspends()
        let connectedResource = await fake.isConnected
        XCTAssertTrue(connectedResource)
        let pending = Task {
            try await composition.requestClient.send(.killPane(PaneIDControlRequest(
                requestID: "cancel-during-connect",
                paneID: "pane"
            )))
        }
        try await waitForPendingRequest(on: composition.requestClient)

        firstConnect.cancel()
        try await waitForDisconnectCount(1, on: fake)
        let expectedCancellation = ConnectionState.failed(
            ConnectionManagerError.connectionCancelled.localizedDescription
        )
        await manager.waitForState(expectedCancellation)
        let connectedAfterCancellation = await fake.isConnected
        let pendingRequestCount = await composition.requestClient.pendingRequestCount
        XCTAssertFalse(connectedAfterCancellation)
        XCTAssertTrue(composition.workspaceStore.isStale)
        XCTAssertEqual(pendingRequestCount, 0)
        if pendingRequestCount > 0 {
            pending.cancel()
        }
        do {
            _ = try await pending.value
            XCTFail("Cancellation should fail a request started during transport connect")
        } catch {
            XCTAssertEqual(error as? ControlRequestError, .disconnected)
        }

        let reconnect = Task {
            await manager.connect(to: testEndpoint())
        }
        try await waitForHello(on: fake)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await reconnect.value
        let reconnectedState = await manager.state
        let reconnectDisconnectCount = await fake.disconnectCount
        XCTAssertEqual(reconnectedState, .connected)
        XCTAssertEqual(reconnectDisconnectCount, 1)

        await transport.releaseFirstConnect()
        await firstConnect.value
        let stateAfterLateReturn = await manager.state
        let connectedAfterLateReturn = await fake.isConnected
        let finalDisconnectCount = await fake.disconnectCount
        XCTAssertEqual(stateAfterLateReturn, .connected)
        XCTAssertTrue(connectedAfterLateReturn)
        XCTAssertEqual(finalDisconnectCount, 1)

        await manager.disconnect()
    }

    func testCancellationAfterHelloBeforeWelcomeCleansUpAndAllowsReconnect() async throws {
        let fake = FakeTransport()
        let composition = makeComposition(transport: fake, token: "token")
        let manager = composition.manager
        let connectTask = Task {
            await manager.connect(to: testEndpoint())
        }

        try await waitForHello(on: fake)
        connectTask.cancel()
        await connectTask.value
        try await waitForDisconnectCount(1, on: fake)

        XCTAssertTrue(composition.workspaceStore.isStale)
        let cancelledState = await manager.state
        XCTAssertEqual(
            cancelledState,
            .failed(ConnectionManagerError.connectionCancelled.localizedDescription)
        )

        let reconnectTask = Task {
            await manager.connect(to: testEndpoint())
        }
        try await waitForHello(on: fake, occurrence: 2)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await reconnectTask.value
        _ = try await waitForSnapshotRequest(on: fake)

        let reconnectedState = await manager.state
        XCTAssertEqual(reconnectedState, .connected)
    }

    func testCancellationDuringProvisionalNegotiationCleansUpAndAllowsReconnect() async throws {
        let fake = FakeTransport()
        let composition = makeComposition(transport: fake, token: "token")
        let manager = composition.manager
        let connectTask = Task {
            await manager.connect(to: testEndpoint())
        }

        try await waitForHello(on: fake)
        await fake.emit(.legacy(.welcome(WelcomePayload(
            serverID: "host",
            serverName: "Host",
            protocolVersion: PsycheProtocolVersion.legacy,
            projectName: "psyche",
            supportedVersions: [
                PsycheProtocolVersion.legacy,
                PsycheProtocolVersion.current
            ]
        ))))
        let provisionalState = await manager.state
        XCTAssertEqual(provisionalState, .authenticating)

        connectTask.cancel()
        await connectTask.value
        try await waitForDisconnectCount(1, on: fake)

        let reconnectTask = Task {
            await manager.connect(to: testEndpoint())
        }
        try await waitForHello(on: fake, occurrence: 2)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await reconnectTask.value
        _ = try await waitForSnapshotRequest(on: fake)

        let reconnectedState = await manager.state
        XCTAssertEqual(reconnectedState, .connected)
    }

    func testCancellationAtSuccessfulHelloBoundaryCleansUpAndAllowsReconnect() async throws {
        let fake = FakeTransport()
        let helloGate = AsyncGate()
        let transport = HelloCompletionGateTransport(base: fake, gate: helloGate)
        let composition = makeComposition(transport: transport, token: "token")
        let manager = composition.manager
        let connectTask = Task {
            await manager.connect(to: testEndpoint())
        }

        try await waitForHello(on: fake)
        await helloGate.release()
        connectTask.cancel()
        await connectTask.value
        try await waitForDisconnectCount(1, on: fake)

        let reconnectTask = Task {
            await manager.connect(to: testEndpoint())
        }
        try await waitForHello(on: fake, occurrence: 2)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await reconnectTask.value
        _ = try await waitForSnapshotRequest(on: fake)

        let reconnectedState = await manager.state
        XCTAssertEqual(reconnectedState, .connected)
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

        let connectTask = Task {
            await manager.connect(to: HostEndpoint(
                host: "psyche.local",
                port: 4242,
                certificateFingerprint: testCertificateFingerprint
            ))
        }
        try? await waitForHello(on: fake)
        await manager.waitForMessageProcessorReadiness()
        await manager.pair(code: "123456")

        let sent = await fake.sentMessages
        guard requireCount(sent, 2, "pair defaults") else { return }
        guard case let .legacy(.pair(payload)) = sent[1] else {
            return XCTFail("Expected typed pair request")
        }
        XCTAssertEqual(payload.clientID, "ios-device")
        XCTAssertEqual(payload.clientName, "Psyche Tests")
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await connectTask.value
    }

    func testControlSnapshotAndOrderedWorkspaceEventsUpdateSharedStore() async throws {
        let fake = FakeTransport()
        let composition = makeComposition(transport: fake, token: "token")
        let manager = composition.manager

        let connectTask = Task {
            await manager.connect(to: testEndpoint())
        }
        try await waitForHello(on: fake)
        await manager.waitForMessageProcessorReadiness()
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await connectTask.value
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

        let connectTask = Task {
            await manager.connect(to: testEndpoint())
        }
        try await waitForHello(on: fake)
        await manager.waitForMessageProcessorReadiness()
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await connectTask.value
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

        let connectTask = Task {
            await manager.connect(to: testEndpoint())
        }
        try await waitForHello(on: fake)
        await manager.waitForMessageProcessorReadiness()
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await connectTask.value
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

        let firstConnect = Task {
            await manager.connect(to: testEndpoint())
        }
        try await waitForHello(on: fake)
        await manager.waitForMessageProcessorReadiness()
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await firstConnect.value
        let firstID = try await waitForSnapshotRequest(on: fake)
        await fake.emit(.control(.workspaceSnapshot(MobileWorkspaceSnapshotResult(
            requestID: firstID,
            sequence: 1,
            workspace: makeWorkspace(revision: 1)
        ))))
        await manager.waitForEventDrain(after: 2)
        await manager.disconnect()

        let secondConnect = Task {
            await manager.connect(to: testEndpoint())
        }
        try await waitForHello(on: fake, occurrence: 2)
        await manager.waitForMessageProcessorReadiness()
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await secondConnect.value

        _ = try await waitForSnapshotRequest(on: fake, occurrence: 2)
        let messages = await fake.sentMessages
        XCTAssertEqual(messages.filter(\.isWorkspaceSnapshotRequest).count, 2)
    }

    func testReconnectAcceptsLowerSequenceAuthoritativeSnapshot() async throws {
        let fake = FakeTransport()
        let composition = makeComposition(transport: fake, token: "token")
        let manager = composition.manager

        let firstConnect = Task {
            await manager.connect(to: testEndpoint())
        }
        try await waitForHello(on: fake)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await firstConnect.value
        let firstID = try await waitForSnapshotRequest(on: fake)
        await fake.emit(.control(.workspaceSnapshot(MobileWorkspaceSnapshotResult(
            requestID: firstID,
            sequence: 50,
            workspace: makeWorkspace(revision: 50)
        ))))
        await manager.waitForEventDrain(after: 2)
        await manager.disconnect()

        XCTAssertEqual(composition.workspaceStore.workspace?.revision, 50)
        XCTAssertTrue(composition.workspaceStore.isStale)

        let secondConnect = Task {
            await manager.connect(to: testEndpoint())
        }
        try await waitForHello(on: fake, occurrence: 2)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await secondConnect.value
        let secondID = try await waitForSnapshotRequest(on: fake, occurrence: 2)
        await fake.emit(.control(.workspaceSnapshot(MobileWorkspaceSnapshotResult(
            requestID: secondID,
            sequence: 1,
            workspace: makeWorkspace(revision: 1)
        ))))
        await manager.waitForEventDrain(after: 4)

        XCTAssertEqual(composition.workspaceStore.workspace?.revision, 1)
        XCTAssertEqual(composition.workspaceStore.sequence, 1)
        XCTAssertFalse(composition.workspaceStore.isStale)
        XCTAssertFalse(composition.workspaceStore.needsFullSnapshot)
    }

    func testStaleRecoverySnapshotFromPriorGenerationCannotMutateReconnect() async throws {
        let fake = FakeTransport()
        let composition = makeComposition(transport: fake, token: "token")
        let manager = composition.manager

        let firstConnect = Task {
            await manager.connect(to: testEndpoint())
        }
        try await waitForHello(on: fake)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await firstConnect.value
        let initialID = try await waitForSnapshotRequest(on: fake)
        await fake.emit(.control(.workspaceSnapshot(MobileWorkspaceSnapshotResult(
            requestID: initialID,
            sequence: 1,
            workspace: makeWorkspace(revision: 1)
        ))))
        try await waitForWorkspaceRevision(1, in: composition.workspaceStore)

        await fake.emit(.workspaceChanged(WorkspaceChangedEvent(
            revision: 3,
            sequence: 3,
            workspace: makeWorkspace(revision: 3)
        )))
        let staleRecoveryID = try await waitForSnapshotRequest(on: fake, occurrence: 2)

        await manager.disconnect()
        let secondConnect = Task {
            await manager.connect(to: testEndpoint())
        }
        try await waitForHello(on: fake, occurrence: 2)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await secondConnect.value
        let activeRequestID = try await waitForSnapshotRequest(on: fake, occurrence: 3)

        await fake.emit(.control(.workspaceSnapshot(MobileWorkspaceSnapshotResult(
            requestID: staleRecoveryID,
            sequence: 99,
            workspace: makeWorkspace(revision: 99)
        ))))
        for _ in 0..<100 {
            await Task.yield()
        }

        XCTAssertEqual(composition.workspaceStore.workspace?.revision, 1)
        XCTAssertEqual(composition.workspaceStore.sequence, 0)
        XCTAssertTrue(composition.workspaceStore.isStale)
        XCTAssertTrue(composition.workspaceStore.needsFullSnapshot)

        await fake.emit(.control(.workspaceSnapshot(MobileWorkspaceSnapshotResult(
            requestID: activeRequestID,
            sequence: 1,
            workspace: makeWorkspace(revision: 2)
        ))))
        await fake.emit(.workspaceChanged(WorkspaceChangedEvent(
            revision: 3,
            sequence: 2,
            workspace: makeWorkspace(revision: 3)
        )))
        try await waitForWorkspaceRevision(3, in: composition.workspaceStore)

        XCTAssertEqual(composition.workspaceStore.sequence, 2)
        XCTAssertFalse(composition.workspaceStore.isStale)
        XCTAssertFalse(composition.workspaceStore.needsFullSnapshot)
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
        transport: any PsycheTransport,
        clientID: String = "test-client",
        clientName: String = "Psyche Tests",
        token: String? = nil,
        messageProcessorStart: @escaping @Sendable () async -> Void = {}
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
            token: token,
            messageProcessorStart: messageProcessorStart
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

    private func waitForHello(
        on transport: FakeTransport,
        occurrence: Int = 1,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws {
        for _ in 0..<1_000 {
            let count = await transport.sentMessages.filter {
                if case .legacy(.hello) = $0 { return true }
                return false
            }.count
            if count >= occurrence { return }
            await Task.yield()
        }
        XCTFail("Timed out waiting for hello \(occurrence)", file: file, line: line)
        throw TestError.timedOut
    }

    private func waitForDisconnectCount(
        _ count: Int,
        on transport: FakeTransport,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws {
        for _ in 0..<1_000 {
            if await transport.disconnectCount >= count { return }
            await Task.yield()
        }
        XCTFail("Timed out waiting for disconnect \(count)", file: file, line: line)
        throw TestError.timedOut
    }

    private func waitForWorkspaceRevision(
        _ revision: Int,
        in store: WorkspaceStore,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws {
        for _ in 0..<1_000 {
            if store.workspace?.revision == revision { return }
            await Task.yield()
        }
        XCTFail("Timed out waiting for workspace revision \(revision)", file: file, line: line)
        throw TestError.timedOut
    }

    private func waitForPaneIDs(
        _ paneIDs: [String],
        in manager: ConnectionManager,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws {
        for _ in 0..<1_000 {
            if await manager.panes.map(\.id) == paneIDs { return }
            await Task.yield()
        }
        XCTFail("Timed out waiting for panes \(paneIDs)", file: file, line: line)
        throw TestError.timedOut
    }

    private func waitForPendingRequest(
        on client: ControlRequestClient,
        count: Int = 1,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws {
        for _ in 0..<1_000 {
            if await client.pendingRequestCount >= count { return }
            await Task.yield()
        }
        XCTFail("Timed out waiting for \(count) pending request(s)", file: file, line: line)
        throw TestError.timedOut
    }

    private func controlRequest(
        _ request: MobileControlRequest,
        on client: ControlRequestClient,
        probe: RequestCompletionProbe
    ) -> Task<Result<MobileControlResponse, any Error>, Never> {
        Task {
            let result: Result<MobileControlResponse, any Error>
            do {
                result = .success(try await client.send(request))
            } catch {
                result = .failure(error)
            }
            await probe.markComplete()
            return result
        }
    }

    private func waitForConnectionAttempts(
        _ count: Int,
        on transport: FakeTransport,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws {
        for _ in 0..<1_000 {
            if await transport.connectionAttempts.count >= count { return }
            await Task.yield()
        }
        XCTFail("Timed out waiting for connection attempt \(count)", file: file, line: line)
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

private actor AsyncGate {
    private var isReleased = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        guard !isReleased else { return }
        await withCheckedContinuation { continuation in
            if isReleased {
                continuation.resume()
            } else {
                waiters.append(continuation)
            }
        }
    }

    func release() {
        isReleased = true
        let waiting = waiters
        waiters.removeAll()
        waiting.forEach { $0.resume() }
    }
}

private actor HelloCompletionGateTransport: PsycheTransport {
    private let base: FakeTransport
    private let gate: AsyncGate
    private var shouldGateHello = true

    init(base: FakeTransport, gate: AsyncGate) {
        self.base = base
        self.gate = gate
    }

    func connect(to endpoint: HostEndpoint) async throws {
        try await base.connect(to: endpoint)
    }

    func disconnect() async {
        await base.disconnect()
    }

    func send(_ message: MobileClientMessage) async throws {
        try await base.send(message)
        if shouldGateHello, case .legacy(.hello) = message {
            shouldGateHello = false
            await gate.wait()
        }
    }

    func incomingMessages() async -> AsyncStream<MobileServerMessage> {
        await base.incomingMessages()
    }

    func incomingBinaryFrames() async -> AsyncStream<TerminalBinaryFrame> {
        await base.incomingBinaryFrames()
    }
}

private actor RequestCompletionProbe {
    private(set) var isComplete = false

    func markComplete() {
        isComplete = true
    }
}

private actor AllocatedConnectSuspensionTransport: PsycheTransport {
    private let base: FakeTransport
    private let firstConnectGate = AsyncGate()
    private var connectionCount = 0
    private var firstConnectDidSuspend = false
    private var firstConnectWaiters: [CheckedContinuation<Void, Never>] = []

    init(base: FakeTransport) {
        self.base = base
    }

    func connect(to endpoint: HostEndpoint) async throws {
        connectionCount += 1
        let shouldSuspend = connectionCount == 1
        try await base.connect(to: endpoint)
        guard shouldSuspend else { return }

        firstConnectDidSuspend = true
        let waiting = firstConnectWaiters
        firstConnectWaiters.removeAll()
        waiting.forEach { $0.resume() }
        await firstConnectGate.wait()
    }

    func disconnect() async {
        await base.disconnect()
    }

    func send(_ message: MobileClientMessage) async throws {
        try await base.send(message)
    }

    func incomingMessages() async -> AsyncStream<MobileServerMessage> {
        await base.incomingMessages()
    }

    func incomingBinaryFrames() async -> AsyncStream<TerminalBinaryFrame> {
        await base.incomingBinaryFrames()
    }

    func waitUntilFirstConnectSuspends() async {
        guard !firstConnectDidSuspend else { return }
        await withCheckedContinuation { continuation in
            if firstConnectDidSuspend {
                continuation.resume()
            } else {
                firstConnectWaiters.append(continuation)
            }
        }
    }

    func releaseFirstConnect() async {
        await firstConnectGate.release()
    }
}

private final class BlockingReadSecureStore: SecureStore, @unchecked Sendable {
    private let condition = NSCondition()
    private var storage: [String: Data] = [:]
    private var shouldBlockNextRead = false
    private var readBegan = false
    private var readReleased = false

    func blockNextRead() {
        condition.withLock {
            shouldBlockNextRead = true
            readBegan = false
            readReleased = false
        }
    }

    func waitUntilReadBegins(
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws {
        for _ in 0..<1_000 {
            if condition.withLock({ readBegan }) { return }
            await Task.yield()
        }
        XCTFail("Timed out waiting for paired-host read", file: file, line: line)
        throw TestError.timedOut
    }

    func releaseRead() {
        condition.withLock {
            readReleased = true
            condition.broadcast()
        }
    }

    func data(forKey key: String) throws -> Data? {
        condition.lock()
        if shouldBlockNextRead {
            shouldBlockNextRead = false
            readBegan = true
            condition.broadcast()
            while !readReleased {
                condition.wait()
            }
        }
        let data = storage[key]
        condition.unlock()
        return data
    }

    func set(_ data: Data, forKey key: String) throws {
        condition.withLock {
            storage[key] = data
        }
    }

    func removeValue(forKey key: String) throws {
        _ = condition.withLock {
            storage.removeValue(forKey: key)
        }
    }
}

private actor MessageProcessorStartGate {
    private var isReleased = false
    private var didEnter = false
    private var entryWaiters: [CheckedContinuation<Void, Never>] = []
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        didEnter = true
        let entered = entryWaiters
        entryWaiters.removeAll()
        entered.forEach { $0.resume() }
        guard !isReleased else { return }
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
        }
    }

    func waitUntilEntered() async {
        guard !didEnter else { return }
        await withCheckedContinuation { continuation in
            if didEnter {
                continuation.resume()
            } else {
                entryWaiters.append(continuation)
            }
        }
    }

    func release() {
        isReleased = true
        let waiting = waiters
        waiters.removeAll()
        waiting.forEach { $0.resume() }
    }
}

private extension MobileClientMessage {
    var isWorkspaceSnapshotRequest: Bool {
        if case .control(.workspaceSnapshot) = self { return true }
        return false
    }
}
