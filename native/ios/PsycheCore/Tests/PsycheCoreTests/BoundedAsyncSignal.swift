import Foundation

final class BoundedAsyncSignal: @unchecked Sendable {
    struct TimeoutScheduler: Sendable {
        struct Handle: Sendable {
            private let cancelOperation: @Sendable () -> Void

            init(cancel: @escaping @Sendable () -> Void) {
                self.cancelOperation = cancel
            }

            func cancel() {
                cancelOperation()
            }
        }

        private let scheduleOperation: @Sendable (Duration, @escaping @Sendable () -> Void) -> Handle

        init(
            schedule: @escaping @Sendable (Duration, @escaping @Sendable () -> Void) -> Handle
        ) {
            self.scheduleOperation = schedule
        }

        func schedule(
            after timeout: Duration,
            operation: @escaping @Sendable () -> Void
        ) -> Handle {
            scheduleOperation(timeout, operation)
        }

        static let live = TimeoutScheduler { timeout, operation in
            let task = Task {
                do {
                    try await Task.sleep(for: timeout)
                } catch is CancellationError {
                    return
                } catch {
                    return
                }
                operation()
            }
            return Handle(cancel: { task.cancel() })
        }
    }

    enum WaitError: Error, Equatable, LocalizedError {
        case timedOut(String)

        var errorDescription: String? {
            switch self {
            case .timedOut(let event):
                "Timed out waiting for \(event)."
            }
        }
    }

    var pendingWaiterCount: Int {
        withLock { state.waiters.count }
    }

    private struct Waiter {
        let continuation: CheckedContinuation<Void, any Error>
        var timeoutHandle: TimeoutScheduler.Handle?
    }

    private enum RegistrationResult {
        case cancelled
        case alreadySignaled
        case registered
    }

    private struct State {
        var isSignaled = false
        var waiters: [UUID: Waiter] = [:]
        var registeringWaiters: Set<UUID> = []
        var cancelledRegistrations: Set<UUID> = []
    }

    private let lock = NSLock()
    private let timeoutScheduler: TimeoutScheduler
    private var state = State()

    init(timeoutScheduler: TimeoutScheduler = .live) {
        self.timeoutScheduler = timeoutScheduler
    }

    deinit {
        let waiters = withLock {
            let waiters = Array(state.waiters.values)
            state.waiters.removeAll()
            state.registeringWaiters.removeAll()
            state.cancelledRegistrations.removeAll()
            state.isSignaled = false
            return waiters
        }
        finish(waiters, with: .failure(CancellationError()))
    }

    func wait(for event: String, timeout: Duration) async throws {
        try Task.checkCancellation()
        let id = UUID()

        return try await withTaskCancellationHandler {
            beginRegistration(for: id)

            try await withCheckedThrowingContinuation { continuation in
                switch register(continuation, for: id) {
                case .cancelled:
                    continuation.resume(throwing: CancellationError())
                case .alreadySignaled:
                    continuation.resume()
                case .registered:
                    let timeoutHandle = timeoutScheduler.schedule(after: timeout) { [weak self] in
                        self?.timeoutWaiter(id: id, event: event)
                    }
                    attachTimeoutHandle(timeoutHandle, to: id)
                }
            }
        } onCancel: {
            cancelWaiter(id: id)
        }
    }

    func signal() {
        let waiters = withLock {
            state.isSignaled = true
            let waiters = Array(state.waiters.values)
            state.waiters.removeAll()
            return waiters
        }
        finish(waiters, with: .success(()))
    }

    func reset() {
        let waiters = withLock {
            state.isSignaled = false
            state.cancelledRegistrations.formUnion(state.registeringWaiters)
            let waiters = Array(state.waiters.values)
            state.waiters.removeAll()
            return waiters
        }
        finish(waiters, with: .failure(CancellationError()))
    }

    private func beginRegistration(for id: UUID) {
        _ = withLock {
            state.registeringWaiters.insert(id)
        }
    }

    private func register(
        _ continuation: CheckedContinuation<Void, any Error>,
        for id: UUID
    ) -> RegistrationResult {
        withLock {
            state.registeringWaiters.remove(id)

            if state.cancelledRegistrations.remove(id) != nil || Task.isCancelled {
                return .cancelled
            }
            guard !state.isSignaled else {
                return .alreadySignaled
            }

            state.waiters[id] = Waiter(continuation: continuation)
            return .registered
        }
    }

    private func attachTimeoutHandle(_ timeoutHandle: TimeoutScheduler.Handle, to id: UUID) {
        let shouldCancel = withLock {
            guard var waiter = state.waiters[id] else { return true }
            waiter.timeoutHandle = timeoutHandle
            state.waiters[id] = waiter
            return false
        }

        if shouldCancel {
            timeoutHandle.cancel()
        }
    }

    private func timeoutWaiter(id: UUID, event: String) {
        finishWaiter(id: id, with: .failure(WaitError.timedOut(event)))
    }

    private func cancelWaiter(id: UUID) {
        let waiter: Waiter? = withLock {
            if let waiter = state.waiters.removeValue(forKey: id) {
                return waiter
            }
            if state.registeringWaiters.contains(id) {
                state.cancelledRegistrations.insert(id)
            }
            return nil
        }

        guard let waiter else { return }
        waiter.timeoutHandle?.cancel()
        waiter.continuation.resume(throwing: CancellationError())
    }

    private func finishWaiter(
        id: UUID,
        with result: Result<Void, any Error>
    ) {
        guard let waiter = withLock({ state.waiters.removeValue(forKey: id) }) else { return }
        waiter.timeoutHandle?.cancel()
        waiter.continuation.resume(with: result)
    }

    private func finish(
        _ waiters: [Waiter],
        with result: Result<Void, any Error>
    ) {
        for waiter in waiters {
            waiter.timeoutHandle?.cancel()
            waiter.continuation.resume(with: result)
        }
    }

    private func withLock<T>(_ operation: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return operation()
    }
}
