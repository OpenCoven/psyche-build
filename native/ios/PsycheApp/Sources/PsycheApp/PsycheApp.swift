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
            configuredCockpit
        }
    }

    @ViewBuilder
    private var configuredCockpit: some View {
        let content = CockpitView()
            .environmentObject(model)
            .environmentObject(model.workspaceStore)
            .environmentObject(model.remoteActionStore)
            .environmentObject(model.terminalRegistry)
            .preferredColorScheme(.dark)
            .task {
                await model.start()
            }

        if let dynamicTypeSize = Self.dynamicTypeSize(in: ProcessInfo.processInfo.arguments) {
            content.environment(\.dynamicTypeSize, dynamicTypeSize)
        } else {
            content
        }
    }

    private static func dynamicTypeSize(in arguments: [String]) -> DynamicTypeSize? {
        guard let index = arguments.firstIndex(of: "-uiDynamicTypeSize"),
              arguments.indices.contains(index + 1)
        else {
            return nil
        }
        switch arguments[index + 1] {
        case "accessibility1": return .accessibility1
        case "accessibility2": return .accessibility2
        case "accessibility3": return .accessibility3
        case "accessibility4": return .accessibility4
        case "accessibility5": return .accessibility5
        default: return nil
        }
    }
}
