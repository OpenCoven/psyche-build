import Foundation
import XCTest
@testable import PsycheCore

final class PsycheInviteTests: XCTestCase {
    func testParsesPsycheConnectIntoANormalizedEndpoint() throws {
        let invite = try XCTUnwrap(PsycheInvite(url: URL(string:
            "psyche://connect?endpoint=wss%3A%2F%2FStudio.EXAMPLE.%3A4242&psyche_invite=one-time-token"
        )!))

        XCTAssertEqual(invite.endpoint.host, "studio.example")
        XCTAssertEqual(invite.endpoint.port, 4242)
        XCTAssertEqual(invite.token, "one-time-token")
    }

    func testParsesHTTPSConnectEquivalent() throws {
        let invite = try XCTUnwrap(PsycheInvite(url: URL(string:
            "https://psyche.opencoven.ai/connect?endpoint=https%3A%2F%2Frelay.example&psyche_invite=one-time-token"
        )!))

        XCTAssertEqual(invite.endpoint.host, "relay.example")
        XCTAssertEqual(invite.endpoint.port, 443)
    }

    func testRejectsMissingOrEmptyInviteToken() {
        XCTAssertNil(PsycheInvite(url: URL(string: "psyche://connect?endpoint=wss%3A%2F%2Fstudio.example%3A4242")!))
        XCTAssertNil(PsycheInvite(url: URL(string: "psyche://connect?endpoint=wss%3A%2F%2Fstudio.example%3A4242&psyche_invite=%20%20")!))
    }

    func testRejectsCovenCaveAndWrongRouteLinks() {
        XCTAssertNil(PsycheInvite(url: URL(string: "coven://connect?endpoint=wss%3A%2F%2Fstudio.example%3A4242&psyche_invite=token")!))
        XCTAssertNil(PsycheInvite(url: URL(string: "https://cave.opencoven.ai/connect?endpoint=wss%3A%2F%2Fstudio.example%3A4242&psyche_invite=token")!))
        XCTAssertNil(PsycheInvite(url: URL(string: "psyche://invite?endpoint=wss%3A%2F%2Fstudio.example%3A4242&psyche_invite=token")!))
        XCTAssertNil(PsycheInvite(url: URL(string: "https://psyche.opencoven.ai/invite?endpoint=wss%3A%2F%2Fstudio.example%3A4242&psyche_invite=token")!))
    }

    func testRejectsMalformedEndpointValues() {
        XCTAssertNil(PsycheInvite(url: URL(string: "psyche://connect?endpoint=not-a-url&psyche_invite=token")!))
        XCTAssertNil(PsycheInvite(url: URL(string: "psyche://connect?endpoint=wss%3A%2F%2Fuser%40studio.example&psyche_invite=token")!))
        XCTAssertNil(PsycheInvite(url: URL(string: "psyche://connect?endpoint=ws%3A%2F%2Fstudio.example&psyche_invite=token")!))
    }
}
