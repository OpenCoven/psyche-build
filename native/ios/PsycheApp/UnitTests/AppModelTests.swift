import Foundation
import PsycheCore
import XCTest
@testable import Psyche_Build

@MainActor
final class AppModelTests: XCTestCase {
    func testFixtureRootComposesNoConnectionGraph() {
        let model = AppModel(fixture: WorkspaceFixtures.multiproject)

        // The absence of the graph is the guarantee that a UI fixture cannot
        // reach the network or the keychain — there is nothing there to reach
        // with.
        XCTAssertNil(model.composition)
        XCTAssertTrue(model.isFixture)
        XCTAssertEqual(model.fixtureName, WorkspaceFixtures.multiproject)
    }

    func testFixtureRootStartsWithWorkspaceStateAlreadyApplied() {
        let model = AppModel(fixture: WorkspaceFixtures.multiproject)

        XCTAssertNotNil(model.workspaceStore.workspace)
        XCTAssertEqual(model.workspaceStore.nowSections.map(\.kind), [.needsYou, .running, .recent])
        XCTAssertEqual(model.hostName, AppModel.fixtureHostName)
    }

    func testFixtureStartIsANoOpRatherThanAConnectionAttempt() async {
        let model = AppModel(fixture: WorkspaceFixtures.multiproject)

        await model.start()

        XCTAssertNil(model.composition)
        XCTAssertNil(model.connectionError)
        XCTAssertEqual(model.hostName, AppModel.fixtureHostName)
    }

    func testProductionRootComposesOneSharedGraph() {
        let model = AppModel()
        let composition = model.composition

        XCTAssertNotNil(composition)
        XCTAssertFalse(model.isFixture)
        XCTAssertNil(model.fixtureName)
        XCTAssertTrue(model.workspaceStore === composition?.workspaceStore)
    }

    func testProductionRootStartsWithNothingConfirmed() {
        let model = AppModel()

        XCTAssertNil(model.workspaceStore.workspace)
        XCTAssertTrue(model.workspaceStore.isStale)
        XCTAssertNil(model.hostName)
    }

    func testFixtureNameIsReadFromLaunchArguments() {
        XCTAssertEqual(
            AppModel.fixtureName(in: ["Psyche", "-uiFixture", "multiproject"]),
            "multiproject"
        )
        XCTAssertNil(AppModel.fixtureName(in: ["Psyche"]))
        XCTAssertNil(
            AppModel.fixtureName(in: ["Psyche", "-uiFixture"]),
            "A dangling flag must not select an unnamed fixture"
        )
        XCTAssertNil(
            AppModel.fixtureName(in: ["Psyche", "-uiFixture", ""]),
            "An empty name must fall through to production rather than trap"
        )
    }

    func testFixtureSendFailureFlagIsReadFromLaunchArguments() {
        XCTAssertTrue(
            AppModel.fixtureSendFails(
                in: ["Psyche", "-uiFixture", "multiproject", "-uiTerminalSendFailure"]
            )
        )
        XCTAssertFalse(
            AppModel.fixtureSendFails(in: ["Psyche", "-uiFixture", "multiproject"])
        )
    }

    func testFixtureCanDeterministicallyFailTerminalSends() async {
        let model = AppModel(
            fixture: WorkspaceFixtures.multiproject,
            fixtureSendFails: true
        )
        await model.terminalRegistry.show(primary: "web-home")

        let accepted = await model.terminalRegistry.send(
            Data("keep\r".utf8),
            toPane: "web-home"
        )

        XCTAssertFalse(accepted)
        XCTAssertNotNil(model.terminalRegistry.lastErrorMessage)
    }

    func testPairingRecordsTheHostForLaterContext() {
        let model = AppModel(fixture: WorkspaceFixtures.multiproject)

        model.recordPairedHostName("studio.local")

        XCTAssertEqual(model.hostName, "studio.local")
    }

    func testAcceptsAValidDeepLinkAsAPendingInvite() {
        let model = AppModel(fixture: WorkspaceFixtures.multiproject)

        model.receive(url: URL(string:
            "psyche://connect?host=wss%3A%2F%2Fstudio.example%3A4242&psyche_invite=one-time-token"
        )!)

        XCTAssertEqual(model.pendingInvite?.endpoint.host, "studio.example")
        XCTAssertEqual(model.pendingInvite?.endpoint.port, 4242)
        XCTAssertEqual(model.pendingInvite?.token, "one-time-token")
    }

    func testRejectsAnInvalidDeepLinkWithoutChangingPendingInvite() {
        let model = AppModel(fixture: WorkspaceFixtures.multiproject)

        model.receive(url: URL(string: "coven://connect?host=wss%3A%2F%2Fstudio.example&psyche_invite=token")!)

        XCTAssertNil(model.pendingInvite)
    }

    func testGeneratedAppRegistersPsycheURLDeliveryPath() throws {
        let sourceRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let infoURL = sourceRoot.appendingPathComponent("Resources/Info.plist")
        let appURL = sourceRoot.appendingPathComponent("Sources/PsycheApp/PsycheApp.swift")
        let infoData = try Data(contentsOf: infoURL)
        let info = try XCTUnwrap(
            PropertyListSerialization.propertyList(from: infoData, format: nil) as? [String: Any]
        )
        let urlTypes = try XCTUnwrap(info["CFBundleURLTypes"] as? [[String: Any]])
        let schemes = try XCTUnwrap(urlTypes.first?["CFBundleURLSchemes"] as? [String])
        let appSource = try String(contentsOf: appURL, encoding: .utf8)

        XCTAssertEqual(schemes, ["psyche"])
        XCTAssertTrue(appSource.contains(".onOpenURL"))
        XCTAssertTrue(appSource.contains("model.receive(url: url)"))
    }
}
