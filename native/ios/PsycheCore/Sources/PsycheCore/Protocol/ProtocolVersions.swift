import Foundation

/// Mirrors `LEGACY_PROTOCOL_VERSION`, `PROTOCOL_VERSION`, and
/// `SUPPORTED_PROTOCOL_VERSIONS` in `src/services/bridge/wireProtocol.ts`.
/// A host advertising none of these cannot speak to this client, so discovery
/// drops it rather than offering a connection that would fail at hello.
public enum PsycheProtocolVersion {
    public static let legacy = 2
    public static let current = 3
    public static let supported: Set<Int> = [legacy, current]
}
