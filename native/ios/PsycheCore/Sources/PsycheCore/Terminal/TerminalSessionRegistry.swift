import Combine
import Foundation

/// Owns every attached terminal, and never more than two of them.
///
/// The cap is the point: a phone cannot afford a live PTY subscription per
/// pane, so showing a third pane detaches one first rather than quietly
/// keeping three streams alive. Everything else here exists to make a
/// reattach cheap — the per-pane sequence cursor outlives a disconnect, so
/// coming back asks the host for the delta instead of the whole scrollback.
@MainActor
public final class TerminalSessionRegistry: ObservableObject {
    /// Two visible panes is the documented ceiling for the workspace.
    public static let maximumAttachedSessions = 2
    public static let defaultOutputLimit = 64 * 1024

    @Published public private(set) var attachedPaneIDs: [String] = []
    @Published public private(set) var focusedPaneID: String?
    @Published public private(set) var outputByPaneID: [String: Data] = [:]
    @Published public private(set) var lastErrorMessage: String?

    private let client: any TerminalControlling
    private let outputLimit: Int

    private var sessions: [String: TerminalSession] = [:]
    private var paneIDByStreamID: [String: String] = [:]
    /// Survives a disconnect on purpose: it is the resume point a reattach
    /// sends as `sinceSequence`.
    private var latestSequenceByPaneID: [String: UInt64] = [:]
    private var frameTask: Task<Void, Never>?

    public init(
        client: any TerminalControlling,
        outputLimit: Int = TerminalSessionRegistry.defaultOutputLimit
    ) {
        self.client = client
        self.outputLimit = outputLimit
    }

    deinit {
        frameTask?.cancel()
    }

    public var attachedSessionCount: Int { sessions.count }

    public func session(forPane paneID: String) -> TerminalSession? {
        sessions[paneID]
    }

    public func resumeSequence(forPane paneID: String) -> UInt64? {
        latestSequenceByPaneID[paneID]
    }

    public func start() {
        frameTask?.cancel()
        frameTask = Task { [weak self] in
            guard let frames = await self?.client.incomingFrames() else { return }
            for await frame in frames {
                guard !Task.isCancelled else { return }
                await self?.receive(frame)
            }
        }
    }

    public func stop() {
        frameTask?.cancel()
        frameTask = nil
    }

    /// Attaches exactly the panes asked for, detaching anything else first.
    public func show(primary: String?, secondary: String? = nil) async {
        var desired: [String] = []
        for paneID in [primary, secondary].compactMap({ $0 }) where !desired.contains(paneID) {
            desired.append(paneID)
        }
        // Truncating rather than trusting the caller keeps the cap a property
        // of the registry, not of whoever called it.
        desired = Array(desired.prefix(Self.maximumAttachedSessions))

        for paneID in sessions.keys where !desired.contains(paneID) {
            await detach(paneID)
        }
        for paneID in desired where sessions[paneID] == nil {
            await attach(paneID)
        }

        attachedPaneIDs = desired.filter { sessions[$0] != nil }
        if let focusedPaneID, !attachedPaneIDs.contains(focusedPaneID) {
            self.focusedPaneID = nil
        }
        if focusedPaneID == nil {
            focusedPaneID = attachedPaneIDs.first
        }
    }

    public func focus(_ paneID: String) {
        guard attachedPaneIDs.contains(paneID) else { return }
        focusedPaneID = paneID
    }

    /// Sends to the pane the caller explicitly captured while it was focused.
    /// Looking up focus inside this async operation would let a later tap
    /// redirect bytes that were meant for the previous pane.
    ///
    /// Reports whether the host took it, so a composer can keep a draft that
    /// never made it out rather than clearing the field on a failed send.
    @discardableResult
    public func send(_ data: Data, toPane paneID: String) async -> Bool {
        guard let session = sessions[paneID] else {
            lastErrorMessage = TerminalControlError.notAttached(paneID).localizedDescription
            return false
        }
        do {
            try await client.send(data, toStream: session.streamID)
            lastErrorMessage = nil
            return true
        } catch {
            lastErrorMessage = error.localizedDescription
            return false
        }
    }

    public func resize(paneID: String, columns: Int, rows: Int) async {
        guard let session = sessions[paneID] else { return }
        do {
            try await client.resize(streamID: session.streamID, columns: columns, rows: rows)
        } catch {
            lastErrorMessage = error.localizedDescription
        }
    }

    /// The connection is gone, so no stream on it is live any more. The output
    /// and the sequence cursors stay: they are what makes the reattach a delta.
    public func markDisconnected() {
        sessions.removeAll()
        paneIDByStreamID.removeAll()
        attachedPaneIDs = []
        focusedPaneID = nil
    }

    public func clearError() {
        lastErrorMessage = nil
    }

    // MARK: - Internals

    private func attach(_ paneID: String) async {
        do {
            let session = try await client.attach(
                paneID: paneID,
                sinceSequence: latestSequenceByPaneID[paneID]
            )
            sessions[paneID] = session
            paneIDByStreamID[session.streamID] = paneID

            if session.replayMode == .replace {
                // The host could not continue from our cursor, so what we hold
                // is not a prefix of what it is about to send. Splicing them
                // would join unrelated output.
                outputByPaneID[paneID] = Data()
                latestSequenceByPaneID[paneID] = 0
            }
            // Deliberately not advancing the cursor to session.latestSequence:
            // the replay frame carrying that sequence has not arrived yet, and
            // seeding the cursor with it would make us drop the replay itself.
        } catch {
            lastErrorMessage = error.localizedDescription
        }
    }

    private func detach(_ paneID: String) async {
        guard let session = sessions.removeValue(forKey: paneID) else { return }
        paneIDByStreamID.removeValue(forKey: session.streamID)
        attachedPaneIDs.removeAll { $0 == paneID }
        if focusedPaneID == paneID { focusedPaneID = nil }
        do {
            try await client.detach(streamID: session.streamID)
        } catch {
            lastErrorMessage = error.localizedDescription
        }
    }

    private func receive(_ frame: TerminalBinaryFrame) {
        guard let paneID = paneIDByStreamID[frame.streamID] else { return }
        // A frame at or behind the cursor is a replay we already applied or a
        // duplicate from a reattach; appending it would double the output.
        guard frame.sequence > (latestSequenceByPaneID[paneID] ?? 0) else { return }

        latestSequenceByPaneID[paneID] = frame.sequence
        var buffer = outputByPaneID[paneID] ?? Data()
        buffer.append(frame.payload)
        if buffer.count > outputLimit {
            buffer.removeFirst(buffer.count - outputLimit)
        }
        outputByPaneID[paneID] = buffer
    }
}
