import SwiftUI
import UIKit

// MARK: - Floating button (SwiftUI)

public extension View {
    /// Overlays a floating chat button that opens the support chat.
    ///
    /// ```swift
    /// ContentView().teleDeskFloatingButton()
    /// ```
    func teleDeskFloatingButton(
        alignment: Alignment = .bottomTrailing,
        padding: CGFloat = 20,
        isHidden: Bool = false
    ) -> some View {
        modifier(FloatingButtonModifier(alignment: alignment, padding: padding, isHidden: isHidden))
    }
}

private struct FloatingButtonModifier: ViewModifier {
    let alignment: Alignment
    let padding: CGFloat
    let isHidden: Bool
    @State private var presented = false

    func body(content: Content) -> some View {
        content
            .overlay(alignment: alignment) {
                if !isHidden {
                    TeleDeskFloatingButton { presented = true }
                        .padding(padding)
                        .transition(.scale.combined(with: .opacity))
                }
            }
            .sheet(isPresented: $presented) {
                NavigationStack { TeleDeskChatView(showsCloseButton: true) }
            }
    }
}

/// The round chat button on its own, if you want to place it yourself.
public struct TeleDeskFloatingButton: View {
    @ObservedObject private var state = SupportState.shared
    private let action: () -> Void

    public init(action: @escaping () -> Void) {
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            Image(systemName: "bubble.left.fill")
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 56, height: 56)
                .background(Circle().fill(state.tint))
                .shadow(color: .black.opacity(0.18), radius: 12, y: 6)
                .overlay(alignment: .topTrailing) { UnreadBadge(count: state.unreadCount).offset(x: 2, y: -2) }
        }
        .buttonStyle(PressableStyle())
        .accessibilityLabel(state.unreadCount > 0 ? "Support chat, \(state.unreadCount) unread" : "Support chat")
        .onAppear { state.watch() }
        .onDisappear { state.unwatch() }
    }
}

// MARK: - Regular button

/// A regular button that opens the chat in a sheet. Style it like any SwiftUI button.
///
/// ```swift
/// TeleDeskButton()                                  // "Contact support"
/// TeleDeskButton("Help").buttonStyle(.borderedProminent)
/// TeleDeskButton { Label("Chat with us", systemImage: "bubble.left") }
/// ```
public struct TeleDeskButton<Label: View>: View {
    @State private var presented = false
    private let label: Label

    public init(@ViewBuilder label: () -> Label) {
        self.label = label()
    }

    public var body: some View {
        Button { presented = true } label: { label }
            .sheet(isPresented: $presented) {
                NavigationStack { TeleDeskChatView(showsCloseButton: true) }
            }
    }
}

public extension TeleDeskButton where Label == Text {
    init(_ title: String = "Contact support") {
        self.init { Text(title) }
    }
}

// MARK: - Settings row

/// A row for a settings `List`/`Form` with an icon, unread badge and chevron.
///
/// ```swift
/// Form {
///     Section("Help") { TeleDeskSupportRow() }
/// }
/// ```
/// Use `.push` (default) inside a `NavigationStack`, or `.sheet` to present modally.
public struct TeleDeskSupportRow: View {
    public enum Presentation { case push, sheet }

    @ObservedObject private var state = SupportState.shared
    @State private var presented = false
    private let title: String
    private let subtitle: String?
    private let systemImage: String
    private let presentation: Presentation

    public init(
        _ title: String = "Contact support",
        subtitle: String? = "We usually reply in minutes",
        systemImage: String = "bubble.left.and.bubble.right.fill",
        presentation: Presentation = .push
    ) {
        self.title = title
        self.subtitle = subtitle
        self.systemImage = systemImage
        self.presentation = presentation
    }

    public var body: some View {
        Group {
            switch presentation {
            case .push:
                NavigationLink { TeleDeskChatView() } label: { rowContent }
            case .sheet:
                Button { presented = true } label: {
                    HStack {
                        rowContent
                        Image(systemName: "chevron.right")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                }
                .foregroundStyle(.primary)
                .sheet(isPresented: $presented) {
                    NavigationStack { TeleDeskChatView(showsCloseButton: true) }
                }
            }
        }
        .onAppear { state.watch() }
        .onDisappear { state.unwatch() }
    }

    private var rowContent: some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 29, height: 29)
                .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(state.tint))
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                if let subtitle {
                    Text(subtitle).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            UnreadBadge(count: state.unreadCount)
        }
    }
}

// MARK: - UIKit floating button

public extension TeleDesk {
    enum FloatingPosition { case bottomTrailing, bottomLeading }

    /// Adds a floating chat button on top of your app's key window (UIKit apps).
    static func showFloatingButton(position: FloatingPosition = .bottomTrailing, inset: CGFloat = 20) {
        hideFloatingButton()
        guard let window = keyWindow else { return }
        let host = UIHostingController(rootView: TeleDeskFloatingButton { TeleDesk.presentFromTop() })
        host.view.backgroundColor = .clear
        host.view.translatesAutoresizingMaskIntoConstraints = false
        window.addSubview(host.view)
        let guide = window.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            host.view.widthAnchor.constraint(equalToConstant: 64),
            host.view.heightAnchor.constraint(equalToConstant: 64),
            host.view.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -inset + 4),
            position == .bottomTrailing
                ? host.view.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -inset + 4)
                : host.view.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: inset - 4),
        ])
        floatingHost = host
    }

    static func hideFloatingButton() {
        floatingHost?.view.removeFromSuperview()
        floatingHost = nil
    }

    /// Unread agent replies (updated while a TeleDesk entry point is on screen).
    static var unreadCount: Int { SupportState.shared.unreadCount }

    internal static var floatingHost: UIViewController?

    internal static var keyWindow: UIWindow? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow }
    }

    internal static func presentFromTop() {
        var top = keyWindow?.rootViewController
        while let next = top?.presentedViewController { top = next }
        if let top { present(from: top) }
    }
}

// MARK: - Shared bits

struct UnreadBadge: View {
    let count: Int

    var body: some View {
        if count > 0 {
            Text(count > 9 ? "9+" : "\(count)")
                .font(.caption2.weight(.bold))
                .foregroundStyle(.white)
                .padding(.horizontal, 6)
                .frame(minWidth: 20, minHeight: 20)
                .background(Capsule().fill(Color.red))
        }
    }
}

private struct PressableStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.92 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}
