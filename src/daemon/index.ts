import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import { readOrCreateToken, tokenFilePath } from './token.js';
import { listPanes, capturePaneSync } from './panes.js';
import {
  PROTOCOL_VERSION,
  type ClientRequest,
  type ServerResponse,
  type StreamId,
  encodeBinaryFrame,
} from './protocol.js';
import {
  buildDesktopUseQuickInput,
  buildDesktopUseStateFromEvents,
} from '../utils/covenDesktopUse.js';
import { TmuxControl, tmuxSessionNameForRoot, tmuxSessionExists } from './tmuxControl.js';
import {
  bridgeErrorCode,
  bridgeErrorMessage,
  buildScopedProject,
  capturePaneText,
  listProjectCovenSessions,
  listScopedProjects,
  createCovenClient,
  launchProjectCovenSession,
  openProjectCovenSession,
  routeProjectCovenSessionCapability,
  readPaneStatus,
  resolveConfiguredPaneId,
  spawnBridgePane,
  tmuxPaneExists,
} from './bridge.js';
import {
  AgenticCapabilityRouter,
  createCovenNativeCapabilityStrategy,
  type AgenticCapabilityStrategy,
} from '../orchestration/capabilityRouter.js';
import type { CovenClient } from './bridge.js';

export interface DaemonOptions {
  port: number;
  projectRoot: string;
  printToken: boolean;
  serverVersion: string;
  capabilityStrategies: readonly AgenticCapabilityStrategy[];
}

const DEFAULT_PORT = Number(process.env.PSYCHE_DAEMON_PORT ?? 47123);

export async function runDaemon(opts: Partial<DaemonOptions> = {}): Promise<void> {
  const projectRoot = opts.projectRoot ?? findGitRoot() ?? process.cwd();
  const port = opts.port ?? DEFAULT_PORT;
  const serverVersion = opts.serverVersion ?? 'unknown';
  const capabilityRouter = new AgenticCapabilityRouter({
    strategies: [
      createCovenNativeCapabilityStrategy(),
      ...(opts.capabilityStrategies ?? []),
    ],
  });

  const token = await readOrCreateToken();

  if (opts.printToken) {
    process.stdout.write(token + '\n');
    return;
  }

  const sessionName = tmuxSessionNameForRoot(projectRoot);
  const tmux = new TmuxControl(sessionName);
  if (tmuxSessionExists(sessionName)) {
    tmux.start();
  }
  tmux.on('stderr', (msg) => {
    // eslint-disable-next-line no-console
    console.error(`[tmux-control] ${msg.trim()}`);
  });

  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port,
    verifyClient: () => {
      // Auth is enforced after the WebSocket upgrade (hello frame or Bearer header).
      return true;
    },
  });

  // eslint-disable-next-line no-console
  console.log(`psyche daemon listening on 127.0.0.1:${port}`);
  // eslint-disable-next-line no-console
  console.log(`project root:  ${projectRoot}`);
  // eslint-disable-next-line no-console
  console.log(`tmux session:  ${sessionName}${tmux['started'] ? '' : ' (not running — start psyche first)'}`);
  // eslint-disable-next-line no-console
  console.log(`token file:    ${tokenFilePath()}`);

  wss.on('connection', (ws, req) => {
    const authedViaHeader = req.headers['authorization'] === `Bearer ${token}`;
    const conn = new Connection(ws, {
      token,
      projectRoot,
      serverVersion,
      authedViaHeader,
      tmux,
      capabilityRouter,
    });
    conn.bind();
  });

  const shutdown = (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`\npsyche daemon shutting down (${signal})`);
    tmux.stop();
    wss.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

interface ConnectionDeps {
  token: string;
  projectRoot: string;
  serverVersion: string;
  authedViaHeader: boolean;
  tmux: TmuxControl;
  capabilityRouter: AgenticCapabilityRouter;
}

class Connection {
  private authed: boolean;
  private activeStreams = new Map<StreamId, { paneId: string; outputHandler: (paneId: string, data: Buffer) => void }>();

  constructor(
    private ws: WebSocket,
    private deps: ConnectionDeps,
  ) {
    this.authed = deps.authedViaHeader;
  }

  bind(): void {
    if (this.authed) {
      this.send({ type: 'welcome', protocol: PROTOCOL_VERSION, serverVersion: this.deps.serverVersion });
    }

    this.ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // client-sent binary frames not used yet; inputs come via panes.input
        return;
      }
      this.onText(data.toString('utf8'));
    });

    this.ws.on('close', () => {
      for (const [, stream] of this.activeStreams) {
        this.deps.tmux.off('output', stream.outputHandler);
      }
      this.activeStreams.clear();
    });
  }

  private send(msg: ServerResponse): void {
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      // socket likely gone; close handler will clean up
    }
  }

  private sendBinary(streamId: StreamId, payload: Buffer): void {
    try {
      this.ws.send(encodeBinaryFrame(streamId, payload));
    } catch {
      // ignore
    }
  }

  private async onText(raw: string): Promise<void> {
    let msg: ClientRequest;
    try {
      msg = JSON.parse(raw) as ClientRequest;
    } catch {
      this.send({ type: 'error', code: 'bad_json', message: 'invalid JSON frame' });
      return;
    }

    if (!this.authed) {
      if (msg.type === 'hello') {
        if (msg.token === this.deps.token) {
          this.authed = true;
          this.send({ type: 'welcome', protocol: PROTOCOL_VERSION, serverVersion: this.deps.serverVersion });
        } else {
          this.send({ type: 'error', code: 'unauthorized', message: 'bad token' });
          this.ws.close(4401, 'unauthorized');
        }
        return;
      }
      this.send({ type: 'error', code: 'unauthorized', message: 'hello required' });
      this.ws.close(4401, 'unauthorized');
      return;
    }

    await this.dispatch(msg);
  }

  private async dispatch(msg: ClientRequest): Promise<void> {
    switch (msg.type) {
      case 'hello': {
        this.send({ type: 'welcome', protocol: PROTOCOL_VERSION, serverVersion: this.deps.serverVersion });
        return;
      }
      case 'projects.list': {
        try {
          const projects = await listScopedProjects(this.deps.projectRoot);
          this.send({ type: 'projects.list.result', requestId: msg.requestId, projects });
        } catch (e) {
          this.send({ type: 'error', requestId: msg.requestId, code: 'projects_list_failed', message: bridgeErrorMessage(e) });
        }
        return;
      }
      case 'projects.open': {
        try {
          const project = await buildScopedProject(this.deps.projectRoot, msg.cwd, {
            title: msg.title,
            autonomyProfile: msg.autonomyProfile,
          });
          this.send({ type: 'projects.open.result', requestId: msg.requestId, project });
        } catch (e) {
          this.send({ type: 'error', requestId: msg.requestId, code: 'project_scope_violation', message: bridgeErrorMessage(e) });
        }
        return;
      }
      case 'panes.list': {
        const panes = await listPanes(this.deps.projectRoot);
        this.send({ type: 'panes.list.result', requestId: msg.requestId, panes });
        return;
      }
      case 'coven.sessions.list': {
        try {
          const sessions = await listProjectCovenSessions(this.deps.projectRoot, createCovenClient());
          this.send({ type: 'coven.sessions.list.result', requestId: msg.requestId, sessions });
        } catch (e) {
          this.send({ type: 'error', requestId: msg.requestId, code: bridgeErrorCode(e, 'coven_sessions_list_failed'), message: bridgeErrorMessage(e) });
        }
        return;
      }
      case 'coven.sessions.launch': {
        try {
          const session = await launchProjectCovenSession(this.deps.projectRoot, msg.launch, createCovenClient());
          this.send({ type: 'coven.sessions.launch.result', requestId: msg.requestId, session });
        } catch (e) {
          this.send({ type: 'error', requestId: msg.requestId, code: bridgeErrorCode(e, 'coven_session_launch_failed'), message: bridgeErrorMessage(e) });
        }
        return;
      }
      case 'coven.sessions.open': {
        try {
          const result = await openProjectCovenSession(this.deps.projectRoot, this.deps.tmux.sessionName, msg.id);
          this.send({
            type: 'coven.sessions.open.result',
            requestId: msg.requestId,
            id: result.id,
            pane: result.pane,
            session: result.session,
          });
        } catch (e) {
          this.send({ type: 'error', requestId: msg.requestId, code: bridgeErrorCode(e, 'coven_session_open_failed'), message: bridgeErrorMessage(e) });
        }
        return;
      }
      case 'coven.capabilities.execute': {
        try {
          this.send(await dispatchCovenCapabilityRequest(
            this.deps.projectRoot,
            msg,
            this.deps.capabilityRouter,
          ));
        } catch (e) {
          this.send({
            type: 'error',
            requestId: msg.requestId,
            code: bridgeErrorCode(e, 'coven_capability_execution_failed'),
            message: bridgeErrorMessage(e),
          });
        }
        return;
      }
      case 'coven.desktop.state': {
        try {
          const client = createCovenClient();
          const [session, events] = await Promise.all([
            client.getSession?.(msg.sessionId),
            client.listEvents?.(msg.sessionId) ?? Promise.resolve([]),
          ]);
          const state = buildDesktopUseStateFromEvents(msg.sessionId, msg.sessionId, events, session);
          this.send({ type: 'coven.desktop.state.result', requestId: msg.requestId, state });
        } catch (e) {
          this.send({ type: 'error', requestId: msg.requestId, code: bridgeErrorCode(e, 'coven_desktop_state_failed'), message: bridgeErrorMessage(e) });
        }

        return;
      }
      case 'coven.desktop.action': {
        try {
          const client = createCovenClient();
          await client.sendInput?.(msg.sessionId, buildDesktopUseQuickInput(msg.action));
          this.send({ type: 'coven.desktop.action.result', requestId: msg.requestId, sessionId: msg.sessionId, action: msg.action, accepted: true });
        } catch (e) {
          this.send({ type: 'error', requestId: msg.requestId, code: bridgeErrorCode(e, 'coven_desktop_action_failed'), message: bridgeErrorMessage(e) });
        }
        return;
      }
      case 'panes.capture': {
        try {
          const paneId = await resolveConfiguredPaneId(this.deps.projectRoot, msg.id);
          const captured = capturePaneText(paneId, msg.lines, capturePaneSync);
          this.send({ type: 'panes.capture.result', requestId: msg.requestId, ...captured });
        } catch (e) {
          this.send({ type: 'error', requestId: msg.requestId, code: bridgeErrorCode(e, 'capture_failed'), message: bridgeErrorMessage(e) });
        }
        return;
      }
      case 'panes.status': {
        try {
          const status = await readPaneStatus(this.deps.projectRoot, msg.id, tmuxPaneExists);
          this.send({ type: 'panes.status.result', requestId: msg.requestId, status });
        } catch (e) {
          this.send({ type: 'error', requestId: msg.requestId, code: 'status_failed', message: bridgeErrorMessage(e) });
        }
        return;
      }
      case 'panes.attach': {
        const streamId = randomUUID().slice(0, 8);
        const paneId = msg.id;

        this.send({ type: 'panes.attach.result', requestId: msg.requestId, streamId, id: paneId });

        const outputHandler = (pId: string, data: Buffer) => {
          if (pId === paneId) this.sendBinary(streamId, data);
        };
        this.deps.tmux.on('output', outputHandler);
        this.activeStreams.set(streamId, { paneId, outputHandler });

        // seed with current buffer before live stream takes over
        const buf = capturePaneSync(paneId);
        if (buf.length > 0) {
          this.sendBinary(streamId, buf);
        }

        if (msg.cols && msg.rows) {
          try {
            this.deps.tmux.resizePane(paneId, msg.cols, msg.rows);
          } catch {
            // best-effort; resize errors shouldn't kill the attach
          }
        }

        return;
      }
      case 'panes.detach': {
        const stream = this.activeStreams.get(msg.streamId);
        if (stream) {
          this.deps.tmux.off('output', stream.outputHandler);
          this.activeStreams.delete(msg.streamId);
        }
        this.send({ type: 'ack', requestId: msg.requestId, ok: true });
        return;
      }
      case 'panes.focus': {
        const paneId = msg.streamId ? this.activeStreams.get(msg.streamId)?.paneId : msg.id;
        if (!paneId) {
          this.send({
            type: 'error',
            requestId: msg.requestId,
            code: msg.streamId ? 'no_stream' : 'missing_pane',
            message: msg.streamId ? 'unknown streamId' : 'pane id or streamId required',
          });
          return;
        }
        try {
          this.deps.tmux.selectPane(paneId);
          this.send({ type: 'ack', requestId: msg.requestId, ok: true });
        } catch (e) {
          this.send({ type: 'error', requestId: msg.requestId, code: 'focus_failed', message: String(e) });
        }
        return;
      }
      case 'panes.input': {
        const stream = this.activeStreams.get(msg.streamId);
        if (!stream) {
          this.send({ type: 'error', requestId: msg.requestId, code: 'no_stream', message: 'unknown streamId' });
          return;
        }
        // `data` is base64 to preserve arbitrary bytes
        let bytes: Buffer;
        try {
          bytes = Buffer.from(msg.data, 'base64');
        } catch {
          this.send({ type: 'error', requestId: msg.requestId, code: 'bad_base64', message: 'input must be base64' });
          return;
        }
        try {
          this.deps.tmux.sendKeysHex(stream.paneId, bytes);
          this.send({ type: 'ack', requestId: msg.requestId, ok: true });
        } catch (e) {
          this.send({ type: 'error', requestId: msg.requestId, code: 'send_keys_failed', message: String(e) });
        }
        return;
      }
      case 'panes.resize': {
        const stream = this.activeStreams.get(msg.streamId);
        if (!stream) {
          this.send({ type: 'error', requestId: msg.requestId, code: 'no_stream', message: 'unknown streamId' });
          return;
        }
        try {
          this.deps.tmux.resizePane(stream.paneId, msg.cols, msg.rows);
          this.send({ type: 'ack', requestId: msg.requestId, ok: true });
        } catch (e) {
          this.send({ type: 'error', requestId: msg.requestId, code: 'resize_failed', message: String(e) });
        }
        return;
      }
      case 'panes.kill': {
        try {
          this.deps.tmux.killPane(msg.id);
          for (const [sid, s] of this.activeStreams) {
            if (s.paneId !== msg.id) continue;
            this.deps.tmux.off('output', s.outputHandler);
            this.activeStreams.delete(sid);
            this.send({ type: 'panes.stream.exit', streamId: sid, reason: 'killed' });
          }
          this.send({ type: 'ack', requestId: msg.requestId, ok: true });
        } catch (e) {
          this.send({ type: 'error', requestId: msg.requestId, code: 'kill_failed', message: String(e) });
        }
        return;
      }
      case 'panes.meta': {
        try {
          await updatePaneMeta(this.deps.projectRoot, msg.id, { title: msg.title, agent: msg.agent });
          this.send({ type: 'ack', requestId: msg.requestId, ok: true });
        } catch (e) {
          this.send({ type: 'error', requestId: msg.requestId, code: 'meta_failed', message: String(e) });
        }
        return;
      }
      case 'panes.spawn': {
        try {
          const result = await spawnBridgePane(this.deps.projectRoot, this.deps.tmux.sessionName, msg);
          this.send({
            type: 'panes.spawn.result',
            requestId: msg.requestId,
            id: result.id,
            pane: result.pane,
            worktreePath: result.worktreePath,
            branch: result.branch,
          });
        } catch (e) {
          this.send({
            type: 'error',
            requestId: msg.requestId,
            code: bridgeErrorCode(e, 'spawn_failed'),
            message: bridgeErrorMessage(e),
          });
        }
        return;
      }
      default: {
        this.send({
          type: 'error',
          requestId: (msg as { requestId?: string }).requestId,
          code: 'unknown_type',
          message: `unknown message type`,
        });
      }
    }
  }
}

export async function dispatchCovenCapabilityRequest(
  projectRoot: string,
  request: Extract<ClientRequest, { type: 'coven.capabilities.execute' }>,
  router: AgenticCapabilityRouter,
  client: CovenClient = createCovenClient(),
): Promise<Extract<ServerResponse, { type: 'coven.capabilities.execute.result' }>> {
  const execution = await routeProjectCovenSessionCapability(
    projectRoot,
    request.sessionId,
    request.capability,
    router,
    client,
  );
  return {
    type: 'coven.capabilities.execute.result',
    requestId: request.requestId,
    sessionId: request.sessionId,
    execution,
  };
}

export async function updatePaneMeta(
  projectRoot: string,
  paneId: string,
  patch: { title?: string; agent?: string },
): Promise<void> {
  const configPath = path.join(projectRoot, '.psyche', 'psyche.config.json');
  const raw = await readFile(configPath, 'utf8');
  const config = JSON.parse(raw) as { panes?: Array<Record<string, unknown>> };
  const panes = Array.isArray(config.panes) ? config.panes : [];
  const pane = panes.find((p) => p.id === paneId || p.paneId === paneId);
  if (!pane) throw new Error(`pane ${paneId} not found`);
  if (patch.title !== undefined) pane.title = patch.title;
  if (patch.agent !== undefined) pane.agent = patch.agent;
  config.panes = panes;
  await writeFile(configPath, JSON.stringify(config, null, 2));
}

function findGitRoot(): string | null {
  try {
    return execSync('git rev-parse --show-toplevel', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim() || null;
  } catch {
    return null;
  }
}

export function parseDaemonArgs(argv: string[]): Partial<DaemonOptions> {
  const opts: Partial<DaemonOptions> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n)) throw new Error('--port requires a number');
      opts.port = n;
    } else if (a === '--print-token') {
      opts.printToken = true;
    } else if (a === '--project-root' && argv[i + 1]) {
      opts.projectRoot = path.resolve(argv[++i]);
    }
  }
  return opts;
}
