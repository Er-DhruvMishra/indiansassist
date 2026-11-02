import SwiftUI

/// Phase F section 17.4: the iOS app. Two entries: **Get help** (share this screen, view only, through the ReplayKit
/// broadcast extension) and **Give help** (the mobile Assist console in an in-app Safari view).
@main
struct IndiansAssistApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            HomeView()
                .environmentObject(model)
                .onOpenURL { model.open(url: $0) }
        }
    }
}
