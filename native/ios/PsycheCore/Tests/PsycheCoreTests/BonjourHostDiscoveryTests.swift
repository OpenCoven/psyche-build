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
        let host = try XCTUnwrap(batch?.first.flatMap { resolvedHost(from: $0) })
        XCTAssertEqual(host.endpoint.host, "studio.local")
        XCTAssertEqual(host.endpoint.port, 47_123)
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
        let host = try XCTUnwrap(hosts.first.flatMap { resolvedHost(from: $0) })
        XCTAssertEqual(host.endpoint.host, "studio.local")
        XCTAssertEqual(host.endpoint.port, 47_123)
        XCTAssertEqual(host.endpoint.certificateFingerprint, fingerprint)
        let requests = await resolver.requests()
        XCTAssertEqual(requests, [.init(name: "Studio", domain: "local.")])
    }

    func testDiscoveryMapsResolverFailuresAndInvalidEndpointsToBoundedAvailability() async throws {
        let timeoutBatch = try await firstDiscoveryBatch(
            browser: FakeBonjourBrowser(),
            resolver: FakeBonjourServiceResolver(results: [
                .init(name: "Timeout", domain: "local."): .bonjourError(.timedOut)
            ]),
            records: [
                makeRecord(name: "Timeout", txt: [
                    "serverId": "timeout", "fingerprint": fingerprint, "versions": "3"
                ])
            ]
        )
        XCTAssertEqual(timeoutBatch.map(\.serverID), ["timeout"])
        XCTAssertEqual(failure(from: timeoutBatch[0]), .timedOut)

        let unresolvedBatch = try await firstDiscoveryBatch(
            browser: FakeBonjourBrowser(),
            resolver: FakeBonjourServiceResolver(results: [
                .init(name: "Failure", domain: "local."): .otherError(FakeBonjourServiceResolverError.failed)
            ]),
            records: [
                makeRecord(name: "Failure", txt: [
                    "serverId": "failure", "fingerprint": fingerprint, "versions": "3"
                ])
            ]
        )
        XCTAssertEqual(unresolvedBatch.map(\.serverID), ["failure"])
        XCTAssertEqual(failure(from: unresolvedBatch[0]), .unresolved)

        let typedUnresolvedBatch = try await firstDiscoveryBatch(
            browser: FakeBonjourBrowser(),
            resolver: FakeBonjourServiceResolver(results: [
                .init(name: "TypedUnresolved", domain: "local."): .bonjourError(.unresolved)
            ]),
            records: [
                makeRecord(name: "TypedUnresolved", txt: [
                    "serverId": "typed-unresolved", "fingerprint": fingerprint, "versions": "3"
                ])
            ]
        )
        XCTAssertEqual(typedUnresolvedBatch.map(\.serverID), ["typed-unresolved"])
        XCTAssertEqual(failure(from: typedUnresolvedBatch[0]), .unresolved)

        let typedInvalidBatch = try await firstDiscoveryBatch(
            browser: FakeBonjourBrowser(),
            resolver: FakeBonjourServiceResolver(results: [
                .init(name: "TypedInvalid", domain: "local."): .bonjourError(.invalidEndpoint)
            ]),
            records: [
                makeRecord(name: "TypedInvalid", txt: [
                    "serverId": "typed-invalid", "fingerprint": fingerprint, "versions": "3"
                ])
            ]
        )
        XCTAssertEqual(typedInvalidBatch.map(\.serverID), ["typed-invalid"])
        XCTAssertEqual(failure(from: typedInvalidBatch[0]), .invalidEndpoint)

        let invalidBatch = try await firstDiscoveryBatch(
            browser: FakeBonjourBrowser(),
            resolver: FakeBonjourServiceResolver(results: [
                .init(name: "Whitespace", domain: "local."): .endpoint(.init(host: " \n ", port: 47_123))
            ]),
            records: [
                makeRecord(name: "Whitespace", txt: [
                    "serverId": "whitespace", "fingerprint": fingerprint, "versions": "3"
                ])
            ]
        )
        XCTAssertEqual(invalidBatch.map(\.serverID), ["whitespace"])
        XCTAssertEqual(failure(from: invalidBatch[0]), .invalidEndpoint)
    }

    func testDiscoveryPublishesMixedSuccessfulAndInvalidEndpointRowsTogether() async throws {
        let bad = BonjourServiceKey(name: "Bad", domain: "local.")
        let good = BonjourServiceKey(name: "Good", domain: "local.")
        let goodReady = XCTestExpectation(description: "good resolution started")
        let browser = FakeBonjourBrowser()
        let resolver = SequencedBonjourServiceResolver(
            plans: [
                bad: [.endpoint(.init(host: " \n ", port: 47_123))],
                good: [.blocked, .endpoint(.init(host: "good.local", port: 47_123))]
            ],
            events: .init(blocked: [good: goodReady])
        )
        let discovery = BonjourHostDiscovery(browser: browser, resolver: resolver)

        let stream = await discovery.start()
        var iterator = stream.makeAsyncIterator()
        browser.emit([
            makeRecord(name: "Bad", txt: ["serverId": "bad", "fingerprint": fingerprint, "versions": "3"]),
            makeRecord(name: "Good", txt: ["serverId": "good", "fingerprint": fingerprint, "versions": "3"])
        ])

        let firstBatchValue = await iterator.next()
        let firstBatch = try XCTUnwrap(firstBatchValue)
        XCTAssertEqual(firstBatch.map(\.serverID), ["bad"])
        XCTAssertEqual(failure(from: firstBatch[0]), .invalidEndpoint)

        await fulfillment(of: [goodReady], timeout: 1)
        await resolver.resume(good, with: .init(host: "good.local", port: 47_123))

        let secondBatchValue = await iterator.next()
        let secondBatch = try XCTUnwrap(secondBatchValue)
        XCTAssertEqual(secondBatch.map(\.serverID), ["bad", "good"])
        XCTAssertEqual(failure(from: secondBatch[0]), .invalidEndpoint)
        XCTAssertEqual(resolvedHost(from: secondBatch[1])?.endpoint.host, "good.local")
        await discovery.stop()
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
        XCTAssertEqual(resolvedHost(from: hosts[0])?.endpoint.host, "first.local")
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
        XCTAssertEqual(browser.stopCount, 0)
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

    func testUnchangedRefreshKeepsResolvedHostsWhenLaterResolutionCompletesFirst() async {
        let alpha = BonjourServiceKey(name: "Alpha", domain: "local.")
        let beta = BonjourServiceKey(name: "Beta", domain: "local.")
        let alphaRefreshReady = XCTestExpectation(description: "alpha refresh is ready")
        let betaRefreshReady = XCTestExpectation(description: "beta refresh is ready")
        let events = SequencedResolverEvents(blocked: [
            alpha: alphaRefreshReady,
            beta: betaRefreshReady
        ])
        let resolver = SequencedBonjourServiceResolver(
            plans: [
                alpha: [.endpoint(.init(host: "alpha.local", port: 47_123)), .blocked],
                beta: [.endpoint(.init(host: "beta.local", port: 47_124)), .blocked]
            ],
            events: events
        )
        let browser = FakeBonjourBrowser()
        let discovery = BonjourHostDiscovery(browser: browser, resolver: resolver)
        let stream = await discovery.start()
        let recorder = SnapshotBatchRecorder(expectedInitialIDs: ["alpha", "beta"])
        let consumer = Task {
            for await batch in stream {
                recorder.record(batch)
            }
        }
        let records = [
            makeRecord(name: "Alpha", txt: ["serverId": "alpha", "fingerprint": fingerprint, "versions": "3"]),
            makeRecord(name: "Beta", txt: ["serverId": "beta", "fingerprint": fingerprint, "versions": "3"])
        ]

        browser.emit(records)
        await fulfillment(of: [recorder.initialFullView], timeout: 1)

        recorder.beginRefresh()
        browser.emit(records)
        await fulfillment(of: [alphaRefreshReady, betaRefreshReady], timeout: 1)
        await resolver.resume(beta, with: .init(host: "beta.local", port: 47_124))

        await fulfillment(of: [recorder.refreshPublished], timeout: 1)
        XCTAssertEqual(recorder.firstRefreshBatch?.map(\.serverID), ["alpha", "beta"])

        await resolver.resume(alpha, with: .init(host: "alpha.local", port: 47_123))
        await discovery.stop()
        consumer.cancel()
    }

    func testRefreshRemovesServicesAbsentFromTheLatestSnapshotBeforeOtherResolutionsFinish() async {
        let alpha = BonjourServiceKey(name: "Alpha", domain: "local.")
        let beta = BonjourServiceKey(name: "Beta", domain: "local.")
        let betaRefreshReady = XCTestExpectation(description: "beta refresh is ready")
        let events = SequencedResolverEvents(blocked: [beta: betaRefreshReady])
        let resolver = SequencedBonjourServiceResolver(
            plans: [
                alpha: [.endpoint(.init(host: "alpha.local", port: 47_123))],
                beta: [.endpoint(.init(host: "beta.local", port: 47_124)), .blocked]
            ],
            events: events
        )
        let browser = FakeBonjourBrowser()
        let discovery = BonjourHostDiscovery(browser: browser, resolver: resolver)
        let stream = await discovery.start()
        let recorder = SnapshotBatchRecorder(expectedInitialIDs: ["alpha", "beta"])
        let consumer = Task {
            for await batch in stream {
                recorder.record(batch)
            }
        }

        browser.emit([
            makeRecord(name: "Alpha", txt: ["serverId": "alpha", "fingerprint": fingerprint, "versions": "3"]),
            makeRecord(name: "Beta", txt: ["serverId": "beta", "fingerprint": fingerprint, "versions": "3"])
        ])
        await fulfillment(of: [recorder.initialFullView], timeout: 1)

        recorder.beginRefresh()
        browser.emit([
            makeRecord(name: "Beta", txt: ["serverId": "beta", "fingerprint": fingerprint, "versions": "3"])
        ])
        await fulfillment(of: [betaRefreshReady, recorder.refreshPublished], timeout: 1)
        XCTAssertEqual(recorder.firstRefreshBatch?.map(\.serverID), ["beta"])

        await resolver.resume(beta, with: .init(host: "beta.local", port: 47_124))
        await discovery.stop()
        consumer.cancel()
    }

    func testRetryChangesOneFailedRowToResolvedWithoutDisturbingAnotherStableRow() async throws {
        let bad = BonjourServiceKey(name: "Bad", domain: "local.")
        let good = BonjourServiceKey(name: "Good", domain: "local.")
        let goodReady = XCTestExpectation(description: "good resolution is ready")
        let events = SequencedResolverEvents(blocked: [good: goodReady])
        let resolver = SequencedBonjourServiceResolver(
            plans: [
                bad: [
                    .endpoint(.init(host: " \n ", port: 47_123)),
                    .endpoint(.init(host: "bad.local", port: 47_123))
                ],
                good: [
                    .blocked,
                    .endpoint(.init(host: "good.local", port: 47_124))
                ]
            ],
            events: events
        )
        let browser = FakeBonjourBrowser()
        let discovery = BonjourHostDiscovery(browser: browser, resolver: resolver)
        let stream = await discovery.start()
        var iterator = stream.makeAsyncIterator()

        browser.emit([
            makeRecord(name: "Bad", txt: ["serverId": "bad", "fingerprint": fingerprint, "versions": "3"]),
            makeRecord(name: "Good", txt: ["serverId": "good", "fingerprint": fingerprint, "versions": "3"])
        ])

        let firstBatchValue = await iterator.next()
        let firstBatch = try XCTUnwrap(firstBatchValue)
        XCTAssertEqual(firstBatch.map(\.serverID), ["bad"])
        XCTAssertEqual(failure(from: firstBatch[0]), .invalidEndpoint)

        await fulfillment(of: [goodReady], timeout: 1)
        await resolver.resume(good, with: .init(host: "good.local", port: 47_124))

        let secondBatchValue = await iterator.next()
        let secondBatch = try XCTUnwrap(secondBatchValue)
        XCTAssertEqual(secondBatch.map(\.serverID), ["bad", "good"])
        XCTAssertEqual(failure(from: secondBatch[0]), .invalidEndpoint)
        XCTAssertEqual(resolvedHost(from: secondBatch[1])?.endpoint.host, "good.local")

        await discovery.retry(serverID: "bad")

        let thirdBatchValue = await iterator.next()
        let thirdBatch = try XCTUnwrap(thirdBatchValue)
        XCTAssertEqual(thirdBatch.map(\.serverID), ["bad", "good"])
        XCTAssertEqual(resolvedHost(from: thirdBatch[0])?.endpoint.host, "bad.local")
        XCTAssertEqual(resolvedHost(from: thirdBatch[1])?.endpoint.host, "good.local")

        await discovery.stop()
    }

    func testBlockedRetryCannotOverwriteANewerBrowseBatchForTheSameIdentity() async throws {
        let bad = BonjourServiceKey(name: "Bad", domain: "local.")
        let retryReady = XCTestExpectation(description: "blocked retry is ready")
        let retryCancelled = XCTestExpectation(description: "blocked retry is cancelled")
        let events = SequencedResolverEvents(
            blocked: [bad: retryReady],
            cancelled: [bad: retryCancelled]
        )
        let resolver = SequencedBonjourServiceResolver(
            plans: [
                bad: [
                    .endpoint(.init(host: " \n ", port: 47_123)),
                    .blocked,
                    .endpoint(.init(host: "batch.local", port: 47_123))
                ]
            ],
            events: events
        )
        let browser = FakeBonjourBrowser()
        let discovery = BonjourHostDiscovery(browser: browser, resolver: resolver)
        let stream = await discovery.start()
        var iterator = stream.makeAsyncIterator()

        browser.emit([
            makeRecord(name: "Bad", txt: ["serverId": "bad", "fingerprint": fingerprint, "versions": "3"])
        ])

        let firstBatchValue = await iterator.next()
        let firstBatch = try XCTUnwrap(firstBatchValue)
        XCTAssertEqual(firstBatch.map(\.serverID), ["bad"])
        XCTAssertEqual(failure(from: firstBatch[0]), .invalidEndpoint)

        let retryTask = Task {
            await discovery.retry(serverID: "bad")
        }
        await fulfillment(of: [retryReady], timeout: 1)

        browser.emit([
            makeRecord(name: "Bad", txt: ["serverId": "bad", "fingerprint": fingerprint, "versions": "3"])
        ])

        let secondBatchValue = await iterator.next()
        let secondBatch = try XCTUnwrap(secondBatchValue)
        XCTAssertEqual(secondBatch.map(\.serverID), ["bad"])
        XCTAssertEqual(resolvedHost(from: secondBatch[0])?.endpoint.host, "batch.local")

        await fulfillment(of: [retryCancelled], timeout: 1)
        await retryTask.value
        XCTAssertEqual(events.cancellationCount(for: bad), 1)

        let unexpectedPublish = XCTestExpectation(description: "stale retry publish")
        unexpectedPublish.isInverted = true
        let watcher = Task {
            if await iterator.next() != nil {
                unexpectedPublish.fulfill()
            }
        }

        await fulfillment(of: [unexpectedPublish], timeout: 0.25)
        watcher.cancel()
        await discovery.stop()
    }

    func testBlockedBatchCannotOverwriteANewerRetryForTheSameIdentity() async throws {
        let bad = BonjourServiceKey(name: "Bad", domain: "local.")
        let blockedBatchReady = XCTestExpectation(description: "blocked refresh batch is ready")
        let events = SequencedResolverEvents(blocked: [bad: blockedBatchReady])
        let resolver = SequencedBonjourServiceResolver(
            plans: [
                bad: [
                    .endpoint(.init(host: " \n ", port: 47_123)),
                    .blocked,
                    .endpoint(.init(host: "retry.local", port: 47_124))
                ]
            ],
            events: events
        )
        let browser = FakeBonjourBrowser()
        let discovery = BonjourHostDiscovery(browser: browser, resolver: resolver)
        let stream = await discovery.start()
        var iterator = stream.makeAsyncIterator()

        browser.emit([
            makeRecord(name: "Bad", txt: ["serverId": "bad", "fingerprint": fingerprint, "versions": "3"])
        ])

        let firstBatchValue = await iterator.next()
        let firstBatch = try XCTUnwrap(firstBatchValue)
        XCTAssertEqual(firstBatch.map(\.serverID), ["bad"])
        XCTAssertEqual(failure(from: firstBatch[0]), .invalidEndpoint)

        browser.emit([
            makeRecord(name: "Bad", txt: ["serverId": "bad", "fingerprint": fingerprint, "versions": "3"])
        ])
        await fulfillment(of: [blockedBatchReady], timeout: 1)

        let retryTask = Task {
            await discovery.retry(serverID: "bad")
        }

        let secondBatchValue = await iterator.next()
        let secondBatch = try XCTUnwrap(secondBatchValue)
        XCTAssertEqual(secondBatch.map(\.serverID), ["bad"])
        XCTAssertEqual(resolvedHost(from: secondBatch[0])?.endpoint.host, "retry.local")
        await retryTask.value

        let unexpectedPublish = XCTestExpectation(description: "stale batch publish")
        unexpectedPublish.isInverted = true
        let watcher = Task {
            if await iterator.next() != nil {
                unexpectedPublish.fulfill()
            }
        }

        await resolver.resume(bad, with: .init(host: "batch.local", port: 47_123))
        await fulfillment(of: [unexpectedPublish], timeout: 0.25)
        watcher.cancel()
        await discovery.stop()
    }

    func testStoppingDiscoveryCancelsABlockedRetryResolver() async throws {
        let bad = BonjourServiceKey(name: "Bad", domain: "local.")
        let retryReady = XCTestExpectation(description: "blocked retry is ready")
        let retryCancelled = XCTestExpectation(description: "blocked retry is cancelled")
        let events = SequencedResolverEvents(
            blocked: [bad: retryReady],
            cancelled: [bad: retryCancelled]
        )
        let resolver = SequencedBonjourServiceResolver(
            plans: [
                bad: [
                    .endpoint(.init(host: " \n ", port: 47_123)),
                    .blocked
                ]
            ],
            events: events
        )
        let browser = FakeBonjourBrowser()
        let discovery = BonjourHostDiscovery(browser: browser, resolver: resolver)
        let stream = await discovery.start()
        var iterator = stream.makeAsyncIterator()

        browser.emit([
            makeRecord(name: "Bad", txt: ["serverId": "bad", "fingerprint": fingerprint, "versions": "3"])
        ])

        let firstBatchValue = await iterator.next()
        let firstBatch = try XCTUnwrap(firstBatchValue)
        XCTAssertEqual(firstBatch.map(\.serverID), ["bad"])
        XCTAssertEqual(failure(from: firstBatch[0]), .invalidEndpoint)

        let retryTask = Task {
            await discovery.retry(serverID: "bad")
        }
        await fulfillment(of: [retryReady], timeout: 1)

        await discovery.stop()

        await fulfillment(of: [retryCancelled], timeout: 1)
        await retryTask.value
        XCTAssertEqual(events.cancellationCount(for: bad), 1)
        let trailingBatch = await iterator.next()
        XCTAssertNil(trailingBatch)
    }

    func testRetryDropsAStaleResultAfterStopCompletesFirst() async throws {
        let bad = BonjourServiceKey(name: "Bad", domain: "local.")
        let retryReady = XCTestExpectation(description: "bad retry is ready")
        let browserStopped = XCTestExpectation(description: "browser stopped after stop")
        let events = SequencedResolverEvents(blocked: [bad: retryReady])
        let browser = FakeBonjourBrowser(stopExpectation: browserStopped)
        let resolver = SequencedBonjourServiceResolver(
            plans: [
                bad: [
                    .endpoint(.init(host: " \n ", port: 47_123)),
                    .blocked,
                    .endpoint(.init(host: "bad.local", port: 47_123))
                ]
            ],
            events: events
        )
        let discovery = BonjourHostDiscovery(browser: browser, resolver: resolver)
        let stream = await discovery.start()
        var iterator = stream.makeAsyncIterator()

        browser.emit([
            makeRecord(name: "Bad", txt: ["serverId": "bad", "fingerprint": fingerprint, "versions": "3"])
        ])

        let firstBatchValue = await iterator.next()
        let firstBatch = try XCTUnwrap(firstBatchValue)
        XCTAssertEqual(firstBatch.map(\.serverID), ["bad"])
        XCTAssertEqual(failure(from: firstBatch[0]), .invalidEndpoint)

        let retryTask = Task {
            await discovery.retry(serverID: "bad")
        }

        await fulfillment(of: [retryReady], timeout: 1)
        await discovery.stop()
        await fulfillment(of: [browserStopped], timeout: 1)
        XCTAssertEqual(browser.startCount, 1)
        XCTAssertEqual(browser.stopCount, 1)

        await resolver.resume(bad, with: .init(host: "bad.local", port: 47_123))
        await retryTask.value

        let trailingBatch = await iterator.next()
        XCTAssertNil(trailingBatch)
    }

    func testRetryIsIgnoredWhenTheServiceDisappearsBeforeCompletion() async throws {
        let bad = BonjourServiceKey(name: "Bad", domain: "local.")
        let badRetryReady = XCTestExpectation(description: "bad retry is ready")
        let events = SequencedResolverEvents(blocked: [bad: badRetryReady])
        let resolver = SequencedBonjourServiceResolver(
            plans: [
                bad: [
                    .endpoint(.init(host: " \n ", port: 47_123)),
                    .blocked,
                    .endpoint(.init(host: "bad.local", port: 47_123))
                ]
            ],
            events: events
        )
        let browser = FakeBonjourBrowser()
        let discovery = BonjourHostDiscovery(browser: browser, resolver: resolver)
        let stream = await discovery.start()
        var iterator = stream.makeAsyncIterator()

        browser.emit([
            makeRecord(name: "Bad", txt: ["serverId": "bad", "fingerprint": fingerprint, "versions": "3"])
        ])

        let firstBatchValue = await iterator.next()
        let firstBatch = try XCTUnwrap(firstBatchValue)
        XCTAssertEqual(firstBatch.map(\.serverID), ["bad"])
        XCTAssertEqual(failure(from: firstBatch[0]), .invalidEndpoint)

        let retryTask = Task {
            await discovery.retry(serverID: "bad")
        }
        await fulfillment(of: [badRetryReady], timeout: 1)

        browser.emit([])
        let disappearanceBatchValue = await iterator.next()
        let disappearanceBatch = try XCTUnwrap(disappearanceBatchValue)
        XCTAssertEqual(disappearanceBatch.map(\.serverID), [])

        let unexpectedPublish = XCTestExpectation(description: "retry publish after disappearance")
        unexpectedPublish.isInverted = true
        let watcher = Task {
            if await iterator.next() != nil {
                unexpectedPublish.fulfill()
            }
        }

        await resolver.resume(bad, with: .init(host: "bad.local", port: 47_123))
        await retryTask.value
        await fulfillment(of: [unexpectedPublish], timeout: 0.25)
        watcher.cancel()

        await discovery.stop()
    }

    func testRetryIsIgnoredWhenTheObservationRestartsBeforeCompletion() async throws {
        let bad = BonjourServiceKey(name: "Bad", domain: "local.")
        let badRetryReady = XCTestExpectation(description: "bad retry is ready")
        let events = SequencedResolverEvents(blocked: [bad: badRetryReady])
        let resolver = SequencedBonjourServiceResolver(
            plans: [
                bad: [
                    .endpoint(.init(host: " \n ", port: 47_123)),
                    .blocked,
                    .endpoint(.init(host: "bad.local", port: 47_123))
                ]
            ],
            events: events
        )
        let browser = FakeBonjourBrowser()
        let discovery = BonjourHostDiscovery(browser: browser, resolver: resolver)
        let stream = await discovery.start()
        var iterator = stream.makeAsyncIterator()

        browser.emit([
            makeRecord(name: "Bad", txt: ["serverId": "bad", "fingerprint": fingerprint, "versions": "3"])
        ])

        let firstBatchValue = await iterator.next()
        let firstBatch = try XCTUnwrap(firstBatchValue)
        XCTAssertEqual(firstBatch.map(\.serverID), ["bad"])
        XCTAssertEqual(failure(from: firstBatch[0]), .invalidEndpoint)

        let retryTask = Task {
            await discovery.retry(serverID: "bad")
        }
        await fulfillment(of: [badRetryReady], timeout: 1)

        let restartedStream = await discovery.start()
        var restartedIterator = restartedStream.makeAsyncIterator()
        let unexpectedPublish = XCTestExpectation(description: "retry publish after restart")
        unexpectedPublish.isInverted = true
        let watcher = Task {
            if await restartedIterator.next() != nil {
                unexpectedPublish.fulfill()
            }
        }

        await resolver.resume(bad, with: .init(host: "bad.local", port: 47_123))
        await retryTask.value
        await fulfillment(of: [unexpectedPublish], timeout: 0.25)
        watcher.cancel()

        await discovery.stop()
    }

    func testStartingNewObservationCancelsABlockedRetryAndFinishesTheSupersededStream() async throws {
        let bad = BonjourServiceKey(name: "Bad", domain: "local.")
        let retryReady = XCTestExpectation(description: "blocked retry is ready")
        let retryCancelled = XCTestExpectation(description: "blocked retry is cancelled")
        let events = SequencedResolverEvents(
            blocked: [bad: retryReady],
            cancelled: [bad: retryCancelled]
        )
        let resolver = SequencedBonjourServiceResolver(
            plans: [
                bad: [
                    .endpoint(.init(host: " \n ", port: 47_123)),
                    .blocked,
                    .endpoint(.init(host: "restarted.local", port: 47_124))
                ]
            ],
            events: events
        )
        let browser = FakeBonjourBrowser()
        let discovery = BonjourHostDiscovery(browser: browser, resolver: resolver)
        let originalStream = await discovery.start()
        var originalIterator = originalStream.makeAsyncIterator()

        browser.emit([
            makeRecord(name: "Bad", txt: ["serverId": "bad", "fingerprint": fingerprint, "versions": "3"])
        ])

        let firstBatchValue = await originalIterator.next()
        let firstBatch = try XCTUnwrap(firstBatchValue)
        XCTAssertEqual(firstBatch.map(\.serverID), ["bad"])
        XCTAssertEqual(failure(from: firstBatch[0]), .invalidEndpoint)

        let retryTask = Task {
            await discovery.retry(serverID: "bad")
        }
        await fulfillment(of: [retryReady], timeout: 1)

        let restartedStream = await discovery.start()
        var restartedIterator = restartedStream.makeAsyncIterator()
        await fulfillment(of: [retryCancelled], timeout: 1)
        let supersededBatch = await originalIterator.next()
        XCTAssertNil(supersededBatch)
        await retryTask.value

        browser.emit([
            makeRecord(name: "Bad", txt: ["serverId": "bad", "fingerprint": fingerprint, "versions": "3"])
        ])

        let restartedBatchValue = await restartedIterator.next()
        let restartedBatch = try XCTUnwrap(restartedBatchValue)
        XCTAssertEqual(restartedBatch.map(\.serverID), ["bad"])
        XCTAssertEqual(resolvedHost(from: restartedBatch[0])?.endpoint.host, "restarted.local")
        XCTAssertEqual(events.cancellationCount(for: bad), 1)
        await discovery.stop()
    }

    func testRetryIsIgnoredWhenTheIdentityIsReplacedBeforeCompletion() async throws {
        let bad = BonjourServiceKey(name: "Bad", domain: "local.")
        let replacement = BonjourServiceKey(name: "Bad v2", domain: "local.")
        let badRetryReady = XCTestExpectation(description: "bad retry is ready")
        let events = SequencedResolverEvents(blocked: [bad: badRetryReady])
        let resolver = SequencedBonjourServiceResolver(
            plans: [
                bad: [
                    .endpoint(.init(host: " \n ", port: 47_123)),
                    .blocked,
                    .endpoint(.init(host: "bad.local", port: 47_123))
                ],
                replacement: [
                    .endpoint(.init(host: "bad-v2.local", port: 47_124))
                ]
            ],
            events: events
        )
        let browser = FakeBonjourBrowser()
        let discovery = BonjourHostDiscovery(browser: browser, resolver: resolver)
        let stream = await discovery.start()
        var iterator = stream.makeAsyncIterator()

        browser.emit([
            makeRecord(name: "Bad", txt: [
                "serverId": "bad", "fingerprint": fingerprint, "versions": "3"
            ])
        ])

        let firstBatchValue = await iterator.next()
        let firstBatch = try XCTUnwrap(firstBatchValue)
        XCTAssertEqual(firstBatch.map(\.serverID), ["bad"])
        XCTAssertEqual(failure(from: firstBatch[0]), .invalidEndpoint)

        let retryTask = Task {
            await discovery.retry(serverID: "bad")
        }
        await fulfillment(of: [badRetryReady], timeout: 1)

        browser.emit([
            makeRecord(name: "Bad v2", txt: [
                "serverId": "bad",
                "fingerprint": String(repeating: "b", count: 64),
                "versions": "3"
            ])
        ])
        let replacementBatchValue = await iterator.next()
        let replacementBatch = try XCTUnwrap(replacementBatchValue)
        XCTAssertEqual(replacementBatch.map(\.serverID), ["bad"])
        XCTAssertEqual(replacementBatch[0].serverName, "Bad v2")
        XCTAssertEqual(resolvedHost(from: replacementBatch[0])?.endpoint.host, "bad-v2.local")

        let unexpectedPublish = XCTestExpectation(description: "retry publish after replacement")
        unexpectedPublish.isInverted = true
        let watcher = Task {
            if await iterator.next() != nil {
                unexpectedPublish.fulfill()
            }
        }

        await resolver.resume(bad, with: .init(host: "bad.local", port: 47_123))
        await retryTask.value
        await fulfillment(of: [unexpectedPublish], timeout: 0.25)
        watcher.cancel()

        await discovery.stop()
    }

    func testConsumerTerminationStopsBrowserAndCancelsActiveResolution() async {
        let blocked = BonjourServiceKey(name: "Blocked", domain: "local.")
        let started = XCTestExpectation(description: "blocked resolution started")
        let cancelled = XCTestExpectation(description: "blocked resolution cancelled")
        let browserStopped = XCTestExpectation(description: "browser stopped after consumer termination")
        let events = ResolverEventLog(started: [blocked: started], cancelled: [blocked: cancelled])
        let browser = FakeBonjourBrowser(stopExpectation: browserStopped)
        let resolver = ControlledBonjourServiceResolver(modes: [blocked: .blocked], events: events)
        let discovery = BonjourHostDiscovery(browser: browser, resolver: resolver)
        let stream = await discovery.start()
        let consumer = Task {
            var iterator = stream.makeAsyncIterator()
            _ = await iterator.next()
        }

        browser.emit([
            makeRecord(name: "Blocked", txt: ["serverId": "blocked", "fingerprint": fingerprint, "versions": "3"])
        ])
        await fulfillment(of: [started], timeout: 1)

        consumer.cancel()

        await fulfillment(of: [cancelled, browserStopped], timeout: 1)
        XCTAssertEqual(browser.stopCount, 1)
        XCTAssertEqual(events.cancellationCount(for: blocked), 1)
    }

    func testConsumerTerminationCancelsABlockedRetryAndStopsTheBrowserExactlyOnce() async throws {
        let bad = BonjourServiceKey(name: "Bad", domain: "local.")
        let firstBatchReceived = XCTestExpectation(description: "first failed batch received")
        let retryReady = XCTestExpectation(description: "blocked retry is ready")
        let retryCancelled = XCTestExpectation(description: "blocked retry is cancelled")
        let browserStopped = XCTestExpectation(description: "browser stopped after retry termination")
        let events = SequencedResolverEvents(
            blocked: [bad: retryReady],
            cancelled: [bad: retryCancelled]
        )
        let browser = FakeBonjourBrowser(stopExpectation: browserStopped)
        let resolver = SequencedBonjourServiceResolver(
            plans: [
                bad: [
                    .endpoint(.init(host: " \n ", port: 47_123)),
                    .blocked
                ]
            ],
            events: events
        )
        let discovery = BonjourHostDiscovery(browser: browser, resolver: resolver)
        let stream = await discovery.start()
        let consumer = Task {
            var iterator = stream.makeAsyncIterator()
            _ = await iterator.next()
            firstBatchReceived.fulfill()
            _ = await iterator.next()
        }

        browser.emit([
            makeRecord(name: "Bad", txt: ["serverId": "bad", "fingerprint": fingerprint, "versions": "3"])
        ])
        await fulfillment(of: [firstBatchReceived], timeout: 1)

        let retryTask = Task {
            await discovery.retry(serverID: "bad")
        }
        await fulfillment(of: [retryReady], timeout: 1)

        consumer.cancel()

        await fulfillment(of: [retryCancelled, browserStopped], timeout: 1)
        await retryTask.value
        XCTAssertEqual(events.cancellationCount(for: bad), 1)
        XCTAssertEqual(browser.stopCount, 1)
    }

    func testConsumerTerminationStopsBrowserExactlyOnceAfterObservationTaskQuiesces() async {
        let blocked = BonjourServiceKey(name: "Blocked", domain: "local.")
        let started = XCTestExpectation(description: "blocked resolution started")
        let cancelled = XCTestExpectation(description: "blocked resolution cancelled")
        let observationTerminated = XCTestExpectation(description: "consumer termination owned observation cleanup")
        let observationReadyToFinish = XCTestExpectation(description: "cancelled observation task is ready to finish")
        let observationFinished = XCTestExpectation(description: "cancelled observation task finished")
        let events = ResolverEventLog(started: [blocked: started], cancelled: [blocked: cancelled])
        let browser = FakeBonjourBrowser()
        let resolver = ControlledBonjourServiceResolver(modes: [blocked: .blocked], events: events)
        let lifecycle = DiscoveryLifecycleBoundary(
            observationTerminated: observationTerminated,
            observationReadyToFinish: observationReadyToFinish,
            observationFinished: observationFinished
        )
        let discovery = BonjourHostDiscovery(
            browser: browser,
            resolver: resolver,
            lifecycle: .init(didTerminateObservation: {
                lifecycle.recordObservationTerminated()
            }, beforeFinishObservation: {
                await lifecycle.waitBeforeFinish()
            }, didFinishObservation: {
                lifecycle.recordObservationFinished()
            })
        )
        let consumerReady = XCTestExpectation(description: "consumer owns the discovery stream")
        let consumer = Task {
            let stream = await discovery.start()
            consumerReady.fulfill()
            var iterator = stream.makeAsyncIterator()
            _ = await iterator.next()
        }

        await fulfillment(of: [consumerReady], timeout: 1)
        browser.emit([
            makeRecord(name: "Blocked", txt: ["serverId": "blocked", "fingerprint": fingerprint, "versions": "3"])
        ])
        await fulfillment(of: [started], timeout: 1)

        consumer.cancel()

        await fulfillment(of: [cancelled, observationReadyToFinish, observationTerminated], timeout: 1)
        lifecycle.allowFinish()
        await fulfillment(of: [observationFinished], timeout: 1)
        XCTAssertEqual(browser.stopCount, 1)
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

private func resolvedHost(
    from entry: BonjourDiscoveryEntry,
    file: StaticString = #filePath,
    line: UInt = #line
) -> DiscoveredHost? {
    switch entry.availability {
    case let .resolved(host):
        return host
    case let .resolutionFailed(failure):
        XCTFail("Expected resolved entry, got \(failure)", file: file, line: line)
        return nil
    }
}

private func failure(
    from entry: BonjourDiscoveryEntry,
    file: StaticString = #filePath,
    line: UInt = #line
) -> BonjourResolutionFailure? {
    switch entry.availability {
    case .resolved:
        XCTFail("Expected failure entry", file: file, line: line)
        return nil
    case let .resolutionFailed(failure):
        return failure
    }
}

private func firstDiscoveryBatch<Resolver: BonjourServiceResolving>(
    browser: FakeBonjourBrowser,
    resolver: Resolver,
    records: [BonjourServiceRecord]
) async throws -> [BonjourDiscoveryEntry] {
    let discovery = BonjourHostDiscovery(browser: browser, resolver: resolver)
    let stream = await discovery.start()
    var iterator = stream.makeAsyncIterator()
    browser.emit(records)
    let batchValue = await iterator.next()
    let batch = try XCTUnwrap(batchValue)
    await discovery.stop()
    return batch
}

private struct BonjourServiceKey: Hashable, Sendable {
    let name: String
    let domain: String
}

private enum FakeBonjourServiceResolverOutcome {
    case endpoint(ResolvedBonjourEndpoint)
    case bonjourError(BonjourServiceResolverError)
    case otherError(Error)
}

private enum FakeBonjourServiceResolverError: Error {
    case failed
}

private actor FakeBonjourServiceResolver: BonjourServiceResolving {
    private let results: [BonjourServiceKey: FakeBonjourServiceResolverOutcome]
    private var resolvedRequests: [BonjourServiceKey] = []

    init(endpoints: [BonjourServiceKey: ResolvedBonjourEndpoint]) {
        self.results = endpoints.mapValues(FakeBonjourServiceResolverOutcome.endpoint)
    }

    init(results: [BonjourServiceKey: FakeBonjourServiceResolverOutcome]) {
        self.results = results
    }

    func resolve(name: String, domain: String) async throws -> ResolvedBonjourEndpoint {
        let key = BonjourServiceKey(name: name, domain: domain)
        resolvedRequests.append(key)
        guard let result = results[key] else {
            throw FakeBonjourServiceResolverError.failed
        }
        switch result {
        case let .endpoint(endpoint):
            return endpoint
        case let .bonjourError(error):
            throw error
        case let .otherError(error):
            throw error
        }
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
    private var storedFirstBatch: [BonjourDiscoveryEntry]??

    var firstBatch: [BonjourDiscoveryEntry]? {
        lock.withLock { storedFirstBatch ?? nil }
    }

    func record(_ batch: [BonjourDiscoveryEntry]?) {
        lock.withLock { storedFirstBatch = batch }
        received.fulfill()
    }
}

private enum SequencedBonjourServiceResolution: Sendable {
    case blocked
    case endpoint(ResolvedBonjourEndpoint)
}

private actor SequencedBonjourServiceResolver: BonjourServiceResolving {
    private struct PendingContinuation {
        let id: UInt64
        let continuation: CheckedContinuation<ResolvedBonjourEndpoint, Error>
    }

    private var plans: [BonjourServiceKey: [SequencedBonjourServiceResolution]]
    private var continuations: [BonjourServiceKey: [PendingContinuation]] = [:]
    private var continuationID: UInt64 = 0
    private let events: SequencedResolverEvents

    init(
        plans: [BonjourServiceKey: [SequencedBonjourServiceResolution]],
        events: SequencedResolverEvents
    ) {
        self.plans = plans
        self.events = events
    }

    func resolve(name: String, domain: String) async throws -> ResolvedBonjourEndpoint {
        let key = BonjourServiceKey(name: name, domain: domain)
        guard var plan = plans[key], !plan.isEmpty else {
            throw FakeBonjourServiceResolverError.failed
        }
        let next = plan.removeFirst()
        plans[key] = plan

        switch next {
        case let .endpoint(endpoint):
            return endpoint
        case .blocked:
            continuationID &+= 1
            let pendingID = continuationID
            return try await withTaskCancellationHandler(operation: {
                try await withCheckedThrowingContinuation { continuation in
                    continuations[key, default: []].append(
                        PendingContinuation(id: pendingID, continuation: continuation)
                    )
                    events.recordBlocked(for: key)
                }
            }, onCancel: {
                Task {
                    await self.cancel(key, continuationID: pendingID)
                }
            })
        }
    }

    func resume(_ key: BonjourServiceKey, with endpoint: ResolvedBonjourEndpoint) {
        guard var pending = continuations[key], !pending.isEmpty else { return }
        let continuation = pending.removeFirst().continuation
        continuations[key] = pending.isEmpty ? nil : pending
        continuation.resume(returning: endpoint)
    }

    private func cancel(_ key: BonjourServiceKey, continuationID: UInt64) {
        guard var pending = continuations[key],
              let index = pending.firstIndex(where: { $0.id == continuationID }) else {
            return
        }
        let continuation = pending.remove(at: index).continuation
        continuations[key] = pending.isEmpty ? nil : pending
        events.recordCancellation(for: key)
        continuation.resume(throwing: CancellationError())
    }
}

private final class SequencedResolverEvents: @unchecked Sendable {
    private let blocked: [BonjourServiceKey: XCTestExpectation]
    private let cancelled: [BonjourServiceKey: XCTestExpectation]
    private let lock = NSLock()
    private var cancellationCounts: [BonjourServiceKey: Int] = [:]

    init(
        blocked: [BonjourServiceKey: XCTestExpectation],
        cancelled: [BonjourServiceKey: XCTestExpectation] = [:]
    ) {
        self.blocked = blocked
        self.cancelled = cancelled
    }

    func recordBlocked(for key: BonjourServiceKey) {
        blocked[key]?.fulfill()
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

private final class SnapshotBatchRecorder: @unchecked Sendable {
    let initialFullView = XCTestExpectation(description: "initial full host view published")
    let refreshPublished = XCTestExpectation(description: "refresh host view published")
    private let lock = NSLock()
    private let expectedInitialIDs: [String]
    private var didPublishInitial = false
    private var awaitingRefresh = false
    private var storedFirstRefreshBatch: [BonjourDiscoveryEntry]?

    init(expectedInitialIDs: [String]) {
        self.expectedInitialIDs = expectedInitialIDs
    }

    var firstRefreshBatch: [BonjourDiscoveryEntry]? {
        lock.withLock { storedFirstRefreshBatch }
    }

    func beginRefresh() {
        lock.withLock {
            awaitingRefresh = true
            storedFirstRefreshBatch = nil
        }
    }

    func record(_ batch: [BonjourDiscoveryEntry]) {
        let fulfill = lock.withLock { () -> (Bool, Bool) in
            let isInitial = !didPublishInitial && batch.map(\.serverID) == expectedInitialIDs
            if isInitial {
                didPublishInitial = true
            }
            let isRefresh = awaitingRefresh && storedFirstRefreshBatch == nil
            if isRefresh {
                storedFirstRefreshBatch = batch
            }
            return (isInitial, isRefresh)
        }
        if fulfill.0 {
            initialFullView.fulfill()
        }
        if fulfill.1 {
            refreshPublished.fulfill()
        }
    }
}

private final class DiscoveryLifecycleBoundary: @unchecked Sendable {
    private let lock = NSLock()
    private let observationTerminated: XCTestExpectation
    private let observationReadyToFinish: XCTestExpectation
    private let observationFinished: XCTestExpectation
    private var continuation: CheckedContinuation<Void, Never>?
    private var didAllowFinish = false

    init(
        observationTerminated: XCTestExpectation,
        observationReadyToFinish: XCTestExpectation,
        observationFinished: XCTestExpectation
    ) {
        self.observationTerminated = observationTerminated
        self.observationReadyToFinish = observationReadyToFinish
        self.observationFinished = observationFinished
    }

    func recordObservationTerminated() {
        observationTerminated.fulfill()
    }

    func waitBeforeFinish() async {
        observationReadyToFinish.fulfill()
        await withCheckedContinuation { continuation in
            let shouldResume = lock.withLock { () -> Bool in
                if didAllowFinish {
                    return true
                }
                self.continuation = continuation
                return false
            }
            if shouldResume {
                continuation.resume()
            }
        }
    }

    func allowFinish() {
        let continuation = lock.withLock { () -> CheckedContinuation<Void, Never>? in
            didAllowFinish = true
            let continuation = self.continuation
            self.continuation = nil
            return continuation
        }
        continuation?.resume()
    }

    func recordObservationFinished() {
        observationFinished.fulfill()
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
    private let stopExpectation: XCTestExpectation?
    private var continuation: AsyncStream<[BonjourServiceRecord]>.Continuation?
    private var storedStartCount = 0
    private var storedStopCount = 0

    init(stopExpectation: XCTestExpectation? = nil) {
        self.stopExpectation = stopExpectation
    }

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
        stopExpectation?.fulfill()
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
