import SwiftUI

@MainActor
final class ChatViewModel: ObservableObject {
    @Published private(set) var messages: [ChatMessage] = []
    @Published private(set) var remote: RemoteConfig?
    @Published var draft = ""
    @Published var errorText: String?

    private let client: APIClient?
    private let pollInterval: TimeInterval
    private var cursor: String?
    private var pollTask: Task<Void, Never>?

    init() {
        if let cfg = TeleDesk.configuration {
            client = TeleDesk.makeClient()
            pollInterval = cfg.pollInterval
            remote = SupportState.shared.remote
        } else {
            client = nil
            pollInterval = 3
            errorText = "TeleDesk.configure(publicKey:apiURL:) was not called."
        }
    }

    var title: String { remote?.name ?? "Support" }
    var greeting: String? { remote?.greeting }
    var isOnline: Bool { remote?.online ?? false }
    var canSend: Bool { client != nil && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    func start() {
        SupportState.shared.chatVisible = true
        if TeleDesk.configuration?.requestsPushOnChatOpen == true {
            Task { await TeleDesk.requestPushIfUndecided() }
        }
        guard let client, pollTask == nil else { return }
        pollTask = Task { [weak self] in
            if let cfg = try? await client.config() {
                self?.remote = cfg
                SupportState.shared.update(remote: cfg)
            }
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(nanoseconds: UInt64((self?.pollInterval ?? 3) * 1_000_000_000))
            }
        }
    }

    func stop() {
        SupportState.shared.chatVisible = false
        pollTask?.cancel()
        pollTask = nil
    }

    func refresh() async {
        guard let client else { return }
        do {
            ingest(try await client.messages(after: cursor))
        } catch {
            // Transient network errors are retried on the next poll.
        }
    }

    func send() {
        guard let client else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        let pending = ChatMessage(id: "pending-\(UUID().uuidString)", from: .visitor, text: text, isPending: true)
        messages.append(pending)
        let identity = TeleDesk.identity
        let meta = TeleDesk.defaultMeta
        Task {
            do {
                let sent = try await client.send(text: text, name: identity.name, email: identity.email, meta: meta)
                messages.removeAll { $0.id == pending.id }
                ingest([sent])
                errorText = nil
            } catch {
                messages.removeAll { $0.id == pending.id }
                draft = text
                errorText = error.localizedDescription
            }
        }
    }

    private func ingest(_ incoming: [ChatMessage]) {
        let known = Set(messages.map(\.id))
        let fresh = incoming.filter { !known.contains($0.id) }
        guard !fresh.isEmpty else { return }
        messages.append(contentsOf: fresh)
        // Server ids are sortable; keep pending messages at the end.
        messages.sort { a, b in
            if a.isPending != b.isPending { return !a.isPending }
            return a.id < b.id
        }
        if let last = fresh.map(\.id).max(), last > (cursor ?? "") { cursor = last }
        SupportState.shared.markRead(upTo: cursor)
    }
}
