import PsycheCore
import SwiftUI

@main
struct PsycheApp: App {
    @StateObject private var model: AppModel

    init() {
        let fixture = AppModel.fixtureName(in: ProcessInfo.processInfo.arguments)
        _model = StateObject(wrappedValue: AppModel(fixture: fixture))
    }

    var body: some Scene {
        WindowGroup {
            CockpitView()
                .environmentObject(model)
                .environmentObject(model.workspaceStore)
                .preferredColorScheme(.dark)
                .task {
                    await model.start()
                }
        }
    }
}
