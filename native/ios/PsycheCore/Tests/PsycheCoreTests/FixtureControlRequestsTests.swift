import XCTest
@testable import PsycheCore

final class FixtureControlRequestsTests: XCTestCase {
    func testRitualLaunchPublishesAPaneAndPreservesRitualMetadata() async throws {
        let requests = FixtureControlRequests(
            workspace: WorkspaceFixtures.workspace(
                named: WorkspaceFixtures.multiproject
            )
        )

        let launch = try await requests.send(.launchRitual(
            MobileRitualLaunchRequest(
                requestID: "launch-1",
                projectID: "website",
                ritualID: "review-site",
                params: nil
            )
        ))
        XCTAssertEqual(
            launch,
            .ack(ControlAckResponse(requestID: "launch-1", ok: true))
        )

        let response = try await requests.send(.workspaceSnapshot(
            ControlRequestIDOnly(requestID: "snapshot-1")
        ))
        guard case let .workspaceSnapshot(snapshot) = response else {
            return XCTFail("Expected an authoritative workspace snapshot")
        }

        XCTAssertEqual(snapshot.sequence, 2)

        let website = try XCTUnwrap(
            snapshot.workspace.projects.first { $0.id == "website" }
        )
        XCTAssertEqual(website.rituals.map(\.id), ["review-site"])
        XCTAssertTrue(
            website.worktrees
                .flatMap(\.panes)
                .contains { $0.id == "ritual-review-site" && $0.cwd == website.root }
        )
    }

    func testUnknownRitualReturnsARefusedAck() async throws {
        let requests = FixtureControlRequests(
            workspace: WorkspaceFixtures.workspace(
                named: WorkspaceFixtures.multiproject
            )
        )

        let response = try await requests.send(.launchRitual(
            MobileRitualLaunchRequest(
                requestID: "launch-404",
                projectID: "website",
                ritualID: "nope",
                params: nil
            )
        ))

        XCTAssertEqual(
            response,
            .ack(ControlAckResponse(requestID: "launch-404", ok: false))
        )
    }
}
