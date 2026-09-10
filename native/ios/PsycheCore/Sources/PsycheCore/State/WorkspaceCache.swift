import Darwin
import Foundation

public enum WorkspaceCacheError: Error, Sendable, Equatable, LocalizedError {
    case invalidHostIdentity
    case tooManyDrafts(actualCount: Int, limit: Int)
    case draftTooLong(paneID: String, actualLength: Int, limit: Int)
    case cacheTooLarge(actualBytes: Int, limit: Int)
    case corruptedRecord
    case unreadableRecord(String)
    case unwritableRecord(String)
    case recoveryRequired

    public var errorDescription: String? {
        switch self {
        case .invalidHostIdentity:
            "The workspace cache requires a non-empty host identity."
        case .tooManyDrafts(let actualCount, let limit):
            "The workspace cache refuses \(actualCount) drafts because the limit is \(limit)."
        case .draftTooLong(_, let actualLength, let limit):
            """
            A draft is \(actualLength) characters long, \
            exceeding the cache limit of \(limit).
            """
        case .cacheTooLarge(let actualBytes, let limit):
            "The workspace cache is \(actualBytes) bytes, exceeding the limit of \(limit)."
        case .corruptedRecord:
            "Saved workspace data is damaged or incompatible. Reconnect to recover after preserving the original data."
        case .unreadableRecord:
            "Saved workspace data could not be read safely. Keep the app data and retry after unlocking the device."
        case .unwritableRecord:
            "Workspace changes could not be saved. Keep the app open and retry after checking device storage."
        case .recoveryRequired:
            "Workspace recovery needs help: preservation storage is full or the record exceeds its limit. Keep the app data; do not reinstall or delete it."
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
    public static let recoveryNotice = "Original workspace data, including any drafts, is preserved on this device but has not been restored. Check for a saving error separately. Keep the app data for recovery; do not reinstall or delete it."

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

    @discardableResult
    /// Returns true only when preservation and a fresh cache write both succeed.
    public func save(
        _ state: CachedWorkspaceState,
        forServerID serverID: String,
        recoverIfNeeded: Bool = true
    ) throws -> Bool {
        let cacheKey = try Self.cacheKey(forServerID: serverID)
        try validate(state)
        var cache: PersistedWorkspaceCache
        var needsRecovery = false
        do {
            cache = try readCache()
        } catch let error as WorkspaceCacheError {
            switch error {
            case .corruptedRecord, .cacheTooLarge, .tooManyDrafts, .draftTooLong:
                guard recoverIfNeeded else { throw error }
                cache = .empty
                needsRecovery = true
            default:
                throw error
            }
        }
        cache.records[cacheKey] = state
        let data = try encode(cache)
        if needsRecovery {
            try store.preserveForRecovery()
        }
        try store.write(data)
        return needsRecovery
    }

    public func hasPreservedRecoveryRecords() throws -> Bool {
        try store.hasPreservedRecoveryRecords()
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
            guard let data = try store.read(maxBytes: limits.maxEncodedBytes) else { return nil }
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
    private static let recoveryByteLimit = 1024 * 1024
    private static let recoveryRecordLimit = 3

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

    func read(maxBytes: Int) throws -> Data? {
        try fileManager.readData(at: fileURL, maxBytes: maxBytes)
    }

    func hasPreservedRecoveryRecords() throws -> Bool {
        for index in 0..<Self.recoveryRecordLimit {
            if try fileManager.fileExists(at: recoveryURL(index)) { return true }
        }
        return false
    }

    // Never evict drafts to make room. Exhaustion requires operator-assisted
    // preservation, and leaves the active record untouched.
    func preserveForRecovery() throws {
        guard let data = try read(maxBytes: Self.recoveryByteLimit),
              data.count <= Self.recoveryByteLimit else {
            throw WorkspaceCacheError.recoveryRequired
        }
        try fileManager.createDirectory(at: directoryURL, protection: Self.protection)
        for index in 0..<Self.recoveryRecordLimit {
            let destination = recoveryURL(index)
            if try fileManager.fileExists(at: destination) {
                if try fileManager.readData(at: destination, maxBytes: Self.recoveryByteLimit) == data {
                    return
                }
                continue
            }
            try fileManager.createFile(at: destination, contents: data, protection: Self.protection)
            // Do not replace the original until the protected preservation copy
            // has been read back successfully.
            guard try fileManager.readData(at: destination, maxBytes: Self.recoveryByteLimit) == data,
                  try read(maxBytes: Self.recoveryByteLimit) == data else {
                throw WorkspaceCacheError.unwritableRecord("preservation verification failed")
            }
            return
        }
        throw WorkspaceCacheError.recoveryRequired
    }

    private func recoveryURL(_ index: Int) -> URL {
        directoryURL.appendingPathComponent("\(fileName).quarantine-\(index)")
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
    func readData(at url: URL, maxBytes: Int) throws -> Data?
    func createDirectory(at url: URL, protection: FileProtectionType) throws
    func createFile(at url: URL, contents: Data, protection: FileProtectionType) throws
    func fileExists(at url: URL) throws -> Bool
    func moveItem(at sourceURL: URL, to destinationURL: URL) throws
    func replaceItem(at originalURL: URL, withItemAt replacementURL: URL) throws
    func removeItemIfPresent(at url: URL) throws
    func attributesOfItem(at url: URL) throws -> [FileAttributeKey: Any]
}

struct SystemWorkspaceCacheFileManager: WorkspaceCacheFileManaging {
    func applicationSupportDirectory() -> URL {
        FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        )[0]
    }

    func readData(at url: URL, maxBytes: Int) throws -> Data? {
        let directory = open(
            url.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        )
        guard directory >= 0 else {
            if errno == ENOENT { return nil }
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        defer { close(directory) }
        let descriptor = openat(
            directory, url.lastPathComponent, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC
        )
        guard descriptor >= 0 else {
            if errno == ENOENT { return nil }
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        var identity = stat()
        guard fstat(descriptor, &identity) == 0,
              identity.st_mode & S_IFMT == S_IFREG,
              identity.st_nlink == 1 else {
            throw WorkspaceCacheError.unreadableRecord("unsafe file identity")
        }
        let data = try Self.readBounded(handle, maxBytes: maxBytes)
        var currentIdentity = stat()
        guard fstatat(directory, url.lastPathComponent, &currentIdentity, AT_SYMLINK_NOFOLLOW) == 0,
              currentIdentity.st_dev == identity.st_dev,
              currentIdentity.st_ino == identity.st_ino,
              currentIdentity.st_nlink == 1 else {
            throw WorkspaceCacheError.unreadableRecord("file identity changed")
        }
        return data
    }

    static func readBounded(_ handle: FileHandle, maxBytes: Int) throws -> Data {
        guard maxBytes >= 0, maxBytes < Int.max else {
            throw WorkspaceCacheError.unreadableRecord("invalid read limit")
        }
        var data = Data()
        while data.count <= maxBytes {
            let remaining = maxBytes + 1 - data.count
            guard let chunk = try handle.read(upToCount: min(16 * 1024, remaining)),
                  !chunk.isEmpty else { break }
            data.append(chunk)
        }
        return data
    }

    func createDirectory(at url: URL, protection: FileProtectionType) throws {
        try FileManager.default.createDirectory(
            at: url,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: protection]
        )
    }

    func createFile(at url: URL, contents: Data, protection: FileProtectionType) throws {
        try contents.write(to: url, options: [
            .withoutOverwriting, .completeFileProtectionUntilFirstUserAuthentication
        ])
        var protectedURL = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try protectedURL.setResourceValues(values)
        let descriptor = open(url.path, O_WRONLY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        try handle.synchronize()
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
