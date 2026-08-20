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
    @Published private(set) var activePairHostModel: PairHostModel?

    let workspaceStore: WorkspaceStore
    /// `nil` under a fixture launch — that absence is what makes the fixture
    /// root incapable of talking to a host.
    let composition: MobileAppComposition?
    let fixtureName: String?
    /// Owns the at-most-two attached terminals for whichever root is running.
    let terminalRegistry: TerminalSessionRegistry
    let paneComposerSendAttempts = PaneComposerSendAttempts()

    private var hasStarted = false
    private let pairHostModelFactory: @MainActor () -> PairHostModel
    private var pairHostCleanupTask: Task<Void, Never>?

    var isFixture: Bool { fixtureName != nil }

    convenience init(composition: MobileAppComposition) {
        self.init(
            composition: composition,
            pairHostModelFactory: { PairHostModel(composition: composition) }
        )
    }

    init(
        composition: MobileAppComposition,
        pairHostModelFactory: @escaping @MainActor () -> PairHostModel
    ) {
        self.composition = composition
        fixtureName = nil
        workspaceStore = composition.workspaceStore
        terminalRegistry = composition.terminalRegistry
        self.pairHostModelFactory = pairHostModelFactory
    }

    private init(
        fixtureName: String,
        fixtureSendFails: Bool,
        fixtureInspectionFails: Bool
    ) {
        let workspaceStore = DemoStore.makeWorkspaceStore(
            fixture: fixtureName,
            inspectionFails: fixtureInspectionFails
        )
        let terminalRegistry = TerminalSessionRegistry(
            client: FixtureTerminalClient(sendFails: fixtureSendFails)
        )
        terminalRegistry.start()

        self.fixtureName = fixtureName
        composition = nil
        self.workspaceStore = workspaceStore
        self.terminalRegistry = terminalRegistry
        pairHostModelFactory = { PairHostModel.fixture() }
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

    func beginPairHostFlow() async -> PairHostModel {
        if let pairHostCleanupTask {
            await pairHostCleanupTask.value
        }
        if let activePairHostModel {
            return activePairHostModel
        }

        let model = pairHostModelFactory()
        activePairHostModel = model
        return model
    }

    func endPairHostFlow(_ model: PairHostModel) async {
        guard activePairHostModel === model else { return }
        if let pairHostCleanupTask {
            await pairHostCleanupTask.value
            return
        }

        let cleanupTask = Task { [weak self] in
            await model.stop()
            await MainActor.run {
                guard let self else { return }
                if self.activePairHostModel === model {
                    self.activePairHostModel = nil
                }
                self.pairHostCleanupTask = nil
            }
        }
        pairHostCleanupTask = cleanupTask
        await cleanupTask.value
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
