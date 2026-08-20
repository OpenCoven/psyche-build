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
    @Published private(set) var hostDiscriminator: String?

    let workspaceStore: WorkspaceStore
    /// `nil` under a fixture launch — that absence is what makes the fixture
    /// root incapable of talking to a host.
    let composition: MobileAppComposition?
    let fixtureName: String?
    /// Owns the at-most-two attached terminals for whichever root is running.
    let terminalRegistry: TerminalSessionRegistry
    let paneComposerSendAttempts = PaneComposerSendAttempts()

    private var hasStarted = false
    private let pairHostSessionAuthority = PairHostModel.SessionAuthority()

    var isFixture: Bool { fixtureName != nil }

    init(composition: MobileAppComposition) {
        fixtureName = nil
        self.composition = composition
        workspaceStore = composition.workspaceStore
        terminalRegistry = composition.terminalRegistry
    }

    private init(
        fixtureName: String,
        fixtureSendFails: Bool,
        fixtureInspectionFails: Bool
    ) {
        self.fixtureName = fixtureName
        composition = nil
        workspaceStore = DemoStore.makeWorkspaceStore(
            fixture: fixtureName,
            inspectionFails: fixtureInspectionFails
        )
        terminalRegistry = TerminalSessionRegistry(
            client: FixtureTerminalClient(sendFails: fixtureSendFails)
        )
        terminalRegistry.start()
        hostName = Self.fixtureHostName
        hostDiscriminator = nil
    }

    convenience init(
        fixture: String? = nil,
        fixtureSendFails: Bool = false,
        fixtureInspectionFails: Bool = false
    ) {
        if let fixture {
            self.init(
                fixtureName: fixture,
                fixtureSendFails: fixtureSendFails,
                fixtureInspectionFails: fixtureInspectionFails
            )
        } else {
            self.init(composition: MobileAppComposition.production())
        }
    }

    /// Fixed so UI tests can assert host context without a paired record.
    static let fixtureHostName = "psyche-demo.local"

    func recordConnectedHost(_ host: PairedHost) {
        hostName = host.serverName
        hostDiscriminator = PairHostDiscriminatorFormatter.format(host: host)
        connectionError = nil
    }

    func makePairHostModel() -> PairHostModel {
        if let composition {
            return PairHostModel(composition: composition, authority: pairHostSessionAuthority)
        }
        return PairHostModel.fixture(authority: pairHostSessionAuthority)
    }

    func loadLastConnectedHostContext() async {
        guard let composition,
              let host = try? await composition.pairedHostStore.lastConnectedHost() else {
            return
        }
        hostName = host.serverName
        hostDiscriminator = PairHostDiscriminatorFormatter.format(host: host)
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
        await loadLastConnectedHostContext()

        let state = await composition.connectionManager.state
        if case let .failed(reason) = state {
            connectionError = reason
        }
    }
}
