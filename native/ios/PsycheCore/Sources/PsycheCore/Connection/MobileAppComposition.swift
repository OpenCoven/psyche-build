import Combine
import Foundation

@MainActor
public final class MobileAppComposition: ObservableObject {
    public let transport: any PsycheTransport
    public let requestClient: ControlRequestClient
    public let workspaceStore: WorkspaceStore
    public let pairedHostStore: PairedHostStore
    public let mobileCredentialStore: MobileCredentialStore
    public let connectionManager: ConnectionManager
    public let terminalRegistry: TerminalSessionRegistry

    private var hasStarted = false

    public init(
        transport: any PsycheTransport,
        pairedHostStore: PairedHostStore,
        mobileCredentialStore: MobileCredentialStore = MobileCredentialStore(),
        clientID: String = UUID().uuidString,
        clientName: String = "Psyche iOS"
    ) {
        self.transport = transport
        self.pairedHostStore = pairedHostStore
        self.mobileCredentialStore = mobileCredentialStore

        let requestClient = ControlRequestClient(transport: transport)
        let workspaceStore = WorkspaceStore(controlRequests: requestClient)
        self.requestClient = requestClient
        self.workspaceStore = workspaceStore
        connectionManager = ConnectionManager(
            transport: transport,
            workspaceStore: workspaceStore,
            requestClient: requestClient,
            pairedHostStore: pairedHostStore,
            mobileCredentialStore: mobileCredentialStore,
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
            pairedHostStore: PairedHostStore(secureStore: KeychainSecureStore()),
            mobileCredentialStore: MobileCredentialStore()
        )
    }

    public func start(reconnectToStoredHost: Bool = true) async {
        guard !hasStarted else { return }
        hasStarted = true
        terminalRegistry.start()
        if reconnectToStoredHost {
            await connectionManager.connectToStoredHost()
        }
    }
}
