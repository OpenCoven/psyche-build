import Foundation
import PsycheCore
import XCTest
@testable import Psyche_Build

private let testFingerprint = String(repeating: "a", count: 64)
private let otherFingerprint = String(repeating: "b", count: 64)

@MainActor
final class PairHostModelTests: XCTestCase {
    func testFixturePublishesDeterministicRowsAndConnectsPairedStudio() async {
        let model = PairHostModel.fixture()

        await model.start()
        await waitUntil { model.rows.count == 4 }

        XCTAssertEqual(model.rows.map(\.serverID), ["changed-host", "new-host", "offline-host", "studio"])
        XCTAssertEqual(model.rows.map(\.pairingStatus), [.requiresRePairing, .unpaired, .unpaired, .paired])

        model.select(serverID: "studio")
        await model.submit()

        XCTAssertEqual(model.phase, .ready)
        XCTAssertEqual(
            model.readyHost,
            makePairedHost(
                serverID: "studio",
                serverName: "Studio",
                endpoint: HostEndpoint(
                    host: "studio.local",
                    port: 4242,
                    certificateFingerprint: testFingerprint
                ),
                clientID: "fixture-client",
                token: "fixture-token"
            )
        )
    }

    func testFixtureChangedHostRequiresConfirmationAndCompletesDeterministicRePairing() async {
        let model = PairHostModel.fixture()

        await model.start()
        await waitUntil { model.rows.count == 4 }

        model.select(serverID: "changed-host")
        model.pairingCode = "123456"

        await model.submit()
        XCTAssertEqual(model.phase, .confirmingRePair)

        await model.confirmRePairing()

        XCTAssertEqual(model.phase, .ready)
        XCTAssertEqual(model.readyHost?.serverID, "changed-host")
        XCTAssertEqual(model.readyHost?.serverName, "Changed Host")
        XCTAssertEqual(model.readyHost?.clientID, "fixture-client")
        XCTAssertEqual(model.readyHost?.token, "fixture-token")
    }

    func testComputedSelectedStateCoversPairedUnpairedRepairAndResolutionFailedRows() async throws {
        let probe = PairHostModelProbe()
        await probe.setPairingStatus(.paired, for: "paired")
        await probe.setPairingStatus(.unpaired, for: "unpaired")
        await probe.setPairingStatus(.requiresRePairing, for: "repair")
        let model = PairHostModel(dependencies: await probe.dependencies())

        await model.start()
        await probe.yield([
            makeEntry(serverID: "paired", serverName: "Paired Host"),
            makeEntry(serverID: "unpaired", serverName: "Unpaired Host"),
            makeEntry(
                serverID: "repair",
                serverName: "Repair Host",
                fingerprint: otherFingerprint
            ),
            makeFailedEntry(serverID: "offline", serverName: "Offline Host", failure: .timedOut)
        ])
        await waitUntil { model.rows.count == 4 }

        model.select(serverID: "paired")
        XCTAssertEqual(model.selectedRow?.serverID, "paired")
        XCTAssertEqual(model.selectedActionMessage, "This device already trusts Paired Host.")
        XCTAssertFalse(model.selectedRequiresPairingCode)
        XCTAssertFalse(model.selectedShowsRePairWarning)
        XCTAssertEqual(model.primaryActionTitle, "Connect")
        XCTAssertFalse(model.showsPairingCodeField)
        XCTAssertTrue(model.canSubmitSelectedAction)

        model.select(serverID: "unpaired")
        XCTAssertEqual(model.selectedRow?.serverID, "unpaired")
        XCTAssertEqual(
            model.selectedActionMessage,
            "Enter the six-digit code shown by Unpaired Host to trust and connect to it."
        )
        XCTAssertTrue(model.selectedRequiresPairingCode)
        XCTAssertFalse(model.selectedShowsRePairWarning)
        XCTAssertEqual(model.primaryActionTitle, "Pair")
        XCTAssertTrue(model.showsPairingCodeField)
        XCTAssertTrue(model.canSubmitSelectedAction)

        model.select(serverID: "repair")
        XCTAssertEqual(model.selectedRow?.serverID, "repair")
        XCTAssertEqual(
            model.selectedActionMessage,
            "Enter a new code, then review the certificate-change warning before re-pairing."
        )
        XCTAssertTrue(model.selectedRequiresPairingCode)
        XCTAssertTrue(model.selectedShowsRePairWarning)
        XCTAssertEqual(model.primaryActionTitle, "Review re-pair warning")
        XCTAssertTrue(model.showsPairingCodeField)
        XCTAssertTrue(model.canSubmitSelectedAction)

        model.select(serverID: "offline")
        XCTAssertEqual(model.selectedRow?.serverID, "offline")
        XCTAssertEqual(
            model.selectedActionMessage,
            "This host was discovered, but its network address is unavailable right now."
        )
        XCTAssertFalse(model.selectedRequiresPairingCode)
        XCTAssertFalse(model.selectedShowsRePairWarning)
        XCTAssertEqual(model.primaryActionTitle, "Address unavailable")
        XCTAssertFalse(model.showsPairingCodeField)
        XCTAssertFalse(model.canSubmitSelectedAction)
    }

    func testComputedManualStateKeepsSubmitEnabledForValidationFailures() async {
        let model = PairHostModel.fixture()

        model.setManualEntrySelected(true)

        XCTAssertTrue(model.showManualEntry)
        XCTAssertNil(model.selectedRow)
        XCTAssertEqual(model.primaryActionTitle, "Pair")
        XCTAssertTrue(model.showsPairingCodeField)
        XCTAssertTrue(model.canSubmitPrimaryAction)
        XCTAssertFalse(model.isActionInProgress)

        await model.submit()

        XCTAssertEqual(model.phase, .failed)
        XCTAssertEqual(model.errorMessage, "Enter the host name or IP address.")
    }

    func testDiscoveryRowsMergeResolvedAndFailedEntriesInStableServerIDOrder() async throws {
        let probe = PairHostModelProbe()
        await probe.setPairingStatus(.paired, for: "server-b")
        await probe.setPairingStatus(.requiresRePairing, for: "server-c")
        let model = PairHostModel(dependencies: await probe.dependencies())

        await model.start()
        await probe.yield([
            makeEntry(serverID: "server-c", serverName: "Gamma"),
            makeFailedEntry(serverID: "server-a", serverName: "Alpha", failure: .timedOut),
            makeEntry(serverID: "server-b", serverName: "Beta")
        ])

        await waitUntil { model.rows.count == 3 }

        XCTAssertEqual(model.phase, .browsing)
        XCTAssertEqual(model.rows.map(\.serverID), ["server-a", "server-b", "server-c"])
        XCTAssertEqual(model.rows.map(\.pairingStatus), [.unpaired, .paired, .requiresRePairing])
        XCTAssertEqual(model.rows[0].resolutionFailure, .timedOut)
        XCTAssertNil(model.rows[0].resolvedEndpoint)
        XCTAssertEqual(model.rows[1].serverName, "Beta")
        XCTAssertEqual(model.rows[1].resolvedEndpoint?.host, "server-b.local")
    }

    func testSameNameHostsPublishDistinctVisibleDiscriminators() async throws {
        let probe = PairHostModelProbe()
        let model = PairHostModel(dependencies: await probe.dependencies())

        await model.start()
        await probe.yield([
            makeEntry(
                serverID: "studio-111111",
                serverName: "Studio",
                host: "studio.local",
                port: 4242
            ),
            makeEntry(
                serverID: "studio-222222",
                serverName: "Studio",
                host: "studio.local",
                port: 4242
            ),
            makeFailedEntry(
                serverID: "studio-333333",
                serverName: "Studio",
                failure: .timedOut
            )
        ])

        await waitUntil { model.rows.count == 3 }

        XCTAssertEqual(
            model.rows.map(\.discriminator),
            [
                "studio.local:4242 • …111111",
                "studio.local:4242 • …222222",
                "…333333"
            ]
        )
        XCTAssertNotEqual(model.rows[0].discriminator, model.rows[1].discriminator)
    }

    func testStatusLookupFailureIsExplicitAndLaterValidSnapshotRecoversWhenIdle() async throws {
        let probe = PairHostModelProbe()
        await probe.setPairingStatusResults(
            [.failure(TestFailure("Stored pairing data is unavailable")), .success(.paired)],
            for: "server-a"
        )
        let model = PairHostModel(dependencies: await probe.dependencies())
        let snapshot = [makeEntry(serverID: "server-a", serverName: "Alpha")]

        await model.start()
        await probe.yield(snapshot)

        await waitUntil { model.phase == .failed }
        XCTAssertEqual(model.errorMessage, "Stored pairing data is unavailable")

        await probe.yield(snapshot)

        await waitUntil {
            model.phase == .browsing &&
                model.errorMessage == nil &&
                model.rows.count == 1
        }
        XCTAssertEqual(model.rows.first?.pairingStatus, .paired)
    }

    func testSelectionIsRetainedOnCompatibleRefreshAndClearedWhenServiceDisappearsWhileIdle() async throws {
        let probe = PairHostModelProbe()
        let model = PairHostModel(dependencies: await probe.dependencies())

        await model.start()
        await probe.yield([makeEntry(serverID: "server-a", serverName: "Alpha", host: "alpha.local")])
        await waitUntil { model.rows.count == 1 }

        model.select(serverID: "server-a")
        XCTAssertEqual(model.phase, .selected)

        await probe.yield([makeEntry(serverID: "server-a", serverName: "Alpha", host: "alpha-2.local")])
        await waitUntil { model.rows.first?.resolvedEndpoint?.host == "alpha-2.local" }

        XCTAssertEqual(model.selectedServerID, "server-a")
        XCTAssertEqual(model.phase, .selected)

        await probe.yield([])
        await waitUntil { model.selectedServerID == nil }

        XCTAssertEqual(model.phase, .browsing)
    }

    func testSelectingDifferentHostDuringActiveConnectKeepsOriginalSelectionPhaseAndReadyHost() async throws {
        let probe = PairHostModelProbe()
        let connectGate = AsyncGate()
        let readinessGate = AsyncGate()
        let readyHost = makePairedHost(serverID: "server-a", serverName: "Alpha")
        await probe.setPairingStatus(.paired, for: "server-a")
        await probe.setPairingStatus(.paired, for: "server-b")
        await probe.setConnectPairedGate(connectGate)
        await probe.setReadinessGate(readinessGate)
        await probe.setConnectPairedResult(.success(readyHost))
        let model = PairHostModel(dependencies: await probe.dependencies())

        await model.start()
        await probe.yield([
            makeEntry(serverID: "server-a", serverName: "Alpha"),
            makeEntry(serverID: "server-b", serverName: "Beta")
        ])
        await waitUntil { model.rows.count == 2 }
        model.select(serverID: "server-a")

        let submitTask = Task { await model.submit() }
        await connectGate.waitUntilStarted()
        await waitUntil { model.phase == .connecting }

        model.select(serverID: "server-b")

        XCTAssertEqual(model.selectedServerID, "server-a")
        XCTAssertEqual(model.phase, .connecting)

        await connectGate.succeed()
        await readinessGate.waitUntilStarted()
        await waitUntil { model.phase == .loadingWorkspace }
        await readinessGate.succeed()
        await submitTask.value

        XCTAssertEqual(model.phase, .ready)
        XCTAssertEqual(model.readyHost, readyHost)
    }

    func testSelectingManualEntryDuringActiveConnectKeepsOriginalSelectionPhaseAndReadyHost() async throws {
        let probe = PairHostModelProbe()
        let connectGate = AsyncGate()
        let readinessGate = AsyncGate()
        let readyHost = makePairedHost(serverID: "server-a", serverName: "Alpha")
        await probe.setPairingStatus(.paired, for: "server-a")
        await probe.setConnectPairedGate(connectGate)
        await probe.setReadinessGate(readinessGate)
        await probe.setConnectPairedResult(.success(readyHost))
        let model = PairHostModel(dependencies: await probe.dependencies())

        await model.start()
        await probe.yield([makeEntry(serverID: "server-a", serverName: "Alpha")])
        await waitUntil { model.rows.count == 1 }
        model.select(serverID: "server-a")

        let submitTask = Task { await model.submit() }
        await connectGate.waitUntilStarted()
        await waitUntil { model.phase == .connecting }

        model.setManualEntrySelected(true)

        XCTAssertFalse(model.showManualEntry)
        XCTAssertEqual(model.selectedServerID, "server-a")
        XCTAssertEqual(model.phase, .connecting)

        await connectGate.succeed()
        await readinessGate.waitUntilStarted()
        await waitUntil { model.phase == .loadingWorkspace }
        await readinessGate.succeed()
        await submitTask.value

        XCTAssertEqual(model.phase, .ready)
        XCTAssertEqual(model.readyHost, readyHost)
    }

    func testStartTwiceStartsDiscoveryAndObservationExactlyOnce() async throws {
        let probe = PairHostModelProbe()
        let model = PairHostModel(dependencies: await probe.dependencies())

        await model.start()
        await model.start()
        await probe.yield([makeEntry(serverID: "server-a", serverName: "Alpha")])

        await waitUntil { model.rows.count == 1 }

        let startCount = await probe.startCount()
        let pairingStatusCalls = await probe.recordedPairingStatusCalls()
        XCTAssertEqual(startCount, 1)
        XCTAssertEqual(pairingStatusCalls, [.init(serverID: "server-a", fingerprint: testFingerprint)])
    }

    func testRetryDelegatesOneIDMarksAndClearsRetryStateAndLeavesOtherRowsAndSelectionIntact() async throws {
        let probe = PairHostModelProbe()
        let retryGate = AsyncGate()
        await probe.setRetryGate(retryGate, for: "server-a")
        let model = PairHostModel(dependencies: await probe.dependencies())

        await model.start()
        await probe.yield([
            makeEntry(serverID: "server-a", serverName: "Alpha"),
            makeEntry(serverID: "server-b", serverName: "Beta")
        ])
        await waitUntil { model.rows.count == 2 }
        model.select(serverID: "server-b")

        model.retry(serverID: "server-a")
        await retryGate.waitUntilStarted()
        await waitUntil { model.retryingServerIDs.contains("server-a") }

        XCTAssertTrue(model.retryingServerIDs.contains("server-a"))
        XCTAssertFalse(model.retryingServerIDs.contains("server-b"))
        XCTAssertEqual(model.selectedServerID, "server-b")

        await retryGate.succeed()
        await waitUntil { model.retryingServerIDs.isEmpty }

        let retryCalls = await probe.recordedRetryCalls()
        XCTAssertEqual(retryCalls, ["server-a"])
        XCTAssertEqual(model.selectedServerID, "server-b")
    }

    func testPairedHostConnectsWithResolvedEndpointSkipsPairAndBecomesReadyOnlyAfterWorkspaceReadiness() async throws {
        let probe = PairHostModelProbe()
        let connectGate = AsyncGate()
        let readinessGate = AsyncGate()
        let endpoint = HostEndpoint(
            host: "alpha.local",
            port: 4242,
            certificateFingerprint: testFingerprint
        )
        let readyHost = makePairedHost(
            serverID: "server-a",
            serverName: "Alpha",
            endpoint: endpoint,
            token: "token-1"
        )
        await probe.setPairingStatus(.paired, for: "server-a")
        await probe.setConnectPairedGate(connectGate)
        await probe.setReadinessGate(readinessGate)
        await probe.setConnectPairedResult(.success(readyHost))
        let model = PairHostModel(dependencies: await probe.dependencies())

        await model.start()
        await probe.yield([makeEntry(serverID: "server-a", serverName: "Alpha", host: "alpha.local")])
        await waitUntil { model.rows.count == 1 }
        model.select(serverID: "server-a")

        let submitTask = Task { await model.submit() }
        await connectGate.waitUntilStarted()
        await waitUntil { model.phase == .connecting }
        XCTAssertNil(model.readyHost)

        await connectGate.succeed()
        await readinessGate.waitUntilStarted()
        await waitUntil { model.phase == .loadingWorkspace }
        XCTAssertNil(model.readyHost)

        let connectPairedCalls = await probe.recordedConnectPairedCalls()
        let pairCalls = await probe.recordedPairCalls()
        XCTAssertEqual(connectPairedCalls, [.init(serverID: "server-a", endpoint: endpoint)])
        XCTAssertTrue(pairCalls.isEmpty)

        await readinessGate.succeed()
        await submitTask.value

        XCTAssertEqual(model.phase, .ready)
        XCTAssertEqual(model.readyHost, readyHost)
    }

    func testUnpairedHostValidatesCodeRunsPairingPathInOrderAndBecomesReadyAfterWorkspaceReadiness() async throws {
        let probe = PairHostModelProbe()
        let connectGate = AsyncGate()
        let pairGate = AsyncGate()
        let readinessGate = AsyncGate()
        let endpoint = HostEndpoint(
            host: "alpha.local",
            port: 4242,
            certificateFingerprint: testFingerprint
        )
        let pairedHost = makePairedHost(serverID: "server-a", serverName: "Alpha", endpoint: endpoint)
        await probe.setConnectForPairingGate(connectGate)
        await probe.setPairGate(pairGate)
        await probe.setReadinessGate(readinessGate)
        await probe.setPairResult(.success(pairedHost))
        let model = PairHostModel(dependencies: await probe.dependencies())

        await model.start()
        await probe.yield([makeEntry(serverID: "server-a", serverName: "Alpha", host: "alpha.local")])
        await waitUntil { model.rows.count == 1 }
        model.select(serverID: "server-a")
        model.pairingCode = "123456"

        let submitTask = Task { await model.submit() }
        await connectGate.waitUntilStarted()
        await waitUntil { model.phase == .connecting }
        XCTAssertTrue(model.isActionInProgress)
        XCTAssertFalse(model.canSubmitSelectedAction)
        XCTAssertFalse(model.canSubmitPrimaryAction)

        await connectGate.succeed()
        await pairGate.waitUntilStarted()
        await waitUntil { model.phase == .pairing }
        XCTAssertTrue(model.isActionInProgress)
        XCTAssertFalse(model.canSubmitSelectedAction)
        XCTAssertFalse(model.canSubmitPrimaryAction)

        await pairGate.succeed()
        await readinessGate.waitUntilStarted()
        await waitUntil { model.phase == .loadingWorkspace }
        XCTAssertTrue(model.isActionInProgress)
        XCTAssertFalse(model.canSubmitSelectedAction)
        XCTAssertFalse(model.canSubmitPrimaryAction)

        let actionOrder = await probe.recordedActionOrder()
        XCTAssertEqual(actionOrder, ["connectForPairing", "pair", "waitForWorkspaceReady"])

        await readinessGate.succeed()
        await submitTask.value

        XCTAssertEqual(model.phase, .ready)
        XCTAssertEqual(model.readyHost, pairedHost)
        XCTAssertEqual(model.pairingCode, "")
    }

    func testUnpairedHostWithInvalidPairingCodeClearsCodeAndFailsLocallyWithoutConnecting() async throws {
        let probe = PairHostModelProbe()
        let model = PairHostModel(dependencies: await probe.dependencies())

        await model.start()
        await probe.yield([makeEntry(serverID: "server-a", serverName: "Alpha", host: "alpha.local")])
        await waitUntil { model.rows.count == 1 }
        model.select(serverID: "server-a")
        model.pairingCode = "12345"

        await model.submit()

        XCTAssertEqual(model.phase, .failed)
        XCTAssertEqual(model.errorMessage, "The pairing code must contain exactly six digits.")
        XCTAssertEqual(model.pairingCode, "")
        let connectForPairingCalls = await probe.recordedConnectForPairingCalls()
        let pairCalls = await probe.recordedPairCalls()
        XCTAssertTrue(connectForPairingCalls.isEmpty)
        XCTAssertTrue(pairCalls.isEmpty)
    }

    func testManualSubmitWithInvalidPairingCodeClearsCodeAndDoesNotConnect() async throws {
        let probe = PairHostModelProbe()
        let model = PairHostModel(dependencies: await probe.dependencies())

        model.setManualEntrySelected(true)
        model.manualHost = "manual.local"
        model.manualPort = "4242"
        model.manualFingerprint = otherFingerprint
        model.pairingCode = "12345"

        await model.submit()

        XCTAssertEqual(model.phase, .failed)
        XCTAssertEqual(model.errorMessage, "The pairing code must contain exactly six digits.")
        XCTAssertEqual(model.pairingCode, "")
        let connectForPairingCalls = await probe.recordedConnectForPairingCalls()
        let pairCalls = await probe.recordedPairCalls()
        XCTAssertTrue(connectForPairingCalls.isEmpty)
        XCTAssertTrue(pairCalls.isEmpty)
    }

    func testChangedFingerprintRequiresExplicitConfirmationBeforeRePairAndCancelReturnsToSelected() async throws {
        let probe = PairHostModelProbe()
        let readinessGate = AsyncGate()
        let endpoint = HostEndpoint(
            host: "alpha.local",
            port: 4242,
            certificateFingerprint: otherFingerprint
        )
        let pairedHost = makePairedHost(serverID: "server-a", serverName: "Alpha", endpoint: endpoint)
        await probe.setPairingStatus(.requiresRePairing, for: "server-a")
        await probe.setPairResult(.success(pairedHost))
        await probe.setReadinessGate(readinessGate)
        let model = PairHostModel(dependencies: await probe.dependencies())

        await model.start()
        await probe.yield([
            makeEntry(
                serverID: "server-a",
                serverName: "Alpha",
                host: "alpha.local",
                fingerprint: otherFingerprint
            )
        ])
        await waitUntil { model.rows.count == 1 }
        model.select(serverID: "server-a")
        model.pairingCode = "123456"

        await model.submit()

        XCTAssertEqual(model.phase, .confirmingRePair)
        let initialPairingCalls = await probe.recordedConnectForPairingCalls()
        XCTAssertTrue(initialPairingCalls.isEmpty)

        model.cancelRePairingConfirmation()
        XCTAssertEqual(model.phase, .selected)

        await model.submit()
        XCTAssertEqual(model.phase, .confirmingRePair)

        let confirmTask = Task { await model.confirmRePairing() }
        await readinessGate.waitUntilStarted()
        await waitUntil { model.phase == .loadingWorkspace }

        await readinessGate.succeed()
        await confirmTask.value

        let actionOrder = await probe.recordedActionOrder()
        XCTAssertEqual(actionOrder, ["connectForPairing", "pair", "waitForWorkspaceReady"])
        XCTAssertEqual(model.phase, .ready)
        XCTAssertEqual(model.readyHost, pairedHost)
    }

    func testStaleRePairConfirmationAfterStatusChangeDoesNotConnect() async throws {
        let probe = PairHostModelProbe()
        let snapshot = [
            makeEntry(
                serverID: "server-a",
                serverName: "Alpha",
                host: "alpha.local",
                fingerprint: otherFingerprint
            )
        ]
        await probe.setPairingStatusResults(
            [.success(.requiresRePairing), .success(.paired)],
            for: "server-a"
        )
        let model = PairHostModel(dependencies: await probe.dependencies())

        await model.start()
        await probe.yield(snapshot)
        await waitUntil { model.rows.first?.pairingStatus == .requiresRePairing }
        model.select(serverID: "server-a")
        model.pairingCode = "123456"

        await model.submit()
        XCTAssertEqual(model.phase, .confirmingRePair)

        await probe.yield(snapshot)
        await waitUntil { model.rows.first?.pairingStatus == .paired }

        await model.confirmRePairing()

        XCTAssertEqual(model.phase, .failed)
        XCTAssertEqual(
            model.errorMessage,
            "This host is no longer ready to re-pair. Retry discovery or use manual entry."
        )
        let connectForPairingCalls = await probe.recordedConnectForPairingCalls()
        let pairCalls = await probe.recordedPairCalls()
        XCTAssertTrue(connectForPairingCalls.isEmpty)
        XCTAssertTrue(pairCalls.isEmpty)
    }

    func testRePairConfirmationWithInvalidPairingCodeClearsCodeAndDoesNotConnect() async throws {
        let probe = PairHostModelProbe()
        await probe.setPairingStatus(.requiresRePairing, for: "server-a")
        let model = PairHostModel(dependencies: await probe.dependencies())

        await model.start()
        await probe.yield([
            makeEntry(
                serverID: "server-a",
                serverName: "Alpha",
                host: "alpha.local",
                fingerprint: otherFingerprint
            )
        ])
        await waitUntil { model.rows.count == 1 }
        model.select(serverID: "server-a")
        model.pairingCode = "123456"

        await model.submit()
        XCTAssertEqual(model.phase, .confirmingRePair)

        model.pairingCode = "12345"
        await model.confirmRePairing()

        XCTAssertEqual(model.phase, .failed)
        XCTAssertEqual(model.errorMessage, "The pairing code must contain exactly six digits.")
        XCTAssertEqual(model.pairingCode, "")
        let connectForPairingCalls = await probe.recordedConnectForPairingCalls()
        let pairCalls = await probe.recordedPairCalls()
        XCTAssertTrue(connectForPairingCalls.isEmpty)
        XCTAssertTrue(pairCalls.isEmpty)
    }

    func testManualInvalidFieldsFailLocallyAndValidManualSubmitUsesNormalizedEndpointAndPairingPath() async throws {
        let probe = PairHostModelProbe()
        let readinessGate = AsyncGate()
        let endpoint = HostEndpoint(
            host: "manual.local",
            port: 4242,
            certificateFingerprint: otherFingerprint
        )
        let pairedHost = makePairedHost(serverID: "manual-server", serverName: "Manual Host", endpoint: endpoint)
        await probe.setPairResult(.success(pairedHost))
        await probe.setReadinessGate(readinessGate)
        let model = PairHostModel(dependencies: await probe.dependencies())

        model.setManualEntrySelected(true)
        model.manualHost = "bad host"
        model.manualPort = "70000"
        model.manualFingerprint = "not-a-fingerprint"
        model.pairingCode = "12"

        await model.submit()

        XCTAssertEqual(model.phase, .failed)
        XCTAssertNotNil(model.errorMessage)
        let initialConnectForPairingCalls = await probe.recordedConnectForPairingCalls()
        let initialPairCalls = await probe.recordedPairCalls()
        XCTAssertTrue(initialConnectForPairingCalls.isEmpty)
        XCTAssertTrue(initialPairCalls.isEmpty)

        model.manualHost = "  manual.local  "
        model.manualPort = " 4242 "
        model.manualFingerprint = otherFingerprint.uppercased().chunked(by: 2).joined(separator: ":")
        model.pairingCode = "123456"

        let submitTask = Task { await model.submit() }
        await readinessGate.waitUntilStarted()
        await waitUntil { model.phase == .loadingWorkspace }

        await readinessGate.succeed()
        await submitTask.value

        let connectForPairingCalls = await probe.recordedConnectForPairingCalls()
        let manualActionOrder = await probe.recordedActionOrder()
        XCTAssertEqual(connectForPairingCalls, [.init(endpoint: endpoint)])
        XCTAssertEqual(manualActionOrder, ["connectForPairing", "pair", "waitForWorkspaceReady"])
        XCTAssertEqual(model.manualHost, "manual.local")
        XCTAssertEqual(model.manualPort, "4242")
        XCTAssertEqual(model.manualFingerprint, otherFingerprint)
        XCTAssertEqual(model.phase, .ready)
        XCTAssertEqual(model.readyHost, pairedHost)
    }

    func testResolutionFailedRowCannotConnectAndExposesRetryOrManualGuidance() async throws {
        let probe = PairHostModelProbe()
        let model = PairHostModel(dependencies: await probe.dependencies())

        await model.start()
        await probe.yield([
            makeFailedEntry(serverID: "server-a", serverName: "Alpha", failure: .unresolved)
        ])
        await waitUntil { model.rows.count == 1 }
        model.select(serverID: "server-a")
        model.pairingCode = "123456"

        await model.submit()

        XCTAssertEqual(model.phase, .failed)
        XCTAssertTrue(model.errorMessage?.contains("Retry") == true)
        XCTAssertTrue(model.errorMessage?.localizedCaseInsensitiveContains("manual") == true)
        let connectForPairingCalls = await probe.recordedConnectForPairingCalls()
        let connectPairedCalls = await probe.recordedConnectPairedCalls()
        XCTAssertTrue(connectForPairingCalls.isEmpty)
        XCTAssertTrue(connectPairedCalls.isEmpty)
    }

    func testReadinessFailureClearsCodeRetainsValidatedManualFieldsAndDoesNotSetReadyHost() async throws {
        let probe = PairHostModelProbe()
        let readinessGate = AsyncGate()
        let readinessError = TestFailure("Workspace never became ready")
        let endpoint = HostEndpoint(
            host: "manual.local",
            port: 4242,
            certificateFingerprint: otherFingerprint
        )
        await probe.setPairResult(.success(makePairedHost(
            serverID: "manual-server",
            serverName: "Manual Host",
            endpoint: endpoint
        )))
        await probe.setReadinessGate(readinessGate)
        let model = PairHostModel(dependencies: await probe.dependencies())

        model.setManualEntrySelected(true)
        model.manualHost = " manual.local "
        model.manualPort = "4242"
        model.manualFingerprint = otherFingerprint
        model.pairingCode = "123456"

        let submitTask = Task { await model.submit() }
        await readinessGate.waitUntilStarted()
        await waitUntil { model.phase == .loadingWorkspace }

        await readinessGate.fail(readinessError)
        await submitTask.value

        XCTAssertEqual(model.phase, .failed)
        XCTAssertEqual(model.errorMessage, readinessError.localizedDescription)
        XCTAssertEqual(model.pairingCode, "")
        XCTAssertEqual(model.manualHost, "manual.local")
        XCTAssertEqual(model.manualPort, "4242")
        XCTAssertEqual(model.manualFingerprint, otherFingerprint)
        XCTAssertNil(model.readyHost)
    }

    func testDuplicateSubmitDoesNotLaunchDuplicateConnections() async throws {
        let probe = PairHostModelProbe()
        let connectGate = AsyncGate()
        let readinessGate = AsyncGate()
        let endpoint = HostEndpoint(
            host: "alpha.local",
            port: 4242,
            certificateFingerprint: testFingerprint
        )
        await probe.setPairingStatus(.paired, for: "server-a")
        await probe.setConnectPairedGate(connectGate)
        await probe.setReadinessGate(readinessGate)
        await probe.setConnectPairedResult(.success(makePairedHost(
            serverID: "server-a",
            serverName: "Alpha",
            endpoint: endpoint
        )))
        let model = PairHostModel(dependencies: await probe.dependencies())

        await model.start()
        await probe.yield([makeEntry(serverID: "server-a", serverName: "Alpha")])
        await waitUntil { model.rows.count == 1 }
        model.select(serverID: "server-a")

        let firstSubmit = Task { await model.submit() }
        await connectGate.waitUntilStarted()
        await waitUntil { model.phase == .connecting }

        await model.submit()
        let connectPairedCalls = await probe.recordedConnectPairedCalls()
        XCTAssertEqual(connectPairedCalls.count, 1)

        await connectGate.succeed()
        await readinessGate.waitUntilStarted()
        await readinessGate.succeed()
        await firstSubmit.value
    }

    func testCancelledStaleActionCompletionCannotOverwriteNewerSelectedState() async throws {
        let probe = PairHostModelProbe()
        let deferredConnect = DeferredThrowingValue<PairedHost>()
        await probe.setPairingStatus(.paired, for: "server-a")
        await probe.setConnectPairedDeferredResult(deferredConnect)
        let model = PairHostModel(dependencies: await probe.dependencies())

        await model.start()
        await probe.yield([makeEntry(serverID: "server-a", serverName: "Alpha")])
        await waitUntil { model.rows.count == 1 }
        model.select(serverID: "server-a")

        let submitTask = Task { await model.submit() }
        await deferredConnect.waitUntilStarted()
        await waitUntil { model.phase == .connecting }

        await model.stop()
        model.select(serverID: "server-a")
        XCTAssertEqual(model.phase, .selected)

        await deferredConnect.fail(TestFailure("Stale connect failure"))
        await submitTask.value

        XCTAssertEqual(model.phase, .selected)
        XCTAssertNil(model.errorMessage)
        XCTAssertNil(model.readyHost)
    }

    func testConcurrentStopCallsShareOneCleanupAndBothAwaitCompletion() async throws {
        let probe = PairHostModelProbe()
        let stopGate = AsyncGate()
        let disconnectGate = AsyncGate()
        let readinessGate = AsyncGate()
        let completions = CompletionTracker()
        let endpoint = HostEndpoint(
            host: "alpha.local",
            port: 4242,
            certificateFingerprint: testFingerprint
        )
        await probe.setPairingStatus(.paired, for: "server-a")
        await probe.setConnectPairedResult(.success(makePairedHost(
            serverID: "server-a",
            serverName: "Alpha",
            endpoint: endpoint
        )))
        await probe.setReadinessGate(readinessGate)
        await probe.setStopGate(stopGate)
        await probe.setDisconnectGate(disconnectGate)
        let model = PairHostModel(dependencies: await probe.dependencies())

        await model.start()
        await probe.yield([makeEntry(serverID: "server-a", serverName: "Alpha")])
        await waitUntil { model.rows.count == 1 }
        model.select(serverID: "server-a")

        let submitTask = Task { await model.submit() }
        await readinessGate.waitUntilStarted()
        await waitUntil { model.phase == .loadingWorkspace }

        let firstStop = Task {
            await model.stop()
            await completions.mark("first")
        }
        let secondStop = Task {
            await model.stop()
            await completions.mark("second")
        }

        await stopGate.waitUntilStarted()
        await waitUntilAsync { await probe.stopCount() == 1 }
        let firstCompletedBeforeStop = await completions.contains("first")
        let secondCompletedBeforeStop = await completions.contains("second")
        XCTAssertFalse(firstCompletedBeforeStop)
        XCTAssertFalse(secondCompletedBeforeStop)

        await stopGate.succeed()
        await disconnectGate.waitUntilStarted()
        await waitUntilAsync { await probe.disconnectCount() == 1 }
        let firstCompletedBeforeDisconnect = await completions.contains("first")
        let secondCompletedBeforeDisconnect = await completions.contains("second")
        XCTAssertFalse(firstCompletedBeforeDisconnect)
        XCTAssertFalse(secondCompletedBeforeDisconnect)

        await disconnectGate.succeed()
        await firstStop.value
        await secondStop.value
        await submitTask.value

        let firstCompletedAfterCleanup = await completions.contains("first")
        let secondCompletedAfterCleanup = await completions.contains("second")
        let stopCount = await probe.stopCount()
        let disconnectCount = await probe.disconnectCount()
        XCTAssertTrue(firstCompletedAfterCleanup)
        XCTAssertTrue(secondCompletedAfterCleanup)
        XCTAssertEqual(stopCount, 1)
        XCTAssertEqual(disconnectCount, 1)
    }

    func testStopDuringActionCancelsOwnedWorkStopsDiscoveryAndDisconnectsIncompleteConnection() async throws {
        let probe = PairHostModelProbe()
        let readinessGate = AsyncGate()
        let endpoint = HostEndpoint(
            host: "alpha.local",
            port: 4242,
            certificateFingerprint: testFingerprint
        )
        await probe.setPairingStatus(.paired, for: "server-a")
        await probe.setConnectPairedResult(.success(makePairedHost(
            serverID: "server-a",
            serverName: "Alpha",
            endpoint: endpoint
        )))
        await probe.setReadinessGate(readinessGate)
        let model = PairHostModel(dependencies: await probe.dependencies())

        await model.start()
        await probe.yield([makeEntry(serverID: "server-a", serverName: "Alpha")])
        await waitUntil { model.rows.count == 1 }
        model.select(serverID: "server-a")
        model.pairingCode = "123456"

        let submitTask = Task { await model.submit() }
        await readinessGate.waitUntilStarted()
        await waitUntil { model.phase == .loadingWorkspace }

        await model.stop()
        await submitTask.value

        let stopCount = await probe.stopCount()
        let disconnectCount = await probe.disconnectCount()
        XCTAssertEqual(stopCount, 1)
        XCTAssertEqual(disconnectCount, 1)
        XCTAssertEqual(model.pairingCode, "")
        XCTAssertNil(model.readyHost)
    }

    func testStopDuringIncompleteConnectionWaitsForDisconnectBeforeReturning() async throws {
        let probe = PairHostModelProbe()
        let readinessGate = AsyncGate()
        let disconnectGate = AsyncGate()
        let completions = CompletionTracker()
        let endpoint = HostEndpoint(
            host: "alpha.local",
            port: 4242,
            certificateFingerprint: testFingerprint
        )
        await probe.setPairingStatus(.paired, for: "server-a")
        await probe.setConnectPairedResult(.success(makePairedHost(
            serverID: "server-a",
            serverName: "Alpha",
            endpoint: endpoint
        )))
        await probe.setReadinessGate(readinessGate)
        await probe.setDisconnectGate(disconnectGate)
        let model = PairHostModel(dependencies: await probe.dependencies())

        await model.start()
        await probe.yield([makeEntry(serverID: "server-a", serverName: "Alpha")])
        await waitUntil { model.rows.count == 1 }
        model.select(serverID: "server-a")

        let submitTask = Task { await model.submit() }
        await readinessGate.waitUntilStarted()
        await waitUntil { model.phase == .loadingWorkspace }

        let stopTask = Task {
            await model.stop()
            await completions.mark("stop")
        }

        await disconnectGate.waitUntilStarted()
        let completedBeforeDisconnect = await completions.contains("stop")
        XCTAssertFalse(completedBeforeDisconnect)

        await disconnectGate.succeed()
        await stopTask.value
        await submitTask.value

        let completedAfterDisconnect = await completions.contains("stop")
        let disconnectCount = await probe.disconnectCount()
        XCTAssertTrue(completedAfterDisconnect)
        XCTAssertEqual(disconnectCount, 1)
    }

    func testStopWhilePairedConnectIsActiveButStillBlockedDisconnectsExactlyOnce() async throws {
        let probe = PairHostModelProbe()
        let connectGate = AsyncGate()
        let endpoint = HostEndpoint(
            host: "alpha.local",
            port: 4242,
            certificateFingerprint: testFingerprint
        )
        await probe.setPairingStatus(.paired, for: "server-a")
        await probe.setConnectPairedGate(connectGate)
        await probe.setConnectPairedResult(.success(makePairedHost(
            serverID: "server-a",
            serverName: "Alpha",
            endpoint: endpoint
        )))
        let model = PairHostModel(dependencies: await probe.dependencies())

        await model.start()
        await probe.yield([makeEntry(serverID: "server-a", serverName: "Alpha", host: "alpha.local")])
        await waitUntil { model.rows.count == 1 }
        model.select(serverID: "server-a")

        let submitTask = Task { await model.submit() }
        await connectGate.waitUntilStarted()
        await waitUntil { model.phase == .connecting }

        await model.stop()
        await connectGate.waitUntilCancelled()
        await submitTask.value

        let stopCount = await probe.stopCount()
        let disconnectCount = await probe.disconnectCount()
        let connectPairedCalls = await probe.recordedConnectPairedCalls()
        XCTAssertEqual(stopCount, 1)
        XCTAssertEqual(disconnectCount, 1)
        XCTAssertEqual(connectPairedCalls, [.init(serverID: "server-a", endpoint: endpoint)])
        XCTAssertNil(model.readyHost)
    }

    func testStopWhileConnectForPairingIsActiveButStillBlockedDisconnectsExactlyOnce() async throws {
        let probe = PairHostModelProbe()
        let connectGate = AsyncGate()
        let endpoint = HostEndpoint(
            host: "alpha.local",
            port: 4242,
            certificateFingerprint: testFingerprint
        )
        await probe.setConnectForPairingGate(connectGate)
        let model = PairHostModel(dependencies: await probe.dependencies())

        await model.start()
        await probe.yield([makeEntry(serverID: "server-a", serverName: "Alpha", host: "alpha.local")])
        await waitUntil { model.rows.count == 1 }
        model.select(serverID: "server-a")
        model.pairingCode = "123456"

        let submitTask = Task { await model.submit() }
        await connectGate.waitUntilStarted()
        await waitUntil { model.phase == .connecting }

        await model.stop()
        await connectGate.waitUntilCancelled()
        await submitTask.value

        let stopCount = await probe.stopCount()
        let disconnectCount = await probe.disconnectCount()
        let connectForPairingCalls = await probe.recordedConnectForPairingCalls()
        let pairCalls = await probe.recordedPairCalls()
        XCTAssertEqual(stopCount, 1)
        XCTAssertEqual(disconnectCount, 1)
        XCTAssertEqual(connectForPairingCalls, [.init(endpoint: endpoint)])
        XCTAssertTrue(pairCalls.isEmpty)
        XCTAssertNil(model.readyHost)
    }

    func testReleasingModelAfterPairedConnectOwnsIncompleteConnectionDisconnectsExactlyOnceWithoutStop() async throws {
        let probe = PairHostModelProbe()
        let readinessGate = AsyncGate()
        let endpoint = HostEndpoint(
            host: "alpha.local",
            port: 4242,
            certificateFingerprint: testFingerprint
        )
        await probe.setPairingStatus(.paired, for: "server-a")
        await probe.setConnectPairedResult(.success(makePairedHost(
            serverID: "server-a",
            serverName: "Alpha",
            endpoint: endpoint
        )))
        await probe.setReadinessGate(readinessGate)

        weak var weakModel: PairHostModel?
        var model: PairHostModel? = PairHostModel(dependencies: await probe.dependencies())
        weakModel = model

        await model?.start()
        await probe.yield([makeEntry(serverID: "server-a", serverName: "Alpha")])
        await waitUntil { model?.rows.count == 1 }
        model?.select(serverID: "server-a")

        let submitTask = Task { [weak model] in
            await model?.submit()
        }
        await readinessGate.waitUntilStarted()
        await waitUntil { model?.phase == .loadingWorkspace }

        submitTask.cancel()
        await readinessGate.waitUntilCancelled()
        await submitTask.value
        model = nil

        await waitUntil { weakModel == nil }
        await waitUntilAsync { await probe.stopCount() == 1 }
        await waitUntilAsync { await probe.disconnectCount() == 1 }

        let disconnectCount = await probe.disconnectCount()
        XCTAssertEqual(disconnectCount, 1)
        XCTAssertNil(weakModel)
    }

    func testReleasingModelAfterConnectForPairingOwnsIncompleteConnectionDisconnectsExactlyOnceWithoutStop() async throws {
        let probe = PairHostModelProbe()
        let pairGate = AsyncGate()
        await probe.setPairGate(pairGate)

        weak var weakModel: PairHostModel?
        var model: PairHostModel? = PairHostModel(dependencies: await probe.dependencies())
        weakModel = model

        await model?.start()
        await probe.yield([makeEntry(serverID: "server-a", serverName: "Alpha")])
        await waitUntil { model?.rows.count == 1 }
        model?.select(serverID: "server-a")
        model?.pairingCode = "123456"

        let submitTask = Task { [weak model] in
            await model?.submit()
        }
        await pairGate.waitUntilStarted()
        await waitUntil { model?.phase == .pairing }

        submitTask.cancel()
        await pairGate.waitUntilCancelled()
        await submitTask.value
        model = nil

        await waitUntil { weakModel == nil }
        await waitUntilAsync { await probe.stopCount() == 1 }
        await waitUntilAsync { await probe.disconnectCount() == 1 }

        let disconnectCount = await probe.disconnectCount()
        XCTAssertEqual(disconnectCount, 1)
        XCTAssertNil(weakModel)
    }

    func testReleasingModelWithActiveDiscoveryAndActionWorkCancelsOwnedTasksAndDoesNotLeak() async throws {
        let probe = PairHostModelProbe()
        let connectGate = AsyncGate()
        let endpoint = HostEndpoint(
            host: "alpha.local",
            port: 4242,
            certificateFingerprint: testFingerprint
        )
        await probe.setPairingStatus(.paired, for: "server-a")
        await probe.setConnectPairedGate(connectGate)
        await probe.setConnectPairedResult(.success(makePairedHost(
            serverID: "server-a",
            serverName: "Alpha",
            endpoint: endpoint
        )))

        weak var weakModel: PairHostModel?
        var model: PairHostModel? = PairHostModel(dependencies: await probe.dependencies())
        weakModel = model

        await model?.start()
        await probe.yield([makeEntry(serverID: "server-a", serverName: "Alpha")])
        await waitUntil { model?.rows.count == 1 }
        model?.select(serverID: "server-a")

        let submitTask = Task { [weak model] in
            await model?.submit()
        }
        await connectGate.waitUntilStarted()
        await waitUntil { model?.phase == .connecting }

        submitTask.cancel()
        await connectGate.waitUntilCancelled()
        await submitTask.value

        model = nil

        let connectWasCancelled = await connectGate.wasCancelled()
        XCTAssertTrue(connectWasCancelled)
        await waitUntil { weakModel == nil }
        await waitUntilAsync { await probe.stopCount() == 1 }
        await waitUntilAsync { await probe.disconnectCount() == 1 }

        let stopCount = await probe.stopCount()
        let disconnectCount = await probe.disconnectCount()
        XCTAssertEqual(stopCount, 1)
        XCTAssertEqual(disconnectCount, 1)
        XCTAssertNil(weakModel)
    }

    func testOlderSessionStopSkipsSharedCleanupAfterNewerSessionClaimsAuthority() async throws {
        let authority = PairHostModel.SessionAuthority()
        let cleanup = SharedCleanupProbe()
        let readinessGateA = AsyncGate()
        let readinessGateB = AsyncGate()
        let modelA = PairHostModel(
            dependencies: sharedSessionDependencies(
                cleanup: cleanup,
                entry: makeEntry(serverID: "server-a", serverName: "Alpha"),
                readinessGate: readinessGateA
            ),
            authority: authority
        )
        let modelB = PairHostModel(
            dependencies: sharedSessionDependencies(
                cleanup: cleanup,
                entry: makeEntry(serverID: "server-b", serverName: "Beta"),
                readinessGate: readinessGateB
            ),
            authority: authority
        )

        await modelA.start()
        await waitUntil { modelA.rows.count == 1 }
        modelA.select(serverID: "server-a")
        let submitA = Task { await modelA.submit() }
        await readinessGateA.waitUntilStarted()
        await waitUntil { modelA.phase == .loadingWorkspace }

        await modelB.start()
        await waitUntil { modelB.rows.count == 1 }
        modelB.select(serverID: "server-b")
        let submitB = Task { await modelB.submit() }
        await readinessGateB.waitUntilStarted()
        await waitUntil { modelB.phase == .loadingWorkspace }

        await modelA.stop()
        await submitA.value

        let stopCountAfterAStop = await cleanup.stopCount()
        let disconnectCountAfterAStop = await cleanup.disconnectCount()
        XCTAssertEqual(stopCountAfterAStop, 0)
        XCTAssertEqual(disconnectCountAfterAStop, 0)
        XCTAssertEqual(modelB.phase, .loadingWorkspace)

        await modelB.stop()
        await submitB.value

        let finalStopCount = await cleanup.stopCount()
        let finalDisconnectCount = await cleanup.disconnectCount()
        XCTAssertEqual(finalStopCount, 1)
        XCTAssertEqual(finalDisconnectCount, 1)
    }

    func testStopDuringSessionClaimWaitsForPendingStartRelinquishesSessionAndNeverStartsDiscovery() async throws {
        let claimGate = SessionClaimGate()
        let authority = PairHostModel.SessionAuthority(beforeClaimActivation: {
            await claimGate.wait()
        })
        let firstProbe = PairHostModelProbe()
        let stopCompletion = CompletionTracker()

        weak var weakModel: PairHostModel?
        var model: PairHostModel? = PairHostModel(
            dependencies: await firstProbe.dependencies(),
            authority: authority
        )
        weakModel = model

        let startTask = Task { [weak model] in
            await model?.start()
        }
        await claimGate.waitUntilStarted()

        let stopTask = Task { [weak model] in
            await model?.stop()
            await stopCompletion.mark("stop")
        }

        await Task.yield()
        let stopFinishedBeforeRelease = await stopCompletion.contains("stop")
        let firstStartCountBeforeRelease = await firstProbe.startCount()
        XCTAssertFalse(stopFinishedBeforeRelease)
        XCTAssertEqual(firstStartCountBeforeRelease, 0)

        await claimGate.release()
        await stopTask.value
        await startTask.value

        let firstStartCountAfterRelease = await firstProbe.startCount()
        let firstStopCountAfterRelease = await firstProbe.stopCount()
        let firstDisconnectCountAfterRelease = await firstProbe.disconnectCount()
        XCTAssertEqual(firstStartCountAfterRelease, 0)
        XCTAssertEqual(firstStopCountAfterRelease, 0)
        XCTAssertEqual(firstDisconnectCountAfterRelease, 0)

        model = nil
        await waitUntil { weakModel == nil }
        let firstStopCountAfterReleaseDeinit = await firstProbe.stopCount()
        let firstDisconnectCountAfterReleaseDeinit = await firstProbe.disconnectCount()
        XCTAssertEqual(firstStopCountAfterReleaseDeinit, 0)
        XCTAssertEqual(firstDisconnectCountAfterReleaseDeinit, 0)

        let secondProbe = PairHostModelProbe()
        let secondModel = PairHostModel(
            dependencies: await secondProbe.dependencies(),
            authority: authority
        )

        await secondModel.start()
        let secondStartCount = await secondProbe.startCount()
        XCTAssertEqual(secondStartCount, 1)

        await secondModel.stop()
        let secondStopCount = await secondProbe.stopCount()
        let secondDisconnectCount = await secondProbe.disconnectCount()
        XCTAssertEqual(secondStopCount, 1)
        XCTAssertEqual(secondDisconnectCount, 0)
    }

    func testCancellingStartDuringSessionClaimRelinquishesSessionWithoutStartingDiscovery() async throws {
        let claimGate = SessionClaimGate()
        let authority = PairHostModel.SessionAuthority(beforeClaimActivation: {
            await claimGate.wait()
        })
        let probe = PairHostModelProbe()
        let startCompletion = CompletionTracker()

        weak var weakModel: PairHostModel?
        var model: PairHostModel? = PairHostModel(
            dependencies: await probe.dependencies(),
            authority: authority
        )
        weakModel = model

        let startTask = Task { [weak model] in
            await model?.start()
            await startCompletion.mark("start")
        }
        await claimGate.waitUntilStarted()

        startTask.cancel()
        await Task.yield()
        let startFinishedBeforeRelease = await startCompletion.contains("start")
        XCTAssertFalse(startFinishedBeforeRelease)

        await claimGate.release()
        await startTask.value

        let startCountAfterCancellation = await probe.startCount()
        let stopCountAfterCancellation = await probe.stopCount()
        let disconnectCountAfterCancellation = await probe.disconnectCount()
        XCTAssertEqual(startCountAfterCancellation, 0)
        XCTAssertEqual(stopCountAfterCancellation, 0)
        XCTAssertEqual(disconnectCountAfterCancellation, 0)

        model = nil
        await waitUntil { weakModel == nil }
        let stopCountAfterCancellationDeinit = await probe.stopCount()
        let disconnectCountAfterCancellationDeinit = await probe.disconnectCount()
        XCTAssertEqual(stopCountAfterCancellationDeinit, 0)
        XCTAssertEqual(disconnectCountAfterCancellationDeinit, 0)
    }

    func testReleasingOlderSessionSkipsSharedCleanupWithoutExplicitStop() async throws {
        let authority = PairHostModel.SessionAuthority()
        let cleanup = SharedCleanupProbe()
        let readinessGateA = AsyncGate()
        let readinessGateB = AsyncGate()

        weak var weakModelA: PairHostModel?
        weak var weakModelB: PairHostModel?
        var modelA: PairHostModel? = PairHostModel(
            dependencies: sharedSessionDependencies(
                cleanup: cleanup,
                entry: makeEntry(serverID: "server-a", serverName: "Alpha"),
                readinessGate: readinessGateA
            ),
            authority: authority
        )
        var modelB: PairHostModel? = PairHostModel(
            dependencies: sharedSessionDependencies(
                cleanup: cleanup,
                entry: makeEntry(serverID: "server-b", serverName: "Beta"),
                readinessGate: readinessGateB
            ),
            authority: authority
        )
        weakModelA = modelA
        weakModelB = modelB

        await modelA?.start()
        await waitUntil { modelA?.rows.count == 1 }
        modelA?.select(serverID: "server-a")
        let submitA = Task { [weak modelA] in
            await modelA?.submit()
        }
        await readinessGateA.waitUntilStarted()
        await waitUntil { modelA?.phase == .loadingWorkspace }

        await modelB?.start()
        await waitUntil { modelB?.rows.count == 1 }
        modelB?.select(serverID: "server-b")
        let submitB = Task { [weak modelB] in
            await modelB?.submit()
        }
        await readinessGateB.waitUntilStarted()
        await waitUntil { modelB?.phase == .loadingWorkspace }

        submitA.cancel()
        await readinessGateA.waitUntilCancelled()
        await submitA.value
        modelA = nil

        await waitUntil { weakModelA == nil }
        let stopCountAfterModelARelease = await cleanup.stopCount()
        let disconnectCountAfterModelARelease = await cleanup.disconnectCount()
        XCTAssertEqual(stopCountAfterModelARelease, 0)
        XCTAssertEqual(disconnectCountAfterModelARelease, 0)
        XCTAssertEqual(modelB?.phase, .loadingWorkspace)

        submitB.cancel()
        await readinessGateB.waitUntilCancelled()
        await submitB.value
        modelB = nil

        await waitUntil { weakModelB == nil }
        await waitUntilAsync { await cleanup.stopCount() == 1 }
        await waitUntilAsync { await cleanup.disconnectCount() == 1 }
        let finalStopCount = await cleanup.stopCount()
        let finalDisconnectCount = await cleanup.disconnectCount()
        XCTAssertEqual(finalStopCount, 1)
        XCTAssertEqual(finalDisconnectCount, 1)
    }

    func testStopAfterReadyDoesNotDisconnect() async throws {
        let probe = PairHostModelProbe()
        let readinessGate = AsyncGate()
        let endpoint = HostEndpoint(
            host: "alpha.local",
            port: 4242,
            certificateFingerprint: testFingerprint
        )
        let readyHost = makePairedHost(serverID: "server-a", serverName: "Alpha", endpoint: endpoint)
        await probe.setPairingStatus(.paired, for: "server-a")
        await probe.setConnectPairedResult(.success(readyHost))
        await probe.setReadinessGate(readinessGate)
        let model = PairHostModel(dependencies: await probe.dependencies())

        await model.start()
        await probe.yield([makeEntry(serverID: "server-a", serverName: "Alpha")])
        await waitUntil { model.rows.count == 1 }
        model.select(serverID: "server-a")

        let submitTask = Task { await model.submit() }
        await readinessGate.waitUntilStarted()
        await readinessGate.succeed()
        await submitTask.value

        XCTAssertEqual(model.phase, .ready)

        await model.stop()

        let stopCount = await probe.stopCount()
        let disconnectCount = await probe.disconnectCount()
        XCTAssertEqual(stopCount, 1)
        XCTAssertEqual(disconnectCount, 0)
    }

    func testReleasingReadyModelDoesNotDisconnect() async throws {
        let probe = PairHostModelProbe()
        let endpoint = HostEndpoint(
            host: "alpha.local",
            port: 4242,
            certificateFingerprint: testFingerprint
        )
        await probe.setPairingStatus(.paired, for: "server-a")
        await probe.setConnectPairedResult(.success(makePairedHost(
            serverID: "server-a",
            serverName: "Alpha",
            endpoint: endpoint
        )))

        weak var weakModel: PairHostModel?
        var model: PairHostModel? = PairHostModel(dependencies: await probe.dependencies())
        weakModel = model

        await model?.start()
        await probe.yield([makeEntry(serverID: "server-a", serverName: "Alpha")])
        await waitUntil { model?.rows.count == 1 }
        model?.select(serverID: "server-a")

        let submitTask = Task { [weak model] in
            await model?.submit()
        }
        await submitTask.value

        XCTAssertEqual(model?.phase, .ready)

        model = nil

        await waitUntil { weakModel == nil }
        await waitUntilAsync { await probe.stopCount() == 1 }

        let disconnectCount = await probe.disconnectCount()
        XCTAssertEqual(disconnectCount, 0)
        XCTAssertNil(weakModel)
    }

    func testProductionInitializerUsesProvidedCompositionGraphForStoreAndManagerClosures() async throws {
        let store = PairedHostStore(secureStore: InMemorySecureStore())
        let host = makePairedHost(serverID: "server-a", serverName: "Alpha")
        try await store.save(host)
        let composition = MobileAppComposition(
            transport: FakeTransport(),
            pairedHostStore: store,
            bonjourHostDiscovery: BonjourHostDiscovery()
        )
        let model = PairHostModel(composition: composition)

        let status = try await model.dependencies.pairingStatus(
            host.serverID,
            host.certificateFingerprint.uppercased()
        )
        await model.dependencies.disconnect()
        let connectionState = await composition.connectionManager.state
        let storedHost = try await composition.pairedHostStore.host(withServerID: host.serverID)

        XCTAssertEqual(status, .paired)
        XCTAssertEqual(connectionState, .disconnected)
        XCTAssertEqual(storedHost, host)
    }
}

private extension PairHostModelTests {
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

    func waitUntilAsync(
        timeout: TimeInterval = 1,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ condition: @escaping () async -> Bool
    ) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !(await condition()) {
            if Date() >= deadline {
                XCTFail("Timed out waiting for async condition", file: file, line: line)
                return
            }
            await Task.yield()
        }
    }

    func sharedSessionDependencies(
        cleanup: SharedCleanupProbe,
        entry: BonjourDiscoveryEntry,
        readinessGate: AsyncGate
    ) -> PairHostModel.Dependencies {
        let endpoint: HostEndpoint?
        if case let .resolved(host) = entry.availability {
            endpoint = host.endpoint
        } else {
            endpoint = nil
        }
        return PairHostModel.Dependencies(
            startDiscovery: {
                AsyncStream { continuation in
                    continuation.yield([entry])
                    continuation.finish()
                }
            },
            stopDiscovery: {
                await cleanup.recordStop()
            },
            retryDiscovery: { _ in },
            pairingStatus: { _, _ in .paired },
            connectPaired: { serverID, resolvedEndpoint in
                PairedHost(
                    serverID: serverID,
                    serverName: entry.serverName,
                    endpoint: resolvedEndpoint ?? endpoint ?? HostEndpoint(
                        host: "\(serverID).local",
                        port: 4242,
                        certificateFingerprint: testFingerprint
                    ),
                    clientID: "test-client",
                    token: "token"
                )
            },
            connectForPairing: { _ in },
            pair: { _ in
                PairedHost(
                    serverID: entry.serverID,
                    serverName: entry.serverName,
                    endpoint: endpoint ?? HostEndpoint(
                        host: "\(entry.serverID).local",
                        port: 4242,
                        certificateFingerprint: testFingerprint
                    ),
                    clientID: "test-client",
                    token: "token"
                )
            },
            waitForWorkspaceReady: {
                try await readinessGate.wait()
            },
            disconnect: {
                await cleanup.recordDisconnect()
            }
        )
    }

    func makeEntry(
        serverID: String,
        serverName: String,
        host: String? = nil,
        port: Int = 4242,
        fingerprint: String = testFingerprint
    ) -> BonjourDiscoveryEntry {
        let normalizedHost = host ?? "\(serverID).local"
        return BonjourDiscoveryEntry(
            identity: BonjourHostIdentity(
                serverID: serverID,
                serverName: serverName,
                domain: "local.",
                certificateFingerprint: fingerprint,
                supportedVersions: [PsycheProtocolVersion.current]
            ),
            availability: .resolved(DiscoveredHost(
                identity: BonjourHostIdentity(
                    serverID: serverID,
                    serverName: serverName,
                    domain: "local.",
                    certificateFingerprint: fingerprint,
                    supportedVersions: [PsycheProtocolVersion.current]
                ),
                endpoint: HostEndpoint(
                    host: normalizedHost,
                    port: port,
                    certificateFingerprint: fingerprint
                )
            ))
        )
    }

    func makeFailedEntry(
        serverID: String,
        serverName: String,
        fingerprint: String = testFingerprint,
        failure: BonjourResolutionFailure
    ) -> BonjourDiscoveryEntry {
        BonjourDiscoveryEntry(
            identity: BonjourHostIdentity(
                serverID: serverID,
                serverName: serverName,
                domain: "local.",
                certificateFingerprint: fingerprint,
                supportedVersions: [PsycheProtocolVersion.current]
            ),
            availability: .resolutionFailed(failure)
        )
    }

    func makePairedHost(
        serverID: String = "server-1",
        serverName: String = "Host",
        endpoint: HostEndpoint? = nil,
        clientID: String = "test-client",
        token: String? = "token"
    ) -> PairedHost {
        PairedHost(
            serverID: serverID,
            serverName: serverName,
            endpoint: endpoint ?? HostEndpoint(
                host: "\(serverID).local",
                port: 4242,
                certificateFingerprint: testFingerprint
            ),
            clientID: clientID,
            token: token
        )
    }
}

private struct TestFailure: LocalizedError, Equatable, Sendable {
    let message: String

    init(_ message: String) {
        self.message = message
    }

    var errorDescription: String? { message }
}

private struct StatusCall: Sendable, Equatable {
    let serverID: String
    let fingerprint: String
}

private struct ConnectPairedCall: Sendable, Equatable {
    let serverID: String
    let endpoint: HostEndpoint?
}

private struct ConnectForPairingCall: Sendable, Equatable {
    let endpoint: HostEndpoint
}

private struct PairCall: Sendable, Equatable {
    let code: String
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

    func waitUntilCancelled(timeout: TimeInterval = 1) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !didCancel {
            if Date() >= deadline {
                return
            }
            await Task.yield()
        }
    }

    func wasCancelled() -> Bool { didCancel }

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

private actor SessionClaimGate {
    private var didStart = false
    private var isReleased = false
    private var continuations: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        didStart = true
        guard !isReleased else { return }
        await withCheckedContinuation { continuation in
            continuations.append(continuation)
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

    func release() {
        isReleased = true
        let waiting = continuations
        continuations.removeAll()
        waiting.forEach { $0.resume() }
    }
}

private actor DeferredThrowingValue<Value: Sendable> {
    private var didStart = false
    private var continuation: CheckedContinuation<Value, any Error>?

    func wait() async throws -> Value {
        didStart = true
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
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

    func succeed(_ value: Value) {
        continuation?.resume(returning: value)
        continuation = nil
    }

    func fail(_ error: any Error) {
        continuation?.resume(throwing: error)
        continuation = nil
    }
}

private actor CompletionTracker {
    private var completions: Set<String> = []

    func mark(_ key: String) {
        completions.insert(key)
    }

    func contains(_ key: String) -> Bool {
        completions.contains(key)
    }
}

private actor SharedCleanupProbe {
    private var stopInvocationCount = 0
    private var disconnectInvocationCount = 0

    func recordStop() {
        stopInvocationCount += 1
    }

    func recordDisconnect() {
        disconnectInvocationCount += 1
    }

    func stopCount() -> Int { stopInvocationCount }
    func disconnectCount() -> Int { disconnectInvocationCount }
}

private actor PairHostModelProbe {
    private let stream: AsyncStream<[BonjourDiscoveryEntry]>
    private let continuation: AsyncStream<[BonjourDiscoveryEntry]>.Continuation

    private var storedPairingStatusResults: [String: [Result<PairingStatus, TestFailure>]] = [:]
    private var storedConnectPairedResult: Result<PairedHost, TestFailure> =
        .success(PairedHost(
            serverID: "paired-default",
            serverName: "Default",
            endpoint: HostEndpoint(
                host: "paired-default.local",
                port: 4242,
                certificateFingerprint: testFingerprint
            ),
            clientID: "client",
            token: "token"
        ))
    private var storedPairResult: Result<PairedHost, TestFailure> =
        .success(PairedHost(
            serverID: "pair-default",
            serverName: "Default",
            endpoint: HostEndpoint(
                host: "pair-default.local",
                port: 4242,
                certificateFingerprint: testFingerprint
            ),
            clientID: "client",
            token: "token"
        ))
    private var startInvocationCount = 0
    private var stopInvocationCount = 0
    private var disconnectInvocationCount = 0
    private var retryCalls: [String] = []
    private var pairingStatusCalls: [StatusCall] = []
    private var connectPairedCalls: [ConnectPairedCall] = []
    private var connectForPairingCalls: [ConnectForPairingCall] = []
    private var pairCalls: [PairCall] = []
    private var actionOrder: [String] = []
    private var connectPairedGate: AsyncGate?
    private var connectPairedDeferredResult: DeferredThrowingValue<PairedHost>?
    private var connectForPairingGate: AsyncGate?
    private var pairGate: AsyncGate?
    private var readinessGate: AsyncGate?
    private var stopGate: AsyncGate?
    private var disconnectGate: AsyncGate?
    private var retryGates: [String: AsyncGate] = [:]

    init() {
        let stream = AsyncStream<[BonjourDiscoveryEntry]>.makeStream()
        self.stream = stream.stream
        continuation = stream.continuation
    }

    func dependencies() -> PairHostModel.Dependencies {
        PairHostModel.Dependencies(
            startDiscovery: { await self.startDiscovery() },
            stopDiscovery: { await self.stopDiscovery() },
            retryDiscovery: { await self.retryDiscovery(serverID: $0) },
            pairingStatus: { try await self.pairingStatus(serverID: $0, fingerprint: $1) },
            connectPaired: { try await self.connectPaired(serverID: $0, endpoint: $1) },
            connectForPairing: { try await self.connectForPairing(endpoint: $0) },
            pair: { try await self.pair(code: $0) },
            waitForWorkspaceReady: { try await self.waitForWorkspaceReady() },
            disconnect: { await self.disconnect() }
        )
    }

    func yield(_ snapshot: [BonjourDiscoveryEntry]) {
        continuation.yield(snapshot)
    }

    func setPairingStatus(_ status: PairingStatus, for serverID: String) {
        storedPairingStatusResults[serverID] = [.success(status)]
    }

    func setPairingStatusResults(
        _ results: [Result<PairingStatus, TestFailure>],
        for serverID: String
    ) {
        storedPairingStatusResults[serverID] = results
    }

    func setConnectPairedResult(_ result: Result<PairedHost, TestFailure>) {
        storedConnectPairedResult = result
    }

    func setPairResult(_ result: Result<PairedHost, TestFailure>) {
        storedPairResult = result
    }

    func setConnectPairedGate(_ gate: AsyncGate?) {
        connectPairedGate = gate
    }

    func setConnectPairedDeferredResult(_ deferredResult: DeferredThrowingValue<PairedHost>?) {
        connectPairedDeferredResult = deferredResult
    }

    func setConnectForPairingGate(_ gate: AsyncGate?) {
        connectForPairingGate = gate
    }

    func setPairGate(_ gate: AsyncGate?) {
        pairGate = gate
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

    func setRetryGate(_ gate: AsyncGate, for serverID: String) {
        retryGates[serverID] = gate
    }

    func recordedRetryCalls() -> [String] { retryCalls }
    func startCount() -> Int { startInvocationCount }
    func recordedPairingStatusCalls() -> [StatusCall] { pairingStatusCalls }
    func recordedConnectPairedCalls() -> [ConnectPairedCall] { connectPairedCalls }
    func recordedConnectForPairingCalls() -> [ConnectForPairingCall] { connectForPairingCalls }
    func recordedPairCalls() -> [PairCall] { pairCalls }
    func recordedActionOrder() -> [String] { actionOrder }
    func stopCount() -> Int { stopInvocationCount }
    func disconnectCount() -> Int { disconnectInvocationCount }

    private func startDiscovery() -> AsyncStream<[BonjourDiscoveryEntry]> {
        startInvocationCount += 1
        return stream
    }

    private func stopDiscovery() async {
        stopInvocationCount += 1
        try? await stopGate?.wait()
    }

    private func retryDiscovery(serverID: String) async {
        retryCalls.append(serverID)
        if let gate = retryGates[serverID] {
            try? await gate.wait()
        }
    }

    private func pairingStatus(
        serverID: String,
        fingerprint: String
    ) throws -> PairingStatus {
        pairingStatusCalls.append(.init(serverID: serverID, fingerprint: fingerprint))
        guard var stored = storedPairingStatusResults[serverID], let result = stored.first else {
            return .unpaired
        }
        if stored.count > 1 {
            stored.removeFirst()
            storedPairingStatusResults[serverID] = stored
        }
        switch result {
        case .success(let status):
            return status
        case .failure(let error):
            throw error
        }
    }

    private func connectPaired(
        serverID: String,
        endpoint: HostEndpoint?
    ) async throws -> PairedHost {
        connectPairedCalls.append(.init(serverID: serverID, endpoint: endpoint))
        actionOrder.append("connectPaired")
        if let connectPairedDeferredResult {
            return try await connectPairedDeferredResult.wait()
        }
        try await connectPairedGate?.wait()
        switch storedConnectPairedResult {
        case .success(let host):
            return host
        case .failure(let error):
            throw error
        }
    }

    private func connectForPairing(endpoint: HostEndpoint) async throws {
        connectForPairingCalls.append(.init(endpoint: endpoint))
        actionOrder.append("connectForPairing")
        try await connectForPairingGate?.wait()
    }

    private func pair(code: String) async throws -> PairedHost {
        pairCalls.append(.init(code: code))
        actionOrder.append("pair")
        try await pairGate?.wait()
        switch storedPairResult {
        case .success(let host):
            return host
        case .failure(let error):
            throw error
        }
    }

    private func waitForWorkspaceReady() async throws {
        actionOrder.append("waitForWorkspaceReady")
        try await readinessGate?.wait()
    }

    private func disconnect() async {
        disconnectInvocationCount += 1
        try? await disconnectGate?.wait()
    }
}

private extension String {
    func chunked(by size: Int) -> [String] {
        stride(from: 0, to: count, by: size).map { start in
            let startIndex = index(self.startIndex, offsetBy: start)
            let chunkEndIndex = index(
                startIndex,
                offsetBy: size,
                limitedBy: self.endIndex
            ) ?? self.endIndex
            return String(self[startIndex..<chunkEndIndex])
        }
    }
}
