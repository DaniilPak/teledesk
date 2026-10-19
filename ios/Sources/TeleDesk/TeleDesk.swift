import SwiftUI
import UIKit

/// Entry point for the TeleDesk SDK.
///
/// ```swift
/// TeleDesk.configure(publicKey: "pk_...", apiURL: URL(string: "https://xyz.execute-api.ap-southeast-2.amazonaws.com")!)
/// TeleDesk.identify(name: "Jane", email: "jane@example.com")
/// TeleDesk.present(from: viewController)   // UIKit
/// TeleDeskChatView()                        // SwiftUI
/// ```
@MainActor
public enum TeleDesk {
    static var configuration: Configuration?
    static var identity = Identity()

    public struct Configuration: Sendable {
        public var publicKey: String
        public var apiURL: URL
        /// Overrides the brand color set in the dashboard.
        public var tintColor: Color?
        /// Seconds between polls while the chat is visible.
        public var pollInterval: TimeInterval

        public init(publicKey: String, apiURL: URL, tintColor: Color? = nil, pollInterval: TimeInterval = 3) {
            self.publicKey = publicKey
            self.apiURL = apiURL
            self.tintColor = tintColor
            self.pollInterval = pollInterval
        }
    }

    public struct Identity: Sendable {
        public var name: String?
        public var email: String?
        public var meta: [String: String] = [:]
    }

    /// Call once at app launch.
    public static func configure(publicKey: String, apiURL: URL, tintColor: Color? = nil) {
        configuration = Configuration(publicKey: publicKey, apiURL: apiURL, tintColor: tintColor)
    }

    public static func configure(_ configuration: Configuration) {
        self.configuration = configuration
    }

    /// Attach customer details to tickets (shown to you in Telegram).
    public static func identify(name: String? = nil, email: String? = nil, meta: [String: String] = [:]) {
        identity.name = name ?? identity.name
        identity.email = email ?? identity.email
        identity.meta.merge(meta) { _, new in new }
    }

    /// Forget the current visitor (e.g. on logout). The next message starts a fresh conversation.
    public static func reset() {
        identity = Identity()
        VisitorStore.reset()
        SupportState.shared.reset()
    }

    static func makeClient() -> APIClient? {
        guard let cfg = configuration else { return nil }
        return APIClient(baseURL: cfg.apiURL, publicKey: cfg.publicKey, visitorId: VisitorStore.visitorId)
    }

    /// A ready-to-present UIKit controller wrapping the chat.
    public static func makeViewController() -> UIViewController {
        let host = UIHostingController(rootView: NavigationStack { TeleDeskChatView(showsCloseButton: true) })
        host.modalPresentationStyle = .pageSheet
        if let sheet = host.sheetPresentationController {
            sheet.detents = [.large()]
            sheet.prefersGrabberVisible = true
        }
        return host
    }

    /// Presents the chat modally.
    public static func present(from presenter: UIViewController, animated: Bool = true) {
        presenter.present(makeViewController(), animated: animated)
    }

    static var defaultMeta: [String: String] {
        let info = Bundle.main.infoDictionary ?? [:]
        var meta: [String: String] = [
            "platform": "iOS \(UIDevice.current.systemVersion)",
            "device": deviceModel,
        ]
        if let v = info["CFBundleShortVersionString"] as? String {
            meta["app"] = "\(v) (\(info["CFBundleVersion"] as? String ?? "?"))"
        }
        return meta.merging(identity.meta) { _, new in new }
    }

    private static var deviceModel: String {
        var sys = utsname()
        uname(&sys)
        return withUnsafeBytes(of: &sys.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
    }
}

enum VisitorStore {
    private static let key = "teledesk.visitorId"

    static var visitorId: String {
        if let id = UserDefaults.standard.string(forKey: key) { return id }
        var bytes = [UInt8](repeating: 0, count: 18)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let id = "v_" + bytes.map { String(format: "%02x", $0) }.joined()
        UserDefaults.standard.set(id, forKey: key)
        return id
    }

    static func reset() {
        UserDefaults.standard.removeObject(forKey: key)
    }
}
