import Combine
import Foundation

public enum RemoteActionStoreError: Error, Sendable, Equatable, LocalizedError {
    case unexpectedResponse

    public var errorDescription: String? {
        "The host returned an unexpected action response. Refresh the workspace and try again."
    }
}

@MainActor
public final class RemoteActionStore: ObservableObject {
    @Published public private(set) var presentation: RemoteActionPresentation?
    @Published public private(set) var busyPaneIDs: Set<String> = []
    @Published public private(set) var isSubmitting = false

    private let controlRequests: (any ControlRequesting)?
    private var operationToken: UUID?

    public init(controlRequests: (any ControlRequesting)? = nil) {
        self.controlRequests = controlRequests
    }

    public func isBusy(_ paneID: String) -> Bool {
        busyPaneIDs.contains(paneID)
    }

    public func start(
        action: PaneAction,
        onPane paneID: String,
        in workspace: WorkspaceSnapshot
    ) async {
        guard operationToken == nil,
              presentation == nil,
              !isSubmitting
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
            fail(
                paneID: current.paneID,
                action: current.action,
                message: error.localizedDescription,
                recoveryText: recoveryText
            )
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

    func containsPane(_ paneID: String, in workspace: WorkspaceSnapshot) -> Bool {
        workspace.projects.contains { project in
            project.projectPanes.contains { $0.id == paneID }
                || project.worktrees.contains { worktree in
                    worktree.panes.contains { $0.id == paneID }
                }
        }
    }
}
