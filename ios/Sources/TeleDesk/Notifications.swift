import UIKit
import UserNotifications

public extension TeleDesk {
    enum PushEnvironment: Sendable {
        /// Sandbox for Simulator and development-signed builds, production for TestFlight / App Store.
        case automatic, sandbox, production
    }

    /// Asks for notification permission and registers with APNs. Call when it makes sense in your
    /// onboarding (e.g. after the customer sends their first message). Returns whether it was granted.
    @discardableResult
    static func requestPushAuthorization(options: UNAuthorizationOptions = [.alert, .sound, .badge]) async -> Bool {
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: options)) ?? false
        if granted { UIApplication.shared.registerForRemoteNotifications() }
        return granted
    }

    /// Prompts while the customer hasn't decided yet; once allowed, re-registers so the token stays current.
    internal static func requestPushIfUndecided() async {
        switch await UNUserNotificationCenter.current().notificationSettings().authorizationStatus {
        case .notDetermined: await requestPushAuthorization()
        case .authorized, .provisional, .ephemeral: UIApplication.shared.registerForRemoteNotifications()
        default: break
        }
    }

    /// Forward the token from `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)`.
    static func setDeviceToken(_ deviceToken: Data, environment: PushEnvironment = .automatic) {
        PushRegistration.store(token: deviceToken.map { String(format: "%02x", $0) }.joined(), environment: environment)
        PushRegistration.syncStoredToken()
    }

    /// True when the notification was sent by TeleDesk (a support reply).
    nonisolated static func isTeleDeskNotification(_ userInfo: [AnyHashable: Any]) -> Bool {
        userInfo["teledesk"] != nil
    }

    /// For your `userNotificationCenter(_:willPresent:)`: returns the options for TeleDesk replies
    /// (silent while the chat is on screen), or `nil` if the notification isn't from TeleDesk.
    static func presentationOptions(for notification: UNNotification) -> UNNotificationPresentationOptions? {
        guard isTeleDeskNotification(notification.request.content.userInfo) else { return nil }
        if SupportState.shared.chatVisible { return [] }
        SupportState.shared.bumpUnread()
        return [.banner, .list, .sound]
    }

    /// For your `userNotificationCenter(_:didReceive:)`: opens the chat when a TeleDesk reply was tapped.
    /// Returns `false` if the notification isn't from TeleDesk.
    @discardableResult
    static func handleNotificationResponse(_ response: UNNotificationResponse) -> Bool {
        guard isTeleDeskNotification(response.notification.request.content.userInfo) else { return false }
        if !SupportState.shared.chatVisible { presentFromTop() }
        return true
    }

    /// A ready-made delegate if your app doesn't have its own:
    /// `UNUserNotificationCenter.current().delegate = TeleDesk.notificationDelegate`
    static let notificationDelegate: UNUserNotificationCenterDelegate = TeleDeskNotificationDelegate()
}

final class TeleDeskNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        Task { @MainActor in
            completionHandler(TeleDesk.presentationOptions(for: notification) ?? [.banner, .list, .sound])
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        Task { @MainActor in
            TeleDesk.handleNotificationResponse(response)
            completionHandler()
        }
    }
}

@MainActor
enum PushRegistration {
    private static let tokenKey = "teledesk.apnsToken"
    private static let envKey = "teledesk.apnsEnv"
    private static let sentKey = "teledesk.apnsSent" // "<visitorId>:<token>" last registered

    static func store(token: String, environment: TeleDesk.PushEnvironment) {
        UserDefaults.standard.set(token, forKey: tokenKey)
        UserDefaults.standard.set(resolve(environment), forKey: envKey)
    }

    /// Registers the stored token for the current visitor once per (visitor, token) pair.
    static func syncStoredToken() {
        guard let token = UserDefaults.standard.string(forKey: tokenKey),
              let env = UserDefaults.standard.string(forKey: envKey),
              let client = TeleDesk.makeClient() else { return }
        let marker = "\(client.visitorId):\(token)"
        guard UserDefaults.standard.string(forKey: sentKey) != marker else { return }
        Task {
            if (try? await client.registerDevice(token: token, environment: env)) != nil {
                UserDefaults.standard.set(marker, forKey: sentKey)
            }
        }
    }

    /// After `TeleDesk.reset()`: stop pushes for the old visitor, register the device for the new one.
    static func visitorChanged(previous: APIClient?) {
        UserDefaults.standard.removeObject(forKey: sentKey)
        if let previous { Task { try? await previous.unregisterDevice() } }
        syncStoredToken()
    }

    private static func resolve(_ environment: TeleDesk.PushEnvironment) -> String {
        switch environment {
        case .sandbox: return "sandbox"
        case .production: return "production"
        case .automatic:
            #if targetEnvironment(simulator)
            return "sandbox"
            #else
            return provisioningAPSEnvironment() ?? "production"
            #endif
        }
    }

    /// Development / ad-hoc builds embed a provisioning profile with `aps-environment`;
    /// App Store and TestFlight builds don't (and always use production).
    private static func provisioningAPSEnvironment() -> String? {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .isoLatin1),
              let start = text.range(of: "<plist"),
              let end = text.range(of: "</plist>"),
              let plistData = String(text[start.lowerBound..<end.upperBound]).data(using: .isoLatin1),
              let plist = try? PropertyListSerialization.propertyList(from: plistData, format: nil) as? [String: Any],
              let entitlements = plist["Entitlements"] as? [String: Any],
              let aps = entitlements["aps-environment"] as? String else { return nil }
        return aps == "development" ? "sandbox" : "production"
    }
}
