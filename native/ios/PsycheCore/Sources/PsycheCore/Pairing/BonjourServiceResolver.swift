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

struct NetServiceResolutionLifecycle: @unchecked Sendable {
    let beforeContinuationRegistration: @Sendable () -> Void
    let didCreateTimeoutTask: @Sendable () -> Void
    let didStartService: @Sendable () -> Void

    init(
        beforeContinuationRegistration: @escaping @Sendable () -> Void = {},
        didCreateTimeoutTask: @escaping @Sendable () -> Void = {},
        didStartService: @escaping @Sendable () -> Void = {}
    ) {
        self.beforeContinuationRegistration = beforeContinuationRegistration
        self.didCreateTimeoutTask = didCreateTimeoutTask
        self.didStartService = didStartService
    }
}

private enum NetServiceRegistration {
    case registered
    case terminal(Error)
    case duplicate
}

final class NetServiceResolution: NSObject, NetServiceDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let service: NetService
    private let timeout: TimeInterval
    private let lifecycle: NetServiceResolutionLifecycle
    private var continuation: CheckedContinuation<ResolvedBonjourEndpoint, Error>?
    private var timeoutTask: Task<Void, Never>?
    private var terminalResult: Result<ResolvedBonjourEndpoint, Error>?

    init(
        name: String,
        domain: String,
        timeout: TimeInterval,
        lifecycle: NetServiceResolutionLifecycle = .init()
    ) {
        self.service = NetService(
            domain: domain,
            type: "\(BonjourHostParser.serviceType).",
            name: name
        )
        self.timeout = timeout
        self.lifecycle = lifecycle
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
        lifecycle.beforeContinuationRegistration()
        let registration = lock.withLock { () -> NetServiceRegistration in
            if let terminalResult {
                switch terminalResult {
                case .success:
                    return .terminal(BonjourServiceResolverError.unresolved)
                case let .failure(error):
                    return .terminal(error)
                }
            }
            guard self.continuation == nil else {
                return .duplicate
            }
            self.continuation = continuation
            return .registered
        }
        guard case .registered = registration else {
            switch registration {
            case let .terminal(error):
                continuation.resume(throwing: error)
            case .duplicate:
                continuation.resume(throwing: BonjourServiceResolverError.unresolved)
            case .registered:
                break
            }
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
        let retainedTimer = lock.withLock { () -> Bool in
            guard continuation != nil else { return false }
            self.timeoutTask = timeoutTask
            return true
        }
        guard retainedTimer else {
            timeoutTask.cancel()
            return
        }
        lifecycle.didCreateTimeoutTask()

        DispatchQueue.main.async { [weak self] in
            guard let self, self.isPending else { return }
            self.lifecycle.didStartService()
            self.service.delegate = self
            self.service.schedule(in: .main, forMode: .default)
            self.service.resolve(withTimeout: self.timeout)
        }
    }

    private var isPending: Bool {
        lock.withLock { continuation != nil }
    }

    var hasPendingResolution: Bool {
        lock.withLock { continuation != nil || timeoutTask != nil }
    }

    private func finish(_ result: Result<ResolvedBonjourEndpoint, Error>) {
        let completion = lock.withLock { () -> (CheckedContinuation<ResolvedBonjourEndpoint, Error>, Task<Void, Never>?)? in
            guard let continuation else {
                if terminalResult == nil {
                    terminalResult = result
                }
                return nil
            }
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
