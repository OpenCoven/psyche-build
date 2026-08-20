import Foundation
import Network

/// One `_psyche._tcp` service as it came off the wire, before any of it is
/// trusted.
public struct BonjourServiceRecord: Sendable, Equatable {
    public let name: String
    public let domain: String
    public let txt: [String: String]

    public init(name: String, domain: String, txt: [String: String]) {
        self.name = name
        self.domain = domain
        self.txt = txt
    }
}

/// A service that carried a usable identity: a server ID, a fingerprint this
/// client can pin, and at least one protocol version it can speak.
public struct BonjourHostIdentity: Sendable, Equatable, Identifiable {
    public let serverID: String
    public let serverName: String
    public let domain: String
    public let certificateFingerprint: String
    public let supportedVersions: [Int]

    public var id: String { serverID }

    public init(
        serverID: String,
        serverName: String,
        domain: String,
        certificateFingerprint: String,
        supportedVersions: [Int]
    ) {
        self.serverID = serverID
        self.serverName = serverName
        self.domain = domain
        self.certificateFingerprint = certificateFingerprint
        self.supportedVersions = supportedVersions
    }
}

/// A discovered host with validated identity metadata and a connectable local
/// network endpoint. The endpoint's certificate fingerprint comes from TXT;
/// its host and port come only from Bonjour service resolution.
public struct DiscoveredHost: Sendable, Equatable, Identifiable {
    public let serverID: String
    public let serverName: String
    public let domain: String
    public let certificateFingerprint: String
    public let supportedVersions: [Int]
    public let endpoint: HostEndpoint

    public var id: String { serverID }

    public init(identity: BonjourHostIdentity, endpoint: HostEndpoint) {
        self.serverID = identity.serverID
        self.serverName = identity.serverName
        self.domain = identity.domain
        self.certificateFingerprint = identity.certificateFingerprint
        self.supportedVersions = identity.supportedVersions
        self.endpoint = endpoint
    }
}

public struct BonjourDiscoveryEntry: Sendable, Equatable, Identifiable {
    public let identity: BonjourHostIdentity
    public let availability: BonjourHostAvailability

    public var id: String { identity.serverID }
    public var serverID: String { identity.serverID }
    public var serverName: String { identity.serverName }

    public init(identity: BonjourHostIdentity, availability: BonjourHostAvailability) {
        self.identity = identity
        self.availability = availability
    }
}

public enum BonjourHostAvailability: Sendable, Equatable {
    case resolved(DiscoveredHost)
    case resolutionFailed(BonjourResolutionFailure)
}

public enum BonjourResolutionFailure: Sendable, Equatable {
    case timedOut
    case unresolved
    case invalidEndpoint
}

/// TXT records are attacker-controlled — anyone on the LAN can advertise
/// `_psyche._tcp`. Nothing here trusts a field it has not validated, and a
/// record missing any of them is dropped rather than surfaced half-formed.
public enum BonjourHostParser {
    public static let serviceType = "_psyche._tcp"

    public static func host(from record: BonjourServiceRecord) -> BonjourHostIdentity? {
        // Bonjour TXT keys are case-insensitive by spec, so fold before lookup.
        let txt = Dictionary(
            record.txt.map { ($0.key.lowercased(), $0.value) },
            uniquingKeysWith: { first, _ in first }
        )

        let serverID = txt["serverid"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !serverID.isEmpty else { return nil }

        guard let rawFingerprint = txt["fingerprint"],
              let fingerprint = try? PinnedCertificateDelegate
                .normalizeFingerprint(rawFingerprint) else {
            return nil
        }

        let versions = supportedVersions(in: txt)
        guard !versions.isEmpty else { return nil }

        let serverName = record.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return BonjourHostIdentity(
            serverID: serverID,
            serverName: serverName.isEmpty ? serverID : serverName,
            domain: record.domain,
            certificateFingerprint: fingerprint,
            supportedVersions: versions
        )
    }

    /// Deduplicates on server ID — the identity — rather than on service name,
    /// which changes when the host is renamed and collides when two hosts pick
    /// the same one. Sorted so a rendered list holds still between browses.
    public static func hosts(from records: [BonjourServiceRecord]) -> [BonjourHostIdentity] {
        var seen: [String: BonjourHostIdentity] = [:]
        for record in records {
            guard let host = host(from: record), seen[host.serverID] == nil else { continue }
            seen[host.serverID] = host
        }
        return seen.values.sorted { $0.serverID < $1.serverID }
    }

    private static func supportedVersions(in txt: [String: String]) -> [Int] {
        let advertised: [Int]
        if let versions = txt["versions"], !versions.isEmpty {
            advertised = versions
                .split(separator: ",")
                .compactMap { Int($0.trimmingCharacters(in: .whitespaces)) }
        } else if let proto = txt["proto"].flatMap({ Int($0.trimmingCharacters(in: .whitespaces)) }) {
            advertised = [proto]
        } else {
            advertised = []
        }
        return advertised.filter(PsycheProtocolVersion.supported.contains).sorted()
    }
}

public protocol BonjourBrowsing: Sendable {
    func records() -> AsyncStream<[BonjourServiceRecord]>
    func start()
    func stop()
}

struct BonjourHostDiscoveryLifecycle: @unchecked Sendable {
    let didTerminateObservation: @Sendable () -> Void
    let beforeFinishObservation: @Sendable () async -> Void
    let didFinishObservation: @Sendable () -> Void

    init(
        didTerminateObservation: @escaping @Sendable () -> Void = {},
        beforeFinishObservation: @escaping @Sendable () async -> Void = {},
        didFinishObservation: @escaping @Sendable () -> Void = {}
    ) {
        self.didTerminateObservation = didTerminateObservation
        self.beforeFinishObservation = beforeFinishObservation
        self.didFinishObservation = didFinishObservation
    }
}

/// Browses the LAN and publishes discovery rows for every valid identity.
public actor BonjourHostDiscovery {
    private let browser: any BonjourBrowsing
    private let resolver: any BonjourServiceResolving
    private let lifecycle: BonjourHostDiscoveryLifecycle
    private var observationTask: Task<Void, Never>?
    private var batchTask: Task<Void, Never>?
    private var continuation: AsyncStream<[BonjourDiscoveryEntry]>.Continuation?
    private var observationID: UInt64 = 0
    private var batchID: UInt64 = 0
    private var activeBatch: Batch?
    private var publishedEntries: [String: BonjourDiscoveryEntry] = [:]
    private var latestIdentities: [String: BonjourHostIdentity] = [:]
    private var resolutionGeneration: UInt64 = 0
    private var latestResolutionTokens: [String: UInt64] = [:]
    private var retryTasks: [String: RetryTask] = [:]

    /// Four concurrent resolutions keep a stale peer from serially delaying
    /// usable hosts while keeping Bonjour work bounded on busy LANs.
    private static let maximumConcurrentResolutions = 4

    private struct Batch {
        let id: UInt64
        let serviceIDs: Set<String>
    }

    private struct ResolutionAttempt {
        let identity: BonjourHostIdentity
        let token: UInt64
    }

    private struct RetryTask {
        let token: UInt64
        let task: Task<BonjourDiscoveryEntry?, Never>
    }

    public init(
        browser: any BonjourBrowsing = NWBonjourBrowser(),
        resolver: any BonjourServiceResolving = NetServiceBonjourResolver()
    ) {
        self.browser = browser
        self.resolver = resolver
        self.lifecycle = .init()
    }

    init(
        browser: any BonjourBrowsing,
        resolver: any BonjourServiceResolving,
        lifecycle: BonjourHostDiscoveryLifecycle = .init()
    ) {
        self.browser = browser
        self.resolver = resolver
        self.lifecycle = lifecycle
    }

    public func start() -> AsyncStream<[BonjourDiscoveryEntry]> {
        observationID &+= 1
        let currentObservationID = observationID
        observationTask?.cancel()
        batchTask?.cancel()
        continuation?.finish()
        continuation = nil
        activeBatch = nil
        publishedEntries = [:]
        latestIdentities = [:]
        invalidateAllResolutionState()

        let records = browser.records()
        browser.start()

        let (stream, continuation) = AsyncStream<[BonjourDiscoveryEntry]>.makeStream()
        self.continuation = continuation
        let task = Task { [resolver] in
            for await batch in records {
                guard !Task.isCancelled else { return }
                self.beginBatch(
                    from: batch,
                    observationID: currentObservationID,
                    using: resolver
                )
            }
            await self.lifecycle.beforeFinishObservation()
            await self.finishObservation(currentObservationID)
            self.lifecycle.didFinishObservation()
        }
        observationTask = task
        continuation.onTermination = { [weak self] _ in
            task.cancel()
            Task {
                await self?.terminateObservation(currentObservationID)
            }
        }
        return stream
    }

    public func stop() {
        observationID &+= 1
        observationTask?.cancel()
        observationTask = nil
        batchTask?.cancel()
        batchTask = nil
        activeBatch = nil
        publishedEntries = [:]
        latestIdentities = [:]
        invalidateAllResolutionState()
        continuation?.finish()
        continuation = nil
        browser.stop()
    }

    public func retry(serverID: String) async {
        guard let identity = latestIdentities[serverID] else { return }
        let currentObservationID = observationID
        let token = nextResolutionToken(for: serverID)
        cancelRetryTask(for: serverID)
        let task = Task { [resolver] in
            await Self.resolveHost(identity, using: resolver)
        }
        retryTasks[serverID] = RetryTask(token: token, task: task)

        let entry = await withTaskCancellationHandler(operation: {
            await task.value
        }, onCancel: {
            task.cancel()
        })
        clearRetryTaskIfCurrent(serverID: serverID, token: token)

        guard let entry else { return }
        guard currentObservationID == self.observationID,
              latestIdentities[serverID] == identity else {
            return
        }
        publishRetriedEntry(
            entry,
            observationID: currentObservationID,
            identity: identity,
            resolutionToken: token
        )
    }

    private func beginBatch(
        from records: [BonjourServiceRecord],
        observationID: UInt64,
        using resolver: any BonjourServiceResolving
    ) {
        guard observationID == self.observationID else { return }

        let identities = BonjourHostParser.hosts(from: records)
        batchID &+= 1
        let currentBatchID = batchID
        batchTask?.cancel()
        let serviceIDs = Set(identities.map(\.serverID))
        let removedIdentityIDs = Set(latestIdentities.keys).subtracting(serviceIDs)
        let removedPublishedIDs = Set(publishedEntries.keys).subtracting(serviceIDs)
        invalidateResolutionState(for: removedIdentityIDs)
        for serviceID in removedIdentityIDs {
            latestIdentities.removeValue(forKey: serviceID)
        }
        for serviceID in removedPublishedIDs {
            publishedEntries.removeValue(forKey: serviceID)
        }
        for identity in identities {
            latestIdentities[identity.serverID] = identity
        }
        let attempts = identities.map { identity in
            ResolutionAttempt(
                identity: identity,
                token: nextResolutionToken(for: identity.serverID)
            )
        }
        cancelRetryTasks(for: serviceIDs)
        activeBatch = Batch(id: currentBatchID, serviceIDs: serviceIDs)
        if !removedPublishedIDs.isEmpty {
            publishCurrentEntries()
        }

        let discovery = self
        batchTask = Task { [resolver, discovery] in
            let completed = await BonjourHostDiscovery.resolveHosts(from: attempts, using: resolver) { entry, token in
                guard !Task.isCancelled else { return }
                await discovery.publishResolvedEntry(
                    entry,
                    observationID: observationID,
                    batchID: currentBatchID,
                    resolutionToken: token
                )
            }
            guard !Task.isCancelled else { return }
            await discovery.finishBatch(
                observationID: observationID,
                batchID: currentBatchID,
                completed: completed
            )
        }
    }

    private func publishResolvedEntry(
        _ entry: BonjourDiscoveryEntry,
        observationID: UInt64,
        batchID: UInt64,
        resolutionToken: UInt64
    ) {
        guard observationID == self.observationID,
              activeBatch?.id == batchID,
              latestIdentities[entry.serverID] == entry.identity,
              latestResolutionTokens[entry.serverID] == resolutionToken else {
            return
        }
        publishedEntries[entry.serverID] = entry
        publishCurrentEntries()
    }

    private func publishRetriedEntry(
        _ entry: BonjourDiscoveryEntry,
        observationID: UInt64,
        identity: BonjourHostIdentity,
        resolutionToken: UInt64
    ) {
        guard observationID == self.observationID,
              latestIdentities[entry.serverID] == identity,
              latestResolutionTokens[entry.serverID] == resolutionToken else {
            return
        }
        publishedEntries[entry.serverID] = entry
        publishCurrentEntries()
    }

    private func finishBatch(
        observationID: UInt64,
        batchID: UInt64,
        completed: Bool
    ) {
        guard observationID == self.observationID,
              let batch = activeBatch,
              batch.id == batchID else {
            return
        }
        _ = completed
        activeBatch = nil
        batchTask = nil
    }

    private func publishCurrentEntries() {
        continuation?.yield(publishedEntries.values.sorted { $0.serverID < $1.serverID })
    }

    private func finishObservation(_ observationID: UInt64) {
        guard observationID == self.observationID else { return }
        observationTask = nil
        batchTask?.cancel()
        batchTask = nil
        activeBatch = nil
        publishedEntries = [:]
        latestIdentities = [:]
        invalidateAllResolutionState()
        continuation?.finish()
        continuation = nil
        browser.stop()
    }

    private func terminateObservation(_ observationID: UInt64) {
        guard observationID == self.observationID,
              continuation != nil else {
            return
        }
        // Invalidate this reader before cancelling it so its trailing
        // finishObservation call cannot own browser shutdown a second time.
        self.observationID &+= 1
        observationTask?.cancel()
        observationTask = nil
        batchTask?.cancel()
        batchTask = nil
        activeBatch = nil
        publishedEntries = [:]
        latestIdentities = [:]
        invalidateAllResolutionState()
        continuation = nil
        lifecycle.didTerminateObservation()
        browser.stop()
    }

    private static func resolveHosts(
        from attempts: [ResolutionAttempt],
        using resolver: any BonjourServiceResolving,
        publish: @escaping @Sendable (BonjourDiscoveryEntry, UInt64) async -> Void
    ) async -> Bool {
        guard !attempts.isEmpty else { return !Task.isCancelled }

        await withTaskGroup(of: (BonjourDiscoveryEntry, UInt64)?.self) { group in
            var nextAttemptIndex = 0

            func resolveNextAttempt() {
                let attempt = attempts[nextAttemptIndex]
                nextAttemptIndex += 1
                group.addTask {
                    guard let entry = await resolveHost(attempt.identity, using: resolver) else {
                        return nil
                    }
                    return (entry, attempt.token)
                }
            }

            for _ in 0..<min(maximumConcurrentResolutions, attempts.count) {
                resolveNextAttempt()
            }

            while let resolved = await group.next() {
                guard !Task.isCancelled else {
                    group.cancelAll()
                    return
                }

                if let resolved {
                    await publish(resolved.0, resolved.1)
                }

                if nextAttemptIndex < attempts.count {
                    resolveNextAttempt()
                }
            }
        }
        return !Task.isCancelled
    }

    private func nextResolutionToken(for serverID: String) -> UInt64 {
        resolutionGeneration &+= 1
        let token = resolutionGeneration
        latestResolutionTokens[serverID] = token
        return token
    }

    private func cancelRetryTask(for serverID: String) {
        retryTasks.removeValue(forKey: serverID)?.task.cancel()
    }

    private func cancelRetryTasks<S: Sequence>(for serverIDs: S) where S.Element == String {
        for serverID in serverIDs {
            cancelRetryTask(for: serverID)
        }
    }

    private func clearRetryTaskIfCurrent(serverID: String, token: UInt64) {
        guard retryTasks[serverID]?.token == token else { return }
        retryTasks.removeValue(forKey: serverID)
    }

    private func invalidateResolutionState<S: Sequence>(for serverIDs: S) where S.Element == String {
        for serverID in serverIDs {
            latestResolutionTokens.removeValue(forKey: serverID)
            cancelRetryTask(for: serverID)
        }
    }

    private func invalidateAllResolutionState() {
        latestResolutionTokens = [:]
        let tasks = retryTasks.values.map(\.task)
        retryTasks = [:]
        for task in tasks {
            task.cancel()
        }
    }

    private static func resolveHost(
        _ identity: BonjourHostIdentity,
        using resolver: any BonjourServiceResolving
    ) async -> BonjourDiscoveryEntry? {
        guard !Task.isCancelled else { return nil }
        do {
            let resolved = try await resolver.resolve(name: identity.serverName, domain: identity.domain)
            guard !Task.isCancelled else { return nil }
            guard let endpoint = endpoint(from: resolved, fingerprint: identity.certificateFingerprint) else {
                return BonjourDiscoveryEntry(
                    identity: identity,
                    availability: .resolutionFailed(.invalidEndpoint)
                )
            }
            return BonjourDiscoveryEntry(
                identity: identity,
                availability: .resolved(DiscoveredHost(identity: identity, endpoint: endpoint))
            )
        } catch is CancellationError {
            return nil
        } catch let error as BonjourServiceResolverError {
            switch error {
            case .timedOut:
                return BonjourDiscoveryEntry(
                    identity: identity,
                    availability: .resolutionFailed(.timedOut)
                )
            case .unresolved:
                return BonjourDiscoveryEntry(
                    identity: identity,
                    availability: .resolutionFailed(.unresolved)
                )
            case .invalidEndpoint:
                return BonjourDiscoveryEntry(
                    identity: identity,
                    availability: .resolutionFailed(.invalidEndpoint)
                )
            }
        } catch {
            return BonjourDiscoveryEntry(
                identity: identity,
                availability: .resolutionFailed(.unresolved)
            )
        }
    }

    private static func endpoint(
        from resolved: ResolvedBonjourEndpoint,
        fingerprint: String
    ) -> HostEndpoint? {
        let host = resolved.host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !host.isEmpty, (1...65_535).contains(resolved.port) else { return nil }
        return HostEndpoint(
            host: host,
            port: resolved.port,
            certificateFingerprint: fingerprint
        )
    }
}

public final class NWBonjourBrowser: BonjourBrowsing, @unchecked Sendable {
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "ai.opencoven.psyche.bonjour")
    private var browser: NWBrowser?
    private var continuation: AsyncStream<[BonjourServiceRecord]>.Continuation?

    public init() {}

    deinit {
        browser?.cancel()
        continuation?.finish()
    }

    public func records() -> AsyncStream<[BonjourServiceRecord]> {
        let (stream, continuation) = AsyncStream<[BonjourServiceRecord]>.makeStream()
        let previous = lock.withLock {
            let previous = self.continuation
            self.continuation = continuation
            return previous
        }
        previous?.finish()
        return stream
    }

    public func start() {
        let parameters = NWParameters()
        parameters.includePeerToPeer = false
        let browser = NWBrowser(
            for: .bonjourWithTXTRecord(type: BonjourHostParser.serviceType, domain: nil),
            using: parameters
        )
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            self?.emit(results)
        }
        let previous = lock.withLock {
            let previous = self.browser
            self.browser = browser
            return previous
        }
        previous?.cancel()
        browser.start(queue: queue)
    }

    public func stop() {
        let (browser, continuation) = lock.withLock {
            let values = (self.browser, self.continuation)
            self.browser = nil
            self.continuation = nil
            return values
        }
        browser?.cancel()
        continuation?.finish()
    }

    private func emit(_ results: Set<NWBrowser.Result>) {
        let records = results.compactMap(Self.record(from:))
        lock.withLock { continuation }?.yield(records)
    }

    private static func record(from result: NWBrowser.Result) -> BonjourServiceRecord? {
        guard case let .service(name, _, domain, _) = result.endpoint else { return nil }
        var txt: [String: String] = [:]
        if case let .bonjour(record) = result.metadata {
            txt = record.dictionary
        }
        return BonjourServiceRecord(name: name, domain: domain, txt: txt)
    }
}
