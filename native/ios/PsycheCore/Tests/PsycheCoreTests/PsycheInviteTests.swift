import Foundation
import XCTest
@testable import PsycheCore

final class PsycheInviteTests: XCTestCase {
    /// Mirrors the desktop Open on phone URL shape without coupling this
    /// target to desktop runtime code.
    func testParsesDesktopEmittedPsycheConnectIntoANormalizedEndpoint() throws {
        let invite = try XCTUnwrap(PsycheInvite.parse(URL(string:
            "psyche://connect?host=wss%3A%2F%2FStudio.EXAMPLE.%3A4242&fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&psyche_invite=one-time-token"
        )!))

        XCTAssertEqual(invite.endpoint.host, "studio.example")
        XCTAssertEqual(invite.endpoint.port, 4242)
        XCTAssertEqual(
            invite.endpoint.certificateFingerprint,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        )
        XCTAssertEqual(invite.token, "one-time-token")
    }

    func testParsesHTTPSConnectEquivalent() throws {
        let invite = try XCTUnwrap(PsycheInvite(url: URL(string:
            "https://psyche.opencoven.ai/connect?host=https%3A%2F%2Frelay.example&fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&psyche_invite=one-time-token"
        )!))

        XCTAssertEqual(invite.endpoint.host, "relay.example")
        XCTAssertEqual(invite.endpoint.port, 443)
    }

    func testRejectsMissingOrEmptyInviteToken() {
        XCTAssertNil(PsycheInvite(url: URL(string: "psyche://connect?host=wss%3A%2F%2Fstudio.example%3A4242")!))
        XCTAssertNil(PsycheInvite(url: URL(string: "psyche://connect?host=wss%3A%2F%2Fstudio.example%3A4242&fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&psyche_invite=%20%20")!))
    }

    func testRequiresOneValidFingerprintAndNormalizesIt() throws {
        let fingerprint = String(repeating: "ab", count: 32)
        let valid = try XCTUnwrap(PsycheInvite(url: URL(string:
            "psyche://connect?host=wss%3A%2F%2Fstudio.example&fingerprint=\(Array(repeating: "AB", count: 32).joined(separator: ":"))&psyche_invite=token"
        )!))
        XCTAssertEqual(valid.endpoint.certificateFingerprint, fingerprint)
        XCTAssertNil(PsycheInvite(url: URL(string: "psyche://connect?host=wss%3A%2F%2Fstudio.example&psyche_invite=token")!))
        XCTAssertNil(PsycheInvite(url: URL(string: "psyche://connect?host=wss%3A%2F%2Fstudio.example&fingerprint=nope&psyche_invite=token")!))
        XCTAssertNil(PsycheInvite(url: URL(string: "psyche://connect?host=wss%3A%2F%2Fstudio.example&fingerprint=\(fingerprint)&fingerprint=\(fingerprint)&psyche_invite=token")!))
    }

    func testRejectsCovenCaveAndWrongRouteLinks() {
        XCTAssertNil(PsycheInvite(url: URL(string: "coven://connect?host=wss%3A%2F%2Fstudio.example%3A4242&fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&psyche_invite=token")!))
        XCTAssertNil(PsycheInvite(url: URL(string: "https://cave.opencoven.ai/connect?host=wss%3A%2F%2Fstudio.example%3A4242&fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&psyche_invite=token")!))
        XCTAssertNil(PsycheInvite(url: URL(string: "psyche://invite?host=wss%3A%2F%2Fstudio.example%3A4242&fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&psyche_invite=token")!))
        XCTAssertNil(PsycheInvite(url: URL(string: "https://psyche.opencoven.ai/invite?host=wss%3A%2F%2Fstudio.example%3A4242&fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&psyche_invite=token")!))
    }

    func testRejectsMalformedEndpointValues() {
        XCTAssertNil(PsycheInvite(url: URL(string: "psyche://connect?host=not-a-url&fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&psyche_invite=token")!))
        XCTAssertNil(PsycheInvite(url: URL(string: "psyche://connect?host=wss%3A%2F%2Fuser%40studio.example&fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&psyche_invite=token")!))
        XCTAssertNil(PsycheInvite(url: URL(string: "psyche://connect?host=ws%3A%2F%2Fstudio.example&fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&psyche_invite=token")!))
    }
}
