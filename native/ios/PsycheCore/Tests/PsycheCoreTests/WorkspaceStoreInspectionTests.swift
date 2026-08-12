import Foundation
import XCTest
@testable import PsycheCore

@MainActor
final class WorkspaceStoreInspectionTests: XCTestCase {
    private let paneID = "ios-cockpit"

    func testFileCommandsCarryOnlyThePublishedPaneAndRequestedPath() async throws {
        let requests = InspectionControlRequests()
        let store = makeStore(requests)

        let snapshot = try await store.listFiles(inPane: paneID)
        let content = try await store.readFile("Sources/App.swift", inPane: paneID)
        let diff = try await store.diffFile("Sources/App.swift", inPane: paneID)

        XCTAssertEqual(snapshot.files.map(\.path), ["Sources/App.swift"])
        XCTAssertEqual(content, "struct App {}\n")
        XCTAssertEqual(diff, "@@ -1 +1 @@\n-old\n+new")
        let sent = await requests.sent
        XCTAssertEqual(sent, [
            .listFiles(MobileFilesListRequest(
                requestID: "request-1",
                paneID: paneID
            )),
            .readFile(MobileFilesReadRequest(
                requestID: "request-2",
                paneID: paneID,
                path: "Sources/App.swift"
            )),
            .diffFile(MobileFilesDiffRequest(
                requestID: "request-3",
                paneID: paneID,
                path: "Sources/App.swift"
            )),
        ])
    }

    func testInspectionRefusesStaleWorkspaceBeforeSending() async {
        let requests = InspectionControlRequests()
        let store = makeStore(requests)
        store.markDisconnected()

        await assertThrows(.staleWorkspace) {
            _ = try await store.listFiles(inPane: self.paneID)
        }
        let sent = await requests.sent
        XCTAssertEqual(sent.count, 0)
    }

    func testInspectionRefusesAnUnpublishedPaneBeforeSending() async {
        let requests = InspectionControlRequests()
        let store = makeStore(requests)

        await assertThrows(.unknownPane("%404")) {
            _ = try await store.listFiles(inPane: "%404")
        }
        let sent = await requests.sent
        XCTAssertEqual(sent.count, 0)
    }

    func testInspectionRejectsAMismatchedResponse() async {
        let requests = InspectionControlRequests(responseOverride: .ack(
            ControlAckResponse(requestID: "wrong", ok: true)
        ))
        let store = makeStore(requests)

        await assertThrows(.unexpectedResponse) {
            _ = try await store.readFile("Sources/App.swift", inPane: self.paneID)
        }
    }

    private func makeStore(_ requests: InspectionControlRequests) -> WorkspaceStore {
        let store = WorkspaceStore(controlRequests: requests)
        store.applySnapshot(
            workspace: WorkspaceFixtures.workspace(named: WorkspaceFixtures.multiproject),
            sequence: 1
        )
        return store
    }

    private func assertThrows(
        _ expected: WorkspaceStoreError,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ body: () async throws -> Void
    ) async {
        do {
            try await body()
            XCTFail("Expected \(expected)", file: file, line: line)
        } catch {
            XCTAssertEqual(error as? WorkspaceStoreError, expected, file: file, line: line)
        }
    }
}

private actor InspectionControlRequests: ControlRequesting {
    private(set) var sent: [MobileControlRequest] = []
    private var nextID = 0
    private let responseOverride: MobileControlResponse?

    init(responseOverride: MobileControlResponse? = nil) {
        self.responseOverride = responseOverride
    }

    func nextRequestID() -> String {
        nextID += 1
        return "request-\(nextID)"
    }

    func send(_ request: MobileControlRequest) throws -> MobileControlResponse {
        sent.append(request)
        if let responseOverride { return responseOverride }

        switch request {
        case .listFiles(let payload):
            return .filesList(MobileFilesListResult(
                requestID: payload.requestID,
                paneID: payload.paneID,
                snapshot: BrowserSnapshot(
                    rootPath: "/repo",
                    files: [BrowserFile(
                        path: "Sources/App.swift",
                        name: "App.swift",
                        parentPath: "Sources",
                        exists: true,
                        changed: true,
                        statusCode: " M",
                        statusLabel: "M"
                    )]
                )
            ))
        case .readFile(let payload):
            return .filesRead(MobileFilesReadResult(
                requestID: payload.requestID,
                paneID: payload.paneID,
                path: payload.path,
                content: "struct App {}\n"
            ))
        case .diffFile(let payload):
            return .filesDiff(MobileFilesDiffResult(
                requestID: payload.requestID,
                paneID: payload.paneID,
                path: payload.path,
                diff: "@@ -1 +1 @@\n-old\n+new"
            ))
        default:
            return .ack(ControlAckResponse(requestID: request.requestID ?? "", ok: true))
        }
    }
}
