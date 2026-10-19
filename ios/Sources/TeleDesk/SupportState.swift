import SwiftUI

/// Shared state for entry points (floating button, settings row): brand color and unread replies.
@MainActor
final class SupportState: ObservableObject {
    static let shared = SupportState()

    @Published private(set) var unreadCount = 0
    @Published private(set) var remote: RemoteConfig?

    private static let lastReadKey = "teledesk.lastRead"
    private var lastRead: String? {
        get { UserDefaults.standard.string(forKey: Self.lastReadKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.lastReadKey) }
    }

    private var watchers = 0
    private var task: Task<Void, Never>?
    /// True while the chat screen is on screen; replies are read immediately.
    var chatVisible = false { didSet { if chatVisible { unreadCount = 0 } } }

    var tint: Color {
        TeleDesk.configuration?.tintColor ?? Color(hex: remote?.color) ?? .accentColor
    }

    func update(remote: RemoteConfig) { self.remote = remote }

    /// Entry points call this on appear/disappear; polling runs only while something is visible.
    func watch() {
        watchers += 1
        guard task == nil, let client = TeleDesk.makeClient() else { return }
        task = Task { [weak self] in
            if self?.remote == nil, let cfg = try? await client.config() { self?.remote = cfg }
            while !Task.isCancelled {
                await self?.checkUnread(client)
                try? await Task.sleep(nanoseconds: 30 * 1_000_000_000)
            }
        }
    }

    func unwatch() {
        watchers = max(0, watchers - 1)
        if watchers == 0 {
            task?.cancel()
            task = nil
        }
    }

    func markRead(upTo id: String?) {
        guard let id, id > (lastRead ?? "") else { return }
        lastRead = id
        unreadCount = 0
    }

    func bumpUnread() { unreadCount += 1 }

    func reset() {
        lastRead = nil
        unreadCount = 0
    }

    private func checkUnread(_ client: APIClient) async {
        guard !chatVisible, let messages = try? await client.messages(after: lastRead) else { return }
        let floor = lastRead ?? ""
        unreadCount = messages.filter { $0.from != .visitor && $0.id > floor }.count
    }
}
