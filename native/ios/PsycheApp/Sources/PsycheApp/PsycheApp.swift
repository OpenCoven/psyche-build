import PsycheCore
import SwiftUI

@main
struct PsycheApp: App {
    @StateObject private var model: AppModel

    init() {
        let arguments = ProcessInfo.processInfo.arguments
        let fixture = AppModel.fixtureName(in: arguments)
        _model = StateObject(wrappedValue: AppModel(
            fixture: fixture,
            fixtureSendFails: AppModel.fixtureSendFails(in: arguments),
            fixtureInspectionFails: AppModel.fixtureInspectionFails(in: arguments)
        ))
    }

    var body: some Scene {
        WindowGroup {
            CockpitView()
                .environmentObject(model)
                .environmentObject(model.workspaceStore)
                .environmentObject(model.remoteActionStore)
                .environmentObject(model.terminalRegistry)
                .preferredColorScheme(.dark)
                .task {
                    await model.start()
                }
        }
    }
}
