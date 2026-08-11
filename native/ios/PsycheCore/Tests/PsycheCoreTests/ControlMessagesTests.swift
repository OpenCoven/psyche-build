import XCTest
@testable import PsycheCore

final class ControlMessagesTests: XCTestCase {
    func testEncodesWorkspaceSnapshotRequestWithCanonicalDiscriminator() throws {
        let message = MobileClientMessage.control(makeWorkspaceSnapshotRequest(requestID: "workspace-1"))
        let object = try encodedJSONObject(of: message)

        XCTAssertEqual(object["type"] as? String, "control")
        XCTAssertEqual(payload(from: object)["type"] as? String, "workspace.snapshot")
        XCTAssertEqual(payload(from: object)["requestId"] as? String, "workspace-1")
    }

    func testEncodesKillPaneRequestWithCanonicalDiscriminator() throws {
        let message = MobileClientMessage.control(makeKillPaneRequest(requestID: "kill-1", paneID: "%3"))
        let object = try encodedJSONObject(of: message)

        XCTAssertEqual(object["type"] as? String, "control")
        XCTAssertEqual(payload(from: object)["type"] as? String, "panes.kill")
        XCTAssertEqual(payload(from: object)["requestId"] as? String, "kill-1")
        XCTAssertEqual(payload(from: object)["id"] as? String, "%3")
    }

    func testWorkspaceSnapshotCaseOverridesDiscriminatorDecodedIntoPayload() throws {
        let decodedPayload = try JSONDecoder().decode(
            ControlRequestIDOnly.self,
            from: Data(#"{"type":"panes.kill","requestId":"workspace-2"}"#.utf8)
        )
        let message = MobileClientMessage.control(.workspaceSnapshot(decodedPayload))
        let object = try encodedJSONObject(of: message)

        XCTAssertEqual(payload(from: object)["type"] as? String, "workspace.snapshot")
        XCTAssertEqual(payload(from: object)["requestId"] as? String, "workspace-2")
    }

    func testKillPaneCaseOverridesDiscriminatorDecodedIntoPayload() throws {
        let decodedPayload = try JSONDecoder().decode(
            PaneIDControlRequest.self,
            from: Data(#"{"type":"workspace.snapshot","requestId":"kill-2","id":"%4"}"#.utf8)
        )
        let message = MobileClientMessage.control(.killPane(decodedPayload))
        let object = try encodedJSONObject(of: message)

        XCTAssertEqual(payload(from: object)["type"] as? String, "panes.kill")
        XCTAssertEqual(payload(from: object)["requestId"] as? String, "kill-2")
        XCTAssertEqual(payload(from: object)["id"] as? String, "%4")
    }

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

    func testRawKillPaneDiscriminatorDecodesAndRoundTripsAsKillPane() throws {
        let raw = Data(
            #"{"type":"control","payload":{"type":"panes.kill","requestId":"kill-3","id":"%5"}}"#.utf8
        )
        let message = try JSONDecoder().decode(MobileClientMessage.self, from: raw)

        guard case let .control(.killPane(request)) = message else {
            return XCTFail("Expected panes.kill to select the killPane case")
        }
        XCTAssertEqual(request.requestID, "kill-3")
        XCTAssertEqual(request.paneID, "%5")

        let object = try encodedJSONObject(of: message)
        XCTAssertEqual(payload(from: object)["type"] as? String, "panes.kill")
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

    func testUnknownControlRequestsDecodeWithoutFailingTheStream() throws {
        let message = try JSONDecoder().decode(
            MobileClientMessage.self,
            from: Data(#"{"type":"control","payload":{"type":"future.request","requestId":"req-10"}}"#.utf8)
        )

        guard case let .control(.unknown(request)) = message else {
            return XCTFail("Expected unknown control request")
        }
        XCTAssertEqual(request.type, "future.request")
        XCTAssertEqual(request.requestID, "req-10")
    }

    func testEverySupportedMobileControlRequestFixtureDecodesToTypedCase() throws {
        let fixtures = try loadMobileControlFixtures()

        for requestType in MobileControlRequest.supportedTypeNames {
            let fixture = try XCTUnwrap(
                fixtures.first(where: { entry in
                    guard let type = controlPayloadType(in: entry.value) else { return false }
                    return type == requestType
                }),
                "Missing fixture for supported request type \(requestType)"
            )
            let request = try decodeRequestFixture(fixture.key, fixtures: fixtures)
            if case .unknown = request {
                XCTFail("Supported request fixture \(fixture.key) decoded as .unknown")
            }
        }
    }

    func testEverySupportedMobileControlResponseFixtureDecodesToTypedCase() throws {
        let fixtures = try loadMobileControlFixtures()

        for responseType in MobileControlResponse.supportedTypeNames {
            let fixture = try XCTUnwrap(
                fixtures.first(where: { entry in
                    guard let type = controlPayloadType(in: entry.value) else { return false }
                    return type == responseType
                }),
                "Missing fixture for supported response type \(responseType)"
            )
            let response = try decodeResponseFixture(fixture.key, fixtures: fixtures)
            if case .unknown = response {
                XCTFail("Supported response fixture \(fixture.key) decoded as .unknown")
            }
        }
    }

    func testSupportedCanonicalControlFixturesDecodeToTypedCases() throws {
        let fixtures = try loadMobileControlFixtures()

        guard case .detachPane = try decodeRequestFixture("detachPane", fixtures: fixtures) else {
            return XCTFail("Expected panes.detach")
        }
        guard case .inputPane = try decodeRequestFixture("inputPane", fixtures: fixtures) else {
            return XCTFail("Expected panes.input")
        }
        guard case .resizePane = try decodeRequestFixture("resizePane", fixtures: fixtures) else {
            return XCTFail("Expected panes.resize")
        }
        guard case .killPane = try decodeRequestFixture("killPane", fixtures: fixtures) else {
            return XCTFail("Expected panes.kill")
        }
        guard case .paneMeta = try decodeRequestFixture("paneMeta", fixtures: fixtures) else {
            return XCTFail("Expected panes.meta")
        }

        guard case .ack = try decodeResponseFixture("ack", fixtures: fixtures) else {
            return XCTFail("Expected ack")
        }
        guard case .paneSpawned = try decodeResponseFixture("paneSpawned", fixtures: fixtures) else {
            return XCTFail("Expected panes.spawn.result")
        }
        guard case .streamExited = try decodeResponseFixture("streamExited", fixtures: fixtures) else {
            return XCTFail("Expected panes.stream.exit")
        }
        guard case .error = try decodeResponseFixture("controlError", fixtures: fixtures) else {
            return XCTFail("Expected error")
        }
    }

    private func decodeRequestFixture(
        _ name: String,
        fixtures: [String: Data]
    ) throws -> MobileControlRequest {
        let data = try XCTUnwrap(fixtures[name])
        guard case let .control(request) = try JSONDecoder().decode(MobileClientMessage.self, from: data) else {
            throw NSError(domain: "ControlMessagesTests", code: 1)
        }
        return request
    }

    private func decodeResponseFixture(
        _ name: String,
        fixtures: [String: Data]
    ) throws -> MobileControlResponse {
        let data = try XCTUnwrap(fixtures[name])
        guard case let .control(response) = try JSONDecoder().decode(MobileServerMessage.self, from: data) else {
            throw NSError(domain: "ControlMessagesTests", code: 2)
        }
        return response
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

    private func encodedJSONObject(of message: MobileClientMessage) throws -> [String: Any] {
        let data = try JSONEncoder().encode(message)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func payload(from object: [String: Any]) -> [String: Any] {
        (object["payload"] as? [String: Any]) ?? [:]
    }

    private func controlPayloadType(in data: Data) -> String? {
        guard
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            object["type"] as? String == "control",
            let payload = object["payload"] as? [String: Any],
            let type = payload["type"] as? String
        else {
            return nil
        }
        return type
    }

    private func makeWorkspaceSnapshotRequest(requestID: String) -> MobileControlRequest {
        .workspaceSnapshot(ControlRequestIDOnly(requestID: requestID))
    }

    private func makeKillPaneRequest(requestID: String, paneID: String) -> MobileControlRequest {
        .killPane(PaneIDControlRequest(requestID: requestID, paneID: paneID))
    }
}
