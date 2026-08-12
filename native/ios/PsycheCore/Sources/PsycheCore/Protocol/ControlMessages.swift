import Foundation

public enum MobileClientMessage: Codable, Sendable, Equatable {
    case legacy(ClientMessage)
    case control(MobileControlRequest)

    private enum CodingKeys: String, CodingKey { case type, payload }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)

        switch type {
        case "control":
            self = .control(try container.decode(MobileControlRequest.self, forKey: .payload))
        default:
            self = .legacy(try ClientMessage(from: decoder))
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .legacy(let message):
            try message.encode(to: encoder)
        case .control(let payload):
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode("control", forKey: .type)
            try container.encode(payload, forKey: .payload)
        }
    }
}

public enum MobileServerMessage: Codable, Sendable, Equatable {
    case legacy(ServerMessage)
    case control(MobileControlResponse)
    case workspaceChanged(WorkspaceChangedEvent)

    private enum CodingKeys: String, CodingKey { case type, payload }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)

        switch type {
        case "control":
            self = .control(try container.decode(MobileControlResponse.self, forKey: .payload))
        case "workspaceChanged":
            self = .workspaceChanged(try container.decode(WorkspaceChangedEvent.self, forKey: .payload))
        default:
            self = .legacy(try ServerMessage(from: decoder))
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .legacy(let message):
            try message.encode(to: encoder)
        case .control(let payload):
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode("control", forKey: .type)
            try container.encode(payload, forKey: .payload)
        case .workspaceChanged(let payload):
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode("workspaceChanged", forKey: .type)
            try container.encode(payload, forKey: .payload)
        }
    }
}

public enum MobileControlRequest: Codable, Sendable, Equatable {
    /// Wire `payload.type` values this side declares for mobile control requests.
    public static var supportedTypeNames: [String] { MessageType.allCases.map(\.rawValue) }

    case workspaceSnapshot(ControlRequestIDOnly)
    case spawnPane(MobilePaneSpawnRequest)
    case attachPane(MobilePaneAttachRequest)
    case detachPane(PaneDetachRequest)
    case inputPane(PaneInputRequest)
    case resizePane(PaneResizeRequest)
    case killPane(PaneIDControlRequest)
    case paneMeta(PaneMetaRequest)
    case listFiles(MobileFilesListRequest)
    case readFile(MobileFilesReadRequest)
    case diffFile(MobileFilesDiffRequest)
    case startAction(MobileActionStartRequest)
    case respondToAction(MobileActionRespondRequest)
    case launchRitual(MobileRitualLaunchRequest)
    case unknown(UnknownControlRequest)

    private enum CodingKeys: String, CodingKey {
        case type
        case requestID = "requestId"
        case paneID = "id"
    }
    private enum MessageType: String, CaseIterable {
        case workspaceSnapshot = "workspace.snapshot"
        case detachPane = "panes.detach"
        case inputPane = "panes.input"
        case resizePane = "panes.resize"
        case killPane = "panes.kill"
        case paneMeta = "panes.meta"
        case spawnPane = "panes.spawn"
        case attachPane = "panes.attach"
        case listFiles = "files.list"
        case readFile = "files.read"
        case diffFile = "files.diff"
        case startAction = "actions.start"
        case respondToAction = "actions.respond"
        case launchRitual = "rituals.launch"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)

        switch type {
        case "workspace.snapshot":
            self = .workspaceSnapshot(
                ControlRequestIDOnly(requestID: try container.decode(String.self, forKey: .requestID))
            )
        case "panes.spawn": self = .spawnPane(try MobilePaneSpawnRequest(from: decoder))
        case "panes.attach": self = .attachPane(try MobilePaneAttachRequest(from: decoder))
        case "panes.detach": self = .detachPane(try PaneDetachRequest(from: decoder))
        case "panes.input": self = .inputPane(try PaneInputRequest(from: decoder))
        case "panes.resize": self = .resizePane(try PaneResizeRequest(from: decoder))
        case "panes.kill":
            self = .killPane(
                PaneIDControlRequest(
                    requestID: try container.decode(String.self, forKey: .requestID),
                    paneID: try container.decode(String.self, forKey: .paneID)
                )
            )
        case "panes.meta": self = .paneMeta(try PaneMetaRequest(from: decoder))
        case "files.list": self = .listFiles(try MobileFilesListRequest(from: decoder))
        case "files.read": self = .readFile(try MobileFilesReadRequest(from: decoder))
        case "files.diff": self = .diffFile(try MobileFilesDiffRequest(from: decoder))
        case "actions.start": self = .startAction(try MobileActionStartRequest(from: decoder))
        case "actions.respond": self = .respondToAction(try MobileActionRespondRequest(from: decoder))
        case "rituals.launch": self = .launchRitual(try MobileRitualLaunchRequest(from: decoder))
        case "ack",
             "panes.spawn.result",
             "panes.stream.exit",
             "error",
             "mobile.workspace.snapshot.result",
             "mobile.panes.attach.result",
             "files.list.result",
             "files.read.result",
             "files.diff.result",
             "actions.result":
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Mobile control response \(type) cannot decode as a request"
            )
        default: self = .unknown(try UnknownControlRequest(from: decoder))
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .workspaceSnapshot(let payload):
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(MessageType.workspaceSnapshot.rawValue, forKey: .type)
            try container.encode(payload.requestID, forKey: .requestID)
        case .spawnPane(let payload): try payload.encode(to: encoder)
        case .attachPane(let payload): try payload.encode(to: encoder)
        case .detachPane(let payload): try payload.encode(to: encoder)
        case .inputPane(let payload): try payload.encode(to: encoder)
        case .resizePane(let payload): try payload.encode(to: encoder)
        case .killPane(let payload):
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(MessageType.killPane.rawValue, forKey: .type)
            try container.encode(payload.requestID, forKey: .requestID)
            try container.encode(payload.paneID, forKey: .paneID)
        case .paneMeta(let payload): try payload.encode(to: encoder)
        case .listFiles(let payload): try payload.encode(to: encoder)
        case .readFile(let payload): try payload.encode(to: encoder)
        case .diffFile(let payload): try payload.encode(to: encoder)
        case .startAction(let payload): try payload.encode(to: encoder)
        case .respondToAction(let payload): try payload.encode(to: encoder)
        case .launchRitual(let payload): try payload.encode(to: encoder)
        case .unknown(let payload): try payload.encode(to: encoder)
        }
    }
}

public enum MobileControlResponse: Codable, Sendable, Equatable {
    /// Wire `payload.type` values this side declares for mobile control responses.
    public static var supportedTypeNames: [String] { MessageType.allCases.map(\.rawValue) }

    case workspaceSnapshot(MobileWorkspaceSnapshotResult)
    case ack(ControlAckResponse)
    case paneSpawned(PaneSpawnedResponse)
    case attachPane(MobilePaneAttachResult)
    case streamExited(PaneStreamExitedResponse)
    case filesList(MobileFilesListResult)
    case filesRead(MobileFilesReadResult)
    case filesDiff(MobileFilesDiffResult)
    case actionResult(MobileActionsResultResponse)
    case error(MobileProtocolErrorResponse)
    case unknown(UnknownControlResponse)

    private enum CodingKeys: String, CodingKey { case type }
    private enum MessageType: String, CaseIterable {
        case ack
        case paneSpawned = "panes.spawn.result"
        case streamExited = "panes.stream.exit"
        case error
        case workspaceSnapshot = "mobile.workspace.snapshot.result"
        case attachPane = "mobile.panes.attach.result"
        case filesList = "files.list.result"
        case filesRead = "files.read.result"
        case filesDiff = "files.diff.result"
        case actionResult = "actions.result"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)

        switch type {
        case "mobile.workspace.snapshot.result": self = .workspaceSnapshot(try MobileWorkspaceSnapshotResult(from: decoder))
        case "ack": self = .ack(try ControlAckResponse(from: decoder))
        case "panes.spawn.result": self = .paneSpawned(try PaneSpawnedResponse(from: decoder))
        case "mobile.panes.attach.result": self = .attachPane(try MobilePaneAttachResult(from: decoder))
        case "panes.stream.exit": self = .streamExited(try PaneStreamExitedResponse(from: decoder))
        case "files.list.result": self = .filesList(try MobileFilesListResult(from: decoder))
        case "files.read.result": self = .filesRead(try MobileFilesReadResult(from: decoder))
        case "files.diff.result": self = .filesDiff(try MobileFilesDiffResult(from: decoder))
        case "actions.result": self = .actionResult(try MobileActionsResultResponse(from: decoder))
        case "error": self = .error(try MobileProtocolErrorResponse(from: decoder))
        default:
            self = .unknown(try UnknownControlResponse(from: decoder))
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .workspaceSnapshot(let payload): try payload.encode(to: encoder)
        case .ack(let payload): try payload.encode(to: encoder)
        case .paneSpawned(let payload): try payload.encode(to: encoder)
        case .attachPane(let payload): try payload.encode(to: encoder)
        case .streamExited(let payload): try payload.encode(to: encoder)
        case .filesList(let payload): try payload.encode(to: encoder)
        case .filesRead(let payload): try payload.encode(to: encoder)
        case .filesDiff(let payload): try payload.encode(to: encoder)
        case .actionResult(let payload): try payload.encode(to: encoder)
        case .error(let payload): try payload.encode(to: encoder)
        case .unknown(let payload): try payload.encode(to: encoder)
        }
    }
}

public extension MobileControlRequest {
    /// Every declared request type carries an ID. `unknown` is whatever a
    /// newer host sent, which may not, so this stays optional rather than
    /// inventing one.
    var requestID: String? {
        switch self {
        case .workspaceSnapshot(let payload): payload.requestID
        case .spawnPane(let payload): payload.requestID
        case .attachPane(let payload): payload.requestID
        case .detachPane(let payload): payload.requestID
        case .inputPane(let payload): payload.requestID
        case .resizePane(let payload): payload.requestID
        case .killPane(let payload): payload.requestID
        case .paneMeta(let payload): payload.requestID
        case .listFiles(let payload): payload.requestID
        case .readFile(let payload): payload.requestID
        case .diffFile(let payload): payload.requestID
        case .startAction(let payload): payload.requestID
        case .respondToAction(let payload): payload.requestID
        case .launchRitual(let payload): payload.requestID
        case .unknown(let payload): payload.requestID
        }
    }
}

public extension MobileControlResponse {
    /// The request this answers, when it answers one. `streamExited` is an
    /// unsolicited event and a protocol error may be connection-wide, so both
    /// legitimately have no ID and must not be correlated to a caller.
    var requestID: String? {
        switch self {
        case .workspaceSnapshot(let payload): payload.requestID
        case .ack(let payload): payload.requestID
        case .paneSpawned(let payload): payload.requestID
        case .attachPane(let payload): payload.requestID
        case .streamExited: nil
        case .filesList(let payload): payload.requestID
        case .filesRead(let payload): payload.requestID
        case .filesDiff(let payload): payload.requestID
        case .actionResult(let payload): payload.requestID
        case .error(let payload): payload.requestID
        case .unknown(let payload): payload.requestID
        }
    }
}

public struct WorkspaceChangedEvent: Codable, Sendable, Equatable {
    public let revision: Int
    public let sequence: UInt64
    public let workspace: WorkspaceSnapshot
}

public enum PaneCreateKind: String, Codable, Sendable, CaseIterable {
    case agent
    case terminal
    case covenSession = "coven-session"
}

public enum TerminalReplayMode: String, Codable, Sendable, CaseIterable {
    case append
    case replace
}

public struct BrowserFile: Codable, Sendable, Equatable, Identifiable {
    public let path: String
    public let name: String
    public let parentPath: String?
    public let exists: Bool
    public let changed: Bool
    public let statusCode: String
    public let statusLabel: String

    public var id: String { path }
}

public struct BrowserSnapshot: Codable, Sendable, Equatable {
    public let rootPath: String
    public let files: [BrowserFile]
}

public struct MobileActionOption: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let label: String
    public let description: String?
    public let danger: Bool?
    public let isDefault: Bool?

    enum CodingKeys: String, CodingKey {
        case id, label, description, danger
        case isDefault = "default"
    }
}

public struct MobileActionReviewData: Codable, Sendable, Equatable {
    public let repoPath: String
    public let sourceBranch: String
    public let targetBranch: String
    public let files: [String]
    public let aiFailed: Bool?
}

public struct MobileActionResult: Codable, Sendable, Equatable {
    public let type: String
    public let message: String
    public let title: String?
    public let confirmLabel: String?
    public let cancelLabel: String?
    public let options: [MobileActionOption]?
    public let placeholder: String?
    public let defaultValue: String?
    public let inputMaxVisibleLines: Int?
    public let progress: Double?
    public let targetPaneID: String?
    public let reviewData: MobileActionReviewData?
    public let data: String?
    public let relatedFiles: [String]?
    public let dismissable: Bool?

    enum CodingKeys: String, CodingKey {
        case type, message, title, confirmLabel, cancelLabel, options, placeholder, defaultValue
        case inputMaxVisibleLines, progress, reviewData, data, relatedFiles, dismissable
        case targetPaneID = "targetPaneId"
    }
}

public enum PaneAction: String, Codable, Sendable, CaseIterable {
    case view
    case setSource = "set_source"
    case close
    case merge
    case createPR = "create_pr"
    case rename
    case duplicate
    case runTest = "run_test"
    case runDev = "run_dev"
    case openOutput = "open_output"
    case copyPath = "copy_path"
    case openInEditor = "open_in_editor"
    case toggleAutopilot = "toggle_autopilot"
    case attachAgent = "attach_agent"
    case createChildWorktree = "create_child_worktree"
    case openTerminalInWorktree = "open_terminal_in_worktree"
    case openFileBrowser = "open_file_browser"
}

public enum MobileActionResponse: Sendable, Equatable {
    case confirm
    case choice(optionID: String)
    case input(value: String)
    case cancel
}

extension MobileActionResponse: Codable {
    private enum CodingKeys: String, CodingKey { case type, optionID = "optionId", value }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)

        switch type {
        case "confirm": self = .confirm
        case "choice": self = .choice(optionID: try container.decode(String.self, forKey: .optionID))
        case "input": self = .input(value: try container.decode(String.self, forKey: .value))
        case "cancel": self = .cancel
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unsupported mobile action response type \(type)"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .confirm:
            try container.encode("confirm", forKey: .type)
        case .choice(let optionID):
            try container.encode("choice", forKey: .type)
            try container.encode(optionID, forKey: .optionID)
        case .input(let value):
            try container.encode("input", forKey: .type)
            try container.encode(value, forKey: .value)
        case .cancel:
            try container.encode("cancel", forKey: .type)
        }
    }
}

public enum CovenDesktopQuickAction: String, Codable, Sendable, CaseIterable {
    case screenshot
    case inspect
    case permissions
    case approve
    case deny
    case test
}

public enum JSONValue: Codable, Sendable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

public struct ControlRequestIDOnly: Codable, Sendable, Equatable {
    public let requestID: String

    public init(requestID: String) {
        self.requestID = requestID
    }

    enum CodingKeys: String, CodingKey {
        case requestID = "requestId"
    }
}

public struct ProjectsOpenRequest: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String
    public let cwd: String?
    public let title: String?
    public let autonomyProfile: String?

    public init(requestID: String, cwd: String?, title: String?, autonomyProfile: String?) {
        self.type = "projects.open"
        self.requestID = requestID
        self.cwd = cwd
        self.title = title
        self.autonomyProfile = autonomyProfile
    }

    enum CodingKeys: String, CodingKey {
        case type, cwd, title, autonomyProfile
        case requestID = "requestId"
    }
}

public struct ExistingWorktreeReference: Codable, Sendable, Equatable {
    public let slug: String
    public let worktreePath: String
    public let branchName: String
}

public struct MobilePaneSpawnRequest: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String
    public let idempotencyKey: String
    public let kind: PaneCreateKind
    public let projectID: String
    public let cwd: String
    public let branch: String?
    public let startPointBranch: String?
    public let agent: String?
    public let title: String?
    public let prompt: String?
    public let existingWorktree: ExistingWorktreeReference?

    public init(
        requestID: String,
        idempotencyKey: String,
        kind: PaneCreateKind,
        projectID: String,
        cwd: String,
        branch: String?,
        startPointBranch: String?,
        agent: String?,
        title: String?,
        prompt: String?,
        existingWorktree: ExistingWorktreeReference?
    ) {
        self.type = "panes.spawn"
        self.requestID = requestID
        self.idempotencyKey = idempotencyKey
        self.kind = kind
        self.projectID = projectID
        self.cwd = cwd
        self.branch = branch
        self.startPointBranch = startPointBranch
        self.agent = agent
        self.title = title
        self.prompt = prompt
        self.existingWorktree = existingWorktree
    }

    enum CodingKeys: String, CodingKey {
        case type, idempotencyKey, kind, cwd, branch, agent, title, prompt, existingWorktree
        case requestID = "requestId"
        case projectID = "projectId"
        case startPointBranch
    }
}

public struct PaneSpawnManyRequest: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String
    public let idempotencyKey: String
    public let launches: [PaneLaunchSpec]

    public init(requestID: String, idempotencyKey: String, launches: [PaneLaunchSpec]) {
        self.type = "panes.spawnMany"
        self.requestID = requestID
        self.idempotencyKey = idempotencyKey
        self.launches = launches
    }

    enum CodingKeys: String, CodingKey {
        case type, idempotencyKey, launches
        case requestID = "requestId"
    }
}

public struct PaneLaunchSpec: Codable, Sendable, Equatable {
    public let cwd: String
    public let branch: String?
    public let startPointBranch: String?
    public let agent: String?
    public let title: String?
    public let prompt: String?
    public let existingWorktree: ExistingWorktreeReference?
}

public struct PaneCaptureRequest: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String
    public let id: String
    public let lines: Int?

    public init(requestID: String, id: String, lines: Int?) {
        self.type = "panes.capture"
        self.requestID = requestID
        self.id = id
        self.lines = lines
    }

    enum CodingKeys: String, CodingKey {
        case type, id, lines
        case requestID = "requestId"
    }
}

public struct PaneStatusRequest: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String
    public let id: String

    public init(requestID: String, id: String) {
        self.type = "panes.status"
        self.requestID = requestID
        self.id = id
    }

    enum CodingKeys: String, CodingKey {
        case type, id
        case requestID = "requestId"
    }
}

public struct MobileRitualLaunchRequest: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String
    public let projectID: String
    public let ritualID: String
    public let params: [String: String]?

    public init(
        requestID: String,
        projectID: String,
        ritualID: String,
        params: [String: String]?
    ) {
        self.type = "rituals.launch"
        self.requestID = requestID
        self.projectID = projectID
        self.ritualID = ritualID
        self.params = params
    }

    enum CodingKeys: String, CodingKey {
        case type, params
        case requestID = "requestId"
        case projectID = "projectId"
        case ritualID = "ritualId"
    }
}

public struct MobilePaneAttachRequest: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String
    public let id: String
    public let columns: Int?
    public let rows: Int?
    public let sinceSequence: UInt64?

    public init(requestID: String, id: String, columns: Int?, rows: Int?, sinceSequence: UInt64?) {
        self.type = "panes.attach"
        self.requestID = requestID
        self.id = id
        self.columns = columns
        self.rows = rows
        self.sinceSequence = sinceSequence
    }

    enum CodingKeys: String, CodingKey {
        case type, id, rows
        case requestID = "requestId"
        case columns = "cols"
        case sinceSequence = "sinceSeq"
    }
}

public struct PaneDetachRequest: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String
    public let streamID: String

    public init(requestID: String, streamID: String) {
        self.type = "panes.detach"
        self.requestID = requestID
        self.streamID = streamID
    }

    enum CodingKeys: String, CodingKey {
        case type
        case requestID = "requestId"
        case streamID = "streamId"
    }
}

public struct PaneFocusRequest: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String
    public let id: String?
    public let streamID: String?

    public init(requestID: String, id: String?, streamID: String?) {
        self.type = "panes.focus"
        self.requestID = requestID
        self.id = id
        self.streamID = streamID
    }

    enum CodingKeys: String, CodingKey {
        case type, id
        case requestID = "requestId"
        case streamID = "streamId"
    }
}

public struct PaneInputRequest: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String
    public let streamID: String
    public let data: String

    public init(requestID: String, streamID: String, data: String) {
        self.type = "panes.input"
        self.requestID = requestID
        self.streamID = streamID
        self.data = data
    }

    enum CodingKeys: String, CodingKey {
        case type, data
        case requestID = "requestId"
        case streamID = "streamId"
    }
}

public struct PaneResizeRequest: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String
    public let streamID: String
    public let cols: Int
    public let rows: Int

    public init(requestID: String, streamID: String, cols: Int, rows: Int) {
        self.type = "panes.resize"
        self.requestID = requestID
        self.streamID = streamID
        self.cols = cols
        self.rows = rows
    }

    enum CodingKeys: String, CodingKey {
        case type, cols, rows
        case requestID = "requestId"
        case streamID = "streamId"
    }
}

public struct PaneIDControlRequest: Codable, Sendable, Equatable {
    public let requestID: String
    public let paneID: String

    public init(requestID: String, paneID: String) {
        self.requestID = requestID
        self.paneID = paneID
    }

    enum CodingKeys: String, CodingKey {
        case requestID = "requestId"
        case paneID = "id"
    }
}

public struct PaneMetaRequest: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String
    public let id: String
    public let title: String?
    public let agent: String?

    public init(requestID: String, id: String, title: String?, agent: String?) {
        self.type = "panes.meta"
        self.requestID = requestID
        self.id = id
        self.title = title
        self.agent = agent
    }

    enum CodingKeys: String, CodingKey {
        case type, id, title, agent
        case requestID = "requestId"
    }
}

public struct CovenSessionLaunchSpec: Codable, Sendable, Equatable {
    public let harness: String
    public let prompt: String
    public let cwd: String?
    public let title: String?
}

public struct CovenSessionLaunchRequest: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String
    public let launch: CovenSessionLaunchSpec

    public init(requestID: String, launch: CovenSessionLaunchSpec) {
        self.type = "coven.sessions.launch"
        self.requestID = requestID
        self.launch = launch
    }

    enum CodingKeys: String, CodingKey {
        case type, launch
        case requestID = "requestId"
    }
}

public struct CovenSessionOpenRequest: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String
    public let id: String

    public init(requestID: String, id: String) {
        self.type = "coven.sessions.open"
        self.requestID = requestID
        self.id = id
    }

    enum CodingKeys: String, CodingKey {
        case type, id
        case requestID = "requestId"
    }
}

public struct CovenCapabilityRequestSpec: Codable, Sendable, Equatable {
    public let taskID: String
    public let traceID: String?
    public let capability: String
    public let provider: String?
    public let prompt: String
    public let title: String?
    public let state: [String: JSONValue]?
    public let attempt: Int?
    public let idempotencyKey: String?

    enum CodingKeys: String, CodingKey {
        case capability, provider, prompt, title, state, attempt, idempotencyKey
        case taskID = "taskId"
        case traceID = "traceId"
    }
}

public struct CovenCapabilityExecuteRequest: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String
    public let sessionID: String
    public let capability: CovenCapabilityRequestSpec

    public init(requestID: String, sessionID: String, capability: CovenCapabilityRequestSpec) {
        self.type = "coven.capabilities.execute"
        self.requestID = requestID
        self.sessionID = sessionID
        self.capability = capability
    }

    enum CodingKeys: String, CodingKey {
        case type, capability
        case requestID = "requestId"
        case sessionID = "sessionId"
    }
}

public struct CovenDesktopStateRequest: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String
    public let sessionID: String

    public init(requestID: String, sessionID: String) {
        self.type = "coven.desktop.state"
        self.requestID = requestID
        self.sessionID = sessionID
    }

    enum CodingKeys: String, CodingKey {
        case type
        case requestID = "requestId"
        case sessionID = "sessionId"
    }
}

public struct CovenDesktopActionRequest: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String
    public let sessionID: String
    public let action: CovenDesktopQuickAction

    public init(requestID: String, sessionID: String, action: CovenDesktopQuickAction) {
        self.type = "coven.desktop.action"
        self.requestID = requestID
        self.sessionID = sessionID
        self.action = action
    }

    enum CodingKeys: String, CodingKey {
        case type, action
        case requestID = "requestId"
        case sessionID = "sessionId"
    }
}

public struct MobileFilesListRequest: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String
    public let paneID: String

    public init(requestID: String, paneID: String) {
        self.type = "files.list"
        self.requestID = requestID
        self.paneID = paneID
    }

    enum CodingKeys: String, CodingKey {
        case type
        case requestID = "requestId"
        case paneID = "paneId"
    }
}

public struct MobileFilesReadRequest: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String
    public let paneID: String
    public let path: String

    public init(requestID: String, paneID: String, path: String) {
        self.type = "files.read"
        self.requestID = requestID
        self.paneID = paneID
        self.path = path
    }

    enum CodingKeys: String, CodingKey {
        case type, path
        case requestID = "requestId"
        case paneID = "paneId"
    }
}

public struct MobileFilesDiffRequest: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String
    public let paneID: String
    public let path: String

    public init(requestID: String, paneID: String, path: String) {
        self.type = "files.diff"
        self.requestID = requestID
        self.paneID = paneID
        self.path = path
    }

    enum CodingKeys: String, CodingKey {
        case type, path
        case requestID = "requestId"
        case paneID = "paneId"
    }
}

public struct MobileActionStartRequest: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String
    public let paneID: String
    public let action: PaneAction

    public init(requestID: String, paneID: String, action: PaneAction) {
        self.type = "actions.start"
        self.requestID = requestID
        self.paneID = paneID
        self.action = action
    }

    enum CodingKeys: String, CodingKey {
        case type, action
        case requestID = "requestId"
        case paneID = "paneId"
    }
}

public struct MobileActionRespondRequest: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String
    public let sessionID: String
    public let response: MobileActionResponse

    public init(requestID: String, sessionID: String, response: MobileActionResponse) {
        self.type = "actions.respond"
        self.requestID = requestID
        self.sessionID = sessionID
        self.response = response
    }

    enum CodingKeys: String, CodingKey {
        case type, response
        case requestID = "requestId"
        case sessionID = "sessionId"
    }
}

public struct ControlPaneSummary: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let cwd: String
    public let branch: String?
    public let agent: String?
    public let title: String?
    public let lastActivity: String?
}

public struct MobileWorkspaceSnapshotResult: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String
    public let sequence: UInt64
    public let workspace: WorkspaceSnapshot

    public init(requestID: String, sequence: UInt64, workspace: WorkspaceSnapshot) {
        self.type = "mobile.workspace.snapshot.result"
        self.requestID = requestID
        self.sequence = sequence
        self.workspace = workspace
    }

    enum CodingKeys: String, CodingKey {
        case type, sequence, workspace
        case requestID = "requestId"
    }
}

public struct ControlAckResponse: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String
    public let ok: Bool

    public init(requestID: String, ok: Bool = true) {
        self.type = "ack"
        self.requestID = requestID
        self.ok = ok
    }

    enum CodingKeys: String, CodingKey {
        case type, ok
        case requestID = "requestId"
    }
}

public struct PaneSpawnedResponse: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String
    public let id: String
    public let pane: ControlPaneSummary?
    public let worktreePath: String?
    public let branch: String?

    public init(requestID: String, id: String, pane: ControlPaneSummary?, worktreePath: String?, branch: String?) {
        self.type = "panes.spawn.result"
        self.requestID = requestID
        self.id = id
        self.pane = pane
        self.worktreePath = worktreePath
        self.branch = branch
    }

    enum CodingKeys: String, CodingKey {
        case type, id, pane, worktreePath, branch
        case requestID = "requestId"
    }
}

public struct MobilePaneAttachResult: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String
    public let streamID: String
    public let id: String
    public let latestSequence: UInt64
    public let hasReplay: Bool
    public let replayMode: TerminalReplayMode

    public init(requestID: String, streamID: String, id: String, latestSequence: UInt64, hasReplay: Bool, replayMode: TerminalReplayMode) {
        self.type = "mobile.panes.attach.result"
        self.requestID = requestID
        self.streamID = streamID
        self.id = id
        self.latestSequence = latestSequence
        self.hasReplay = hasReplay
        self.replayMode = replayMode
    }

    enum CodingKeys: String, CodingKey {
        case type, id, hasReplay, replayMode
        case requestID = "requestId"
        case streamID = "streamId"
        case latestSequence = "latestSeq"
    }
}

public struct PaneStreamExitedResponse: Codable, Sendable, Equatable {
    public let type: String
    public let streamID: String
    public let reason: String

    public init(streamID: String, reason: String) {
        self.type = "panes.stream.exit"
        self.streamID = streamID
        self.reason = reason
    }

    enum CodingKeys: String, CodingKey {
        case type, reason
        case streamID = "streamId"
    }
}

public struct MobileFilesListResult: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String
    public let paneID: String
    public let snapshot: BrowserSnapshot

    public init(requestID: String, paneID: String, snapshot: BrowserSnapshot) {
        self.type = "files.list.result"
        self.requestID = requestID
        self.paneID = paneID
        self.snapshot = snapshot
    }

    enum CodingKeys: String, CodingKey {
        case type, snapshot
        case requestID = "requestId"
        case paneID = "paneId"
    }
}

public struct MobileFilesReadResult: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String
    public let paneID: String
    public let path: String
    public let content: String
    public let truncated: Bool

    public init(requestID: String, paneID: String, path: String, content: String, truncated: Bool) {
        self.type = "files.read.result"
        self.requestID = requestID
        self.paneID = paneID
        self.path = path
        self.content = content
        self.truncated = truncated
    }

    enum CodingKeys: String, CodingKey {
        case type, path, content, truncated
        case requestID = "requestId"
        case paneID = "paneId"
    }
}

public struct MobileFilesDiffResult: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String
    public let paneID: String
    public let path: String
    public let diff: String

    public init(requestID: String, paneID: String, path: String, diff: String) {
        self.type = "files.diff.result"
        self.requestID = requestID
        self.paneID = paneID
        self.path = path
        self.diff = diff
    }

    enum CodingKeys: String, CodingKey {
        case type, path, diff
        case requestID = "requestId"
        case paneID = "paneId"
    }
}

public struct MobileActionsResultResponse: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String
    public let sessionID: String?
    public let result: MobileActionResult

    public init(requestID: String, sessionID: String?, result: MobileActionResult) {
        self.type = "actions.result"
        self.requestID = requestID
        self.sessionID = sessionID
        self.result = result
    }

    enum CodingKeys: String, CodingKey {
        case type, result
        case requestID = "requestId"
        case sessionID = "sessionId"
    }
}

public struct MobileProtocolErrorResponse: Codable, Sendable, Equatable, Error, LocalizedError {
    public let type: String
    public let requestID: String?
    public let code: String
    public let message: String

    public init(requestID: String?, code: String, message: String) {
        self.type = "error"
        self.requestID = requestID
        self.code = code
        self.message = message
    }

    public var errorDescription: String? { message }

    enum CodingKeys: String, CodingKey {
        case type, code, message
        case requestID = "requestId"
    }
}

public struct UnknownControlResponse: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String?

    public init(type: String, requestID: String?) {
        self.type = type
        self.requestID = requestID
    }

    enum CodingKeys: String, CodingKey {
        case type
        case requestID = "requestId"
    }
}

public struct UnknownControlRequest: Codable, Sendable, Equatable {
    public let type: String
    public let requestID: String?

    public init(type: String, requestID: String?) {
        self.type = type
        self.requestID = requestID
    }

    enum CodingKeys: String, CodingKey {
        case type
        case requestID = "requestId"
    }
}
