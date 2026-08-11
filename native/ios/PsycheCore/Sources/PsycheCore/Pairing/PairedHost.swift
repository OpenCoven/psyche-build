import Foundation

/// A host this device has completed pairing with. The server ID is the
/// identity — names change, addresses move between networks, and tokens are
/// reissued, but a server ID that starts presenting a different certificate is
/// a different host until the user says otherwise.
public struct PairedHost: Codable, Sendable, Equatable, Identifiable {
    public let serverID: String
    public let serverName: String
    public let endpoint: HostEndpoint
    public let clientID: String
    public let token: String?

    public var id: String { serverID }
    public var certificateFingerprint: String { endpoint.certificateFingerprint }

    public init(
        serverID: String,
        serverName: String,
        endpoint: HostEndpoint,
        clientID: String,
        token: String?
    ) {
        self.serverID = serverID
        self.serverName = serverName
        self.endpoint = endpoint
        self.clientID = clientID
        self.token = token
    }

    public func withToken(_ token: String?) -> PairedHost {
        PairedHost(
            serverID: serverID,
            serverName: serverName,
            endpoint: endpoint,
            clientID: clientID,
            token: token
        )
    }

    public func withEndpoint(_ endpoint: HostEndpoint) -> PairedHost {
        PairedHost(
            serverID: serverID,
            serverName: serverName,
            endpoint: endpoint,
            clientID: clientID,
            token: token
        )
    }
}

/// Whether a host the user is looking at can be connected to directly, or is
/// carrying a certificate that no longer matches what was pinned at pairing.
public enum PairingStatus: String, Codable, Sendable, Equatable {
    case unpaired
    case paired
    case requiresRePairing
}
