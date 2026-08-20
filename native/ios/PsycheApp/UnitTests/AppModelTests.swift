import Foundation
import PsycheCore
import XCTest
@testable import Psyche_Build

private let testCertificateFingerprint = String(repeating: "a", count: 64)

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

    func testProductionRootComposesOneSharedGraph() throws {
        let discovery = BonjourHostDiscovery()
        let (composition, _) = makeComposition(bonjourHostDiscovery: discovery)
        let model = AppModel(composition: composition)
        let retainedComposition = try XCTUnwrap(model.composition)

        XCTAssertFalse(model.isFixture)
        XCTAssertNil(model.fixtureName)
        XCTAssertTrue(retainedComposition === composition)
        XCTAssertTrue(model.workspaceStore === composition.workspaceStore)
        XCTAssertTrue(model.terminalRegistry === composition.terminalRegistry)
    }

    func testCompositionRetainsTheExactInjectedBonjourDiscovery() {
        let discovery = BonjourHostDiscovery()
        let (composition, _) = makeComposition(bonjourHostDiscovery: discovery)

        XCTAssertTrue(composition.bonjourHostDiscovery === discovery)
    }

    func testProductionRootStartsWithNothingConfirmed() {
        let model = AppModel()

        XCTAssertNotNil(model.composition)
        XCTAssertNil(model.workspaceStore.workspace)
        XCTAssertTrue(model.workspaceStore.isStale)
        XCTAssertNil(model.hostName)
    }

    func testLoadLastConnectedHostContextUsesSelectedStoredHostNotSortedHosts() async throws {
        let (composition, store) = makeComposition()
        let model = AppModel(composition: composition)
        let alpha = makePairedHost(serverID: "server-a", serverName: "Alpha")
        let studio = makePairedHost(serverID: "server-z", serverName: "Studio")
        try await store.save(alpha)
        try await store.save(studio)
        try await store.markLastConnected(serverID: studio.serverID)

        await model.loadLastConnectedHostContext()

        XCTAssertEqual(model.hostName, "Studio")
    }

    func testLoadLastConnectedHostContextWithoutSelectionDoesNotFallbackToSortedHost() async throws {
        let (composition, store) = makeComposition()
        let model = AppModel(composition: composition)
        let alpha = makePairedHost(serverID: "server-a", serverName: "Alpha")
        try await store.save(alpha)
        model.recordConnectedHost(makePairedHost(serverID: "server-existing", serverName: "Remembered"))

        await model.loadLastConnectedHostContext()

        XCTAssertEqual(model.hostName, "Remembered")
    }

    func testFixtureLoadLastConnectedHostContextIsANoOpWithoutConnectionGraph() async {
        let model = AppModel(fixture: WorkspaceFixtures.multiproject)

        await model.loadLastConnectedHostContext()

        XCTAssertNil(model.composition)
        XCTAssertEqual(model.hostName, AppModel.fixtureHostName)
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

    func testRecordConnectedHostSetsServerNameAndClearsAnExistingConnectionError() async throws {
        let transport = FakeTransport(shouldFailConnection: true)
        let (composition, store) = makeComposition(transport: transport)
        let model = AppModel(composition: composition)
        let failingHost = makePairedHost(serverID: "server-z", serverName: "Studio")
        let recoveredHost = makePairedHost(serverID: "server-a", serverName: "Alpha")
        try await store.save(failingHost)
        try await store.markLastConnected(serverID: failingHost.serverID)

        await model.start()
        model.recordConnectedHost(recoveredHost)

        XCTAssertEqual(model.hostName, "Alpha")
        XCTAssertNil(model.connectionError)
    }

    func testStartUsesSelectedLastConnectedHostOnceAndRecordsFailureState() async throws {
        let transport = FakeTransport(shouldFailConnection: true)
        let (composition, store) = makeComposition(transport: transport)
        let model = AppModel(composition: composition)
        let alpha = makePairedHost(serverID: "server-a", serverName: "Alpha")
        let studio = makePairedHost(serverID: "server-z", serverName: "Studio")
        try await store.save(alpha)
        try await store.save(studio)
        try await store.markLastConnected(serverID: studio.serverID)

        await model.start()
        await model.start()

        let connectionAttempts = await transport.connectionAttempts
        let expectedError = ConnectionManagerError.connectionFailed(
            reason: FakeTransportError.connectionFailed.localizedDescription
        ).localizedDescription
        XCTAssertEqual(model.hostName, "Studio")
        XCTAssertEqual(model.connectionError, expectedError)
        XCTAssertEqual(connectionAttempts, [studio.endpoint])
    }
}

private extension AppModelTests {
    func makeComposition(
        transport: any PsycheTransport = FakeTransport(),
        secureStore: any SecureStore = InMemorySecureStore(),
        bonjourHostDiscovery: BonjourHostDiscovery = BonjourHostDiscovery()
    ) -> (composition: MobileAppComposition, store: PairedHostStore) {
        let store = PairedHostStore(secureStore: secureStore)
        let composition = MobileAppComposition(
            transport: transport,
            pairedHostStore: store,
            bonjourHostDiscovery: bonjourHostDiscovery
        )
        return (composition, store)
    }

    func makePairedHost(
        serverID: String = "server-1",
        serverName: String = "Host",
        host: String? = nil,
        clientID: String = "test-client",
        token: String? = nil
    ) -> PairedHost {
        let resolvedHost = host ?? "\(serverID).local"
        return PairedHost(
            serverID: serverID,
            serverName: serverName,
            endpoint: HostEndpoint(
                host: resolvedHost,
                port: 4242,
                certificateFingerprint: testCertificateFingerprint
            ),
            clientID: clientID,
            token: token
        )
    }
}
