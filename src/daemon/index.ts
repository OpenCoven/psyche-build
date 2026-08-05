import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { execSync } from 'node:child_process';
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
import { TmuxControl, tmuxSessionNameForRoot, tmuxSessionExists } from '../services/tmuxControl.js';
import { isTmuxPaneId } from '../utils/tmuxTarget.js';
import { decodeBase64Payload } from '../utils/base64.js';
import {
  bridgeErrorCode,
  bridgeErrorMessage,
  buildScopedProject,
  capturePaneText,
  listProjectCovenSessions,
  listScopedProjects,
  createCovenClient,
  mutateBridgeConfig,
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

/** Largest client frame accepted. See the maxPayload note in runDaemon. */
export const MAX_CLIENT_FRAME_BYTES = 1024 * 1024;

/**
 * How long a connection may sit without authenticating.
 *
 * Clients send `hello` immediately (or authenticate on the upgrade with a
 * Bearer header), so anything still silent after this is either broken or
 * squatting a socket. Without the deadline, idle unauthenticated connections
 * accumulate without bound.
 */
export const AUTH_DEADLINE_MS = 10_000;

/**
 * Live attach streams allowed per connection.
 *
 * Each attach registers a listener on the shared TmuxControl emitter, so an
 * unbounded count is both a memory leak and a duplicate-output bug.
 */
export const MAX_STREAMS_PER_CONNECTION = 64;

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
    // `ws` defaults to 100 MB per frame, which an unauthenticated peer can
    // send repeatedly to exhaust the daemon's heap. Control frames are JSON
    // plus base64 keystrokes; 1 MiB is well above any real request.
    maxPayload: MAX_CLIENT_FRAME_BYTES,
    verifyClient: () => {
      // Auth is enforced after the WebSocket upgrade (hello frame or Bearer header).
      return true;
    },
  });

  // Without an 'error' listener the EventEmitter rethrows and the daemon dies.
  wss.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error(`[daemon] listener error: ${err.message}`);
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
    const header = req.headers['authorization'];
    const authedViaHeader = typeof header === 'string'
      && header.startsWith('Bearer ')
      && tokensMatch(token, header.slice('Bearer '.length));
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

export interface ConnectionDeps {
  token: string;
  projectRoot: string;
  serverVersion: string;
  authedViaHeader: boolean;
  tmux: TmuxControl;
  capabilityRouter: AgenticCapabilityRouter;
}

/**
 * One authenticated client of the loopback daemon.
 *
 * Exported so the authorization and crash-resistance rules can be exercised
 * directly against a fake socket, instead of only through a live tmux session.
 */
export class Connection {
  private authed: boolean;
  private activeStreams = new Map<StreamId, { paneId: string }>();
  private authTimer: NodeJS.Timeout | null = null;
  /**
   * One `output` listener per connection, not one per stream.
   *
   * TmuxControl is a shared EventEmitter. Registering a listener per attach
   * meant a client with many panes open blew past Node's default listener
   * cap — the "possible memory leak" warning — and every attach leaked a
   * listener until the socket closed. Fanning out inside a single handler
   * keeps the registration count at one and makes detach cleanup exact.
   */
  private outputHandler: ((paneId: string, data: Buffer) => void) | null = null;

  constructor(
    private ws: WebSocket,
    private deps: ConnectionDeps,
  ) {
    this.authed = deps.authedViaHeader;
  }

  bind(): void {
    if (this.authed) {
      this.send({ type: 'welcome', protocol: PROTOCOL_VERSION, serverVersion: this.deps.serverVersion });
    } else {
      this.authTimer = setTimeout(() => {
        this.send({ type: 'error', code: 'auth_timeout', message: 'hello not received in time' });
        this.ws.close(4408, 'auth timeout');
      }, AUTH_DEADLINE_MS);
      // Node keeps the event loop alive for pending timers; a stalled client
      // must not be able to hold the process open.
      this.authTimer.unref?.();
    }

    this.ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // client-sent binary frames not used yet; inputs come via panes.input
        return;
      }
      // onText is async: an unhandled rejection here terminates the whole
      // daemon on modern Node, which turns any handler bug into a remote
      // denial of service. Answer with an error frame and stay up.
      void this.onText(data.toString('utf8')).catch((error) => {
        this.send({
          type: 'error',
          code: 'internal_error',
          message: bridgeErrorMessage(error),
        });
      });
    });

    // `ws` emits 'error' on an abrupt peer reset. An unhandled 'error' event
    // is rethrown by EventEmitter and kills the daemon.
    this.ws.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error(`[daemon] connection error: ${err.message}`);
    });

    this.ws.on('close', () => {
      if (this.authTimer) {
        clearTimeout(this.authTimer);
        this.authTimer = null;
      }
      this.activeStreams.clear();
      this.releaseOutputHandler();
    });
  }

  /** Attach the shared output listener once the first stream needs it. */
  private ensureOutputHandler(): void {
    if (this.outputHandler) return;
    const handler = (paneId: string, data: Buffer) => {
      for (const [streamId, stream] of this.activeStreams) {
        if (stream.paneId === paneId) this.sendBinary(streamId, data);
      }
    };
    this.outputHandler = handler;
    this.deps.tmux.on('output', handler);
  }

  /** Detach it again once the last stream goes away. */
  private releaseOutputHandler(): void {
    if (!this.outputHandler || this.activeStreams.size > 0) return;
    this.deps.tmux.off('output', this.outputHandler);
    this.outputHandler = null;
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
        if (tokensMatch(this.deps.token, msg.token)) {
          this.authed = true;
          if (this.authTimer) {
            clearTimeout(this.authTimer);
            this.authTimer = null;
          }
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

  /**
   * Resolve a client-supplied pane id to a tmux pane id inside this project.
   *
   * The daemon is scoped to one project root, and every other handler already
   * went through `resolveConfiguredPaneId`. The streaming and lifecycle
   * handlers used to take the raw id straight from the wire, which let a
   * client authenticated for project A stream output from — and type into —
   * any tmux pane on the machine, including the user's unrelated shells.
   *
   * The shape check afterwards is belt-and-braces: config is written by
   * psyche, but it is a plain JSON file on disk, and a pane id is about to
   * become tmux command text.
   */
  private async resolveScopedPaneId(paneId: unknown): Promise<string> {
    if (typeof paneId !== 'string' || !paneId) {
      throw bridgeErrorLike('missing_pane', 'pane id required');
    }
    const resolved = await resolveConfiguredPaneId(this.deps.projectRoot, paneId);
    if (!isTmuxPaneId(resolved)) {
      throw bridgeErrorLike('invalid_pane', 'pane is not addressable as a tmux pane id');
    }
    return resolved;
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
        let paneId: string;
        try {
          paneId = await this.resolveScopedPaneId(msg.id);
        } catch (e) {
          this.send({ type: 'error', requestId: msg.requestId, code: bridgeErrorCode(e, 'attach_failed'), message: bridgeErrorMessage(e) });
          return;
        }

        if (this.activeStreams.size >= MAX_STREAMS_PER_CONNECTION) {
          this.send({
            type: 'error',
            requestId: msg.requestId,
            code: 'too_many_streams',
            message: `at most ${MAX_STREAMS_PER_CONNECTION} attached streams per connection`,
          });
          return;
        }

        const streamId = randomUUID().slice(0, 8);
        this.send({ type: 'panes.attach.result', requestId: msg.requestId, streamId, id: paneId });

        this.activeStreams.set(streamId, { paneId });
        this.ensureOutputHandler();

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
        if (this.activeStreams.delete(msg.streamId)) {
          this.releaseOutputHandler();
        }
        this.send({ type: 'ack', requestId: msg.requestId, ok: true });
        return;
      }
      case 'panes.focus': {
        let paneId: string | undefined;
        if (msg.streamId) {
          // A streamId was already scope-checked at attach time.
          paneId = this.activeStreams.get(msg.streamId)?.paneId;
        } else if (msg.id !== undefined) {
          try {
            paneId = await this.resolveScopedPaneId(msg.id);
          } catch (e) {
            this.send({ type: 'error', requestId: msg.requestId, code: bridgeErrorCode(e, 'focus_failed'), message: bridgeErrorMessage(e) });
            return;
          }
        }
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
        // `data` is base64 to preserve arbitrary bytes. This used to be a
        // try/catch, which never fired: Buffer.from(..., 'base64') skips
        // characters outside the alphabet instead of throwing, so a malformed
        // payload was silently mangled and typed into the user's terminal.
        const bytes = decodeBase64Payload(msg.data);
        if (!bytes) {
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
          const paneId = await this.resolveScopedPaneId(msg.id);
          this.deps.tmux.killPane(paneId);
          for (const [sid, s] of this.activeStreams) {
            if (s.paneId !== paneId) continue;
            this.activeStreams.delete(sid);
            this.send({ type: 'panes.stream.exit', streamId: sid, reason: 'killed' });
          }
          this.releaseOutputHandler();
          this.send({ type: 'ack', requestId: msg.requestId, ok: true });
        } catch (e) {
          this.send({ type: 'error', requestId: msg.requestId, code: bridgeErrorCode(e, 'kill_failed'), message: bridgeErrorMessage(e) });
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

/** Error carrying a protocol `code`, matching what bridge.ts throws. */
function bridgeErrorLike(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

/**
 * Constant-time daemon-token comparison.
 *
 * The token is 256 bits, so a timing oracle is not the practical break — but
 * `===` short-circuits on the first differing byte, and there is no reason to
 * hand out that signal when the fix is one call.
 */
export function tokensMatch(expected: string, supplied: unknown): boolean {
  if (typeof supplied !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(supplied, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Patch a pane's metadata in the project config.
 *
 * Goes through `mutateBridgeConfig` rather than doing its own
 * read-parse-write. That gives it three things it did not have: serialization
 * against concurrent spawns (an inline read-modify-write here dropped panes
 * that a spawn appended between the read and the write), an atomic write
 * (a plain `writeFile` truncates first, so a crash left a torn registry), and
 * a read that refuses to fall back to an empty config when the file exists but
 * cannot be parsed.
 */
export async function updatePaneMeta(
  projectRoot: string,
  paneId: string,
  patch: { title?: string; agent?: string },
): Promise<void> {
  await mutateBridgeConfig(projectRoot, (config) => {
    const panes = Array.isArray(config.panes) ? config.panes : [];
    const pane = panes.find((p) => p.id === paneId || p.paneId === paneId);
    if (!pane) throw new Error(`pane ${paneId} not found`);
    if (patch.title !== undefined) pane.title = patch.title;
    if (patch.agent !== undefined) pane.agent = patch.agent;
    config.panes = panes;
  });
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
