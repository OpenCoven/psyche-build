import Foundation

/// A host this device has completed pairing with. The server ID is the
/// identity — names change, addresses move between networks, and tokens are
/// reissued, but a server ID that starts presenting a different certificate is
/// a different host until the user says otherwise.
public struct PairedHost: Codable, Sendable, Equatable, Identifiable {
    public let serverID: String
    public let serverName: String
    public let endpoint: HostEndpoint
    public let clientID: String
    public let token: String?

    public var id: String { serverID }
    public var certificateFingerprint: String { endpoint.certificateFingerprint }

    public init(
        serverID: String,
        serverName: String,
        endpoint: HostEndpoint,
        clientID: String,
        token: String?
    ) {
        self.serverID = serverID
        self.serverName = serverName
        self.endpoint = endpoint
        self.clientID = clientID
        self.token = token
    }

    public func withToken(_ token: String?) -> PairedHost {
        PairedHost(
            serverID: serverID,
            serverName: serverName,
            endpoint: endpoint,
            clientID: clientID,
            token: token
        )
    }

    public func withEndpoint(_ endpoint: HostEndpoint) -> PairedHost {
        PairedHost(
            serverID: serverID,
            serverName: serverName,
            endpoint: endpoint,
            clientID: clientID,
            token: token
        )
    }
}

/// Whether a host the user is looking at can be connected to directly, or is
/// carrying a certificate that no longer matches what was pinned at pairing.
public enum PairingStatus: String, Codable, Sendable, Equatable {
    case unpaired
    case paired
    case requiresRePairing
}


// MARK: - Atomic host readiness (issue #241, slice 1)

/// Where a connection to a host stands in the readiness contract. The raw
/// values are the contract state names from issue #241 and are stable
/// identifiers for logs and diagnostics; the case names follow repository
/// Swift style.
public enum HostReadinessState: String, Codable, Sendable, Equatable, CaseIterable {
    case unknown
    case discovering
    case pairing
    case authenticating
    case hostCommitted = "host_committed"
    case synchronizing
    case ready
    case degraded
    case reconnecting
    case revoked
}

/// The failure boundaries the readiness contract defines rollback behavior
/// for. Each one maps to exactly one deterministic rollback — never to a
/// success-shaped workspace.
public enum HostReadinessFailureBoundary: String, CaseIterable, Sendable, Equatable {
    case transport
    case authentication
    case secureStore
    case decodeRevision
    case workspaceApply
    case revocation
}

/// One recorded readiness failure: which boundary failed and what the machine
/// was doing when it did.
public struct HostReadinessFailure: Equatable, Sendable {
    public let boundary: HostReadinessFailureBoundary
    public let reason: String?
    public let stateAtFailure: HostReadinessState

    public init(
        boundary: HostReadinessFailureBoundary,
        reason: String?,
        stateAtFailure: HostReadinessState
    ) {
        self.boundary = boundary
        self.reason = reason
        self.stateAtFailure = stateAtFailure
    }
}

/// The inputs that move readiness forward. The transition table is the single
/// authority for which event is legal in which state, and
/// `HostReadinessMachine` is its only writer, so the table doubles as the
/// reviewed contract. Failures do not ride this enum: they resolve through
/// the boundary table, which needs machine state (`hasCommittedHost`) that a
/// pure event cannot carry.
public enum HostReadinessEvent: Equatable, Sendable {
    case discoveryStarted
    case reconnectionStarted
    case pairingStarted
    case authenticationStarted
    case hostCommitSucceeded
    case synchronizationStarted
    case workspaceAccepted
    case connectionLost
    case revoked
}

/// The pure readiness transition table. A `nil` destination means the event
/// is rejected in that state and nothing changes — readiness never guesses.
///
/// The spine `pairing → authenticating → host_committed → synchronizing →
/// ready` is the atomic sequence: host identity is durably committed
/// (`host_committed`) before any snapshot may be applied, and `ready` is
/// reachable only through a snapshot that validated and was accepted after
/// that commit.
public enum HostReadinessTransitions {
    /// Destination for a non-failure event from `state`, or `nil` when the
    /// event is rejected in that state.
    public static func destination(
        for event: HostReadinessEvent,
        from state: HostReadinessState
    ) -> HostReadinessState? {
        switch event {
        case .revoked:
            // Revocation fails closed from everywhere, and is idempotent once
            // revoked so a duplicate notice cannot surface as an error.
            return .revoked
        case .discoveryStarted:
            switch state {
            case .unknown, .reconnecting, .degraded, .revoked:
                return .discovering
            case .discovering, .pairing, .authenticating, .hostCommitted, .synchronizing, .ready:
                return nil
            }
        case .reconnectionStarted:
            switch state {
            case .unknown, .discovering, .degraded, .ready, .reconnecting:
                // `reconnecting → reconnecting` retries the stored host and
                // replaces any abandoned reconnection flow.
                return .reconnecting
            case .pairing, .authenticating, .hostCommitted, .synchronizing, .revoked:
                return nil
            }
        case .pairingStarted:
            // Discovery is the normal path to a selected host, a manual
            // endpoint skips it, and pairing a new host while one is ready is
            // exactly the retarget flow whose authority must be atomic — so
            // pairing may start from any of those.
            guard state == .discovering || state == .unknown || state == .ready else {
                return nil
            }
            return .pairing
        case .authenticationStarted:
            guard state == .pairing || state == .reconnecting else { return nil }
            return .authenticating
        case .hostCommitSucceeded:
            guard state == .authenticating else { return nil }
            return .hostCommitted
        case .synchronizationStarted:
            guard state == .hostCommitted else { return nil }
            return .synchronizing
        case .workspaceAccepted:
            guard state == .synchronizing else { return nil }
            return .ready
        case .connectionLost:
            guard state == .ready else { return nil }
            return .reconnecting
        }
    }

    /// Failure destinations. `hasCommittedHost` — whether any host identity
    /// was ever durably committed — decides between preserving previous
    /// authority (degraded or reconnecting, stale state preserved) and
    /// reporting that nothing authoritative ever existed (`unknown`, no
    /// workspace state). Transport loss on a live connection is reported as
    /// `connectionLost`, not `.failed(.transport)`.
    public static func destination(
        forFailure boundary: HostReadinessFailureBoundary,
        from state: HostReadinessState,
        hasCommittedHost: Bool
    ) -> HostReadinessState? {
        switch boundary {
        case .revocation:
            return .revoked
        case .transport:
            switch state {
            case .pairing, .authenticating, .hostCommitted, .synchronizing:
                // A lost transport aims straight back at the committed host;
                // its workspace stays on screen, clearly labeled stale.
                return hasCommittedHost ? .reconnecting : .unknown
            case .reconnecting:
                // The stored host never came up; stop automatic retrying.
                return .degraded
            case .ready:
                // Use `connectionLost` instead.
                return nil
            case .unknown, .discovering, .degraded, .revoked:
                return nil
            }
        case .authentication, .secureStore, .decodeRevision, .workspaceApply:
            switch state {
            case .pairing, .authenticating, .hostCommitted, .synchronizing, .reconnecting, .ready:
                return hasCommittedHost ? .degraded : .unknown
            case .unknown, .discovering, .degraded, .revoked:
                // Resting states own no flow, so failure events are inert
                // there; recovery starts a new flow.
                return nil
            }
        }
    }
}

/// What the workspace surface is allowed to show, and under which label.
/// Stale state is semantically distinct from live state: it is the last
/// confirmed workspace of a host this device previously trusted, and it must
/// never present as current while readiness is not `ready`.
public enum HostWorkspacePresentation: Equatable, Sendable {
    case noState
    case live(hostID: String, confirmedAt: Date)
    case stale(hostID: String, confirmedAt: Date)
}

/// The workspace payload a readiness flow synchronizes, with the sequence that
/// orders it. Decoding and revision validation happen behind the validation
/// adapter; the machine guarantees they run — and that the workspace is
/// applied — only after the host identity is durably committed.
public struct HostReadinessSnapshotCandidate: Sendable, Equatable {
    public let workspace: WorkspaceSnapshot
    public let sequence: UInt64

    public init(workspace: WorkspaceSnapshot, sequence: UInt64) {
        self.workspace = workspace
        self.sequence = sequence
    }
}

/// One readiness attempt. A flow is the unit of ownership: every boundary
/// call takes a flow, and only the flow the machine currently owns may commit
/// identity or apply a snapshot. A concurrent or superseded flow fails closed
/// instead of overwriting committed authority.
public struct HostReadinessFlow: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        /// A new host, or a re-pair. `expectedServerID` is set when the flow
        /// targets a known identity that must not be contradicted.
        case pairing(expectedServerID: String?)
        /// A reconnect to the already-committed authority.
        case reconnection(expectedServerID: String)
    }

    public let id: UUID
    public let kind: Kind

    init(id: UUID, kind: Kind) {
        self.id = id
        self.kind = kind
    }

    /// The identity this flow must not contradict when it commits, if it
    /// named one at all.
    public var expectedServerID: String? {
        switch kind {
        case .pairing(let expectedServerID): expectedServerID
        case .reconnection(let expectedServerID): expectedServerID
        }
    }
}

public enum HostReadinessError: Error, Equatable, Sendable, LocalizedError {
    case flowAlreadyActive(serverID: String?)
    case supersededFlow
    case transitionRejected(from: HostReadinessState, event: String)
    case committedHostRequired
    case wrongHostIdentity(expected: String, actual: String)

    public var errorDescription: String? {
        switch self {
        case .flowAlreadyActive:
            "A host readiness flow is already in progress."
        case .supersededFlow:
            "This readiness flow was superseded and can no longer change committed state."
        case .transitionRejected(let from, let event):
            "Host readiness cannot move from \(from.rawValue) by \(event)."
        case .committedHostRequired:
            "Reconnection requires a committed host identity."
        case .wrongHostIdentity(let expected, let actual):
            "Expected paired host \(expected), but the host identified itself as \(actual)."
        }
    }
}

/// A prepared externally visible state change. Preparation may suspend, but
/// publication cannot: the operation must synchronously perform one atomic,
/// all-or-nothing mutation or throw without changing externally visible state.
///
/// The readiness actor invokes the operation only after rechecking flow
/// ownership, then updates its matching internal state without yielding. This
/// makes the external publication and readiness transition one serialized
/// critical section with respect to revocation and replacement flows.
public struct HostReadinessPublication: Sendable {
    private let operation: @Sendable () throws -> Void

    public init(_ operation: @escaping @Sendable () throws -> Void) {
        self.operation = operation
    }

    fileprivate func publish() throws {
        try operation()
    }
}

/// The boundaries a readiness flow crosses, bound to their concrete
/// implementations at composition time. Async adapters may prepare a
/// publication but must not mutate durable or visible authoritative state.
/// Their returned `HostReadinessPublication` performs the final mutation
/// synchronously and atomically after the machine revalidates flow ownership.
public struct HostReadinessAdapters: Sendable {
    /// Prepares an atomic secure-store publication for the authoritative
    /// paired-host identity and selected-host state.
    public let prepareHostIdentity: @Sendable (PairedHost) async throws -> HostReadinessPublication
    /// The decode/revision boundary. Runs after the commit succeeded and
    /// before anything touches the workspace.
    public let validateSnapshot: @Sendable (HostReadinessSnapshotCandidate) async throws -> Void
    /// Prepares an atomic publication of an already-validated workspace.
    public let prepareWorkspace: @Sendable (HostReadinessSnapshotCandidate) async throws -> HostReadinessPublication

    public init(
        prepareHostIdentity: @escaping @Sendable (PairedHost) async throws -> HostReadinessPublication,
        validateSnapshot: @escaping @Sendable (HostReadinessSnapshotCandidate) async throws -> Void,
        prepareWorkspace: @escaping @Sendable (HostReadinessSnapshotCandidate) async throws -> HostReadinessPublication
    ) {
        self.prepareHostIdentity = prepareHostIdentity
        self.validateSnapshot = validateSnapshot
        self.prepareWorkspace = prepareWorkspace
    }
}

/// The atomic host-readiness state machine (issue #241, slice 1).
///
/// One authority at a time. The machine carries the durably committed host
/// identity and what the workspace surface may show, and enforces that a new
/// host's workspace snapshot becomes authoritative only after authentication,
/// the secure-store commit of that identity, decode/revision validation, and
/// workspace acceptance have all succeeded, in that order.
///
/// Every failure boundary rolls back deterministically: freshly fetched state
/// is never applied, the previously authoritative host's workspace stays on
/// screen labeled stale (or there is no state at all for a failed first host),
/// and revocation or a wrong-host identity fails closed. A concurrent or
/// superseded flow cannot overwrite committed authority — only the flow the
/// machine currently owns can cross the commit boundary.
public actor HostReadinessMachine {
    public private(set) var state: HostReadinessState
    /// What the workspace surface may show. `stale` is semantically distinct
    /// from `live`: it is previously authoritative state, never current.
    public private(set) var presentation: HostWorkspacePresentation
    /// The host identity durably committed and currently authoritative.
    /// Updated only after the secure-store commit succeeds.
    public private(set) var committedHost: PairedHost?
    public private(set) var lastFailure: HostReadinessFailure?
    public private(set) var activeFlow: HostReadinessFlow?

    private let adapters: HostReadinessAdapters
    private let now: @Sendable () -> Date

    public init(
        committedHost: PairedHost? = nil,
        adapters: HostReadinessAdapters,
        now: @escaping @Sendable () -> Date = Date.init
    ) {
        self.committedHost = committedHost
        self.adapters = adapters
        self.now = now
        state = .unknown
        presentation = .noState
    }

    /// Starts browsing for hosts. Discovery is not a readiness flow: nothing
    /// is torn down, so the workspace presentation is left untouched.
    @discardableResult
    public func beginDiscovery() throws -> HostReadinessState {
        try requireIdle()
        return try apply(.discoveryStarted)
    }

    /// Begins a pairing flow toward a (possibly not yet identified) host.
    ///
    /// From here on the visible workspace cannot vouch for itself — the
    /// single transport is about to be retargeted — so a live presentation is
    /// relabeled stale immediately, not only after a failure.
    public func beginPairing(expectedServerID: String? = nil) throws -> HostReadinessFlow {
        try beginFlow(.pairing(expectedServerID: expectedServerID), event: .pairingStarted)
    }

    /// Begins reconnecting to the committed host.
    public func beginReconnection() throws -> HostReadinessFlow {
        guard let committedHost else {
            throw HostReadinessError.committedHostRequired
        }
        return try beginFlow(
            .reconnection(expectedServerID: committedHost.serverID),
            event: .reconnectionStarted
        )
    }

    /// The pair request was accepted (or the stored host answered) and the
    /// handshake with the selected identity is in flight.
    @discardableResult
    public func markAuthenticated(for flow: HostReadinessFlow) throws -> HostReadinessState {
        try requireActive(flow)
        return try apply(.authenticationStarted)
    }

    /// Persists the authoritative paired-host identity and selected-host
    /// state BEFORE any workspace snapshot can be applied.
    ///
    /// The secure-store adapter must complete first; if it throws, the flow
    /// rolls back and the snapshot is never applied. A wrong host identity
    /// fails closed as a revocation without touching committed authority.
    public func commitHostIdentity(
        _ host: PairedHost,
        for flow: HostReadinessFlow
    ) async throws {
        try requireActive(flow)
        if let expected = flow.expectedServerID, host.serverID != expected {
            failClosed(.revocation, reason: HostReadinessError
                .wrongHostIdentity(expected: expected, actual: host.serverID)
                .localizedDescription)
            throw HostReadinessError.wrongHostIdentity(
                expected: expected,
                actual: host.serverID
            )
        }
        let publication: HostReadinessPublication
        do {
            publication = try await adapters.prepareHostIdentity(host)
        } catch {
            _ = try rollback(.secureStore, reason: error.localizedDescription, for: flow)
            throw error
        }
        guard activeFlow == flow, state == .authenticating else {
            throw HostReadinessError.supersededFlow
        }
        do {
            try publication.publish()
            committedHost = host
            _ = try apply(.hostCommitSucceeded)
        } catch {
            _ = try rollback(.secureStore, reason: error.localizedDescription, for: flow)
            throw error
        }
    }

    /// Takes an already-fetched snapshot candidate through the remaining
    /// readiness gates in the only order that can make it authoritative:
    /// decode/revision validation, workspace acceptance, and only then
    /// `ready`. Nothing else may label state ready.
    public func synchronizeWorkspace(
        _ candidate: HostReadinessSnapshotCandidate,
        for flow: HostReadinessFlow
    ) async throws {
        try requireActive(flow)
        guard state == .hostCommitted else {
            throw HostReadinessError.transitionRejected(
                from: state,
                event: "synchronizationStarted"
            )
        }
        _ = try apply(.synchronizationStarted)

        do {
            try await adapters.validateSnapshot(candidate)
        } catch {
            _ = try rollback(.decodeRevision, reason: error.localizedDescription, for: flow)
            throw error
        }
        guard activeFlow == flow, state == .synchronizing else {
            throw HostReadinessError.supersededFlow
        }

        let publication: HostReadinessPublication
        do {
            publication = try await adapters.prepareWorkspace(candidate)
        } catch {
            _ = try rollback(.workspaceApply, reason: error.localizedDescription, for: flow)
            throw error
        }

        guard activeFlow == flow, state == .synchronizing else {
            throw HostReadinessError.supersededFlow
        }

        do {
            try publication.publish()
            _ = try apply(.workspaceAccepted)
            lastFailure = nil
            activeFlow = nil
            presentation = .live(
                hostID: committedHost?.serverID ?? "",
                confirmedAt: now()
            )
        } catch {
            _ = try rollback(.workspaceApply, reason: error.localizedDescription, for: flow)
            throw error
        }
    }

    /// The active flow failed at one boundary. Rolls the machine back
    /// deterministically: the presentation keeps the previously authoritative
    /// workspace labeled stale (or stays empty for a failed first host), the
    /// flow is discarded, and the destination follows the boundary table.
    @discardableResult
    public func fail(
        _ boundary: HostReadinessFailureBoundary,
        reason: String? = nil,
        for flow: HostReadinessFlow
    ) throws -> HostReadinessState {
        try requireActive(flow)
        return try rollback(boundary, reason: reason, for: flow)
    }

    /// A passive transport loss on a live connection: the last confirmed
    /// workspace stays visible but is labeled stale, and readiness aims at
    /// the stored host again.
    @discardableResult
    public func noteConnectionLost() throws -> HostReadinessState {
        let destination = try apply(.connectionLost)
        relabelForFlowStart()
        return destination
    }

    /// Trust was withdrawn — credential revocation or a wrong-host identity.
    /// Fails closed from any state: nothing freshly fetched becomes visible,
    /// previously authoritative state stays clearly labeled stale, and the
    /// committed identity survives on disk for the explicit re-pair path.
    @discardableResult
    public func revoke(reason: String? = nil) throws -> HostReadinessState {
        let from = state
        let destination = try apply(.revoked)
        relabelForFlowStart()
        lastFailure = HostReadinessFailure(
            boundary: .revocation,
            reason: reason,
            stateAtFailure: from
        )
        activeFlow = nil
        return destination
    }

    // MARK: - Internals

    private func beginFlow(_ kind: HostReadinessFlow.Kind, event: HostReadinessEvent) throws -> HostReadinessFlow {
        try requireIdle()
        _ = try apply(event)
        relabelForFlowStart()
        lastFailure = nil
        let flow = HostReadinessFlow(id: UUID(), kind: kind)
        activeFlow = flow
        return flow
    }

    /// Fails closed without touching committed authority — used when a flow
    /// contradicts the identity it committed to.
    private func failClosed(_ boundary: HostReadinessFailureBoundary, reason: String?) {
        lastFailure = HostReadinessFailure(
            boundary: boundary,
            reason: reason,
            stateAtFailure: state
        )
        activeFlow = nil
        state = .revoked
    }

    /// A flow-less event (discovery) may not start while a flow owns the
    /// machine.
    private func requireIdle() throws {
        guard activeFlow == nil else {
            throw HostReadinessError.flowAlreadyActive(
                serverID: activeFlow?.expectedServerID
            )
        }
    }

    private func requireActive(_ flow: HostReadinessFlow) throws {
        guard activeFlow == flow else {
            throw HostReadinessError.supersededFlow
        }
    }

    private func apply(_ event: HostReadinessEvent) throws -> HostReadinessState {
        guard let destination = HostReadinessTransitions.destination(
            for: event,
            from: state
        ) else {
            throw HostReadinessError.transitionRejected(
                from: state,
                event: String(describing: event)
            )
        }
        state = destination
        return destination
    }

    private func rollback(
        _ boundary: HostReadinessFailureBoundary,
        reason: String?,
        for flow: HostReadinessFlow
    ) throws -> HostReadinessState {
        guard activeFlow == flow else {
            throw HostReadinessError.supersededFlow
        }
        let from = state
        guard let destination = HostReadinessTransitions.destination(
            forFailure: boundary,
            from: from,
            hasCommittedHost: committedHost != nil
        ) else {
            throw HostReadinessError.transitionRejected(
                from: from,
                event: "failed(\(boundary.rawValue))"
            )
        }
        lastFailure = HostReadinessFailure(
            boundary: boundary,
            reason: reason,
            stateAtFailure: from
        )
        activeFlow = nil
        state = destination
        return destination
    }

    /// Beginning any readiness flow relabels a live workspace stale: with the
    /// single transport about to be retargeted, readiness cannot vouch for
    /// the visible workspace until the new host is committed and accepted.
    private func relabelForFlowStart() {
        if case .live(let hostID, let confirmedAt) = presentation {
            presentation = .stale(hostID: hostID, confirmedAt: confirmedAt)
        }
    }
}
