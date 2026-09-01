import Foundation
import Security
import XCTest
@testable import PsycheCore

final class PairedHostStoreTests: XCTestCase {
    private let fingerprint = "0c8893630b087f7ab19a71c016e599cebc3b5235fd449e9917a43850edddaa38"
    private let otherFingerprint = String(repeating: "b", count: 64)

    func testRoundTripsAndClearsThroughTheSecureStore() async throws {
        let secureStore = InMemorySecureStore()
        let store = PairedHostStore(secureStore: secureStore)
        let host = makeHost()

        try await store.save(host)

        let loaded = try await store.host(withServerID: "server-1")
        let all = try await store.hosts()
        XCTAssertEqual(loaded, host)
        XCTAssertEqual(all, [host])
        XCTAssertEqual(loaded?.clientID, "client-1")
        XCTAssertEqual(loaded?.token, "token-1")
        XCTAssertEqual(loaded?.endpoint.port, 4242)

        try await store.removeAll()

        let cleared = try await store.hosts()
        let clearedBlob = try secureStore.data(forKey: PairedHostStore.defaultKey)
        XCTAssertEqual(cleared, [])
        XCTAssertNil(clearedBlob)
    }

    func testSurvivesAFreshStoreOverTheSameSecureStore() async throws {
        let secureStore = InMemorySecureStore()
        try await PairedHostStore(secureStore: secureStore).save(makeHost())

        let reopened = try await PairedHostStore(secureStore: secureStore).hosts()

        XCTAssertEqual(reopened, [makeHost()])
    }

    func testSelectedHostSurvivesRestartWithoutFallingBackToServerIDOrder() async throws {
        let secureStore = InMemorySecureStore()
        let store = PairedHostStore(secureStore: secureStore)
        let alphabeticallyFirst = makeHost(serverID: "server-a")
        let selected = makeHost(serverID: "server-z")
        try await store.save(alphabeticallyFirst)
        try await store.save(selected)

        let reopened = PairedHostStore(secureStore: secureStore)
        let hosts = try await reopened.hosts()
        let reopenedSelection = try await reopened.selectedHost()

        XCTAssertEqual(hosts, [alphabeticallyFirst, selected])
        XCTAssertEqual(reopenedSelection, selected)
    }

    func testLegacySingleHostRecordRemainsAnUnambiguousSelection() async throws {
        let secureStore = InMemorySecureStore()
        let host = makeHost()
        try secureStore.set(
            JSONEncoder().encode([host.serverID: host]),
            forKey: PairedHostStore.legacyKey
        )

        let reopened = PairedHostStore(secureStore: secureStore)

        let selected = try await reopened.selectedHost()
        XCTAssertEqual(selected, host)
    }

    func testLegacyMultiHostRecordMigratesThePreviousDeterministicSelection() async throws {
        let secureStore = InMemorySecureStore()
        let first = makeHost(serverID: "server-a")
        let second = makeHost(serverID: "server-z")
        try secureStore.set(
            JSONEncoder().encode([
                second.serverID: second,
                first.serverID: first,
            ]),
            forKey: PairedHostStore.legacyKey
        )

        let migrated = PairedHostStore(secureStore: secureStore)
        let migratedSelection = try await migrated.selectedHost()
        XCTAssertEqual(migratedSelection, first)

        try secureStore.removeValue(forKey: PairedHostStore.legacyKey)
        let reopened = PairedHostStore(secureStore: secureStore)
        let reopenedSelection = try await reopened.selectedHost()
        XCTAssertEqual(reopenedSelection, first)
    }

    func testSelectedHostFailsClosedWhenSelectionDoesNotNameARecord() async throws {
        let secureStore = InMemorySecureStore()
        let host = makeHost()
        try secureStore.set(
            JSONEncoder().encode(PersistedPairedHostStateFixture(
                records: [host.serverID: host],
                selectedServerID: "missing-server"
            )),
            forKey: PairedHostStore.defaultKey
        )
        let store = PairedHostStore(secureStore: secureStore)

        do {
            _ = try await store.selectedHost()
            XCTFail("An inconsistent selected-host binding must fail closed")
        } catch {
            XCTAssertEqual(error as? PairedHostStoreError, .corruptedRecord)
        }
    }

    func testSelectedHostFailsClosedWhenRecordKeyContradictsServerIdentity() async throws {
        let secureStore = InMemorySecureStore()
        let host = makeHost(serverID: "actual-server")
        try secureStore.set(
            JSONEncoder().encode(PersistedPairedHostStateFixture(
                records: ["selected-server": host],
                selectedServerID: "selected-server"
            )),
            forKey: PairedHostStore.defaultKey
        )
        let store = PairedHostStore(secureStore: secureStore)

        do {
            _ = try await store.selectedHost()
            XCTFail("A contradictory host record must fail closed")
        } catch {
            XCTAssertEqual(error as? PairedHostStoreError, .corruptedRecord)
        }
    }

    func testPersistsFingerprintsInOneCanonicalForm() async throws {
        let store = PairedHostStore(secureStore: InMemorySecureStore())
        let colonSeparated = fingerprint.uppercased().chunked(every: 2).joined(separator: ":")

        try await store.save(makeHost(fingerprint: colonSeparated))

        let loaded = try await store.host(withServerID: "server-1")
        XCTAssertEqual(loaded?.certificateFingerprint, fingerprint)
    }

    func testRejectsAMalformedFingerprint() async {
        let store = PairedHostStore(secureStore: InMemorySecureStore())

        do {
            try await store.save(makeHost(fingerprint: "nope"))
            XCTFail("Expected a malformed fingerprint to be rejected")
        } catch {
            XCTAssertEqual(error as? PairedHostStoreError, .invalidFingerprint)
            XCTAssertTrue(error.localizedDescription.localizedCaseInsensitiveContains("re-pair"))
        }
    }

    func testSameServerIDWithAChangedFingerprintRefusesToOverwrite() async throws {
        let store = PairedHostStore(secureStore: InMemorySecureStore())
        try await store.save(makeHost())

        do {
            try await store.save(makeHost(fingerprint: otherFingerprint, token: "token-2"))
            XCTFail("Expected a changed fingerprint to require re-pairing")
        } catch {
            XCTAssertEqual(error as? PairedHostStoreError, .identityChanged(serverID: "server-1"))
            XCTAssertTrue(error.localizedDescription.localizedCaseInsensitiveContains("re-pair"))
        }

        let loaded = try await store.host(withServerID: "server-1")
        XCTAssertEqual(loaded?.certificateFingerprint, fingerprint)
        XCTAssertEqual(loaded?.token, "token-1")
    }

    func testExplicitRePairingAcceptsTheNewFingerprint() async throws {
        let store = PairedHostStore(secureStore: InMemorySecureStore())
        try await store.save(makeHost())

        try await store.replace(makeHost(fingerprint: otherFingerprint, token: "token-2"))

        let loaded = try await store.host(withServerID: "server-1")
        let all = try await store.hosts()
        XCTAssertEqual(loaded?.certificateFingerprint, otherFingerprint)
        XCTAssertEqual(loaded?.token, "token-2")
        XCTAssertEqual(all.count, 1)
    }

    func testGenerationBoundRePairingCannotReplaceTrustAfterSupersession() async throws {
        let secureStore = SaveBoundarySecureStore()
        let store = PairedHostStore(secureStore: secureStore)
        try await store.save(makeHost())
        let generation = ConnectionGeneration(id: 1)
        let authorization = PairingPersistenceAuthorization()
        let replacementHost = makeHost(fingerprint: otherFingerprint, token: "token-2")

        secureStore.blockNextRead()
        let replacement = Task {
            try await store.replace(
                replacementHost,
                for: generation,
                authorizedBy: authorization
            )
        }
        try await secureStore.waitUntilReadBegins()
        generation.invalidate()
        secureStore.releaseRead()

        let replaced = try await replacement.value
        XCTAssertFalse(replaced)
        let loaded = try await store.host(withServerID: "server-1")
        XCTAssertEqual(loaded?.certificateFingerprint, fingerprint)
        XCTAssertEqual(loaded?.token, "token-1")
    }

    func testReadinessPublicationRevalidatesItsFlowInsideTheStoreActor() async throws {
        let secureStore = SaveBoundarySecureStore()
        let store = PairedHostStore(secureStore: secureStore)
        let authorization = HostReadinessFlowAuthorization()
        let host = makeHost()
        let claim = try XCTUnwrap(authorization.claimHostPublication(host))

        secureStore.blockNextRead()
        let publication = Task {
            await store.publishReadinessHost(
                host,
                policy: .replace,
                claimedBy: claim,
                authorizedBy: authorization
            )
        }
        try await secureStore.waitUntilReadBegins()
        authorization.revoke()
        secureStore.releaseRead()

        let result = await publication.value
        let hosts = try await store.hosts()
        XCTAssertEqual(result, .notCommitted(reason: nil))
        XCTAssertEqual(hosts, [])
    }

    func testReadinessPublicationCompensatesAMutateThenThrowWrite() async throws {
        let secureStore = FaultingTransactionSecureStore()
        let store = PairedHostStore(secureStore: secureStore)
        let original = makeHost()
        try await store.save(original)
        secureStore.enqueue(.mutateThenThrow(.writeFailed))
        let replacement = makeHost(fingerprint: otherFingerprint, token: "token-2")
        let authorization = HostReadinessFlowAuthorization()
        let claim = try XCTUnwrap(authorization.claimHostPublication(replacement))

        let result = await store.publishReadinessHost(
            replacement,
            policy: .replace,
            claimedBy: claim,
            authorizedBy: authorization
        )

        guard case .notCommitted = result else {
            return XCTFail("Expected a proven compensation, got \(result)")
        }
        let restored = try await store.host(withServerID: original.serverID)
        XCTAssertEqual(restored, original)
    }

    func testReadinessPublicationReportsIndeterminateWhenCompensationFails() async throws {
        let secureStore = FaultingTransactionSecureStore()
        let store = PairedHostStore(secureStore: secureStore)
        try await store.save(makeHost())
        secureStore.enqueue(.mutateThenThrow(.writeFailed))
        secureStore.enqueue(.throwBeforeMutation(.compensationFailed))
        let replacement = makeHost(fingerprint: otherFingerprint, token: "token-2")
        let authorization = HostReadinessFlowAuthorization()
        let claim = try XCTUnwrap(authorization.claimHostPublication(replacement))

        let result = await store.publishReadinessHost(
            replacement,
            policy: .replace,
            claimedBy: claim,
            authorizedBy: authorization
        )

        guard case .indeterminate = result else {
            return XCTFail("Failed compensation must be indeterminate, got \(result)")
        }
    }

    func testReadinessPublicationPreservesSelectionUntilReadyHostIsSelected() async throws {
        let store = PairedHostStore(secureStore: InMemorySecureStore())
        let previouslyReady = makeHost(serverID: "server-a")
        let candidate = makeHost(serverID: "server-z")
        try await store.save(previouslyReady)
        let authorization = HostReadinessFlowAuthorization()
        let claim = try XCTUnwrap(authorization.claimHostPublication(candidate))

        let publication = await store.publishReadinessHost(
            candidate,
            policy: .replace,
            claimedBy: claim,
            authorizedBy: authorization
        )

        XCTAssertEqual(publication, .committed)
        let selectedBeforeReadiness = try await store.selectedHost()
        let persistedCandidate = try await store.host(withServerID: candidate.serverID)
        XCTAssertEqual(selectedBeforeReadiness, previouslyReady)
        XCTAssertEqual(persistedCandidate, candidate)

        let generation = ConnectionGeneration(id: 1)
        let selection = await store.selectReadyHost(
            serverID: candidate.serverID,
            for: generation
        )

        XCTAssertEqual(selection.result, .committed)
        let transaction = try XCTUnwrap(selection.transaction)
        let selectionAuthorization = try XCTUnwrap(selection.authorization)
        let selectedWhilePromotionIsPending = try await store.selectedHost()
        XCTAssertEqual(selectedWhilePromotionIsPending, previouslyReady)

        XCTAssertTrue(selectionAuthorization.finalize {})
        let completion = await store.completeReadyHostSelection(
            transaction,
            authorizedBy: selectionAuthorization,
            selectedBy: generation
        )
        XCTAssertEqual(completion, .committed)
        let selectedAfterReadiness = try await store.selectedHost()
        XCTAssertEqual(selectedAfterReadiness, candidate)
    }

    func testRestartPreservesPreviousAuthorityWhileReadySelectionIsPending() async throws {
        let secureStore = InMemorySecureStore()
        let store = PairedHostStore(secureStore: secureStore)
        let previouslyReady = makeHost(serverID: "server-a")
        let candidate = makeHost(serverID: "server-z")
        try await store.save(previouslyReady)
        let authorization = HostReadinessFlowAuthorization()
        let claim = try XCTUnwrap(authorization.claimHostPublication(candidate))
        let publication = await store.publishReadinessHost(
            candidate,
            policy: .replace,
            claimedBy: claim,
            authorizedBy: authorization
        )
        XCTAssertEqual(publication, .committed)
        let generation = ConnectionGeneration(id: 1)
        let selection = await store.selectReadyHost(
            serverID: candidate.serverID,
            for: generation
        )
        XCTAssertEqual(selection.result, .committed)

        let restarted = PairedHostStore(secureStore: secureStore)
        let restartSelection = try await restarted.selectedHost()

        XCTAssertEqual(restartSelection, previouslyReady)
    }

    func testPendingFirstHostSelectionCreatesNoRestartAuthority() async throws {
        let secureStore = InMemorySecureStore()
        let store = PairedHostStore(secureStore: secureStore)
        let candidate = makeHost(serverID: "server-z")
        let authorization = HostReadinessFlowAuthorization()
        let claim = try XCTUnwrap(authorization.claimHostPublication(candidate))
        let publication = await store.publishReadinessHost(
            candidate,
            policy: .replace,
            claimedBy: claim,
            authorizedBy: authorization
        )
        XCTAssertEqual(publication, .committed)
        let generation = ConnectionGeneration(id: 1)
        let selection = await store.selectReadyHost(
            serverID: candidate.serverID,
            for: generation
        )
        XCTAssertEqual(selection.result, .committed)

        let restarted = PairedHostStore(secureStore: secureStore)
        let restartSelection = try await restarted.selectedHost()

        XCTAssertNil(restartSelection)
    }

    func testRetiredGenerationCannotAdvanceReadyHostSelection() async throws {
        let store = PairedHostStore(secureStore: InMemorySecureStore())
        let previouslyReady = makeHost(serverID: "server-a")
        let candidate = makeHost(serverID: "server-z")
        try await store.save(previouslyReady)
        try await store.save(candidate)
        try await store.save(previouslyReady)
        let generation = ConnectionGeneration(id: 1)
        generation.invalidate()

        let selection = await store.selectReadyHost(
            serverID: candidate.serverID,
            for: generation
        )

        XCTAssertEqual(selection.result, .notCommitted(reason: nil))
        XCTAssertNil(selection.transaction)
        let selected = try await store.selectedHost()
        XCTAssertEqual(selected, previouslyReady)
    }

    func testRetiredSelectionCompensationCannotUndoANewerOwner() async throws {
        let store = PairedHostStore(secureStore: InMemorySecureStore())
        let previouslyReady = makeHost(serverID: "server-a")
        let candidate = makeHost(serverID: "server-z")
        try await store.save(previouslyReady)
        try await store.save(candidate)
        try await store.save(previouslyReady)
        let retired = ConnectionGeneration(id: 1)
        let current = ConnectionGeneration(id: 2)

        let retiredSelection = await store.selectReadyHost(
            serverID: candidate.serverID,
            for: retired
        )
        XCTAssertEqual(retiredSelection.result, .committed)
        let retiredTransaction = try XCTUnwrap(retiredSelection.transaction)
        let retiredAuthorization = try XCTUnwrap(retiredSelection.authorization)
        retired.invalidate()
        let currentSelection = await store.selectReadyHost(
            serverID: candidate.serverID,
            for: current
        )
        XCTAssertEqual(currentSelection.result, .committed)
        let currentTransaction = try XCTUnwrap(currentSelection.transaction)
        let currentAuthorization = try XCTUnwrap(currentSelection.authorization)

        let compensation = await store.compensateReadyHostSelection(
            retiredTransaction,
            authorizedBy: retiredAuthorization,
            selectedBy: retired
        )

        XCTAssertEqual(compensation, .notCommitted(reason: nil))
        XCTAssertTrue(currentAuthorization.finalize {})
        let completion = await store.completeReadyHostSelection(
            currentTransaction,
            authorizedBy: currentAuthorization,
            selectedBy: current
        )
        XCTAssertEqual(completion, .committed)
        let selected = try await store.selectedHost()
        XCTAssertEqual(selected, candidate)
    }

    func testExplicitRePairSupersedesPendingReadySelectionBeforeFinalization() async throws {
        let store = PairedHostStore(secureStore: InMemorySecureStore())
        let previouslyReady = makeHost(serverID: "server-a")
        let candidate = makeHost(serverID: "server-z")
        let replacement = makeHost(
            serverID: candidate.serverID,
            fingerprint: otherFingerprint,
            token: "replacement-token"
        )
        try await store.save(previouslyReady)
        try await store.save(candidate)
        try await store.save(previouslyReady)
        let generation = ConnectionGeneration(id: 1)
        let preparation = await store.selectReadyHost(
            serverID: candidate.serverID,
            for: generation
        )
        let transaction = try XCTUnwrap(preparation.transaction)
        let authorization = try XCTUnwrap(preparation.authorization)

        try await store.replace(replacement)
        var finalized = false
        let allowed = authorization.finalize {
            finalized = true
        }
        let compensation = await store.compensateReadyHostSelection(
            transaction,
            authorizedBy: authorization,
            selectedBy: generation
        )
        let selected = try await store.selectedHost()

        XCTAssertFalse(allowed)
        XCTAssertFalse(finalized)
        XCTAssertEqual(compensation, .notCommitted(reason: nil))
        XCTAssertEqual(selected, replacement)
    }

    func testExplicitRePairSupersedesAlreadySelectedReconnectBeforeFinalization() async throws {
        let store = PairedHostStore(secureStore: InMemorySecureStore())
        let selected = makeHost(serverID: "server-a")
        let replacement = makeHost(
            serverID: selected.serverID,
            fingerprint: otherFingerprint,
            token: "replacement-token"
        )
        try await store.save(selected)
        let generation = ConnectionGeneration(id: 1)
        let preparation = await store.selectReadyHost(
            serverID: selected.serverID,
            for: generation
        )
        XCTAssertNil(preparation.transaction)
        let authorization = try XCTUnwrap(preparation.authorization)

        try await store.replace(replacement)
        var finalized = false
        let allowed = authorization.finalize {
            finalized = true
        }
        let persisted = try await store.selectedHost()

        XCTAssertFalse(allowed)
        XCTAssertFalse(finalized)
        XCTAssertEqual(persisted, replacement)
    }

    func testFailedExplicitSavePreservesFinalizedSelectionOwner() async throws {
        let secureStore = FaultingTransactionSecureStore()
        let store = PairedHostStore(secureStore: secureStore)
        let previouslyReady = makeHost(serverID: "server-a")
        let candidate = makeHost(serverID: "server-b")
        let unrelated = makeHost(serverID: "server-c")
        try await store.save(previouslyReady)
        try await store.save(candidate)
        try await store.save(previouslyReady)
        let generation = ConnectionGeneration(id: 1)
        let preparation = await store.selectReadyHost(
            serverID: candidate.serverID,
            for: generation
        )
        let transaction = try XCTUnwrap(preparation.transaction)
        let authorization = try XCTUnwrap(preparation.authorization)
        XCTAssertTrue(authorization.finalize {})
        secureStore.enqueue(.throwBeforeMutation(.writeFailed))

        do {
            try await store.save(unrelated)
            XCTFail("The explicit save should surface its write failure")
        } catch {
            XCTAssertEqual(
                error as? FaultingTransactionSecureStoreError,
                .writeFailed
            )
        }
        let selectedAfterFailure = try await store.selectedHost()
        let completion = await store.completeReadyHostSelection(
            transaction,
            authorizedBy: authorization,
            selectedBy: generation
        )
        let restarted = PairedHostStore(secureStore: secureStore)
        let restartSelection = try await restarted.selectedHost()

        XCTAssertEqual(selectedAfterFailure, candidate)
        XCTAssertEqual(completion, .committed)
        XCTAssertEqual(restartSelection, candidate)
    }

    func testMutatingExplicitRePairRetiresStaleSelectionOwner() async throws {
        let secureStore = FaultingTransactionSecureStore()
        let store = PairedHostStore(secureStore: secureStore)
        let previouslyReady = makeHost(serverID: "server-a")
        let candidate = makeHost(serverID: "server-b")
        let replacement = makeHost(
            serverID: candidate.serverID,
            fingerprint: otherFingerprint,
            token: "replacement-token"
        )
        try await store.save(previouslyReady)
        try await store.save(candidate)
        try await store.save(previouslyReady)
        let generation = ConnectionGeneration(id: 1)
        let preparation = await store.selectReadyHost(
            serverID: candidate.serverID,
            for: generation
        )
        let authorization = try XCTUnwrap(preparation.authorization)
        secureStore.enqueue(.mutateThenThrow(.writeFailed))

        do {
            try await store.replace(replacement)
            XCTFail("The explicit re-pair should surface its ambiguous write")
        } catch {
            XCTAssertEqual(
                error as? FaultingTransactionSecureStoreError,
                .writeFailed
            )
        }
        let allowed = authorization.finalize {}
        let selected = try await store.selectedHost()

        XCTAssertFalse(allowed)
        XCTAssertEqual(selected, replacement)
    }

    func testRemovingUnrelatedPairPreservesFinalizedSelectionOwner() async throws {
        let secureStore = InMemorySecureStore()
        let store = PairedHostStore(secureStore: secureStore)
        let previouslyReady = makeHost(serverID: "server-a")
        let candidate = makeHost(serverID: "server-b")
        let unrelated = makeHost(serverID: "server-c")
        try await store.save(previouslyReady)
        try await store.save(candidate)
        try await store.save(unrelated)
        try await store.save(previouslyReady)
        let generation = ConnectionGeneration(id: 1)
        let preparation = await store.selectReadyHost(
            serverID: candidate.serverID,
            for: generation
        )
        let transaction = try XCTUnwrap(preparation.transaction)
        let authorization = try XCTUnwrap(preparation.authorization)
        XCTAssertTrue(authorization.finalize {})

        try await store.remove(serverID: unrelated.serverID)
        let selectedBeforeCleanup = try await store.selectedHost()
        let completion = await store.completeReadyHostSelection(
            transaction,
            authorizedBy: authorization,
            selectedBy: generation
        )
        let restarted = PairedHostStore(secureStore: secureStore)
        let restartSelection = try await restarted.selectedHost()
        let removedHost = try await store.host(withServerID: unrelated.serverID)

        XCTAssertEqual(selectedBeforeCleanup, candidate)
        XCTAssertEqual(completion, .committed)
        XCTAssertEqual(restartSelection, candidate)
        XCTAssertNil(removedHost)
    }

    func testRemovingPreviousPairPromotesFinalizedSelection() async throws {
        let secureStore = InMemorySecureStore()
        let store = PairedHostStore(secureStore: secureStore)
        let previouslyReady = makeHost(serverID: "server-a")
        let candidate = makeHost(serverID: "server-b")
        try await store.save(previouslyReady)
        try await store.save(candidate)
        try await store.save(previouslyReady)
        let generation = ConnectionGeneration(id: 1)
        let preparation = await store.selectReadyHost(
            serverID: candidate.serverID,
            for: generation
        )
        let transaction = try XCTUnwrap(preparation.transaction)
        let authorization = try XCTUnwrap(preparation.authorization)
        XCTAssertTrue(authorization.finalize {})

        try await store.remove(serverID: previouslyReady.serverID)
        let completion = await store.completeReadyHostSelection(
            transaction,
            authorizedBy: authorization,
            selectedBy: generation
        )
        let selected = try await store.selectedHost()
        let restarted = PairedHostStore(secureStore: secureStore)
        let restartSelection = try await restarted.selectedHost()

        XCTAssertEqual(completion, .notCommitted(reason: nil))
        XCTAssertEqual(selected, candidate)
        XCTAssertEqual(restartSelection, candidate)
    }

    func testFinalizedSelectionCompletesAfterGenerationRetires() async throws {
        let secureStore = InMemorySecureStore()
        let store = PairedHostStore(secureStore: secureStore)
        let previouslyReady = makeHost(serverID: "server-a")
        let candidate = makeHost(serverID: "server-z")
        try await store.save(previouslyReady)
        try await store.save(candidate)
        try await store.save(previouslyReady)
        let generation = ConnectionGeneration(id: 1)
        let preparation = await store.selectReadyHost(
            serverID: candidate.serverID,
            for: generation
        )
        let transaction = try XCTUnwrap(preparation.transaction)
        let authorization = try XCTUnwrap(preparation.authorization)
        XCTAssertTrue(authorization.finalize {})

        generation.invalidate()
        let completion = await store.completeReadyHostSelection(
            transaction,
            authorizedBy: authorization,
            selectedBy: generation
        )
        let restarted = PairedHostStore(secureStore: secureStore)
        let restartSelection = try await restarted.selectedHost()

        XCTAssertEqual(completion, .committed)
        XCTAssertEqual(restartSelection, candidate)
    }

    func testRetiredSelectionCannotSupersedeCurrentOwner() async throws {
        let store = PairedHostStore(secureStore: InMemorySecureStore())
        let previouslyReady = makeHost(serverID: "server-a")
        let candidate = makeHost(serverID: "server-z")
        try await store.save(previouslyReady)
        try await store.save(candidate)
        try await store.save(previouslyReady)
        let current = ConnectionGeneration(id: 2)
        let currentPreparation = await store.selectReadyHost(
            serverID: candidate.serverID,
            for: current
        )
        let currentTransaction = try XCTUnwrap(currentPreparation.transaction)
        let currentAuthorization = try XCTUnwrap(currentPreparation.authorization)
        let retired = ConnectionGeneration(id: 1)
        retired.invalidate()

        let retiredPreparation = await store.selectReadyHost(
            serverID: previouslyReady.serverID,
            for: retired
        )

        XCTAssertEqual(retiredPreparation.result, .notCommitted(reason: nil))
        XCTAssertTrue(currentAuthorization.finalize {})
        let completion = await store.completeReadyHostSelection(
            currentTransaction,
            authorizedBy: currentAuthorization,
            selectedBy: current
        )
        XCTAssertEqual(completion, .committed)
        let selected = try await store.selectedHost()
        XCTAssertEqual(selected, candidate)
    }

    func testRetiredCompletionCannotClearNewerSelectionOwner() async throws {
        let store = PairedHostStore(secureStore: InMemorySecureStore())
        let previouslyReady = makeHost(serverID: "server-a")
        let candidate = makeHost(serverID: "server-z")
        try await store.save(previouslyReady)
        try await store.save(candidate)
        try await store.save(previouslyReady)
        let retired = ConnectionGeneration(id: 1)
        let retiredPreparation = await store.selectReadyHost(
            serverID: candidate.serverID,
            for: retired
        )
        let retiredTransaction = try XCTUnwrap(retiredPreparation.transaction)
        let retiredAuthorization = try XCTUnwrap(retiredPreparation.authorization)
        XCTAssertTrue(retiredAuthorization.finalize {})
        retired.invalidate()

        let current = ConnectionGeneration(id: 2)
        let currentPreparation = await store.selectReadyHost(
            serverID: candidate.serverID,
            for: current
        )
        XCTAssertNil(currentPreparation.transaction)
        let currentAuthorization = try XCTUnwrap(currentPreparation.authorization)

        let retiredCompletion = await store.completeReadyHostSelection(
            retiredTransaction,
            authorizedBy: retiredAuthorization,
            selectedBy: retired
        )

        XCTAssertEqual(retiredCompletion, .notCommitted(reason: nil))
        XCTAssertTrue(currentAuthorization.finalize {})
        await store.acknowledgeReadyHostSelection(
            authorizedBy: currentAuthorization,
            selectedBy: current
        )
        let selected = try await store.selectedHost()
        XCTAssertEqual(selected, candidate)
    }

    func testReadySelectionCompletionFailureKeepsPreviousRestartAuthority() async throws {
        let secureStore = FaultingTransactionSecureStore()
        let store = PairedHostStore(secureStore: secureStore)
        let previouslyReady = makeHost(serverID: "server-a")
        let candidate = makeHost(serverID: "server-z")
        try await store.save(previouslyReady)
        try await store.save(candidate)
        try await store.save(previouslyReady)
        let generation = ConnectionGeneration(id: 1)
        secureStore.enqueue(.succeed)

        let preparation = await store.selectReadyHost(
            serverID: candidate.serverID,
            for: generation
        )
        let transaction = try XCTUnwrap(preparation.transaction)
        let authorization = try XCTUnwrap(preparation.authorization)
        XCTAssertTrue(authorization.finalize {})
        secureStore.enqueue(.mutateThenThrow(.writeFailed))

        let completion = await store.completeReadyHostSelection(
            transaction,
            authorizedBy: authorization,
            selectedBy: generation
        )
        guard case .notCommitted = completion else {
            return XCTFail("Completion should report its verified rollback")
        }
        let restarted = PairedHostStore(secureStore: secureStore)
        let selected = try await store.selectedHost()
        let restartedSelection = try await restarted.selectedHost()

        XCTAssertEqual(selected, candidate)
        XCTAssertEqual(restartedSelection, previouslyReady)
    }

    func testSuccessorCompensationRestoresFinalizedInProcessAuthority() async throws {
        let secureStore = FaultingTransactionSecureStore()
        let store = PairedHostStore(secureStore: secureStore)
        let first = makeHost(serverID: "server-a")
        let finalized = makeHost(serverID: "server-b")
        let successor = makeHost(serverID: "server-c")
        try await store.save(first)
        try await store.save(finalized)
        try await store.save(first)

        let finalizedGeneration = ConnectionGeneration(id: 1)
        let finalizedPreparation = await store.selectReadyHost(
            serverID: finalized.serverID,
            for: finalizedGeneration
        )
        let finalizedTransaction = try XCTUnwrap(finalizedPreparation.transaction)
        let finalizedAuthorization = try XCTUnwrap(finalizedPreparation.authorization)
        XCTAssertTrue(finalizedAuthorization.finalize {})
        secureStore.enqueue(.mutateThenThrow(.writeFailed))
        let completion = await store.completeReadyHostSelection(
            finalizedTransaction,
            authorizedBy: finalizedAuthorization,
            selectedBy: finalizedGeneration
        )
        guard case .notCommitted = completion else {
            return XCTFail("The finalized marker should remain pending")
        }
        let selectedAfterCleanupFailure = try await store.selectedHost()
        XCTAssertEqual(selectedAfterCleanupFailure, finalized)

        let publicationAuthorization = HostReadinessFlowAuthorization()
        let claim = try XCTUnwrap(publicationAuthorization.claimHostPublication(successor))
        let publication = await store.publishReadinessHost(
            successor,
            policy: .replace,
            claimedBy: claim,
            authorizedBy: publicationAuthorization
        )
        XCTAssertEqual(publication, .committed)
        let successorGeneration = ConnectionGeneration(id: 2)
        let successorPreparation = await store.selectReadyHost(
            serverID: successor.serverID,
            for: successorGeneration
        )
        let successorTransaction = try XCTUnwrap(successorPreparation.transaction)
        let successorAuthorization = try XCTUnwrap(successorPreparation.authorization)

        let compensation = await store.compensateReadyHostSelection(
            successorTransaction,
            authorizedBy: successorAuthorization,
            selectedBy: successorGeneration
        )
        let restarted = PairedHostStore(secureStore: secureStore)
        let selectedAfterCompensation = try await store.selectedHost()
        let restartedSelection = try await restarted.selectedHost()

        XCTAssertEqual(compensation, .committed)
        XCTAssertEqual(selectedAfterCompensation, finalized)
        XCTAssertEqual(restartedSelection, finalized)
    }

    func testCredentialRevocationDoesNotClearANewerBinding() async throws {
        let store = PairedHostStore(secureStore: InMemorySecureStore())
        let host = makeHost()
        try await store.save(host)
        try await store.updateToken("new-token", forServerID: host.serverID)

        let result = await store.revokeToken(
            forServerID: host.serverID,
            expectedClientID: host.clientID,
            expectedToken: host.token
        )
        let retained = try await store.host(withServerID: host.serverID)

        XCTAssertEqual(result, .notCommitted(reason: nil))
        XCTAssertEqual(retained?.token, "new-token")
    }

    func testReadinessPublicationRollsBackSelectedHostWithTheHostRecords() async throws {
        let secureStore = FaultingTransactionSecureStore()
        let store = PairedHostStore(secureStore: secureStore)
        let original = makeHost(serverID: "server-a")
        try await store.save(original)
        secureStore.enqueue(.mutateThenThrow(.writeFailed))
        let replacement = makeHost(serverID: "server-z")
        let authorization = HostReadinessFlowAuthorization()
        let claim = try XCTUnwrap(authorization.claimHostPublication(replacement))

        let result = await store.publishReadinessHost(
            replacement,
            policy: .replace,
            claimedBy: claim,
            authorizedBy: authorization
        )

        guard case .notCommitted = result else {
            return XCTFail("Expected a proven compensation, got \(result)")
        }
        let hosts = try await store.hosts()
        let selected = try await store.selectedHost()
        XCTAssertEqual(hosts, [original])
        XCTAssertEqual(selected, original)
    }

    func testReissuePersistsClientIDAndTokenAsOneCredentialBinding() async throws {
        let store = PairedHostStore(secureStore: InMemorySecureStore())
        try await store.save(makeHost())
        let generation = ConnectionGeneration(id: 1)
        let authorization = PairingPersistenceAuthorization()

        let result = try await store.reissueToken(
            "token-2",
            clientID: "client-2",
            forServerID: "server-1",
            certificateFingerprint: fingerprint,
            for: generation,
            authorizedBy: authorization
        )

        XCTAssertEqual(result, .committed)
        let persisted = try await store.selectedHost()
        XCTAssertEqual(persisted?.clientID, "client-2")
        XCTAssertEqual(persisted?.token, "token-2")
    }

    func testReissueCompensatesAMutateThenThrowCredentialWrite() async throws {
        let secureStore = FaultingTransactionSecureStore()
        let store = PairedHostStore(secureStore: secureStore)
        let original = makeHost()
        try await store.save(original)
        secureStore.enqueue(.mutateThenThrow(.writeFailed))
        let generation = ConnectionGeneration(id: 1)
        let authorization = PairingPersistenceAuthorization()

        let result = try await store.reissueToken(
            "token-2",
            clientID: "client-2",
            forServerID: "server-1",
            certificateFingerprint: fingerprint,
            for: generation,
            authorizedBy: authorization
        )

        guard case .notCommitted = result else {
            return XCTFail("Expected verified credential compensation, got \(result)")
        }
        let persisted = try await store.selectedHost()
        XCTAssertEqual(persisted, original)
    }

    func testReissueReportsIndeterminateWhenCredentialCompensationFails() async throws {
        let secureStore = FaultingTransactionSecureStore()
        let store = PairedHostStore(secureStore: secureStore)
        try await store.save(makeHost())
        secureStore.enqueue(.mutateThenThrow(.writeFailed))
        secureStore.enqueue(.throwBeforeMutation(.compensationFailed))
        let generation = ConnectionGeneration(id: 1)
        let authorization = PairingPersistenceAuthorization()

        let result = try await store.reissueToken(
            "token-2",
            clientID: "client-2",
            forServerID: "server-1",
            certificateFingerprint: fingerprint,
            for: generation,
            authorizedBy: authorization
        )

        guard case .indeterminate = result else {
            return XCTFail("Failed credential compensation must be indeterminate, got \(result)")
        }
    }

    func testReissueReportsIndeterminateWhenCredentialCompensationCannotBeVerified() async throws {
        let secureStore = FaultingTransactionSecureStore()
        let store = PairedHostStore(secureStore: secureStore)
        try await store.save(makeHost())
        secureStore.enqueue(.mutateThenThrow(.writeFailed))
        secureStore.enqueue(.replaceWith(Data("incorrect-compensation".utf8)))
        let generation = ConnectionGeneration(id: 1)
        let authorization = PairingPersistenceAuthorization()

        let result = try await store.reissueToken(
            "token-2",
            clientID: "client-2",
            forServerID: "server-1",
            certificateFingerprint: fingerprint,
            for: generation,
            authorizedBy: authorization
        )

        guard case .indeterminate(let reason) = result else {
            return XCTFail("Unverified credential compensation must be indeterminate")
        }
        XCTAssertTrue(reason.contains("could not be verified"))
    }

    func testSaveUpdatesEverythingElseAboutAKnownHost() async throws {
        let store = PairedHostStore(secureStore: InMemorySecureStore())
        try await store.save(makeHost())

        try await store.save(PairedHost(
            serverID: "server-1",
            serverName: "Renamed",
            endpoint: HostEndpoint(
                host: "10.0.0.9",
                port: 5151,
                certificateFingerprint: fingerprint
            ),
            clientID: "client-1",
            token: "token-2"
        ))

        let loaded = try await store.host(withServerID: "server-1")
        XCTAssertEqual(loaded?.serverName, "Renamed")
        XCTAssertEqual(loaded?.endpoint.host, "10.0.0.9")
        XCTAssertEqual(loaded?.endpoint.port, 5151)
        XCTAssertEqual(loaded?.token, "token-2")
    }

    func testInvalidatedGenerationCannotCommitAtTheSecureWriteBoundary() async throws {
        let secureStore = SaveBoundarySecureStore()
        let store = PairedHostStore(secureStore: secureStore)
        let generation = ConnectionGeneration(id: 1)
        let host = makeHost()

        secureStore.blockNextRead()
        let saveTask = Task {
            try await store.save(host, for: generation)
        }
        try await secureStore.waitUntilReadBegins()

        generation.invalidate()
        secureStore.releaseRead()

        let committed = try await saveTask.value
        let hosts = try await store.hosts()
        XCTAssertFalse(committed)
        XCTAssertEqual(hosts, [])
    }

    func testTokenRefreshDoesNotRequireRePairing() async throws {
        let store = PairedHostStore(secureStore: InMemorySecureStore())
        try await store.save(makeHost())

        try await store.updateToken("token-refreshed", forServerID: "server-1")
        try await store.updateToken("ignored", forServerID: "unknown-server")

        let loaded = try await store.host(withServerID: "server-1")
        let all = try await store.hosts()
        XCTAssertEqual(loaded?.token, "token-refreshed")
        XCTAssertEqual(loaded?.certificateFingerprint, fingerprint)
        XCTAssertEqual(all.count, 1)
    }

    func testSaveBoundarySecureStoreWaitTimesOutWhenNoReadBegins() async {
        let secureStore = SaveBoundarySecureStore()

        secureStore.blockNextRead()

        do {
            try await secureStore.waitUntilReadBegins(timeout: .milliseconds(20))
            XCTFail("Expected the bounded save-boundary read gate to time out")
        } catch let error as BoundedAsyncSignal.WaitError {
            XCTAssertEqual(error, .timedOut("paired host store secure-store read to begin"))
        } catch {
            XCTFail("Expected WaitError.timedOut, got \(error)")
        }
    }

    func testPairingStatusReportsUnpairedPairedAndRePairing() async throws {
        let store = PairedHostStore(secureStore: InMemorySecureStore())
        try await store.save(makeHost())

        let unpaired = try await store.pairingStatus(
            forServerID: "server-2",
            certificateFingerprint: fingerprint
        )
        let paired = try await store.pairingStatus(
            forServerID: "server-1",
            certificateFingerprint: fingerprint.uppercased()
        )
        let changed = try await store.pairingStatus(
            forServerID: "server-1",
            certificateFingerprint: otherFingerprint
        )
        let malformed = try await store.pairingStatus(
            forServerID: "server-1",
            certificateFingerprint: "nope"
        )

        XCTAssertEqual(unpaired, .unpaired)
        XCTAssertEqual(paired, .paired)
        XCTAssertEqual(changed, .requiresRePairing)
        XCTAssertEqual(malformed, .requiresRePairing)
    }

    func testHostsAreOrderedByServerIDAndRemovableIndividually() async throws {
        let store = PairedHostStore(secureStore: InMemorySecureStore())
        try await store.save(makeHost(serverID: "server-c"))
        try await store.save(makeHost(serverID: "server-a"))
        try await store.save(makeHost(serverID: "server-b"))

        try await store.remove(serverID: "server-b")
        try await store.remove(serverID: "server-unknown")

        let all = try await store.hosts()
        XCTAssertEqual(all.map(\.serverID), ["server-a", "server-c"])
    }

    func testCorruptedBlobSurfacesRepairGuidance() async {
        let secureStore = InMemorySecureStore()
        try? secureStore.set(Data("not json".utf8), forKey: PairedHostStore.defaultKey)
        let store = PairedHostStore(secureStore: secureStore)

        do {
            _ = try await store.hosts()
            XCTFail("Expected a corrupted record to be reported")
        } catch {
            XCTAssertEqual(error as? PairedHostStoreError, .corruptedRecord)
            XCTAssertTrue(error.localizedDescription.localizedCaseInsensitiveContains("re-pair"))
        }
    }

    func testKeychainStoreUsesAfterFirstUnlockThisDeviceOnly() {
        let attributes = KeychainSecureStore.insertAttributes(
            service: "service",
            account: "account",
            data: Data([1])
        )
        let updates = KeychainSecureStore.updateAttributes(data: Data([1]))

        XCTAssertEqual(
            attributes[kSecAttrAccessible as String] as! CFString,
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        )
        XCTAssertEqual(
            updates[kSecAttrAccessible as String] as! CFString,
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        )
        XCTAssertEqual(attributes[kSecClass as String] as! CFString, kSecClassGenericPassword)
        XCTAssertEqual(attributes[kSecAttrService as String] as? String, "service")
        XCTAssertEqual(attributes[kSecAttrAccount as String] as? String, "account")
    }

    func testKeychainLookupQueryDoesNotLeakTheSecret() {
        let query = KeychainSecureStore.lookupQuery(service: "service", account: "account")

        XCTAssertNil(query[kSecValueData as String])
        XCTAssertEqual(query[kSecAttrService as String] as? String, "service")
    }

    private func makeHost(
        serverID: String = "server-1",
        fingerprint: String? = nil,
        clientID: String = "client-1",
        token: String? = "token-1"
    ) -> PairedHost {
        PairedHost(
            serverID: serverID,
            serverName: "Studio",
            endpoint: HostEndpoint(
                host: "psyche.local",
                port: 4242,
                certificateFingerprint: fingerprint ?? self.fingerprint
            ),
            clientID: clientID,
            token: token
        )
    }
}

private final class SaveBoundarySecureStore: SecureStore, @unchecked Sendable {
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
            for: "paired host store secure-store read to begin",
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

private final class SuccessfulWriteBoundarySecureStore: SecureStore, @unchecked Sendable {
    private let condition = NSCondition()
    private let writeBeganSignal = BoundedAsyncSignal()
    private var storage: [String: Data] = [:]
    private var shouldBlockNextWrite = false
    private var writeReleased = false
    private var writes = 0

    var writeCount: Int {
        condition.withLock { writes }
    }

    func resetWriteCount() {
        condition.withLock {
            writes = 0
        }
    }

    func blockNextWrite() {
        writeBeganSignal.reset()
        condition.withLock {
            shouldBlockNextWrite = true
            writeReleased = false
        }
    }

    func waitUntilWriteBegins(timeout: Duration = .milliseconds(250)) async throws {
        try await writeBeganSignal.wait(
            for: "paired host store secure-store write to begin",
            timeout: timeout
        )
    }

    func releaseWrite() {
        condition.withLock {
            writeReleased = true
            condition.broadcast()
        }
    }

    func data(forKey key: String) throws -> Data? {
        condition.withLock { storage[key] }
    }

    func set(_ data: Data, forKey key: String) throws {
        condition.lock()
        storage[key] = data
        writes += 1
        if shouldBlockNextWrite {
            shouldBlockNextWrite = false
            condition.unlock()
            writeBeganSignal.signal()
            condition.lock()
            while !writeReleased {
                condition.wait()
            }
        }
        condition.unlock()
    }

    func removeValue(forKey key: String) throws {
        _ = condition.withLock {
            storage.removeValue(forKey: key)
        }
    }
}

private enum FaultingTransactionSecureStoreError: Error, Equatable {
    case writeFailed
    case compensationFailed
}

private struct PersistedPairedHostStateFixture: Codable {
    let records: [String: PairedHost]
    let selectedServerID: String?
}

private final class FaultingTransactionSecureStore: SecureStore, @unchecked Sendable {
    enum WriteBehavior {
        case succeed
        case mutateThenThrow(FaultingTransactionSecureStoreError)
        case throwBeforeMutation(FaultingTransactionSecureStoreError)
        case replaceWith(Data)
    }

    private let lock = NSLock()
    private var storage: [String: Data] = [:]
    private var writeBehaviors: [WriteBehavior] = []

    func enqueue(_ behavior: WriteBehavior) {
        lock.withLock {
            writeBehaviors.append(behavior)
        }
    }

    func hosts() -> [String: PairedHost]? {
        lock.withLock {
            guard let data = storage[PairedHostStore.defaultKey] else { return nil }
            let decoder = JSONDecoder()
            if let state = try? decoder.decode(PersistedPairedHostStateFixture.self, from: data) {
                return state.records
            }
            return try? decoder.decode([String: PairedHost].self, from: data)
        }
    }

    func data(forKey key: String) throws -> Data? {
        lock.withLock { storage[key] }
    }

    func set(_ data: Data, forKey key: String) throws {
        try lock.withLock {
            let behavior = writeBehaviors.isEmpty ? .succeed : writeBehaviors.removeFirst()
            switch behavior {
            case .succeed:
                storage[key] = data
            case .mutateThenThrow(let error):
                storage[key] = data
                throw error
            case .throwBeforeMutation(let error):
                throw error
            case .replaceWith(let replacement):
                storage[key] = replacement
            }
        }
    }

    func removeValue(forKey key: String) throws {
        _ = lock.withLock {
            storage.removeValue(forKey: key)
        }
    }
}

private extension String {
    func chunked(every size: Int) -> [Substring] {
        stride(from: 0, to: count, by: size).map { offset in
            let start = index(startIndex, offsetBy: offset)
            let end = index(start, offsetBy: size, limitedBy: endIndex) ?? endIndex
            return self[start..<end]
        }
    }
}

// MARK: - Host readiness (issue #241, slice 1)

private actor ReadinessBoundaryGate {
    private var entered = false
    private var entryWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseContinuation: CheckedContinuation<Void, Never>?

    func suspend() async {
        entered = true
        let waiters = entryWaiters
        entryWaiters.removeAll()
        waiters.forEach { $0.resume() }
        await withCheckedContinuation { continuation in
            releaseContinuation = continuation
        }
    }

    func waitUntilEntered() async {
        guard !entered else { return }
        await withCheckedContinuation { continuation in
            entryWaiters.append(continuation)
        }
    }

    func release() {
        releaseContinuation?.resume()
        releaseContinuation = nil
    }
}

private actor ReadinessValidationRecorder {
    private var blockedSequence: UInt64?
    private var gate: ReadinessBoundaryGate?

    func validate(_ candidate: HostReadinessSnapshotCandidate) async throws {
        if blockedSequence == candidate.sequence, let gate {
            await gate.suspend()
        }
    }

    func block(sequence: UInt64, on gate: ReadinessBoundaryGate) {
        blockedSequence = sequence
        self.gate = gate
    }

}

@MainActor
private final class ReadinessBoundaryRecorder {
    let secureStore = FaultingTransactionSecureStore()
    let workspaceStore = WorkspaceStore()
    let pairedHostStore: PairedHostStore

    private var validationCalls: [String] = []
    private var validationFailure: (any Error)?

    init() {
        pairedHostStore = PairedHostStore(secureStore: secureStore)
    }

    var calls: [String] {
        validationCalls
    }

    var committedHostID: String? {
        secureStore.hosts()?.keys.sorted().last
    }

    var appliedWorkspaceSequence: UInt64? {
        workspaceStore.workspace == nil ? nil : workspaceStore.sequence
    }

    func setCommitFailure(_ error: (any Error)?, afterMutation: Bool = false) {
        guard error != nil else { return }
        secureStore.enqueue(
            afterMutation
                ? .mutateThenThrow(.writeFailed)
                : .throwBeforeMutation(.writeFailed)
        )
    }

    func setValidationFailure(_ error: (any Error)?) {
        validationFailure = error
    }

    func validateSnapshot(_ candidate: HostReadinessSnapshotCandidate) throws {
        validationCalls.append("validate:\(candidate.sequence)")
        if let validationFailure {
            throw validationFailure
        }
    }
}

private enum ReadinessBoundaryError: Error, Equatable {
    case commitFailed
    case validationFailed
}

/// Exhaustive coverage of the pure transition table: every allowed transition
/// is asserted, plus the rejections that prove an out-of-place event changes
/// nothing.
final class HostReadinessTransitionsTests: XCTestCase {
    func testStateRawValuesMatchTheIssueContract() {
        // The raw values are the contract's stable state names; the order is
        // the delivery order of the readiness spine.
        XCTAssertEqual(
            HostReadinessState.allCases.map(\.rawValue),
            [
                "unknown",
                "discovering",
                "pairing",
                "authenticating",
                "host_committed",
                "synchronizing",
                "ready",
                "degraded",
                "reconnecting",
                "revoked"
            ]
        )
    }

    func testTheReadinessSpineAdvancesOneStateAtATime() {
        // The spine `pairing → authenticating → host_committed →
        // synchronizing → ready` is the atomic sequence: authority is durably
        // committed before any snapshot may be applied, and `ready` is only
        // reachable through an accepted snapshot.
        XCTAssertEqual(
            HostReadinessTransitions.destination(for: .discoveryStarted, from: .unknown),
            .discovering
        )
        XCTAssertEqual(
            HostReadinessTransitions.destination(for: .pairingStarted, from: .discovering),
            .pairing
        )
        XCTAssertEqual(
            HostReadinessTransitions.destination(for: .pairingStarted, from: .ready),
            .pairing,
            "pairing a new host while one is ready is the retarget flow whose authority must be atomic"
        )
        XCTAssertEqual(
            HostReadinessTransitions.destination(for: .authenticationStarted, from: .pairing),
            .authenticating
        )
        XCTAssertEqual(
            HostReadinessTransitions.destination(for: .hostCommitSucceeded, from: .authenticating),
            .hostCommitted
        )
        XCTAssertEqual(
            HostReadinessTransitions.destination(for: .synchronizationStarted, from: .hostCommitted),
            .synchronizing
        )
        XCTAssertEqual(
            HostReadinessTransitions.destination(for: .workspaceAccepted, from: .synchronizing),
            .ready
        )
    }

    func testReconnectionAndRecoveryTransitions() {
        XCTAssertEqual(
            HostReadinessTransitions.destination(for: .reconnectionStarted, from: .unknown),
            .reconnecting
        )
        XCTAssertEqual(
            HostReadinessTransitions.destination(for: .reconnectionStarted, from: .degraded),
            .reconnecting
        )
        XCTAssertEqual(
            HostReadinessTransitions.destination(for: .reconnectionStarted, from: .ready),
            .reconnecting
        )
        XCTAssertEqual(
            HostReadinessTransitions.destination(for: .reconnectionStarted, from: .reconnecting),
            .reconnecting,
            "retrying a stored-host reconnection replaces the abandoned attempt"
        )
        XCTAssertEqual(
            HostReadinessTransitions.destination(for: .discoveryStarted, from: .reconnecting),
            .discovering
        )
        XCTAssertEqual(
            HostReadinessTransitions.destination(for: .discoveryStarted, from: .degraded),
            .discovering
        )
        XCTAssertEqual(
            HostReadinessTransitions.destination(for: .discoveryStarted, from: .revoked),
            .discovering,
            "the explicit re-pair path is the way out of revocation"
        )
        XCTAssertEqual(
            HostReadinessTransitions.destination(for: .connectionLost, from: .ready),
            .reconnecting
        )
    }

    func testRejectedTransitionsChangeNothing() {
        // Events from states their spine step does not belong to are rejected.
        XCTAssertNil(
            HostReadinessTransitions.destination(for: .workspaceAccepted, from: .hostCommitted)
        )
        XCTAssertNil(
            HostReadinessTransitions.destination(for: .synchronizationStarted, from: .authenticating)
        )
        XCTAssertNil(
            HostReadinessTransitions.destination(for: .hostCommitSucceeded, from: .synchronizing)
        )
        XCTAssertNil(
            HostReadinessTransitions.destination(for: .connectionLost, from: .synchronizing)
        )
        XCTAssertNil(
            HostReadinessTransitions.destination(for: .discoveryStarted, from: .ready)
        )
        XCTAssertNil(
            HostReadinessTransitions.destination(for: .pairingStarted, from: .authenticating),
            "pairing may not start inside an in-flight flow"
        )
        XCTAssertNil(
            HostReadinessTransitions.destination(for: .pairingStarted, from: .degraded),
            "a degraded machine recovers by reconnection, not by silently re-pairing"
        )
        XCTAssertNil(
            HostReadinessTransitions.destination(for: .reconnectionStarted, from: .revoked),
            "revoked credentials cannot reconnect; recovery is discovery and re-pair"
        )
        XCTAssertNil(
            HostReadinessTransitions.destination(for: .authenticationStarted, from: .discovering)
        )
    }

    func testEveryFailureBoundaryHasADeterministicDestination() {
        // In-flow failures with previous authority preserve it: transport
        // loss aims back at the committed host, everything else degrades.
        let flowStates: [HostReadinessState] = [
            .pairing, .authenticating, .hostCommitted, .synchronizing
        ]
        for state in flowStates {
            XCTAssertEqual(
                HostReadinessTransitions.destination(
                    forFailure: .transport,
                    from: state,
                    hasCommittedHost: true
                ),
                .reconnecting,
                "transport failure from \(state.rawValue) must aim at the committed host"
            )
            XCTAssertEqual(
                HostReadinessTransitions.destination(
                    forFailure: .transport,
                    from: state,
                    hasCommittedHost: false
                ),
                .unknown,
                "transport failure with no authority from \(state.rawValue) must report unknown"
            )
            for boundary: HostReadinessFailureBoundary in [
                .authentication, .secureStore, .decodeRevision, .workspaceApply
            ] {
                XCTAssertEqual(
                    HostReadinessTransitions.destination(
                        forFailure: boundary,
                        from: state,
                        hasCommittedHost: true
                    ),
                    .degraded,
                    "\(boundary.rawValue) failure from \(state.rawValue) must degrade with stale state preserved"
                )
                XCTAssertEqual(
                    HostReadinessTransitions.destination(
                        forFailure: boundary,
                        from: state,
                        hasCommittedHost: false
                    ),
                    .unknown,
                    "\(boundary.rawValue) failure for a first host must report unknown"
                )
            }
            XCTAssertEqual(
                HostReadinessTransitions.destination(
                    forFailure: .revocation,
                    from: state,
                    hasCommittedHost: true
                ),
                .revoked
            )
        }

        // A reconnection that cannot reach the stored host stops retrying and
        // degrades instead of looping.
        XCTAssertEqual(
            HostReadinessTransitions.destination(
                forFailure: .transport,
                from: .reconnecting,
                hasCommittedHost: true
            ),
            .degraded
        )
        // Transport loss on a live connection is `connectionLost`, not a
        // `.failed(.transport)` event.
        XCTAssertNil(
            HostReadinessTransitions.destination(
                forFailure: .transport,
                from: .ready,
                hasCommittedHost: true
            )
        )
    }

    func testRevocationFailsClosedFromEveryRestingAndFlowState() {
        for state in HostReadinessState.allCases {
            XCTAssertEqual(
                HostReadinessTransitions.destination(
                    forFailure: .revocation,
                    from: state,
                    hasCommittedHost: state == .ready || state == .revoked
                ),
                .revoked,
                "revocation must fail closed from \(state.rawValue)"
            )
        }
    }
}

/// Behavioral coverage of the machine: the atomic commit-before-apply
/// sequence, every rollback boundary, stale-state preservation, and the
/// single-flight concurrency guard.
@MainActor
final class HostReadinessMachineTests: XCTestCase {
    private let fixedDate = Date(timeIntervalSinceReferenceDate: 762_543_210)

    private func makeHost(serverID: String, clientID: String = "client-1") -> PairedHost {
        PairedHost(
            serverID: serverID,
            serverName: serverID == "new-host" ? "New Host" : "Studio",
            endpoint: HostEndpoint(
                host: "\(serverID).local",
                port: 4242,
                certificateFingerprint: String(repeating: "a", count: 64)
            ),
            clientID: clientID,
            token: "token-1"
        )
    }

    private func makeCandidate(sequence: UInt64) -> HostReadinessSnapshotCandidate {
        HostReadinessSnapshotCandidate(
            workspace: WorkspaceSnapshot(revision: 3, projects: []),
            sequence: sequence
        )
    }

    private func makeMachine(
        committedHost: PairedHost? = nil,
        recorder: ReadinessBoundaryRecorder
    ) -> HostReadinessMachine {
        HostReadinessMachine(
            committedHost: committedHost,
            pairedHostStore: recorder.pairedHostStore,
            workspaceStore: recorder.workspaceStore,
            validateSnapshot: { candidate in
                try await recorder.validateSnapshot(candidate)
            },
            now: { Date(timeIntervalSinceReferenceDate: 762_543_210) }
        )
    }

    /// Drives a full successful pairing to `ready`, so tests that need a
    /// previously authoritative host have something real on screen.
    @discardableResult
    private func driveToReady(
        _ machine: HostReadinessMachine,
        recorder: ReadinessBoundaryRecorder,
        host: PairedHost,
        sequence: UInt64 = 7
    ) async throws -> HostReadinessFlow {
        _ = try await machine.beginDiscovery()
        let flow = try await machine.beginPairing(expectedServerID: host.serverID)
        _ = try await machine.markAuthenticated(for: flow)
        try await machine.commitHostIdentity(host, for: flow)
        try await machine.synchronizeWorkspace(
            makeCandidate(sequence: sequence),
            for: flow
        )
        try machine.finalizeReadyHostSelection(serverID: host.serverID)
        return flow
    }

    func testHappyPathCommitsTheHostBeforeApplyingTheWorkspace() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)
        let host = makeHost(serverID: "new-host")

        try await driveToReady(machine, recorder: recorder, host: host)

        let state = await machine.state
        let presentation = await machine.presentation
        let committed = await machine.committedHost
        let failure = await machine.lastFailure
        XCTAssertEqual(
            recorder.calls,
            ["validate:7"],
            "validation must run before the workspace owner publishes"
        )
        let persistedHost = try await recorder.pairedHostStore.host(
            withServerID: host.serverID
        )
        XCTAssertEqual(persistedHost, host)
        XCTAssertEqual(recorder.workspaceStore.sequence, 7)
        XCTAssertEqual(state, .ready)
        XCTAssertEqual(presentation, .live(hostID: "new-host", confirmedAt: fixedDate))
        XCTAssertEqual(committed, host)
        XCTAssertNil(failure)
    }

    func testPairingCannotCommitHostBeforeAuthentication() async throws {
        let secureStore = SuccessfulWriteBoundarySecureStore()
        let pairedHostStore = PairedHostStore(secureStore: secureStore)
        let machine = HostReadinessMachine(
            pairedHostStore: pairedHostStore,
            workspaceStore: WorkspaceStore(),
            now: { Date(timeIntervalSinceReferenceDate: 762_543_210) }
        )
        let host = makeHost(serverID: "new-host")
        let flow = try machine.beginPairing(expectedServerID: host.serverID)

        do {
            _ = try await machine.commitHostIdentity(host, for: flow)
            XCTFail("Pairing must authenticate before publishing host authority")
        } catch let error as HostReadinessError {
            XCTAssertEqual(
                error,
                .transitionRejected(from: .pairing, event: "hostCommitStarted")
            )
        }

        let persistedHosts = try await pairedHostStore.hosts()
        XCTAssertEqual(secureStore.writeCount, 0)
        XCTAssertEqual(persistedHosts, [])
        XCTAssertNil(machine.committedHost)
        XCTAssertEqual(machine.state, .pairing)
        XCTAssertEqual(machine.activeFlow, flow)
    }

    func testReconnectionCannotCommitHostBeforeAuthentication() async throws {
        let secureStore = SuccessfulWriteBoundarySecureStore()
        let pairedHostStore = PairedHostStore(secureStore: secureStore)
        let committedHost = makeHost(serverID: "old-host", clientID: "client-old")
        try await pairedHostStore.save(committedHost)
        secureStore.resetWriteCount()
        let machine = HostReadinessMachine(
            committedHost: committedHost,
            pairedHostStore: pairedHostStore,
            workspaceStore: WorkspaceStore(),
            now: { Date(timeIntervalSinceReferenceDate: 762_543_210) }
        )
        let flow = try machine.beginReconnection()
        let refreshedHost = makeHost(serverID: "old-host", clientID: "client-refreshed")

        do {
            _ = try await machine.commitHostIdentity(refreshedHost, for: flow)
            XCTFail("Reconnection must authenticate before publishing host authority")
        } catch let error as HostReadinessError {
            XCTAssertEqual(
                error,
                .transitionRejected(from: .reconnecting, event: "hostCommitStarted")
            )
        }

        let persistedHost = try await pairedHostStore.host(
            withServerID: committedHost.serverID
        )
        XCTAssertEqual(secureStore.writeCount, 0)
        XCTAssertEqual(persistedHost, committedHost)
        XCTAssertEqual(machine.committedHost, committedHost)
        XCTAssertEqual(machine.state, .reconnecting)
        XCTAssertEqual(machine.activeFlow, flow)
    }

    func testReconnectionFromAStoredHostReachesReadyThroughTheSameSpine() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let host = makeHost(serverID: "old-host", clientID: "client-old")
        let machine = makeMachine(committedHost: host, recorder: recorder)

        let flow = try await machine.beginReconnection()
        _ = try await machine.markAuthenticated(for: flow)
        try await machine.commitHostIdentity(host, for: flow)
        try await machine.synchronizeWorkspace(makeCandidate(sequence: 7), for: flow)
        try machine.finalizeReadyHostSelection(serverID: host.serverID)

        let state = await machine.state
        XCTAssertEqual(state, .ready)
        XCTAssertEqual(recorder.calls, ["validate:7"])
        let presentation = await machine.presentation
        XCTAssertEqual(presentation, .live(hostID: "old-host", confirmedAt: fixedDate))
    }

    func testASecureStoreFailureNeverLeavesTheNewWorkspaceApplied() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)
        let oldHost = makeHost(serverID: "old-host", clientID: "client-old")
        try await driveToReady(machine, recorder: recorder, host: oldHost, sequence: 5)

        // A live workspace from the previously authoritative host exists.
        let livePresentation = await machine.presentation
        XCTAssertEqual(livePresentation, .live(hostID: "old-host", confirmedAt: fixedDate))

        recorder.setCommitFailure(ReadinessBoundaryError.commitFailed)
        let flow = try await machine.beginPairing(expectedServerID: "new-host")
        _ = try await machine.markAuthenticated(for: flow)

        let result = try await machine.commitHostIdentity(
            makeHost(serverID: "new-host"),
            for: flow
        )
        guard case .notCommitted = result else {
            return XCTFail("Expected the secure-store boundary not to commit, got \(result)")
        }

        let state = await machine.state
        let presentation = await machine.presentation
        let committed = await machine.committedHost
        let failure = await machine.lastFailure
        XCTAssertEqual(state, .degraded)
        XCTAssertEqual(
            presentation,
            .stale(hostID: "old-host", confirmedAt: fixedDate),
            "the previously authoritative workspace must survive, clearly stale"
        )
        XCTAssertEqual(committed, oldHost, "committed authority must survive the rollback")
        XCTAssertEqual(failure?.boundary, .secureStore)
        XCTAssertEqual(
            recorder.calls,
            ["validate:5"],
            "no snapshot may be applied after a failed commit"
        )
        XCTAssertEqual(recorder.workspaceStore.sequence, 5)
    }

    func testASecureStoreFailureForAFirstHostLeavesNoWorkspaceState() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)

        let flow = try await machine.beginPairing(expectedServerID: "new-host")
        _ = try await machine.markAuthenticated(for: flow)
        recorder.setCommitFailure(ReadinessBoundaryError.commitFailed)

        let result = try await machine.commitHostIdentity(
            makeHost(serverID: "new-host"),
            for: flow
        )
        guard case .notCommitted = result else {
            return XCTFail("Expected the secure-store boundary not to commit, got \(result)")
        }

        let state = await machine.state
        let presentation = await machine.presentation
        let committed = await machine.committedHost
        XCTAssertEqual(state, .unknown, "a failed first host leaves nothing authoritative")
        XCTAssertEqual(presentation, .noState, "a failed new host must not show any state")
        XCTAssertNil(committed)
        XCTAssertEqual(recorder.calls, [])
    }

    func testADecodeRevisionFailureRejectsTheSnapshotBeforeItIsApplied() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)
        let oldHost = makeHost(serverID: "old-host", clientID: "client-old")
        try await driveToReady(machine, recorder: recorder, host: oldHost, sequence: 5)

        recorder.setValidationFailure(ReadinessBoundaryError.validationFailed)
        let flow = try await machine.beginPairing(expectedServerID: "new-host")
        _ = try await machine.markAuthenticated(for: flow)
        try await machine.commitHostIdentity(makeHost(serverID: "new-host"), for: flow)

        do {
            try await machine.synchronizeWorkspace(makeCandidate(sequence: 7), for: flow)
            XCTFail("Expected the decode/revision boundary to reject the snapshot")
        } catch {
            // Expected.
        }

        let state = await machine.state
        let presentation = await machine.presentation
        XCTAssertEqual(state, .degraded)
        XCTAssertEqual(
            recorder.calls,
            ["validate:5", "validate:7"],
            "the workspace apply must never run after validation rejects the snapshot"
        )
        XCTAssertEqual(recorder.workspaceStore.sequence, 5)
        XCTAssertEqual(presentation, .stale(hostID: "old-host", confirmedAt: fixedDate))
    }

    func testAWorkspaceApplyFailureRollsBackWithoutASuccessShapedWorkspace() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)
        let oldHost = makeHost(serverID: "old-host", clientID: "client-old")
        try await driveToReady(machine, recorder: recorder, host: oldHost, sequence: 5)

        let flow = try await machine.beginPairing(expectedServerID: "new-host")
        _ = try await machine.markAuthenticated(for: flow)
        try await machine.commitHostIdentity(makeHost(serverID: "new-host"), for: flow)

        try await machine.synchronizeWorkspace(makeCandidate(sequence: 4), for: flow)

        let state = await machine.state
        let presentation = await machine.presentation
        XCTAssertEqual(state, .degraded)
        XCTAssertEqual(presentation, .stale(hostID: "old-host", confirmedAt: fixedDate))
        let committed = await machine.committedHost
        XCTAssertEqual(
            committed?.serverID,
            "old-host",
            "a pre-ready candidate must not replace the last ready authority"
        )
        XCTAssertEqual(recorder.calls, ["validate:5", "validate:4"])
        XCTAssertEqual(recorder.workspaceStore.sequence, 5)
    }

    func testATransportFailureDuringSynchronizationRollsBackToReconnecting() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)
        let oldHost = makeHost(serverID: "old-host", clientID: "client-old")
        try await driveToReady(machine, recorder: recorder, host: oldHost, sequence: 5)

        let flow = try await machine.beginPairing(expectedServerID: "new-host")
        _ = try await machine.markAuthenticated(for: flow)
        try await machine.commitHostIdentity(makeHost(serverID: "new-host"), for: flow)
        _ = try await machine.fail(.transport, reason: "Connection lost", for: flow)

        let state = await machine.state
        let presentation = await machine.presentation
        XCTAssertEqual(state, .reconnecting)
        XCTAssertEqual(presentation, .stale(hostID: "old-host", confirmedAt: fixedDate))
        XCTAssertEqual(recorder.workspaceStore.sequence, 5)
    }

    func testAnAuthenticationFailurePreservesThePreviousStaleState() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)
        let oldHost = makeHost(serverID: "old-host", clientID: "client-old")
        try await driveToReady(machine, recorder: recorder, host: oldHost, sequence: 5)

        let flow = try await machine.beginPairing(expectedServerID: "new-host")
        _ = try await machine.fail(.authentication, reason: "Pairing rejected", for: flow)

        let state = await machine.state
        let presentation = await machine.presentation
        let failure = await machine.lastFailure
        XCTAssertEqual(state, .degraded)
        XCTAssertEqual(presentation, .stale(hostID: "old-host", confirmedAt: fixedDate))
        XCTAssertEqual(failure?.boundary, .authentication)
        XCTAssertEqual(failure?.reason, "Pairing rejected")
        XCTAssertEqual(failure?.stateAtFailure, .pairing)
    }

    func testAConnectionLostRelabelsALiveWorkspaceStaleAndAimsAtTheStoredHost() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)
        try await driveToReady(
            machine,
            recorder: recorder,
            host: makeHost(serverID: "old-host", clientID: "client-old")
        )

        _ = try await machine.noteConnectionLost()

        let state = await machine.state
        let presentation = await machine.presentation
        XCTAssertEqual(state, .reconnecting)
        XCTAssertEqual(presentation, .stale(hostID: "old-host", confirmedAt: fixedDate))
        let committed = await machine.committedHost
        XCTAssertEqual(committed, makeHost(serverID: "old-host", clientID: "client-old"))
    }

    func testAWrongHostIdentityAtTheCommitBoundaryFailsClosed() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)
        let oldHost = makeHost(serverID: "old-host", clientID: "client-old")
        try await driveToReady(machine, recorder: recorder, host: oldHost, sequence: 5)

        let flow = try await machine.beginReconnection()
        _ = try await machine.markAuthenticated(for: flow)

        do {
            try await machine.commitHostIdentity(
                makeHost(serverID: "impostor", clientID: "client-9"),
                for: flow
            )
            XCTFail("A wrong-host identity must fail closed")
        } catch let error as HostReadinessError {
            XCTAssertEqual(
                error,
                .wrongHostIdentity(expected: "old-host", actual: "impostor")
            )
        }

        let state = await machine.state
        let committed = await machine.committedHost
        let failure = await machine.lastFailure
        let stalePresentation = await machine.presentation
        XCTAssertEqual(state, .revoked)
        XCTAssertEqual(committed, oldHost, "committed authority must not be overwritten")
        XCTAssertEqual(
            stalePresentation,
            .stale(hostID: "old-host", confirmedAt: fixedDate)
        )
        XCTAssertEqual(recorder.calls, ["validate:5"])
        let persistedImpostor = try await recorder.pairedHostStore.host(
            withServerID: "impostor"
        )
        XCTAssertNil(persistedImpostor, "a wrong-host commit must never reach the secure store")
        XCTAssertEqual(failure?.boundary, .revocation)
    }

    func testASupersededFlowCannotCommitOrApplyAnything() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)
        let oldHost = makeHost(serverID: "old-host", clientID: "client-old")
        try await driveToReady(machine, recorder: recorder, host: oldHost, sequence: 5)

        let superseded = try await machine.beginPairing(expectedServerID: "new-host")
        _ = try await machine.markAuthenticated(for: superseded)
        try await machine.commitHostIdentity(
            makeHost(serverID: "new-host", clientID: "client-new"),
            for: superseded
        )
        _ = try await machine.fail(.transport, reason: "Connection lost", for: superseded)

        let retry = try await machine.beginReconnection()
        XCTAssertNotEqual(retry, superseded)

        // The abandoned flow wakes up and tries to commit again.
        do {
            try await machine.commitHostIdentity(
                makeHost(serverID: "rogue-host", clientID: "client-rogue"),
                for: superseded
            )
            XCTFail("A superseded flow must not be able to commit")
        } catch let error as HostReadinessError {
            XCTAssertEqual(error, .supersededFlow)
        }

        do {
            try await machine.synchronizeWorkspace(makeCandidate(sequence: 9), for: superseded)
            XCTFail("A superseded flow must not be able to apply a snapshot")
        } catch {
            // Expected.
        }

        let state = await machine.state
        let committed = await machine.committedHost
        XCTAssertEqual(state, .reconnecting)
        XCTAssertEqual(committed, oldHost)
        XCTAssertEqual(
            recorder.calls,
            ["validate:5"],
            "only the owning flow ever crosses the commit boundary"
        )
    }

    func testAStaleCommitCannotOverwriteANewerAuthoritativeHost() async throws {
        let secureStore = SaveBoundarySecureStore()
        let pairedHostStore = PairedHostStore(secureStore: secureStore)
        let machine = HostReadinessMachine(
            pairedHostStore: pairedHostStore,
            workspaceStore: WorkspaceStore(),
            now: { Date(timeIntervalSinceReferenceDate: 762_543_210) }
        )

        let staleFlow = try await machine.beginPairing(expectedServerID: "stale-host")
        _ = try await machine.markAuthenticated(for: staleFlow)
        let staleHost = makeHost(serverID: "stale-host")
        secureStore.blockNextRead()
        let staleCommit = Task {
            try await machine.commitHostIdentity(staleHost, for: staleFlow)
        }
        try await secureStore.waitUntilReadBegins()

        _ = try await machine.revoke(reason: "Credential revoked")
        _ = try await machine.beginDiscovery()
        let freshFlow = try await machine.beginPairing(expectedServerID: "fresh-host")
        _ = try await machine.markAuthenticated(for: freshFlow)
        let freshHost = makeHost(serverID: "fresh-host", clientID: "client-fresh")
        let freshCommit = Task {
            try await machine.commitHostIdentity(freshHost, for: freshFlow)
        }

        secureStore.releaseRead()
        let staleResult = try await staleCommit.value
        let freshResult = try await freshCommit.value
        XCTAssertEqual(staleResult, .notCommitted(reason: nil))
        XCTAssertEqual(freshResult, .committed)
        try await machine.synchronizeWorkspace(makeCandidate(sequence: 8), for: freshFlow)
        try machine.finalizeReadyHostSelection(serverID: freshHost.serverID)

        let state = await machine.state
        let committedHost = await machine.committedHost
        let persistedHost = try await pairedHostStore.host(withServerID: freshHost.serverID)
        XCTAssertEqual(state, .ready)
        XCTAssertEqual(committedHost, freshHost)
        XCTAssertEqual(
            persistedHost,
            freshHost,
            "a stale async commit must never overwrite the newer durable authority"
        )
    }

    func testSuccessfulHostWriteLinearizesBeforeConcurrentRevocation() async throws {
        let secureStore = SuccessfulWriteBoundarySecureStore()
        let pairedHostStore = PairedHostStore(secureStore: secureStore)
        let machine = HostReadinessMachine(
            pairedHostStore: pairedHostStore,
            workspaceStore: WorkspaceStore(),
            now: { Date(timeIntervalSinceReferenceDate: 762_543_210) }
        )
        let host = makeHost(serverID: "new-host")
        let flow = try machine.beginPairing(expectedServerID: host.serverID)
        _ = try machine.markAuthenticated(for: flow)

        secureStore.blockNextWrite()
        let commit = Task {
            try await machine.commitHostIdentity(host, for: flow)
        }
        try await secureStore.waitUntilWriteBegins()

        let revocationStarted = BoundedAsyncSignal()
        let release = Task.detached {
            try await revocationStarted.wait(
                for: "host readiness revocation to begin",
                timeout: .seconds(1)
            )
            secureStore.releaseWrite()
        }
        let revocation = Task { @MainActor in
            revocationStarted.signal()
            return try machine.revoke(reason: "Credential revoked")
        }

        let revokedState = try await revocation.value
        let commitResult = try await commit.value
        try await release.value
        let persistedHost = try await pairedHostStore.host(withServerID: host.serverID)

        XCTAssertEqual(commitResult, .committed)
        XCTAssertEqual(revokedState, .revoked)
        XCTAssertEqual(persistedHost, host)
        XCTAssertNil(machine.committedHost)
        XCTAssertEqual(machine.state, .revoked)
        XCTAssertNil(machine.activeFlow)
        XCTAssertEqual(machine.lastFailure?.stateAtFailure, .hostCommitted)
    }

    func testWrongHostFailureReconcilesAConcurrentSuccessfulHostWrite() async throws {
        let secureStore = SuccessfulWriteBoundarySecureStore()
        let pairedHostStore = PairedHostStore(secureStore: secureStore)
        let machine = HostReadinessMachine(
            pairedHostStore: pairedHostStore,
            workspaceStore: WorkspaceStore(),
            now: { Date(timeIntervalSinceReferenceDate: 762_543_210) }
        )
        let host = makeHost(serverID: "new-host")
        let flow = try machine.beginPairing(expectedServerID: host.serverID)
        _ = try machine.markAuthenticated(for: flow)

        secureStore.blockNextWrite()
        let commit = Task {
            try await machine.commitHostIdentity(host, for: flow)
        }
        try await secureStore.waitUntilWriteBegins()

        let failureStarted = BoundedAsyncSignal()
        let release = Task.detached {
            try await failureStarted.wait(
                for: "wrong-host failure to begin",
                timeout: .seconds(1)
            )
            secureStore.releaseWrite()
        }
        let wrongHost = Task { @MainActor in
            failureStarted.signal()
            return try await machine.commitHostIdentity(
                makeHost(serverID: "rogue-host", clientID: "client-rogue"),
                for: flow
            )
        }

        do {
            _ = try await wrongHost.value
            XCTFail("A wrong-host identity must fail closed")
        } catch let error as HostReadinessError {
            XCTAssertEqual(
                error,
                .wrongHostIdentity(expected: host.serverID, actual: "rogue-host")
            )
        }
        let commitResult = try await commit.value
        try await release.value
        let persistedHost = try await pairedHostStore.host(withServerID: host.serverID)

        XCTAssertEqual(commitResult, .committed)
        XCTAssertEqual(secureStore.writeCount, 1)
        XCTAssertEqual(persistedHost, host)
        XCTAssertNil(machine.committedHost)
        XCTAssertEqual(machine.state, .revoked)
        XCTAssertNil(machine.activeFlow)
        XCTAssertEqual(machine.lastFailure?.boundary, .revocation)
        XCTAssertEqual(machine.lastFailure?.stateAtFailure, .hostCommitted)
    }

    func testConcurrentValidHostPublicationsCommitExactlyOnce() async throws {
        let secureStore = SuccessfulWriteBoundarySecureStore()
        let pairedHostStore = PairedHostStore(secureStore: secureStore)
        let machine = HostReadinessMachine(
            pairedHostStore: pairedHostStore,
            workspaceStore: WorkspaceStore(),
            now: { Date(timeIntervalSinceReferenceDate: 762_543_210) }
        )
        let firstHost = makeHost(serverID: "new-host", clientID: "client-first")
        let secondHost = makeHost(serverID: "new-host", clientID: "client-second")
        let flow = try machine.beginPairing(expectedServerID: firstHost.serverID)
        _ = try machine.markAuthenticated(for: flow)

        secureStore.blockNextWrite()
        let firstCommit = Task {
            try await machine.commitHostIdentity(firstHost, for: flow)
        }
        try await secureStore.waitUntilWriteBegins()

        let secondStarted = BoundedAsyncSignal()
        let release = Task.detached {
            try await secondStarted.wait(
                for: "second host publication to begin",
                timeout: .seconds(1)
            )
            secureStore.releaseWrite()
        }
        let secondCommit = Task { @MainActor in
            secondStarted.signal()
            return try await machine.commitHostIdentity(secondHost, for: flow)
        }

        let firstResult = try await firstCommit.value
        let secondResult = try await secondCommit.value
        try await release.value
        let persistedHost = try await pairedHostStore.host(withServerID: firstHost.serverID)

        XCTAssertEqual(firstResult, .committed)
        XCTAssertEqual(secondResult, .notCommitted(reason: nil))
        XCTAssertEqual(secureStore.writeCount, 1)
        XCTAssertEqual(persistedHost, firstHost)
        XCTAssertNil(machine.committedHost)
        XCTAssertEqual(machine.authenticatedHost, firstHost)
        XCTAssertEqual(machine.state, .hostCommitted)
        XCTAssertEqual(machine.activeFlow, flow)
    }

    func testSuccessfulHostWriteLinearizesBeforeConcurrentFailure() async throws {
        let secureStore = SuccessfulWriteBoundarySecureStore()
        let pairedHostStore = PairedHostStore(secureStore: secureStore)
        let machine = HostReadinessMachine(
            pairedHostStore: pairedHostStore,
            workspaceStore: WorkspaceStore(),
            now: { Date(timeIntervalSinceReferenceDate: 762_543_210) }
        )
        let host = makeHost(serverID: "new-host")
        let flow = try machine.beginPairing(expectedServerID: host.serverID)
        _ = try machine.markAuthenticated(for: flow)

        secureStore.blockNextWrite()
        let commit = Task {
            try await machine.commitHostIdentity(host, for: flow)
        }
        try await secureStore.waitUntilWriteBegins()

        let failureStarted = BoundedAsyncSignal()
        let release = Task.detached {
            try await failureStarted.wait(
                for: "host readiness failure to begin",
                timeout: .seconds(1)
            )
            secureStore.releaseWrite()
        }
        let failure = Task { @MainActor in
            failureStarted.signal()
            return try machine.fail(.transport, reason: "Connection lost", for: flow)
        }

        let failedState = try await failure.value
        let commitResult = try await commit.value
        try await release.value
        let persistedHost = try await pairedHostStore.host(withServerID: host.serverID)

        XCTAssertEqual(commitResult, .committed)
        XCTAssertEqual(failedState, .unknown)
        XCTAssertEqual(persistedHost, host)
        XCTAssertNil(machine.committedHost)
        XCTAssertEqual(machine.state, .unknown)
        XCTAssertNil(machine.activeFlow)
        XCTAssertEqual(machine.lastFailure?.boundary, .transport)
        XCTAssertEqual(machine.lastFailure?.stateAtFailure, .hostCommitted)
    }

    func testStaleFlowTeardownAfterSynchronizationRollsBackProvisionalReadiness() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)
        let oldHost = makeHost(serverID: "old-host", clientID: "client-old")
        try await driveToReady(machine, recorder: recorder, host: oldHost, sequence: 5)
        let previousWorkspace = recorder.workspaceStore.workspace

        let flow = try machine.beginPairing(expectedServerID: "new-host")
        _ = try machine.markAuthenticated(for: flow)
        try await machine.commitHostIdentity(
            makeHost(serverID: "new-host", clientID: "client-new"),
            for: flow
        )
        try await machine.synchronizeWorkspace(makeCandidate(sequence: 8), for: flow)

        let state = try machine.reconcileConnectionLoss(
            ownedFlow: flow,
            reason: "Transport disconnected"
        )

        XCTAssertEqual(state, .reconnecting)
        XCTAssertEqual(machine.committedHost, oldHost)
        XCTAssertEqual(recorder.workspaceStore.sequence, 5)
        XCTAssertEqual(recorder.workspaceStore.workspace, previousWorkspace)
        XCTAssertEqual(
            machine.presentation,
            .stale(hostID: oldHost.serverID, confirmedAt: fixedDate)
        )
    }

    func testAStaleWorkspaceApplyCannotOverwriteANewerAuthoritativeWorkspace() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let staleApplyGate = ReadinessBoundaryGate()
        let validation = ReadinessValidationRecorder()
        await validation.block(sequence: 7, on: staleApplyGate)
        let machine = HostReadinessMachine(
            pairedHostStore: recorder.pairedHostStore,
            workspaceStore: recorder.workspaceStore,
            validateSnapshot: { candidate in
                try await validation.validate(candidate)
            },
            now: { Date(timeIntervalSinceReferenceDate: 762_543_210) }
        )

        let staleFlow = try await machine.beginPairing(expectedServerID: "stale-host")
        _ = try await machine.markAuthenticated(for: staleFlow)
        try await machine.commitHostIdentity(makeHost(serverID: "stale-host"), for: staleFlow)
        let staleCandidate = makeCandidate(sequence: 7)
        let staleApply = Task {
            try await machine.synchronizeWorkspace(staleCandidate, for: staleFlow)
        }
        await staleApplyGate.waitUntilEntered()

        _ = try await machine.revoke(reason: "Credential revoked")
        _ = try await machine.beginDiscovery()
        let freshFlow = try await machine.beginPairing(expectedServerID: "fresh-host")
        _ = try await machine.markAuthenticated(for: freshFlow)
        try await machine.commitHostIdentity(
            makeHost(serverID: "fresh-host", clientID: "client-fresh"),
            for: freshFlow
        )
        try await machine.synchronizeWorkspace(makeCandidate(sequence: 8), for: freshFlow)
        try machine.finalizeReadyHostSelection(serverID: "fresh-host")

        await staleApplyGate.release()
        do {
            try await staleApply.value
            XCTFail("The stale apply must be rejected after revocation and replacement")
        } catch let error as HostReadinessError {
            XCTAssertEqual(error, .supersededFlow)
        }

        let state = await machine.state
        XCTAssertEqual(state, .ready)
        XCTAssertEqual(
            recorder.appliedWorkspaceSequence,
            8,
            "a stale async apply must never overwrite the newer authoritative workspace"
        )
    }

    func testAnAtomicPublicationFailureDoesNotPublishOrAdvanceReadiness() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)
        let host = makeHost(serverID: "new-host")
        let flow = try await machine.beginPairing(expectedServerID: host.serverID)
        _ = try await machine.markAuthenticated(for: flow)

        recorder.setCommitFailure(ReadinessBoundaryError.commitFailed)
        let result = try await machine.commitHostIdentity(host, for: flow)
        guard case .notCommitted = result else {
            return XCTFail("Expected an explicit not-committed result, got \(result)")
        }

        let state = await machine.state
        let committedHost = await machine.committedHost
        XCTAssertEqual(state, .unknown)
        XCTAssertNil(committedHost)
        XCTAssertNil(
            recorder.committedHostID,
            "a throwing publication must fail closed without durable authority"
        )
    }

    func testAMutateThenThrowPublicationReportsNotCommittedAfterVerifiedCompensation() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)
        let host = makeHost(serverID: "new-host")
        let flow = try await machine.beginPairing(expectedServerID: host.serverID)
        _ = try await machine.markAuthenticated(for: flow)

        recorder.setCommitFailure(ReadinessBoundaryError.commitFailed, afterMutation: true)
        let result = try await machine.commitHostIdentity(host, for: flow)
        guard case .notCommitted = result else {
            return XCTFail("Expected verified compensation, got \(result)")
        }

        XCTAssertNil(recorder.committedHostID)
        let state = await machine.state
        let failure = await machine.lastFailure
        XCTAssertEqual(state, .unknown)
        XCTAssertEqual(failure?.recovery, .rolledBack)
    }

    @MainActor
    func testIndeterminateStorePublicationIsExplicitAndFailsClosed() async throws {
        let secureStore = FaultingTransactionSecureStore()
        let pairedHostStore = PairedHostStore(secureStore: secureStore)
        let oldHost = makeHost(serverID: "old-host", clientID: "client-old")
        try await pairedHostStore.save(oldHost)
        secureStore.enqueue(.mutateThenThrow(.writeFailed))
        secureStore.enqueue(.throwBeforeMutation(.compensationFailed))
        let machine = HostReadinessMachine(
            committedHost: oldHost,
            pairedHostStore: pairedHostStore,
            workspaceStore: WorkspaceStore(),
            now: { Date(timeIntervalSinceReferenceDate: 762_543_210) }
        )
        let host = makeHost(serverID: "new-host")
        let flow = try machine.beginPairing(expectedServerID: host.serverID)
        _ = try machine.markAuthenticated(for: flow)

        let result = try await machine.commitHostIdentity(host, for: flow)

        guard case .indeterminate = result else {
            return XCTFail("Expected explicit indeterminate result, got \(result)")
        }
        XCTAssertEqual(machine.state, .revoked)
        XCTAssertEqual(machine.lastFailure?.recovery, .indeterminate)
        XCTAssertEqual(machine.presentation, .noState)
    }

    func testASecondFlowCannotStartWhileOneIsActive() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)

        let first = try await machine.beginPairing(expectedServerID: "first-host")
        do {
            _ = try await machine.beginPairing(expectedServerID: "second-host")
            XCTFail("A second readiness flow must be refused while one is active")
        } catch let error as HostReadinessError {
            XCTAssertEqual(error, .flowAlreadyActive(serverID: "first-host"))
        }

        // The active flow is untouched by the rejected one.
        _ = try await machine.markAuthenticated(for: first)
        let state = await machine.state
        XCTAssertEqual(state, .authenticating)
    }

    func testReconnectionRequiresACommittedHost() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)

        do {
            _ = try await machine.beginReconnection()
            XCTFail("Reconnection without committed authority must be refused")
        } catch let error as HostReadinessError {
            XCTAssertEqual(error, .committedHostRequired)
        }
    }

    func testSynchronizationRequiresACommittedHost() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)

        let flow = try await machine.beginPairing(expectedServerID: "new-host")
        _ = try await machine.markAuthenticated(for: flow)

        do {
            try await machine.synchronizeWorkspace(makeCandidate(sequence: 7), for: flow)
            XCTFail("Synchronization requires a committed host")
        } catch {
            // Expected: no commit, no snapshot.
        }

        XCTAssertTrue(recorder.calls.isEmpty)
    }

    func testABeginFlowRelabelsALiveWorkspaceStaleImmediately() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)
        try await driveToReady(
            machine,
            recorder: recorder,
            host: makeHost(serverID: "old-host", clientID: "client-old")
        )

        _ = try await machine.beginPairing(expectedServerID: "new-host")

        let presentation = await machine.presentation
        XCTAssertEqual(
            presentation,
            .stale(hostID: "old-host", confirmedAt: fixedDate),
            "the visible workspace cannot vouch for itself once a flow retargets the transport"
        )
    }

    func testAReadinessFlowPreservesTheWorkspaceConnectionGeneration() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let generation = ConnectionGeneration(id: 1)
        recorder.workspaceStore.beginConnection(for: generation)
        let machine = makeMachine(recorder: recorder)
        let host = makeHost(serverID: "new-host")

        let flow = try machine.beginPairing(expectedServerID: host.serverID)
        _ = try machine.markAuthenticated(for: flow)
        try await machine.commitHostIdentity(host, for: flow)
        try await machine.synchronizeWorkspace(makeCandidate(sequence: 8), for: flow)
        try machine.finalizeReadyHostSelection(serverID: host.serverID)
        recorder.workspaceStore.applyEvent(
            workspace: WorkspaceSnapshot(revision: 9, projects: []),
            sequence: 9,
            for: generation
        )

        XCTAssertEqual(recorder.workspaceStore.workspace?.revision, 9)
        XCTAssertEqual(recorder.workspaceStore.sequence, 9)
    }

    func testARollbackKeepsThePreviousConfirmedAtTimestamp() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)
        try await driveToReady(
            machine,
            recorder: recorder,
            host: makeHost(serverID: "old-host", clientID: "client-old")
        )

        let flow = try await machine.beginPairing(expectedServerID: "new-host")
        _ = try await machine.markAuthenticated(for: flow)
        try await machine.commitHostIdentity(makeHost(serverID: "new-host"), for: flow)

        try await machine.synchronizeWorkspace(makeCandidate(sequence: 6), for: flow)

        let presentation = await machine.presentation
        guard case .stale(let hostID, let confirmedAt) = presentation else {
            return XCTFail("Expected stale presentation after rollback, got \(presentation)")
        }
        XCTAssertEqual(hostID, "old-host")
        XCTAssertEqual(confirmedAt, fixedDate)
    }

    func testRevocationFailsClosedAndRecoveryGoesThroughDiscovery() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)
        let oldHost = makeHost(serverID: "old-host", clientID: "client-old")
        try await driveToReady(machine, recorder: recorder, host: oldHost)

        _ = try await machine.revoke(reason: "Token revoked")

        var state = await machine.state
        var presentation = await machine.presentation
        XCTAssertEqual(state, .revoked)
        XCTAssertEqual(presentation, .stale(hostID: "old-host", confirmedAt: fixedDate))
        let stillCommitted = await machine.committedHost
        XCTAssertEqual(stillCommitted, makeHost(serverID: "old-host", clientID: "client-old"))

        // Recovery is the explicit path: discovery, then a fresh pairing.
        _ = try await machine.beginDiscovery()
        let flow = try await machine.beginPairing(expectedServerID: "new-host")
        _ = try await machine.markAuthenticated(for: flow)
        try await machine.commitHostIdentity(makeHost(serverID: "new-host"), for: flow)
        try await machine.synchronizeWorkspace(makeCandidate(sequence: 7), for: flow)
        try machine.finalizeReadyHostSelection(serverID: "new-host")

        state = await machine.state
        presentation = await machine.presentation
        XCTAssertEqual(state, .ready)
        XCTAssertEqual(presentation, .live(hostID: "new-host", confirmedAt: fixedDate))
    }

    func testADegradedStateRecoversThroughAReconnectionFlow() async throws {
        let recorder = ReadinessBoundaryRecorder()
        let machine = makeMachine(recorder: recorder)
        let host = makeHost(serverID: "old-host", clientID: "client-old")
        try await driveToReady(machine, recorder: recorder, host: host, sequence: 5)

        // Commit the new host, then fail at the workspace-apply boundary.
        let failed = try await machine.beginPairing(expectedServerID: "new-host")
        _ = try await machine.markAuthenticated(for: failed)
        try await machine.commitHostIdentity(
            makeHost(serverID: "new-host", clientID: "client-new"),
            for: failed
        )
        try await machine.synchronizeWorkspace(makeCandidate(sequence: 4), for: failed)
        let degradedState = await machine.state
        XCTAssertEqual(degradedState, .degraded)

        // Recovery runs the same spine against the last ready authority, with
        // the workspace boundary healthy again.
        let retry = try await machine.beginReconnection()
        _ = try await machine.markAuthenticated(for: retry)
        try await machine.commitHostIdentity(
            host,
            for: retry
        )
        try await machine.synchronizeWorkspace(makeCandidate(sequence: 8), for: retry)
        try machine.finalizeReadyHostSelection(serverID: host.serverID)

        let state = await machine.state
        XCTAssertEqual(state, .ready)
        let presentation = await machine.presentation
        XCTAssertEqual(presentation, .live(hostID: "old-host", confirmedAt: fixedDate))
    }
}
