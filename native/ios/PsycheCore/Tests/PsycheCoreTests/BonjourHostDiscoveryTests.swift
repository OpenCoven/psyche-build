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
        let discovery = BonjourHostDiscovery(browser: browser)

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
        XCTAssertEqual(browser.startCount, 1)

        await discovery.stop()
        XCTAssertEqual(browser.stopCount, 1)
    }

    private func makeRecord(
        name: String = "Studio",
        domain: String = "local.",
        txt: [String: String]
    ) -> BonjourServiceRecord {
        BonjourServiceRecord(name: name, domain: domain, txt: txt)
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
