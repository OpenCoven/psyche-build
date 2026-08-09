import Foundation

public enum ControlRequestError: Error, Sendable, Equatable, LocalizedError {
    case missingRequestID
    case duplicateRequestID(String)
    case timedOut(String)
    case disconnected

    public var errorDescription: String? {
        switch self {
        case .missingRequestID:
            "The control request is missing a request ID."
        case .duplicateRequestID(let id):
            "A control request with ID \(id) is already in flight."
        case .timedOut:
            "The host did not answer in time."
        case .disconnected:
            "The connection to the host ended before the host answered."
        }
    }
}

/// The seam every store sends control traffic through. One implementation is
/// shared app-wide so request IDs stay unique and a disconnect can fail every
/// waiter at once.
public protocol ControlRequesting: Sendable {
    func nextRequestID() async -> String
    func send(_ request: MobileControlRequest) async throws -> MobileControlResponse
}

/// Delays are injected so the timeout path is testable without waiting on a
/// real clock.
public protocol ControlRequestScheduler: Sendable {
    func sleep(for duration: Duration) async throws
}

public struct ContinuousClockScheduler: ControlRequestScheduler {
    public init() {}

    public func sleep(for duration: Duration) async throws {
        try await Task.sleep(for: duration)
    }
}

/// Correlates control responses back to the caller that asked for them.
///
/// Every pending request is keyed by its wire request ID. A response, a
/// protocol error, a timeout, and a disconnect all funnel through one
/// remove-then-resume step, so a continuation is resumed exactly once no
/// matter how many of those race, and nothing survives a disconnect.
public actor ControlRequestClient: ControlRequesting {
    public static let defaultTimeout = Duration.seconds(15)

    private let transport: any PsycheTransport
    private let scheduler: any ControlRequestScheduler
    private let timeout: Duration

    private var pending: [String: PendingRequest] = [:]
    private var reservations: [String: UInt64] = [:]
    private var nextToken: UInt64 = 0

    public init(
        transport: any PsycheTransport,
        scheduler: any ControlRequestScheduler = ContinuousClockScheduler(),
        timeout: Duration = defaultTimeout
    ) {
        self.transport = transport
        self.scheduler = scheduler
        self.timeout = timeout
    }

    deinit {
        for request in pending.values {
            request.transmission?.cancel()
            request.timeout?.cancel()
            request.continuation.resume(throwing: ControlRequestError.disconnected)
        }
    }

    public var pendingRequestCount: Int { pending.count }

    public func nextRequestID() -> String {
        UUID().uuidString
    }

    public func send(_ request: MobileControlRequest) async throws -> MobileControlResponse {
        try Task.checkCancellation()
        guard let id = request.requestID, !id.isEmpty else {
            throw ControlRequestError.missingRequestID
        }
        guard reservations[id] == nil else {
            throw ControlRequestError.duplicateRequestID(id)
        }

        nextToken &+= 1
        let token = nextToken
        reservations[id] = token

        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                pending[id] = PendingRequest(
                    token: token,
                    continuation: continuation
                )
                startTasks(for: request, id: id, token: token)
            }
        } onCancel: {
            Task { await self.cancel(id, token: token) }
        }
    }

    /// Routes an inbound control response to whoever is waiting for it.
    /// Returns false when nothing was waiting — an unsolicited event, a
    /// connection-wide error, or a late answer to something already timed out
    /// — so the caller can surface it instead of silently dropping it.
    @discardableResult
    public func handle(_ response: MobileControlResponse) -> Bool {
        guard let id = response.requestID else { return false }

        if case .error(let payload) = response {
            return resume(id, with: .failure(payload))
        }
        return resume(id, with: .success(response))
    }

    /// Fails every waiter at once. Called on disconnect so no request outlives
    /// the connection that could have answered it.
    public func failAll(with error: any Error = ControlRequestError.disconnected) {
        let waiting = pending
        pending.removeAll()

        for (id, request) in waiting {
            releaseReservation(id, token: request.token)
        }
        for request in waiting.values {
            request.transmission?.cancel()
            request.timeout?.cancel()
            request.continuation.resume(throwing: error)
        }
    }

    private func startTasks(for request: MobileControlRequest, id: String, token: UInt64) {
        let transport = self.transport
        let transmission = Task { [weak self, transport] in
            do {
                try await transport.send(.control(request))
            } catch {
                guard !Task.isCancelled else { return }
                await self?.fail(id, token: token, with: error)
            }
        }

        let scheduler = self.scheduler
        let timeout = self.timeout
        let timeoutTask = Task { [weak self, scheduler] in
            do {
                try await scheduler.sleep(for: timeout)
            } catch {
                return
            }
            await self?.fail(id, token: token, with: ControlRequestError.timedOut(id))
        }
        pending[id]?.transmission = transmission
        pending[id]?.timeout = timeoutTask
    }

    private func fail(_ id: String, token: UInt64, with error: any Error) {
        guard pending[id]?.token == token else { return }
        _ = finish(id, with: .failure(error))
    }

    private func cancel(_ id: String, token: UInt64) {
        guard pending[id]?.token == token else { return }
        _ = finish(id, with: .failure(CancellationError()))
    }

    /// The single place a continuation is resumed. Removing first means a
    /// second caller finds nothing and returns false rather than resuming
    /// again.
    @discardableResult
    private func resume(
        _ id: String,
        with result: Result<MobileControlResponse, any Error>
    ) -> Bool {
        finish(id, with: result)
    }

    @discardableResult
    private func finish(
        _ id: String,
        with result: Result<MobileControlResponse, any Error>
    ) -> Bool {
        guard let request = pending.removeValue(forKey: id) else { return false }
        releaseReservation(id, token: request.token)
        request.transmission?.cancel()
        request.timeout?.cancel()
        request.continuation.resume(with: result)
        return true
    }

    private func releaseReservation(_ id: String, token: UInt64) {
        if reservations[id] == token {
            reservations.removeValue(forKey: id)
        }
    }

    private struct PendingRequest {
        let token: UInt64
        let continuation: CheckedContinuation<MobileControlResponse, any Error>
        var transmission: Task<Void, Never>?
        var timeout: Task<Void, Never>?
    }
}
