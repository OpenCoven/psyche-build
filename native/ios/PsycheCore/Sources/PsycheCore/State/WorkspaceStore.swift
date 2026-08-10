import Combine
import Foundation

public enum WorkspaceStoreError: Error, Sendable, Equatable, LocalizedError {
    case noControlRequests
    case unexpectedResponse

    public var errorDescription: String? {
        switch self {
        case .noControlRequests:
            "This workspace is not connected to a host."
        case .unexpectedResponse:
            "The host answered the workspace request with something else."
        }
    }
}

/// The single mobile source of truth for workspace state.
///
/// Events are only applied in sequence. A gap means this client has missed
/// something, so the store keeps the last state it knows is real, marks itself
/// stale, and asks for a full snapshot — it never patches a hole by accepting
/// state it cannot place in order.
@MainActor
public final class WorkspaceStore: ObservableObject {
    @Published public private(set) var workspace: WorkspaceSnapshot?
    @Published public private(set) var nowSections: [NowSection] = []
    @Published public private(set) var isStale = true
    @Published public private(set) var needsFullSnapshot = true
    @Published public private(set) var lastConfirmedAt: Date?
    @Published public var selectedProjectID: String?
    @Published public var primaryPaneID: String?
    @Published public var secondaryPaneID: String?
    @Published public var drafts: [String: String] = [:]

    public private(set) var sequence: UInt64 = 0

    private let controlRequests: (any ControlRequesting)?
    private let now: @Sendable () -> Date
    private var isAwaitingConnectionSnapshot = false

    public init(
        controlRequests: (any ControlRequesting)? = nil,
        now: @escaping @Sendable () -> Date = Date.init
    ) {
        self.controlRequests = controlRequests
        self.now = now
    }

    /// Applies an incremental update. Anything already seen is ignored, and a
    /// gap leaves the current state untouched while flagging that only a full
    /// snapshot can restore correctness.
    public func applyEvent(workspace: WorkspaceSnapshot, sequence nextSequence: UInt64) {
        guard !isAwaitingConnectionSnapshot else {
            isStale = true
            needsFullSnapshot = true
            return
        }
        guard nextSequence > sequence else { return }
        guard sequence == 0 || nextSequence == sequence + 1 else {
            isStale = true
            needsFullSnapshot = true
            return
        }
        accept(workspace: workspace, sequence: nextSequence)
    }

    /// Applies an authoritative snapshot. A snapshot is complete state rather
    /// than a delta, so it may jump the sequence forward across a gap — that is
    /// exactly how a gap is recovered.
    public func applySnapshot(workspace: WorkspaceSnapshot, sequence nextSequence: UInt64) {
        guard nextSequence >= sequence else { return }
        isAwaitingConnectionSnapshot = false
        accept(workspace: workspace, sequence: nextSequence)
    }

    /// Asks the host for authoritative state and applies it. This is the only
    /// way out of a sequence gap.
    @discardableResult
    public func requestFullSnapshot() async throws -> WorkspaceSnapshot {
        guard let controlRequests else { throw WorkspaceStoreError.noControlRequests }

        let requestID = await controlRequests.nextRequestID()
        let response = try await controlRequests.send(
            .workspaceSnapshot(ControlRequestIDOnly(requestID: requestID))
        )
        guard case let .workspaceSnapshot(result) = response else {
            throw WorkspaceStoreError.unexpectedResponse
        }
        applySnapshot(workspace: result.workspace, sequence: result.sequence)
        return result.workspace
    }

    /// Offline state stays on screen but must never look live. The last
    /// confirmed state and its timestamp are kept so the UI can say how old it
    /// is rather than blanking out.
    public func markDisconnected() {
        isStale = true
    }

    /// A new transport connection has its own sequence space. Keep the last
    /// known workspace visible while making the next authoritative snapshot
    /// the new sequence baseline.
    public func beginConnection() {
        sequence = 0
        isStale = true
        needsFullSnapshot = true
        isAwaitingConnectionSnapshot = true
    }

    public func setDraft(_ draft: String?, forPane paneID: String) {
        drafts[paneID] = draft
    }

    private func accept(workspace: WorkspaceSnapshot, sequence nextSequence: UInt64) {
        self.workspace = workspace
        sequence = nextSequence
        lastConfirmedAt = now()
        isStale = false
        needsFullSnapshot = false
        reconcileSelection()
        nowSections = Self.makeNowSections(workspace)
    }

    /// A pane or project can disappear between snapshots. Selection and drafts
    /// pointing at something the host no longer publishes are dropped rather
    /// than left dangling for the UI to dereference.
    private func reconcileSelection() {
        let located = Self.allPanes(in: workspace)
        let paneIDs = Set(located.map(\.pane.id))
        let projectIDs = Set(workspace?.projects.map(\.id) ?? [])

        if let selectedProjectID, !projectIDs.contains(selectedProjectID) {
            self.selectedProjectID = nil
        }
        if let primaryPaneID, !paneIDs.contains(primaryPaneID) {
            self.primaryPaneID = nil
        }
        if let secondaryPaneID, !paneIDs.contains(secondaryPaneID) {
            self.secondaryPaneID = nil
        }
        if primaryPaneID == nil {
            primaryPaneID = located.first?.pane.id
        }
        if secondaryPaneID != nil, secondaryPaneID == primaryPaneID {
            secondaryPaneID = nil
        }
        drafts = drafts.filter { paneIDs.contains($0.key) }
    }

    static func allPanes(in workspace: WorkspaceSnapshot?) -> [LocatedPane] {
        guard let workspace else { return [] }
        return workspace.projects.flatMap { project in
            let worktreePanes = project.worktrees.flatMap(\.panes)
            return (worktreePanes + project.projectPanes).map {
                LocatedPane(project: project, pane: $0)
            }
        }
    }

    static func makeNowSections(_ workspace: WorkspaceSnapshot) -> [NowSection] {
        let items = allPanes(in: workspace).map { located in
            NowItem(
                paneID: located.pane.id,
                projectID: located.project.id,
                projectTitle: located.project.title,
                title: located.pane.title ?? located.pane.id,
                agent: located.pane.agent,
                status: located.pane.status,
                needsAttention: located.pane.needsAttention ?? false,
                lastActivity: ISO8601Timestamp.date(from: located.pane.lastActivity)
            )
        }

        let grouped = Dictionary(grouping: items, by: \.sectionKind)
        return NowSectionKind.allCases.compactMap { kind in
            guard let sectionItems = grouped[kind], !sectionItems.isEmpty else { return nil }
            return NowSection(kind: kind, items: sectionItems.sorted(by: isOrderedBefore))
        }
    }

    /// Most recent first, then project, then pane title. `sorted` is not
    /// stable, so pane ID breaks any remaining tie — without a total order,
    /// panes that match on every visible field could swap places between
    /// identical snapshots.
    private static func isOrderedBefore(_ left: NowItem, _ right: NowItem) -> Bool {
        let leftDate = left.lastActivity ?? .distantPast
        let rightDate = right.lastActivity ?? .distantPast
        if leftDate != rightDate { return leftDate > rightDate }

        if left.projectTitle != right.projectTitle {
            return left.projectTitle.localizedStandardCompare(right.projectTitle) == .orderedAscending
        }
        if left.title != right.title {
            return left.title.localizedStandardCompare(right.title) == .orderedAscending
        }
        return left.paneID < right.paneID
    }

    struct LocatedPane {
        let project: WorkspaceProjectSnapshot
        let pane: WorkspacePaneSnapshot
    }
}
