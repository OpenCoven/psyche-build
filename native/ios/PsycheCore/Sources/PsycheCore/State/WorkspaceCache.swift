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
    public let workspace: WorkspaceSnapshot
    public let sequence: UInt64
    public let lastConfirmedAt: Date?
    public let selectedProjectID: String?
    public let primaryPaneID: String?
    public let secondaryPaneID: String?
    public let drafts: [String: String]

    public init(
        workspace: WorkspaceSnapshot,
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
        let normalizedServerID = try Self.normalizedServerID(serverID)
        guard let data = try readData() else { return nil }
        let cache = try decodeCache(from: data)
        return cache.records[normalizedServerID]
    }

    public func save(
        _ state: CachedWorkspaceState,
        forServerID serverID: String
    ) throws {
        let normalizedServerID = try Self.normalizedServerID(serverID)
        try validate(state)
        var cache = try readCache()
        cache.records[normalizedServerID] = state
        let data = try encode(cache)
        try store.write(data)
    }

    public func removeCachedState(forServerID serverID: String) throws {
        let normalizedServerID = try Self.normalizedServerID(serverID)
        var cache = try readCache()
        guard cache.records.removeValue(forKey: normalizedServerID) != nil else { return }
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

    private static func normalizedServerID(_ serverID: String) throws -> String {
        let trimmed = serverID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw WorkspaceCacheError.invalidHostIdentity
        }
        return trimmed
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
