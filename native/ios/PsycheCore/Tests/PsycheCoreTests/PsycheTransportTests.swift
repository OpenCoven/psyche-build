import Foundation
import XCTest
@testable import PsycheCore

final class PsycheTransportTests: XCTestCase {
    private let endpoint = HostEndpoint(
        host: "psyche.local",
        port: 4242,
        certificateFingerprint: String(repeating: "a", count: 64)
    )

    func testDecodesTerminalBinaryFrame() throws {
        let data = makeFrame(streamID: "pane-1", sequence: 258, payload: Data([0xde, 0xad]))

        XCTAssertEqual(
            try TerminalBinaryFrame.decode(data),
            TerminalBinaryFrame(
                streamID: "pane-1",
                sequence: 258,
                payload: Data([0xde, 0xad])
            )
        )
    }

    func testDecodesMaximumSequenceAndEmptyPayloadInBigEndianOrder() throws {
        let data = makeFrame(streamID: "π", sequence: .max, payload: Data())

        let decoded = try TerminalBinaryFrame.decode(data)

        XCTAssertEqual(decoded.streamID, "π")
        XCTAssertEqual(decoded.sequence, .max)
        XCTAssertTrue(decoded.payload.isEmpty)
    }

    func testRejectsMalformedTerminalBinaryFrames() {
        let invalidUTF8 = Data([1, 0xff]) + Data(repeating: 0, count: 8)

        assertFrameError(Data(), equals: .truncatedHeader)
        assertFrameError(Data([0]) + Data(repeating: 0, count: 8), equals: .emptyStreamID)
        assertFrameError(Data([4, 0x61]), equals: .truncatedHeader)
        assertFrameError(invalidUTF8, equals: .invalidStreamID)
    }

    func testFakeTransportReconnectCreatesFreshStreamsAndIgnoresStaleEmits() async throws {
        let transport = FakeTransport()
        try await transport.connect(to: endpoint)
        let firstMessages = await transport.incomingMessages()
        let firstBinary = await transport.incomingBinaryFrames()

        await transport.disconnect()
        try await transport.connect(to: endpoint)
        let secondMessages = await transport.incomingMessages()
        let secondBinary = await transport.incomingBinaryFrames()

        let staleMessage = MobileServerMessage.legacy(.pong(TokenPayload(token: "stale")))
        let currentMessage = MobileServerMessage.legacy(.pong(TokenPayload(token: "current")))
        let staleFrame = TerminalBinaryFrame(streamID: "stale", sequence: 1, payload: Data())
        let currentFrame = TerminalBinaryFrame(streamID: "current", sequence: 2, payload: Data([1]))

        await transport.emit(staleMessage, onConnection: 0)
        await transport.emit(staleFrame, onConnection: 0)
        await transport.emit(currentMessage, onConnection: 1)
        await transport.emit(currentFrame, onConnection: 1)

        var firstMessageIterator = firstMessages.makeAsyncIterator()
        var firstBinaryIterator = firstBinary.makeAsyncIterator()
        var secondMessageIterator = secondMessages.makeAsyncIterator()
        var secondBinaryIterator = secondBinary.makeAsyncIterator()

        let firstMessage = await firstMessageIterator.next()
        let firstFrame = await firstBinaryIterator.next()
        let secondMessage = await secondMessageIterator.next()
        let secondFrame = await secondBinaryIterator.next()
        XCTAssertNil(firstMessage)
        XCTAssertNil(firstFrame)
        XCTAssertEqual(secondMessage, currentMessage)
        XCTAssertEqual(secondFrame, currentFrame)
    }

    private func makeFrame(streamID: String, sequence: UInt64, payload: Data) -> Data {
        let idData = Data(streamID.utf8)
        var data = Data([UInt8(idData.count)])
        data.append(idData)
        for shift in stride(from: 56, through: 0, by: -8) {
            data.append(UInt8((sequence >> UInt64(shift)) & 0xff))
        }
        data.append(payload)
        return data
    }

    private func assertFrameError(
        _ data: Data,
        equals expected: TerminalBinaryFrameError,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertThrowsError(try TerminalBinaryFrame.decode(data), file: file, line: line) { error in
            XCTAssertEqual(error as? TerminalBinaryFrameError, expected, file: file, line: line)
        }
    }
}
