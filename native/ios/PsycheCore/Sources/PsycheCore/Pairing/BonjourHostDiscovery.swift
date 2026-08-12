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

/// Browses the LAN and publishes only the hosts that survived parsing.
public actor BonjourHostDiscovery {
    private let browser: any BonjourBrowsing
    private let resolver: any BonjourServiceResolving
    private var resolutionTask: Task<Void, Never>?

    public init(
        browser: any BonjourBrowsing = NWBonjourBrowser(),
        resolver: any BonjourServiceResolving = NetServiceBonjourResolver()
    ) {
        self.browser = browser
        self.resolver = resolver
    }

    public func start() -> AsyncStream<[DiscoveredHost]> {
        let records = browser.records()
        browser.start()
        resolutionTask?.cancel()

        let (stream, continuation) = AsyncStream<[DiscoveredHost]>.makeStream()
        let task = Task { [resolver] in
            for await batch in records {
                guard !Task.isCancelled else { return }
                continuation.yield(await Self.resolveHosts(from: batch, using: resolver))
            }
            continuation.finish()
        }
        resolutionTask = task
        continuation.onTermination = { _ in task.cancel() }
        return stream
    }

    public func stop() {
        resolutionTask?.cancel()
        resolutionTask = nil
        browser.stop()
    }

    private static func resolveHosts(
        from records: [BonjourServiceRecord],
        using resolver: any BonjourServiceResolving
    ) async -> [DiscoveredHost] {
        var hosts: [DiscoveredHost] = []
        for identity in BonjourHostParser.hosts(from: records) {
            guard !Task.isCancelled else { return [] }
            do {
                let resolved = try await resolver.resolve(name: identity.serverName, domain: identity.domain)
                guard let endpoint = endpoint(from: resolved, fingerprint: identity.certificateFingerprint) else {
                    continue
                }
                hosts.append(DiscoveredHost(identity: identity, endpoint: endpoint))
            } catch is CancellationError {
                return []
            } catch {
                continue
            }
        }
        return hosts.sorted { $0.serverID < $1.serverID }
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
