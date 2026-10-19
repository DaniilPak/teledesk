import XCTest
import SwiftUI
@testable import TeleDesk

final class TeleDeskTests: XCTestCase {
    func testDecodesServerMessage() throws {
        let json = #"{"messages":[{"id":"MSG#000001700000000#abcd1234","from":"agent","text":"Hi","ticket":1,"agentName":"Ann","createdAt":"2026-01-01T00:00:00.000Z"}]}"#
        struct R: Decodable { var messages: [ChatMessage] }
        let r = try JSONDecoder().decode(R.self, from: Data(json.utf8))
        XCTAssertEqual(r.messages.first?.from, .agent)
        XCTAssertEqual(r.messages.first?.agentName, "Ann")
        XCTAssertFalse(r.messages[0].isPending)
    }

    func testHexColor() {
        XCTAssertNotNil(Color(hex: "#112233"))
        XCTAssertNil(Color(hex: "112233"))
        XCTAssertNil(Color(hex: nil))
    }

    @MainActor
    func testVisitorIdIsStable() {
        VisitorStore.reset()
        let a = VisitorStore.visitorId
        XCTAssertEqual(a, VisitorStore.visitorId)
        XCTAssertTrue(a.hasPrefix("v_") && a.count == 38)
    }
}
