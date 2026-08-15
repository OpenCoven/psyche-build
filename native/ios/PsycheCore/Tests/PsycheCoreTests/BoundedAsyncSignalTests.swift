import XCTest

final class BoundedAsyncSignalTests: XCTestCase {
    func testSignalCompletesWaitingTask() async throws {
        let scheduler = TimeoutSchedulerProbe()
        let signal = BoundedAsyncSignal(timeoutScheduler: scheduler.scheduler)
        let waiter = Task {
            try await signal.wait(for: "read gate", timeout: .seconds(1))
        }

        let timeout = try await waitForNextScheduledTimeout(on: scheduler)
        signal.signal()

        try await waitForTimeoutCancellation(of: timeout.id, on: scheduler)
        try await waiter.value
    }

    func testSignalBeforeWaitReturnsImmediately() async throws {
        let scheduler = TimeoutSchedulerProbe()
        let signal = BoundedAsyncSignal(timeoutScheduler: scheduler.scheduler)

        signal.signal()

        try await signal.wait(for: "read gate", timeout: .milliseconds(10))
        XCTAssertEqual(scheduler.scheduledTimeoutCount, 0)
    }

    func testMissingSignalTimesOutWithTheEventName() async throws {
        let scheduler = TimeoutSchedulerProbe()
        let signal = BoundedAsyncSignal(timeoutScheduler: scheduler.scheduler)
        let waiter = Task {
            try await signal.wait(for: "blocked read", timeout: .milliseconds(20))
        }
        let timeout = try await waitForNextScheduledTimeout(on: scheduler)

        scheduler.fire(timeout.id)

        do {
            try await waiter.value
            XCTFail("Expected the wait to time out")
        } catch let error as BoundedAsyncSignal.WaitError {
            XCTAssertEqual(error, .timedOut("blocked read"))
            XCTAssertEqual(error.errorDescription, "Timed out waiting for blocked read.")
        } catch {
            XCTFail("Expected WaitError.timedOut, got \(error)")
        }
    }

    func testCancellingWaiterThrowsCancellationAndLaterSignalIsSafe() async throws {
        let scheduler = TimeoutSchedulerProbe()
        let signal = BoundedAsyncSignal(timeoutScheduler: scheduler.scheduler)
        let waiter = Task {
            try await signal.wait(for: "blocked read", timeout: .seconds(1))
        }

        let timeout = try await waitForNextScheduledTimeout(on: scheduler)
        waiter.cancel()

        do {
            try await waiter.value
            XCTFail("Expected the wait to be cancelled")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }

        try await waitForTimeoutCancellation(of: timeout.id, on: scheduler)
        XCTAssertEqual(signal.pendingWaiterCount, 0)

        signal.signal()
    }

    func testResetCancelsPendingWaitersAndMakesTheSignalReusable() async throws {
        let scheduler = TimeoutSchedulerProbe()
        let signal = BoundedAsyncSignal(timeoutScheduler: scheduler.scheduler)
        let staleWaiter = Task {
            try await signal.wait(for: "stale read", timeout: .seconds(1))
        }

        let staleTimeout = try await waitForNextScheduledTimeout(on: scheduler)
        signal.reset()

        do {
            try await staleWaiter.value
            XCTFail("Expected reset() to cancel the pending waiter")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }

        try await waitForTimeoutCancellation(of: staleTimeout.id, on: scheduler)
        XCTAssertEqual(signal.pendingWaiterCount, 0)

        let freshWaiter = Task {
            try await signal.wait(for: "fresh read", timeout: .seconds(1))
        }

        let freshTimeout = try await waitForNextScheduledTimeout(on: scheduler)
        signal.signal()

        try await waitForTimeoutCancellation(of: freshTimeout.id, on: scheduler)
        try await freshWaiter.value
    }

    func testSignallingCancelsTimeoutTaskWithoutALateTimeout() async throws {
        let scheduler = TimeoutSchedulerProbe()
        let signal = BoundedAsyncSignal(timeoutScheduler: scheduler.scheduler)
        let waiter = Task {
            try await signal.wait(for: "read gate", timeout: .milliseconds(150))
        }

        let originalTimeout = try await waitForNextScheduledTimeout(on: scheduler)
        signal.signal()

        try await waitForTimeoutCancellation(of: originalTimeout.id, on: scheduler)
        try await waiter.value
        scheduler.fire(originalTimeout.id)

        signal.reset()

        let nextWaiter = Task {
            try await signal.wait(for: "next read", timeout: .milliseconds(20))
        }
        let nextTimeout = try await waitForNextScheduledTimeout(on: scheduler)
        scheduler.fire(nextTimeout.id)

        do {
            try await nextWaiter.value
            XCTFail("Expected the reset signal to block again")
        } catch let error as BoundedAsyncSignal.WaitError {
            XCTAssertEqual(error, .timedOut("next read"))
        } catch {
            XCTFail("Expected WaitError.timedOut after reset, got \(error)")
        }
    }

    func testCancellingTheWaiterDoesNotBecomeATimeout() async throws {
        let scheduler = TimeoutSchedulerProbe()
        let signal = BoundedAsyncSignal(timeoutScheduler: scheduler.scheduler)
        let waiter = Task {
            try await signal.wait(for: "cancelled read", timeout: .milliseconds(150))
        }

        let timeout = try await waitForNextScheduledTimeout(on: scheduler)
        waiter.cancel()

        do {
            try await waiter.value
            XCTFail("Expected the wait to be cancelled")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }

        try await waitForTimeoutCancellation(of: timeout.id, on: scheduler)
        scheduler.fire(timeout.id)
        XCTAssertEqual(signal.pendingWaiterCount, 0)
    }

    private func waitForNextScheduledTimeout(
        on scheduler: TimeoutSchedulerProbe,
        timeout: Duration = .milliseconds(250),
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws -> TimeoutSchedulerProbe.ScheduledTimeout {
        try await waitForProbeValue(
            description: "the next scheduled timeout",
            timeout: timeout,
            file: file,
            line: line
        ) {
            scheduler.takeNextScheduledTimeout()
        }
    }

    private func waitForTimeoutCancellation(
        of id: UUID,
        on scheduler: TimeoutSchedulerProbe,
        timeout: Duration = .milliseconds(250),
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws {
        _ = try await waitForProbeValue(
            description: "cancellation of timeout \(id)",
            timeout: timeout,
            file: file,
            line: line
        ) {
            scheduler.hasCancelledTimeout(id) ? () : nil
        } as Void
    }

    private func waitForProbeValue<T>(
        description: String,
        timeout: Duration,
        file: StaticString,
        line: UInt,
        poll: () -> T?
    ) async throws -> T {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)

        while clock.now < deadline {
            if let value = poll() {
                return value
            }
            await Task.yield()
        }

        XCTFail("Timed out waiting for \(description)", file: file, line: line)
        throw ProbeWaitError.timedOut(description)
    }
}

private enum ProbeWaitError: Error, LocalizedError {
    case timedOut(String)

    var errorDescription: String? {
        switch self {
        case .timedOut(let description):
            "Timed out waiting for \(description)."
        }
    }
}

private final class TimeoutSchedulerProbe: @unchecked Sendable {
    struct ScheduledTimeout: Sendable {
        let id: UUID
        let timeout: Duration
        let operation: @Sendable () -> Void
    }

    var scheduler: BoundedAsyncSignal.TimeoutScheduler {
        BoundedAsyncSignal.TimeoutScheduler { [weak self] timeout, operation in
            guard let self else {
                return .init(cancel: {})
            }

            let scheduled = ScheduledTimeout(
                id: UUID(),
                timeout: timeout,
                operation: operation
            )
            recordScheduled(scheduled)

            return .init(cancel: { [weak self] in
                self?.recordCancellation(of: scheduled.id)
            })
        }
    }

    var scheduledTimeoutCount: Int {
        withLock { scheduledTimeouts.count }
    }

    private let lock = NSLock()
    private var scheduledTimeouts: [UUID: ScheduledTimeout] = [:]
    private var pendingScheduledTimeouts: [ScheduledTimeout] = []
    private var cancelledTimeoutIDs: Set<UUID> = []
    private var firedTimeoutIDs: Set<UUID> = []

    func takeNextScheduledTimeout() -> ScheduledTimeout? {
        withLock {
            pendingScheduledTimeouts.isEmpty ? nil : pendingScheduledTimeouts.removeFirst()
        }
    }

    func hasCancelledTimeout(_ id: UUID) -> Bool {
        withLock { cancelledTimeoutIDs.contains(id) }
    }

    func fire(_ id: UUID) {
        let operation = withLock { () -> (@Sendable () -> Void)? in
            guard
                !cancelledTimeoutIDs.contains(id),
                firedTimeoutIDs.insert(id).inserted,
                let scheduled = scheduledTimeouts[id]
            else {
                return nil
            }

            return scheduled.operation
        }

        operation?()
    }

    private func recordScheduled(_ scheduled: ScheduledTimeout) {
        withLock {
            scheduledTimeouts[scheduled.id] = scheduled
            pendingScheduledTimeouts.append(scheduled)
        }
    }

    private func recordCancellation(of id: UUID) {
        withLock {
            _ = cancelledTimeoutIDs.insert(id)
        }
    }

    private func withLock<T>(_ operation: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return operation()
    }
}
