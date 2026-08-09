import Foundation

public enum PaneStatus: String, Codable, Sendable, CaseIterable {
    case working
    case idle
    case waiting
    case unknown

    /// Synthesized Codable throws on an unrecognized raw value, so a status
    /// added on the host would fail the whole message decode on an older
    /// client. `.unknown` exists precisely to absorb that, so decode into it.
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = PaneStatus(rawValue: raw) ?? .unknown
    }
}

public enum ConnectionState: Codable, Sendable, Equatable {
    case disconnected
    case connecting
    case authenticating
    case connected
    case disconnecting
    case failed(String)
}

public enum ConnectionRoute: String, Codable, Sendable, CaseIterable {
    case localNetwork
    case relay
}

public struct HostEndpoint: Codable, Sendable, Equatable, Hashable {
    public let host: String
    public let port: Int
    public let route: ConnectionRoute

    public init(host: String, port: Int, route: ConnectionRoute = .localNetwork) {
        self.host = host
        self.port = port
        self.route = route
    }
}

public struct Project: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let displayName: String
    public let attentionCount: Int

    public init(id: String, displayName: String, attentionCount: Int) {
        self.id = id
        self.displayName = displayName
        self.attentionCount = attentionCount
    }
}

public struct PaneSnapshot: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let displayName: String
    public let kind: String
    public let projectID: String?
    public let projectName: String?
    public let worktreePath: String?
    public let agent: String?
    public let status: PaneStatus

    public init(
        id: String,
        displayName: String,
        kind: String,
        projectID: String?,
        projectName: String?,
        worktreePath: String?,
        agent: String?,
        status: PaneStatus
    ) {
        self.id = id
        self.displayName = displayName
        self.kind = kind
        self.projectID = projectID
        self.projectName = projectName
        self.worktreePath = worktreePath
        self.agent = agent
        self.status = status
    }

    enum CodingKeys: String, CodingKey {
        case id, displayName, kind, projectID = "projectId", projectName, worktreePath, agent, status
    }
}

public struct WorkspaceSnapshotEnvelope: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String
    public let workspace: WorkspaceSnapshot

    enum CodingKeys: String, CodingKey {
        case type, requestID = "requestId", workspace
    }
}

public struct WorkspaceSnapshot: Codable, Sendable, Equatable {
    public let revision: Int
    public let projects: [WorkspaceProjectSnapshot]
}

public struct WorkspaceProjectSnapshot: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let root: String
    public let title: String
    public let worktrees: [WorkspaceWorktreeSnapshot]
    public let projectPanes: [WorkspacePaneSnapshot]
    public let runningCount: Int
    public let attentionCount: Int
}

public struct WorkspaceWorktreeSnapshot: Codable, Sendable, Equatable, Identifiable {
    public var id: String { path }
    public let path: String
    public let head: String
    public let branch: String?
    public let isMain: Bool
    public let detached: Bool
    public let bare: Bool
    public let locked: Bool
    public let lockReason: String?
    public let prunable: Bool
    public let pruneReason: String?
    public let dirty: Bool
    public let missing: Bool
    public let panes: [WorkspacePaneSnapshot]
    public let runningCount: Int
    public let attentionCount: Int
}

public struct WorkspacePaneSnapshot: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let cwd: String
    public let title: String?
    public let kind: String
    public let agent: String?
    public let status: String
    public let needsAttention: Bool?
    public let recoverability: String
}

public struct AttentionEvent: Codable, Sendable, Equatable {
    public let paneID: String
    public let reason: PaneStatus
    public let summary: String?
    public let timestamp: String

    public init(paneID: String, reason: PaneStatus, summary: String?, timestamp: String) {
        self.paneID = paneID
        self.reason = reason
        self.summary = summary
        self.timestamp = timestamp
    }

    enum CodingKeys: String, CodingKey {
        case paneID = "paneId", reason, summary, timestamp
    }
}

public enum RitualScope: String, Codable, Sendable {
    case builtIn
    case project
}

public struct Ritual: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let displayName: String
    public let description: String?
    public let scope: RitualScope
    public let projectID: String?

    public init(id: String, displayName: String, description: String?, scope: RitualScope, projectID: String?) {
        self.id = id
        self.displayName = displayName
        self.description = description
        self.scope = scope
        self.projectID = projectID
    }

    enum CodingKeys: String, CodingKey {
        case id, displayName, description, scope, projectID = "projectId"
    }
}

public struct ProtocolError: Codable, Sendable, Equatable, Error, LocalizedError {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }

    public var errorDescription: String? { message }
}

public struct HelloPayload: Codable, Sendable, Equatable {
    public let clientID: String
    public let clientName: String
    public let protocolVersion: Int
    public let token: String?

    public init(clientID: String, clientName: String, protocolVersion: Int = 2, token: String?) {
        self.clientID = clientID
        self.clientName = clientName
        self.protocolVersion = protocolVersion
        self.token = token
    }

    enum CodingKeys: String, CodingKey {
        case clientID = "clientId", clientName, protocolVersion, token
    }
}

public struct EmptyPayload: Codable, Sendable, Equatable {
    public init() {}
}

public struct PaneIDPayload: Codable, Sendable, Equatable {
    public let paneID: String
    public init(paneID: String) { self.paneID = paneID }

    enum CodingKeys: String, CodingKey {
        case paneID = "paneId"
    }
}

public struct SendInputPayload: Codable, Sendable, Equatable {
    public let paneID: String
    public let data: String

    public init(paneID: String, data: String) {
        self.paneID = paneID
        self.data = data
    }

    enum CodingKeys: String, CodingKey {
        case paneID = "paneId"
        case data
    }
}

public struct SubscribePanePayload: Codable, Sendable, Equatable {
    public let paneID: String
    public let sinceSeq: UInt64?

    public init(paneID: String, sinceSeq: UInt64?) {
        self.paneID = paneID
        self.sinceSeq = sinceSeq
    }

    enum CodingKeys: String, CodingKey {
        case paneID = "paneId"
        case sinceSeq
    }
}

public struct TokenPayload: Codable, Sendable, Equatable {
    public let token: String
    public init(token: String) { self.token = token }
}

public struct ListRitualsPayload: Codable, Sendable, Equatable {
    public let projectID: String?
    public init(projectID: String?) { self.projectID = projectID }

    enum CodingKeys: String, CodingKey {
        case projectID = "projectId"
    }
}

public struct LaunchRitualPayload: Codable, Sendable, Equatable {
    public let projectID: String
    public let ritualID: String
    public let params: [String: String]

    public init(projectID: String, ritualID: String, params: [String: String]) {
        self.projectID = projectID
        self.ritualID = ritualID
        self.params = params
    }

    enum CodingKeys: String, CodingKey {
        case projectID = "projectId"
        case ritualID = "ritualId"
        case params
    }
}

public struct PairRequestPayload: Codable, Sendable, Equatable {
    public let code: String
    public let clientID: String
    public let clientName: String

    public init(code: String, clientID: String, clientName: String) {
        self.code = code
        self.clientID = clientID
        self.clientName = clientName
    }

    enum CodingKeys: String, CodingKey {
        case code
        case clientID = "clientId"
        case clientName
    }
}

public enum ClientMessage: Codable, Sendable, Equatable {

    /// Wire `type` values this side declares. The contract test asserts a
    /// fixture exists for each — see protocol-fixtures/.
    public static var allTypeNames: [String] { MessageType.allCases.map(\.rawValue) }

    case hello(HelloPayload)
    case listPanes(EmptyPayload)
    case sendInput(SendInputPayload)
    case focusPane(PaneIDPayload)
    case ping(TokenPayload)
    case listProjects(EmptyPayload)
    case subscribePane(SubscribePanePayload)
    case unsubscribePane(PaneIDPayload)
    case listRituals(ListRitualsPayload)
    case launchRitual(LaunchRitualPayload)
    case pair(PairRequestPayload)

    private enum CodingKeys: String, CodingKey { case type, payload }
    private enum MessageType: String, Codable, CaseIterable {
        case hello, listPanes, sendInput, focusPane, ping, listProjects, subscribePane, unsubscribePane, listRituals, launchRitual, pair
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(MessageType.self, forKey: .type)
        switch type {
        case .hello: self = .hello(try container.decode(HelloPayload.self, forKey: .payload))
        case .listPanes: self = .listPanes(try container.decode(EmptyPayload.self, forKey: .payload))
        case .sendInput: self = .sendInput(try container.decode(SendInputPayload.self, forKey: .payload))
        case .focusPane: self = .focusPane(try container.decode(PaneIDPayload.self, forKey: .payload))
        case .ping: self = .ping(try container.decode(TokenPayload.self, forKey: .payload))
        case .listProjects: self = .listProjects(try container.decode(EmptyPayload.self, forKey: .payload))
        case .subscribePane: self = .subscribePane(try container.decode(SubscribePanePayload.self, forKey: .payload))
        case .unsubscribePane: self = .unsubscribePane(try container.decode(PaneIDPayload.self, forKey: .payload))
        case .listRituals: self = .listRituals(try container.decode(ListRitualsPayload.self, forKey: .payload))
        case .launchRitual: self = .launchRitual(try container.decode(LaunchRitualPayload.self, forKey: .payload))
        case .pair: self = .pair(try container.decode(PairRequestPayload.self, forKey: .payload))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .hello(let payload): try encode(.hello, payload, into: &container)
        case .listPanes(let payload): try encode(.listPanes, payload, into: &container)
        case .sendInput(let payload): try encode(.sendInput, payload, into: &container)
        case .focusPane(let payload): try encode(.focusPane, payload, into: &container)
        case .ping(let payload): try encode(.ping, payload, into: &container)
        case .listProjects(let payload): try encode(.listProjects, payload, into: &container)
        case .subscribePane(let payload): try encode(.subscribePane, payload, into: &container)
        case .unsubscribePane(let payload): try encode(.unsubscribePane, payload, into: &container)
        case .listRituals(let payload): try encode(.listRituals, payload, into: &container)
        case .launchRitual(let payload): try encode(.launchRitual, payload, into: &container)
        case .pair(let payload): try encode(.pair, payload, into: &container)
        }
    }

    private func encode<Payload: Encodable>(
        _ type: MessageType,
        _ payload: Payload,
        into container: inout KeyedEncodingContainer<CodingKeys>
    ) throws {
        try container.encode(type, forKey: .type)
        try container.encode(payload, forKey: .payload)
    }
}

public struct WelcomePayload: Codable, Sendable, Equatable {
    public let serverID: String
    public let serverName: String
    public let protocolVersion: Int
    public let projectName: String?
    public let supportedVersions: [Int]?

    public init(
        serverID: String,
        serverName: String,
        protocolVersion: Int,
        projectName: String?,
        supportedVersions: [Int]? = nil
    ) {
        self.serverID = serverID
        self.serverName = serverName
        self.protocolVersion = protocolVersion
        self.projectName = projectName
        self.supportedVersions = supportedVersions
    }

    enum CodingKeys: String, CodingKey {
        case serverID = "serverId", serverName, protocolVersion, projectName, supportedVersions
    }
}

public struct PaneOutputPayload: Codable, Sendable, Equatable {
    public let paneID: String
    public let data: String
    public let seq: UInt64

    public init(paneID: String, data: String, seq: UInt64) {
        self.paneID = paneID
        self.data = data
        self.seq = seq
    }

    enum CodingKeys: String, CodingKey {
        case paneID = "paneId"
        case data, seq
    }
}

public struct RitualListPayload: Codable, Sendable, Equatable {
    public let projectID: String?
    public let rituals: [Ritual]

    public init(projectID: String?, rituals: [Ritual]) {
        self.projectID = projectID
        self.rituals = rituals
    }

    enum CodingKeys: String, CodingKey {
        case projectID = "projectId"
        case rituals
    }
}

public struct PairChallengePayload: Codable, Sendable, Equatable {
    public let expiresAt: String
    public let codeLength: Int

    public init(expiresAt: String, codeLength: Int) {
        self.expiresAt = expiresAt
        self.codeLength = codeLength
    }
}

public struct PairAcceptedPayload: Codable, Sendable, Equatable {
    public let token: String
    public init(token: String) { self.token = token }
}

public struct PairRejectedPayload: Codable, Sendable, Equatable {
    public let reason: String
    public init(reason: String) { self.reason = reason }
}

public enum ServerMessage: Codable, Sendable, Equatable {

    /// Wire `type` values this side declares. The contract test asserts a
    /// fixture exists for each — see protocol-fixtures/.
    public static var allTypeNames: [String] { MessageType.allCases.map(\.rawValue) }

    case welcome(WelcomePayload)
    case paneList([PaneSnapshot])
    case paneListChanged([PaneSnapshot])
    case projectList([Project])
    case paneOutput(PaneOutputPayload)
    case ritualList(RitualListPayload)
    case attention(AttentionEvent)
    case pairChallenge(PairChallengePayload)
    case pairAccepted(PairAcceptedPayload)
    case pairRejected(PairRejectedPayload)
    case pong(TokenPayload)
    case error(ProtocolError)

    private enum CodingKeys: String, CodingKey { case type, payload }
    private enum MessageType: String, Codable, CaseIterable {
        case welcome, paneList, paneListChanged, projectList, paneOutput, ritualList, attention, pairChallenge, pairAccepted, pairRejected, pong, error
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(MessageType.self, forKey: .type)
        switch type {
        case .welcome: self = .welcome(try container.decode(WelcomePayload.self, forKey: .payload))
        case .paneList: self = .paneList(try container.decode([PaneSnapshot].self, forKey: .payload))
        case .paneListChanged: self = .paneListChanged(try container.decode([PaneSnapshot].self, forKey: .payload))
        case .projectList: self = .projectList(try container.decode([Project].self, forKey: .payload))
        case .paneOutput: self = .paneOutput(try container.decode(PaneOutputPayload.self, forKey: .payload))
        case .ritualList: self = .ritualList(try container.decode(RitualListPayload.self, forKey: .payload))
        case .attention: self = .attention(try container.decode(AttentionEvent.self, forKey: .payload))
        case .pairChallenge: self = .pairChallenge(try container.decode(PairChallengePayload.self, forKey: .payload))
        case .pairAccepted: self = .pairAccepted(try container.decode(PairAcceptedPayload.self, forKey: .payload))
        case .pairRejected: self = .pairRejected(try container.decode(PairRejectedPayload.self, forKey: .payload))
        case .pong: self = .pong(try container.decode(TokenPayload.self, forKey: .payload))
        case .error: self = .error(try container.decode(ProtocolError.self, forKey: .payload))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .welcome(let payload): try encode(.welcome, payload, into: &container)
        case .paneList(let payload): try encode(.paneList, payload, into: &container)
        case .paneListChanged(let payload): try encode(.paneListChanged, payload, into: &container)
        case .projectList(let payload): try encode(.projectList, payload, into: &container)
        case .paneOutput(let payload): try encode(.paneOutput, payload, into: &container)
        case .ritualList(let payload): try encode(.ritualList, payload, into: &container)
        case .attention(let payload): try encode(.attention, payload, into: &container)
        case .pairChallenge(let payload): try encode(.pairChallenge, payload, into: &container)
        case .pairAccepted(let payload): try encode(.pairAccepted, payload, into: &container)
        case .pairRejected(let payload): try encode(.pairRejected, payload, into: &container)
        case .pong(let payload): try encode(.pong, payload, into: &container)
        case .error(let payload): try encode(.error, payload, into: &container)
        }
    }

    public static func decode(from data: Data) throws -> ServerMessage {
        try JSONDecoder().decode(ServerMessage.self, from: data)
    }

    private func encode<Payload: Encodable>(
        _ type: MessageType,
        _ payload: Payload,
        into container: inout KeyedEncodingContainer<CodingKeys>
    ) throws {
        try container.encode(type, forKey: .type)
        try container.encode(payload, forKey: .payload)
    }
}
