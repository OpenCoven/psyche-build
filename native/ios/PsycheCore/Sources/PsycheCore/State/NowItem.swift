import Foundation

public enum NowSectionKind: String, Sendable, Equatable, CaseIterable {
    case needsYou
    case running
    case recent
}

public struct NowItem: Identifiable, Sendable, Equatable {
    public let paneID: String
    public let projectID: String
    public let projectTitle: String
    public let title: String
    public let agent: String?
    public let status: String
    public let needsAttention: Bool
    public let lastActivity: Date?

    public var id: String { paneID }

    public init(
        paneID: String,
        projectID: String,
        projectTitle: String,
        title: String,
        agent: String?,
        status: String,
        needsAttention: Bool,
        lastActivity: Date?
    ) {
        self.paneID = paneID
        self.projectID = projectID
        self.projectTitle = projectTitle
        self.title = title
        self.agent = agent
        self.needsAttention = needsAttention
        self.status = status
        self.lastActivity = lastActivity
    }

    /// Which Now section this pane belongs in. Status strings come from the
    /// host and are matched case-insensitively; anything unrecognized falls to
    /// Recent rather than being hidden.
    public var sectionKind: NowSectionKind {
        let status = status.lowercased()
        if needsAttention || NowSectionKind.attentionStatuses.contains(status) {
            return .needsYou
        }
        if NowSectionKind.runningStatuses.contains(status) {
            return .running
        }
        return .recent
    }
}

public extension NowSectionKind {
    static let attentionStatuses: Set<String> = ["waiting", "failed", "blocked"]
    static let runningStatuses: Set<String> = ["starting", "running", "working", "analyzing"]
}

public struct NowSection: Identifiable, Sendable, Equatable {
    public let kind: NowSectionKind
    public let items: [NowItem]

    public var id: NowSectionKind { kind }

    public var title: String {
        switch kind {
        case .needsYou: "Needs You"
        case .running: "Running"
        case .recent: "Recent"
        }
    }

    public init(kind: NowSectionKind, items: [NowItem]) {
        self.kind = kind
        self.items = items
    }
}

/// The host stamps activity with `new Date().toISOString()`, which carries
/// fractional seconds. `ISO8601DateFormatter` rejects those unless asked for
/// them, and a nil date silently collapses Now ordering to titles alone — so
/// parse the fractional form first and keep the plain form as a fallback.
enum ISO8601Timestamp {
    // Apple documents ISO8601DateFormatter as thread-safe, and neither of
    // these is mutated after construction — so sharing them beats allocating a
    // formatter per pane on every snapshot.
    nonisolated(unsafe) private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    nonisolated(unsafe) private static let plain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    static func date(from value: String?) -> Date? {
        guard let value, !value.isEmpty else { return nil }
        return fractional.date(from: value) ?? plain.date(from: value)
    }
}
