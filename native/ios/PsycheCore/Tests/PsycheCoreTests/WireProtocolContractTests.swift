import XCTest
@testable import PsycheCore

/// Client half of the wire-protocol contract.
///
/// `BridgeMessages.swift` hand-mirrors `src/services/bridge/wireProtocol.ts`.
/// Nothing in either build links them, so a field renamed or a case added on
/// one side stays invisible until a device fails to decode a real message.
///
/// Both suites read the SAME fixtures from `protocol-fixtures/` and assert the
/// same three properties: completeness, decodes, round-trips. The host
/// counterpart is `__tests__/bridge/wireProtocolContract.test.ts`.
final class WireProtocolContractTests: XCTestCase {

    /// Fixtures live at the repo root, outside the Xcode project, so they are
    /// located relative to this source file rather than a test bundle — no
    /// project.yml resource wiring to keep in sync.
    private static var fixtureDirectory: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // -> PsycheCoreTests/
            .deletingLastPathComponent()  // -> Tests/
            .deletingLastPathComponent()  // -> PsycheCore/
            .deletingLastPathComponent()  // -> ios/
            .deletingLastPathComponent()  // -> native/
            .deletingLastPathComponent()  // -> repo root
            .appendingPathComponent("protocol-fixtures")
    }

    private func loadFixtures(_ file: String) throws -> [String: Data] {
        let url = Self.fixtureDirectory.appendingPathComponent(file)
        let raw = try Data(contentsOf: url)
        // Deliberately a failure, not an XCTSkip: an empty or malformed fixture
        // file is exactly the contract breaking, and a skip would let it pass
        // CI unnoticed — the silent-pass failure mode these tests exist to stop.
        guard let object = try JSONSerialization.jsonObject(with: raw) as? [String: Any] else {
            XCTFail("\(file) is not a JSON object — the fixture file is malformed or empty")
            return [:]
        }
        XCTAssertFalse(object.isEmpty, "\(file) contains no fixtures")
        return try object.mapValues {
            try JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys])
        }
    }

    private func wireType(of data: Data) throws -> String {
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        return (object?["type"] as? String) ?? ""
    }

    private func nestedControlType(of data: Data) throws -> String {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let payload = try XCTUnwrap(object["payload"] as? [String: Any])
        return try XCTUnwrap(payload["type"] as? String)
    }


    /// Swift's JSONEncoder omits nil optionals; TypeScript's JSON.stringify
    /// writes an explicit null. Both sides DECODE either form, and the host
    /// reads these fields with truthy checks (`if (m.payload.token)`), so the
    /// difference is tolerated on the wire — but it is real, so round-trip
    /// comparison strips nulls on both sides rather than pretending otherwise.
    /// `testNilOptionalsAreOmittedNotNulled` pins the behaviour so it stays a
    /// known property instead of an accident.
    private func strippingNulls(_ value: Any) -> Any {
        if let dict = value as? [String: Any] {
            var out: [String: Any] = [:]
            for (k, v) in dict where !(v is NSNull) {
                out[k] = strippingNulls(v)
            }
            return out
        }
        if let array = value as? [Any] {
            return array.map(strippingNulls)
        }
        return value
    }

    private func comparableJSON(_ data: Data) throws -> NSDictionary {
        let object = try JSONSerialization.jsonObject(with: data)
        return (strippingNulls(object) as? [String: Any] as NSDictionary?) ?? [:]
    }

    // MARK: - Completeness

    // The anti-drift check: add a case here and this fails until a fixture
    // exists for the TypeScript side to decode too.
    func testEveryClientMessageTypeHasAFixture() throws {
        let covered = Set(try loadFixtures("client-messages.json").values.map { try wireType(of: $0) })
        let missing = ClientMessage.allTypeNames.filter { !covered.contains($0) }
        XCTAssertEqual(missing, [], "Client message types with no fixture")
    }

    func testEveryServerMessageTypeHasAFixture() throws {
        let covered = Set(try loadFixtures("server-messages.json").values.map { try wireType(of: $0) })
        let missing = ServerMessage.allTypeNames.filter { !covered.contains($0) }
        XCTAssertEqual(missing, [], "Server message types with no fixture")
    }

    // The reverse: a fixture for a type this side no longer declares would
    // otherwise keep passing on the host alone.
    func testNoFixtureForAnUndeclaredClientType() throws {
        let declared = Set(ClientMessage.allTypeNames)
        for (name, data) in try loadFixtures("client-messages.json") {
            let type = try wireType(of: data)
            XCTAssertTrue(declared.contains(type), "Fixture \(name) has undeclared type \(type)")
        }
    }

    func testNoFixtureForAnUndeclaredServerType() throws {
        let declared = Set(ServerMessage.allTypeNames)
        for (name, data) in try loadFixtures("server-messages.json") {
            let type = try wireType(of: data)
            XCTAssertTrue(declared.contains(type), "Fixture \(name) has undeclared type \(type)")
        }
    }

    func testMobileControlFixturesCoverEverySupportedRequestType() throws {
        let covered = Set(
            try loadFixtures("mobile-control.json")
                .values
                .filter { try wireType(of: $0) == "control" }
                .compactMap { try? nestedControlType(of: $0) }
        )
        let missing = MobileControlRequest.supportedTypeNames.filter { !covered.contains($0) }
        XCTAssertEqual(missing, [], "Supported request types with no fixture")
    }

    func testMobileControlFixturesCoverEverySupportedResponseType() throws {
        let covered = Set(
            try loadFixtures("mobile-control.json")
                .values
                .filter { try wireType(of: $0) == "control" }
                .compactMap { try? nestedControlType(of: $0) }
        )
        let missing = MobileControlResponse.supportedTypeNames.filter { !covered.contains($0) }
        XCTAssertEqual(missing, [], "Supported response types with no fixture")
    }

    // MARK: - Decoding

    func testEveryClientFixtureDecodes() throws {
        for (name, data) in try loadFixtures("client-messages.json") {
            XCTAssertNoThrow(
                try JSONDecoder().decode(ClientMessage.self, from: data),
                "Failed to decode client fixture \(name)"
            )
        }
    }

    func testEveryServerFixtureDecodes() throws {
        for (name, data) in try loadFixtures("server-messages.json") {
            XCTAssertNoThrow(
                try JSONDecoder().decode(ServerMessage.self, from: data),
                "Failed to decode server fixture \(name)"
            )
        }
    }

    // MARK: - Round-trip

    // Decode then re-encode must reproduce the same JSON value. This is what
    // catches a CodingKeys mapping that decodes leniently but writes back the
    // wrong wire spelling.
    func testClientFixturesRoundTrip() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]

        for (name, data) in try loadFixtures("client-messages.json") {
            let decoded = try JSONDecoder().decode(ClientMessage.self, from: data)
            let reencoded = try encoder.encode(decoded)
            XCTAssertEqual(
                try comparableJSON(reencoded),
                try comparableJSON(data),
                "Client fixture \(name) did not survive a round-trip"
            )
        }
    }

    func testServerFixturesRoundTrip() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]

        for (name, data) in try loadFixtures("server-messages.json") {
            let decoded = try JSONDecoder().decode(ServerMessage.self, from: data)
            let reencoded = try encoder.encode(decoded)
            XCTAssertEqual(
                try comparableJSON(reencoded),
                try comparableJSON(data),
                "Server fixture \(name) did not survive a round-trip"
            )
        }
    }


    func testMobileControlFixturesDecodeAndRoundTrip() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]

        for (name, data) in try loadFixtures("mobile-control.json") {
            if let decodedClient = try? JSONDecoder().decode(MobileClientMessage.self, from: data) {
                XCTAssertEqual(
                    try comparableJSON(encoder.encode(decodedClient)),
                    try comparableJSON(data),
                    "Mobile client fixture \(name) did not survive a round-trip"
                )
                continue
            }

            if let decodedServer = try? JSONDecoder().decode(MobileServerMessage.self, from: data) {
                XCTAssertEqual(
                    try comparableJSON(encoder.encode(decodedServer)),
                    try comparableJSON(data),
                    "Mobile server fixture \(name) did not survive a round-trip"
                )
                continue
            }

            XCTFail("Mobile control fixture \(name) did not decode as either client or server")
        }
    }

    func testSupportedMobileControlRequestFixturesDecodeToTypedCases() throws {
        for (name, data) in try loadFixtures("mobile-control.json") {
            guard try wireType(of: data) == "control" else { continue }
            guard MobileControlRequest.supportedTypeNames.contains(try nestedControlType(of: data)) else { continue }
            guard case let .control(request) = try JSONDecoder().decode(MobileClientMessage.self, from: data) else {
                return XCTFail("Expected control client fixture \(name)")
            }
            if case .unknown = request {
                XCTFail("Supported request fixture \(name) decoded as .unknown")
            }
        }
    }

    func testSupportedMobileControlResponseFixturesDecodeToTypedCases() throws {
        for (name, data) in try loadFixtures("mobile-control.json") {
            guard try wireType(of: data) == "control" else { continue }
            guard MobileControlResponse.supportedTypeNames.contains(try nestedControlType(of: data)) else { continue }
            guard case let .control(response) = try JSONDecoder().decode(MobileServerMessage.self, from: data) else {
                return XCTFail("Expected control server fixture \(name)")
            }
            if case .unknown = response {
                XCTFail("Supported response fixture \(name) decoded as .unknown")
            }
        }
    }

    func testWorkspaceSnapshotFixtureDecodesAndRoundTrips() throws {
        let data = try Data(
            contentsOf: Self.fixtureDirectory.appendingPathComponent("workspace-snapshot.json")
        )
        let snapshot = try JSONDecoder().decode(WorkspaceSnapshotEnvelope.self, from: data)

        XCTAssertEqual(snapshot.type, "workspace.snapshot.result")
        XCTAssertEqual(snapshot.workspace.revision, 42)
        XCTAssertEqual(snapshot.workspace.projects.first?.worktrees.count, 2)
        XCTAssertEqual(
            snapshot.workspace.projects.first?.worktrees.first?.panes.first?.lastActivity,
            "2026-08-03T02:12:00.000Z"
        )
        XCTAssertEqual(
            snapshot.workspace.projects.first?.projectPanes.first?.recoverability,
            "missing-worktree"
        )
        XCTAssertEqual(
            try comparableJSON(JSONEncoder().encode(snapshot)),
            try comparableJSON(data)
        )
    }

    func testUnknownRitualPublicationStateDegradesWithoutRejectingProject() throws {
        let data = try XCTUnwrap(
            """
            {
              "id": "project-1",
              "root": "/repo",
              "title": "psyche-build",
              "worktrees": [],
              "projectPanes": [],
              "runningCount": 0,
              "attentionCount": 0,
              "rituals": {
                "state": "future-host-state",
                "rituals": []
              }
            }
            """.data(using: .utf8)
        )

        let project = try JSONDecoder().decode(WorkspaceProjectSnapshot.self, from: data)

        XCTAssertEqual(project.rituals?.state, .unavailable)
    }

    // MARK: - Spot checks the host side also asserts

    func testDecodedPaneSnapshotUsesTheWireIdSpelling() throws {
        let fixtures = try loadFixtures("server-messages.json")
        let data = try XCTUnwrap(fixtures["paneList"])
        guard case let .paneList(panes) = try JSONDecoder().decode(ServerMessage.self, from: data) else {
            return XCTFail("Expected paneList")
        }
        // Swift spells this projectID; the wire spells it projectId.
        XCTAssertEqual(panes.first?.projectID, "proj-1")
        XCTAssertEqual(panes.first?.status, .working)
    }

    func testNullableFieldsDecodeAsNil() throws {
        let fixtures = try loadFixtures("server-messages.json")
        let data = try XCTUnwrap(fixtures["welcome_noProject"])
        guard case let .welcome(payload) = try JSONDecoder().decode(ServerMessage.self, from: data) else {
            return XCTFail("Expected welcome")
        }
        XCTAssertNil(payload.projectName)
    }

    // Documents a real difference between the two implementations rather than
    // hiding it: given `"token": null`, Swift re-encodes with the key ABSENT.
    // The host tolerates this (truthy checks), but anything that starts doing
    // `payload.token === null` on the TypeScript side would break, and this
    // test is where that assumption is recorded.
    func testNilOptionalsAreOmittedNotNulled() throws {
        let fixtures = try loadFixtures("client-messages.json")
        let data = try XCTUnwrap(fixtures["hello_noToken"])
        let decoded = try JSONDecoder().decode(ClientMessage.self, from: data)
        let reencoded = try JSONEncoder().encode(decoded)

        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: reencoded) as? [String: Any]
        )
        let payload = try XCTUnwrap(object["payload"] as? [String: Any])

        XCTAssertFalse(payload.keys.contains("token"),
                       "Swift omits nil optionals; if this changes, the fixtures and the host both need review")
    }

}
