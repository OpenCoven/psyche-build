import Combine
import Foundation

@MainActor
public final class MobileAppComposition: ObservableObject {
    public let transport: any PsycheTransport
    public let requestClient: ControlRequestClient
    public let workspaceStore: WorkspaceStore
    /// The single host-action state machine shared by every native action
    /// surface. It uses the same request client as the workspace store so an
    /// action cannot silently switch transports or lose its session state.
    public let remoteActionStore: RemoteActionStore
    public let pairedHostStore: PairedHostStore
    /// The atomic host-readiness authority for this app. It is created here so
    /// every surface observes the same readiness state and the same
    /// live/stale workspace presentation the connection publishes.
    public let hostReadiness: HostReadinessMachine
    public let connectionManager: ConnectionManager
    public let terminalRegistry: TerminalSessionRegistry
    public let workspaceCache: WorkspaceCache?
    @Published public private(set) var workspaceCacheError: String?
    @Published public private(set) var workspaceCacheRecoveryNotice: String?

    private var hasStarted = false
    private var cachedWorkspaceHostID: String?
    private var cacheOperationGeneration: UInt64 = 0
    private var recoveryNoticeDismissed = false
    private var subscriptions = Set<AnyCancellable>()

    public init(
        transport: any PsycheTransport,
        pairedHostStore: PairedHostStore,
        workspaceCache: WorkspaceCache? = nil,
        clientID: String = UUID().uuidString,
        clientName: String = "Psyche iOS"
    ) {
        self.transport = transport
        self.pairedHostStore = pairedHostStore
        self.workspaceCache = workspaceCache

        let requestClient = ControlRequestClient(transport: transport)
        let workspaceStore = WorkspaceStore(controlRequests: requestClient)
        self.requestClient = requestClient
        self.workspaceStore = workspaceStore
        remoteActionStore = RemoteActionStore(controlRequests: requestClient)
        let hostReadiness = HostReadinessMachine(
            pairedHostStore: pairedHostStore,
            workspaceStore: workspaceStore
        )
        self.hostReadiness = hostReadiness
        connectionManager = ConnectionManager(
            transport: transport,
            workspaceStore: workspaceStore,
            requestClient: requestClient,
            pairedHostStore: pairedHostStore,
            hostReadiness: hostReadiness,
            clientID: clientID,
            clientName: clientName
        )
        terminalRegistry = TerminalSessionRegistry(
            client: TerminalControlClient(requests: requestClient, transport: transport)
        )
        bindWorkspaceCachePersistence()
    }

    public static func production() -> MobileAppComposition {
        MobileAppComposition(
            transport: URLSessionControlTransport(),
            pairedHostStore: PairedHostStore(secureStore: KeychainSecureStore()),
            workspaceCache: WorkspaceCache()
        )
    }

    public func start() async {
        guard !hasStarted else { return }
        hasStarted = true
        terminalRegistry.start()
        await restorePersistedWorkspaceIfAvailable()
        await connectionManager.connectToStoredHost()
    }

    func restorePersistedWorkspaceIfAvailable() async {
        guard let workspaceCache else { return }
        cacheOperationGeneration &+= 1
        let generation = cacheOperationGeneration

        do {
            let preserved = try await workspaceCache.hasPreservedRecoveryRecords()
            guard generation == cacheOperationGeneration else { return }
            if preserved { workspaceCacheRecoveryNotice = WorkspaceCache.recoveryNotice }
            guard let selectedHost = try await pairedHostStore.selectedHost() else {
                cachedWorkspaceHostID = nil
                return
            }
            cachedWorkspaceHostID = selectedHost.serverID
            let cachedState = try await workspaceCache.cachedState(
                forServerID: selectedHost.serverID
            )
            let stillSelected = try await pairedHostStore.selectedHost()?.serverID
            guard generation == cacheOperationGeneration,
                  stillSelected == selectedHost.serverID,
                  hostReadiness.committedHost == nil else { return }
            if let cachedState {
                workspaceStore.restoreCachedState(cachedState)
                workspaceCacheError = nil
            }
        } catch {
            guard generation == cacheOperationGeneration else { return }
            workspaceCacheError = Self.cacheErrorMessage(error, reading: true)
        }
    }

    public func dismissWorkspaceCacheRecoveryNotice() {
        // Dismissal changes presentation only; it never removes preserved data.
        recoveryNoticeDismissed = true
        workspaceCacheRecoveryNotice = nil
    }

    public func retryWorkspaceCachePersistence() async {
        await persistWorkspaceCacheIfPossible()
    }

    private func bindWorkspaceCachePersistence() {
        guard workspaceCache != nil else { return }

        workspaceStore.objectWillChange
            .sink { [weak self] _ in
                self?.scheduleWorkspaceCachePersistence()
            }
            .store(in: &subscriptions)

        hostReadiness.objectWillChange
            .sink { [weak self] _ in
                self?.scheduleWorkspaceCachePersistence()
            }
            .store(in: &subscriptions)
    }

    private func scheduleWorkspaceCachePersistence() {
        Task { @MainActor [weak self] in
            await self?.persistWorkspaceCacheIfPossible()
        }
    }

    private func persistWorkspaceCacheIfPossible() async {
        guard let workspaceCache else { return }
        guard let hostID = currentWorkspaceCacheHostID(),
              let cachedState = workspaceStore.cachedState() else { return }
        guard hostReadiness.state != .authenticating,
              hostReadiness.state != .synchronizing else {
            return
        }
        cacheOperationGeneration &+= 1
        let generation = cacheOperationGeneration
        let canRecover = !workspaceStore.isStale && hostReadiness.committedHost?.serverID == hostID

        do {
            let recovered = try await workspaceCache.save(
                cachedState, forServerID: hostID, recoverIfNeeded: canRecover
            )
            // Preservation concerns the shared file, not one host. A later
            // save must not hide an earlier verified recovery in the same burst.
            if recovered {
                recoveryNoticeDismissed = false
                workspaceCacheRecoveryNotice = WorkspaceCache.recoveryNotice
            }
            guard generation == cacheOperationGeneration,
                  currentWorkspaceCacheHostID() == hostID else { return }
            // Earlier writes in a burst may have performed recovery. Consult the
            // durable preservation records before reporting the latest success.
            let preserved = try await workspaceCache.hasPreservedRecoveryRecords()
            guard generation == cacheOperationGeneration,
                  currentWorkspaceCacheHostID() == hostID else { return }
            if preserved && !recoveryNoticeDismissed {
                workspaceCacheRecoveryNotice = WorkspaceCache.recoveryNotice
            }
            workspaceCacheError = nil
        } catch {
            guard generation == cacheOperationGeneration,
                  currentWorkspaceCacheHostID() == hostID else { return }
            workspaceCacheError = Self.cacheErrorMessage(error, reading: false)
        }
    }

    private func currentWorkspaceCacheHostID() -> String? {
        switch hostReadiness.presentation {
        case .live(let hostID, _), .stale(let hostID, _):
            guard hostReadiness.committedHost?.serverID == hostID else { return nil }
            return hostID
        case .noState:
            guard hostReadiness.committedHost == nil ||
                    hostReadiness.committedHost?.serverID == cachedWorkspaceHostID else { return nil }
            return cachedWorkspaceHostID
        }
    }

    private static func cacheErrorMessage(_ error: Error, reading: Bool) -> String {
        if let cacheError = error as? WorkspaceCacheError {
            return cacheError.localizedDescription
        }
        return (reading
            ? WorkspaceCacheError.unreadableRecord("")
            : WorkspaceCacheError.unwritableRecord("")).localizedDescription
    }
}
