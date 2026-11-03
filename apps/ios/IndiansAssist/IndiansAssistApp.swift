import IASession
import SwiftUI
import UIKit
import UserNotifications

/// Phase F section 17.4: the iOS app. Two entries: **Get help** (share this screen, view only, through the ReplayKit
/// broadcast extension) and **Give help** (the mobile Assist console in an in-app Safari view).
@main
struct IndiansAssistApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            HomeView()
                .environmentObject(model)
                .onOpenURL { model.open(url: $0) }
        }
    }
}

/// The file-offer notification's Save and Decline (C §6.1 F4 on iOS): the answer goes to the App Group, where the
/// broadcast extension holding the transfer reads it. Neither action brings the app forward; tapping the notification
/// itself opens the app, whose Get help screen shows the same choice.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let center = UNUserNotificationCenter.current()
        let save = UNNotificationAction(identifier: FileOfferNotification.saveAction, title: "Save")
        let decline = UNNotificationAction(identifier: FileOfferNotification.declineAction, title: "Decline", options: [.destructive])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: FileOfferNotification.category, actions: [save, decline], intentIdentifiers: []),
        ])
        center.delegate = self
        return true
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        defer { completionHandler() }
        let info = response.notification.request.content.userInfo
        guard response.notification.request.content.categoryIdentifier == FileOfferNotification.category,
              let id = (info[FileOfferNotification.fileIdKey] as? NSNumber)?.int64Value else { return }
        switch response.actionIdentifier {
        case FileOfferNotification.saveAction: try? FileAnswerStore.appGroup()?.answer(fileId: id, accept: true)
        case FileOfferNotification.declineAction: try? FileAnswerStore.appGroup()?.answer(fileId: id, accept: false)
        default: break // tapped: the app opens; Get help shows the offer
        }
    }

    /// While the app is in front, the offer is shown in Get help, so the banner is shown too but without a sound.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list])
    }
}
