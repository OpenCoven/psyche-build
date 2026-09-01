import Combine
import Foundation

public enum WorkspaceStoreError: Error, Sendable, Equatable, LocalizedError {
    case noControlRequests
    case staleWorkspace
    case unexpectedResponse
    case unknownProject(String)
    case unknownPane(String)
    case targetNotInProject(String)
    case rejected

    public var errorDescription: String? {
        switch self {
        case .noControlRequests:
            "This workspace is not connected to a host."
        case .staleWorkspace:
            "File inspection is unavailable while this workspace is out of date."
        case .unexpectedResponse:
            "The host answered the workspace request with something else."
        case .unknownProject(let projectID):
            "Project \(projectID) is not published by this host."
        case .unknownPane(let paneID):
            "Pane \(paneID) is not published by this host."
        case .targetNotInProject(let cwd):
            "\(cwd) is not this project's root or one of its worktrees."
        case .rejected:
            "The host refused the request."
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
    private var activeConnectionGeneration: ConnectionGeneration?

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
        guard activeConnectionGeneration == nil else { return }
        applyEventUnscoped(workspace: workspace, sequence: nextSequence)
    }

    func applyEvent(
        workspace: WorkspaceSnapshot,
        sequence nextSequence: UInt64,
        for generation: ConnectionGeneration
    ) {
        guard activeConnectionGeneration === generation else { return }
        _ = generation.withValidity {
            applyEventUnscoped(workspace: workspace, sequence: nextSequence)
        }
    }

    private func applyEventUnscoped(
        workspace: WorkspaceSnapshot,
        sequence nextSequence: UInt64
    ) {
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
        guard activeConnectionGeneration == nil else { return }
        applySnapshotUnscoped(workspace: workspace, sequence: nextSequence)
    }

    func applySnapshot(
        workspace: WorkspaceSnapshot,
        sequence nextSequence: UInt64,
        for generation: ConnectionGeneration
    ) {
        guard activeConnectionGeneration === generation else { return }
        _ = generation.withValidity {
            applySnapshotUnscoped(workspace: workspace, sequence: nextSequence)
        }
    }

    /// Revalidates readiness authorization and applies the complete snapshot
    /// synchronously on the main actor, preserving connection-generation
    /// ownership for subsequent events.
    func publishReadinessSnapshot(
        _ candidate: HostReadinessSnapshotCandidate,
        authorizedBy authorization: HostReadinessFlowAuthorization
    ) -> HostReadinessTransactionResult {
        authorization.withAuthorization {
            guard candidate.sequence >= sequence else {
                return .notCommitted(
                    reason: "The readiness snapshot is older than the visible workspace."
                )
            }
            applySnapshotUnscoped(
                workspace: candidate.workspace,
                sequence: candidate.sequence
            )
            return .committed
        } ?? .notCommitted(reason: nil)
    }

    private func applySnapshotUnscoped(
        workspace: WorkspaceSnapshot,
        sequence nextSequence: UInt64
    ) {
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
        if let generation = activeConnectionGeneration {
            applySnapshot(
                workspace: result.workspace,
                sequence: result.sequence,
                for: generation
            )
        } else {
            applySnapshot(workspace: result.workspace, sequence: result.sequence)
        }
        return result.workspace
    }

    // MARK: - Commands

    /// Creates a pane in a published project, at that project's root or one of
    /// its worktrees.
    ///
    /// The target is checked here as well as on the host: a client sending an
    /// unpublished target has a bug worth reporting immediately rather than a
    /// round trip later.
    @discardableResult
    public func createPane(
        kind: PaneCreateKind,
        projectID: String,
        cwd: String,
        idempotencyKey: String = UUID().uuidString,
        branch: String? = nil,
        startPointBranch: String? = nil,
        agent: String? = nil,
        title: String? = nil,
        prompt: String? = nil
    ) async throws -> PaneSpawnedResponse {
        let requests = try requireControlRequests()
        try requireLaunchTarget(projectID: projectID, cwd: cwd)

        let response = try await requests.send(.spawnPane(MobilePaneSpawnRequest(
            requestID: await requests.nextRequestID(),
            idempotencyKey: idempotencyKey,
            kind: kind,
            projectID: projectID,
            cwd: cwd,
            branch: branch,
            startPointBranch: startPointBranch,
            agent: agent,
            title: title,
            prompt: prompt,
            existingWorktree: nil
        )))
        guard case let .paneSpawned(result) = response else {
            throw WorkspaceStoreError.unexpectedResponse
        }
        return result
    }

    public func renamePane(_ paneID: String, title: String?, agent: String? = nil) async throws {
        let requests = try requireControlRequests()
        try requirePublishedPane(paneID)

        try requireAck(await requests.send(.paneMeta(PaneMetaRequest(
            requestID: await requests.nextRequestID(),
            id: paneID,
            title: title,
            agent: agent
        ))))
    }

    /// Stops the pane's process. The worktree and branch survive — this is not
    /// a cleanup, and the UI must not present it as one.
    public func stopPane(_ paneID: String) async throws {
        let requests = try requireControlRequests()
        try requirePublishedPane(paneID)

        try requireAck(await requests.send(.killPane(PaneIDControlRequest(
            requestID: await requests.nextRequestID(),
            paneID: paneID
        ))))
    }

    /// Launches a ritual in a published project. Params travel as-is; the
    /// host decides what they mean.
    public func launchRitual(
        _ ritualID: String,
        inProject projectID: String,
        params: [String: String] = [:]
    ) async throws {
        let requests = try requireControlRequests()
        guard workspace?.projects.contains(where: { $0.id == projectID }) == true else {
            throw WorkspaceStoreError.unknownProject(projectID)
        }

        try requireAck(await requests.send(.launchRitual(MobileRitualLaunchRequest(
            requestID: await requests.nextRequestID(),
            projectID: projectID,
            ritualID: ritualID,
            params: params.isEmpty ? nil : params
        ))))
    }

    /// Returns the bounded file index published for a pane's current worktree.
    /// Inspection never runs against stale workspace state because the pane may
    /// have moved or disappeared since the last confirmed snapshot.
    public func listFiles(inPane paneID: String) async throws -> BrowserSnapshot {
        let requests = try requireInspectionRequests(forPane: paneID)
        let requestID = await requests.nextRequestID()
        let response = try await requests.send(.listFiles(MobileFilesListRequest(
            requestID: requestID,
            paneID: paneID
        )))
        guard case let .filesList(result) = response,
              result.requestID == requestID,
              result.paneID == paneID
        else {
            throw WorkspaceStoreError.unexpectedResponse
        }
        return result.snapshot
    }

    public func readFile(_ path: String, inPane paneID: String) async throws -> MobileFilesReadResult {
        let requests = try requireInspectionRequests(forPane: paneID)
        let requestID = await requests.nextRequestID()
        let response = try await requests.send(.readFile(MobileFilesReadRequest(
            requestID: requestID,
            paneID: paneID,
            path: path
        )))
        guard case let .filesRead(result) = response,
              result.requestID == requestID,
              result.paneID == paneID,
              result.path == path
        else {
            throw WorkspaceStoreError.unexpectedResponse
        }
        return result
    }

    public func diffFile(_ path: String, inPane paneID: String) async throws -> String {
        let requests = try requireInspectionRequests(forPane: paneID)
        let requestID = await requests.nextRequestID()
        let response = try await requests.send(.diffFile(MobileFilesDiffRequest(
            requestID: requestID,
            paneID: paneID,
            path: path
        )))
        guard case let .filesDiff(result) = response,
              result.requestID == requestID,
              result.paneID == paneID,
              result.path == path
        else {
            throw WorkspaceStoreError.unexpectedResponse
        }
        return result.diff
    }

    // MARK: - Command helpers

    private func requireControlRequests() throws -> any ControlRequesting {
        guard let controlRequests else { throw WorkspaceStoreError.noControlRequests }
        return controlRequests
    }

    private func requireInspectionRequests(
        forPane paneID: String
    ) throws -> any ControlRequesting {
        let requests = try requireControlRequests()
        guard !isStale else { throw WorkspaceStoreError.staleWorkspace }
        try requirePublishedPane(paneID)
        return requests
    }

    /// An ack that says it failed is not a success. Accepting any response as
    /// one is how a refused command ends up looking like it worked.
    private func requireAck(_ response: MobileControlResponse) throws {
        guard case let .ack(ack) = response else {
            throw WorkspaceStoreError.unexpectedResponse
        }
        guard ack.ok else { throw WorkspaceStoreError.rejected }
    }

    private func requireLaunchTarget(projectID: String, cwd: String) throws {
        guard let project = workspace?.projects.first(where: { $0.id == projectID }) else {
            throw WorkspaceStoreError.unknownProject(projectID)
        }
        let isPublishedTarget = project.root == cwd
            || project.worktrees.contains { $0.path == cwd }
        guard isPublishedTarget else {
            throw WorkspaceStoreError.targetNotInProject(cwd)
        }
    }

    private func requirePublishedPane(_ paneID: String) throws {
        let isPublished = Self.allPanes(in: workspace).contains { $0.pane.id == paneID }
        guard isPublished else { throw WorkspaceStoreError.unknownPane(paneID) }
    }

    /// Offline state stays on screen but must never look live. The last
    /// confirmed state and its timestamp are kept so the UI can say how old it
    /// is rather than blanking out.
    public func markDisconnected() {
        activeConnectionGeneration = nil
        isStale = true
    }

    func markReadinessStale() {
        isStale = true
    }

    func markDisconnected(for generation: ConnectionGeneration) {
        guard activeConnectionGeneration === generation else { return }
        activeConnectionGeneration = nil
        isStale = true
    }

    /// A new transport connection has its own sequence space. Keep the last
    /// known workspace visible while making the next authoritative snapshot
    /// the new sequence baseline.
    public func beginConnection() {
        activeConnectionGeneration = nil
        beginConnectionState()
    }

    func beginConnection(for generation: ConnectionGeneration) {
        _ = generation.withValidity {
            activeConnectionGeneration = generation
            beginConnectionState()
        }
    }

    private func beginConnectionState() {
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
