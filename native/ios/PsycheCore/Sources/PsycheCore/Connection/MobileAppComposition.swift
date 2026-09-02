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

    private var hasStarted = false

    public init(
        transport: any PsycheTransport,
        pairedHostStore: PairedHostStore,
        clientID: String = UUID().uuidString,
        clientName: String = "Psyche iOS"
    ) {
        self.transport = transport
        self.pairedHostStore = pairedHostStore

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
    }

    public static func production() -> MobileAppComposition {
        MobileAppComposition(
            transport: URLSessionControlTransport(),
            pairedHostStore: PairedHostStore(secureStore: KeychainSecureStore())
        )
    }

    public func start() async {
        guard !hasStarted else { return }
        hasStarted = true
        terminalRegistry.start()
        await connectionManager.connectToStoredHost()
    }
}
