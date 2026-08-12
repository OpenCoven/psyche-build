import XCTest

final class BoundedAsyncSignalTests: XCTestCase {
    func testSignalCompletesWaitingTask() async throws {
        let scheduler = TimeoutSchedulerProbe()
        let signal = BoundedAsyncSignal(timeoutScheduler: scheduler.scheduler)
        let waiter = Task {
            try await signal.wait(for: "read gate", timeout: .seconds(1))
        }

        let timeout = await scheduler.nextScheduledTimeout()
        signal.signal()

        await scheduler.waitForCancellation(of: timeout.id)
        try await waiter.value
    }

    func testSignalBeforeWaitReturnsImmediately() async throws {
        let scheduler = TimeoutSchedulerProbe()
        let signal = BoundedAsyncSignal(timeoutScheduler: scheduler.scheduler)

        signal.signal()

        try await signal.wait(for: "read gate", timeout: .milliseconds(10))
        XCTAssertEqual(scheduler.scheduledTimeoutCount, 0)
    }

    func testMissingSignalTimesOutWithTheEventName() async {
        let scheduler = TimeoutSchedulerProbe()
        let signal = BoundedAsyncSignal(timeoutScheduler: scheduler.scheduler)
        let waiter = Task {
            try await signal.wait(for: "blocked read", timeout: .milliseconds(20))
        }
        let timeout = await scheduler.nextScheduledTimeout()

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

        let timeout = await scheduler.nextScheduledTimeout()
        waiter.cancel()

        do {
            try await waiter.value
            XCTFail("Expected the wait to be cancelled")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }

        await scheduler.waitForCancellation(of: timeout.id)
        XCTAssertEqual(signal.pendingWaiterCount, 0)

        signal.signal()
    }

    func testResetCancelsPendingWaitersAndMakesTheSignalReusable() async throws {
        let scheduler = TimeoutSchedulerProbe()
        let signal = BoundedAsyncSignal(timeoutScheduler: scheduler.scheduler)
        let staleWaiter = Task {
            try await signal.wait(for: "stale read", timeout: .seconds(1))
        }

        let staleTimeout = await scheduler.nextScheduledTimeout()
        signal.reset()

        do {
            try await staleWaiter.value
            XCTFail("Expected reset() to cancel the pending waiter")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }

        await scheduler.waitForCancellation(of: staleTimeout.id)
        XCTAssertEqual(signal.pendingWaiterCount, 0)

        let freshWaiter = Task {
            try await signal.wait(for: "fresh read", timeout: .seconds(1))
        }

        let freshTimeout = await scheduler.nextScheduledTimeout()
        signal.signal()

        await scheduler.waitForCancellation(of: freshTimeout.id)
        try await freshWaiter.value
    }

    func testSignallingCancelsTimeoutTaskWithoutALateTimeout() async throws {
        let scheduler = TimeoutSchedulerProbe()
        let signal = BoundedAsyncSignal(timeoutScheduler: scheduler.scheduler)
        let waiter = Task {
            try await signal.wait(for: "read gate", timeout: .milliseconds(150))
        }

        let originalTimeout = await scheduler.nextScheduledTimeout()
        signal.signal()

        await scheduler.waitForCancellation(of: originalTimeout.id)
        try await waiter.value
        scheduler.fire(originalTimeout.id)

        signal.reset()

        let nextWaiter = Task {
            try await signal.wait(for: "next read", timeout: .milliseconds(20))
        }
        let nextTimeout = await scheduler.nextScheduledTimeout()
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

        let timeout = await scheduler.nextScheduledTimeout()
        waiter.cancel()

        do {
            try await waiter.value
            XCTFail("Expected the wait to be cancelled")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }

        await scheduler.waitForCancellation(of: timeout.id)
        scheduler.fire(timeout.id)
        XCTAssertEqual(signal.pendingWaiterCount, 0)
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
    private var scheduleContinuations: [CheckedContinuation<ScheduledTimeout, Never>] = []
    private var cancellationContinuations: [UUID: [CheckedContinuation<Void, Never>]] = [:]

    func nextScheduledTimeout() async -> ScheduledTimeout {
        if let scheduled = withLock({ () -> ScheduledTimeout? in
            pendingScheduledTimeouts.isEmpty ? nil : pendingScheduledTimeouts.removeFirst()
        }) {
            return scheduled
        }

        return await withCheckedContinuation { continuation in
            let scheduled = withLock { () -> ScheduledTimeout? in
                if pendingScheduledTimeouts.isEmpty {
                    scheduleContinuations.append(continuation)
                    return nil
                }

                return pendingScheduledTimeouts.removeFirst()
            }

            if let scheduled {
                continuation.resume(returning: scheduled)
            }
        }
    }

    func waitForCancellation(of id: UUID) async {
        if withLock({ cancelledTimeoutIDs.contains(id) }) {
            return
        }

        await withCheckedContinuation { continuation in
            let shouldResume = withLock {
                if cancelledTimeoutIDs.contains(id) {
                    return true
                }

                cancellationContinuations[id, default: []].append(continuation)
                return false
            }

            if shouldResume {
                continuation.resume()
            }
        }
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
        let continuation = withLock { () -> CheckedContinuation<ScheduledTimeout, Never>? in
            scheduledTimeouts[scheduled.id] = scheduled

            if scheduleContinuations.isEmpty {
                pendingScheduledTimeouts.append(scheduled)
                return nil
            }

            return scheduleContinuations.removeFirst()
        }

        continuation?.resume(returning: scheduled)
    }

    private func recordCancellation(of id: UUID) {
        let continuations = withLock { () -> [CheckedContinuation<Void, Never>] in
            guard cancelledTimeoutIDs.insert(id).inserted else {
                return []
            }

            return cancellationContinuations.removeValue(forKey: id) ?? []
        }

        continuations.forEach { $0.resume() }
    }

    private func withLock<T>(_ operation: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return operation()
    }
}
