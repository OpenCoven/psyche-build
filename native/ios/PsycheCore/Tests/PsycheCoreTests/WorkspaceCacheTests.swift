import Foundation
import XCTest
@testable import PsycheCore

@MainActor
final class WorkspaceCacheTests: XCTestCase {
    func testSameHostRestoreRoundTripsWorkspaceSequenceSelectionAndDrafts() async throws {
        let directoryURL = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directoryURL) }
        let cache = WorkspaceCache(baseDirectoryURL: directoryURL)
        let state = makeCachedState(
            revision: 7,
            sequence: 42,
            selectedProjectID: "project-b",
            primaryPaneID: "pane-2",
            secondaryPaneID: "pane-1",
            drafts: [
                "pane-1": "git status",
                "pane-2": "pnpm test"
            ],
            projectID: "project-b"
        )

        try await cache.save(state, forServerID: "server-a")
        let loadedState = try await cache.cachedState(forServerID: "server-a")
        let loaded = try XCTUnwrap(loadedState)

        XCTAssertEqual(loaded, state)

        let store = WorkspaceStore()
        store.restoreCachedState(loaded)

        XCTAssertEqual(store.workspace?.revision, 7)
        XCTAssertEqual(store.sequence, 42)
        XCTAssertTrue(store.isStale)
        XCTAssertTrue(store.needsFullSnapshot)
        XCTAssertEqual(store.selectedProjectID, "project-b")
        XCTAssertEqual(store.primaryPaneID, "pane-2")
        XCTAssertEqual(store.secondaryPaneID, "pane-1")
        XCTAssertEqual(store.drafts, state.drafts)
    }

    func testMobileCompositionRestoresOnlyTheSelectedHostsCache() async throws {
        let secureStore = InMemorySecureStore()
        let pairedHostStore = PairedHostStore(secureStore: secureStore)
        let serverA = makeHost(serverID: "server-a", fingerprint: String(repeating: "a", count: 64))
        let serverB = makeHost(serverID: "server-b", fingerprint: String(repeating: "b", count: 64))
        try await pairedHostStore.save(serverA)
        try await pairedHostStore.save(serverB)
        try await pairedHostStore.save(serverB)

        let directoryURL = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directoryURL) }
        let cache = WorkspaceCache(baseDirectoryURL: directoryURL)
        try await cache.save(
            makeCachedState(
                revision: 3,
                sequence: 11,
                selectedProjectID: "project-a",
                primaryPaneID: "pane-a",
                secondaryPaneID: nil,
                drafts: ["pane-a": "host-a draft"]
            ),
            forServerID: serverA.serverID
        )
        try await cache.save(
            makeCachedState(
                revision: 9,
                sequence: 27,
                selectedProjectID: "project-b",
                primaryPaneID: "pane-b",
                secondaryPaneID: nil,
                drafts: ["pane-b": "host-b draft"],
                projectID: "project-b"
            ),
            forServerID: serverB.serverID
        )

        let composition = MobileAppComposition(
            transport: FakeTransport(),
            pairedHostStore: pairedHostStore,
            workspaceCache: cache
        )

        await composition.restorePersistedWorkspaceIfAvailable()

        XCTAssertEqual(composition.workspaceStore.workspace?.revision, 9)
        XCTAssertEqual(composition.workspaceStore.sequence, 27)
        XCTAssertEqual(composition.workspaceStore.selectedProjectID, "project-b")
        XCTAssertEqual(composition.workspaceStore.primaryPaneID, "pane-b")
        XCTAssertEqual(composition.workspaceStore.drafts, ["pane-b": "host-b draft"])
        XCTAssertNil(composition.workspaceCacheError)
    }

    func testCrossHostLookupNeverReturnsAnotherHostsState() async throws {
        let directoryURL = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directoryURL) }
        let cache = WorkspaceCache(baseDirectoryURL: directoryURL)
        try await cache.save(
            makeCachedState(
                revision: 1,
                sequence: 1,
                selectedProjectID: "project-a",
                primaryPaneID: "pane-a",
                secondaryPaneID: nil,
                drafts: ["pane-a": "host-a draft"]
            ),
            forServerID: "server-a"
        )

        let restored = try await cache.cachedState(forServerID: "server-b")
        XCTAssertNil(restored)
    }

    func testWhitespaceVariantServerIDsDoNotShareACacheRecord() async throws {
        let directoryURL = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directoryURL) }
        let cache = WorkspaceCache(baseDirectoryURL: directoryURL)
        let exact = makeCachedState(
            revision: 1,
            sequence: 1,
            selectedProjectID: "project-a",
            primaryPaneID: "pane-a",
            secondaryPaneID: nil,
            drafts: ["pane-a": "exact host"]
        )
        let spaced = makeCachedState(
            revision: 2,
            sequence: 2,
            selectedProjectID: "project-b",
            primaryPaneID: "pane-b",
            secondaryPaneID: nil,
            drafts: ["pane-b": "spaced host"],
            projectID: "project-b"
        )

        try await cache.save(exact, forServerID: "server-a")
        try await cache.save(spaced, forServerID: " server-a ")

        let exactRestored = try await cache.cachedState(forServerID: "server-a")
        let spacedRestored = try await cache.cachedState(forServerID: " server-a ")

        XCTAssertEqual(exactRestored, exact)
        XCTAssertEqual(spacedRestored, spaced)
    }

    func testRejectsTooManyDraftsExplicitlyAndKeepsPreviousCache() async throws {
        let directoryURL = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directoryURL) }
        let cache = WorkspaceCache(
            baseDirectoryURL: directoryURL,
            limits: WorkspaceCacheLimits(
                maxEncodedBytes: 8 * 1024,
                maxDraftCount: 1,
                maxDraftLength: 128
            )
        )
        let original = makeCachedState(
            revision: 1,
            sequence: 1,
            selectedProjectID: "project-a",
            primaryPaneID: "pane-a",
            secondaryPaneID: nil,
            drafts: ["pane-a": "echo ok"]
        )
        try await cache.save(original, forServerID: "server-a")

        do {
            try await cache.save(
                makeCachedState(
                    revision: 2,
                    sequence: 2,
                    selectedProjectID: "project-a",
                    primaryPaneID: "pane-a",
                    secondaryPaneID: "pane-b",
                    drafts: [
                        "pane-a": "echo ok",
                        "pane-b": "echo nope"
                    ]
                ),
                forServerID: "server-a"
            )
            XCTFail("Expected the cache to reject too many drafts")
        } catch {
            XCTAssertEqual(
                error as? WorkspaceCacheError,
                .tooManyDrafts(actualCount: 2, limit: 1)
            )
        }

        let restored = try await cache.cachedState(forServerID: "server-a")
        XCTAssertEqual(restored, original)
    }

    func testRejectsAnOversizedDraftExplicitlyAndKeepsPreviousCache() async throws {
        let directoryURL = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directoryURL) }
        let cache = WorkspaceCache(
            baseDirectoryURL: directoryURL,
            limits: WorkspaceCacheLimits(
                maxEncodedBytes: 8 * 1024,
                maxDraftCount: 4,
                maxDraftLength: 4
            )
        )
        let original = makeCachedState(
            revision: 1,
            sequence: 1,
            selectedProjectID: "project-a",
            primaryPaneID: "pane-a",
            secondaryPaneID: nil,
            drafts: ["pane-a": "ok"]
        )
        try await cache.save(original, forServerID: "server-a")

        do {
            try await cache.save(
                makeCachedState(
                    revision: 2,
                    sequence: 2,
                    selectedProjectID: "project-a",
                    primaryPaneID: "pane-a",
                    secondaryPaneID: nil,
                    drafts: ["pane-a": "print"]
                ),
                forServerID: "server-a"
            )
            XCTFail("Expected the cache to reject an oversized draft")
        } catch {
            XCTAssertEqual(
                error as? WorkspaceCacheError,
                .draftTooLong(paneID: "pane-a", actualLength: 5, limit: 4)
            )
        }

        let restored = try await cache.cachedState(forServerID: "server-a")
        XCTAssertEqual(restored, original)
    }

    func testRejectsAnOversizedCachePayloadExplicitlyAndKeepsPreviousCache() async throws {
        let directoryURL = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directoryURL) }
        let cache = WorkspaceCache(
            baseDirectoryURL: directoryURL,
            limits: WorkspaceCacheLimits(
                maxEncodedBytes: 900,
                maxDraftCount: 4,
                maxDraftLength: 64
            )
        )
        let original = makeCachedState(
            revision: 1,
            sequence: 1,
            selectedProjectID: "project-a",
            primaryPaneID: "pane-a",
            secondaryPaneID: nil,
            drafts: ["pane-a": "ok"]
        )
        try await cache.save(original, forServerID: "server-a")

        do {
            try await cache.save(
                makeCachedState(
                    revision: 2,
                    sequence: 2,
                    selectedProjectID: "project-a",
                    primaryPaneID: "pane-a",
                    secondaryPaneID: nil,
                    drafts: ["pane-a": "ok"],
                    projectTitle: String(repeating: "W", count: 400)
                ),
                forServerID: "server-a"
            )
            XCTFail("Expected the cache to reject an oversized payload")
        } catch let error as WorkspaceCacheError {
            guard case .cacheTooLarge = error else {
                return XCTFail("Expected cacheTooLarge, got \(error)")
            }
        }

        let restored = try await cache.cachedState(forServerID: "server-a")
        XCTAssertEqual(restored, original)
    }

    func testWritesCompleteUntilFirstAuthProtection() async throws {
        let directoryURL = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directoryURL) }
        let fileManager = RecordingWorkspaceCacheFileManager(baseDirectoryURL: directoryURL)
        let cache = WorkspaceCache(
            baseDirectoryURL: directoryURL,
            fileManager: fileManager
        )

        try await cache.save(
            makeCachedState(
                revision: 1,
                sequence: 1,
                selectedProjectID: "project-a",
                primaryPaneID: "pane-a",
                secondaryPaneID: nil,
                drafts: ["pane-a": "echo ok"]
            ),
            forServerID: "server-a"
        )

        XCTAssertEqual(fileManager.recordedDirectoryProtection, .completeUntilFirstUserAuthentication)
        XCTAssertEqual(fileManager.recordedFileProtection, .completeUntilFirstUserAuthentication)
    }

    func testReplacementFailureLeavesPreviousCacheIntact() async throws {
        let directoryURL = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directoryURL) }
        let fileManager = FaultingWorkspaceCacheFileManager(baseDirectoryURL: directoryURL)
        let cache = WorkspaceCache(
            baseDirectoryURL: directoryURL,
            fileManager: fileManager
        )
        let original = makeCachedState(
            revision: 1,
            sequence: 1,
            selectedProjectID: "project-a",
            primaryPaneID: "pane-a",
            secondaryPaneID: nil,
            drafts: ["pane-a": "echo ok"]
        )
        try await cache.save(original, forServerID: "server-a")
        fileManager.failNextReplace()

        do {
            try await cache.save(
                makeCachedState(
                    revision: 2,
                    sequence: 2,
                    selectedProjectID: "project-b",
                    primaryPaneID: "pane-b",
                    secondaryPaneID: nil,
                    drafts: ["pane-b": "echo later"]
                ),
                forServerID: "server-a"
            )
            XCTFail("Expected a replacement failure")
        } catch {
            XCTAssertEqual(error as? FaultingWorkspaceCacheFileManagerError, .replaceFailed)
        }

        let restored = try await cache.cachedState(forServerID: "server-a")
        XCTAssertEqual(restored, original)
        let tempFiles = try FileManager.default.contentsOfDirectory(
            at: directoryURL,
            includingPropertiesForKeys: nil
        ).filter { $0.lastPathComponent.hasSuffix(".tmp") }
        XCTAssertEqual(tempFiles, [])
    }

    func testCacheSchemaCannotRepresentCredentialsSourceBodiesOrTranscripts() async throws {
        let state = makeCachedState(
            revision: 1,
            sequence: 1,
            selectedProjectID: "project-a",
            primaryPaneID: "pane-a",
            secondaryPaneID: "pane-b",
            drafts: ["pane-a": "echo ok"]
        )

        let data = try JSONEncoder().encode(state)
        let payload = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        XCTAssertEqual(
            Set(payload.keys),
            Set([
                "workspace",
                "sequence",
                "lastConfirmedAt",
                "selectedProjectID",
                "primaryPaneID",
                "secondaryPaneID",
                "drafts"
            ])
        )
        let keys = collectKeys(in: payload)

        XCTAssertFalse(keys.contains("token"))
        XCTAssertFalse(keys.contains("clientId"))
        XCTAssertFalse(keys.contains("clientID"))
        XCTAssertFalse(keys.contains("content"))
        XCTAssertFalse(keys.contains("data"))
        XCTAssertFalse(keys.contains("diff"))
        XCTAssertFalse(keys.contains("transcript"))
    }

    private func makeCachedState(
        revision: Int,
        sequence: UInt64,
        selectedProjectID: String?,
        primaryPaneID: String?,
        secondaryPaneID: String?,
        drafts: [String: String],
        projectID: String = "project-a",
        projectTitle: String = "Alpha"
    ) -> CachedWorkspaceState {
        CachedWorkspaceState(
            workspace: WorkspaceSnapshot(
                revision: revision,
                projects: [
                    WorkspaceProjectSnapshot(
                        id: projectID,
                        root: "/repos/\(projectID)",
                        title: projectTitle,
                        worktrees: [
                            WorkspaceWorktreeSnapshot(
                                path: "/repos/\(projectID)",
                                head: "abc123",
                                branch: "main",
                                isMain: true,
                                detached: false,
                                bare: false,
                                locked: false,
                                lockReason: nil,
                                prunable: false,
                                pruneReason: nil,
                                dirty: false,
                                missing: false,
                                panes: drafts.keys.sorted().map {
                                    WorkspacePaneSnapshot(
                                        id: $0,
                                        cwd: "/repos/\(projectID)",
                                        title: $0,
                                        kind: "terminal",
                                        agent: nil,
                                        status: "working",
                                        needsAttention: false,
                                        lastActivity: "2026-09-10T10:47:56Z",
                                        recoverability: "recoverable"
                                    )
                                },
                                runningCount: drafts.count,
                                attentionCount: 0
                            )
                        ],
                        projectPanes: [],
                        runningCount: drafts.count,
                        attentionCount: 0
                    )
                ]
            ),
            sequence: sequence,
            lastConfirmedAt: Date(timeIntervalSince1970: 1_726_000_000),
            selectedProjectID: selectedProjectID,
            primaryPaneID: primaryPaneID,
            secondaryPaneID: secondaryPaneID,
            drafts: drafts
        )
    }

    private func makeHost(serverID: String, fingerprint: String) -> PairedHost {
        PairedHost(
            serverID: serverID,
            serverName: "Host \(serverID)",
            endpoint: HostEndpoint(
                host: "\(serverID).local",
                port: 4242,
                certificateFingerprint: fingerprint
            ),
            clientID: "client-\(serverID)",
            token: "token-\(serverID)"
        )
    }

    private func collectKeys(in value: Any) -> Set<String> {
        if let dictionary = value as? [String: Any] {
            return dictionary.reduce(into: Set(dictionary.keys)) { partialResult, entry in
                partialResult.formUnion(collectKeys(in: entry.value))
            }
        }
        if let array = value as? [Any] {
            return array.reduce(into: Set<String>()) { partialResult, element in
                partialResult.formUnion(collectKeys(in: element))
            }
        }
        return []
    }

    private func makeTemporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}

private enum FaultingWorkspaceCacheFileManagerError: Error, Equatable {
    case replaceFailed
}

private final class RecordingWorkspaceCacheFileManager: WorkspaceCacheFileManaging, @unchecked Sendable {
    private let baseDirectoryURL: URL
    private(set) var recordedDirectoryProtection: FileProtectionType?
    private(set) var recordedFileProtection: FileProtectionType?

    init(baseDirectoryURL: URL) {
        self.baseDirectoryURL = baseDirectoryURL
    }

    func applicationSupportDirectory() -> URL {
        baseDirectoryURL
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
        recordedDirectoryProtection = protection
        try FileManager.default.createDirectory(
            at: url,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: protection]
        )
    }

    func createFile(at url: URL, contents: Data, protection: FileProtectionType) throws {
        recordedFileProtection = protection
        let created = FileManager.default.createFile(
            atPath: url.path,
            contents: contents,
            attributes: [.protectionKey: protection]
        )
        XCTAssertTrue(created)
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

private final class FaultingWorkspaceCacheFileManager: WorkspaceCacheFileManaging, @unchecked Sendable {
    private let lock = NSLock()
    private let baseDirectoryURL: URL
    private var shouldFailNextReplace = false

    init(baseDirectoryURL: URL) {
        self.baseDirectoryURL = baseDirectoryURL
    }

    func failNextReplace() {
        lock.withLock {
            shouldFailNextReplace = true
        }
    }

    func applicationSupportDirectory() -> URL {
        baseDirectoryURL
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
        XCTAssertTrue(created)
    }

    func fileExists(at url: URL) throws -> Bool {
        FileManager.default.fileExists(atPath: url.path)
    }

    func moveItem(at sourceURL: URL, to destinationURL: URL) throws {
        try FileManager.default.moveItem(at: sourceURL, to: destinationURL)
    }

    func replaceItem(at originalURL: URL, withItemAt replacementURL: URL) throws {
        let shouldFail = lock.withLock {
            let result = shouldFailNextReplace
            shouldFailNextReplace = false
            return result
        }
        if shouldFail {
            throw FaultingWorkspaceCacheFileManagerError.replaceFailed
        }
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
