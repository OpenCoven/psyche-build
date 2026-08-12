import Foundation
import XCTest
@testable import PsycheCore

final class BonjourHostDiscoveryTests: XCTestCase {
    private let fingerprint = "0c8893630b087f7ab19a71c016e599cebc3b5235fd449e9917a43850edddaa38"

    func testParsesAWellFormedRecordAndNormalizesTheFingerprint() throws {
        let colonSeparated = fingerprint.uppercased().chunked(every: 2).joined(separator: ":")

        let host = try XCTUnwrap(BonjourHostParser.host(from: makeRecord(
            txt: ["proto": "2", "versions": "2,3", "serverId": "server-1", "fingerprint": colonSeparated]
        )))

        XCTAssertEqual(host.serverID, "server-1")
        XCTAssertEqual(host.serverName, "Studio")
        XCTAssertEqual(host.domain, "local.")
        XCTAssertEqual(host.certificateFingerprint, fingerprint)
        XCTAssertEqual(host.supportedVersions, [2, 3])
    }

    func testTXTKeysAreMatchedCaseInsensitively() throws {
        let host = try XCTUnwrap(BonjourHostParser.host(from: makeRecord(
            txt: ["ServerId": "server-1", "FingerPrint": fingerprint, "Versions": "3"]
        )))

        XCTAssertEqual(host.serverID, "server-1")
        XCTAssertEqual(host.supportedVersions, [3])
    }

    func testFallsBackToTheLegacyProtoKeyWhenVersionsIsAbsent() throws {
        let host = try XCTUnwrap(BonjourHostParser.host(from: makeRecord(
            txt: ["serverId": "server-1", "fingerprint": fingerprint, "proto": "2"]
        )))

        XCTAssertEqual(host.supportedVersions, [2])
    }

    func testDropsRecordsWithAMalformedOrMissingFingerprint() {
        let malformed = [
            String(repeating: "a", count: 63),
            String(repeating: "z", count: 64),
            ""
        ]

        for value in malformed {
            XCTAssertNil(
                BonjourHostParser.host(from: makeRecord(
                    txt: ["serverId": "server-1", "fingerprint": value, "versions": "3"]
                )),
                "Expected fingerprint \(value) to be dropped"
            )
        }

        XCTAssertNil(BonjourHostParser.host(from: makeRecord(
            txt: ["serverId": "server-1", "versions": "3"]
        )))
    }

    func testDropsRecordsWithNoSupportedProtocolVersion() {
        let unsupported = [
            ["serverId": "server-1", "fingerprint": fingerprint, "versions": "1,99"],
            ["serverId": "server-1", "fingerprint": fingerprint, "versions": "not-a-number"],
            ["serverId": "server-1", "fingerprint": fingerprint, "proto": "1"],
            ["serverId": "server-1", "fingerprint": fingerprint]
        ]

        for txt in unsupported {
            XCTAssertNil(
                BonjourHostParser.host(from: makeRecord(txt: txt)),
                "Expected \(txt) to be dropped"
            )
        }
    }

    func testIgnoresUnsupportedVersionsAlongsideSupportedOnes() throws {
        let host = try XCTUnwrap(BonjourHostParser.host(from: makeRecord(
            txt: ["serverId": "server-1", "fingerprint": fingerprint, "versions": "99,3,1"]
        )))

        XCTAssertEqual(host.supportedVersions, [3])
    }

    func testDropsRecordsWithAMissingOrBlankServerID() {
        XCTAssertNil(BonjourHostParser.host(from: makeRecord(
            txt: ["fingerprint": fingerprint, "versions": "3"]
        )))
        XCTAssertNil(BonjourHostParser.host(from: makeRecord(
            txt: ["serverId": "   ", "fingerprint": fingerprint, "versions": "3"]
        )))
    }

    func testFallsBackToTheServerIDWhenTheServiceNameIsBlank() throws {
        let host = try XCTUnwrap(BonjourHostParser.host(from: makeRecord(
            name: "  ",
            txt: ["serverId": "server-1", "fingerprint": fingerprint, "versions": "3"]
        )))

        XCTAssertEqual(host.serverName, "server-1")
    }

    func testIdentityIsTheServerIDNotTheServiceName() {
        let records = [
            makeRecord(name: "Studio", txt: [
                "serverId": "server-1", "fingerprint": fingerprint, "versions": "3"
            ]),
            makeRecord(name: "Studio Renamed", txt: [
                "serverId": "server-1", "fingerprint": String(repeating: "b", count: 64), "versions": "3"
            ]),
            makeRecord(name: "Studio", txt: [
                "serverId": "server-0", "fingerprint": fingerprint, "versions": "3"
            ])
        ]

        let hosts = BonjourHostParser.hosts(from: records)

        XCTAssertEqual(hosts.map(\.serverID), ["server-0", "server-1"])
        XCTAssertEqual(hosts.last?.serverName, "Studio")
    }

    func testMalformedRecordsDoNotSuppressTheGoodOnesBesideThem() {
        let records = [
            makeRecord(txt: ["serverId": "server-1", "fingerprint": "bogus", "versions": "3"]),
            makeRecord(txt: [:]),
            makeRecord(name: "Good", txt: [
                "serverId": "server-2", "fingerprint": fingerprint, "versions": "3"
            ])
        ]

        let hosts = BonjourHostParser.hosts(from: records)

        XCTAssertEqual(hosts.map(\.serverID), ["server-2"])
    }

    func testDiscoveryPublishesOnlyParseableHostsAndStopsTheBrowser() async throws {
        let browser = FakeBonjourBrowser()
        let resolver = FakeBonjourServiceResolver(endpoints: [
            .init(name: "Good", domain: "local."): .init(host: "studio.local", port: 47_123)
        ])
        let discovery = BonjourHostDiscovery(browser: browser, resolver: resolver)

        let stream = await discovery.start()
        var iterator = stream.makeAsyncIterator()

        browser.emit([
            makeRecord(txt: ["serverId": "server-1", "fingerprint": "bogus", "versions": "3"]),
            makeRecord(name: "Good", txt: [
                "serverId": "server-2", "fingerprint": fingerprint, "versions": "3"
            ])
        ])

        let batch = await iterator.next()
        XCTAssertEqual(batch?.map(\.serverID), ["server-2"])
        XCTAssertEqual(batch?.first?.endpoint.host, "studio.local")
        XCTAssertEqual(batch?.first?.endpoint.port, 47_123)
        XCTAssertEqual(browser.startCount, 1)

        await discovery.stop()
        XCTAssertEqual(browser.stopCount, 1)
    }

    func testDiscoveryBuildsAConnectableEndpointFromTheResolvedService() async throws {
        let browser = FakeBonjourBrowser()
        let resolver = FakeBonjourServiceResolver(endpoints: [
            .init(name: "Studio", domain: "local."): .init(host: "studio.local", port: 47_123)
        ])
        let discovery = BonjourHostDiscovery(browser: browser, resolver: resolver)

        let stream = await discovery.start()
        var iterator = stream.makeAsyncIterator()
        browser.emit([
            makeRecord(txt: ["serverId": "server-1", "fingerprint": fingerprint, "versions": "3"])
        ])

        let batch = await iterator.next()
        let hosts = try XCTUnwrap(batch)
        XCTAssertEqual(hosts.first?.endpoint.host, "studio.local")
        XCTAssertEqual(hosts.first?.endpoint.port, 47_123)
        XCTAssertEqual(hosts.first?.endpoint.certificateFingerprint, fingerprint)
        let requests = await resolver.requests()
        XCTAssertEqual(requests, [.init(name: "Studio", domain: "local.")])
    }

    func testDiscoveryDropsResolverFailuresAndInvalidLocatorsWithoutHidingAValidHost() async throws {
        let browser = FakeBonjourBrowser()
        let resolver = FakeBonjourServiceResolver(results: [
            .init(name: "Timeout", domain: "local."): .failure(.timeout),
            .init(name: "Failure", domain: "local."): .failure(.failed),
            .init(name: "Whitespace", domain: "local."): .success(.init(host: " \n ", port: 47_123)),
            .init(name: "Zero", domain: "local."): .success(.init(host: "zero.local", port: 0)),
            .init(name: "Negative", domain: "local."): .success(.init(host: "negative.local", port: -1)),
            .init(name: "OutOfRange", domain: "local."): .success(.init(host: "range.local", port: 65_536)),
            .init(name: "Good", domain: "local."): .success(.init(host: "good.local", port: 47_123))
        ])
        let discovery = BonjourHostDiscovery(browser: browser, resolver: resolver)

        let stream = await discovery.start()
        var iterator = stream.makeAsyncIterator()
        browser.emit([
            makeRecord(name: "Malicious", txt: ["serverId": "malicious", "fingerprint": "bogus", "versions": "3"]),
            makeRecord(name: "Timeout", txt: ["serverId": "timeout", "fingerprint": fingerprint, "versions": "3"]),
            makeRecord(name: "Failure", txt: ["serverId": "failure", "fingerprint": fingerprint, "versions": "3"]),
            makeRecord(name: "Whitespace", txt: ["serverId": "whitespace", "fingerprint": fingerprint, "versions": "3"]),
            makeRecord(name: "Zero", txt: ["serverId": "zero", "fingerprint": fingerprint, "versions": "3"]),
            makeRecord(name: "Negative", txt: ["serverId": "negative", "fingerprint": fingerprint, "versions": "3"]),
            makeRecord(name: "OutOfRange", txt: ["serverId": "out-of-range", "fingerprint": fingerprint, "versions": "3"]),
            makeRecord(name: "Good", txt: ["serverId": "good", "fingerprint": fingerprint, "versions": "3"])
        ])

        let batch = await iterator.next()
        let hosts = try XCTUnwrap(batch)
        XCTAssertEqual(hosts.map(\.serverID), ["good"])
        XCTAssertEqual(hosts.first?.endpoint.host, "good.local")
    }

    func testDiscoveryDeduplicatesSuccessfulHostsByServerID() async throws {
        let browser = FakeBonjourBrowser()
        let resolver = FakeBonjourServiceResolver(endpoints: [
            .init(name: "First", domain: "local."): .init(host: "first.local", port: 47_123),
            .init(name: "Second", domain: "local."): .init(host: "second.local", port: 47_124)
        ])
        let discovery = BonjourHostDiscovery(browser: browser, resolver: resolver)

        let stream = await discovery.start()
        var iterator = stream.makeAsyncIterator()
        browser.emit([
            makeRecord(name: "First", txt: ["serverId": "server-1", "fingerprint": fingerprint, "versions": "3"]),
            makeRecord(name: "Second", txt: ["serverId": "server-1", "fingerprint": fingerprint, "versions": "3"])
        ])

        let batch = await iterator.next()
        let hosts = try XCTUnwrap(batch)
        XCTAssertEqual(hosts.map(\.serverID), ["server-1"])
        XCTAssertEqual(hosts.first?.endpoint.host, "first.local")
        let requests = await resolver.requests()
        XCTAssertEqual(requests, [.init(name: "First", domain: "local.")])
    }

    func testStoppingDiscoveryCancelsAnInFlightResolution() async {
        let browser = FakeBonjourBrowser()
        let resolver = CancelTrackingBonjourServiceResolver()
        let discovery = BonjourHostDiscovery(browser: browser, resolver: resolver)

        let stream = await discovery.start()
        browser.emit([
            makeRecord(txt: ["serverId": "server-1", "fingerprint": fingerprint, "versions": "3"])
        ])

        await resolver.waitUntilStarted()

        await discovery.stop()

        await resolver.waitUntilCancelled()
        let cancellationCount = await resolver.cancellationCount
        XCTAssertEqual(cancellationCount, 1)
        withExtendedLifetime(stream) {}
    }

    func testStoppingDiscoveryFinishesWithoutPublishingACancelledBatch() async {
        let blocked = BonjourServiceKey(name: "Blocked", domain: "local.")
        let started = XCTestExpectation(description: "blocked resolution started")
        let cancelled = XCTestExpectation(description: "blocked resolution cancelled")
        let events = ResolverEventLog(started: [blocked: started], cancelled: [blocked: cancelled])
        let browser = FakeBonjourBrowser()
        let resolver = ControlledBonjourServiceResolver(
            modes: [blocked: .blocked],
            events: events
        )
        let discovery = BonjourHostDiscovery(browser: browser, resolver: resolver)
        let stream = await discovery.start()
        let recorder = StreamBatchRecorder()
        let consumer = Task {
            var iterator = stream.makeAsyncIterator()
            recorder.record(await iterator.next())
        }

        browser.emit([
            makeRecord(name: "Blocked", txt: ["serverId": "blocked", "fingerprint": fingerprint, "versions": "3"])
        ])
        await fulfillment(of: [started], timeout: 1)

        await discovery.stop()

        await fulfillment(of: [cancelled, recorder.received], timeout: 1)
        XCTAssertNil(recorder.firstBatch)
        XCTAssertEqual(events.cancellationCount(for: blocked), 1)
        consumer.cancel()
    }

    func testStartingNewObservationFinishesSupersededStreamWithoutPublishingACancelledBatch() async {
        let old = BonjourServiceKey(name: "Old", domain: "local.")
        let fresh = BonjourServiceKey(name: "Fresh", domain: "local.")
        let oldStarted = XCTestExpectation(description: "old resolution started")
        let oldCancelled = XCTestExpectation(description: "old resolution cancelled")
        let freshStarted = XCTestExpectation(description: "fresh resolution started")
        let events = ResolverEventLog(
            started: [old: oldStarted, fresh: freshStarted],
            cancelled: [old: oldCancelled]
        )
        let browser = FakeBonjourBrowser()
        let resolver = ControlledBonjourServiceResolver(
            modes: [
                old: .blocked,
                fresh: .endpoint(.init(host: "fresh.local", port: 47_123))
            ],
            events: events
        )
        let discovery = BonjourHostDiscovery(browser: browser, resolver: resolver)
        let oldStream = await discovery.start()
        let oldRecorder = StreamBatchRecorder()
        let oldConsumer = Task {
            var iterator = oldStream.makeAsyncIterator()
            oldRecorder.record(await iterator.next())
        }

        browser.emit([
            makeRecord(name: "Old", txt: ["serverId": "old", "fingerprint": fingerprint, "versions": "3"])
        ])
        await fulfillment(of: [oldStarted], timeout: 1)

        let freshStream = await discovery.start()
        let freshRecorder = StreamBatchRecorder()
        let freshConsumer = Task {
            var iterator = freshStream.makeAsyncIterator()
            freshRecorder.record(await iterator.next())
        }
        browser.emit([
            makeRecord(name: "Fresh", txt: ["serverId": "fresh", "fingerprint": fingerprint, "versions": "3"])
        ])

        await fulfillment(of: [oldCancelled, oldRecorder.received, freshStarted, freshRecorder.received], timeout: 1)
        XCTAssertNil(oldRecorder.firstBatch)
        XCTAssertEqual(freshRecorder.firstBatch?.map(\.serverID), ["fresh"])
        XCTAssertEqual(events.cancellationCount(for: old), 1)
        await discovery.stop()
        oldConsumer.cancel()
        freshConsumer.cancel()
    }

    func testDiscoveryPublishesAValidHostWithoutWaitingForAPrecedingBlockedResolver() async {
        let blocked = BonjourServiceKey(name: "Blocked", domain: "local.")
        let good = BonjourServiceKey(name: "Good", domain: "local.")
        let blockedStarted = XCTestExpectation(description: "blocked resolution started")
        let goodStarted = XCTestExpectation(description: "good resolution started")
        let events = ResolverEventLog(started: [blocked: blockedStarted, good: goodStarted])
        let browser = FakeBonjourBrowser()
        let resolver = ControlledBonjourServiceResolver(
            modes: [
                blocked: .blocked,
                good: .endpoint(.init(host: "good.local", port: 47_123))
            ],
            events: events
        )
        let discovery = BonjourHostDiscovery(browser: browser, resolver: resolver)
        let stream = await discovery.start()
        let recorder = StreamBatchRecorder()
        let consumer = Task {
            var iterator = stream.makeAsyncIterator()
            recorder.record(await iterator.next())
        }

        browser.emit([
            makeRecord(name: "Blocked", txt: ["serverId": "blocked", "fingerprint": fingerprint, "versions": "3"]),
            makeRecord(name: "Good", txt: ["serverId": "good", "fingerprint": fingerprint, "versions": "3"])
        ])

        await fulfillment(of: [blockedStarted, goodStarted, recorder.received], timeout: 1)
        XCTAssertEqual(recorder.firstBatch?.map(\.serverID), ["good"])
        await discovery.stop()
        consumer.cancel()
    }

    func testSupersededBrowseBatchCancelsOldWorkAndPublishesOnlyTheLatestHosts() async {
        let old = BonjourServiceKey(name: "Old", domain: "local.")
        let fresh = BonjourServiceKey(name: "Fresh", domain: "local.")
        let oldStarted = XCTestExpectation(description: "old resolution started")
        let oldCancelled = XCTestExpectation(description: "old resolution cancelled")
        let freshStarted = XCTestExpectation(description: "fresh resolution started")
        let events = ResolverEventLog(
            started: [old: oldStarted, fresh: freshStarted],
            cancelled: [old: oldCancelled]
        )
        let browser = FakeBonjourBrowser()
        let resolver = ControlledBonjourServiceResolver(
            modes: [
                old: .blocked,
                fresh: .endpoint(.init(host: "fresh.local", port: 47_123))
            ],
            events: events
        )
        let discovery = BonjourHostDiscovery(browser: browser, resolver: resolver)
        let stream = await discovery.start()
        let recorder = StreamBatchRecorder()
        let consumer = Task {
            var iterator = stream.makeAsyncIterator()
            recorder.record(await iterator.next())
        }

        browser.emit([
            makeRecord(name: "Old", txt: ["serverId": "old", "fingerprint": fingerprint, "versions": "3"])
        ])
        await fulfillment(of: [oldStarted], timeout: 1)
        browser.emit([
            makeRecord(name: "Fresh", txt: ["serverId": "fresh", "fingerprint": fingerprint, "versions": "3"])
        ])

        await fulfillment(of: [oldCancelled, freshStarted, recorder.received], timeout: 1)
        XCTAssertEqual(recorder.firstBatch?.map(\.serverID), ["fresh"])
        XCTAssertEqual(events.cancellationCount(for: old), 1)
        await discovery.stop()
        consumer.cancel()
    }

    func testResolverCancellationBeforeContinuationRegistrationDoesNotStartOrRetainWork() async throws {
        let boundary = ResolverRegistrationBoundary()
        let lifecycle = NetServiceResolutionLifecycle(
            beforeContinuationRegistration: {
                boundary.arriveAndWait()
            },
            didCreateTimeoutTask: {
                boundary.recordTimeoutTask()
            },
            didStartService: {
                boundary.recordServiceStart()
            }
        )
        let resolution = NetServiceResolution(
            name: "Studio",
            domain: "local.",
            timeout: 60,
            lifecycle: lifecycle
        )
        let task = Task {
            try await resolution.resolve()
        }

        await fulfillment(of: [boundary.registrationReached], timeout: 1)
        task.cancel()
        boundary.allowRegistration()

        do {
            _ = try await task.value
            XCTFail("Expected cancellation")
        } catch is CancellationError {
            // Expected.
        }

        XCTAssertEqual(boundary.timeoutTaskCount, 0)
        XCTAssertEqual(boundary.serviceStartCount, 0)
        XCTAssertFalse(resolution.hasPendingResolution)
    }

    func testResolverCancellationAfterRegistrationBeforeTimerRetentionDoesNotRetainWork() async throws {
        let boundary = ResolverPostRegistrationBoundary()
        let lifecycle = NetServiceResolutionLifecycle(
            afterContinuationRegistration: {
                boundary.arriveAndWait()
            },
            didAttemptTimerRetention: {
                boundary.timerRetentionAttempted.fulfill()
            },
            didCreateTimeoutTask: {
                boundary.recordTimeoutTask()
            },
            didStartService: {
                boundary.recordServiceStart()
            }
        )
        let resolution = NetServiceResolution(
            name: "Studio",
            domain: "local.",
            timeout: 60,
            lifecycle: lifecycle
        )
        let task = Task {
            try await resolution.resolve()
        }

        await fulfillment(of: [boundary.registrationReached], timeout: 1)
        task.cancel()
        boundary.allowTimerRetention()
        await fulfillment(of: [boundary.timerRetentionAttempted], timeout: 1)

        do {
            _ = try await task.value
            XCTFail("Expected cancellation")
        } catch is CancellationError {
            // Expected.
        }

        XCTAssertEqual(boundary.timeoutTaskCount, 0)
        XCTAssertEqual(boundary.serviceStartCount, 0)
        XCTAssertFalse(resolution.hasPendingResolution)
    }

    private func makeRecord(
        name: String = "Studio",
        domain: String = "local.",
        txt: [String: String]
    ) -> BonjourServiceRecord {
        BonjourServiceRecord(name: name, domain: domain, txt: txt)
    }
}

private struct BonjourServiceKey: Hashable, Sendable {
    let name: String
    let domain: String
}

private enum FakeBonjourServiceResolverError: Error {
    case timeout
    case failed
}

private actor FakeBonjourServiceResolver: BonjourServiceResolving {
    private let results: [BonjourServiceKey: Result<ResolvedBonjourEndpoint, FakeBonjourServiceResolverError>]
    private var resolvedRequests: [BonjourServiceKey] = []

    init(endpoints: [BonjourServiceKey: ResolvedBonjourEndpoint]) {
        self.results = endpoints.mapValues(Result.success)
    }

    init(results: [BonjourServiceKey: Result<ResolvedBonjourEndpoint, FakeBonjourServiceResolverError>]) {
        self.results = results
    }

    func resolve(name: String, domain: String) async throws -> ResolvedBonjourEndpoint {
        let key = BonjourServiceKey(name: name, domain: domain)
        resolvedRequests.append(key)
        guard let result = results[key] else { throw FakeBonjourServiceResolverError.failed }
        return try result.get()
    }

    func requests() -> [BonjourServiceKey] {
        resolvedRequests
    }
}

private actor CancelTrackingBonjourServiceResolver: BonjourServiceResolving {
    private var startContinuation: CheckedContinuation<Void, Never>?
    private var cancellationContinuation: CheckedContinuation<Void, Never>?
    private var started = false
    private var cancelled = 0

    var cancellationCount: Int { cancelled }

    func resolve(name: String, domain: String) async throws -> ResolvedBonjourEndpoint {
        started = true
        startContinuation?.resume()
        startContinuation = nil
        do {
            try await Task.sleep(for: .seconds(60))
            throw FakeBonjourServiceResolverError.failed
        } catch is CancellationError {
            cancelled += 1
            cancellationContinuation?.resume()
            cancellationContinuation = nil
            throw CancellationError()
        }
    }

    func waitUntilStarted() async {
        if started { return }
        await withCheckedContinuation { startContinuation = $0 }
    }

    func waitUntilCancelled() async {
        if cancelled > 0 { return }
        await withCheckedContinuation { cancellationContinuation = $0 }
    }
}

private enum ControlledBonjourServiceResolution: Sendable {
    case blocked
    case endpoint(ResolvedBonjourEndpoint)
}

private actor ControlledBonjourServiceResolver: BonjourServiceResolving {
    private let modes: [BonjourServiceKey: ControlledBonjourServiceResolution]
    private let events: ResolverEventLog

    init(
        modes: [BonjourServiceKey: ControlledBonjourServiceResolution],
        events: ResolverEventLog
    ) {
        self.modes = modes
        self.events = events
    }

    func resolve(name: String, domain: String) async throws -> ResolvedBonjourEndpoint {
        let key = BonjourServiceKey(name: name, domain: domain)
        events.recordStart(for: key)
        switch modes[key] {
        case .endpoint(let endpoint):
            return endpoint
        case .blocked:
            do {
                try await Task.sleep(for: .seconds(60))
                throw FakeBonjourServiceResolverError.failed
            } catch is CancellationError {
                events.recordCancellation(for: key)
                throw CancellationError()
            }
        case nil:
            throw FakeBonjourServiceResolverError.failed
        }
    }
}

private final class ResolverEventLog: @unchecked Sendable {
    private let lock = NSLock()
    private let started: [BonjourServiceKey: XCTestExpectation]
    private let cancelled: [BonjourServiceKey: XCTestExpectation]
    private var startCounts: [BonjourServiceKey: Int] = [:]
    private var cancellationCounts: [BonjourServiceKey: Int] = [:]

    init(
        started: [BonjourServiceKey: XCTestExpectation] = [:],
        cancelled: [BonjourServiceKey: XCTestExpectation] = [:]
    ) {
        self.started = started
        self.cancelled = cancelled
    }

    func recordStart(for key: BonjourServiceKey) {
        let expectation = lock.withLock { () -> XCTestExpectation? in
            startCounts[key, default: 0] += 1
            return started[key]
        }
        expectation?.fulfill()
    }

    func recordCancellation(for key: BonjourServiceKey) {
        let expectation = lock.withLock { () -> XCTestExpectation? in
            cancellationCounts[key, default: 0] += 1
            return cancelled[key]
        }
        expectation?.fulfill()
    }

    func cancellationCount(for key: BonjourServiceKey) -> Int {
        lock.withLock { cancellationCounts[key, default: 0] }
    }
}

private final class StreamBatchRecorder: @unchecked Sendable {
    let received = XCTestExpectation(description: "stream produced its first result")
    private let lock = NSLock()
    private var storedFirstBatch: [DiscoveredHost]??

    var firstBatch: [DiscoveredHost]? {
        lock.withLock { storedFirstBatch ?? nil }
    }

    func record(_ batch: [DiscoveredHost]?) {
        lock.withLock { storedFirstBatch = batch }
        received.fulfill()
    }
}

private final class ResolverRegistrationBoundary: @unchecked Sendable {
    let registrationReached = XCTestExpectation(description: "resolver reached registration boundary")
    private let lock = NSLock()
    private let registrationGate = DispatchSemaphore(value: 0)
    private var storedTimeoutTaskCount = 0
    private var storedServiceStartCount = 0

    var timeoutTaskCount: Int { lock.withLock { storedTimeoutTaskCount } }
    var serviceStartCount: Int { lock.withLock { storedServiceStartCount } }

    func arriveAndWait() {
        registrationReached.fulfill()
        registrationGate.wait()
    }

    func allowRegistration() {
        registrationGate.signal()
    }

    func recordTimeoutTask() {
        lock.withLock { storedTimeoutTaskCount += 1 }
    }

    func recordServiceStart() {
        lock.withLock { storedServiceStartCount += 1 }
    }
}

private final class ResolverPostRegistrationBoundary: @unchecked Sendable {
    let registrationReached = XCTestExpectation(description: "resolver registered continuation")
    let timerRetentionAttempted = XCTestExpectation(description: "resolver attempted timer retention")
    private let lock = NSLock()
    private let timerRetentionGate = DispatchSemaphore(value: 0)
    private var storedTimeoutTaskCount = 0
    private var storedServiceStartCount = 0

    var timeoutTaskCount: Int { lock.withLock { storedTimeoutTaskCount } }
    var serviceStartCount: Int { lock.withLock { storedServiceStartCount } }

    func arriveAndWait() {
        registrationReached.fulfill()
        timerRetentionGate.wait()
    }

    func allowTimerRetention() {
        timerRetentionGate.signal()
    }

    func recordTimeoutTask() {
        lock.withLock { storedTimeoutTaskCount += 1 }
    }

    func recordServiceStart() {
        lock.withLock { storedServiceStartCount += 1 }
    }
}

private final class FakeBonjourBrowser: BonjourBrowsing, @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: AsyncStream<[BonjourServiceRecord]>.Continuation?
    private var storedStartCount = 0
    private var storedStopCount = 0

    var startCount: Int { lock.withLock { storedStartCount } }
    var stopCount: Int { lock.withLock { storedStopCount } }

    func records() -> AsyncStream<[BonjourServiceRecord]> {
        let (stream, continuation) = AsyncStream<[BonjourServiceRecord]>.makeStream()
        lock.withLock { self.continuation = continuation }
        return stream
    }

    func start() {
        lock.withLock { storedStartCount += 1 }
    }

    func stop() {
        lock.withLock { storedStopCount += 1 }
        lock.withLock { continuation }?.finish()
    }

    func emit(_ records: [BonjourServiceRecord]) {
        lock.withLock { continuation }?.yield(records)
    }
}

private extension String {
    func chunked(every size: Int) -> [Substring] {
        stride(from: 0, to: count, by: size).map { offset in
            let start = index(startIndex, offsetBy: offset)
            let end = index(start, offsetBy: size, limitedBy: endIndex) ?? endIndex
            return self[start..<end]
        }
    }
}
