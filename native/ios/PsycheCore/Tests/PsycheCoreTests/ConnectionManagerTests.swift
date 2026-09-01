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
        await manager.waitForEventDrain(after: 3)

        let connectedState = await manager.state
        XCTAssertEqual(connectedState, .connected)
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

    func testPreV3LegacyWorkspaceMessagesDoNotMutateState() async throws {
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
        await fake.emit(.legacy(.projectList([
            Project(id: "legacy-project", displayName: "Legacy", attentionCount: 1)
        ])))
        await fake.emit(.legacy(.paneList([makePane(id: "legacy-pane")])))
        await fake.emit(.legacy(.paneOutput(PaneOutputPayload(
            paneID: "legacy-pane",
            data: "legacy output",
            seq: 1
        ))))
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await connectTask.value

        let legacyProjects = await manager.projects
        let legacyPanes = await manager.panes
        let legacyOutput = await manager.latestOutputByPane
        XCTAssertTrue(legacyProjects.isEmpty)
        XCTAssertTrue(legacyPanes.isEmpty)
        XCTAssertTrue(legacyOutput.isEmpty)
        XCTAssertNil(composition.workspaceStore.workspace)

        let requestID = try await waitForSnapshotRequest(on: fake)
        await fake.emit(.control(.workspaceSnapshot(MobileWorkspaceSnapshotResult(
            requestID: requestID,
            sequence: 1,
            workspace: makeWorkspace(revision: 10)
        ))))
        try await waitForWorkspaceRevision(10, in: composition.workspaceStore)

        XCTAssertEqual(composition.workspaceStore.sequence, 1)
        XCTAssertFalse(composition.workspaceStore.isStale)
    }

    func testSharedRequestClientActivatesOnlyAfterV3Negotiation() async throws {
        let fake = FakeTransport()
        let composition = makeComposition(transport: fake)
        let manager = composition.manager
        let connectTask = Task {
            await manager.connect(to: testEndpoint())
        }

        try await waitForHello(on: fake)
        do {
            _ = try await composition.requestClient.send(.killPane(PaneIDControlRequest(
                requestID: "pre-v3",
                paneID: "pane"
            )))
            XCTFail("The shared client must stay unavailable before v3 negotiation")
        } catch {
            XCTAssertEqual(error as? ControlRequestError, .disconnected)
        }

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
        await fake.emit(.control(.ack(ControlAckResponse(requestID: "pre-v3"))))
        for _ in 0..<100 {
            await Task.yield()
        }

        let pendingBeforeV3 = await composition.requestClient.pendingRequestCount
        let stateBeforeV3 = await manager.state
        let beforeV3Messages = await fake.sentMessages
        XCTAssertEqual(pendingBeforeV3, 0)
        XCTAssertEqual(stateBeforeV3, .authenticating)
        XCTAssertFalse(beforeV3Messages.contains { message in
            if case .control = message { return true }
            return false
        })

        await fake.emit(.legacy(.welcome(makeWelcome())))
        await connectTask.value

        let postV3Probe = RequestCompletionProbe()
        let postV3Waiter = controlRequest(
            .killPane(PaneIDControlRequest(requestID: "post-v3", paneID: "pane")),
            on: composition.requestClient,
            probe: postV3Probe
        )
        try await waitForPendingRequest(on: composition.requestClient)
        await fake.emit(.control(.ack(ControlAckResponse(requestID: "post-v3"))))

        let postV3Result = await postV3Waiter.value
        XCTAssertEqual(
            try postV3Result.get(),
            .ack(ControlAckResponse(requestID: "post-v3"))
        )
        let postV3Completed = await postV3Probe.isComplete
        XCTAssertTrue(postV3Completed)
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

    func testPairRegistersItsWaiterBeforeSendingAndReturnsPersistedHostBeforeSnapshot() async throws {
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

        let pairing = pairingResult(code: "123456", on: manager)
        try await waitForPairRequest(on: fake)

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
        let expectedHost = PairedHost(
            serverID: "server-1",
            serverName: "Host",
            endpoint: endpoint,
            clientID: "test-client",
            token: "paired-token"
        )
        XCTAssertEqual(persistedHosts, [expectedHost])
        let pairingResult = await pairing.value
        XCTAssertEqual(try pairingResult.get(), expectedHost)

        await fake.emit(.legacy(.pairAccepted(PairAcceptedPayload(token: "duplicate-token"))))
        for _ in 0..<100 { await Task.yield() }
        let hostsAfterDuplicate = try await composition.pairedHostStore.hosts()
        XCTAssertEqual(hostsAfterDuplicate, [expectedHost])
    }

    func testPairRequiresALiveNegotiatedConnection() async throws {
        let manager = makeComposition(transport: FakeTransport()).manager

        do {
            _ = try await manager.pair(code: "123456")
            XCTFail("Expected pairing without a connection to fail")
        } catch {
            XCTAssertEqual(error as? PairingError, .notConnected)
        }
    }

    func testPairRejectionReturnsReasonAndDoesNotPersist() async throws {
        let fake = FakeTransport()
        let composition = makeComposition(transport: fake)
        let connectTask = Task {
            await composition.manager.connect(to: testEndpoint())
        }
        try await waitForHello(on: fake)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await connectTask.value
        let pairing = pairingResult(code: "123456", on: composition.manager)
        try await waitForPairRequest(on: fake)
        await fake.emit(.legacy(.pairRejected(PairRejectedPayload(reason: "invalid code"))))

        let persistedHosts = try await composition.pairedHostStore.hosts()
        XCTAssertEqual(persistedHosts, [])
        do {
            _ = try await pairing.value.get()
            XCTFail("Expected the rejected pair request to fail")
        } catch {
            XCTAssertEqual(error as? PairingError, .rejected(reason: "invalid code"))
        }
    }

    func testPairDisconnectFailsWaiterAndLateAcceptanceCannotPersist() async throws {
        let fake = FakeTransport()
        let composition = makeComposition(transport: fake)
        let manager = composition.manager

        let firstConnect = Task { await manager.connect(to: testEndpoint()) }
        try await waitForHello(on: fake)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await firstConnect.value

        let firstPairing = pairingResult(code: "123456", on: manager)
        try await waitForPairRequest(on: fake)
        await manager.disconnect()
        do {
            _ = try await firstPairing.value.get()
            XCTFail("Expected disconnect to fail the pairing waiter")
        } catch {
            XCTAssertEqual(error as? PairingError, .connectionChanged)
        }

        let secondConnect = Task { await manager.connect(to: testEndpoint()) }
        try await waitForHello(on: fake, occurrence: 2)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await secondConnect.value
        let secondPairing = pairingResult(code: "654321", on: manager)
        try await waitForPairRequest(on: fake, occurrence: 2)

        await fake.emit(
            .legacy(.pairAccepted(PairAcceptedPayload(token: "stale-token"))),
            onConnection: 0
        )
        for _ in 0..<100 { await Task.yield() }
        let hostsBeforeActiveResponse = try await composition.pairedHostStore.hosts()
        XCTAssertEqual(hostsBeforeActiveResponse, [])

        await fake.emit(.legacy(.pairAccepted(PairAcceptedPayload(token: "fresh-token"))))
        let host = try await secondPairing.value.get()
        XCTAssertEqual(host.token, "fresh-token")
    }

    func testCancelledPairPoisonsGenerationUntilFreshReconnectAndLateAcceptanceCannotPersist() async throws {
        let fake = FakeTransport()
        let composition = makeComposition(transport: fake)
        let manager = composition.manager
        let connectTask = Task { await manager.connect(to: testEndpoint()) }
        try await waitForHello(on: fake)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await connectTask.value

        let pairing = pairingResult(code: "123456", on: manager)
        try await waitForPairRequest(on: fake)
        pairing.cancel()

        do {
            _ = try await pairing.value.get()
            XCTFail("Expected cancellation to fail the pairing waiter")
        } catch {
            XCTAssertEqual(error as? PairingError, .cancelled)
        }
        do {
            _ = try await manager.pair(code: "654321")
            XCTFail("Expected the poisoned connection to require a reconnect")
        } catch {
            XCTAssertEqual(error as? PairingError, .reconnectRequired)
        }
        let pairRequestsBeforeReconnect = await fake.sentMessages.filter {
            if case .legacy(.pair) = $0 { return true }
            return false
        }
        XCTAssertEqual(pairRequestsBeforeReconnect.count, 1)

        await fake.emit(.legacy(.pairAccepted(PairAcceptedPayload(token: "late-token"))))
        try await waitForDisconnectCount(1, on: fake)
        let persistedHosts = try await composition.pairedHostStore.hosts()
        XCTAssertEqual(persistedHosts, [])

        let reconnect = Task { await manager.connect(to: testEndpoint()) }
        try await waitForHello(on: fake, occurrence: 2)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await reconnect.value
        let freshPairing = pairingResult(code: "654321", on: manager)
        try await waitForPairRequest(on: fake, occurrence: 2)
        await fake.emit(
            .legacy(.pairAccepted(PairAcceptedPayload(token: "stale-token"))),
            onConnection: 0
        )
        for _ in 0..<100 { await Task.yield() }
        let hostsBeforeFreshAcceptance = try await composition.pairedHostStore.hosts()
        XCTAssertEqual(hostsBeforeFreshAcceptance, [])
        await fake.emit(.legacy(.pairAccepted(PairAcceptedPayload(token: "fresh-token"))))
        let freshResult = await freshPairing.value
        XCTAssertEqual(try freshResult.get().token, "fresh-token")
    }

    func testCancellationBeforeStoreCommitRevokesPersistenceAuthorization() async throws {
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
            hostReadiness: HostReadinessMachine(
                pairedHostStore: pairedHostStore,
                workspaceStore: workspaceStore
            ),
            clientID: "test-client",
            clientName: "Psyche Tests"
        )
        let connectTask = Task { await manager.connect(to: testEndpoint()) }
        try await waitForHello(on: fake)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await connectTask.value

        let pairing = pairingResult(code: "123456", on: manager)
        try await waitForPairRequest(on: fake)
        secureStore.blockNextRead()
        await fake.emit(.legacy(.pairAccepted(PairAcceptedPayload(token: "late-token"))))
        try await secureStore.waitUntilReadBegins()
        pairing.cancel()
        secureStore.releaseRead()
        let cancellation = await pairing.value

        do {
            _ = try cancellation.get()
            XCTFail("Expected cancellation to complete the pairing exactly once")
        } catch {
            XCTAssertEqual(error as? PairingError, .cancelled)
        }
        for _ in 0..<100 { await Task.yield() }
        let persistedHosts = try await pairedHostStore.hosts()
        XCTAssertEqual(persistedHosts, [])
    }

    func testStoreCancellationRetiresPairingGenerationBeforeFreshRecovery() async throws {
        let fake = FakeTransport()
        let secureStore = CancellationOnceSecureStore()
        let pairedHostStore = PairedHostStore(secureStore: secureStore)
        let requestClient = ControlRequestClient(transport: fake)
        let workspaceStore = WorkspaceStore(controlRequests: requestClient)
        let manager = ConnectionManager(
            transport: fake,
            workspaceStore: workspaceStore,
            requestClient: requestClient,
            pairedHostStore: pairedHostStore,
            hostReadiness: HostReadinessMachine(
                pairedHostStore: pairedHostStore,
                workspaceStore: workspaceStore
            ),
            clientID: "test-client",
            clientName: "Psyche Tests"
        )
        let firstConnect = Task { await manager.connect(to: testEndpoint()) }
        try await waitForHello(on: fake)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await firstConnect.value

        let firstPairing = pairingResult(code: "123456", on: manager)
        try await waitForPairRequest(on: fake)
        await fake.emit(.legacy(.pairAccepted(PairAcceptedPayload(token: "cancelled-token"))))
        let firstResult = await firstPairing.value
        do {
            _ = try firstResult.get()
            XCTFail("Expected store cancellation to fail pairing")
        } catch {
            // Host persistence now runs through readiness, which reports a
            // proven rollback rather than the store's own error identity.
            XCTAssertEqual(
                error as? ConnectionManagerError,
                .hostIdentityNotCommitted(CancellationError().localizedDescription)
            )
        }
        try await waitForDisconnectCount(1, on: fake)

        do {
            _ = try await manager.pair(code: "654321")
            XCTFail("Expected the retired generation to require reconnect")
        } catch {
            XCTAssertEqual(error as? PairingError, .reconnectRequired)
        }
        let pairRequestsBeforeRecovery = await fake.sentMessages.filter {
            if case .legacy(.pair) = $0 { return true }
            return false
        }
        XCTAssertEqual(pairRequestsBeforeRecovery.count, 1)

        await fake.emit(.legacy(.pairAccepted(PairAcceptedPayload(token: "late-token"))))
        for _ in 0..<100 { await Task.yield() }
        let disconnectCountAfterLateResponse = await fake.disconnectCount
        let hostsAfterLateResponse = try await pairedHostStore.hosts()
        XCTAssertEqual(disconnectCountAfterLateResponse, 1)
        XCTAssertEqual(hostsAfterLateResponse, [])

        let secondConnect = Task { await manager.connect(to: testEndpoint()) }
        try await waitForHello(on: fake, occurrence: 2)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await secondConnect.value
        let secondPairing = pairingResult(code: "654321", on: manager)
        try await waitForPairRequest(on: fake, occurrence: 2)
        await fake.emit(.legacy(.pairAccepted(PairAcceptedPayload(token: "fresh-token"))))
        let recovered = try await secondPairing.value.get()
        XCTAssertEqual(recovered.token, "fresh-token")
    }

    func testPairSendFailurePoisonsGenerationAndCleansUpBeforeRetry() async throws {
        let fake = FakeTransport()
        let transport = PairSendFailingTransport(base: fake)
        let manager = makeComposition(transport: transport).manager
        let connectTask = Task { await manager.connect(to: testEndpoint()) }
        try await waitForHello(on: fake)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await connectTask.value

        do {
            _ = try await manager.pair(code: "123456")
            XCTFail("Expected the pair send failure to surface")
        } catch {
            XCTAssertEqual(error as? FakeTransportError, .connectionFailed)
        }
        do {
            _ = try await manager.pair(code: "654321")
            XCTFail("Expected failed pairing to require reconnect")
        } catch {
            XCTAssertEqual(error as? PairingError, .reconnectRequired)
        }
        let pairRequests = await fake.sentMessages.filter {
            if case .legacy(.pair) = $0 { return true }
            return false
        }
        XCTAssertEqual(pairRequests, [])
        try await waitForDisconnectCount(1, on: fake)
    }

    func testPairRejectsConcurrentRequest() async throws {
        let fake = FakeTransport()
        let manager = makeComposition(transport: fake).manager
        let connectTask = Task { await manager.connect(to: testEndpoint()) }
        try await waitForHello(on: fake)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await connectTask.value

        let firstPairing = pairingResult(code: "123456", on: manager)
        try await waitForPairRequest(on: fake)
        do {
            _ = try await manager.pair(code: "654321")
            XCTFail("Expected concurrent pairing to be rejected")
        } catch {
            XCTAssertEqual(error as? PairingError, .alreadyInProgress)
        }
        firstPairing.cancel()
        _ = await firstPairing.value
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
            hostReadiness: HostReadinessMachine(
                pairedHostStore: pairedHostStore,
                workspaceStore: workspaceStore
            ),
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

        let pairing = pairingResult(code: "123456", on: manager)
        try await waitForPairRequest(on: fake)
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

        let pairingResult = await pairing.value
        do {
            _ = try pairingResult.get()
            XCTFail("Expected replacement connection to fail the retired pairing")
        } catch {
            XCTAssertEqual(error as? PairingError, .connectionChanged)
        }

        let persistedHosts = try await pairedHostStore.hosts()
        XCTAssertEqual(
            persistedHosts.map(\.token),
            ["original-token"],
            "The retired session's late acceptance must not replace the committed token"
        )
        XCTAssertEqual(persistedHosts.map(\.endpoint), [secondEndpoint])

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

    func testRestartReconnectsToTheLastSelectedHostNotTheFirstServerID() async throws {
        let secureStore = InMemorySecureStore()
        let seedStore = PairedHostStore(secureStore: secureStore)
        let alphabeticallyFirst = PairedHost(
            serverID: "server-a",
            serverName: "Host A",
            endpoint: HostEndpoint(
                host: "host-a.local",
                port: 5151,
                certificateFingerprint: testCertificateFingerprint
            ),
            clientID: "client-a",
            token: "token-a"
        )
        let selected = PairedHost(
            serverID: "server-z",
            serverName: "Host Z",
            endpoint: HostEndpoint(
                host: "host-z.local",
                port: 5252,
                certificateFingerprint: testCertificateFingerprint
            ),
            clientID: "client-z",
            token: "token-z"
        )
        try await seedStore.save(alphabeticallyFirst)
        try await seedStore.save(selected)

        let fake = FakeTransport()
        let restarted = makeComposition(
            transport: fake,
            clientID: "new-install-id",
            secureStore: secureStore
        )
        let connectTask = Task { await restarted.manager.connectToStoredHost() }
        try await waitForHello(on: fake)

        let attempts = await fake.connectionAttempts
        XCTAssertEqual(attempts, [selected.endpoint])
        let hello = await fake.sentMessages.compactMap { message -> HelloPayload? in
            guard case let .legacy(.hello(payload)) = message else { return nil }
            return payload
        }.first
        XCTAssertEqual(hello?.clientID, selected.clientID)
        XCTAssertEqual(hello?.token, selected.token)

        await fake.emit(.legacy(.welcome(makeWelcome(serverID: selected.serverID))))
        await connectTask.value
    }

    func testPreReadyTeardownPreservesPreviousSelectionForRestart() async throws {
        let secureStore = InMemorySecureStore()
        let previouslyReady = makeStoredHost()
        try await PairedHostStore(secureStore: secureStore).save(previouslyReady)
        let candidateEndpoint = HostEndpoint(
            host: "candidate.local",
            port: 5252,
            certificateFingerprint: testCertificateFingerprint
        )
        let firstTransport = FakeTransport()
        let firstLaunch = makeComposition(
            transport: firstTransport,
            secureStore: secureStore
        )

        let connect = Task {
            await firstLaunch.manager.connect(to: candidateEndpoint)
        }
        try await waitForHello(on: firstTransport)
        await firstTransport.emit(.legacy(.welcome(makeWelcome(serverID: "server-z"))))
        await connect.value
        let pairing = pairingResult(code: "123456", on: firstLaunch.manager)
        try await waitForPairRequest(on: firstTransport)
        await firstTransport.emit(.legacy(.pairAccepted(
            PairAcceptedPayload(token: "candidate-token")
        )))
        _ = try await pairing.value.get()

        let selectedBeforeTeardown = try await firstLaunch.pairedHostStore.selectedHost()
        XCTAssertEqual(selectedBeforeTeardown, previouslyReady)
        await firstLaunch.manager.disconnect()

        let restartTransport = FakeTransport()
        let restarted = makeComposition(
            transport: restartTransport,
            secureStore: secureStore
        )
        let reconnect = Task { await restarted.manager.connectToStoredHost() }
        try await waitForHello(on: restartTransport)
        let attempts = await restartTransport.connectionAttempts
        XCTAssertEqual(attempts, [previouslyReady.endpoint])
        await restartTransport.emit(.legacy(.welcome(
            makeWelcome(serverID: previouslyReady.serverID)
        )))
        await reconnect.value
    }

    func testPreReadySnapshotFailurePreservesPreviousSelection() async throws {
        let secureStore = InMemorySecureStore()
        let previouslyReady = makeStoredHost()
        try await PairedHostStore(secureStore: secureStore).save(previouslyReady)
        let candidateEndpoint = HostEndpoint(
            host: "candidate.local",
            port: 5252,
            certificateFingerprint: testCertificateFingerprint
        )
        let fake = FakeTransport()
        let composition = makeComposition(
            transport: fake,
            secureStore: secureStore,
            validateSnapshot: { _ in throw TestError.timedOut }
        )

        let connect = Task { await composition.manager.connect(to: candidateEndpoint) }
        try await waitForHello(on: fake)
        await fake.emit(.legacy(.welcome(makeWelcome(serverID: "server-z"))))
        await connect.value
        let pairing = pairingResult(code: "123456", on: composition.manager)
        try await waitForPairRequest(on: fake)
        await fake.emit(.legacy(.pairAccepted(
            PairAcceptedPayload(token: "candidate-token")
        )))
        _ = try await pairing.value.get()
        let snapshotID = try await waitForSnapshotRequest(on: fake)
        await fake.emit(.control(.workspaceSnapshot(MobileWorkspaceSnapshotResult(
            requestID: snapshotID,
            sequence: 1,
            workspace: makeWorkspace(revision: 1)
        ))))
        await composition.manager.waitForState(.failed(TestError.timedOut.localizedDescription))

        let selected = try await composition.pairedHostStore.selectedHost()
        XCTAssertEqual(selected, previouslyReady)
    }

    func testSameManagerReturnsToPreviouslyReadyHostAfterCandidateDisconnects() async throws {
        let secureStore = InMemorySecureStore()
        let previouslyReady = makeStoredHost()
        try await PairedHostStore(secureStore: secureStore).save(previouslyReady)
        let candidateEndpoint = HostEndpoint(
            host: "candidate.local",
            port: 5252,
            certificateFingerprint: testCertificateFingerprint
        )
        let fake = FakeTransport()
        let composition = makeComposition(
            transport: fake,
            secureStore: secureStore
        )

        try await reachReadyStoredHost(composition: composition, transport: fake)
        await composition.manager.disconnect()

        let candidateConnect = Task {
            await composition.manager.connect(to: candidateEndpoint)
        }
        try await waitForHello(on: fake, occurrence: 2)
        await fake.emit(.legacy(.welcome(makeWelcome(serverID: "server-z"))))
        await candidateConnect.value
        let pairing = pairingResult(code: "123456", on: composition.manager)
        try await waitForPairRequest(on: fake)
        await fake.emit(.legacy(.pairAccepted(
            PairAcceptedPayload(token: "candidate-token")
        )))
        _ = try await pairing.value.get()
        XCTAssertEqual(composition.hostReadiness.state, .hostCommitted)

        await composition.manager.disconnect()
        let fallback = Task { await composition.manager.connectToStoredHost() }
        try await waitForHello(on: fake, occurrence: 3)
        let attempts = await fake.connectionAttempts
        XCTAssertEqual(
            attempts,
            [previouslyReady.endpoint, candidateEndpoint, previouslyReady.endpoint]
        )
        await fake.emit(.legacy(.welcome(
            makeWelcome(serverID: previouslyReady.serverID)
        )))
        await fallback.value
    }

    func testDisconnectDuringReadyHostSelectionCannotLeaveReadinessLive() async throws {
        let secureStore = BlockingReadSecureStore()
        let previouslyReady = makeStoredHost()
        try await PairedHostStore(secureStore: secureStore).save(previouslyReady)
        let candidateEndpoint = HostEndpoint(
            host: "candidate.local",
            port: 5252,
            certificateFingerprint: testCertificateFingerprint
        )
        let fake = FakeTransport()
        let composition = makeComposition(
            transport: fake,
            secureStore: secureStore
        )

        try await reachReadyStoredHost(composition: composition, transport: fake)
        await composition.manager.disconnect()
        let candidateConnect = Task {
            await composition.manager.connect(to: candidateEndpoint)
        }
        try await waitForHello(on: fake, occurrence: 2)
        await fake.emit(.legacy(.welcome(makeWelcome(serverID: "server-z"))))
        await candidateConnect.value
        let pairing = pairingResult(code: "123456", on: composition.manager)
        try await waitForPairRequest(on: fake)
        await fake.emit(.legacy(.pairAccepted(
            PairAcceptedPayload(token: "candidate-token")
        )))
        _ = try await pairing.value.get()
        let snapshotID = try await waitForSnapshotRequest(on: fake, occurrence: 2)

        secureStore.blockNextRead()
        await fake.emit(.control(.workspaceSnapshot(MobileWorkspaceSnapshotResult(
            requestID: snapshotID,
            sequence: 1,
            workspace: makeWorkspace(revision: 2)
        ))))
        try await secureStore.waitUntilReadBegins(timeout: .seconds(2))

        XCTAssertEqual(composition.workspaceStore.workspace?.revision, 1)
        XCTAssertTrue(composition.workspaceStore.isStale)
        await composition.manager.disconnect()
        secureStore.releaseRead()
        for _ in 0..<100 {
            await Task.yield()
        }

        XCTAssertNotEqual(composition.hostReadiness.state, .ready)
        if case .live = composition.hostReadiness.presentation {
            XCTFail("Transport teardown must not leave the provisional workspace live")
        }
        let selected = try await composition.pairedHostStore.selectedHost()
        XCTAssertEqual(selected?.serverID, previouslyReady.serverID)
        XCTAssertEqual(selected?.endpoint, previouslyReady.endpoint)
    }

    func testSelectionMutationFailureKeepsPreviouslyReadyWorkspace() async throws {
        let secureStore = FailableWriteSecureStore()
        let previouslyReady = makeStoredHost()
        try await PairedHostStore(secureStore: secureStore).save(previouslyReady)
        let candidateEndpoint = HostEndpoint(
            host: "candidate.local",
            port: 5252,
            certificateFingerprint: testCertificateFingerprint
        )
        let fake = FakeTransport()
        let composition = makeComposition(
            transport: fake,
            secureStore: secureStore
        )

        try await reachReadyStoredHost(composition: composition, transport: fake)
        await composition.manager.disconnect()
        let candidateConnect = Task {
            await composition.manager.connect(to: candidateEndpoint)
        }
        try await waitForHello(on: fake, occurrence: 2)
        await fake.emit(.legacy(.welcome(makeWelcome(serverID: "server-z"))))
        await candidateConnect.value
        let pairing = pairingResult(code: "123456", on: composition.manager)
        try await waitForPairRequest(on: fake)
        await fake.emit(.legacy(.pairAccepted(
            PairAcceptedPayload(token: "candidate-token")
        )))
        _ = try await pairing.value.get()
        let snapshotID = try await waitForSnapshotRequest(on: fake, occurrence: 2)
        secureStore.setBehavior(.mutateThenFailWrite)

        await fake.emit(.control(.workspaceSnapshot(MobileWorkspaceSnapshotResult(
            requestID: snapshotID,
            sequence: 1,
            workspace: makeWorkspace(revision: 2)
        ))))
        try await waitForDisconnectCount(2, on: fake)

        XCTAssertEqual(composition.workspaceStore.workspace?.revision, 1)
        XCTAssertTrue(composition.workspaceStore.isStale)
        let selected = try await composition.pairedHostStore.selectedHost()
        XCTAssertEqual(selected?.serverID, previouslyReady.serverID)
        XCTAssertEqual(selected?.endpoint, previouslyReady.endpoint)
    }

    func testIndeterminateSelectionMutationNeverPublishesCandidateWorkspace() async throws {
        let secureStore = FailableWriteSecureStore()
        let previouslyReady = makeStoredHost()
        try await PairedHostStore(secureStore: secureStore).save(previouslyReady)
        let candidateEndpoint = HostEndpoint(
            host: "candidate.local",
            port: 5252,
            certificateFingerprint: testCertificateFingerprint
        )
        let fake = FakeTransport()
        let composition = makeComposition(
            transport: fake,
            secureStore: secureStore
        )

        try await reachReadyStoredHost(composition: composition, transport: fake)
        await composition.manager.disconnect()
        let candidateConnect = Task {
            await composition.manager.connect(to: candidateEndpoint)
        }
        try await waitForHello(on: fake, occurrence: 2)
        await fake.emit(.legacy(.welcome(makeWelcome(serverID: "server-z"))))
        await candidateConnect.value
        let pairing = pairingResult(code: "123456", on: composition.manager)
        try await waitForPairRequest(on: fake)
        await fake.emit(.legacy(.pairAccepted(
            PairAcceptedPayload(token: "candidate-token")
        )))
        _ = try await pairing.value.get()
        let snapshotID = try await waitForSnapshotRequest(on: fake, occurrence: 2)
        secureStore.setBehavior(.mutateThenFailWriteAndCompensation)

        await fake.emit(.control(.workspaceSnapshot(MobileWorkspaceSnapshotResult(
            requestID: snapshotID,
            sequence: 1,
            workspace: makeWorkspace(revision: 2)
        ))))
        try await waitForDisconnectCount(2, on: fake)

        XCTAssertEqual(composition.workspaceStore.workspace?.revision, 1)
        XCTAssertTrue(composition.workspaceStore.isStale)
        XCTAssertEqual(composition.hostReadiness.state, .revoked)
        if case .live(let hostID, _) = composition.hostReadiness.presentation {
            XCTFail("Indeterminate selection must not leave \(hostID) live")
        }
    }

    func testPairOverridePersistsAndReconnectsWithRequestIdentityAndToken() async throws {
        let fake = FakeTransport()
        let composition = makeComposition(
            transport: fake,
            clientID: "default-client-b",
            clientName: "Default Device B"
        )
        let manager = composition.manager

        let initialConnect = Task { await manager.connect(to: testEndpoint()) }
        try await waitForHello(on: fake)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await initialConnect.value

        let pairing = pairingResult(
            code: "123456",
            clientID: "override-client-a",
            clientName: "Override Device A",
            on: manager
        )
        try await waitForPairRequest(on: fake)
        let firstPairRequest = await fake.sentMessages.compactMap { message -> PairRequestPayload? in
            guard case let .legacy(.pair(payload)) = message else { return nil }
            return payload
        }.last
        XCTAssertEqual(
            firstPairRequest,
            PairRequestPayload(
                code: "123456",
                clientID: "override-client-a",
                clientName: "Override Device A"
            )
        )

        await fake.emit(.legacy(.pairAccepted(PairAcceptedPayload(token: "issued-token"))))
        let paired = try await pairing.value.get()
        XCTAssertEqual(paired.clientID, "override-client-a")
        XCTAssertEqual(paired.token, "issued-token")
        let persistedHosts = try await composition.pairedHostStore.hosts()
        XCTAssertEqual(persistedHosts, [paired])
        let snapshotID = try await waitForSnapshotRequest(on: fake)
        await fake.emit(.control(.workspaceSnapshot(MobileWorkspaceSnapshotResult(
            requestID: snapshotID,
            sequence: 1,
            workspace: makeWorkspace(revision: 1)
        ))))
        await manager.waitForEventDrain(after: 3)
        XCTAssertEqual(composition.hostReadiness.state, .ready)

        let followUpPairing = pairingResult(code: "654321", on: manager)
        try await waitForPairRequest(on: fake, occurrence: 2)
        let followUpRequest = await fake.sentMessages.compactMap { message -> PairRequestPayload? in
            guard case let .legacy(.pair(payload)) = message else { return nil }
            return payload
        }.last
        XCTAssertEqual(followUpRequest?.clientID, "override-client-a")
        await fake.emit(.legacy(.pairRejected(PairRejectedPayload(reason: "not needed"))))
        _ = await followUpPairing.value

        await manager.disconnect()
        let storedReconnect = Task { await manager.connectToStoredHost() }
        try await waitForHello(on: fake, occurrence: 2)
        let reconnectHello = await fake.sentMessages.compactMap { message -> HelloPayload? in
            guard case let .legacy(.hello(payload)) = message else { return nil }
            return payload
        }.last
        XCTAssertEqual(reconnectHello?.clientID, "override-client-a")
        XCTAssertEqual(reconnectHello?.token, "issued-token")
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await storedReconnect.value
    }

    func testReissuedCredentialsSurviveRestartAsOneBinding() async throws {
        let secureStore = InMemorySecureStore()
        let stored = makeStoredHost()
        try await PairedHostStore(secureStore: secureStore).save(stored)
        let firstTransport = FakeTransport()
        let firstLaunch = makeComposition(
            transport: firstTransport,
            clientID: "unused-install-id",
            secureStore: secureStore
        )

        let initialConnect = Task { await firstLaunch.manager.connectToStoredHost() }
        try await waitForHello(on: firstTransport)
        await firstTransport.emit(.legacy(.welcome(makeWelcome(serverID: stored.serverID))))
        await initialConnect.value

        let pairing = pairingResult(
            code: "123456",
            clientID: "reissued-client-id",
            on: firstLaunch.manager
        )
        try await waitForPairRequest(on: firstTransport)
        await firstTransport.emit(.legacy(.pairAccepted(
            PairAcceptedPayload(token: "reissued-token")
        )))
        let paired = try await pairing.value.get()
        XCTAssertEqual(paired.clientID, "reissued-client-id")
        XCTAssertEqual(paired.token, "reissued-token")
        await firstLaunch.manager.disconnect()

        let restartedTransport = FakeTransport()
        let restarted = makeComposition(
            transport: restartedTransport,
            clientID: "another-install-id",
            secureStore: secureStore
        )
        let reconnect = Task { await restarted.manager.connectToStoredHost() }
        try await waitForHello(on: restartedTransport)
        let hello = await restartedTransport.sentMessages.compactMap {
            message -> HelloPayload? in
            guard case let .legacy(.hello(payload)) = message else { return nil }
            return payload
        }.first
        XCTAssertEqual(hello?.clientID, "reissued-client-id")
        XCTAssertEqual(hello?.token, "reissued-token")

        await restartedTransport.emit(.legacy(.welcome(
            makeWelcome(serverID: stored.serverID)
        )))
        await reconnect.value
    }

    func testIndeterminateCredentialReissueRevokesReadinessAndFailsClosed() async throws {
        let secureStore = FailableWriteSecureStore()
        let stored = makeStoredHost()
        try await PairedHostStore(secureStore: secureStore).save(stored)
        let fake = FakeTransport()
        let composition = makeComposition(
            transport: fake,
            clientID: "unused-install-id",
            secureStore: secureStore
        )

        let connect = Task { await composition.manager.connectToStoredHost() }
        try await waitForHello(on: fake)
        await fake.emit(.legacy(.welcome(makeWelcome(serverID: stored.serverID))))
        await connect.value

        secureStore.setBehavior(.failWriteAndCompensation)
        let pairing = pairingResult(
            code: "123456",
            clientID: "reissued-client-id",
            on: composition.manager
        )
        try await waitForPairRequest(on: fake)
        await fake.emit(.legacy(.pairAccepted(
            PairAcceptedPayload(token: "reissued-token")
        )))

        let expectedFailure: ConnectionState
        do {
            _ = try await pairing.value.get()
            XCTFail("An indeterminate credential write must not report pairing success")
            expectedFailure = .failed("Pairing unexpectedly succeeded")
        } catch {
            guard case .hostIdentityIndeterminate = error as? ConnectionManagerError else {
                return XCTFail("Expected fail-closed indeterminate state, got \(error)")
            }
            expectedFailure = .failed(error.localizedDescription)
        }
        await composition.manager.waitForState(expectedFailure)
        XCTAssertEqual(composition.hostReadiness.state, .revoked)
        let state = await composition.manager.state
        guard case .failed = state else {
            return XCTFail("Indeterminate credentials must tear down the connection, got \(state)")
        }
    }

    func testStoredHostLookupCannotOverrideManualConnectCredentials() async throws {
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
            hostReadiness: HostReadinessMachine(
                pairedHostStore: pairedHostStore,
                workspaceStore: workspaceStore
            ),
            clientID: "manual-client",
            clientName: "Psyche Tests"
        )
        let stored = PairedHost(
            serverID: "server-a",
            serverName: "Stored Host A",
            endpoint: HostEndpoint(
                host: "host-a.local",
                port: 5151,
                certificateFingerprint: testCertificateFingerprint
            ),
            clientID: "host-a-client",
            token: "host-a-token"
        )
        let manualEndpoint = HostEndpoint(
            host: "host-b.local",
            port: 5252,
            certificateFingerprint: testCertificateFingerprint
        )
        try await pairedHostStore.save(stored)

        secureStore.blockNextRead()
        let storedConnect = Task {
            await manager.connectToStoredHost()
        }
        try await secureStore.waitUntilReadBegins()

        let firstManualConnect = Task {
            await manager.connect(to: manualEndpoint)
        }
        try await waitForHello(on: fake)
        secureStore.releaseRead()
        await storedConnect.value
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await firstManualConnect.value
        await manager.disconnect()

        let secondManualConnect = Task {
            await manager.connect(to: manualEndpoint)
        }
        try await waitForHello(on: fake, occurrence: 2)

        let attempts = await fake.connectionAttempts
        XCTAssertEqual(attempts, [manualEndpoint, manualEndpoint])
        let hellos = await fake.sentMessages.compactMap { message -> HelloPayload? in
            guard case let .legacy(.hello(payload)) = message else { return nil }
            return payload
        }
        XCTAssertEqual(hellos.map(\.clientID), ["manual-client", "manual-client"])
        XCTAssertEqual(hellos.map(\.token), [nil, nil])

        await fake.emit(.legacy(.welcome(makeWelcome())))
        await secondManualConnect.value
        await manager.disconnect()
    }

    func testDisconnectDuringStoredHostLookupPreventsStaleConnect() async throws {
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
            hostReadiness: HostReadinessMachine(
                pairedHostStore: pairedHostStore,
                workspaceStore: workspaceStore
            ),
            clientID: "new-install-id",
            clientName: "Psyche Tests"
        )
        let stored = PairedHost(
            serverID: "server-a",
            serverName: "Stored Host A",
            endpoint: HostEndpoint(
                host: "host-a.local",
                port: 5151,
                certificateFingerprint: testCertificateFingerprint
            ),
            clientID: "host-a-client",
            token: "host-a-token"
        )
        try await pairedHostStore.save(stored)

        secureStore.blockNextRead()
        let completionProbe = RequestCompletionProbe()
        let storedConnect = Task {
            await manager.connectToStoredHost()
            await completionProbe.markComplete()
        }
        try await secureStore.waitUntilReadBegins()

        await manager.disconnect()
        secureStore.releaseRead()
        try await waitForConnectCompletionOrAttempt(
            probe: completionProbe,
            transport: fake,
            attemptCount: 1
        )
        if await fake.connectionAttempts.isEmpty == false {
            try await waitForHello(on: fake)
            await fake.emit(.legacy(.welcome(makeWelcome())))
        }
        await storedConnect.value

        let attempts = await fake.connectionAttempts
        let messages = await fake.sentMessages
        let state = await manager.state
        XCTAssertTrue(attempts.isEmpty)
        XCTAssertTrue(messages.isEmpty)
        XCTAssertEqual(state, .disconnected)

        await manager.disconnect()
    }

    func testDisconnectDuringReadinessFlowPublicationDoesNotOrphanTheFlow() async throws {
        let gate = MessageProcessorStartGate()
        let firstTransport = FakeTransport()
        let composition = makeComposition(
            transport: firstTransport,
            readinessFlowPublicationStart: gate.wait
        )

        let retiredConnect = Task {
            await composition.manager.connect(to: testEndpoint())
        }
        await gate.waitUntilEntered()
        await composition.manager.disconnect()
        await gate.release()
        await retiredConnect.value

        XCTAssertNil(composition.hostReadiness.activeFlow)
        XCTAssertEqual(composition.hostReadiness.state, .unknown)

        let replacementConnect = Task {
            await composition.manager.connect(to: testEndpoint())
        }
        try await waitForHello(on: firstTransport)
        await firstTransport.emit(.legacy(.welcome(makeWelcome())))
        await replacementConnect.value

        let attempts = await firstTransport.connectionAttempts
        XCTAssertEqual(attempts, [testEndpoint()])
        await composition.manager.disconnect()
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

    func testBlockingSecureStoreWaitTimesOutWhenNoReadBegins() async {
        let secureStore = BlockingReadSecureStore()

        secureStore.blockNextRead()

        do {
            try await secureStore.waitUntilReadBegins(timeout: .milliseconds(20))
            XCTFail("Expected the bounded read gate to time out")
        } catch let error as BoundedAsyncSignal.WaitError {
            XCTAssertEqual(error, .timedOut("connection manager secure-store read to begin"))
        } catch {
            XCTFail("Expected WaitError.timedOut, got \(error)")
        }
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
        do {
            _ = try await composition.requestClient.send(.killPane(PaneIDControlRequest(
                requestID: "disconnect-during-connect",
                paneID: "pane"
            )))
            XCTFail("A request during transport connect must fail before transmission")
        } catch {
            XCTAssertEqual(error as? ControlRequestError, .disconnected)
        }

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

    func testReconnectWaitsForPriorDisconnectTeardown() async throws {
        let fake = FakeTransport()
        let transport = SuspendedDisconnectTransport(base: fake)
        let manager = makeComposition(transport: transport, token: "token").manager

        let firstConnect = Task {
            await manager.connect(to: testEndpoint())
        }
        try await waitForHello(on: fake)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await firstConnect.value

        let disconnect = Task {
            await manager.disconnect()
        }
        await transport.waitUntilDisconnectSuspends()

        let reconnectProbe = RequestCompletionProbe()
        let reconnect = Task {
            await manager.connect(to: testEndpoint())
            await reconnectProbe.markComplete()
        }
        for _ in 0..<100 {
            await Task.yield()
        }

        let attemptsDuringTeardown = await fake.connectionAttempts
        let reconnectCompletedDuringTeardown = await reconnectProbe.isComplete
        XCTAssertEqual(attemptsDuringTeardown.count, 1)
        XCTAssertFalse(reconnectCompletedDuringTeardown)

        await transport.releaseDisconnect()
        await disconnect.value
        try await waitForHello(on: fake, occurrence: 2)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await reconnect.value

        let state = await manager.state
        let isConnected = await fake.isConnected
        let attempts = await fake.connectionAttempts
        let disconnectCount = await fake.disconnectCount
        XCTAssertEqual(state, .connected)
        XCTAssertTrue(isConnected)
        XCTAssertEqual(attempts.count, 2)
        XCTAssertEqual(disconnectCount, 1)
    }

    func testDisconnectInvalidatesConnectWaitingForPriorTeardown() async throws {
        let fake = FakeTransport()
        let transport = SuspendedDisconnectTransport(base: fake)
        let manager = makeComposition(transport: transport, token: "token").manager

        let firstConnect = Task {
            await manager.connect(to: testEndpoint())
        }
        try await waitForHello(on: fake)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await firstConnect.value

        let firstDisconnect = Task {
            await manager.disconnect()
        }
        await transport.waitUntilDisconnectSuspends()

        let waitingConnectProbe = RequestCompletionProbe()
        let waitingConnect = Task {
            await manager.connect(to: testEndpoint())
            await waitingConnectProbe.markComplete()
        }
        for _ in 0..<100 {
            await Task.yield()
        }
        let attemptsWhileWaiting = await fake.connectionAttempts.count
        XCTAssertEqual(attemptsWhileWaiting, 1)

        let secondDisconnect = Task {
            await manager.disconnect()
        }
        try await waitForDisconnectingTransitions(2, in: manager)

        await transport.releaseDisconnect()
        await firstDisconnect.value
        await secondDisconnect.value
        try await waitForConnectCompletionOrAttempt(
            probe: waitingConnectProbe,
            transport: fake,
            attemptCount: 2
        )

        let attemptsAfterTeardown = await fake.connectionAttempts.count
        if attemptsAfterTeardown > 1 {
            await fake.emit(.legacy(.welcome(makeWelcome())))
        }
        await waitingConnect.value

        XCTAssertEqual(
            attemptsAfterTeardown,
            1,
            "The disconnect intent must invalidate the connect waiting behind teardown"
        )
        guard attemptsAfterTeardown == 1 else {
            await manager.disconnect()
            return
        }

        let laterConnect = Task {
            await manager.connect(to: testEndpoint())
        }
        try await waitForHello(on: fake, occurrence: 2)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await laterConnect.value

        let finalAttempts = await fake.connectionAttempts.count
        let finalState = await manager.state
        XCTAssertEqual(finalAttempts, 2)
        XCTAssertEqual(finalState, .connected)
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
        do {
            _ = try await composition.requestClient.send(.killPane(PaneIDControlRequest(
                requestID: "cancel-during-connect",
                paneID: "pane"
            )))
            XCTFail("A request during transport connect must fail before transmission")
        } catch {
            XCTAssertEqual(error as? ControlRequestError, .disconnected)
        }

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
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await connectTask.value
        let pairing = pairingResult(code: "123456", on: manager)
        try? await waitForPairRequest(on: fake)

        let sent = await fake.sentMessages
        guard requireCount(sent, 2, "pair defaults") else { return }
        guard case let .legacy(.pair(payload)) = sent[1] else {
            return XCTFail("Expected typed pair request")
        }
        XCTAssertEqual(payload.clientID, "ios-device")
        XCTAssertEqual(payload.clientName, "Psyche Tests")
        await fake.emit(.legacy(.pairRejected(PairRejectedPayload(reason: "test"))))
        _ = await pairing.value
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

    func testCorrelatedAckForRecoverySnapshotFailsConnection() async throws {
        let fake = FakeTransport()
        let composition = makeComposition(transport: fake, token: "token")
        let manager = composition.manager

        let connectTask = Task {
            await manager.connect(to: testEndpoint())
        }
        try await waitForHello(on: fake)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await connectTask.value
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
        let recoveryID = try await waitForSnapshotRequest(on: fake, occurrence: 2)
        await fake.emit(.control(.ack(ControlAckResponse(requestID: recoveryID))))

        let failure = await waitForFailure(in: manager)
        let isConnected = await fake.isConnected
        let pendingRequestCount = await composition.requestClient.pendingRequestCount
        XCTAssertEqual(
            failure,
            ConnectionManagerError.unexpectedSnapshotResponse(recoveryID).localizedDescription
        )
        XCTAssertFalse(isConnected)
        XCTAssertTrue(composition.workspaceStore.isStale)
        XCTAssertEqual(pendingRequestCount, 0)
    }

    func testCorrelatedAckClaimsRecoveryBeforeBackToBackSnapshotCanApply() async throws {
        let fake = FakeTransport()
        let failureGate = MessageProcessorStartGate()
        let composition = makeComposition(
            transport: fake,
            token: "token",
            snapshotRequestFailureStart: failureGate.wait
        )
        let manager = composition.manager

        let connectTask = Task {
            await manager.connect(to: testEndpoint())
        }
        try await waitForHello(on: fake)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await connectTask.value
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
        let recoveryID = try await waitForSnapshotRequest(on: fake, occurrence: 2)
        await fake.emitBackToBack([
            .control(.ack(ControlAckResponse(requestID: recoveryID))),
            .control(.workspaceSnapshot(MobileWorkspaceSnapshotResult(
                requestID: recoveryID,
                sequence: 99,
                workspace: makeWorkspace(revision: 99)
            )))
        ])

        await failureGate.waitUntilEntered()
        await manager.waitForEventDrain(after: 4)
        for _ in 0..<100 {
            await Task.yield()
        }
        XCTAssertEqual(composition.workspaceStore.workspace?.revision, 1)
        XCTAssertTrue(composition.workspaceStore.isStale)

        await failureGate.release()
        let failure = await waitForFailure(in: manager)
        XCTAssertEqual(
            failure,
            ConnectionManagerError.unexpectedSnapshotResponse(recoveryID).localizedDescription
        )
        let isConnected = await fake.isConnected
        let disconnectCount = await fake.disconnectCount
        XCTAssertFalse(isConnected)
        XCTAssertEqual(disconnectCount, 1)
    }

    func testCorrelatedOtherResponseForRecoverySnapshotFailsAndCanReconnect() async throws {
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
        let recoveryID = try await waitForSnapshotRequest(on: fake, occurrence: 2)
        await fake.emit(.control(.unknown(UnknownControlResponse(
            type: "future.success",
            requestID: recoveryID
        ))))

        let failure = await waitForFailure(in: manager)
        XCTAssertEqual(
            failure,
            ConnectionManagerError.unexpectedSnapshotResponse(recoveryID).localizedDescription
        )

        let secondConnect = Task {
            await manager.connect(to: testEndpoint())
        }
        try await waitForHello(on: fake, occurrence: 2)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await secondConnect.value
        _ = try await waitForSnapshotRequest(on: fake, occurrence: 3)

        let attemptCount = await fake.connectionAttempts.count
        let snapshotRequestCount = await fake.sentMessages
            .filter(\.isWorkspaceSnapshotRequest)
            .count
        XCTAssertEqual(attemptCount, 2)
        XCTAssertEqual(snapshotRequestCount, 3)
        await manager.disconnect()
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

    // MARK: - Host readiness composition (issue #241)

    func testStoredHostReconnectCommitsIdentityBeforeAnyWorkspaceBecomesVisible() async throws {
        let fake = FakeTransport()
        let composition = makeComposition(transport: fake, clientID: "install-id")
        let stored = makeStoredHost()
        try await composition.pairedHostStore.save(stored)

        let connectTask = Task { await composition.manager.connectToStoredHost() }
        try await waitForHello(on: fake)
        await fake.emit(.legacy(.welcome(makeWelcome(serverID: "server-1"))))
        await connectTask.value

        XCTAssertEqual(composition.hostReadiness.state, .hostCommitted)
        XCTAssertNil(
            composition.workspaceStore.workspace,
            "No workspace may be visible before one is accepted for the committed host"
        )

        let snapshotID = try await waitForSnapshotRequest(on: fake)
        await fake.emit(.control(.workspaceSnapshot(MobileWorkspaceSnapshotResult(
            requestID: snapshotID,
            sequence: 1,
            workspace: makeWorkspace(revision: 1)
        ))))
        await composition.manager.waitForEventDrain(after: 2)

        XCTAssertEqual(composition.hostReadiness.state, .ready)
        XCTAssertEqual(composition.workspaceStore.workspace?.revision, 1)
        XCTAssertFalse(composition.workspaceStore.isStale)
        guard case let .live(hostID, _) = composition.hostReadiness.presentation else {
            return XCTFail("An accepted workspace must present as live")
        }
        XCTAssertEqual(hostID, "server-1")
    }

    func testStoredHostReconnectFailsClosedWhenAnotherHostAnswers() async throws {
        let fake = FakeTransport()
        let composition = makeComposition(transport: fake, clientID: "install-id")
        let stored = makeStoredHost()
        try await composition.pairedHostStore.save(stored)

        let connectTask = Task { await composition.manager.connectToStoredHost() }
        try await waitForHello(on: fake)
        await fake.emit(.legacy(.welcome(makeWelcome(serverID: "server-2"))))
        await connectTask.value

        XCTAssertEqual(composition.hostReadiness.state, .revoked)
        XCTAssertNil(composition.workspaceStore.workspace)
        XCTAssertEqual(composition.hostReadiness.committedHost?.serverID, "server-1")
        let snapshotRequests = await fake.sentMessages
            .filter(\.isWorkspaceSnapshotRequest)
        XCTAssertEqual(
            snapshotRequests.count,
            0,
            "A wrong-host connection must never reach the point of asking for state"
        )
        let persistedHosts = try await composition.pairedHostStore.hosts()
        XCTAssertEqual(persistedHosts, [stored])
        let state = await composition.manager.state
        guard case .failed = state else {
            return XCTFail("A wrong-host welcome must fail the connection, got \(state)")
        }    }

    func testStoredHostReconnectIsRefusedWhileReadinessIsRevoked() async throws {
        let fake = FakeTransport()
        let composition = makeComposition(transport: fake, clientID: "install-id")
        try await composition.pairedHostStore.save(makeStoredHost())

        let connectTask = Task { await composition.manager.connectToStoredHost() }
        try await waitForHello(on: fake)
        await fake.emit(.legacy(.welcome(makeWelcome(serverID: "server-2"))))
        await connectTask.value
        XCTAssertEqual(composition.hostReadiness.state, .revoked)

        await composition.manager.disconnect()
        await composition.manager.connectToStoredHost()

        XCTAssertEqual(composition.hostReadiness.state, .revoked)
        let attempts = await fake.connectionAttempts
        XCTAssertEqual(
            attempts.count,
            1,
            "Revoked trust must not silently reconnect to the stored host"
        )
        let state = await composition.manager.state
        guard case .failed = state else {
            return XCTFail("A refused readiness flow must fail the connection, got \(state)")
        }
    }

    func testFailedNewHostPairingLeavesThePreviousWorkspaceStaleNotLive() async throws {
        let fake = FakeTransport()
        let secureStore = FailableWriteSecureStore()
        let composition = makeComposition(
            transport: fake,
            clientID: "install-id",
            secureStore: secureStore
        )
        let stored = makeStoredHost()
        try await composition.pairedHostStore.save(stored)
        try await reachReadyStoredHost(composition: composition, transport: fake)

        let newHostEndpoint = HostEndpoint(
            host: "new-host.local",
            port: 4343,
            certificateFingerprint: testCertificateFingerprint
        )
        let connectTask = Task { await composition.manager.connect(to: newHostEndpoint) }
        try await waitForHello(on: fake, occurrence: 2)
        await fake.emit(.legacy(.welcome(makeWelcome(serverID: "server-2"))))
        await connectTask.value

        XCTAssertEqual(composition.workspaceStore.workspace?.revision, 1)
        XCTAssertTrue(
            composition.workspaceStore.isStale,
            "Retargeting the transport must relabel the visible workspace"
        )

        secureStore.setBehavior(.failWrite)
        let pairing = pairingResult(code: "123456", on: composition.manager)
        try await waitForPairRequest(on: fake)
        await fake.emit(.legacy(.pairAccepted(PairAcceptedPayload(token: "new-token"))))
        let pairingOutcome = await pairing.value

        do {
            _ = try pairingOutcome.get()
            XCTFail("A refused secure-store write must fail pairing")
        } catch {
            guard case .hostIdentityNotCommitted = error as? ConnectionManagerError else {
                return XCTFail("Expected a proven rollback, got \(error)")
            }
        }
        XCTAssertEqual(composition.hostReadiness.state, .degraded)
        XCTAssertEqual(
            composition.hostReadiness.committedHost?.serverID,
            "server-1",
            "A failed new host must not become the committed authority"
        )
        XCTAssertEqual(
            composition.workspaceStore.workspace?.revision,
            1,
            "The previously authoritative workspace must survive the failure"
        )
        XCTAssertTrue(composition.workspaceStore.isStale)
        guard case let .stale(hostID, _) = composition.hostReadiness.presentation else {
            return XCTFail(
                "Preserved state must present as stale, got \(composition.hostReadiness.presentation)"
            )
        }
        XCTAssertEqual(hostID, "server-1")
        let survivingHosts = try await composition.pairedHostStore.hosts()
        XCTAssertEqual(survivingHosts.map(\.serverID), ["server-1"])
    }

    func testIndeterminateHostCommitFailsClosedWithNoVisibleWorkspace() async throws {
        let fake = FakeTransport()
        let secureStore = FailableWriteSecureStore()
        let composition = makeComposition(transport: fake, secureStore: secureStore)

        let connectTask = Task { await composition.manager.connect(to: testEndpoint()) }
        try await waitForHello(on: fake)
        await fake.emit(.legacy(.welcome(makeWelcome())))
        await connectTask.value

        secureStore.setBehavior(.failWriteAndCompensation)
        let pairing = pairingResult(code: "123456", on: composition.manager)
        try await waitForPairRequest(on: fake)
        await fake.emit(.legacy(.pairAccepted(PairAcceptedPayload(token: "new-token"))))
        let pairingOutcome = await pairing.value

        do {
            _ = try pairingOutcome.get()
            XCTFail("An unverifiable secure-store write must fail pairing")
        } catch {
            guard case .hostIdentityIndeterminate = error as? ConnectionManagerError else {
                return XCTFail("Expected an indeterminate commit, got \(error)")
            }
        }
        XCTAssertEqual(composition.hostReadiness.state, .revoked)
        XCTAssertNil(composition.hostReadiness.committedHost)
        XCTAssertNil(composition.workspaceStore.workspace)
        XCTAssertEqual(composition.hostReadiness.presentation, .noState)
    }

    func testConnectionLossAfterReadyKeepsTheWorkspaceVisibleButStale() async throws {
        let fake = FakeTransport()
        let composition = makeComposition(transport: fake, clientID: "install-id")
        try await composition.pairedHostStore.save(makeStoredHost())
        try await reachReadyStoredHost(composition: composition, transport: fake)

        await composition.manager.disconnect()

        XCTAssertEqual(composition.hostReadiness.state, .reconnecting)
        XCTAssertEqual(composition.workspaceStore.workspace?.revision, 1)
        XCTAssertTrue(composition.workspaceStore.isStale)
        guard case let .stale(hostID, _) = composition.hostReadiness.presentation else {
            return XCTFail(
                "Offline state must present as stale, got \(composition.hostReadiness.presentation)"
            )
        }
        XCTAssertEqual(hostID, "server-1")
    }

    private func makeStoredHost() -> PairedHost {
        PairedHost(
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
    }

    /// Drives a stored host all the way to `ready` so a test can start from
    /// state that is genuinely authoritative rather than merely present.
    private func reachReadyStoredHost(
        composition: TestComposition,
        transport fake: FakeTransport,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws {
        let connectTask = Task { await composition.manager.connectToStoredHost() }
        try await waitForHello(on: fake)
        await fake.emit(.legacy(.welcome(makeWelcome(serverID: "server-1"))))
        await connectTask.value
        let snapshotID = try await waitForSnapshotRequest(on: fake)
        await fake.emit(.control(.workspaceSnapshot(MobileWorkspaceSnapshotResult(
            requestID: snapshotID,
            sequence: 1,
            workspace: makeWorkspace(revision: 1)
        ))))
        await composition.manager.waitForEventDrain(after: 2)
        XCTAssertEqual(composition.hostReadiness.state, .ready, file: file, line: line)
    }

    private func makeComposition(
        transport: any PsycheTransport,
        clientID: String = "test-client",
        clientName: String = "Psyche Tests",
        token: String? = nil,
        secureStore: any SecureStore = InMemorySecureStore(),
        messageProcessorStart: @escaping @Sendable () async -> Void = {},
        snapshotRequestFailureStart: @escaping @Sendable () async -> Void = {},
        readinessFlowPublicationStart: @escaping @Sendable () async -> Void = {},
        validateSnapshot: @escaping @Sendable (
            HostReadinessSnapshotCandidate
        ) async throws -> Void = { _ in }
    ) -> TestComposition {
        let requestClient = ControlRequestClient(transport: transport)
        let workspaceStore = WorkspaceStore(controlRequests: requestClient)
        let pairedHostStore = PairedHostStore(secureStore: secureStore)
        let hostReadiness = HostReadinessMachine(
            pairedHostStore: pairedHostStore,
            workspaceStore: workspaceStore,
            validateSnapshot: validateSnapshot
        )
        let manager = ConnectionManager(
            transport: transport,
            workspaceStore: workspaceStore,
            requestClient: requestClient,
            pairedHostStore: pairedHostStore,
            hostReadiness: hostReadiness,
            clientID: clientID,
            clientName: clientName,
            token: token,
            messageProcessorStart: messageProcessorStart,
            snapshotRequestFailureStart: snapshotRequestFailureStart,
            readinessFlowPublicationStart: readinessFlowPublicationStart
        )
        XCTAssertTrue(manager.requestClient === requestClient)
        return TestComposition(
            manager: manager,
            workspaceStore: workspaceStore,
            requestClient: requestClient,
            pairedHostStore: pairedHostStore,
            hostReadiness: manager.hostReadiness
        )
    }

    private func testEndpoint() -> HostEndpoint {
        HostEndpoint(
            host: "psyche.local",
            port: 4242,
            certificateFingerprint: testCertificateFingerprint
        )
    }

    private func makeWelcome(serverID: String = "host") -> WelcomePayload {
        WelcomePayload(
            serverID: serverID,
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

    private func waitForPairRequest(
        on transport: FakeTransport,
        occurrence: Int = 1,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws {
        for _ in 0..<1_000 {
            let count = await transport.sentMessages.filter {
                if case .legacy(.pair) = $0 { return true }
                return false
            }.count
            if count >= occurrence { return }
            await Task.yield()
        }
        XCTFail("Timed out waiting for pair request \(occurrence)", file: file, line: line)
        throw TestError.timedOut
    }

    private func pairingResult(
        code: String,
        clientID: String? = nil,
        clientName: String? = nil,
        on manager: ConnectionManager
    ) -> Task<Result<PairedHost, any Error>, Never> {
        Task {
            do {
                return .success(
                    try await manager.pair(
                        code: code,
                        clientID: clientID,
                        clientName: clientName
                    )
                )
            } catch {
                return .failure(error)
            }
        }
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

    private func waitForFailure(
        in manager: ConnectionManager,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async -> String? {
        for _ in 0..<1_000 {
            if case let .failed(reason) = await manager.state {
                return reason
            }
            await Task.yield()
        }
        XCTFail("Timed out waiting for connection failure", file: file, line: line)
        return nil
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

    private func waitForDisconnectingTransitions(
        _ count: Int,
        in manager: ConnectionManager,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws {
        for _ in 0..<1_000 {
            let transitions = await manager.stateHistory.filter { $0 == .disconnecting }.count
            if transitions >= count { return }
            await Task.yield()
        }
        XCTFail("Timed out waiting for disconnect intent \(count)", file: file, line: line)
        throw TestError.timedOut
    }

    private func waitForConnectCompletionOrAttempt(
        probe: RequestCompletionProbe,
        transport: FakeTransport,
        attemptCount: Int,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws {
        for _ in 0..<1_000 {
            let isComplete = await probe.isComplete
            let attempts = await transport.connectionAttempts.count
            if isComplete || attempts >= attemptCount {
                return
            }
            await Task.yield()
        }
        XCTFail("Timed out waiting for queued connect resolution", file: file, line: line)
        throw TestError.timedOut
    }

}

private struct TestComposition {
    let manager: ConnectionManager
    let workspaceStore: WorkspaceStore
    let requestClient: ControlRequestClient
    let pairedHostStore: PairedHostStore
    let hostReadiness: HostReadinessMachine
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

private actor PairSendFailingTransport: PsycheTransport {
    private let base: FakeTransport
    private var shouldFailPair = true

    init(base: FakeTransport) {
        self.base = base
    }

    func connect(to endpoint: HostEndpoint) async throws {
        try await base.connect(to: endpoint)
    }

    func disconnect() async {
        await base.disconnect()
    }

    func send(_ message: MobileClientMessage) async throws {
        if shouldFailPair, case .legacy(.pair) = message {
            shouldFailPair = false
            throw FakeTransportError.connectionFailed
        }
        try await base.send(message)
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

private actor SuspendedDisconnectTransport: PsycheTransport {
    private let base: FakeTransport
    private let disconnectGate = AsyncGate()
    private var disconnectDidSuspend = false
    private var disconnectWaiters: [CheckedContinuation<Void, Never>] = []

    init(base: FakeTransport) {
        self.base = base
    }

    func connect(to endpoint: HostEndpoint) async throws {
        try await base.connect(to: endpoint)
    }

    func disconnect() async {
        disconnectDidSuspend = true
        let waiting = disconnectWaiters
        disconnectWaiters.removeAll()
        waiting.forEach { $0.resume() }
        await disconnectGate.wait()
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

    func waitUntilDisconnectSuspends() async {
        guard !disconnectDidSuspend else { return }
        await withCheckedContinuation { continuation in
            if disconnectDidSuspend {
                continuation.resume()
            } else {
                disconnectWaiters.append(continuation)
            }
        }
    }

    func releaseDisconnect() async {
        await disconnectGate.release()
    }
}

private final class BlockingReadSecureStore: SecureStore, @unchecked Sendable {
    private let condition = NSCondition()
    private let readBeganSignal = BoundedAsyncSignal()
    private var storage: [String: Data] = [:]
    private var shouldBlockNextRead = false
    private var readReleased = false

    func blockNextRead() {
        readBeganSignal.reset()
        condition.withLock {
            shouldBlockNextRead = true
            readReleased = false
        }
    }

    func waitUntilReadBegins(timeout: Duration = .milliseconds(250)) async throws {
        try await readBeganSignal.wait(
            for: "connection manager secure-store read to begin",
            timeout: timeout
        )
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
            condition.unlock()
            readBeganSignal.signal()
            condition.lock()
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

/// A secure store whose next write can be refused, with control over whether the
/// compensating write that follows is allowed to prove the rollback. That
/// distinction is the whole difference between a refused commit and an
/// indeterminate one, so a test must be able to pick which one it exercises.
private final class FailableWriteSecureStore: SecureStore, @unchecked Sendable {
    enum Behavior {
        case succeed
        case failWrite
        case failWriteAndCompensation
        case mutateThenFailWrite
        case mutateThenFailWriteAndCompensation
    }

    enum StoreError: Error {
        case denied
    }

    private let lock = NSLock()
    private var storage: [String: Data] = [:]
    private var behavior: Behavior = .succeed
    private var hasRefusedWrite = false

    func setBehavior(_ behavior: Behavior) {
        lock.withLock {
            self.behavior = behavior
            hasRefusedWrite = false
        }
    }

    func data(forKey key: String) throws -> Data? {
        lock.withLock { storage[key] }
    }

    func set(_ data: Data, forKey key: String) throws {
        try lock.withLock {
            switch behavior {
            case .succeed:
                storage[key] = data
            case .failWrite:
                guard !hasRefusedWrite else {
                    storage[key] = data
                    return
                }
                hasRefusedWrite = true
                throw StoreError.denied
            case .failWriteAndCompensation:
                throw StoreError.denied
            case .mutateThenFailWrite:
                guard !hasRefusedWrite else {
                    storage[key] = data
                    return
                }
                hasRefusedWrite = true
                storage[key] = data
                throw StoreError.denied
            case .mutateThenFailWriteAndCompensation:
                if !hasRefusedWrite {
                    hasRefusedWrite = true
                    storage[key] = data
                }
                throw StoreError.denied
            }
        }
    }

    func removeValue(forKey key: String) throws {
        try lock.withLock {
            if case .failWriteAndCompensation = behavior {
                throw StoreError.denied
            }
            if case .mutateThenFailWriteAndCompensation = behavior {
                throw StoreError.denied
            }
            storage.removeValue(forKey: key)
        }
    }
}

private final class CancellationOnceSecureStore: SecureStore, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String: Data] = [:]
    private var shouldCancelNextRead = true

    func data(forKey key: String) throws -> Data? {
        try lock.withLock {
            if shouldCancelNextRead {
                shouldCancelNextRead = false
                throw CancellationError()
            }
            return storage[key]
        }
    }

    func set(_ data: Data, forKey key: String) throws {
        lock.withLock {
            storage[key] = data
        }
    }

    func removeValue(forKey key: String) throws {
        lock.withLock {
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

private extension FakeTransport {
    func emitBackToBack(_ messages: [MobileServerMessage]) {
        messages.forEach(emit)
    }
}
