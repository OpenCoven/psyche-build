import XCTest
import PsycheCore

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

    func testFileInspectionFixturesDecodeEveryBoundedField() throws {
        let fixtures = try loadMobileControlFixtures()

        guard case let .listFiles(list) = try decodeRequestFixture("listFiles", fixtures: fixtures) else {
            return XCTFail("Expected files.list")
        }
        XCTAssertEqual(list.requestID, "files-list-1")
        XCTAssertEqual(list.paneID, "%3")

        guard case let .filesList(listResult) = try decodeResponseFixture(
            "filesListResult",
            fixtures: fixtures
        ) else {
            return XCTFail("Expected files.list.result")
        }
        XCTAssertEqual(listResult.snapshot.rootPath, "/repo")
        XCTAssertEqual(listResult.snapshot.files.first?.path, "src/index.ts")
        XCTAssertEqual(listResult.snapshot.files.first?.statusLabel, "Modified")

        guard case let .filesRead(readResult) = try decodeResponseFixture(
            "filesReadResult",
            fixtures: fixtures
        ) else {
            return XCTFail("Expected files.read.result")
        }
        XCTAssertEqual(readResult.path, "src/index.ts")
        XCTAssertEqual(readResult.content, "export {};\n")
        XCTAssertEqual(readResult.truncated, true)

        guard case let .filesDiff(diffResult) = try decodeResponseFixture(
            "filesDiffResult",
            fixtures: fixtures
        ) else {
            return XCTFail("Expected files.diff.result")
        }
        XCTAssertEqual(diffResult.path, "src/index.ts")
        XCTAssertEqual(diffResult.diff, "@@ -0,0 +1 @@\n+export {};\n")
    }

    func testActionResponseFixtureCarriesTheContinuationSession() throws {
        let fixtures = try loadMobileControlFixtures()
        guard case let .respondToAction(response) = try decodeRequestFixture(
            "respondToAction",
            fixtures: fixtures
        ) else {
            return XCTFail("Expected actions.respond")
        }
        XCTAssertEqual(response.requestID, "action-response-1")
        XCTAssertEqual(response.sessionID, "action-session-1")
        XCTAssertEqual(response.response, .confirm)
    }

    func testActionResultDecodesStringMetadata() throws {
        let message = try JSONDecoder().decode(MobileServerMessage.self, from: Data("""
        {
          "type": "control",
          "payload": {
            "type": "actions.result",
            "requestId": "action-1",
            "result": {
              "type": "success",
              "message": "Created pane",
              "data": {"action": "create_pane", "agent": "codex"}
            }
          }
        }
        """.utf8))

        guard case let .control(.actionResult(response)) = message else {
            return XCTFail("Expected actions.result")
        }
        XCTAssertEqual(response.result.data, ["action": "create_pane", "agent": "codex"])
    }

    func testConstructedActionResultPreservesEveryPresentationField() throws {
        let option = MobileActionOption(
            id: "approve",
            label: "Approve",
            description: "Approve the changes as-is",
            danger: true,
            isDefault: false
        )
        let reviewData = MobileActionReviewData(
            repoPath: "/repo",
            sourceBranch: "feature/mobile-actions",
            targetBranch: "main",
            files: ["Sources/App.swift", "Tests/AppTests.swift"],
            aiFailed: false
        )
        let result = MobileActionResult(
            type: "pr_review",
            message: "Review the proposed changes",
            title: "PR Review",
            confirmLabel: "Submit review",
            cancelLabel: "Cancel",
            options: [option],
            placeholder: "Leave a review comment",
            defaultValue: "Looks good",
            inputMaxVisibleLines: 4,
            progress: 0.75,
            targetPaneID: "%11",
            reviewData: reviewData,
            data: [
                "host": "studio.local",
                "projectTitle": "psyche-build",
                "consequence": "Creates a public pull request"
            ],
            relatedFiles: ["Sources/App.swift", "Sources/SceneDelegate.swift"],
            dismissable: false
        )

        XCTAssertEqual(option.id, "approve")
        XCTAssertEqual(option.label, "Approve")
        XCTAssertEqual(option.description, "Approve the changes as-is")
        XCTAssertEqual(option.danger, true)
        XCTAssertEqual(option.isDefault, false)

        XCTAssertEqual(result.type, "pr_review")
        XCTAssertEqual(result.message, "Review the proposed changes")
        XCTAssertEqual(result.title, "PR Review")
        XCTAssertEqual(result.confirmLabel, "Submit review")
        XCTAssertEqual(result.cancelLabel, "Cancel")
        XCTAssertEqual(result.options, [option])
        XCTAssertEqual(result.placeholder, "Leave a review comment")
        XCTAssertEqual(result.defaultValue, "Looks good")
        XCTAssertEqual(result.inputMaxVisibleLines, 4)
        XCTAssertEqual(result.progress, 0.75)
        XCTAssertEqual(result.targetPaneID, "%11")
        XCTAssertEqual(result.reviewData, reviewData)
        XCTAssertEqual(
            result.data,
            [
                "host": "studio.local",
                "projectTitle": "psyche-build",
                "consequence": "Creates a public pull request"
            ]
        )
        XCTAssertEqual(result.relatedFiles, ["Sources/App.swift", "Sources/SceneDelegate.swift"])
        XCTAssertEqual(result.dismissable, false)

        let response = MobileActionsResultResponse(
            requestID: "action-response-1",
            sessionID: "session-1",
            result: result
        )
        let message = MobileServerMessage.control(.actionResult(response))
        let encoded = try encodedJSONObject(of: message)
        let payloadObject = payload(from: encoded)
        let encodedResult = try XCTUnwrap(payloadObject["result"] as? [String: Any])
        let encodedOption = try XCTUnwrap((encodedResult["options"] as? [[String: Any]])?.first)
        let encodedReviewData = try XCTUnwrap(encodedResult["reviewData"] as? [String: Any])

        XCTAssertEqual(encoded["type"] as? String, "control")
        XCTAssertEqual(payloadObject["type"] as? String, "actions.result")
        XCTAssertEqual(payloadObject["requestId"] as? String, "action-response-1")
        XCTAssertEqual(payloadObject["sessionId"] as? String, "session-1")
        XCTAssertEqual(encodedResult["type"] as? String, "pr_review")
        XCTAssertEqual(encodedResult["message"] as? String, "Review the proposed changes")
        XCTAssertEqual(encodedResult["title"] as? String, "PR Review")
        XCTAssertEqual(encodedResult["confirmLabel"] as? String, "Submit review")
        XCTAssertEqual(encodedResult["cancelLabel"] as? String, "Cancel")
        XCTAssertEqual(encodedResult["placeholder"] as? String, "Leave a review comment")
        XCTAssertEqual(encodedResult["defaultValue"] as? String, "Looks good")
        XCTAssertEqual(try XCTUnwrap(encodedResult["inputMaxVisibleLines"] as? NSNumber).intValue, 4)
        XCTAssertEqual(try XCTUnwrap(encodedResult["progress"] as? NSNumber).doubleValue, 0.75)
        XCTAssertEqual(encodedResult["targetPaneId"] as? String, "%11")
        XCTAssertNil(encodedResult["targetPaneID"])
        XCTAssertEqual(encodedOption["id"] as? String, "approve")
        XCTAssertEqual(encodedOption["label"] as? String, "Approve")
        XCTAssertEqual(encodedOption["description"] as? String, "Approve the changes as-is")
        XCTAssertEqual(try XCTUnwrap(encodedOption["danger"] as? NSNumber).boolValue, true)
        XCTAssertEqual(try XCTUnwrap(encodedOption["default"] as? NSNumber).boolValue, false)
        XCTAssertNil(encodedOption["isDefault"])
        XCTAssertEqual(encodedReviewData["repoPath"] as? String, "/repo")
        XCTAssertEqual(encodedReviewData["sourceBranch"] as? String, "feature/mobile-actions")
        XCTAssertEqual(encodedReviewData["targetBranch"] as? String, "main")
        XCTAssertEqual(encodedReviewData["files"] as? [String], ["Sources/App.swift", "Tests/AppTests.swift"])
        XCTAssertEqual(try XCTUnwrap(encodedReviewData["aiFailed"] as? NSNumber).boolValue, false)
        XCTAssertEqual(try XCTUnwrap(encodedResult["data"] as? [String: String]), [
            "host": "studio.local",
            "projectTitle": "psyche-build",
            "consequence": "Creates a public pull request"
        ])
        XCTAssertEqual(encodedResult["relatedFiles"] as? [String], ["Sources/App.swift", "Sources/SceneDelegate.swift"])
        XCTAssertEqual(try XCTUnwrap(encodedResult["dismissable"] as? NSNumber).boolValue, false)

        let decoded = try JSONDecoder().decode(MobileServerMessage.self, from: JSONEncoder().encode(message))

        guard case let .control(.actionResult(decodedResponse)) = decoded else {
            return XCTFail("Expected actions.result response")
        }
        XCTAssertEqual(decodedResponse.sessionID, "session-1")
        XCTAssertEqual(decodedResponse.result, result)
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

    private func encodedJSONObject<T: Encodable>(of value: T) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
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
