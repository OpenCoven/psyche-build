import Foundation

public struct ResolvedBonjourEndpoint: Sendable, Equatable {
    public let host: String
    public let port: Int

    public init(host: String, port: Int) {
        self.host = host
        self.port = port
    }
}

public protocol BonjourServiceResolving: Sendable {
    func resolve(name: String, domain: String) async throws -> ResolvedBonjourEndpoint
}

public enum BonjourServiceResolverError: Error, Sendable, Equatable {
    case timedOut
    case unresolved
    case invalidEndpoint
}

/// Resolves a Bonjour service name into the host and port that `URLSession`
/// can connect to. The result remains routing information only: callers pin
/// the certificate fingerprint that came from the separately parsed TXT data.
public final class NetServiceBonjourResolver: BonjourServiceResolving, @unchecked Sendable {
    private let timeout: TimeInterval

    public init(timeout: TimeInterval = 5) {
        self.timeout = timeout
    }

    public func resolve(name: String, domain: String) async throws -> ResolvedBonjourEndpoint {
        let resolution = NetServiceResolution(name: name, domain: domain, timeout: timeout)
        return try await resolution.resolve()
    }
}

private final class NetServiceResolution: NSObject, NetServiceDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let service: NetService
    private let timeout: TimeInterval
    private var continuation: CheckedContinuation<ResolvedBonjourEndpoint, Error>?
    private var timeoutTask: Task<Void, Never>?

    init(name: String, domain: String, timeout: TimeInterval) {
        self.service = NetService(
            domain: domain,
            type: "\(BonjourHostParser.serviceType).",
            name: name
        )
        self.timeout = timeout
    }

    func resolve() async throws -> ResolvedBonjourEndpoint {
        try Task.checkCancellation()
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                begin(continuation)
            }
        }, onCancel: {
            finish(.failure(CancellationError()))
        })
    }

    func netServiceDidResolveAddress(_ sender: NetService) {
        guard let endpoint = Self.endpoint(host: sender.hostName, port: sender.port) else {
            finish(.failure(BonjourServiceResolverError.invalidEndpoint))
            return
        }
        finish(.success(endpoint))
    }

    func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) {
        finish(.failure(BonjourServiceResolverError.unresolved))
    }

    private func begin(_ continuation: CheckedContinuation<ResolvedBonjourEndpoint, Error>) {
        guard !Task.isCancelled else {
            continuation.resume(throwing: CancellationError())
            return
        }
        let shouldStart = lock.withLock {
            guard self.continuation == nil else { return false }
            self.continuation = continuation
            return true
        }
        guard shouldStart else {
            continuation.resume(throwing: BonjourServiceResolverError.unresolved)
            return
        }

        let timeoutTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await Task.sleep(for: .seconds(timeout))
                finish(.failure(BonjourServiceResolverError.timedOut))
            } catch {
                // Completion and cancellation both cancel this bounded timer.
            }
        }
        lock.withLock { self.timeoutTask = timeoutTask }

        DispatchQueue.main.async { [weak self] in
            guard let self, self.isPending else { return }
            self.service.delegate = self
            self.service.schedule(in: .main, forMode: .default)
            self.service.resolve(withTimeout: self.timeout)
        }
    }

    private var isPending: Bool {
        lock.withLock { continuation != nil }
    }

    private func finish(_ result: Result<ResolvedBonjourEndpoint, Error>) {
        let completion = lock.withLock { () -> (CheckedContinuation<ResolvedBonjourEndpoint, Error>, Task<Void, Never>?)? in
            guard let continuation else { return nil }
            self.continuation = nil
            let timeoutTask = self.timeoutTask
            self.timeoutTask = nil
            return (continuation, timeoutTask)
        }
        guard let (continuation, timeoutTask) = completion else { return }

        timeoutTask?.cancel()
        DispatchQueue.main.async { [service] in
            service.stop()
            service.remove(from: .main, forMode: .default)
            service.delegate = nil
        }
        continuation.resume(with: result)
    }

    private static func endpoint(host: String?, port: Int) -> ResolvedBonjourEndpoint? {
        guard var host else { return nil }
        host = host.trimmingCharacters(in: .whitespacesAndNewlines)
        while host.hasSuffix(".") {
            host.removeLast()
        }
        guard !host.isEmpty, (1...65_535).contains(port) else { return nil }
        return ResolvedBonjourEndpoint(host: host.lowercased(), port: port)
    }
}
