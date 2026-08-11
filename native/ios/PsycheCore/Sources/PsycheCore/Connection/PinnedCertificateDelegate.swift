import CryptoKit
import Foundation
import Security

public enum CertificatePinningError: Error, Sendable, Equatable, LocalizedError {
    case invalidFingerprint

    public var errorDescription: String? {
        "The paired host certificate fingerprint is invalid. Re-pair this device with the host."
    }
}

public final class PinnedCertificateDelegate: NSObject, URLSessionDelegate, @unchecked Sendable {
    public let normalizedFingerprint: String

    private let stateLock = NSLock()
    private var storedDidRejectPin = false

    /// A rejected pin is indistinguishable from an ordinary socket drop by the
    /// time URLSession reports it, so record it here and let the transport turn
    /// the next failure into re-pair guidance.
    public var didRejectPin: Bool {
        stateLock.withLock { storedDidRejectPin }
    }

    public init(certificateFingerprint: String) throws {
        normalizedFingerprint = try Self.normalizeFingerprint(certificateFingerprint)
        super.init()
    }

    public static func normalizeFingerprint(_ fingerprint: String) throws -> String {
        let normalized = fingerprint.replacingOccurrences(of: ":", with: "").lowercased()
        guard normalized.utf8.count == 64,
              normalized.utf8.allSatisfy(Self.isASCIIHexDigit) else {
            throw CertificatePinningError.invalidFingerprint
        }
        return normalized
    }

    public static func matches(
        certificateData: Data,
        expectedFingerprint: String
    ) throws -> Bool {
        let expected = try normalizeFingerprint(expectedFingerprint)
        let actual = SHA256.hash(data: certificateData)
            .map { String(format: "%02x", $0) }
            .joined()
        return actual == expected
    }

    public func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping @Sendable (
            URLSession.AuthChallengeDisposition,
            URLCredential?
        ) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }

        guard let trust = challenge.protectionSpace.serverTrust,
              let certificates = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leafCertificate = certificates.first else {
            recordPinRejection()
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }

        let certificateData = SecCertificateCopyData(leafCertificate) as Data
        guard (try? Self.matches(
            certificateData: certificateData,
            expectedFingerprint: normalizedFingerprint
        )) == true else {
            recordPinRejection()
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }

        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    private func recordPinRejection() {
        stateLock.withLock { storedDidRejectPin = true }
    }

    private static func isASCIIHexDigit(_ byte: UInt8) -> Bool {
        switch byte {
        case 48...57, 97...102:
            true
        default:
            false
        }
    }
}
