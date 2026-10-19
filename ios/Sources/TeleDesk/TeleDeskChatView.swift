import SwiftUI

/// Minimal support chat. Embed it in a sheet or push it in a NavigationStack.
public struct TeleDeskChatView: View {
    @StateObject private var model = ChatViewModel()
    @Environment(\.dismiss) private var dismiss
    @FocusState private var inputFocused: Bool
    private let showsCloseButton: Bool

    public init(showsCloseButton: Bool = false) {
        self.showsCloseButton = showsCloseButton
    }

    private var tint: Color {
        TeleDesk.configuration?.tintColor ?? Color(hex: model.remote?.color) ?? .primary
    }

    public var body: some View {
        VStack(spacing: 0) {
            messageList
            if let error = model.errorText {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .padding(.horizontal)
                    .padding(.top, 6)
            }
            composer
        }
        .background(Color(.systemGroupedBackground).opacity(0.5))
        .navigationTitle(model.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(model.title).font(.headline)
                    HStack(spacing: 5) {
                        Circle().fill(model.isOnline ? Color.green : Color.gray.opacity(0.5)).frame(width: 6, height: 6)
                        Text(model.isOnline ? "Usually replies in minutes" : "Leave a message")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            if showsCloseButton {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark").font(.subheadline.weight(.semibold))
                    }
                    .tint(.secondary)
                    .accessibilityLabel("Close")
                }
            }
        }
        .onAppear { model.start() }
        .onDisappear { model.stop() }
    }

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    if let greeting = model.greeting, !greeting.isEmpty {
                        Bubble(text: greeting, isMine: false, tint: tint)
                    }
                    ForEach(Array(model.messages.enumerated()), id: \.element.id) { index, message in
                        row(message, previous: index > 0 ? model.messages[index - 1] : nil)
                            .id(message.id)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: model.messages.count) { _ in
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
        }
    }

    @ViewBuilder
    private func row(_ message: ChatMessage, previous: ChatMessage?) -> some View {
        switch message.from {
        case .system:
            Text(message.text)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
        case .agent:
            VStack(alignment: .leading, spacing: 2) {
                if previous?.from != .agent, let name = message.agentName {
                    Text(name).font(.caption2).foregroundStyle(.secondary).padding(.leading, 4).padding(.top, 4)
                }
                Bubble(text: message.text, isMine: false, tint: tint)
            }
        case .visitor:
            Bubble(text: message.text, isMine: true, tint: tint)
                .opacity(message.isPending ? 0.55 : 1)
        }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message", text: $model.draft, axis: .vertical)
                .lineLimit(1...5)
                .focused($inputFocused)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .stroke(Color(.separator), lineWidth: 1)
                )
                .submitLabel(.send)
                .onSubmit(model.send)

            Button(action: model.send) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(Color(.systemBackground))
                    .frame(width: 36, height: 36)
                    .background(Circle().fill(tint))
            }
            .disabled(!model.canSend)
            .opacity(model.canSend ? 1 : 0.35)
            .accessibilityLabel("Send")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }
}

private struct Bubble: View {
    let text: String
    let isMine: Bool
    let tint: Color

    var body: some View {
        HStack {
            if isMine { Spacer(minLength: 48) }
            Text(text)
                .font(.body)
                .foregroundStyle(isMine ? Color(.systemBackground) : Color.primary)
                .padding(.horizontal, 13)
                .padding(.vertical, 9)
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(isMine ? tint : Color(.secondarySystemGroupedBackground))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .stroke(isMine ? Color.clear : Color(.separator).opacity(0.5), lineWidth: 0.5)
                )
                .textSelection(.enabled)
            if !isMine { Spacer(minLength: 48) }
        }
    }
}

extension Color {
    init?(hex: String?) {
        guard let hex, hex.hasPrefix("#"), hex.count == 7, let v = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        self.init(
            red: Double((v >> 16) & 0xFF) / 255,
            green: Double((v >> 8) & 0xFF) / 255,
            blue: Double(v & 0xFF) / 255
        )
    }
}
