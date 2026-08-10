import Foundation
import XCTest
@testable import PsycheCore

final class ControlRequestClientTests: XCTestCase {
    func testRequestBeforeGenerationActivationFailsWithoutSending() async {
        let transport = AmbiguousFailingTransport()
        let client = ControlRequestClient(transport: transport, scheduler: ManualScheduler())

        do {
            _ = try await client.send(.workspaceSnapshot(
                ControlRequestIDOnly(requestID: "pre-v3")
            ))
            XCTFail("Expected a request before v3 activation to fail")
        } catch {
            XCTAssertEqual(error as? ControlRequestError, .disconnected)
        }

        let sent = await transport.sentMessages
        let pending = await client.pendingRequestCount
        XCTAssertTrue(sent.isEmpty)
        XCTAssertEqual(pending, 0)
    }

    func testCorrelatesAResponseBackToItsCaller() async throws {
        let transport = FakeTransport()
        try await transport.connect(to: endpoint())
        let client = ControlRequestClient(transport: transport, scheduler: ManualScheduler())
        _ = await activateGeneration(on: client)

        async let response = client.send(.workspaceSnapshot(ControlRequestIDOnly(requestID: "req-1")))
        try await waitForPendingRequest(on: client)
        await client.handle(.ack(ControlAckResponse(requestID: "req-1")))

        let value = try await response
        let sent = await transport.sentMessages
        XCTAssertEqual(value, .ack(ControlAckResponse(requestID: "req-1")))
        XCTAssertEqual(
            sent,
            [.control(.workspaceSnapshot(ControlRequestIDOnly(requestID: "req-1")))]
        )
        let remaining = await client.pendingRequestCount
        XCTAssertEqual(remaining, 0)
    }

    func testAnswersOnlyTheRequestThatAsked() async throws {
        let transport = FakeTransport()
        try await transport.connect(to: endpoint())
        let client = ControlRequestClient(transport: transport, scheduler: ManualScheduler())
        _ = await activateGeneration(on: client)

        async let first = client.send(.workspaceSnapshot(ControlRequestIDOnly(requestID: "req-1")))
        async let second = client.send(.killPane(PaneIDControlRequest(requestID: "req-2", paneID: "pane-1")))
        try await waitForPendingRequest(on: client, count: 2)

        await client.handle(.ack(ControlAckResponse(requestID: "req-2", ok: false)))
        let secondValue = try await second

        await client.handle(.ack(ControlAckResponse(requestID: "req-1")))
        let firstValue = try await first

        XCTAssertEqual(secondValue, .ack(ControlAckResponse(requestID: "req-2", ok: false)))
        XCTAssertEqual(firstValue, .ack(ControlAckResponse(requestID: "req-1")))
    }

    func testProtocolErrorPropagatesToTheWaitingCaller() async throws {
        let transport = FakeTransport()
        try await transport.connect(to: endpoint())
        let client = ControlRequestClient(transport: transport, scheduler: ManualScheduler())
        _ = await activateGeneration(on: client)
        let failure = MobileProtocolErrorResponse(
            requestID: "req-1",
            code: "pane_not_found",
            message: "No such pane"
        )

        async let response = client.send(.workspaceSnapshot(ControlRequestIDOnly(requestID: "req-1")))
        try await waitForPendingRequest(on: client)
        await client.handle(.error(failure))

        do {
            _ = try await response
            XCTFail("Expected the protocol error to propagate")
        } catch {
            XCTAssertEqual(error as? MobileProtocolErrorResponse, failure)
            XCTAssertEqual(error.localizedDescription, "No such pane")
        }
        let remaining = await client.pendingRequestCount
        XCTAssertEqual(remaining, 0)
    }

    func testConnectionWideErrorIsNotCorrelatedToAnyCaller() async throws {
        let transport = FakeTransport()
        try await transport.connect(to: endpoint())
        let client = ControlRequestClient(transport: transport, scheduler: ManualScheduler())
        _ = await activateGeneration(on: client)

        async let response = client.send(.workspaceSnapshot(ControlRequestIDOnly(requestID: "req-1")))
        try await waitForPendingRequest(on: client)

        let handled = await client.handle(.error(MobileProtocolErrorResponse(
            requestID: nil,
            code: "unauthorized",
            message: "Pair first"
        )))
        XCTAssertFalse(handled)

        await client.handle(.ack(ControlAckResponse(requestID: "req-1")))
        let value = try await response
        XCTAssertEqual(value, .ack(ControlAckResponse(requestID: "req-1")))
    }

    func testUnsolicitedEventIsNotCorrelated() async {
        let client = ControlRequestClient(transport: FakeTransport(), scheduler: ManualScheduler())

        let handled = await client.handle(.streamExited(PaneStreamExitedResponse(
            streamID: "stream-1",
            reason: "exited"
        )))

        XCTAssertFalse(handled)
    }

    func testTimeoutFailsTheCallerAndClearsThePendingRequest() async throws {
        let transport = FakeTransport()
        try await transport.connect(to: endpoint())
        let scheduler = ManualScheduler()
        let client = ControlRequestClient(transport: transport, scheduler: scheduler)
        _ = await activateGeneration(on: client)

        async let response = client.send(.workspaceSnapshot(ControlRequestIDOnly(requestID: "req-1")))
        try await waitForPendingRequest(on: client)
        // The client starts its timeout task asynchronously, so firing before
        // that task reaches sleep would lose the fire and hang the test.
        try await waitForScheduler(on: scheduler, count: 1)
        await scheduler.fire()

        do {
            _ = try await response
            XCTFail("Expected the request to time out")
        } catch {
            XCTAssertEqual(error as? ControlRequestError, .timedOut("req-1"))
        }
        let remaining = await client.pendingRequestCount
        XCTAssertEqual(remaining, 0)
    }

    func testUsesTheInjectedTimeoutAndDefaultsProductionToFifteenSeconds() async throws {
        let transport = FakeTransport()
        try await transport.connect(to: endpoint())
        let scheduler = ManualScheduler()
        let timeout = Duration.milliseconds(250)
        let client = ControlRequestClient(
            transport: transport,
            scheduler: scheduler,
            timeout: timeout
        )
        _ = await activateGeneration(on: client)

        async let response = client.send(.workspaceSnapshot(
            ControlRequestIDOnly(requestID: "req-1")
        ))
        try await waitForPendingRequest(on: client)
        try await waitForScheduler(on: scheduler, count: 1)

        let durations = await scheduler.requestedDurations
        XCTAssertEqual(durations, [timeout])
        XCTAssertEqual(ControlRequestClient.defaultTimeout, .seconds(15))

        await scheduler.fire()
        _ = try? await response
    }

    func testALateResponseAfterATimeoutIsIgnored() async throws {
        let transport = FakeTransport()
        try await transport.connect(to: endpoint())
        let scheduler = ManualScheduler()
        let client = ControlRequestClient(transport: transport, scheduler: scheduler)
        _ = await activateGeneration(on: client)

        async let response = client.send(.workspaceSnapshot(ControlRequestIDOnly(requestID: "req-1")))
        try await waitForPendingRequest(on: client)
        try await waitForScheduler(on: scheduler, count: 1)
        await scheduler.fire()
        _ = try? await response

        // Resuming a second time would trap, so this passing at all is the
        // assertion that matters.
        let handled = await client.handle(.ack(ControlAckResponse(requestID: "req-1")))
        XCTAssertFalse(handled)
    }

    func testTimedOutIDCannotBeReusedBeforeDisconnect() async throws {
        let transport = FakeTransport()
        try await transport.connect(to: endpoint())
        let scheduler = ManualScheduler()
        let client = ControlRequestClient(transport: transport, scheduler: scheduler)
        _ = await activateGeneration(on: client)

        async let first = client.send(.workspaceSnapshot(ControlRequestIDOnly(requestID: "req-1")))
        try await waitForPendingRequest(on: client)
        try await waitForScheduler(on: scheduler, count: 1)
        await scheduler.fire()
        _ = try? await first

        let probe = CompletionProbe()
        let second = reuseAttempt(on: client, probe: probe)
        try await waitForReuseAttempt(on: client, probe: probe)
        let handled = await client.handle(.ack(ControlAckResponse(requestID: "req-1")))
        let result = await second.value

        assertDuplicate(result, id: "req-1")
        XCTAssertFalse(handled)
        let sent = await transport.sentMessages
        XCTAssertEqual(sent.count, 1, "The retired ID must not start another request")
    }

    func testDuplicateRequestIDIsRejectedWhileTheFirstIsInFlight() async throws {
        let transport = FakeTransport()
        try await transport.connect(to: endpoint())
        let client = ControlRequestClient(transport: transport, scheduler: ManualScheduler())
        _ = await activateGeneration(on: client)

        async let first = client.send(.workspaceSnapshot(ControlRequestIDOnly(requestID: "req-1")))
        try await waitForPendingRequest(on: client)

        do {
            _ = try await client.send(.killPane(PaneIDControlRequest(requestID: "req-1", paneID: "pane-1")))
            XCTFail("Expected the duplicate request ID to be rejected")
        } catch {
            XCTAssertEqual(error as? ControlRequestError, .duplicateRequestID("req-1"))
        }

        await client.handle(.ack(ControlAckResponse(requestID: "req-1")))
        let value = try await first
        let sent = await transport.sentMessages
        XCTAssertEqual(value, .ack(ControlAckResponse(requestID: "req-1")))
        XCTAssertEqual(sent.count, 1, "The rejected duplicate must not reach the host")
    }

    func testARetiredIDCanBeUsedAgain() async throws {
        let transport = FakeTransport()
        try await transport.connect(to: endpoint())
        let client = ControlRequestClient(transport: transport, scheduler: ManualScheduler())
        _ = await activateGeneration(on: client)

        async let first = client.send(.workspaceSnapshot(ControlRequestIDOnly(requestID: "req-1")))
        try await waitForPendingRequest(on: client)
        await client.handle(.ack(ControlAckResponse(requestID: "req-1")))
        _ = try await first

        async let second = client.send(.workspaceSnapshot(ControlRequestIDOnly(requestID: "req-1")))
        try await waitForPendingRequest(on: client)
        await client.handle(.ack(ControlAckResponse(requestID: "req-1", ok: false)))

        let value = try await second
        XCTAssertEqual(value, .ack(ControlAckResponse(requestID: "req-1", ok: false)))
    }

    func testDisconnectFailsEveryPendingRequestAndLeavesNothingBehind() async throws {
        let transport = FakeTransport()
        try await transport.connect(to: endpoint())
        let client = ControlRequestClient(transport: transport, scheduler: ManualScheduler())
        _ = await activateGeneration(on: client)

        async let first = client.send(.workspaceSnapshot(ControlRequestIDOnly(requestID: "req-1")))
        async let second = client.send(.killPane(PaneIDControlRequest(requestID: "req-2", paneID: "pane-1")))
        try await waitForPendingRequest(on: client, count: 2)

        await client.failAll()

        do {
            _ = try await first
            XCTFail("Expected the disconnect to fail the first pending request")
        } catch {
            XCTAssertEqual(error as? ControlRequestError, .disconnected)
            XCTAssertTrue(
                error.localizedDescription.localizedCaseInsensitiveContains("connection")
            )
        }

        do {
            _ = try await second
            XCTFail("Expected the disconnect to fail the second pending request")
        } catch {
            XCTAssertEqual(error as? ControlRequestError, .disconnected)
        }

        let remaining = await client.pendingRequestCount
        XCTAssertEqual(remaining, 0)

        // A response arriving after the disconnect must find nothing to resume.
        let handled = await client.handle(.ack(ControlAckResponse(requestID: "req-1")))
        XCTAssertFalse(handled)
    }

    func testRequestsSurviveAndReconnectAfterDisconnect() async throws {
        let transport = FakeTransport()
        try await transport.connect(to: endpoint())
        let client = ControlRequestClient(transport: transport, scheduler: ManualScheduler())
        _ = await activateGeneration(on: client)

        async let first = client.send(.workspaceSnapshot(ControlRequestIDOnly(requestID: "req-1")))
        try await waitForPendingRequest(on: client)
        await client.failAll()
        _ = try? await first

        _ = await activateGeneration(on: client, id: 2)
        async let second = client.send(.workspaceSnapshot(ControlRequestIDOnly(requestID: "req-1")))
        try await waitForPendingRequest(on: client)
        await client.handle(.ack(ControlAckResponse(requestID: "req-1")))

        let value = try await second
        XCTAssertEqual(value, .ack(ControlAckResponse(requestID: "req-1")))
    }

    func testOldGenerationResponseCannotResolveReusedIDOnNewGeneration() async throws {
        let transport = FakeTransport()
        try await transport.connect(to: endpoint())
        let client = ControlRequestClient(transport: transport, scheduler: ManualScheduler())
        let firstGeneration = ConnectionGeneration(id: 1)
        let secondGeneration = ConnectionGeneration(id: 2)

        await client.beginGeneration(firstGeneration)
        let first = Task {
            try await client.send(
                .workspaceSnapshot(ControlRequestIDOnly(requestID: "req-1")),
                for: firstGeneration
            )
        }
        try await waitForPendingRequest(on: client)
        await client.endGeneration(firstGeneration)
        _ = try? await first.value

        await client.beginGeneration(secondGeneration)
        let second = Task {
            try await client.send(
                .workspaceSnapshot(ControlRequestIDOnly(requestID: "req-1")),
                for: secondGeneration
            )
        }
        try await waitForPendingRequest(on: client)

        let staleHandled = await client.handle(
            .ack(ControlAckResponse(requestID: "req-1")),
            for: firstGeneration
        )
        XCTAssertFalse(staleHandled)
        let pendingAfterStaleResponse = await client.pendingRequestCount
        XCTAssertEqual(pendingAfterStaleResponse, 1)

        let activeHandled = await client.handle(
            .ack(ControlAckResponse(requestID: "req-1", ok: false)),
            for: secondGeneration
        )
        XCTAssertTrue(activeHandled)
        let response = try await second.value
        XCTAssertEqual(response, .ack(ControlAckResponse(requestID: "req-1", ok: false)))
    }

    func testInvalidatedGenerationCannotResolvePendingRequestBeforeEndGeneration() async throws {
        let transport = FakeTransport()
        try await transport.connect(to: endpoint())
        let client = ControlRequestClient(transport: transport, scheduler: ManualScheduler())
        let generation = ConnectionGeneration(id: 1)

        await client.beginGeneration(generation)
        let request = Task {
            try await client.send(
                .workspaceSnapshot(ControlRequestIDOnly(requestID: "req-1")),
                for: generation
            )
        }
        try await waitForPendingRequest(on: client)

        generation.invalidate()
        let handled = await client.handle(
            .ack(ControlAckResponse(requestID: "req-1")),
            for: generation
        )

        XCTAssertFalse(handled)
        let pendingBeforeEnd = await client.pendingRequestCount
        XCTAssertEqual(pendingBeforeEnd, 1)

        await client.endGeneration(generation)
        do {
            _ = try await request.value
            XCTFail("Invalidated generation should fail through disconnect cleanup")
        } catch {
            XCTAssertEqual(error as? ControlRequestError, .disconnected)
        }
    }

    func testDisconnectReleasesIDsBeforeFailedCallersResume() async throws {
        let transport = FakeTransport()
        try await transport.connect(to: endpoint())
        let client = ControlRequestClient(transport: transport, scheduler: ManualScheduler())
        _ = await activateGeneration(on: client)

        let first = Task {
            try await client.send(.workspaceSnapshot(ControlRequestIDOnly(requestID: "req-1")))
        }
        try await waitForPendingRequest(on: client)

        await client.failAll()

        _ = await activateGeneration(on: client, id: 2)
        let second = Task {
            try await client.send(.workspaceSnapshot(ControlRequestIDOnly(requestID: "req-1")))
        }
        try await waitForPendingRequest(on: client)
        await client.handle(.ack(ControlAckResponse(requestID: "req-1")))

        _ = try? await first.value
        let value = try await second.value
        XCTAssertEqual(value, .ack(ControlAckResponse(requestID: "req-1")))
    }

    func testCancellingTheCallerClearsThePendingRequest() async throws {
        let transport = FakeTransport()
        try await transport.connect(to: endpoint())
        let scheduler = ManualScheduler()
        let client = ControlRequestClient(transport: transport, scheduler: scheduler)
        _ = await activateGeneration(on: client)
        let request = Task {
            try await client.send(.workspaceSnapshot(ControlRequestIDOnly(requestID: "req-1")))
        }
        try await waitForPendingRequest(on: client)

        request.cancel()

        do {
            _ = try await request.value
            XCTFail("Expected cancellation to reach the caller")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }
        let remaining = await client.pendingRequestCount
        XCTAssertEqual(remaining, 0)
        try await waitForScheduler(on: scheduler, count: 0)
    }

    func testCancelledIDCannotBeReusedBeforeDisconnect() async throws {
        let transport = FakeTransport()
        try await transport.connect(to: endpoint())
        let client = ControlRequestClient(transport: transport, scheduler: ManualScheduler())
        _ = await activateGeneration(on: client)
        let first = Task {
            try await client.send(.workspaceSnapshot(ControlRequestIDOnly(requestID: "req-1")))
        }
        try await waitForPendingRequest(on: client)

        first.cancel()
        _ = try? await first.value

        let probe = CompletionProbe()
        let second = reuseAttempt(on: client, probe: probe)
        try await waitForReuseAttempt(on: client, probe: probe)
        let handled = await client.handle(.ack(ControlAckResponse(requestID: "req-1")))
        let result = await second.value

        assertDuplicate(result, id: "req-1")
        XCTAssertFalse(handled)
        let sent = await transport.sentMessages
        XCTAssertEqual(sent.count, 1, "The retired ID must not start another request")
    }

    func testFailAllAllowsRetiredIDReuseOnTheNextConnection() async throws {
        let transport = FakeTransport()
        try await transport.connect(to: endpoint())
        let scheduler = ManualScheduler()
        let client = ControlRequestClient(transport: transport, scheduler: scheduler)
        _ = await activateGeneration(on: client)

        async let first = client.send(.workspaceSnapshot(ControlRequestIDOnly(requestID: "req-1")))
        try await waitForPendingRequest(on: client)
        try await waitForScheduler(on: scheduler, count: 1)
        await scheduler.fire()
        _ = try? await first

        await client.failAll()

        _ = await activateGeneration(on: client, id: 2)
        async let second = client.send(.workspaceSnapshot(ControlRequestIDOnly(requestID: "req-1")))
        try await waitForPendingRequest(on: client)
        await client.handle(.ack(ControlAckResponse(requestID: "req-1", ok: false)))

        let value = try await second
        XCTAssertEqual(value, .ack(ControlAckResponse(requestID: "req-1", ok: false)))
    }

    func testAmbiguousTransportFailureRetiresIDUntilDisconnect() async throws {
        let transport = AmbiguousFailingTransport()
        let client = ControlRequestClient(transport: transport, scheduler: ManualScheduler())
        _ = await activateGeneration(on: client)

        do {
            _ = try await client.send(.workspaceSnapshot(ControlRequestIDOnly(
                requestID: "req-1"
            )))
            XCTFail("Expected the first transport send to fail")
        } catch {
            XCTAssertEqual(error as? FakeTransportError, .connectionFailed)
        }

        let probe = CompletionProbe()
        let second = reuseAttempt(on: client, probe: probe)
        try await waitForReuseAttempt(on: client, probe: probe)
        let handled = await client.handle(.ack(ControlAckResponse(requestID: "req-1")))
        let result = await second.value

        assertDuplicate(result, id: "req-1")
        XCTAssertFalse(handled)
        let sent = await transport.sentMessages
        XCTAssertEqual(sent.count, 1, "An ambiguous failed send must keep its ID retired")
    }

    func testTransportFailureFailsTheCaller() async {
        // Never connected, so FakeTransport.send throws.
        let client = ControlRequestClient(transport: FakeTransport(), scheduler: ManualScheduler())
        _ = await activateGeneration(on: client)

        do {
            _ = try await client.send(.workspaceSnapshot(ControlRequestIDOnly(requestID: "req-1")))
            XCTFail("Expected the transport failure to reach the caller")
        } catch {
            XCTAssertEqual(error as? FakeTransportError, .connectionFailed)
        }
        let remaining = await client.pendingRequestCount
        XCTAssertEqual(remaining, 0)
    }

    func testUnknownRequestWithoutAnIDIsRejectedBeforeSending() async throws {
        let transport = FakeTransport()
        try await transport.connect(to: endpoint())
        let client = ControlRequestClient(transport: transport, scheduler: ManualScheduler())
        _ = await activateGeneration(on: client)

        do {
            _ = try await client.send(.unknown(UnknownControlRequest(
                type: "panes.future",
                requestID: nil
            )))
            XCTFail("Expected a request without an ID to be rejected")
        } catch {
            XCTAssertEqual(error as? ControlRequestError, .missingRequestID)
        }
        let sent = await transport.sentMessages
        XCTAssertTrue(sent.isEmpty)
    }

    func testGeneratedRequestIDsAreUnique() async {
        let client = ControlRequestClient(transport: FakeTransport(), scheduler: ManualScheduler())
        var ids: Set<String> = []

        for _ in 0..<256 {
            ids.insert(await client.nextRequestID())
        }

        XCTAssertEqual(ids.count, 256)
        XCTAssertFalse(ids.contains(""))
    }

    private func endpoint() -> HostEndpoint {
        HostEndpoint(
            host: "psyche.local",
            port: 4242,
            certificateFingerprint: String(repeating: "a", count: 64)
        )
    }

    private func activateGeneration(
        on client: ControlRequestClient,
        id: UInt64 = 1
    ) async -> ConnectionGeneration {
        let generation = ConnectionGeneration(id: id)
        await client.beginGeneration(generation)
        return generation
    }

    /// The request registers on the actor before `send` suspends, but the
    /// caller reaches this line first. Poll rather than sleep so the test
    /// stays deterministic.
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
        throw TestWaitError.timedOut
    }

    private func waitForScheduler(
        on scheduler: ManualScheduler,
        count: Int,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws {
        for _ in 0..<1_000 {
            if await scheduler.waiterCount == count { return }
            await Task.yield()
        }
        XCTFail("Timed out waiting for \(count) scheduler waiter(s)", file: file, line: line)
        throw TestWaitError.timedOut
    }

    private func reuseAttempt(
        on client: ControlRequestClient,
        probe: CompletionProbe
    ) -> Task<Result<MobileControlResponse, any Error>, Never> {
        Task {
            let result: Result<MobileControlResponse, any Error>
            do {
                result = .success(try await client.send(.workspaceSnapshot(
                    ControlRequestIDOnly(requestID: "req-1")
                )))
            } catch {
                result = .failure(error)
            }
            await probe.markComplete()
            return result
        }
    }

    private func waitForReuseAttempt(
        on client: ControlRequestClient,
        probe: CompletionProbe,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws {
        for _ in 0..<1_000 {
            let hasPendingRequest = await client.pendingRequestCount > 0
            let isComplete = await probe.isComplete
            if hasPendingRequest || isComplete { return }
            await Task.yield()
        }
        XCTFail("Timed out waiting for the reuse attempt", file: file, line: line)
        throw TestWaitError.timedOut
    }

    private func assertDuplicate(
        _ result: Result<MobileControlResponse, any Error>,
        id: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        switch result {
        case .success:
            XCTFail("Expected the retired ID to remain unavailable", file: file, line: line)
        case .failure(let error):
            XCTAssertEqual(
                error as? ControlRequestError,
                .duplicateRequestID(id),
                file: file,
                line: line
            )
        }
    }
}

private enum TestWaitError: Error {
    case timedOut
}

private actor CompletionProbe {
    private(set) var isComplete = false

    func markComplete() {
        isComplete = true
    }
}

private actor AmbiguousFailingTransport: PsycheTransport {
    private(set) var sentMessages: [MobileClientMessage] = []

    func connect(to endpoint: HostEndpoint) async throws {}

    func disconnect() async {}

    func send(_ message: MobileClientMessage) async throws {
        sentMessages.append(message)
        if sentMessages.count == 1 {
            throw FakeTransportError.connectionFailed
        }
    }

    func incomingMessages() async -> AsyncStream<MobileServerMessage> {
        AsyncStream { $0.finish() }
    }

    func incomingBinaryFrames() async -> AsyncStream<TerminalBinaryFrame> {
        AsyncStream { $0.finish() }
    }
}

/// Holds every sleep open until the test fires it, so a timeout happens
/// exactly when the test says and never on wall-clock time.
private actor ManualScheduler: ControlRequestScheduler {
    private var waiters: [UUID: CheckedContinuation<Void, any Error>] = [:]
    private(set) var requestedDurations: [Duration] = []
    var waiterCount: Int { waiters.count }

    func sleep(for duration: Duration) async throws {
        let id = UUID()
        requestedDurations.append(duration)
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                waiters[id] = continuation
            }
        } onCancel: {
            Task { await self.cancel(id) }
        }
    }

    func fire() {
        let waiting = waiters
        waiters.removeAll()
        waiting.values.forEach { $0.resume() }
    }

    private func cancel(_ id: UUID) {
        waiters.removeValue(forKey: id)?.resume(throwing: CancellationError())
    }
}
