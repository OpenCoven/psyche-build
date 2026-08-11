import Foundation
import XCTest
@testable import PsycheCore

final class URLSessionControlTransportTests: XCTestCase {
    private let fingerprint = String(repeating: "a", count: 64)

    func testMalformedFingerprintFailsBeforeSessionCreation() async {
        let factory = TestWebSocketSessionFactory(sessions: [TestWebSocketSession()])
        let transport = URLSessionControlTransport(sessionFactory: factory)

        do {
            try await transport.connect(to: HostEndpoint(
                host: "psyche.local",
                port: 4242,
                certificateFingerprint: "not-a-fingerprint"
            ))
            XCTFail("Expected malformed fingerprint to fail")
        } catch {
            XCTAssertTrue(error.localizedDescription.localizedCaseInsensitiveContains("re-pair"))
        }

        XCTAssertEqual(factory.makeSessionCount, 0)
    }

    func testConnectBuildsIPv6URLAndReconnectCreatesFreshStreams() async throws {
        let firstSession = TestWebSocketSession()
        let secondSession = TestWebSocketSession()
        let factory = TestWebSocketSessionFactory(sessions: [firstSession, secondSession])
        let transport = URLSessionControlTransport(sessionFactory: factory)
        let endpoint = HostEndpoint(
            host: "2001:db8::1",
            port: 4242,
            certificateFingerprint: fingerprint
        )

        try await transport.connect(to: endpoint)
        let firstMessages = await transport.incomingMessages()
        let firstBinary = await transport.incomingBinaryFrames()

        try await transport.connect(to: endpoint)
        let secondMessages = await transport.incomingMessages()
        let secondBinary = await transport.incomingBinaryFrames()

        let firstURLs = await firstSession.requestedURLs.map(\.absoluteString)
        let firstInvalidationCount = await firstSession.invalidationCount
        let secondURLs = await secondSession.requestedURLs.map(\.absoluteString)
        XCTAssertEqual(firstURLs, ["wss://[2001:db8::1]:4242"])
        XCTAssertEqual(firstInvalidationCount, 1)
        XCTAssertEqual(secondURLs, ["wss://[2001:db8::1]:4242"])

        var firstMessageIterator = firstMessages.makeAsyncIterator()
        var firstBinaryIterator = firstBinary.makeAsyncIterator()
        let firstMessage = await firstMessageIterator.next()
        let firstFrame = await firstBinaryIterator.next()
        XCTAssertNil(firstMessage)
        XCTAssertNil(firstFrame)

        let message = MobileServerMessage.legacy(.pong(TokenPayload(token: "new")))
        let frame = TerminalBinaryFrame(streamID: "pane-1", sequence: 7, payload: Data([7]))
        await secondSession.socket.enqueue(.string(String(decoding: try JSONEncoder().encode(message), as: UTF8.self)))
        await secondSession.socket.enqueue(.data(makeFrame(frame)))

        var secondMessageIterator = secondMessages.makeAsyncIterator()
        var secondBinaryIterator = secondBinary.makeAsyncIterator()
        let secondMessage = await secondMessageIterator.next()
        let secondFrame = await secondBinaryIterator.next()
        XCTAssertEqual(secondMessage, message)
        XCTAssertEqual(secondFrame, frame)
    }

    func testRoutesStringJSONDataAndBinaryFrames() async throws {
        let session = TestWebSocketSession()
        let transport = URLSessionControlTransport(
            sessionFactory: TestWebSocketSessionFactory(sessions: [session])
        )
        try await transport.connect(to: endpoint())
        let messages = await transport.incomingMessages()
        let binaryFrames = await transport.incomingBinaryFrames()

        let textMessage = MobileServerMessage.legacy(.pong(TokenPayload(token: "text")))
        let dataMessage = MobileServerMessage.legacy(.pairAccepted(PairAcceptedPayload(token: "data")))
        let binaryFrame = TerminalBinaryFrame(
            streamID: "stream-1",
            sequence: UInt64.max,
            payload: Data([0xde, 0xad])
        )

        await session.socket.enqueue(.string(String(
            decoding: try JSONEncoder().encode(textMessage),
            as: UTF8.self
        )))
        await session.socket.enqueue(.data(try JSONEncoder().encode(dataMessage)))
        await session.socket.enqueue(.data(makeFrame(binaryFrame)))

        var messageIterator = messages.makeAsyncIterator()
        var binaryIterator = binaryFrames.makeAsyncIterator()
        let firstMessage = await messageIterator.next()
        let secondMessage = await messageIterator.next()
        let frame = await binaryIterator.next()
        XCTAssertEqual(firstMessage, textMessage)
        XCTAssertEqual(secondMessage, dataMessage)
        XCTAssertEqual(frame, binaryFrame)
    }

    func testSendUsesJSONTextFrames() async throws {
        let session = TestWebSocketSession()
        let transport = URLSessionControlTransport(
            sessionFactory: TestWebSocketSessionFactory(sessions: [session])
        )
        try await transport.connect(to: endpoint())
        let message = MobileClientMessage.legacy(.ping(TokenPayload(token: "ping")))

        try await transport.send(message)

        let sent = await session.socket.sentMessages
        guard case let .string(json)? = sent.first else {
            return XCTFail("Expected a WebSocket text message")
        }
        XCTAssertEqual(
            try JSONDecoder().decode(MobileClientMessage.self, from: Data(json.utf8)),
            message
        )
    }

    func testMalformedInboundDataFinishesBothStreams() async throws {
        let session = TestWebSocketSession()
        let transport = URLSessionControlTransport(
            sessionFactory: TestWebSocketSessionFactory(sessions: [session])
        )
        try await transport.connect(to: endpoint())
        let messages = await transport.incomingMessages()
        let binaryFrames = await transport.incomingBinaryFrames()

        await session.socket.enqueue(.data(Data([0])))

        var messageIterator = messages.makeAsyncIterator()
        var binaryIterator = binaryFrames.makeAsyncIterator()
        let message = await messageIterator.next()
        let frame = await binaryIterator.next()
        let invalidationCount = await session.invalidationCount
        XCTAssertNil(message)
        XCTAssertNil(frame)
        XCTAssertEqual(invalidationCount, 1)
    }

    func testRejectedPinSurfacesRepairGuidanceWhenTheSocketDies() async throws {
        let session = TestWebSocketSession()
        let factory = TestWebSocketSessionFactory(sessions: [session])
        let transport = URLSessionControlTransport(sessionFactory: factory)
        try await transport.connect(to: endpoint())
        let messages = await transport.incomingMessages()

        // The host presents a certificate that fails the pin, so URLSession
        // cancels the challenge and then drops the socket.
        factory.rejectPinOnLastDelegate()
        await session.socket.failPendingReceives(URLError(.cancelled))

        var messageIterator = messages.makeAsyncIterator()
        let message = await messageIterator.next()
        let failure = await transport.lastFailure()
        XCTAssertNil(message)
        XCTAssertEqual(failure, .certificatePinRejected)
        XCTAssertTrue(
            failure?.localizedDescription.localizedCaseInsensitiveContains("re-pair") == true
        )
    }

    func testOrdinaryDropDoesNotClaimAPinRejection() async throws {
        let session = TestWebSocketSession()
        let transport = URLSessionControlTransport(
            sessionFactory: TestWebSocketSessionFactory(sessions: [session])
        )
        try await transport.connect(to: endpoint())
        let messages = await transport.incomingMessages()

        await session.socket.failPendingReceives(URLError(.networkConnectionLost))

        var messageIterator = messages.makeAsyncIterator()
        let message = await messageIterator.next()
        let failure = await transport.lastFailure()
        XCTAssertNil(message)
        XCTAssertNil(failure)
    }

    private func endpoint() -> HostEndpoint {
        HostEndpoint(
            host: "psyche.local",
            port: 4242,
            certificateFingerprint: fingerprint
        )
    }

    private func makeFrame(_ frame: TerminalBinaryFrame) -> Data {
        let idData = Data(frame.streamID.utf8)
        var data = Data([UInt8(idData.count)])
        data.append(idData)
        for shift in stride(from: 56, through: 0, by: -8) {
            data.append(UInt8((frame.sequence >> UInt64(shift)) & 0xff))
        }
        data.append(frame.payload)
        return data
    }
}

private final class TestWebSocketSessionFactory: ControlWebSocketSessionFactory, @unchecked Sendable {
    private let lock = NSLock()
    private var sessions: [TestWebSocketSession]
    private var storedMakeSessionCount = 0
    private var lastDelegate: PinnedCertificateDelegate?

    init(sessions: [TestWebSocketSession]) {
        self.sessions = sessions
    }

    var makeSessionCount: Int {
        lock.withLock { storedMakeSessionCount }
    }

    func makeSession(delegate: PinnedCertificateDelegate) -> any ControlWebSocketSession {
        lock.withLock {
            storedMakeSessionCount += 1
            lastDelegate = delegate
            return sessions.removeFirst()
        }
    }

    /// Drives the delegate's real fail-closed path — a server-trust challenge
    /// it cannot verify — rather than poking test-only state into it.
    func rejectPinOnLastDelegate() {
        guard let delegate = lock.withLock({ lastDelegate }) else { return }
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let challenge = URLAuthenticationChallenge(
            protectionSpace: URLProtectionSpace(
                host: "psyche.local",
                port: 4242,
                protocol: "https",
                realm: nil,
                authenticationMethod: NSURLAuthenticationMethodServerTrust
            ),
            proposedCredential: nil,
            previousFailureCount: 0,
            failureResponse: nil,
            error: nil,
            sender: TestChallengeSender()
        )
        delegate.urlSession(session, didReceive: challenge) { _, _ in }
    }
}

private final class TestChallengeSender: NSObject, URLAuthenticationChallengeSender, @unchecked Sendable {
    func use(_ credential: URLCredential, for challenge: URLAuthenticationChallenge) {}
    func continueWithoutCredential(for challenge: URLAuthenticationChallenge) {}
    func cancel(_ challenge: URLAuthenticationChallenge) {}
}

private actor TestWebSocketSession: ControlWebSocketSession {
    let socket = TestWebSocketTask()
    private(set) var requestedURLs: [URL] = []
    private(set) var invalidationCount = 0

    func makeWebSocketTask(with url: URL) async -> any ControlWebSocketTask {
        requestedURLs.append(url)
        return socket
    }

    func invalidateAndCancel() async {
        invalidationCount += 1
    }
}

private actor TestWebSocketTask: ControlWebSocketTask {
    private(set) var resumeCount = 0
    private(set) var cancelCount = 0
    private(set) var sentMessages: [URLSessionWebSocketTask.Message] = []
    private var queuedMessages: [URLSessionWebSocketTask.Message] = []
    private var receivers: [CheckedContinuation<URLSessionWebSocketTask.Message, any Error>] = []
    private var pendingFailure: (any Error)?

    func resume() async {
        resumeCount += 1
    }

    func cancel() async {
        cancelCount += 1
        let waiting = receivers
        receivers.removeAll()
        waiting.forEach { $0.resume(throwing: CancellationError()) }
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        sentMessages.append(message)
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        if !queuedMessages.isEmpty {
            return queuedMessages.removeFirst()
        }
        if let pendingFailure {
            throw pendingFailure
        }
        return try await withCheckedThrowingContinuation { continuation in
            receivers.append(continuation)
        }
    }

    /// Fails whoever is waiting, and whoever asks next — the receive loop may
    /// not have reached `receive()` yet when a test drops the socket.
    func failPendingReceives(_ error: any Error) {
        pendingFailure = error
        let waiting = receivers
        receivers.removeAll()
        waiting.forEach { $0.resume(throwing: error) }
    }

    func enqueue(_ message: URLSessionWebSocketTask.Message) {
        if !receivers.isEmpty {
            receivers.removeFirst().resume(returning: message)
        } else {
            queuedMessages.append(message)
        }
    }
}
