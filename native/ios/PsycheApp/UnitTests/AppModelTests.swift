import Foundation
import PsycheCore
import XCTest
@testable import Psyche_Build

@MainActor
final class AppModelTests: XCTestCase {
    func testFixtureRootComposesNoConnectionGraph() {
        let model = AppModel(fixture: WorkspaceFixtures.multiproject)

        // The absence of the graph is the guarantee that a UI fixture cannot
        // reach the network or the keychain — there is nothing there to reach
        // with.
        XCTAssertNil(model.composition)
        XCTAssertTrue(model.isFixture)
        XCTAssertEqual(model.fixtureName, WorkspaceFixtures.multiproject)
    }

    func testFixtureRootStartsWithWorkspaceStateAlreadyApplied() {
        let model = AppModel(fixture: WorkspaceFixtures.multiproject)

        XCTAssertNotNil(model.workspaceStore.workspace)
        XCTAssertEqual(model.workspaceStore.nowSections.map(\.kind), [.needsYou, .running, .recent])
        XCTAssertEqual(model.hostName, AppModel.fixtureHostName)
    }

    func testFixtureStartIsANoOpRatherThanAConnectionAttempt() async {
        let model = AppModel(fixture: WorkspaceFixtures.multiproject)

        await model.start()

        XCTAssertNil(model.composition)
        XCTAssertNil(model.connectionError)
        XCTAssertEqual(model.hostName, AppModel.fixtureHostName)
    }

    func testProductionRootComposesOneSharedGraph() {
        let model = AppModel()
        let composition = model.composition

        XCTAssertNotNil(composition)
        XCTAssertFalse(model.isFixture)
        XCTAssertNil(model.fixtureName)
        XCTAssertTrue(model.workspaceStore === composition?.workspaceStore)
        XCTAssertTrue(model.remoteActionStore === composition?.remoteActionStore)
    }

    func testProductionRootStartsWithNothingConfirmed() {
        let model = AppModel()

        XCTAssertNil(model.workspaceStore.workspace)
        XCTAssertTrue(model.workspaceStore.isStale)
        XCTAssertNil(model.hostName)
    }

    func testProductionStartNamesSelectedHostInsteadOfLexicalFirstHost() async throws {
        let secureStore = InMemorySecureStore()
        let pairedHostStore = PairedHostStore(secureStore: secureStore)
        let lexicalFirst = PairedHost(
            serverID: "server-a",
            serverName: "Lexical First",
            endpoint: HostEndpoint(
                host: "first.local",
                port: 5151,
                certificateFingerprint: String(repeating: "a", count: 64)
            ),
            clientID: "client-a",
            token: "token-a"
        )
        let selected = PairedHost(
            serverID: "server-z",
            serverName: "Selected Host",
            endpoint: HostEndpoint(
                host: "selected.local",
                port: 5252,
                certificateFingerprint: String(repeating: "b", count: 64)
            ),
            clientID: "client-z",
            token: "token-z"
        )
        try await pairedHostStore.save(lexicalFirst)
        try await pairedHostStore.save(selected)
        let transport = FakeTransport(scriptedMessages: [
            .legacy(.welcome(WelcomePayload(
                serverID: selected.serverID,
                serverName: selected.serverName,
                protocolVersion: 3,
                projectName: nil
            )))
        ])
        let composition = MobileAppComposition(
            transport: transport,
            pairedHostStore: pairedHostStore
        )
        let model = AppModel(productionComposition: composition)

        await model.start()

        XCTAssertEqual(model.hostName, selected.serverName)
    }

    func testHostNameRefreshesWhenProvisionalHostIsPromoted() async throws {
        let secureStore = InMemorySecureStore()
        let pairedHostStore = PairedHostStore(secureStore: secureStore)
        let first = makeHost(
            serverID: "server-a",
            serverName: "Host A",
            host: "a.local",
            fingerprint: String(repeating: "a", count: 64)
        )
        let second = makeHost(
            serverID: "server-b",
            serverName: "Host B",
            host: "b.local",
            fingerprint: String(repeating: "b", count: 64)
        )
        try await pairedHostStore.save(first)
        let transport = FakeTransport()
        let composition = MobileAppComposition(
            transport: transport,
            pairedHostStore: pairedHostStore
        )
        let model = AppModel(productionComposition: composition)

        let start = Task { await model.start() }
        try await waitForHello(on: transport)
        await transport.emit(.legacy(.welcome(makeWelcome(for: first))))
        await start.value
        let firstSnapshot = try await waitForSnapshotRequest(on: transport)
        await transport.emit(.control(.workspaceSnapshot(MobileWorkspaceSnapshotResult(
            requestID: firstSnapshot,
            sequence: 1,
            workspace: try makeWorkspace(revision: 1)
        ))))
        try await waitForHostName(first.serverName, in: model)

        await composition.connectionManager.disconnect()
        let connect = Task {
            await composition.connectionManager.connect(to: second.endpoint)
        }
        try await waitForHello(on: transport, occurrence: 2)
        await transport.emit(.legacy(.welcome(makeWelcome(for: second))))
        await connect.value
        let pairing = Task {
            try await composition.connectionManager.pair(code: "123456")
        }
        try await waitForPairRequest(on: transport)
        await transport.emit(.legacy(.pairAccepted(
            PairAcceptedPayload(token: "token-b")
        )))
        _ = try await pairing.value
        let secondSnapshot = try await waitForSnapshotRequest(
            on: transport,
            occurrence: 2
        )
        await transport.emit(.control(.workspaceSnapshot(MobileWorkspaceSnapshotResult(
            requestID: secondSnapshot,
            sequence: 1,
            workspace: try makeWorkspace(revision: 2)
        ))))

        try await waitForHostName(second.serverName, in: model)
        XCTAssertEqual(model.hostName, second.serverName)
    }

    func testReadinessChangeRefreshesHostNameWithoutAWorkspaceEmission() async throws {
        let secureStore = InMemorySecureStore()
        let pairedHostStore = PairedHostStore(secureStore: secureStore)
        let first = makeHost(
            serverID: "server-a",
            serverName: "Host A",
            host: "a.local",
            fingerprint: String(repeating: "a", count: 64)
        )
        let second = makeHost(
            serverID: "server-b",
            serverName: "Host B",
            host: "b.local",
            fingerprint: String(repeating: "b", count: 64)
        )
        try await pairedHostStore.save(first)
        let composition = MobileAppComposition(
            transport: FakeTransport(),
            pairedHostStore: pairedHostStore
        )
        let model = AppModel(productionComposition: composition)
        model.recordPairedHostName(first.serverName)
        try await waitForHostName(first.serverName, in: model)

        try await pairedHostStore.save(second)
        _ = try composition.hostReadiness.beginDiscovery()

        try await waitForHostName(second.serverName, in: model)
        XCTAssertEqual(model.hostName, second.serverName)
    }

    func testFixtureNameIsReadFromLaunchArguments() {
        XCTAssertEqual(
            AppModel.fixtureName(in: ["Psyche", "-uiFixture", "multiproject"]),
            "multiproject"
        )
        XCTAssertNil(AppModel.fixtureName(in: ["Psyche"]))
        XCTAssertNil(
            AppModel.fixtureName(in: ["Psyche", "-uiFixture"]),
            "A dangling flag must not select an unnamed fixture"
        )
        XCTAssertNil(
            AppModel.fixtureName(in: ["Psyche", "-uiFixture", ""]),
            "An empty name must fall through to production rather than trap"
        )
    }

    func testFixtureSendFailureFlagIsReadFromLaunchArguments() {
        XCTAssertTrue(
            AppModel.fixtureSendFails(
                in: ["Psyche", "-uiFixture", "multiproject", "-uiTerminalSendFailure"]
            )
        )
        XCTAssertFalse(
            AppModel.fixtureSendFails(in: ["Psyche", "-uiFixture", "multiproject"])
        )
    }

    func testFixtureCanDeterministicallyFailTerminalSends() async {
        let model = AppModel(
            fixture: WorkspaceFixtures.multiproject,
            fixtureSendFails: true
        )
        await model.terminalRegistry.show(primary: "web-home")

        let accepted = await model.terminalRegistry.send(
            Data("keep\r".utf8),
            toPane: "web-home"
        )

        XCTAssertFalse(accepted)
        XCTAssertNotNil(model.terminalRegistry.lastErrorMessage)
    }

    func testPairingRecordsTheHostForLaterContext() {
        let model = AppModel(fixture: WorkspaceFixtures.multiproject)

        model.recordPairedHostName("studio.local")

        XCTAssertEqual(model.hostName, "studio.local")
    }

    private func makeHost(
        serverID: String,
        serverName: String,
        host: String,
        fingerprint: String
    ) -> PairedHost {
        PairedHost(
            serverID: serverID,
            serverName: serverName,
            endpoint: HostEndpoint(
                host: host,
                port: 4242,
                certificateFingerprint: fingerprint
            ),
            clientID: "client-\(serverID)",
            token: "token-\(serverID)"
        )
    }

    private func makeWelcome(for host: PairedHost) -> WelcomePayload {
        WelcomePayload(
            serverID: host.serverID,
            serverName: host.serverName,
            protocolVersion: 3,
            projectName: nil
        )
    }

    private func makeWorkspace(revision: Int) throws -> WorkspaceSnapshot {
        try JSONDecoder().decode(
            WorkspaceSnapshot.self,
            from: Data(#"{"revision":\#(revision),"projects":[]}"#.utf8)
        )
    }

    private func waitForHello(
        on transport: FakeTransport,
        occurrence: Int = 1
    ) async throws {
        try await waitForSentMessage(
            on: transport,
            description: "hello \(occurrence)"
        ) { messages in
            messages.filter {
                if case .legacy(.hello) = $0 { return true }
                return false
            }.count >= occurrence
        }
    }

    private func waitForPairRequest(on transport: FakeTransport) async throws {
        try await waitForSentMessage(on: transport, description: "pair request") {
            $0.contains {
                if case .legacy(.pair) = $0 { return true }
                return false
            }
        }
    }

    private func waitForSnapshotRequest(
        on transport: FakeTransport,
        occurrence: Int = 1
    ) async throws -> String {
        try await waitForSentMessage(
            on: transport,
            description: "workspace snapshot \(occurrence)"
        ) { messages in
            messages.compactMap { message -> String? in
                guard case let .control(.workspaceSnapshot(request)) = message else {
                    return nil
                }
                return request.requestID
            }.count >= occurrence
        }
        let requests = await transport.sentMessages.compactMap { message -> String? in
            guard case let .control(.workspaceSnapshot(request)) = message else {
                return nil
            }
            return request.requestID
        }
        return requests[occurrence - 1]
    }

    private func waitForHostName(
        _ expected: String,
        in model: AppModel
    ) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(2))
        while model.hostName != expected, clock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        guard model.hostName == expected else {
            throw AppModelTestError.timedOut("host name \(expected)")
        }
    }

    private func waitForSentMessage(
        on transport: FakeTransport,
        description: String,
        predicate: ([MobileClientMessage]) -> Bool
    ) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(2))
        while clock.now < deadline {
            if predicate(await transport.sentMessages) {
                return
            }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw AppModelTestError.timedOut(description)
    }
}

private enum AppModelTestError: Error {
    case timedOut(String)
}
