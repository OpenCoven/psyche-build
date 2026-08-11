import Foundation
import XCTest
@testable import PsycheCore

final class TerminalControlClientTests: XCTestCase {

    func testInputRejectsANegativeAcknowledgement() async {
        let requests = StubControlRequests(
            response: .ack(ControlAckResponse(requestID: "req-1", ok: false))
        )
        let client = TerminalControlClient(requests: requests, transport: StubTransport())

        do {
            try await client.send(Data("pwd\r".utf8), toStream: "stream-1")
            XCTFail("Expected a negative acknowledgement to reject the input")
        } catch {
            XCTAssertEqual(error as? TerminalControlError, .inputRejected)
            XCTAssertEqual(error.localizedDescription, "The host rejected the terminal input.")
        }
    }

    func testInputRejectsAMismatchedResponseType() async {
        let requests = StubControlRequests(response: .paneSpawned(PaneSpawnedResponse(
            requestID: "req-1",
            id: "pane-2",
            pane: nil,
            worktreePath: nil,
            branch: nil
        )))
        let client = TerminalControlClient(requests: requests, transport: StubTransport())

        do {
            try await client.send(Data("pwd\r".utf8), toStream: "stream-1")
            XCTFail("Expected a mismatched response to reject the input")
        } catch {
            XCTAssertEqual(error as? TerminalControlError, .unexpectedResponse)
        }
    }
}

private actor StubControlRequests: ControlRequesting {
    private let response: MobileControlResponse

    init(response: MobileControlResponse) {
        self.response = response
    }

    func nextRequestID() -> String {
        "req-1"
    }

    func send(_ request: MobileControlRequest) async throws -> MobileControlResponse {
        response
    }
}

private actor StubTransport: PsycheTransport {
    func connect(to endpoint: HostEndpoint) async throws {}
    func disconnect() async {}
    func send(_ message: MobileClientMessage) async throws {}

    func incomingMessages() async -> AsyncStream<MobileServerMessage> {
        AsyncStream { $0.finish() }
    }

    func incomingBinaryFrames() async -> AsyncStream<TerminalBinaryFrame> {
        AsyncStream { $0.finish() }
    }
}
