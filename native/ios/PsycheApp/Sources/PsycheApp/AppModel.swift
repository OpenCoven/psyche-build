import Combine
import Foundation
import PsycheCore

/// The app's composition root.
///
/// Two roots, one of which is chosen once at launch: production builds the
/// single shared transport/request/store graph and reconnects to the stored
/// host, while a `-uiFixture` launch composes deterministic state in memory.
/// The fixture root never constructs a transport or a Keychain store, so a UI
/// test cannot reach the network or the device keychain no matter what it taps.
@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var connectionError: String?
    /// Which host the state on screen came from. Rows read it for VoiceOver,
    /// where the host is not otherwise recoverable from the visible text.
    @Published private(set) var hostName: String?

    let workspaceStore: WorkspaceStore
    /// Shared host-owned action state. Fixture roots receive a disconnected
    /// store so UI previews can exercise the state surface without a socket.
    let remoteActionStore: RemoteActionStore
    /// `nil` under a fixture launch — that absence is what makes the fixture
    /// root incapable of talking to a host.
    let composition: MobileAppComposition?
    let fixtureName: String?
    /// Owns the at-most-two attached terminals for whichever root is running.
    let terminalRegistry: TerminalSessionRegistry
    let paneComposerSendAttempts = PaneComposerSendAttempts()

    private var hasStarted = false
    private var hostContextRefreshGeneration: UInt64 = 0
    private var subscriptions = Set<AnyCancellable>()

    var isFixture: Bool { fixtureName != nil }

    init(
        fixture: String? = nil,
        fixtureSendFails: Bool = false,
        fixtureInspectionFails: Bool = false,
        productionComposition: MobileAppComposition? = nil
    ) {
        fixtureName = fixture

        guard let fixture else {
            let composition = productionComposition ?? MobileAppComposition.production()
            self.composition = composition
            workspaceStore = composition.workspaceStore
            remoteActionStore = composition.remoteActionStore
            terminalRegistry = composition.terminalRegistry
            bindHostContextUpdates()
            return
        }

        composition = nil
        workspaceStore = DemoStore.makeWorkspaceStore(
            fixture: fixture,
            inspectionFails: fixtureInspectionFails
        )
        remoteActionStore = RemoteActionStore()
        // A fixture terminal client, so the fixture shell renders real output
        // through the real registry without opening a socket.
        terminalRegistry = TerminalSessionRegistry(
            client: FixtureTerminalClient(sendFails: fixtureSendFails)
        )
        terminalRegistry.start()
        hostName = Self.fixtureHostName
    }

    /// Fixed so UI tests can assert host context without a paired record.
    static let fixtureHostName = "psyche-demo.local"

    func recordPairedHostName(_ name: String) {
        guard composition != nil else {
            hostName = name
            return
        }
        Task { await refreshHostContext() }
    }

    /// Reads the launch arguments once so the decision cannot drift between
    /// the scene and whatever else asks later.
    static func fixtureName(in arguments: [String]) -> String? {
        guard let flag = arguments.firstIndex(of: "-uiFixture"),
              arguments.indices.contains(flag + 1) else {
            return nil
        }
        let name = arguments[flag + 1]
        return name.isEmpty ? nil : name
    }

    static func fixtureSendFails(in arguments: [String]) -> Bool {
        arguments.contains("-uiTerminalSendFailure")
    }

    static func fixtureInspectionFails(in arguments: [String]) -> Bool {
        arguments.contains("-uiInspectionFailure")
    }

    func start() async {
        guard !hasStarted else { return }
        hasStarted = true
        guard let composition else { return }

        await composition.start()
        await refreshHostContext()

        let state = await composition.connectionManager.state
        if case let .failed(reason) = state {
            connectionError = reason
        }
    }

    private func bindHostContextUpdates() {
        workspaceStore.objectWillChange
            .sink { [weak self] in
                Task { @MainActor [weak self] in
                    await self?.refreshHostContext()
                }
            }
            .store(in: &subscriptions)

        composition?.hostReadiness.objectWillChange
            .sink { [weak self] in
                Task { @MainActor [weak self] in
                    await self?.refreshHostContext()
                }
            }
            .store(in: &subscriptions)
    }

    private func refreshHostContext() async {
        guard let composition else { return }
        hostContextRefreshGeneration &+= 1
        let refreshGeneration = hostContextRefreshGeneration

        let presentationHostID: String?
        switch composition.hostReadiness.presentation {
        case .live(let hostID, _), .stale(let hostID, _):
            presentationHostID = hostID
        case .noState:
            presentationHostID = nil
        }

        let resolvedHostName: String?
        if let presentationHostID {
            resolvedHostName = try? await composition.pairedHostStore.host(
                withServerID: presentationHostID
            )?.serverName
        } else {
            let connectionState = await composition.connectionManager.state
            if case .connected = connectionState,
               let committedHost = composition.hostReadiness.committedHost {
                resolvedHostName = committedHost.serverName
            } else {
                resolvedHostName = try? await composition.pairedHostStore
                    .selectedHost()?.serverName
            }
        }

        guard refreshGeneration == hostContextRefreshGeneration else { return }
        hostName = resolvedHostName
    }
}
