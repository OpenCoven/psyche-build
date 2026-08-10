import PsycheCore
import SwiftUI

@main
struct PsycheApp: App {
    @StateObject private var store = DemoStore()
    @StateObject private var liveComposition = MobileAppComposition.production()

    var body: some Scene {
        WindowGroup {
            CockpitView()
                .environmentObject(store)
                .preferredColorScheme(.dark)
                .task {
                    await liveComposition.start()
                }
        }
    }
}
