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

    private var hasStarted = false
    private var cachedWorkspaceHostID: String?
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

        do {
            guard let selectedHost = try await pairedHostStore.selectedHost() else {
                cachedWorkspaceHostID = nil
                workspaceCacheError = nil
                return
            }
            cachedWorkspaceHostID = selectedHost.serverID
            if let cachedState = try await workspaceCache.cachedState(
                forServerID: selectedHost.serverID
            ) {
                workspaceStore.restoreCachedState(cachedState)
            }
            workspaceCacheError = nil
        } catch {
            workspaceCacheError = error.localizedDescription
        }
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

        if let committedHostID = hostReadiness.committedHost?.serverID {
            cachedWorkspaceHostID = committedHostID
        }
        guard let cachedWorkspaceHostID else { return }
        guard hostReadiness.state != .authenticating,
              hostReadiness.state != .synchronizing else {
            return
        }

        do {
            if let cachedState = workspaceStore.cachedState() {
                try await workspaceCache.save(cachedState, forServerID: cachedWorkspaceHostID)
            } else {
                try await workspaceCache.removeCachedState(forServerID: cachedWorkspaceHostID)
            }
            workspaceCacheError = nil
        } catch {
            workspaceCacheError = error.localizedDescription
        }
    }
}
