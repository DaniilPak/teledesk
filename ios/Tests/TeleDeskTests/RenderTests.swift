import XCTest
import SwiftUI
@testable import TeleDesk

/// Renders entry points to PNGs when TELEDESK_SNAPSHOT_DIR is set (visual check, no assertions on pixels).
@MainActor
final class RenderTests: XCTestCase {
    func testRenderEntryPoints() throws {
        TeleDesk.configure(publicKey: "pk_test", apiURL: URL(string: "http://localhost:8787")!)
        // ImageRenderer can't draw UIKit-backed containers (Form, NavigationStack), so lay out plainly.
        let view = VStack(alignment: .leading, spacing: 16) {
            TeleDeskSupportRow(presentation: .sheet)
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color(.secondarySystemGroupedBackground)))
            TeleDeskButton("Report a problem").buttonStyle(.borderedProminent)
            TeleDeskButton { Label("Chat with us", systemImage: "bubble.left") }.buttonStyle(.bordered)
            Spacer()
        }
        .padding(16)
        .frame(width: 390, height: 360)
        .background(Color(.systemGroupedBackground))
        .teleDeskFloatingButton()

        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.uiImage)
        XCTAssertGreaterThan(image.size.width, 0)
        if let dir = ProcessInfo.processInfo.environment["TELEDESK_SNAPSHOT_DIR"] {
            try image.pngData()?.write(to: URL(fileURLWithPath: dir).appendingPathComponent("entry-points.png"))
        }
    }

    func testMarkReadOnlyMovesForward() {
        let state = SupportState.shared
        state.reset()
        state.markRead(upTo: "MSG#000000000000002#00000000")
        state.markRead(upTo: "MSG#000000000000001#00000000")
        XCTAssertEqual(UserDefaults.standard.string(forKey: "teledesk.lastRead"), "MSG#000000000000002#00000000")
        state.reset()
    }
}
