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
    }

    func testProductionRootStartsWithNothingConfirmed() {
        let model = AppModel()

        XCTAssertNil(model.workspaceStore.workspace)
        XCTAssertTrue(model.workspaceStore.isStale)
        XCTAssertNil(model.hostName)
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

    func testClearingAFixtureConnectionRemovesItsVisibleHostContext() async {
        let model = AppModel(fixture: WorkspaceFixtures.multiproject)

        await model.clearConnection()

        XCTAssertNil(model.hostName)
        XCTAssertNil(model.pendingInvite)
    }

    func testClearingAConnectionDeletesBothStoredHostAndMobileCredential() async throws {
        let pairedHostStore = PairedHostStore(secureStore: InMemorySecureStore())
        let credentialStore = MobileCredentialStore(secureStore: InMemorySecureStore())
        let endpoint = HostEndpoint(
            host: "studio.example", port: 4242,
            certificateFingerprint: String(repeating: "a", count: 64)
        )
        try await pairedHostStore.save(PairedHost(
            serverID: "host", serverName: "Studio", endpoint: endpoint,
            clientID: "client", token: "legacy-token"
        ))
        try await credentialStore.save(endpoint: endpoint, token: "durable-token")
        let model = AppModel(composition: MobileAppComposition(
            transport: AppModelFakeTransport(),
            pairedHostStore: pairedHostStore,
            mobileCredentialStore: credentialStore
        ))

        await model.clearConnection()

        let storedHosts = try await pairedHostStore.hosts()
        let storedCredential = try await credentialStore.credential(for: endpoint)
        XCTAssertTrue(storedHosts.isEmpty)
        XCTAssertNil(storedCredential)
        XCTAssertNil(model.hostName)
    }

    func testAcceptsAValidDeepLinkAsAPendingInvite() {
        let model = AppModel(fixture: WorkspaceFixtures.multiproject)

        model.receive(url: URL(string:
            "psyche://connect?host=wss%3A%2F%2Fstudio.example%3A4242&fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&psyche_invite=one-time-token"
        )!)

        XCTAssertEqual(model.pendingInvite?.endpoint.host, "studio.example")
        XCTAssertEqual(model.pendingInvite?.endpoint.port, 4242)
        XCTAssertEqual(model.pendingInvite?.token, "one-time-token")
    }

    func testLiveInviteWaitsForAuthenticationBeforePublishingHost() async throws {
        let transport = AppModelFakeTransport()
        let model = AppModel(composition: MobileAppComposition(
            transport: transport,
            pairedHostStore: PairedHostStore(secureStore: InMemorySecureStore()),
            mobileCredentialStore: MobileCredentialStore(secureStore: InMemorySecureStore())
        ))
        await model.start()
        let invite = try XCTUnwrap(PsycheInvite.parse(URL(string:
            "psyche://connect?host=wss%3A%2F%2Fstudio.example%3A4242&fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&psyche_invite=one-time-token"
        )!))

        let result = Task { await model.connect(using: invite) }
        _ = try await transport.waitForHello()
        XCTAssertNil(model.hostName)
        await transport.emit(.legacy(.welcome(WelcomePayload(
            serverID: "studio", serverName: "Studio", protocolVersion: 3, projectName: nil
        ))))

        let connected = await result.value
        XCTAssertTrue(connected)
        XCTAssertEqual(model.hostName, "studio.example")
    }

    func testLiveInviteRejectionKeepsHostEmptyAndUsesSafeRecovery() async throws {
        let model = AppModel(composition: MobileAppComposition(
            transport: AppModelRejectingTransport(),
            pairedHostStore: PairedHostStore(secureStore: InMemorySecureStore()),
            mobileCredentialStore: MobileCredentialStore(secureStore: InMemorySecureStore())
        ))
        await model.start()
        let invite = try XCTUnwrap(PsycheInvite.parse(URL(string:
            "psyche://connect?host=wss%3A%2F%2Fstudio.example%3A4242&fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&psyche_invite=one-time-token"
        )!))

        let connected = await model.connect(using: invite)
        XCTAssertFalse(connected)
        XCTAssertNil(model.hostName)
        XCTAssertEqual(model.connectionError, "Could not connect. Create a fresh Open on phone invite and try again.")
    }

    func testPendingLaunchInviteConnectsBeforeStoredHostReconnect() async throws {
        let transport = AppModelFakeTransport()
        let pairedHostStore = PairedHostStore(secureStore: InMemorySecureStore())
        let endpoint = HostEndpoint(
            host: "studio.example", port: 4242,
            certificateFingerprint: String(repeating: "a", count: 64)
        )
        try await pairedHostStore.save(PairedHost(
            serverID: "host", serverName: "Host", endpoint: endpoint,
            clientID: "legacy-client", token: "legacy-token"
        ))
        let model = AppModel(composition: MobileAppComposition(
            transport: transport,
            pairedHostStore: pairedHostStore,
            mobileCredentialStore: MobileCredentialStore(secureStore: InMemorySecureStore())
        ))
        model.receive(url: URL(string:
            "psyche://connect?host=wss%3A%2F%2Fstudio.example%3A4242&fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&psyche_invite=one-time-invite"
        )!)

        let start = Task { await model.start() }
        let hello = try await transport.waitForHello()
        XCTAssertEqual(hello.invite, "one-time-invite")
        XCTAssertNil(hello.token)
        start.cancel()
    }

    func testPendingLaunchInvitePublishesItsHostOnlyAfterAuthentication() async throws {
        let transport = AppModelFakeTransport()
        let model = AppModel(composition: MobileAppComposition(
            transport: transport,
            pairedHostStore: PairedHostStore(secureStore: InMemorySecureStore()),
            mobileCredentialStore: MobileCredentialStore(secureStore: InMemorySecureStore())
        ))
        model.receive(url: URL(string:
            "psyche://connect?host=wss%3A%2F%2Fstudio.example%3A4242&fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&psyche_invite=one-time-invite"
        )!)

        let start = Task { await model.start() }
        _ = try await transport.waitForHello()
        XCTAssertNil(model.hostName)
        await transport.emit(.legacy(.welcome(WelcomePayload(
            serverID: "studio", serverName: "Studio", protocolVersion: 3, projectName: nil
        ))))
        await start.value

        XCTAssertEqual(model.hostName, "studio.example")
        XCTAssertNil(model.connectionError)
    }

    func testPendingLaunchInviteRejectionUsesSafeRecovery() async throws {
        let model = AppModel(composition: MobileAppComposition(
            transport: AppModelRejectingTransport(),
            pairedHostStore: PairedHostStore(secureStore: InMemorySecureStore()),
            mobileCredentialStore: MobileCredentialStore(secureStore: InMemorySecureStore())
        ))
        model.receive(url: URL(string:
            "psyche://connect?host=wss%3A%2F%2Fstudio.example%3A4242&fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&psyche_invite=one-time-invite"
        )!)

        await model.start()

        XCTAssertNil(model.hostName)
        XCTAssertEqual(model.connectionError, "Could not connect. Create a fresh Open on phone invite and try again.")
    }

    func testRejectsAnInvalidDeepLinkWithoutChangingPendingInvite() {
        let model = AppModel(fixture: WorkspaceFixtures.multiproject)

        model.receive(url: URL(string: "coven://connect?host=wss%3A%2F%2Fstudio.example&fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&psyche_invite=token")!)

        XCTAssertNil(model.pendingInvite)
    }

    func testGeneratedAppRegistersPsycheURLDeliveryPath() throws {
        let sourceRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let infoURL = sourceRoot.appendingPathComponent("Resources/Info.plist")
        let appURL = sourceRoot.appendingPathComponent("Sources/PsycheApp/PsycheApp.swift")
        let infoData = try Data(contentsOf: infoURL)
        let info = try XCTUnwrap(
            PropertyListSerialization.propertyList(from: infoData, format: nil) as? [String: Any]
        )
        let urlTypes = try XCTUnwrap(info["CFBundleURLTypes"] as? [[String: Any]])
        let schemes = try XCTUnwrap(urlTypes.first?["CFBundleURLSchemes"] as? [String])
        let appSource = try String(contentsOf: appURL, encoding: .utf8)

        XCTAssertEqual(schemes, ["psyche"])
        XCTAssertTrue(appSource.contains(".onOpenURL"))
        XCTAssertTrue(appSource.contains("model.receive(url: url)"))
    }
}

private actor AppModelFakeTransport: PsycheTransport {
    private var continuation: AsyncStream<MobileServerMessage>.Continuation?
    private var stream: AsyncStream<MobileServerMessage>?
    private var helloWaiters: [CheckedContinuation<HelloPayload, any Error>] = []
    private var lastHello: HelloPayload?

    func connect(to endpoint: HostEndpoint) async throws {
        let pair = AsyncStream<MobileServerMessage>.makeStream()
        stream = pair.stream
        continuation = pair.continuation
    }

    func disconnect() async {
        continuation?.finish()
        continuation = nil
        stream = nil
    }

    func emit(_ message: MobileServerMessage) {
        continuation?.yield(message)
    }

    func send(_ message: MobileClientMessage) async throws {
        guard case let .legacy(.hello(payload)) = message else { return }
        lastHello = payload
        let waiters = helloWaiters
        helloWaiters.removeAll()
        waiters.forEach { $0.resume(returning: payload) }
    }

    func incomingMessages() async -> AsyncStream<MobileServerMessage> {
        stream ?? AsyncStream { $0.finish() }
    }

    func incomingBinaryFrames() async -> AsyncStream<TerminalBinaryFrame> {
        AsyncStream { $0.finish() }
    }

    func waitForHello() async throws -> HelloPayload {
        if let lastHello { return lastHello }
        return try await withCheckedThrowingContinuation { continuation in
            if let lastHello {
                continuation.resume(returning: lastHello)
                return
            }
            helloWaiters.append(continuation)
        }
    }
}

private actor AppModelRejectingTransport: PsycheTransport {
    func connect(to endpoint: HostEndpoint) async throws { throw URLError(.cannotConnectToHost) }
    func disconnect() async {}
    func send(_ message: MobileClientMessage) async throws {}
    func incomingMessages() async -> AsyncStream<MobileServerMessage> { AsyncStream { $0.finish() } }
    func incomingBinaryFrames() async -> AsyncStream<TerminalBinaryFrame> { AsyncStream { $0.finish() } }
}
