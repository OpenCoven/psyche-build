import Foundation
import XCTest
@testable import PsycheCore

final class PinnedCertificateDelegateTests: XCTestCase {
    private let fingerprint = "0c8893630b087f7ab19a71c016e599cebc3b5235fd449e9917a43850edddaa38"

    func testNormalizesColonSeparatedFingerprint() throws {
        let colonSeparated = fingerprint.uppercased().chunked(every: 2).joined(separator: ":")

        XCTAssertEqual(
            try PinnedCertificateDelegate.normalizeFingerprint(colonSeparated),
            fingerprint
        )
    }

    func testRejectsMalformedFingerprintWithRepairGuidance() {
        for malformed in [
            "",
            String(repeating: "a", count: 63),
            String(repeating: "a", count: 65),
            String(repeating: "z", count: 64),
            " \(fingerprint)"
        ] {
            XCTAssertThrowsError(
                try PinnedCertificateDelegate.normalizeFingerprint(malformed),
                "Expected \(malformed) to be rejected"
            ) { error in
                XCTAssertTrue(error.localizedDescription.localizedCaseInsensitiveContains("re-pair"))
            }
        }
    }

    func testMatchesLeafCertificateDataFingerprint() throws {
        let certificateData = Data("leaf-certificate".utf8)

        XCTAssertTrue(try PinnedCertificateDelegate.matches(
            certificateData: certificateData,
            expectedFingerprint: fingerprint
        ))
        XCTAssertFalse(try PinnedCertificateDelegate.matches(
            certificateData: certificateData,
            expectedFingerprint: String(repeating: "f", count: 64)
        ))
    }

    func testNonServerTrustChallengeUsesDefaultHandling() throws {
        let delegate = try PinnedCertificateDelegate(certificateFingerprint: fingerprint)
        let challenge = makeChallenge(authenticationMethod: NSURLAuthenticationMethodHTTPBasic)
        let result = ChallengeResult()
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }

        delegate.urlSession(session, didReceive: challenge) { disposition, credential in
            result.store(disposition: disposition, credential: credential)
        }

        XCTAssertEqual(result.disposition, .performDefaultHandling)
        XCTAssertNil(result.credential)
    }

    func testServerTrustChallengeWithoutTrustCancels() throws {
        let delegate = try PinnedCertificateDelegate(certificateFingerprint: fingerprint)
        let challenge = makeChallenge(authenticationMethod: NSURLAuthenticationMethodServerTrust)
        let result = ChallengeResult()
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }

        delegate.urlSession(session, didReceive: challenge) { disposition, credential in
            result.store(disposition: disposition, credential: credential)
        }

        XCTAssertEqual(result.disposition, .cancelAuthenticationChallenge)
        XCTAssertNil(result.credential)
    }

    private func makeChallenge(authenticationMethod: String) -> URLAuthenticationChallenge {
        let protectionSpace = URLProtectionSpace(
            host: "psyche.local",
            port: 4242,
            protocol: "https",
            realm: nil,
            authenticationMethod: authenticationMethod
        )
        return URLAuthenticationChallenge(
            protectionSpace: protectionSpace,
            proposedCredential: nil,
            previousFailureCount: 0,
            failureResponse: nil,
            error: nil,
            sender: ChallengeSender()
        )
    }
}

private final class ChallengeResult: @unchecked Sendable {
    private let lock = NSLock()
    private var storedDisposition: URLSession.AuthChallengeDisposition?
    private var storedCredential: URLCredential?

    var disposition: URLSession.AuthChallengeDisposition? {
        lock.withLock { storedDisposition }
    }

    var credential: URLCredential? {
        lock.withLock { storedCredential }
    }

    func store(disposition: URLSession.AuthChallengeDisposition, credential: URLCredential?) {
        lock.withLock {
            storedDisposition = disposition
            storedCredential = credential
        }
    }
}

private final class ChallengeSender: NSObject, URLAuthenticationChallengeSender, @unchecked Sendable {
    func use(_ credential: URLCredential, for challenge: URLAuthenticationChallenge) {}
    func continueWithoutCredential(for challenge: URLAuthenticationChallenge) {}
    func cancel(_ challenge: URLAuthenticationChallenge) {}
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
