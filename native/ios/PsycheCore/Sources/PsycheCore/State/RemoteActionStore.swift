import Combine
import Foundation

public enum RemoteActionStoreError: Error, Sendable, Equatable, LocalizedError {
    case unexpectedResponse

    public var errorDescription: String? {
        "The host returned an unexpected action response. Refresh the workspace and try again."
    }
}

/// Host error codes raised before the action callback runs, so they prove the
/// request had no effect.
///
/// Deliberately a closed allowlist rather than "any host error": the daemon
/// converts an exception thrown from inside a running action into a generic
/// `internal_error`, which is indistinguishable from a partially applied
/// effect. Anything not listed here keeps the outcome unknown.
let NO_EFFECT_HOST_ERROR_CODES: Set<String> = [
    "action_session_not_found",
    "action_session_limit",
    "invalid_action_response",
    "invalid_action_state",
    "project_scope_violation",
    "unknown_pane",
]

/// A consequential request whose reply was lost after dispatch.
///
/// The host may have executed it. Every field here exists so the outcome can be
/// reconciled against the host rather than guessed: nothing derived from user
/// input, credentials or prompts is retained.
public struct UnknownActionOutcome: Sendable, Equatable, Identifiable {
    public let requestID: String
    public let sessionID: String?
    public let paneID: String
    public let action: PaneAction
    public let scope: RemoteActionScope
    public let message: String

    public var id: String { requestID }

    public init(
        requestID: String,
        sessionID: String?,
        paneID: String,
        action: PaneAction,
        scope: RemoteActionScope,
        message: String
    ) {
        self.requestID = requestID
        self.sessionID = sessionID
        self.paneID = paneID
        self.action = action
        self.scope = scope
        self.message = message
    }
}

/// How an operator resolved an unknown outcome after observing the host.
public enum UnknownActionResolution: Sendable, Equatable {
    /// The host shows the effect did happen.
    case observedApplied
    /// The host shows the effect did not happen.
    case observedNotApplied
}

@MainActor
public final class RemoteActionStore: ObservableObject {
    @Published public private(set) var presentation: RemoteActionPresentation?
    @Published public private(set) var busyPaneIDs: Set<String> = []
    @Published public private(set) var isSubmitting = false
    /// Panes whose last consequential request has an unknown outcome, keyed by
    /// pane. Published so a host switch or reconnect cannot quietly drop them.
    @Published public private(set) var unknownOutcomes: [String: UnknownActionOutcome] = [:]

    private let controlRequests: (any ControlRequesting)?
    private var operationToken: UUID?

    public init(controlRequests: (any ControlRequesting)? = nil) {
        self.controlRequests = controlRequests
    }

    public func isBusy(_ paneID: String) -> Bool {
        busyPaneIDs.contains(paneID)
    }

    public func canStartAction(onPane paneID: String) -> Bool {
        operationToken == nil
            && presentation == nil
            && !isSubmitting
            && !busyPaneIDs.contains(paneID)
            && unknownOutcomes[paneID] == nil
    }

    public func unknownOutcome(forPane paneID: String) -> UnknownActionOutcome? {
        unknownOutcomes[paneID]
    }

    /// The explicit operator recovery path out of an unknown outcome.
    ///
    /// Nothing else clears one: not dismissing, not reconnecting, not switching
    /// hosts. The caller states what the host was observed to show, so the guard
    /// is released against an observation rather than against a timer.
    public func resolveUnknownOutcome(
        forPane paneID: String,
        as resolution: UnknownActionResolution
    ) {
        guard let outcome = unknownOutcomes.removeValue(forKey: paneID) else {
            return
        }
        busyPaneIDs.remove(paneID)
        if presentation?.requiresReconciliation == true,
           presentation?.paneID == paneID {
            // An applied action is not a failure. Rendering it as one after the
            // guard is released is how an operator ends up retrying something
            // that already happened.
            presentation = .reconciled(
                requestID: outcome.requestID,
                paneID: paneID,
                action: outcome.action,
                resolution: resolution
            )
        }
    }

    public func start(
        action: PaneAction,
        onPane paneID: String,
        in workspace: WorkspaceSnapshot
    ) async {
        guard canStartAction(onPane: paneID)
        else {
            return
        }

        let token = UUID()
        operationToken = token
        defer {
            if operationToken == token {
                operationToken = nil
            }
        }

        guard containsPane(paneID, in: workspace) else {
            fail(
                paneID: paneID,
                action: action,
                message: "Pane \(paneID) is not published by this host. Refresh the workspace and try again."
            )
            return
        }
        guard let controlRequests else {
            fail(
                paneID: paneID,
                action: action,
                message: "This action is not connected to a host. Reconnect and try again."
            )
            return
        }

        busyPaneIDs.insert(paneID)
        presentation = .progress(paneID: paneID, action: action)
        let requestID = await controlRequests.nextRequestID()

        do {
            let response = try await controlRequests.send(.startAction(
                MobileActionStartRequest(
                    requestID: requestID,
                    paneID: paneID,
                    action: action
                )
            ))
            try apply(
                response,
                expectedRequestID: requestID,
                paneID: paneID,
                action: action
            )
        } catch {
            fail(
                paneID: paneID,
                action: action,
                message: error.localizedDescription
            )
        }
    }

    public func respond(
        _ response: MobileActionResponse,
        recoveryText: String? = nil
    ) async {
        guard operationToken == nil,
              !isSubmitting,
              let current = presentation,
              current.isInteractive,
              let sessionID = current.sessionID,
              let controlRequests
        else {
            return
        }

        let token = UUID()
        operationToken = token
        isSubmitting = true
        presentation = current.consumingSession()
        let requestID = await controlRequests.nextRequestID()
        defer {
            if operationToken == token {
                operationToken = nil
            }
            isSubmitting = false
        }

        do {
            let result = try await controlRequests.send(.respondToAction(
                MobileActionRespondRequest(
                    requestID: requestID,
                    sessionID: sessionID,
                    response: response
                )
            ))
            try apply(
                result,
                expectedRequestID: requestID,
                paneID: current.paneID,
                action: current.action,
                inheriting: current
            )
        } catch {
            // The session was consumed before dispatch, so by the time this
            // runs the host may already have executed a consequential effect.
            // Only a provably undispatched request, or an authoritative host
            // answer, may be reported as an ordinary failure.
            if current.action.mayHaveConsequentialEffect, mayHaveReachedHost(error) {
                // `recoveryText` is the operator's literal draft. An unknown
                // outcome persists until it is resolved by hand, so attaching
                // the draft would hold raw input in published state for an
                // unbounded time. The draft stays in the editor, not here.
                recordUnknownOutcome(
                    requestID: requestID,
                    sessionID: sessionID,
                    presentation: current,
                    message: error.localizedDescription
                )
            } else {
                fail(
                    paneID: current.paneID,
                    action: current.action,
                    message: error.localizedDescription,
                    recoveryText: recoveryText
                )
            }
        }
    }

    public func dismiss() {
        guard let presentation,
              !presentation.isInteractive,
              presentation.dismissable,
              !isSubmitting
        else {
            return
        }
        self.presentation = nil
    }
}

private extension RemoteActionStore {
    func apply(
        _ response: MobileControlResponse,
        expectedRequestID: String,
        paneID: String,
        action: PaneAction,
        inheriting previous: RemoteActionPresentation? = nil
    ) throws {
        switch response {
        case .actionResult(let payload):
            guard payload.requestID == expectedRequestID else {
                throw RemoteActionStoreError.unexpectedResponse
            }
            let next = try RemoteActionPresentation.make(
                response: payload,
                paneID: paneID,
                action: action,
                inheriting: previous
            )
            presentation = next
            if !next.isInteractive {
                busyPaneIDs.remove(paneID)
            }
        case .error(let error):
            throw error
        default:
            throw RemoteActionStoreError.unexpectedResponse
        }
    }

    func fail(
        paneID: String,
        action: PaneAction,
        message: String,
        recoveryText: String? = nil
    ) {
        busyPaneIDs.remove(paneID)
        presentation = .failure(
            paneID: paneID,
            action: action,
            message: message,
            recoveryText: recoveryText
        )
    }

    /// Whether a failed request may already have taken effect on the host.
    ///
    /// Two things make an outcome known: the request provably never left this
    /// device, or the host answered. A timeout, a dropped connection, a
    /// cancellation or a reply that could not be interpreted establish neither,
    /// and a control-request timeout does not cancel host execution.
    func mayHaveReachedHost(_ error: any Error) -> Bool {
        if let hostError = error as? MobileProtocolErrorResponse {
            // The host answering is not the same as the host doing nothing.
            // `RemoteActionSessions.respond` consumes the session and then
            // awaits the action itself, so a throw from inside a partially
            // applied effect reaches this device as the daemon's generic
            // `internal_error` backstop. Only codes raised before any callback
            // runs prove there was no effect.
            return !NO_EFFECT_HOST_ERROR_CODES.contains(hostError.code)
        }
        if let requestError = error as? ControlRequestError {
            switch requestError {
            case .missingRequestID, .duplicateRequestID, .notConnected:
                // Refused before registration, so nothing was transmitted.
                return false
            case .timedOut, .disconnected:
                // Both mean this client stopped waiting, not that the host
                // stopped working. `.disconnected` now names only the in-flight
                // case, where bytes may already have reached the host.
                return true
            }
        }
        return true
    }

    func recordUnknownOutcome(
        requestID: String,
        sessionID: String,
        presentation current: RemoteActionPresentation,
        message: String
    ) {
        let outcome = UnknownActionOutcome(
            requestID: requestID,
            sessionID: sessionID,
            paneID: current.paneID,
            action: current.action,
            scope: current.scope,
            message: message
        )
        unknownOutcomes[current.paneID] = outcome
        // The pane stays guarded: releasing it is what would permit a retry of
        // an effect that may already have happened.
        busyPaneIDs.insert(current.paneID)
        presentation = .reconciliationRequired(
            requestID: requestID,
            paneID: current.paneID,
            action: current.action,
            sessionID: sessionID,
            scope: current.scope,
            relatedFiles: current.relatedFiles,
            message: message
        )
    }

    func containsPane(_ paneID: String, in workspace: WorkspaceSnapshot) -> Bool {
        workspace.projects.contains { project in
            project.projectPanes.contains { $0.id == paneID }
                || project.worktrees.contains { worktree in
                    worktree.panes.contains { $0.id == paneID }
                }
        }
    }
}
