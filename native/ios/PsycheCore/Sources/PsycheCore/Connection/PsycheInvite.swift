import Foundation

/// A one-time connection handoff. Parsing only validates and normalizes the
/// URL; redeeming its token is deliberately owned by a later connection flow.
public struct PsycheInvite: Sendable, Equatable {
    public struct Endpoint: Sendable, Equatable {
        public let host: String
        public let port: Int

        public init(host: String, port: Int) {
            self.host = host
            self.port = port
        }
    }

    public let endpoint: Endpoint
    public let token: String

    public init?(url: URL) {
        guard Self.isPsycheConnectURL(url),
              let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let token = Self.singleValue(named: "psyche_invite", in: query),
              !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let endpointValue = Self.singleValue(named: "endpoint", in: query),
              let endpoint = Self.endpoint(from: endpointValue) else {
            return nil
        }

        self.endpoint = endpoint
        self.token = token
    }

    private static func isPsycheConnectURL(_ url: URL) -> Bool {
        switch url.scheme?.lowercased() {
        case "psyche":
            return url.host?.lowercased() == "connect" && (url.path.isEmpty || url.path == "/")
        case "https":
            return url.host?.lowercased() == "psyche.opencoven.ai" && url.path == "/connect"
        default:
            return false
        }
    }

    private static func singleValue(named name: String, in items: [URLQueryItem]) -> String? {
        let values = items.filter { $0.name == name }.compactMap(\.value)
        guard values.count == 1 else { return nil }
        return values[0]
    }

    private static func endpoint(from value: String) -> Endpoint? {
        guard let url = URL(string: value),
              let scheme = url.scheme?.lowercased(),
              scheme == "wss" || scheme == "https",
              url.user == nil,
              url.password == nil,
              url.query == nil,
              url.fragment == nil,
              url.path.isEmpty || url.path == "/",
              let rawHost = url.host else {
            return nil
        }

        let host = rawHost.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
        let port = url.port ?? 443
        guard !host.isEmpty, (1...65_535).contains(port) else { return nil }
        return Endpoint(host: host, port: port)
    }
}
