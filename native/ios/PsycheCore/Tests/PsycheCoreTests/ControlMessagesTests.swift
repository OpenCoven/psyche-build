import XCTest
@testable import PsycheCore

final class ControlMessagesTests: XCTestCase {
    func testDecodesWorkspaceSnapshotRequest() throws {
        let message = try JSONDecoder().decode(
            MobileClientMessage.self,
            from: Data(#"{"type":"control","payload":{"type":"workspace.snapshot","requestId":"workspace-1"}}"#.utf8)
        )

        guard case let .control(.workspaceSnapshot(request)) = message else {
            return XCTFail("Expected workspace snapshot control request")
        }
        XCTAssertEqual(request.requestID, "workspace-1")
    }

    func testDecodesWorkspaceChangedFixture() throws {
        let fixtures = try loadMobileControlFixtures()
        let data = try XCTUnwrap(fixtures["workspaceChanged"])
        let message = try JSONDecoder().decode(MobileServerMessage.self, from: data)

        guard case let .workspaceChanged(event) = message else {
            return XCTFail("Expected workspaceChanged event")
        }
        XCTAssertEqual(event.revision, 42)
        XCTAssertEqual(event.sequence, 7)
        XCTAssertEqual(event.workspace.projects.first?.id, "project-1")
    }

    func testDecodesCustomPaneSpawnAndAttachRequests() throws {
        let fixtures = try loadMobileControlFixtures()

        let spawnData = try XCTUnwrap(fixtures["spawnAgentPane"])
        let spawnMessage = try JSONDecoder().decode(MobileClientMessage.self, from: spawnData)
        guard case let .control(.spawnPane(request)) = spawnMessage else {
            return XCTFail("Expected panes.spawn control request")
        }
        XCTAssertEqual(request.kind, .agent)
        XCTAssertEqual(request.projectID, "/repo")
        XCTAssertEqual(request.idempotencyKey, "spawn-agent-1")
        XCTAssertEqual(request.agent, "coven-code")
        XCTAssertEqual(request.title, "Implement mobile cockpit")
        XCTAssertEqual(request.prompt, "Add the paired protocol-v3 control envelope.")

        let attachData = try XCTUnwrap(fixtures["attachAgentPane"])
        let attachMessage = try JSONDecoder().decode(MobileClientMessage.self, from: attachData)
        guard case let .control(.attachPane(attach)) = attachMessage else {
            return XCTFail("Expected panes.attach control request")
        }
        XCTAssertEqual(attach.id, "%3")
        XCTAssertEqual(attach.columns, 100)
        XCTAssertEqual(attach.rows, 32)
        XCTAssertEqual(attach.sinceSequence, 12)
    }

    func testUnknownControlResponsesDecodeWithoutFailingTheStream() throws {
        let message = try JSONDecoder().decode(
            MobileServerMessage.self,
            from: Data(#"{"type":"control","payload":{"type":"future.result","requestId":"req-9"}}"#.utf8)
        )

        guard case let .control(.unknown(response)) = message else {
            return XCTFail("Expected unknown control response")
        }
        XCTAssertEqual(response.type, "future.result")
        XCTAssertEqual(response.requestID, "req-9")
    }

    private func loadMobileControlFixtures() throws -> [String: Data] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("protocol-fixtures/mobile-control.json")
        let raw = try Data(contentsOf: url)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: raw) as? [String: Any])
        return try object.mapValues { try JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys]) }
    }
}
