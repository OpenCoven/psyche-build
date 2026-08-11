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
    /// `nil` under a fixture launch — that absence is what makes the fixture
    /// root incapable of talking to a host.
    let composition: MobileAppComposition?
    let fixtureName: String?
    /// Owns the at-most-two attached terminals for whichever root is running.
    let terminalRegistry: TerminalSessionRegistry
    let paneComposerSendAttempts = PaneComposerSendAttempts()

    private var hasStarted = false

    var isFixture: Bool { fixtureName != nil }

    init(fixture: String? = nil, fixtureSendFails: Bool = false) {
        fixtureName = fixture

        guard let fixture else {
            let composition = MobileAppComposition.production()
            self.composition = composition
            workspaceStore = composition.workspaceStore
            terminalRegistry = composition.terminalRegistry
            return
        }

        composition = nil
        workspaceStore = DemoStore.makeWorkspaceStore(fixture: fixture)
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
        hostName = name
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

    func start() async {
        guard !hasStarted else { return }
        hasStarted = true
        guard let composition else { return }

        await composition.start()

        // Read the stored identity rather than waiting on a welcome: it is
        // what auto-connect just used, and it lets Settings and VoiceOver name
        // the host even when the connection has not come up.
        if let paired = try? await composition.pairedHostStore.hosts().first {
            hostName = paired.serverName
        }

        let state = await composition.connectionManager.state
        if case let .failed(reason) = state {
            connectionError = reason
        }
    }
}
