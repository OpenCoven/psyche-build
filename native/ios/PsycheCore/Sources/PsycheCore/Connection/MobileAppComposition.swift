import Combine
import Foundation

@MainActor
public final class MobileAppComposition: ObservableObject {
    public let transport: any PsycheTransport
    public let requestClient: ControlRequestClient
    public let workspaceStore: WorkspaceStore
    public let pairedHostStore: PairedHostStore
    public let connectionManager: ConnectionManager

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
        connectionManager = ConnectionManager(
            transport: transport,
            workspaceStore: workspaceStore,
            requestClient: requestClient,
            pairedHostStore: pairedHostStore,
            clientID: clientID,
            clientName: clientName
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
        await connectionManager.connectToStoredHost()
    }
}
