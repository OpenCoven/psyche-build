import Foundation

final class BoundedAsyncSignal: @unchecked Sendable {
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
        var timeoutTask: Task<Void, Never>?
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
    private var state = State()

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
                    let timeoutTask = Task { [weak self] in
                        do {
                            try await Task.sleep(for: timeout)
                        } catch is CancellationError {
                            return
                        } catch {
                            return
                        }
                        self?.timeoutWaiter(id: id, event: event)
                    }
                    attachTimeoutTask(timeoutTask, to: id)
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

    private func attachTimeoutTask(_ timeoutTask: Task<Void, Never>, to id: UUID) {
        let shouldCancel = withLock {
            guard var waiter = state.waiters[id] else { return true }
            waiter.timeoutTask = timeoutTask
            state.waiters[id] = waiter
            return false
        }

        if shouldCancel {
            timeoutTask.cancel()
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
        waiter.timeoutTask?.cancel()
        waiter.continuation.resume(throwing: CancellationError())
    }

    private func finishWaiter(
        id: UUID,
        with result: Result<Void, any Error>
    ) {
        guard let waiter = withLock({ state.waiters.removeValue(forKey: id) }) else { return }
        waiter.timeoutTask?.cancel()
        waiter.continuation.resume(with: result)
    }

    private func finish(
        _ waiters: [Waiter],
        with result: Result<Void, any Error>
    ) {
        for waiter in waiters {
            waiter.timeoutTask?.cancel()
            waiter.continuation.resume(with: result)
        }
    }

    private func withLock<T>(_ operation: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return operation()
    }
}
