import XCTest

final class BoundedAsyncSignalTests: XCTestCase {
    func testSignalCompletesWaitingTask() async throws {
        let signal = BoundedAsyncSignal()
        let waiter = Task {
            try await signal.wait(for: "read gate", timeout: .seconds(1))
        }

        try await waitForPendingWaiters(on: signal)
        signal.signal()

        try await waiter.value
    }

    func testSignalBeforeWaitReturnsImmediately() async throws {
        let signal = BoundedAsyncSignal()

        signal.signal()

        try await signal.wait(for: "read gate", timeout: .milliseconds(10))
    }

    func testMissingSignalTimesOutWithTheEventName() async {
        let signal = BoundedAsyncSignal()

        do {
            try await signal.wait(for: "blocked read", timeout: .milliseconds(20))
            XCTFail("Expected the wait to time out")
        } catch let error as BoundedAsyncSignal.WaitError {
            XCTAssertEqual(error, .timedOut("blocked read"))
            XCTAssertEqual(error.errorDescription, "Timed out waiting for blocked read.")
        } catch {
            XCTFail("Expected WaitError.timedOut, got \(error)")
        }
    }

    func testCancellingWaiterThrowsCancellationAndLaterSignalIsSafe() async throws {
        let signal = BoundedAsyncSignal()
        let waiter = Task {
            try await signal.wait(for: "blocked read", timeout: .seconds(1))
        }

        try await waitForPendingWaiters(on: signal)
        waiter.cancel()

        do {
            try await waiter.value
            XCTFail("Expected the wait to be cancelled")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }

        XCTAssertEqual(signal.pendingWaiterCount, 0)

        signal.signal()
    }

    func testResetCancelsPendingWaitersAndMakesTheSignalReusable() async throws {
        let signal = BoundedAsyncSignal()
        let staleWaiter = Task {
            try await signal.wait(for: "stale read", timeout: .seconds(1))
        }

        try await waitForPendingWaiters(on: signal)
        signal.reset()

        do {
            try await staleWaiter.value
            XCTFail("Expected reset() to cancel the pending waiter")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }

        XCTAssertEqual(signal.pendingWaiterCount, 0)

        let freshWaiter = Task {
            try await signal.wait(for: "fresh read", timeout: .seconds(1))
        }

        try await waitForPendingWaiters(on: signal)
        signal.signal()

        try await freshWaiter.value
    }

    func testSignallingCancelsTimeoutTaskWithoutALateTimeout() async throws {
        let signal = BoundedAsyncSignal()
        let waiter = Task {
            try await signal.wait(for: "read gate", timeout: .milliseconds(150))
        }

        try await waitForPendingWaiters(on: signal)
        signal.signal()

        try await waiter.value
        try await Task.sleep(for: .milliseconds(250))

        signal.reset()

        do {
            try await signal.wait(for: "next read", timeout: .milliseconds(20))
            XCTFail("Expected the reset signal to block again")
        } catch let error as BoundedAsyncSignal.WaitError {
            XCTAssertEqual(error, .timedOut("next read"))
        } catch {
            XCTFail("Expected WaitError.timedOut after reset, got \(error)")
        }
    }

    func testCancellingTheWaiterDoesNotBecomeATimeout() async throws {
        let signal = BoundedAsyncSignal()
        let waiter = Task {
            try await signal.wait(for: "cancelled read", timeout: .milliseconds(150))
        }

        try await waitForPendingWaiters(on: signal)
        waiter.cancel()

        do {
            try await waiter.value
            XCTFail("Expected the wait to be cancelled")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }

        try await Task.sleep(for: .milliseconds(250))
        XCTAssertEqual(signal.pendingWaiterCount, 0)
    }

    private func waitForPendingWaiters(
        on signal: BoundedAsyncSignal,
        count: Int = 1,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws {
        for _ in 0..<1_000 {
            if signal.pendingWaiterCount == count { return }
            await Task.yield()
        }

        XCTFail("Timed out waiting for \(count) pending waiter(s)", file: file, line: line)
        throw TestWaitError.timedOut
    }
}

private enum TestWaitError: Error {
    case timedOut
}
