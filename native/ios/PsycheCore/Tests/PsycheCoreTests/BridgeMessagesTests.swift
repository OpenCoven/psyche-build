import XCTest
@testable import PsycheCore

final class BridgeMessagesTests: XCTestCase {
    func testDecodesWelcome() throws {
        let message = try decode(#"{"type":"welcome","payload":{"serverId":"host-1","serverName":"Studio Mac","protocolVersion":2,"projectName":"psyche-build"}}"#)

        guard case let .welcome(payload) = message else {
            return XCTFail("Expected welcome")
        }
        XCTAssertEqual(payload.serverID, "host-1")
        XCTAssertEqual(payload.serverName, "Studio Mac")
        XCTAssertEqual(payload.protocolVersion, 2)
    }

    func testDecodesPaneList() throws {
        let message = try decode(#"{"type":"paneList","payload":[{"id":"pane-1","displayName":"iOS cockpit","kind":"agent","projectId":"project-1","projectName":"psyche-build","worktreePath":"/repo","agent":"Copilot","status":"working"}]}"#)

        guard case let .paneList(panes) = message else {
            return XCTFail("Expected pane list")
        }
        XCTAssertEqual(panes.first?.projectID, "project-1")
        XCTAssertEqual(panes.first?.status, .working)
    }

    func testDecodesPaneOutput() throws {
        let message = try decode(#"{"type":"paneOutput","payload":{"paneId":"pane-1","data":"aGVsbG8=","seq":42}}"#)

        guard case let .paneOutput(payload) = message else {
            return XCTFail("Expected pane output")
        }
        XCTAssertEqual(payload.paneID, "pane-1")
        XCTAssertEqual(payload.data, "aGVsbG8=")
        XCTAssertEqual(payload.seq, 42)
    }

    func testDecodesPairAccepted() throws {
        let message = try decode(#"{"type":"pairAccepted","payload":{"token":"paired-token"}}"#)

        guard case let .pairAccepted(payload) = message else {
            return XCTFail("Expected pair accepted")
        }
        XCTAssertEqual(payload.token, "paired-token")
    }

    func testDecodesError() throws {
        let message = try decode(#"{"type":"error","payload":{"code":"unauthorized","message":"Pair first"}}"#)

        guard case let .error(error) = message else {
            return XCTFail("Expected protocol error")
        }
        XCTAssertEqual(error.code, "unauthorized")
        XCTAssertEqual(error.message, "Pair first")
    }

    private func decode(_ json: String) throws -> ServerMessage {
        try ServerMessage.decode(from: Data(json.utf8))
    }
}
