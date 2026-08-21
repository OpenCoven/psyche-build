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
        XCTAssertNil(model.hostDiscriminator)
    }

    func testFixtureStartIsANoOpRatherThanAConnectionAttempt() async {
        let model = AppModel(fixture: WorkspaceFixtures.multiproject)

        await model.start()

        XCTAssertNil(model.composition)
        XCTAssertNil(model.connectionError)
        XCTAssertEqual(model.hostName, AppModel.fixtureHostName)
        XCTAssertNil(model.hostDiscriminator)
    }

    func testFixtureBeginPairHostFlowPublishesDeterministicRowsWithoutLiveComposition() async {
        let model = AppModel(fixture: WorkspaceFixtures.multiproject)
        let pairHostModel = await model.beginPairHostFlow()

        await pairHostModel.start()
        await waitUntil { pairHostModel.rows.count == 4 }

        XCTAssertNil(model.composition)
        XCTAssertEqual(
            pairHostModel.rows.map(\.serverID),
            ["changed-host", "new-host", "offline-host", "studio"]
        )
        XCTAssertEqual(
            pairHostModel.rows.map(\.serverName),
            ["Changed Host", "New Host", "Offline Host", "Studio"]
        )
        XCTAssertEqual(
            pairHostModel.rows.map(\.pairingStatus),
            [.requiresRePairing, .unpaired, .unpaired, .paired]
        )
        XCTAssertEqual(pairHostModel.rows[2].resolutionFailure, .timedOut)

        await model.endPairHostFlow(pairHostModel)
    }

    func testBeginPairHostFlowReturnsOneActiveModelForConcurrentAndRepeatedCalls() async {
        let (composition, _) = makeComposition()
        let factory = AppModelPairHostFactory()
        let model = AppModel(
            composition: composition,
            pairHostModelFactory: { factory.makeModel() }
        )

        let firstTask = Task { @MainActor in
            ObjectIdentifier(await model.beginPairHostFlow())
        }
        let secondTask = Task { @MainActor in
            ObjectIdentifier(await model.beginPairHostFlow())
        }
        let firstID = await firstTask.value
        let secondID = await secondTask.value
        let thirdID = ObjectIdentifier(await model.beginPairHostFlow())
        let activeModel = try? XCTUnwrap(model.activePairHostModel)

        XCTAssertEqual(firstID, secondID)
        XCTAssertEqual(firstID, thirdID)
        XCTAssertEqual(activeModel.map(ObjectIdentifier.init), firstID)
        XCTAssertEqual(factory.probes.count, 1)
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

    func testProductionBeginPairHostFlowUsesInjectedCompositionGraph() async throws {
        let discovery = BonjourHostDiscovery()
        let (composition, store) = makeComposition(bonjourHostDiscovery: discovery)
        let host = makePairedHost(serverID: "server-a", serverName: "Alpha")
        try await store.save(host)
        let model = AppModel(composition: composition)

        let pairHostModel = await model.beginPairHostFlow()
        let status = try await pairHostModel.dependencies.pairingStatus(
            host.serverID,
            host.certificateFingerprint.uppercased()
        )
        await pairHostModel.dependencies.disconnect()
        let connectionState = await composition.connectionManager.state
        let storedHost = try await composition.pairedHostStore.host(withServerID: host.serverID)

        XCTAssertEqual(status, .paired)
        XCTAssertEqual(connectionState, .disconnected)
        XCTAssertEqual(storedHost, host)

        await model.endPairHostFlow(pairHostModel)
    }

    func testEndPairHostFlowRetainsActiveModelUntilStopFinishes() async throws {
        let (composition, _) = makeComposition()
        let factory = AppModelPairHostFactory()
        let model = AppModel(
            composition: composition,
            pairHostModelFactory: { factory.makeModel() }
        )
        let pairHostModel = await model.beginPairHostFlow()
        let firstProbe = try XCTUnwrap(factory.probes.first)
        let stopGate = AsyncGate()
        await firstProbe.setStopGate(stopGate)

        await pairHostModel.start()

        let endTask = Task { @MainActor in
            await model.endPairHostFlow(pairHostModel)
        }

        await stopGate.waitUntilStarted()

        XCTAssertTrue(model.activePairHostModel === pairHostModel)

        await stopGate.succeed()
        await endTask.value

        let stopCount = await firstProbe.stopCount()
        XCTAssertNil(model.activePairHostModel)
        XCTAssertEqual(stopCount, 1)
    }

    func testBeginPairHostFlowDuringBlockedEndWaitsAndReturnsDistinctModelAfterCleanup() async throws {
        let (composition, _) = makeComposition()
        let factory = AppModelPairHostFactory()
        let model = AppModel(
            composition: composition,
            pairHostModelFactory: { factory.makeModel() }
        )
        let first = await model.beginPairHostFlow()
        let firstID = ObjectIdentifier(first)
        let firstProbe = try XCTUnwrap(factory.probes.first)
        let stopGate = AsyncGate()
        await firstProbe.setStopGate(stopGate)

        await first.start()

        let endTask = Task { @MainActor in
            await model.endPairHostFlow(first)
        }
        await stopGate.waitUntilStarted()

        let secondTask = Task { @MainActor in
            ObjectIdentifier(await model.beginPairHostFlow())
        }

        await Task.yield()
        XCTAssertEqual(factory.probes.count, 1)
        XCTAssertTrue(model.activePairHostModel === first)

        await stopGate.succeed()
        let secondID = await secondTask.value
        await endTask.value

        XCTAssertNotEqual(secondID, firstID)
        XCTAssertEqual(factory.probes.count, 2)
        XCTAssertEqual(model.activePairHostModel.map(ObjectIdentifier.init), secondID)
    }

    func testConcurrentEndPairHostFlowCallsShareOneStopAndCleanup() async throws {
        let (composition, _) = makeComposition()
        let factory = AppModelPairHostFactory()
        let model = AppModel(
            composition: composition,
            pairHostModelFactory: { factory.makeModel() }
        )
        let pairHostModel = await model.beginPairHostFlow()
        let probe = try XCTUnwrap(factory.probes.first)
        let stopGate = AsyncGate()
        let disconnectGate = AsyncGate()
        let readinessGate = AsyncGate()
        await probe.setStopGate(stopGate)
        await probe.setDisconnectGate(disconnectGate)
        await probe.setReadinessGate(readinessGate)

        await pairHostModel.start()
        await probe.yield([makeDiscoveryEntry(serverID: "server-a", serverName: "Alpha")])
        await waitUntil { pairHostModel.rows.count == 1 }
        pairHostModel.select(serverID: "server-a")

        let submitTask = Task { @MainActor in
            await pairHostModel.submit()
        }
        await readinessGate.waitUntilStarted()
        await waitUntil { pairHostModel.phase == .loadingWorkspace }

        let firstEnd = Task { @MainActor in
            await model.endPairHostFlow(pairHostModel)
        }
        let secondEnd = Task { @MainActor in
            await model.endPairHostFlow(pairHostModel)
        }

        await stopGate.waitUntilStarted()
        let stopCountBeforeDisconnect = await probe.stopCount()
        XCTAssertEqual(stopCountBeforeDisconnect, 1)

        await stopGate.succeed()
        await disconnectGate.waitUntilStarted()
        let disconnectCountBeforeFinish = await probe.disconnectCount()
        XCTAssertEqual(disconnectCountBeforeFinish, 1)

        await disconnectGate.succeed()
        await firstEnd.value
        await secondEnd.value
        await submitTask.value

        let finalStopCount = await probe.stopCount()
        let finalDisconnectCount = await probe.disconnectCount()
        XCTAssertNil(model.activePairHostModel)
        XCTAssertEqual(finalStopCount, 1)
        XCTAssertEqual(finalDisconnectCount, 1)
    }

    func testExternalEndOfIncompleteConnectionDisconnectsBeforeNewBeginReturns() async throws {
        let (composition, _) = makeComposition()
        let factory = AppModelPairHostFactory()
        let model = AppModel(
            composition: composition,
            pairHostModelFactory: { factory.makeModel() }
        )
        let first = await model.beginPairHostFlow()
        let firstID = ObjectIdentifier(first)
        let firstProbe = try XCTUnwrap(factory.probes.first)
        let disconnectGate = AsyncGate()
        let readinessGate = AsyncGate()
        await firstProbe.setDisconnectGate(disconnectGate)
        await firstProbe.setReadinessGate(readinessGate)

        await first.start()
        await firstProbe.yield([makeDiscoveryEntry(serverID: "server-a", serverName: "Alpha")])
        await waitUntil { first.rows.count == 1 }
        first.select(serverID: "server-a")

        let submitTask = Task { @MainActor in
            await first.submit()
        }
        await readinessGate.waitUntilStarted()
        await waitUntil { first.phase == .loadingWorkspace }

        let endTask = Task { @MainActor in
            await model.endPairHostFlow(first)
        }
        await disconnectGate.waitUntilStarted()

        let secondTask = Task { @MainActor in
            ObjectIdentifier(await model.beginPairHostFlow())
        }
        await Task.yield()

        XCTAssertEqual(factory.probes.count, 1)

        await disconnectGate.succeed()
        let secondID = await secondTask.value
        await endTask.value
        await submitTask.value

        let disconnectCount = await firstProbe.disconnectCount()
        XCTAssertNotEqual(secondID, firstID)
        XCTAssertEqual(factory.probes.count, 2)
        XCTAssertEqual(disconnectCount, 1)
    }

    func testEndPairHostFlowAfterPairRejectionDisconnectsIncompleteManualConnectionExactlyOnce() async throws {
        let (composition, _) = makeComposition()
        let factory = AppModelPairHostFactory()
        let model = AppModel(
            composition: composition,
            pairHostModelFactory: { factory.makeModel() }
        )
        let pairHostModel = await model.beginPairHostFlow()
        let probe = try XCTUnwrap(factory.probes.first)
        await probe.setPairResult(.failure(AppModelTestFailure("Pair rejected")))

        await pairHostModel.start()
        pairHostModel.setManualEntrySelected(true)
        pairHostModel.manualHost = " manual.local "
        pairHostModel.manualPort = " 4242 "
        pairHostModel.manualFingerprint = testCertificateFingerprint
        pairHostModel.pairingCode = "123456"

        await pairHostModel.submit()

        let connectForPairingCount = await probe.connectForPairingCount()
        let pairCount = await probe.pairCount()
        let disconnectCountBeforeEnd = await probe.disconnectCount()
        XCTAssertEqual(pairHostModel.phase, .failed)
        XCTAssertEqual(pairHostModel.errorMessage, "Pair rejected")
        XCTAssertEqual(connectForPairingCount, 1)
        XCTAssertEqual(pairCount, 1)
        XCTAssertEqual(disconnectCountBeforeEnd, 0)

        await model.endPairHostFlow(pairHostModel)

        let stopCount = await probe.stopCount()
        let disconnectCount = await probe.disconnectCount()
        XCTAssertNil(model.activePairHostModel)
        XCTAssertEqual(stopCount, 1)
        XCTAssertEqual(disconnectCount, 1)
    }

    func testEndPairHostFlowAfterValidationFailureBeforeConnectDoesNotDisconnect() async throws {
        let (composition, _) = makeComposition()
        let factory = AppModelPairHostFactory()
        let model = AppModel(
            composition: composition,
            pairHostModelFactory: { factory.makeModel() }
        )
        let pairHostModel = await model.beginPairHostFlow()
        let probe = try XCTUnwrap(factory.probes.first)

        await pairHostModel.start()
        pairHostModel.setManualEntrySelected(true)
        pairHostModel.manualHost = "manual.local"
        pairHostModel.manualPort = "4242"
        pairHostModel.manualFingerprint = testCertificateFingerprint
        pairHostModel.pairingCode = "12345"

        await pairHostModel.submit()

        let connectForPairingCount = await probe.connectForPairingCount()
        let pairCount = await probe.pairCount()
        XCTAssertEqual(pairHostModel.phase, .failed)
        XCTAssertEqual(
            pairHostModel.errorMessage,
            "The pairing code must contain exactly six digits."
        )
        XCTAssertEqual(connectForPairingCount, 0)
        XCTAssertEqual(pairCount, 0)

        await model.endPairHostFlow(pairHostModel)

        let stopCount = await probe.stopCount()
        let disconnectCount = await probe.disconnectCount()
        XCTAssertNil(model.activePairHostModel)
        XCTAssertEqual(stopCount, 1)
        XCTAssertEqual(disconnectCount, 0)
    }

    func testEndPairHostFlowAfterReadinessFailureDisconnectsIncompleteManualConnection() async throws {
        let (composition, _) = makeComposition()
        let factory = AppModelPairHostFactory()
        let model = AppModel(
            composition: composition,
            pairHostModelFactory: { factory.makeModel() }
        )
        let pairHostModel = await model.beginPairHostFlow()
        let probe = try XCTUnwrap(factory.probes.first)
        let readinessGate = AsyncGate()
        let endpoint = HostEndpoint(
            host: "manual.local",
            port: 4242,
            certificateFingerprint: testCertificateFingerprint
        )
        await probe.setPairResult(.success(makePairedHost(
            serverID: "manual-server",
            serverName: "Manual Host",
            host: endpoint.host,
            port: endpoint.port
        )))
        await probe.setReadinessGate(readinessGate)

        await pairHostModel.start()
        pairHostModel.setManualEntrySelected(true)
        pairHostModel.manualHost = "manual.local"
        pairHostModel.manualPort = "4242"
        pairHostModel.manualFingerprint = testCertificateFingerprint
        pairHostModel.pairingCode = "123456"

        let submitTask = Task { @MainActor in
            await pairHostModel.submit()
        }
        await readinessGate.waitUntilStarted()
        await waitUntil { pairHostModel.phase == .loadingWorkspace }
        await readinessGate.fail(AppModelTestFailure("Workspace never became ready"))
        await submitTask.value

        let connectForPairingCount = await probe.connectForPairingCount()
        let pairCount = await probe.pairCount()
        let disconnectCountBeforeEnd = await probe.disconnectCount()
        XCTAssertEqual(pairHostModel.phase, .failed)
        XCTAssertEqual(pairHostModel.errorMessage, "Workspace never became ready")
        XCTAssertEqual(connectForPairingCount, 1)
        XCTAssertEqual(pairCount, 1)
        XCTAssertEqual(disconnectCountBeforeEnd, 0)

        await model.endPairHostFlow(pairHostModel)

        let stopCount = await probe.stopCount()
        let disconnectCount = await probe.disconnectCount()
        XCTAssertNil(model.activePairHostModel)
        XCTAssertEqual(stopCount, 1)
        XCTAssertEqual(disconnectCount, 1)
    }

    func testEndPairHostFlowAfterReadyManualPairingDoesNotDisconnect() async throws {
        let (composition, _) = makeComposition()
        let factory = AppModelPairHostFactory()
        let model = AppModel(
            composition: composition,
            pairHostModelFactory: { factory.makeModel() }
        )
        let pairHostModel = await model.beginPairHostFlow()
        let probe = try XCTUnwrap(factory.probes.first)
        let readinessGate = AsyncGate()
        await probe.setPairResult(.success(makePairedHost(
            serverID: "manual-server",
            serverName: "Manual Host",
            host: "manual.local"
        )))
        await probe.setReadinessGate(readinessGate)

        await pairHostModel.start()
        pairHostModel.setManualEntrySelected(true)
        pairHostModel.manualHost = "manual.local"
        pairHostModel.manualPort = "4242"
        pairHostModel.manualFingerprint = testCertificateFingerprint
        pairHostModel.pairingCode = "123456"

        let submitTask = Task { @MainActor in
            await pairHostModel.submit()
        }
        await readinessGate.waitUntilStarted()
        await waitUntil { pairHostModel.phase == .loadingWorkspace }
        await readinessGate.succeed()
        await submitTask.value

        let connectForPairingCount = await probe.connectForPairingCount()
        let pairCount = await probe.pairCount()
        XCTAssertEqual(pairHostModel.phase, .ready)
        XCTAssertEqual(connectForPairingCount, 1)
        XCTAssertEqual(pairCount, 1)

        await model.endPairHostFlow(pairHostModel)

        let stopCount = await probe.stopCount()
        let disconnectCount = await probe.disconnectCount()
        XCTAssertNil(model.activePairHostModel)
        XCTAssertEqual(stopCount, 1)
        XCTAssertEqual(disconnectCount, 0)
    }

    func testReadyEndStopsDiscoveryWithoutDisconnectAndAllowsNewDistinctFlow() async throws {
        let (composition, _) = makeComposition()
        let factory = AppModelPairHostFactory()
        let model = AppModel(
            composition: composition,
            pairHostModelFactory: { factory.makeModel() }
        )
        let first = await model.beginPairHostFlow()
        let firstID = ObjectIdentifier(first)
        let firstProbe = try XCTUnwrap(factory.probes.first)
        let readinessGate = AsyncGate()
        await firstProbe.setReadinessGate(readinessGate)

        await first.start()
        await firstProbe.yield([makeDiscoveryEntry(serverID: "server-a", serverName: "Alpha")])
        await waitUntil { first.rows.count == 1 }
        first.select(serverID: "server-a")

        let submitTask = Task { @MainActor in
            await first.submit()
        }
        await readinessGate.waitUntilStarted()
        await readinessGate.succeed()
        await submitTask.value

        XCTAssertEqual(first.phase, .ready)

        await model.endPairHostFlow(first)
        let second = await model.beginPairHostFlow()

        let stopCount = await firstProbe.stopCount()
        let disconnectCount = await firstProbe.disconnectCount()
        XCTAssertNotEqual(ObjectIdentifier(second), firstID)
        XCTAssertEqual(factory.probes.count, 2)
        XCTAssertEqual(stopCount, 1)
        XCTAssertEqual(disconnectCount, 0)
    }

    func testProductionRootStartsWithNothingConfirmed() {
        let model = AppModel()

        XCTAssertNotNil(model.composition)
        XCTAssertNil(model.workspaceStore.workspace)
        XCTAssertTrue(model.workspaceStore.isStale)
        XCTAssertNil(model.hostName)
        XCTAssertNil(model.hostDiscriminator)
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
        XCTAssertEqual(model.hostDiscriminator, "server-z.local:4242 • …rver-z")
    }

    func testLoadLastConnectedHostContextWithoutSelectionDoesNotFallbackToSortedHost() async throws {
        let (composition, store) = makeComposition()
        let model = AppModel(composition: composition)
        let alpha = makePairedHost(serverID: "server-a", serverName: "Alpha")
        try await store.save(alpha)
        model.recordConnectedHost(
            makePairedHost(
                serverID: "server-existing",
                serverName: "Remembered",
                host: "remembered.local",
                port: 5151
            )
        )

        await model.loadLastConnectedHostContext()

        XCTAssertEqual(model.hostName, "Remembered")
        XCTAssertEqual(model.hostDiscriminator, "remembered.local:5151 • …isting")
    }

    func testFixtureLoadLastConnectedHostContextIsANoOpWithoutConnectionGraph() async {
        let model = AppModel(fixture: WorkspaceFixtures.multiproject)

        await model.loadLastConnectedHostContext()

        XCTAssertNil(model.composition)
        XCTAssertEqual(model.hostName, AppModel.fixtureHostName)
        XCTAssertNil(model.hostDiscriminator)
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

    func testFixturePairingReadinessDelayFlagIsReadFromLaunchArguments() {
        XCTAssertEqual(
            AppModel.fixturePairingReadinessDelay(in: ["Psyche", "-uiPairingReadinessDelay"]),
            .seconds(2)
        )
        XCTAssertNil(
            AppModel.fixturePairingReadinessDelay(in: ["Psyche", "-uiFixture", "multiproject"])
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

    func testRecordConnectedHostSetsServerNameDiscriminatorAndClearsAnExistingConnectionError() async throws {
        let transport = FakeTransport(shouldFailConnection: true)
        let (composition, store) = makeComposition(transport: transport)
        let model = AppModel(composition: composition)
        let failingHost = makePairedHost(serverID: "server-z", serverName: "Studio")
        let recoveredHost = makePairedHost(
            serverID: "server-a",
            serverName: "Alpha",
            host: "alpha.local",
            port: 5151
        )
        try await store.save(failingHost)
        try await store.markLastConnected(serverID: failingHost.serverID)

        await model.start()
        model.recordConnectedHost(recoveredHost)

        XCTAssertEqual(model.hostName, "Alpha")
        XCTAssertEqual(model.hostDiscriminator, "alpha.local:5151 • …rver-a")
        XCTAssertNil(model.connectionError)
    }

    func testRecordConnectedHostKeepsSameNameHostsDistinguishableByDiscriminator() {
        let model = AppModel(fixture: WorkspaceFixtures.multiproject)
        let first = makePairedHost(
            serverID: "studio-111111",
            serverName: "Studio",
            host: "studio.local",
            port: 4242
        )
        let second = makePairedHost(
            serverID: "studio-222222",
            serverName: "Studio",
            host: "studio.local",
            port: 4343
        )

        model.recordConnectedHost(first)
        let firstDiscriminator = model.hostDiscriminator
        model.recordConnectedHost(second)

        XCTAssertEqual(model.hostName, "Studio")
        XCTAssertEqual(firstDiscriminator, "studio.local:4242 • …111111")
        XCTAssertEqual(model.hostDiscriminator, "studio.local:4343 • …222222")
        XCTAssertNotEqual(firstDiscriminator, model.hostDiscriminator)
    }

    func testLoadLastConnectedHostContextRestoresExactSelectedHostContext() async throws {
        let (composition, store) = makeComposition()
        let model = AppModel(composition: composition)
        let first = makePairedHost(
            serverID: "studio-111111",
            serverName: "Studio",
            host: "studio.local",
            port: 4242
        )
        let second = makePairedHost(
            serverID: "studio-222222",
            serverName: "Studio",
            host: "studio.local",
            port: 4343
        )
        try await store.save(first)
        try await store.save(second)
        try await store.markLastConnected(serverID: second.serverID)

        await model.loadLastConnectedHostContext()

        XCTAssertEqual(model.hostName, "Studio")
        XCTAssertEqual(model.hostDiscriminator, "studio.local:4343 • …222222")
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
        XCTAssertEqual(model.hostDiscriminator, "server-z.local:4242 • …rver-z")
        XCTAssertEqual(model.connectionError, expectedError)
        XCTAssertEqual(connectionAttempts, [studio.endpoint])
    }
}

private extension AppModelTests {
    func waitUntil(
        timeout: TimeInterval = 1,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ condition: @escaping @MainActor () -> Bool
    ) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() >= deadline {
                XCTFail("Timed out waiting for condition", file: file, line: line)
                return
            }
            await Task.yield()
        }
    }

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
        port: Int = 4242,
        clientID: String = "test-client",
        token: String? = nil
    ) -> PairedHost {
        let resolvedHost = host ?? "\(serverID).local"
        return PairedHost(
            serverID: serverID,
            serverName: serverName,
            endpoint: HostEndpoint(
                host: resolvedHost,
                port: port,
                certificateFingerprint: testCertificateFingerprint
            ),
            clientID: clientID,
            token: token
        )
    }

    func makeDiscoveryEntry(
        serverID: String,
        serverName: String,
        host: String? = nil,
        port: Int = 4242
    ) -> BonjourDiscoveryEntry {
        let resolvedHost = host ?? "\(serverID).local"
        let identity = BonjourHostIdentity(
            serverID: serverID,
            serverName: serverName,
            domain: "local.",
            certificateFingerprint: testCertificateFingerprint,
            supportedVersions: [PsycheProtocolVersion.current]
        )
        return BonjourDiscoveryEntry(
            identity: identity,
            availability: .resolved(DiscoveredHost(
                identity: identity,
                endpoint: HostEndpoint(
                    host: resolvedHost,
                    port: port,
                    certificateFingerprint: testCertificateFingerprint
                )
            ))
        )
    }
}

@MainActor
private final class AppModelPairHostFactory {
    private(set) var probes: [AppModelPairHostProbe] = []

    func makeModel() -> PairHostModel {
        let probe = AppModelPairHostProbe()
        probes.append(probe)
        return probe.makeModel()
    }
}

@MainActor
private final class AppModelPairHostProbe {
    private let recorder = AppModelPairHostRecorder()

    func makeModel() -> PairHostModel {
        PairHostModel(dependencies: PairHostModel.Dependencies(
            startDiscovery: { await self.recorder.startDiscovery() },
            stopDiscovery: { await self.recorder.stopDiscovery() },
            retryDiscovery: { _ in },
            pairingStatus: { _, _ in .paired },
            connectPaired: { try await self.recorder.connectPaired(serverID: $0, endpoint: $1) },
            connectForPairing: { try await self.recorder.connectForPairing(endpoint: $0) },
            pair: { try await self.recorder.pair(code: $0) },
            waitForWorkspaceReady: { try await self.recorder.waitForWorkspaceReady() },
            disconnect: { await self.recorder.disconnect() }
        ))
    }

    func yield(_ snapshot: [BonjourDiscoveryEntry]) async {
        await recorder.yield(snapshot)
    }

    func setConnectPairedResult(_ result: Result<PairedHost, AppModelTestFailure>) async {
        await recorder.setConnectPairedResult(result)
    }

    func setPairResult(_ result: Result<PairedHost, AppModelTestFailure>) async {
        await recorder.setPairResult(result)
    }

    func setReadinessGate(_ gate: AsyncGate?) async {
        await recorder.setReadinessGate(gate)
    }

    func setStopGate(_ gate: AsyncGate?) async {
        await recorder.setStopGate(gate)
    }

    func setDisconnectGate(_ gate: AsyncGate?) async {
        await recorder.setDisconnectGate(gate)
    }

    func stopCount() async -> Int {
        await recorder.stopCount()
    }

    func disconnectCount() async -> Int {
        await recorder.disconnectCount()
    }

    func connectForPairingCount() async -> Int {
        await recorder.connectForPairingCount()
    }

    func pairCount() async -> Int {
        await recorder.pairCount()
    }
}

private actor AppModelPairHostRecorder {
    private let stream: AsyncStream<[BonjourDiscoveryEntry]>
    private let continuation: AsyncStream<[BonjourDiscoveryEntry]>.Continuation
    private var connectPairedResult: Result<PairedHost, AppModelTestFailure> = .success(
        PairedHost(
            serverID: "server-a",
            serverName: "Alpha",
            endpoint: HostEndpoint(
                host: "server-a.local",
                port: 4242,
                certificateFingerprint: testCertificateFingerprint
            ),
            clientID: "test-client",
            token: "test-token"
        )
    )
    private var pairResult: Result<PairedHost, AppModelTestFailure> =
        .failure(AppModelTestFailure("Unexpected pairing call"))
    private var readinessGate: AsyncGate?
    private var stopGate: AsyncGate?
    private var disconnectGate: AsyncGate?
    private var stopInvocationCount = 0
    private var disconnectInvocationCount = 0
    private var connectForPairingInvocationCount = 0
    private var pairInvocationCount = 0

    init() {
        let stream = AsyncStream<[BonjourDiscoveryEntry]>.makeStream()
        self.stream = stream.stream
        continuation = stream.continuation
    }

    func startDiscovery() -> AsyncStream<[BonjourDiscoveryEntry]> {
        stream
    }

    func yield(_ snapshot: [BonjourDiscoveryEntry]) {
        continuation.yield(snapshot)
    }

    func setConnectPairedResult(_ result: Result<PairedHost, AppModelTestFailure>) {
        connectPairedResult = result
    }

    func setPairResult(_ result: Result<PairedHost, AppModelTestFailure>) {
        pairResult = result
    }

    func setReadinessGate(_ gate: AsyncGate?) {
        readinessGate = gate
    }

    func setStopGate(_ gate: AsyncGate?) {
        stopGate = gate
    }

    func setDisconnectGate(_ gate: AsyncGate?) {
        disconnectGate = gate
    }

    func connectPaired(
        serverID: String,
        endpoint: HostEndpoint?
    ) async throws -> PairedHost {
        switch connectPairedResult {
        case .success(let host):
            return PairedHost(
                serverID: serverID,
                serverName: host.serverName,
                endpoint: endpoint ?? host.endpoint,
                clientID: host.clientID,
                token: host.token
            )
        case .failure(let error):
            throw error
        }
    }

    func connectForPairing(endpoint: HostEndpoint) async throws {
        _ = endpoint
        connectForPairingInvocationCount += 1
    }

    func pair(code: String) async throws -> PairedHost {
        _ = code
        pairInvocationCount += 1
        switch pairResult {
        case .success(let host):
            return host
        case .failure(let error):
            throw error
        }
    }

    func waitForWorkspaceReady() async throws {
        try await readinessGate?.wait()
    }

    func stopDiscovery() async {
        stopInvocationCount += 1
        try? await stopGate?.wait()
    }

    func disconnect() async {
        disconnectInvocationCount += 1
        try? await disconnectGate?.wait()
    }

    func stopCount() -> Int {
        stopInvocationCount
    }

    func disconnectCount() -> Int {
        disconnectInvocationCount
    }

    func connectForPairingCount() -> Int {
        connectForPairingInvocationCount
    }

    func pairCount() -> Int {
        pairInvocationCount
    }
}

private struct AppModelTestFailure: LocalizedError, Equatable, Sendable {
    let message: String

    init(_ message: String) {
        self.message = message
    }

    var errorDescription: String? { message }
}

private actor AsyncGate {
    private var didStart = false
    private var didCancel = false
    private var continuation: CheckedContinuation<Void, any Error>?

    func wait() async throws {
        didStart = true
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
            }
        } onCancel: {
            Task { await self.cancel() }
        }
    }

    func waitUntilStarted(timeout: TimeInterval = 1) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !didStart {
            if Date() >= deadline {
                return
            }
            await Task.yield()
        }
    }

    func succeed() {
        continuation?.resume()
        continuation = nil
    }

    func fail(_ error: any Error) {
        continuation?.resume(throwing: error)
        continuation = nil
    }

    private func cancel() {
        didCancel = true
        continuation?.resume(throwing: CancellationError())
        continuation = nil
    }
}
