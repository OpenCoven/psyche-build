import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKSPACE_SNAPSHOT_FIXTURE } from "../../protocol-fixtures/fixtures";
import { BridgeDaemon } from "../../src/services/bridge/BridgeDaemon";
import { PaneOutputBuffer } from "../../src/services/bridge/PaneOutputBuffer";
import { PROTOCOL_VERSION } from "../../src/services/bridge/wireProtocol";

/** A pane the fixture workspace actually publishes. */
const PUBLISHED_PANE = "%3";

function createSession(connectionId = "connection-1") {
  return {
    state: "authenticated" as const,
    protocolVersion: PROTOCOL_VERSION,
    clientId: "client-1",
    token: "token-1",
    connectionId,
    controlStreams: new Map<string, { paneId: string; teardown: () => void }>(),
    subscriptionTeardowns: new Map<string, () => void>(),
    subscribedPaneIds: new Set<string>(),
    send: vi.fn(),
    sendBinary: vi.fn(),
  };
}

function createHub() {
  const buffers = new Map<string, PaneOutputBuffer>();
  return {
    input: [] as Array<{ paneId: string; data: string }>,
    resizes: [] as Array<{ paneId: string; cols: number; rows: number }>,
    bufferFor(paneId: string) {
      let buffer = buffers.get(paneId);
      if (!buffer) {
        buffer = new PaneOutputBuffer();
        buffers.set(paneId, buffer);
      }
      return buffer;
    },
    sendInput(paneId: string, data: Buffer) {
      this.input.push({ paneId, data: data.toString("utf8") });
    },
    resizePane(paneId: string, cols: number, rows: number) {
      this.resizes.push({ paneId, cols, rows });
    },
  };
}

function createDaemon() {
  const daemon = new BridgeDaemon({
    serverId: "server-1",
    serverName: "test",
    projectName: "psyche",
    sessionName: "test-session",
    paneProvider: () => [],
    projectProvider: () => [],
    workspaceProvider: () => structuredClone(WORKSPACE_SNAPSHOT_FIXTURE.workspace) as any,
    ritualProvider: () => [],
    launchRitual: async () => {},
  });
  const hub = createHub();
  (daemon as any).hub = hub;
  return { daemon, hub };
}

function install(daemon: BridgeDaemon, sessions: any[]) {
  (daemon as any).listener = { activeSessions: new Set(sessions) };
}

/** Drives one control request the way the socket handler does. */
async function control(daemon: BridgeDaemon, session: any, request: unknown) {
  await (daemon as any).handleControl(session, request);
  const sent = session.send.mock.calls.map((call: any[]) => call[0]);
  return sent[sent.length - 1]?.payload;
}

type CapturedFrame = { streamId: string; sequence: number; text: string };

function framesFor(session: any): CapturedFrame[] {
  return session.sendBinary.mock.calls.map(([streamId, sequence, payload]: any[]) => ({
    streamId,
    sequence,
    text: Buffer.from(payload).toString("utf8"),
  }));
}

async function attach(daemon: BridgeDaemon, session: any, sinceSeq?: number) {
  return control(daemon, session, {
    type: "panes.attach",
    requestId: "attach-1",
    id: PUBLISHED_PANE,
    ...(sinceSeq === undefined ? {} : { sinceSeq }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BridgeDaemon terminal streams", () => {
  it("refuses a pane the workspace does not publish", async () => {
    const { daemon } = createDaemon();
    const session = createSession();
    install(daemon, [session]);

    const response = await control(daemon, session, {
      type: "panes.attach",
      requestId: "attach-1",
      id: "%404",
    });

    expect(response).toMatchObject({ type: "error", code: "unknown_pane" });
    expect(session.controlStreams.size).toBe(0);
  });

  it("refuses a tmux-looking id published only by a Coven session", async () => {
    const { daemon } = createDaemon();
    const session = createSession();
    install(daemon, [session]);
    const workspace = (daemon as any).opts.workspaceProvider();
    workspace.projects[0].worktrees[1].panes[0].id = "%10";
    (daemon as any).opts.workspaceProvider = () => workspace;

    const response = await control(daemon, session, {
      type: "panes.attach",
      requestId: "attach-coven",
      id: "%10",
    });

    expect(response).toMatchObject({ type: "error", code: "unknown_pane" });
    expect(session.controlStreams.size).toBe(0);
  });

  it("refuses a pane id tmux would treat as command text", async () => {
    const { daemon } = createDaemon();
    const session = createSession();
    install(daemon, [session]);

    const response = await control(daemon, session, {
      type: "panes.attach",
      requestId: "attach-1",
      id: "%3; kill-server",
    });

    expect(response).toMatchObject({ type: "error", code: "invalid_pane" });
  });

  it("answers with stream metadata before any output frame", async () => {
    const { daemon, hub } = createDaemon();
    const session = createSession();
    install(daemon, [session]);
    hub.bufferFor(PUBLISHED_PANE).write(Buffer.from("earlier\n", "utf8"));

    const response = await attach(daemon, session);

    expect(response).toMatchObject({
      type: "mobile.panes.attach.result",
      id: PUBLISHED_PANE,
      hasReplay: true,
      replayMode: "replace",
    });
    // The control response is sent before the queued frames are flushed.
    const sendOrder = session.send.mock.invocationCallOrder[0];
    const firstFrameOrder = session.sendBinary.mock.invocationCallOrder[0];
    expect(sendOrder).toBeLessThan(firstFrameOrder);
    expect(framesFor(session)[0].text).toBe("earlier\n");
  });

  it("loses nothing written during the replay handoff and sends no duplicates", async () => {
    const { daemon, hub } = createDaemon();
    const session = createSession();
    install(daemon, [session]);
    const buffer = hub.bufferFor(PUBLISHED_PANE);
    buffer.write(Buffer.from("one\n", "utf8"));

    // A chunk lands between subscribe and the snapshot read.
    const realSnapshot = buffer.snapshot.bind(buffer);
    vi.spyOn(buffer, "snapshot").mockImplementationOnce((sinceSeq?: number) => {
      buffer.write(Buffer.from("two\n", "utf8"));
      return realSnapshot(sinceSeq);
    });

    await attach(daemon, session);
    buffer.write(Buffer.from("three\n", "utf8"));

    const text = framesFor(session).map((frame) => frame.text).join("");
    expect(text).toBe("one\ntwo\nthree\n");
  });

  it("resumes from a sequence with append, and replaces when the resume point is unreachable", async () => {
    const { daemon, hub } = createDaemon();
    const buffer = hub.bufferFor(PUBLISHED_PANE);
    buffer.write(Buffer.from("one\n", "utf8"));
    buffer.write(Buffer.from("two\n", "utf8"));

    const resuming = createSession("connection-resume");
    install(daemon, [resuming]);
    const appended = await attach(daemon, resuming, 1);
    expect(appended).toMatchObject({ replayMode: "append" });
    expect(framesFor(resuming).map((f) => f.text).join("")).toBe("two\n");

    const ahead = createSession("connection-ahead");
    install(daemon, [ahead]);
    const replaced = await attach(daemon, ahead, 99);
    expect(replaced).toMatchObject({ replayMode: "replace" });
  });

  it("multiplexes two panes over one connection with distinct stream ids", async () => {
    const { daemon, hub } = createDaemon();
    const session = createSession();
    install(daemon, [session]);

    const first = await attach(daemon, session);
    const second = await control(daemon, session, {
      type: "panes.attach",
      requestId: "attach-2",
      id: "%9",
    });

    expect(second).toMatchObject({ type: "mobile.panes.attach.result", id: "%9" });
    expect(first.streamId).not.toBe(second.streamId);
    expect(session.controlStreams.size).toBe(2);

    hub.bufferFor(PUBLISHED_PANE).write(Buffer.from("a", "utf8"));
    hub.bufferFor("%9").write(Buffer.from("b", "utf8"));

    const byStream = new Map(framesFor(session).map((f) => [f.streamId, f.text]));
    expect(byStream.get(first.streamId)).toBe("a");
    expect(byStream.get(second.streamId)).toBe("b");
  });

  it("stops forwarding after detach", async () => {
    const { daemon, hub } = createDaemon();
    const session = createSession();
    install(daemon, [session]);
    const attached = await attach(daemon, session);

    const ack = await control(daemon, session, {
      type: "panes.detach",
      requestId: "detach-1",
      streamId: attached.streamId,
    });
    session.sendBinary.mockClear();
    hub.bufferFor(PUBLISHED_PANE).write(Buffer.from("after detach", "utf8"));

    expect(ack).toMatchObject({ type: "ack", ok: true });
    expect(session.controlStreams.size).toBe(0);
    expect(session.sendBinary).not.toHaveBeenCalled();
  });

  it("routes input and resize to the pane behind the stream", async () => {
    const { daemon, hub } = createDaemon();
    const session = createSession();
    install(daemon, [session]);
    const attached = await attach(daemon, session);

    await control(daemon, session, {
      type: "panes.input",
      requestId: "input-1",
      streamId: attached.streamId,
      data: Buffer.from("ls\r", "utf8").toString("base64"),
    });
    await control(daemon, session, {
      type: "panes.resize",
      requestId: "resize-1",
      streamId: attached.streamId,
      cols: 80,
      rows: 24,
    });

    expect(hub.input).toEqual([{ paneId: PUBLISHED_PANE, data: "ls\r" }]);
    expect(hub.resizes).toEqual([{ paneId: PUBLISHED_PANE, cols: 80, rows: 24 }]);
  });

  it("refuses to act on a stream this connection does not own", async () => {
    const { daemon, hub } = createDaemon();
    const owner = createSession("connection-owner");
    const other = createSession("connection-other");
    install(daemon, [owner, other]);
    const attached = await attach(daemon, owner);

    for (const request of [
      { type: "panes.detach", requestId: "d", streamId: attached.streamId },
      {
        type: "panes.input",
        requestId: "i",
        streamId: attached.streamId,
        data: Buffer.from("rm -rf /", "utf8").toString("base64"),
      },
      { type: "panes.resize", requestId: "r", streamId: attached.streamId, cols: 1, rows: 1 },
    ]) {
      const response = await control(daemon, other, request);
      expect(response).toMatchObject({ type: "error", code: "no_stream" });
    }

    // The owner's stream is untouched and nothing reached the pane.
    expect(owner.controlStreams.size).toBe(1);
    expect(hub.input).toEqual([]);
    expect(hub.resizes).toEqual([]);
  });

  it("refuses an unknown stream id", async () => {
    const { daemon } = createDaemon();
    const session = createSession();
    install(daemon, [session]);

    const response = await control(daemon, session, {
      type: "panes.detach",
      requestId: "d",
      streamId: "never-existed",
    });

    expect(response).toMatchObject({ type: "error", code: "no_stream" });
  });

  it("tears down every subscription when the socket closes", async () => {
    const { daemon, hub } = createDaemon();
    const session = createSession();
    install(daemon, [session]);
    await attach(daemon, session);
    await control(daemon, session, {
      type: "panes.attach",
      requestId: "attach-2",
      id: "%9",
    });
    expect(session.controlStreams.size).toBe(2);

    // The real close handler the listener invokes, not a stand-in for it.
    (daemon as any).onSessionClose(session);
    session.sendBinary.mockClear();

    hub.bufferFor(PUBLISHED_PANE).write(Buffer.from("orphan", "utf8"));
    hub.bufferFor("%9").write(Buffer.from("orphan", "utf8"));

    expect(session.controlStreams.size).toBe(0);
    expect(session.sendBinary).not.toHaveBeenCalled();
  });
});

describe("BridgeDaemon terminal stream limits", () => {
  it("refuses to hold unbounded streams for one connection", async () => {
    const { daemon } = createDaemon();
    const session = createSession();
    install(daemon, [session]);

    const accepted: string[] = [];
    let refusal: any;
    for (let i = 0; i < 8; i += 1) {
      const response = await control(daemon, session, {
        type: "panes.attach",
        requestId: `attach-${i}`,
        id: PUBLISHED_PANE,
      });
      if (response?.type === "mobile.panes.attach.result") {
        accepted.push(response.streamId);
      } else {
        refusal = response;
        break;
      }
    }

    expect(refusal).toMatchObject({ type: "error", code: "too_many_streams" });
    expect(accepted.length).toBeLessThanOrEqual(4);
    expect(session.controlStreams.size).toBe(accepted.length);
  });

  it("frees the budget again once a stream is detached", async () => {
    const { daemon } = createDaemon();
    const session = createSession();
    install(daemon, [session]);

    const streamIds: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const response = await control(daemon, session, {
        type: "panes.attach",
        requestId: `attach-${i}`,
        id: PUBLISHED_PANE,
      });
      streamIds.push(response.streamId);
    }

    await control(daemon, session, {
      type: "panes.detach",
      requestId: "detach-1",
      streamId: streamIds[0],
    });
    const response = await control(daemon, session, {
      type: "panes.attach",
      requestId: "attach-again",
      id: PUBLISHED_PANE,
    });

    expect(response).toMatchObject({ type: "mobile.panes.attach.result" });
  });
});
