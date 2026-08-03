import SwiftUI

@main
struct PsycheApp: App {
    @StateObject private var store = DemoStore()

    var body: some Scene {
        WindowGroup {
            CockpitView()
                .environmentObject(store)
                .preferredColorScheme(.dark)
        }
    }
}
