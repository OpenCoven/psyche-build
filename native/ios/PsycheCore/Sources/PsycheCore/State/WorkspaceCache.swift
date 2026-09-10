import Foundation

public enum WorkspaceCacheError: Error, Sendable, Equatable, LocalizedError {
    case invalidHostIdentity
    case tooManyDrafts(actualCount: Int, limit: Int)
    case draftTooLong(paneID: String, actualLength: Int, limit: Int)
    case cacheTooLarge(actualBytes: Int, limit: Int)
    case corruptedRecord
    case unreadableRecord(String)
    case unwritableRecord(String)

    public var errorDescription: String? {
        switch self {
        case .invalidHostIdentity:
            "The workspace cache requires a non-empty host identity."
        case .tooManyDrafts(let actualCount, let limit):
            "The workspace cache refuses \(actualCount) drafts because the limit is \(limit)."
        case .draftTooLong(let paneID, let actualLength, let limit):
            """
            The draft for pane \(paneID) is \(actualLength) characters long, \
            exceeding the cache limit of \(limit).
            """
        case .cacheTooLarge(let actualBytes, let limit):
            "The workspace cache is \(actualBytes) bytes, exceeding the limit of \(limit)."
        case .corruptedRecord:
            "The workspace cache could not be read and was ignored."
        case .unreadableRecord(let reason):
            "The workspace cache could not be read: \(reason)"
        case .unwritableRecord(let reason):
            "The workspace cache could not be written: \(reason)"
        }
    }
}

public struct WorkspaceCacheLimits: Sendable, Equatable {
    public let maxEncodedBytes: Int
    public let maxDraftCount: Int
    public let maxDraftLength: Int

    public init(
        maxEncodedBytes: Int,
        maxDraftCount: Int,
        maxDraftLength: Int
    ) {
        self.maxEncodedBytes = maxEncodedBytes
        self.maxDraftCount = maxDraftCount
        self.maxDraftLength = maxDraftLength
    }

    public static let `default` = WorkspaceCacheLimits(
        maxEncodedBytes: 256 * 1024,
        maxDraftCount: 24,
        maxDraftLength: 4_096
    )
}

public struct CachedWorkspaceState: Codable, Sendable, Equatable {
    public let workspace: CachedWorkspaceSnapshot
    public let sequence: UInt64
    public let lastConfirmedAt: Date?
    public let selectedProjectID: String?
    public let primaryPaneID: String?
    public let secondaryPaneID: String?
    public let drafts: [String: String]

    public init(
        workspace: CachedWorkspaceSnapshot,
        sequence: UInt64,
        lastConfirmedAt: Date?,
        selectedProjectID: String?,
        primaryPaneID: String?,
        secondaryPaneID: String?,
        drafts: [String: String]
    ) {
        self.workspace = workspace
        self.sequence = sequence
        self.lastConfirmedAt = lastConfirmedAt
        self.selectedProjectID = selectedProjectID
        self.primaryPaneID = primaryPaneID
        self.secondaryPaneID = secondaryPaneID
        self.drafts = drafts
    }

    public init(
        workspace: WorkspaceSnapshot,
        sequence: UInt64,
        lastConfirmedAt: Date?,
        selectedProjectID: String?,
        primaryPaneID: String?,
        secondaryPaneID: String?,
        drafts: [String: String]
    ) {
        self.init(
            workspace: CachedWorkspaceSnapshot(workspace),
            sequence: sequence,
            lastConfirmedAt: lastConfirmedAt,
            selectedProjectID: selectedProjectID,
            primaryPaneID: primaryPaneID,
            secondaryPaneID: secondaryPaneID,
            drafts: drafts
        )
    }

    public var restoredWorkspace: WorkspaceSnapshot {
        workspace.workspaceSnapshot
    }
}

public struct CachedWorkspaceSnapshot: Codable, Sendable, Equatable {
    public let revision: Int
    public let projects: [CachedWorkspaceProjectSnapshot]

    public init(
        revision: Int,
        projects: [CachedWorkspaceProjectSnapshot]
    ) {
        self.revision = revision
        self.projects = projects
    }

    public init(_ workspace: WorkspaceSnapshot) {
        revision = workspace.revision
        projects = workspace.projects.map(CachedWorkspaceProjectSnapshot.init)
    }

    public var workspaceSnapshot: WorkspaceSnapshot {
        WorkspaceSnapshot(
            revision: revision,
            projects: projects.map(\.workspaceProjectSnapshot)
        )
    }
}

public struct CachedWorkspaceProjectSnapshot: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let root: String
    public let title: String
    public let worktrees: [CachedWorkspaceWorktreeSnapshot]
    public let projectPanes: [CachedWorkspacePaneSnapshot]
    public let runningCount: Int
    public let attentionCount: Int
    public let rituals: CachedRitualPublicationSnapshot?

    public init(
        id: String,
        root: String,
        title: String,
        worktrees: [CachedWorkspaceWorktreeSnapshot],
        projectPanes: [CachedWorkspacePaneSnapshot],
        runningCount: Int,
        attentionCount: Int,
        rituals: CachedRitualPublicationSnapshot?
    ) {
        self.id = id
        self.root = root
        self.title = title
        self.worktrees = worktrees
        self.projectPanes = projectPanes
        self.runningCount = runningCount
        self.attentionCount = attentionCount
        self.rituals = rituals
    }

    public init(_ project: WorkspaceProjectSnapshot) {
        id = project.id
        root = project.root
        title = project.title
        worktrees = project.worktrees.map(CachedWorkspaceWorktreeSnapshot.init)
        projectPanes = project.projectPanes.map(CachedWorkspacePaneSnapshot.init)
        runningCount = project.runningCount
        attentionCount = project.attentionCount
        rituals = project.rituals.map(CachedRitualPublicationSnapshot.init)
    }

    public var workspaceProjectSnapshot: WorkspaceProjectSnapshot {
        WorkspaceProjectSnapshot(
            id: id,
            root: root,
            title: title,
            worktrees: worktrees.map(\.workspaceWorktreeSnapshot),
            projectPanes: projectPanes.map(\.workspacePaneSnapshot),
            runningCount: runningCount,
            attentionCount: attentionCount,
            rituals: rituals?.ritualPublicationSnapshot
        )
    }
}

public struct CachedWorkspaceWorktreeSnapshot: Codable, Sendable, Equatable, Identifiable {
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
    public let panes: [CachedWorkspacePaneSnapshot]
    public let runningCount: Int
    public let attentionCount: Int

    public init(
        path: String,
        head: String,
        branch: String?,
        isMain: Bool,
        detached: Bool,
        bare: Bool,
        locked: Bool,
        lockReason: String?,
        prunable: Bool,
        pruneReason: String?,
        dirty: Bool,
        missing: Bool,
        panes: [CachedWorkspacePaneSnapshot],
        runningCount: Int,
        attentionCount: Int
    ) {
        self.path = path
        self.head = head
        self.branch = branch
        self.isMain = isMain
        self.detached = detached
        self.bare = bare
        self.locked = locked
        self.lockReason = lockReason
        self.prunable = prunable
        self.pruneReason = pruneReason
        self.dirty = dirty
        self.missing = missing
        self.panes = panes
        self.runningCount = runningCount
        self.attentionCount = attentionCount
    }

    public init(_ worktree: WorkspaceWorktreeSnapshot) {
        path = worktree.path
        head = worktree.head
        branch = worktree.branch
        isMain = worktree.isMain
        detached = worktree.detached
        bare = worktree.bare
        locked = worktree.locked
        lockReason = worktree.lockReason
        prunable = worktree.prunable
        pruneReason = worktree.pruneReason
        dirty = worktree.dirty
        missing = worktree.missing
        panes = worktree.panes.map(CachedWorkspacePaneSnapshot.init)
        runningCount = worktree.runningCount
        attentionCount = worktree.attentionCount
    }

    public var workspaceWorktreeSnapshot: WorkspaceWorktreeSnapshot {
        WorkspaceWorktreeSnapshot(
            path: path,
            head: head,
            branch: branch,
            isMain: isMain,
            detached: detached,
            bare: bare,
            locked: locked,
            lockReason: lockReason,
            prunable: prunable,
            pruneReason: pruneReason,
            dirty: dirty,
            missing: missing,
            panes: panes.map(\.workspacePaneSnapshot),
            runningCount: runningCount,
            attentionCount: attentionCount
        )
    }
}

public struct CachedWorkspacePaneSnapshot: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let cwd: String
    public let title: String?
    public let kind: String
    public let agent: String?
    public let status: String
    public let needsAttention: Bool?
    public let lastActivity: String?
    public let recoverability: String

    public init(
        id: String,
        cwd: String,
        title: String?,
        kind: String,
        agent: String?,
        status: String,
        needsAttention: Bool?,
        lastActivity: String?,
        recoverability: String
    ) {
        self.id = id
        self.cwd = cwd
        self.title = title
        self.kind = kind
        self.agent = agent
        self.status = status
        self.needsAttention = needsAttention
        self.lastActivity = lastActivity
        self.recoverability = recoverability
    }

    public init(_ pane: WorkspacePaneSnapshot) {
        id = pane.id
        cwd = pane.cwd
        title = pane.title
        kind = pane.kind
        agent = pane.agent
        status = pane.status
        needsAttention = pane.needsAttention
        lastActivity = pane.lastActivity
        recoverability = pane.recoverability
    }

    public var workspacePaneSnapshot: WorkspacePaneSnapshot {
        WorkspacePaneSnapshot(
            id: id,
            cwd: cwd,
            title: title,
            kind: kind,
            agent: agent,
            status: status,
            needsAttention: needsAttention,
            lastActivity: lastActivity,
            recoverability: recoverability
        )
    }
}

public struct CachedRitualPublicationSnapshot: Codable, Sendable, Equatable {
    public let state: RitualPublicationState
    public let rituals: [CachedPublishedRitual]

    public init(
        state: RitualPublicationState,
        rituals: [CachedPublishedRitual]
    ) {
        self.state = state
        self.rituals = rituals
    }

    public init(_ snapshot: RitualPublicationSnapshot) {
        state = snapshot.state
        rituals = snapshot.rituals.map(CachedPublishedRitual.init)
    }

    public var ritualPublicationSnapshot: RitualPublicationSnapshot {
        RitualPublicationSnapshot(
            state: state,
            rituals: rituals.map(\.publishedRitual)
        )
    }
}

public struct CachedPublishedRitual: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let displayName: String
    public let description: String?
    public let scope: RitualScope

    public init(
        id: String,
        displayName: String,
        description: String?,
        scope: RitualScope
    ) {
        self.id = id
        self.displayName = displayName
        self.description = description
        self.scope = scope
    }

    public init(_ ritual: PublishedRitual) {
        id = ritual.id
        displayName = ritual.displayName
        description = ritual.description
        scope = ritual.scope
    }

    public var publishedRitual: PublishedRitual {
        PublishedRitual(
            id: id,
            displayName: displayName,
            description: description,
            scope: scope
        )
    }
}

public actor WorkspaceCache {
    public static let defaultFileName = "workspace-cache.v1.json"

    private let limits: WorkspaceCacheLimits
    private let store: ProtectedAppSupportFileStore
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(
        baseDirectoryURL: URL? = nil,
        fileName: String = defaultFileName,
        limits: WorkspaceCacheLimits = .default
    ) {
        self.limits = limits
        store = ProtectedAppSupportFileStore(
            baseDirectoryURL: baseDirectoryURL,
            fileName: fileName
        )
        encoder.dateEncodingStrategy = .iso8601
        decoder.dateDecodingStrategy = .iso8601
    }

    init(
        baseDirectoryURL: URL? = nil,
        fileName: String = defaultFileName,
        limits: WorkspaceCacheLimits = .default,
        fileManager: any WorkspaceCacheFileManaging
    ) {
        self.limits = limits
        store = ProtectedAppSupportFileStore(
            baseDirectoryURL: baseDirectoryURL,
            fileName: fileName,
            fileManager: fileManager
        )
        encoder.dateEncodingStrategy = .iso8601
        decoder.dateDecodingStrategy = .iso8601
    }

    public func cachedState(forServerID serverID: String) throws -> CachedWorkspaceState? {
        let cacheKey = try Self.cacheKey(forServerID: serverID)
        guard let data = try readData() else { return nil }
        let cache = try decodeCache(from: data)
        return cache.records[cacheKey]
    }

    public func save(
        _ state: CachedWorkspaceState,
        forServerID serverID: String
    ) throws {
        let cacheKey = try Self.cacheKey(forServerID: serverID)
        try validate(state)
        var cache = try readCache()
        cache.records[cacheKey] = state
        let data = try encode(cache)
        try store.write(data)
    }

    public func removeCachedState(forServerID serverID: String) throws {
        let cacheKey = try Self.cacheKey(forServerID: serverID)
        var cache = try readCache()
        guard cache.records.removeValue(forKey: cacheKey) != nil else { return }
        let data = try encode(cache)
        try store.write(data)
    }

    func persistedFileProtectionType() throws -> FileProtectionType? {
        try store.protectionTypeIfPresent()
    }

    private func readCache() throws -> PersistedWorkspaceCache {
        guard let data = try readData() else { return .empty }
        return try decodeCache(from: data)
    }

    private func readData() throws -> Data? {
        do {
            guard let data = try store.read() else { return nil }
            guard data.count <= limits.maxEncodedBytes else {
                throw WorkspaceCacheError.cacheTooLarge(
                    actualBytes: data.count,
                    limit: limits.maxEncodedBytes
                )
            }
            return data
        } catch let error as WorkspaceCacheError {
            throw error
        } catch {
            throw WorkspaceCacheError.unreadableRecord(error.localizedDescription)
        }
    }

    private func decodeCache(from data: Data) throws -> PersistedWorkspaceCache {
        do {
            let cache = try decoder.decode(PersistedWorkspaceCache.self, from: data)
            guard cache.version == PersistedWorkspaceCache.currentVersion else {
                throw WorkspaceCacheError.corruptedRecord
            }
            try cache.records.values.forEach(validate)
            return cache
        } catch let error as WorkspaceCacheError {
            throw error
        } catch {
            throw WorkspaceCacheError.corruptedRecord
        }
    }

    private func encode(_ cache: PersistedWorkspaceCache) throws -> Data {
        do {
            let data = try encoder.encode(cache)
            guard data.count <= limits.maxEncodedBytes else {
                throw WorkspaceCacheError.cacheTooLarge(
                    actualBytes: data.count,
                    limit: limits.maxEncodedBytes
                )
            }
            return data
        } catch let error as WorkspaceCacheError {
            throw error
        } catch {
            throw WorkspaceCacheError.unwritableRecord(error.localizedDescription)
        }
    }

    private func validate(_ state: CachedWorkspaceState) throws {
        guard state.drafts.count <= limits.maxDraftCount else {
            throw WorkspaceCacheError.tooManyDrafts(
                actualCount: state.drafts.count,
                limit: limits.maxDraftCount
            )
        }
        for (paneID, draft) in state.drafts {
            let length = draft.count
            guard length <= limits.maxDraftLength else {
                throw WorkspaceCacheError.draftTooLong(
                    paneID: paneID,
                    actualLength: length,
                    limit: limits.maxDraftLength
                )
            }
        }
    }

    private static func cacheKey(forServerID serverID: String) throws -> String {
        guard !serverID.isEmpty else {
            throw WorkspaceCacheError.invalidHostIdentity
        }
        return serverID
    }

    private struct PersistedWorkspaceCache: Codable, Equatable {
        static let currentVersion = 1

        let version: Int
        var records: [String: CachedWorkspaceState]

        static let empty = Self(version: currentVersion, records: [:])
    }
}

private struct ProtectedAppSupportFileStore: Sendable {
    private static let protection = FileProtectionType.completeUntilFirstUserAuthentication

    private let baseDirectoryURL: URL?
    private let fileName: String
    private let fileManager: any WorkspaceCacheFileManaging

    init(
        baseDirectoryURL: URL?,
        fileName: String,
        fileManager: any WorkspaceCacheFileManaging = SystemWorkspaceCacheFileManager()
    ) {
        self.baseDirectoryURL = baseDirectoryURL
        self.fileName = fileName
        self.fileManager = fileManager
    }

    func read() throws -> Data? {
        try fileManager.readData(at: fileURL)
    }

    func write(_ data: Data) throws {
        let directoryURL = directoryURL
        try fileManager.createDirectory(
            at: directoryURL,
            protection: Self.protection
        )
        let temporaryURL = directoryURL.appendingPathComponent(
            "\(fileName).\(UUID().uuidString).tmp",
            isDirectory: false
        )
        do {
            try fileManager.createFile(
                at: temporaryURL,
                contents: data,
                protection: Self.protection
            )
            if try fileManager.fileExists(at: fileURL) {
                try fileManager.replaceItem(at: fileURL, withItemAt: temporaryURL)
            } else {
                try fileManager.moveItem(at: temporaryURL, to: fileURL)
            }
        } catch {
            try? fileManager.removeItemIfPresent(at: temporaryURL)
            throw error
        }
    }

    func protectionTypeIfPresent() throws -> FileProtectionType? {
        guard try fileManager.fileExists(at: fileURL) else { return nil }
        return try fileManager.attributesOfItem(at: fileURL)[.protectionKey] as? FileProtectionType
    }

    private var directoryURL: URL {
        baseDirectoryURL ?? fileManager.applicationSupportDirectory()
    }

    private var fileURL: URL {
        directoryURL.appendingPathComponent(fileName, isDirectory: false)
    }
}

protocol WorkspaceCacheFileManaging: Sendable {
    func applicationSupportDirectory() -> URL
    func readData(at url: URL) throws -> Data?
    func createDirectory(at url: URL, protection: FileProtectionType) throws
    func createFile(at url: URL, contents: Data, protection: FileProtectionType) throws
    func fileExists(at url: URL) throws -> Bool
    func moveItem(at sourceURL: URL, to destinationURL: URL) throws
    func replaceItem(at originalURL: URL, withItemAt replacementURL: URL) throws
    func removeItemIfPresent(at url: URL) throws
    func attributesOfItem(at url: URL) throws -> [FileAttributeKey: Any]
}

private struct SystemWorkspaceCacheFileManager: WorkspaceCacheFileManaging {
    func applicationSupportDirectory() -> URL {
        FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        )[0]
    }

    func readData(at url: URL) throws -> Data? {
        do {
            return try Data(contentsOf: url)
        } catch let error as NSError {
            guard error.domain == NSCocoaErrorDomain,
                  error.code == NSFileReadNoSuchFileError else {
                throw error
            }
            return nil
        }
    }

    func createDirectory(at url: URL, protection: FileProtectionType) throws {
        try FileManager.default.createDirectory(
            at: url,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: protection]
        )
    }

    func createFile(at url: URL, contents: Data, protection: FileProtectionType) throws {
        let created = FileManager.default.createFile(
            atPath: url.path,
            contents: contents,
            attributes: [.protectionKey: protection]
        )
        guard created else {
            throw CocoaError(.fileWriteUnknown)
        }
    }

    func fileExists(at url: URL) throws -> Bool {
        FileManager.default.fileExists(atPath: url.path)
    }

    func moveItem(at sourceURL: URL, to destinationURL: URL) throws {
        try FileManager.default.moveItem(at: sourceURL, to: destinationURL)
    }

    func replaceItem(at originalURL: URL, withItemAt replacementURL: URL) throws {
        _ = try FileManager.default.replaceItemAt(
            originalURL,
            withItemAt: replacementURL,
            backupItemName: nil,
            options: [.usingNewMetadataOnly]
        )
    }

    func removeItemIfPresent(at url: URL) throws {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        try FileManager.default.removeItem(at: url)
    }

    func attributesOfItem(at url: URL) throws -> [FileAttributeKey: Any] {
        try FileManager.default.attributesOfItem(atPath: url.path)
    }
}
