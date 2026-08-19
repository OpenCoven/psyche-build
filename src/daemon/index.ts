import { WebSocketServer, WebSocket } from 'ws';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { readOrCreateToken, tokenFilePath } from './token.js';
import {
  listPaneSurfaceBindings,
  listPanes,
  capturePaneSync,
  type PaneLivenessProbe,
  type TmuxIdentityProbe,
} from './panes.js';
import {
  PROTOCOL_VERSION,
  type ClientRequest,
  type ServerResponse,
  type StreamId,
  type CovenSessionSummary,
  encodeBinaryFrame,
} from './protocol.js';
import {
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
  getProjectCovenSession,
  listProjectCovenSessions,
  listScopedProjects,
  createCovenClient,
  readPaneStatus,
  resolveConfiguredPaneId,
  tmuxPaneExists,
  type BridgeCovenOpenResult,
} from './bridge.js';
import { canonicalizeProjectRoot } from '../control/projectIdentity.js';
import { createHostControlPlane } from '../control/host.js';
import { ControlServer } from '../control/server.js';
import { createControlCredentialStore } from '../control/credentials.js';
import { controlEndpointForProject } from '../control/endpoint.js';
import { createDaemonControlHandlers } from './controlHandlers.js';
import { PaneObservationStore } from '../control/resources/paneObservation.js';
import { SurfaceRegistry, type PaneSurface } from '../control/surfaces.js';
import type { ControlActorKind, ControlCommand, CommandOutcome } from '../control/types.js';
import {
  AgenticCapabilityRouter,
  createCovenNativeCapabilityStrategy,
  type AgenticCapabilityStrategy,
  type AgenticCapabilityExecution,
} from '../orchestration/capabilityRouter.js';
import { readDaemonWorkspaceSnapshot } from './workspace.js';
import type { WorkspaceSnapshot } from '../workspace/snapshot.js';
import type { BridgeSpawnRequest, BridgeSpawnResult } from './bridge.js';
import { Orchestrator, type LaneBackend } from '../orchestration/orchestrator.js';
import { createDaemonOrchestrator } from './orchestrationBackend.js';
import { PaneOutputFanout } from './paneOutputFanout.js';
import { BrowserProviderBroker } from '../control/browserProviderBroker.js';
import { BrowserSemanticSnapshotRegistry } from '../control/browserSemanticSnapshots.js';
import { AGENT_CONTROL_LIMITS } from '../control/limits.js';
import { daemonOrchestrationControlIdempotencyKey } from '../orchestration/operationIdentity.js';

export interface DaemonOptions {
  port: number;
  projectRoot: string;
  printToken: boolean;
  serverVersion: string;
  capabilityStrategies: readonly AgenticCapabilityStrategy[];
  /** Optional lane backend override for orchestration tasks. */
  laneBackend?: LaneBackend;
  /** Pre-constructed orchestrator override. */
  orchestrator?: Orchestrator;
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
export const MAX_BATCH_LANES = 16;
export const MAX_IDEMPOTENT_SPAWNS = 128;
export const MAX_CONNECTION_BUFFERED_BYTES = 1024 * 1024;

export async function refreshPaneSurfaces(
  projectRoot: string,
  surfaces: SurfaceRegistry,
  observations: PaneObservationStore,
  isPaneLive?: PaneLivenessProbe,
  getTmuxIdentity?: TmuxIdentityProbe,
): Promise<readonly PaneSurface[]> {
  const panes = await listPaneSurfaceBindings(projectRoot, isPaneLive, getTmuxIdentity);
  const seen = new Set(panes.map((pane) => pane.id));
  for (const pane of panes) {
    const previous = surfaces.get(pane.id);
    surfaces.upsertPane({
      id: pane.id,
      tmuxPaneId: pane.tmuxPaneId,
      projectRoot,
      worktreeRoot: pane.worktreeRoot,
      title: pane.title,
      agent: pane.agent,
      writable: true,
      outputSequence: previous?.kind === 'pane' ? previous.outputSequence : 0,
    });
  }
  for (const resource of surfaces.list()) {
    if (resource.kind !== 'pane' || seen.has(resource.id)) continue;
    surfaces.remove(resource.id);
    observations.clear(resource.id);
  }
  return surfaces.list().filter((resource): resource is PaneSurface => resource.kind === 'pane');
}

export class PaneSurfaceRefreshQueue {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly refresh: () => Promise<readonly PaneSurface[]>) {}

  run(): Promise<readonly PaneSurface[]> {
    const result = this.tail.then(this.refresh, this.refresh);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function invalidatePaneSurfaces(
  surfaces: SurfaceRegistry,
  observations: PaneObservationStore,
): void {
  for (const resource of surfaces.list()) {
    if (resource.kind !== 'pane') continue;
    surfaces.remove(resource.id);
    observations.clear(resource.id);
  }
}

export function installDaemonPaneLifecycleHooks(
  sessionName: string,
  pid = process.pid,
  run: typeof execFileSync = execFileSync,
): void {
  const notify = `run-shell "kill -USR2 ${pid} 2>/dev/null || true # psyche-daemon-control"`;
  const installed: string[] = [];
  try {
    for (const hook of DAEMON_PANE_LIFECYCLE_HOOKS) {
      const hookName = `${hook}[${DAEMON_PANE_HOOK_INDEX}]`;
      run('tmux', ['set-hook', '-t', sessionName, hookName, notify], { stdio: 'ignore' });
      installed.push(hookName);
    }
  } catch (error) {
    for (const hookName of installed.reverse()) {
      try {
        run('tmux', ['set-hook', '-u', '-t', sessionName, hookName], { stdio: 'ignore' });
      } catch {
        // Preserve the installation failure; cleanup is best effort.
      }
    }
    throw error;
  }
}

export function uninstallDaemonPaneLifecycleHooks(
  sessionName: string,
  run: typeof execFileSync = execFileSync,
): void {
  for (const hook of DAEMON_PANE_LIFECYCLE_HOOKS) {
    run('tmux', [
      'set-hook', '-u', '-t', sessionName, `${hook}[${DAEMON_PANE_HOOK_INDEX}]`,
    ], { stdio: 'ignore' });
  }
}

const DAEMON_PANE_LIFECYCLE_HOOKS = ['pane-exited', 'after-split-window'] as const;
const DAEMON_PANE_HOOK_INDEX = 987654321;

export async function runDaemon(opts: Partial<DaemonOptions> = {}): Promise<void> {
  const projectRoot = opts.projectRoot ?? findGitRoot() ?? process.cwd();
  const port = daemonPort(opts.port ?? DEFAULT_PORT);
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

  // The runtime is the single authority for pane mutations. Acquire the
  // project owner fence before accepting any connection; a failed acquire must
  // fail startup loudly rather than fall back to unfenced mutation.
  const canonicalProjectRoot = await canonicalizeProjectRoot(projectRoot);
  const orchestrator = opts.orchestrator
    ?? (opts.laneBackend
      ? new Orchestrator({ executeLane: opts.laneBackend })
      : createDaemonOrchestrator({ sessionName }));
  const paneObservations = new PaneObservationStore();
  const surfaces = new SurfaceRegistry();
  await refreshPaneSurfaces(canonicalProjectRoot, surfaces, paneObservations);
  const paneRefresh = new PaneSurfaceRefreshQueue(() => refreshPaneSurfaces(
    canonicalProjectRoot,
    surfaces,
    paneObservations,
  ));
  const handlePaneLifecycleSignal = (): void => {
    invalidatePaneSurfaces(surfaces, paneObservations);
    void paneRefresh.run().catch((error) => {
      // eslint-disable-next-line no-console
      console.error(`[daemon] failed to refresh pane surfaces: ${String(error)}`);
    });
  };
  const paneOutput = new PaneOutputFanout(tmux, (tmuxPaneId: string, data: Buffer) => {
    const pane = surfaces.list().find(
      (resource) => resource.kind === 'pane' && resource.tmuxPaneId === tmuxPaneId,
    );
    if (!pane || pane.kind !== 'pane') return;
    const outputSequence = paneObservations.append(pane.id, data);
    surfaces.upsertPane({ ...pane, outputSequence });
  });
  tmux.on('windowClose', () => {
    handlePaneLifecycleSignal();
  });
  tmux.on('tmuxExit', () => {
    invalidatePaneSurfaces(surfaces, paneObservations);
  });
  let providerRuntime: { submit(command: ControlCommand): Promise<CommandOutcome> } | undefined;
  let providerOwnerEpoch = 0;
  const submitProviderMutation = async (
    kind: 'provider.resource.upsert' | 'provider.resource.remove',
    payload: Extract<ControlCommand, { kind: typeof kind }>['payload'],
  ): Promise<unknown> => {
    if (!providerRuntime) throw Object.assign(new Error('control runtime is unavailable'), {
      code: 'provider_unavailable',
    });
    const id = randomUUID();
    const outcome = await providerRuntime.submit({
      id,
      idempotencyKey: `provider:${id}`,
      kind,
      projectRoot: canonicalProjectRoot,
      actor: { id: 'desktop-provider', kind: 'human' },
      ownerEpoch: providerOwnerEpoch,
      createdAt: new Date().toISOString(),
      payload,
    } as ControlCommand);
    if (outcome.status !== 'succeeded') {
      throw Object.assign(new Error(outcome.message ?? 'provider resource mutation failed'), {
        code: outcome.code ?? 'provider_error',
      });
    }
    return outcome.value;
  };
  const browserSemanticSnapshots = new BrowserSemanticSnapshotRegistry();
  const browserProvider = new BrowserProviderBroker({
    upsertResource: async (_providerId, resource) => {
      browserSemanticSnapshots.invalidateTab(resource.id, resource.generation);
      const value = await submitProviderMutation('provider.resource.upsert', { resource });
      return (value as { resource?: typeof resource } | undefined)?.resource;
    },
    removeResource: async (_providerId, id, generation) => {
      browserSemanticSnapshots.invalidateTab(id);
      await submitProviderMutation('provider.resource.remove', { id, generation });
    },
    removeProviderResources: async (providerId) => {
      const resources = surfaces.list().filter(
        (item) => item.kind === 'browser_tab' && item.providerId === providerId,
      );
      for (const resource of resources) {
        browserSemanticSnapshots.invalidateTab(resource.id);
        await submitProviderMutation('provider.resource.remove', {
          id: resource.id, generation: resource.generation,
        });
      }
    },
  });
  const controlHandlers = createDaemonControlHandlers({
    tmux,
    projectRoot: canonicalProjectRoot,
    sessionName,
    capabilityRouter,
    orchestrator,
    paneObservations,
    surfaces,
    refreshPaneSurfaces: () => paneRefresh.run(),
    browserProvider,
    browserSemanticSnapshots,
  });
  const controlCredentials = await createControlCredentialStore({
    projectRoot: canonicalProjectRoot,
  });
  const host = await createHostControlPlane(canonicalProjectRoot, {
    handlers: controlHandlers,
    surfaces,
    browserSemanticSnapshots,
    readActiveTaskCredential: controlCredentials.currentTaskCredential,
  });
  providerRuntime = host.runtime;
  providerOwnerEpoch = host.epoch;
  let paneHooksInstalled = false;
  process.on('SIGUSR2', handlePaneLifecycleSignal);
  try {
    if (tmuxSessionExists(sessionName)) {
      installDaemonPaneLifecycleHooks(sessionName);
      paneHooksInstalled = true;
    }
  } catch (error) {
    process.off('SIGUSR2', handlePaneLifecycleSignal);
    paneOutput.close();
    await host.close().catch(() => undefined);
    throw error;
  }
  const uninstallPaneHooks = (): void => {
    if (!paneHooksInstalled) return;
    paneHooksInstalled = false;
    try {
      uninstallDaemonPaneLifecycleHooks(sessionName);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[daemon] failed to uninstall pane lifecycle hooks: ${String(error)}`);
    }
  };

  // Mount the canonical control socket alongside the v0 WebSocket. Both share
  // the one host runtime, so every mutation — from either transport — passes
  // through the single journaled, lease-revalidating authority. Everything that
  // can fail after the owner fence is held runs inside the try so the fence is
  // released before rethrowing and the lock never leaks.
  const controlEndpoint = controlEndpointForProject(canonicalProjectRoot);
  let controlServer: ControlServer;
  try {
    controlServer = await ControlServer.start({
      endpoint: controlEndpoint,
      projectRoot: canonicalProjectRoot,
      ownerEpoch: host.epoch,
      runtime: host.runtime,
      credentials: controlCredentials,
      broker: browserProvider,
    });
  } catch (error) {
    process.off('SIGUSR2', handlePaneLifecycleSignal);
    uninstallPaneHooks();
    paneOutput.close();
    await host.close().catch(() => undefined);
    throw error;
  }

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
  // eslint-disable-next-line no-console
  console.log(`control socket: ${controlEndpoint}`);

  wss.on('connection', (ws, req) => {
    const header = req.headers['authorization'];
    const authedViaHeader = typeof header === 'string'
      && header.startsWith('Bearer ')
      && tokensMatch(token, header.slice('Bearer '.length));
    const conn = new Connection(ws, {
      token,
      projectRoot: canonicalProjectRoot,
      serverVersion,
      authedViaHeader,
      tmux,
      paneOutput,
      controlRuntime: host.runtime,
      ownerEpoch: host.epoch,
    });
    conn.bind();
  });

  const shutdown = (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`\npsyche daemon shutting down (${signal})`);
    process.off('SIGUSR2', handlePaneLifecycleSignal);
    uninstallPaneHooks();
    paneOutput.close();
    tmux.stop();
    wss.close();
    // Close the control socket before releasing the owner fence. host.close()
    // frees the fence, so if it ran concurrently a successor daemon could win
    // the fence and try to bind the same endpoint while this control server is
    // still tearing down its listener/socket file. Sequential teardown (reverse
    // of mount order) closes and unlinks the socket first, then frees the fence.
    void controlServer.close()
      .catch(() => undefined)
      .then(() => host.close())
      .catch(() => undefined)
      .finally(() => process.exit(0));
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
  paneOutput: Pick<PaneOutputFanout, 'subscribe'>;
  /**
   * The single authority for pane mutations.
   *
   * `Connection.dispatch` translates v0 protocol messages into canonical
   * control commands and submits them here instead of driving tmux or the
   * bridge spawn directly. The runtime revalidates leases and owner epoch and
   * journals every transaction.
   */
  controlRuntime: { submit(command: ControlCommand): Promise<CommandOutcome> };
  /** Current owner epoch, stamped onto every translated command. */
  ownerEpoch: number;
  workspaceProvider?: () => Promise<WorkspaceSnapshot>;
}

/**
 * One authenticated client of the loopback daemon.
 *
 * Exported so the authorization and crash-resistance rules can be exercised
 * directly against a fake socket, instead of only through a live tmux session.
 */
export class Connection {
  private authed: boolean;
  private workspaceSequence = 0;
  private activeStreams = new Map<StreamId, { paneId: string }>();

  /**
   * Cached human lease per interactive stream. Keeping the takeover result lets
   * repeated keystrokes reuse the same lease revision instead of re-preempting
   * the pane on every character; `nonce` rotates the takeover idempotency key
   * only when we must re-acquire after being preempted.
   */
  private streamLease = new Map<StreamId, { revision: number; nonce: number }>();
  private idempotentSpawns = new Map<string, {
    fingerprint: string;
    result: Promise<BridgeSpawnResult>;
  }>();
  private authTimer: NodeJS.Timeout | null = null;
  /** Subscription to the daemon-level fan-out; never a direct tmux listener. */
  private unsubscribeOutput: (() => void) | null = null;
  private outputBackpressured = false;

  /** Stable identity for every command this connection translates. */
  private readonly actorId = randomUUID();

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
      this.streamLease.clear();
      this.releaseOutputHandler();
    });
  }

  /** Attach the shared output listener once the first stream needs it. */
  private ensureOutputHandler(): void {
    if (this.unsubscribeOutput) return;
    const handler = (paneId: string, data: Buffer) => {
      for (const [streamId, stream] of this.activeStreams) {
        if (stream.paneId === paneId) this.sendBinary(streamId, data);
      }
    };
    this.unsubscribeOutput = this.deps.paneOutput.subscribe(handler);
  }

  /** Detach it again once the last stream goes away. */
  private releaseOutputHandler(): void {
    if (!this.unsubscribeOutput || this.activeStreams.size > 0) return;
    this.unsubscribeOutput();
    this.unsubscribeOutput = null;
  }

  private send(msg: ServerResponse): void {
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      // socket likely gone; close handler will clean up
    }
  }

  private sendBinary(streamId: StreamId, payload: Buffer): void {
    if (this.outputBackpressured) return;
    const frame = encodeBinaryFrame(streamId, payload);
    if (this.ws.bufferedAmount + frame.length > MAX_CONNECTION_BUFFERED_BYTES) {
      this.outputBackpressured = true;
      this.activeStreams.clear();
      this.streamLease.clear();
      this.releaseOutputHandler();
      this.ws.close(4409, 'pane output backpressure');
      return;
    }
    try {
      this.ws.send(frame);
    } catch {
      // ignore
    }
  }

  private async emitWorkspaceChanged(): Promise<void> {
    try {
      const workspace = await (
        this.deps.workspaceProvider?.()
        ?? readDaemonWorkspaceSnapshot(this.deps.projectRoot)
      );
      this.workspaceSequence += 1;
      this.send({
        type: 'workspace.changed',
        revision: workspace.revision,
        sequence: this.workspaceSequence,
        workspace,
      });
    } catch {
      // The mutation already succeeded. A failed refresh must not rewrite its result.
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
  /**
   * Build a canonical control command from a translated v0 request.
   *
   * The connection never trusts client-supplied actor or epoch fields: it
   * stamps its own connection actor, the current owner epoch, and the project
   * root. The runtime revalidates leases and epoch before any effect runs.
   */
  private buildCommand<K extends ControlCommand['kind']>(
    kind: K,
    payload: Extract<ControlCommand, { kind: K }>['payload'],
    opts: { actorKind: ControlActorKind; idempotencyKey: string },
  ): ControlCommand {
    return {
      id: randomUUID(),
      idempotencyKey: opts.idempotencyKey,
      kind,
      projectRoot: this.deps.projectRoot,
      actor: { id: this.actorId, kind: opts.actorKind, clientId: this.actorId },
      ownerEpoch: this.deps.ownerEpoch,
      createdAt: new Date().toISOString(),
      payload,
    } as ControlCommand;
  }

  private submitControl(command: ControlCommand): Promise<CommandOutcome> {
    return this.deps.controlRuntime.submit(command);
  }

  /** Send the v0 error frame for a non-successful control outcome. */
  private sendControlError(
    requestId: string | undefined,
    fallbackCode: string,
    outcome: CommandOutcome,
  ): void {
    // The runtime reports `command_failed` for handler errors that carry no
    // code of their own (e.g. a raw tmux failure). Those map back to the v0
    // per-operation code so clients keep seeing the same wire codes as before.
    const specificCode =
      outcome.status !== 'succeeded' && outcome.code && outcome.code !== 'command_failed'
        ? outcome.code
        : undefined;
    const code = specificCode ?? fallbackCode;
    const message = outcome.status !== 'succeeded' && outcome.message
      ? outcome.message
      : 'control command failed';
    this.send({ type: 'error', requestId, code, message });
  }

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
      case 'workspace.snapshot': {
        try {
          const workspace = await (
            this.deps.workspaceProvider?.()
            ?? readDaemonWorkspaceSnapshot(this.deps.projectRoot)
          );
          this.send({
            type: 'workspace.snapshot.result',
            requestId: msg.requestId,
            workspace,
          });
        } catch (e) {
          this.send({
            type: 'error',
            requestId: msg.requestId,
            code: 'workspace_snapshot_failed',
            message: bridgeErrorMessage(e),
          });
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
        const outcome = await this.submitControl(this.buildCommand(
          'coven.session.launch',
          {
            harness: msg.launch.harness,
            prompt: msg.launch.prompt,
            cwd: msg.launch.cwd,
            title: msg.launch.title,
          },
          { actorKind: 'compatibility', idempotencyKey: `v0:coven.launch:${randomUUID()}` },
        ));
        if (outcome.status !== 'succeeded') {
          this.sendControlError(msg.requestId, 'coven_session_launch_failed', outcome);
          return;
        }
        const session = outcome.value as CovenSessionSummary;
        this.send({ type: 'coven.sessions.launch.result', requestId: msg.requestId, session });
        await this.emitWorkspaceChanged();
        return;
      }
      case 'coven.sessions.open': {
        const outcome = await this.submitControl(this.buildCommand(
          'coven.session.open',
          { sessionId: msg.id },
          { actorKind: 'compatibility', idempotencyKey: `v0:coven.open:${randomUUID()}` },
        ));
        if (outcome.status !== 'succeeded') {
          this.sendControlError(msg.requestId, 'coven_session_open_failed', outcome);
          return;
        }
        const result = outcome.value as BridgeCovenOpenResult;
        this.send({
          type: 'coven.sessions.open.result',
          requestId: msg.requestId,
          id: result.id,
          pane: result.pane,
          session: result.session,
        });
        await this.emitWorkspaceChanged();
        return;
      }
      case 'coven.capabilities.execute': {
        const outcome = await this.submitControl(this.buildCommand(
          'coven.capability.execute',
          {
            sessionId: msg.sessionId,
            capability: msg.capability.capability,
            prompt: msg.capability.prompt,
            provider: msg.capability.provider,
            taskId: msg.capability.taskId,
            traceId: msg.capability.traceId,
            idempotencyKey: msg.capability.idempotencyKey,
            title: msg.capability.title,
            state: msg.capability.state,
            attempt: msg.capability.attempt,
          },
          { actorKind: 'compatibility', idempotencyKey: msg.capability.idempotencyKey && msg.capability.idempotencyKey.length > 0 ? `v0:coven.capability:${msg.capability.idempotencyKey}` : `v0:coven.capability:${randomUUID()}` },
        ));
        if (outcome.status !== 'succeeded') {
          this.sendControlError(msg.requestId, 'coven_capability_execution_failed', outcome);
          return;
        }
        const value = outcome.value as { sessionId: string; execution: AgenticCapabilityExecution };
        this.send({
          type: 'coven.capabilities.execute.result',
          requestId: msg.requestId,
          sessionId: value.sessionId,
          execution: value.execution,
        });
        return;
      }
      case 'coven.desktop.state': {
        try {
          const client = createCovenClient();
          const session = await getProjectCovenSession(this.deps.projectRoot, msg.sessionId, client);
          const events = await (client.listEvents?.(session.id) ?? Promise.resolve([]));
          const state = buildDesktopUseStateFromEvents(session.id, session.id, events, session);
          this.send({ type: 'coven.desktop.state.result', requestId: msg.requestId, state });
        } catch (e) {
          this.send({ type: 'error', requestId: msg.requestId, code: bridgeErrorCode(e, 'coven_desktop_state_failed'), message: bridgeErrorMessage(e) });
        }
        return;
      }
      case 'coven.desktop.action': {
        const outcome = await this.submitControl(this.buildCommand(
          'coven.desktop.action',
          { sessionId: msg.sessionId, action: msg.action },
          { actorKind: 'compatibility', idempotencyKey: `v0:coven.desktop.action:${randomUUID()}` },
        ));
        if (outcome.status !== 'succeeded') {
          this.sendControlError(msg.requestId, 'coven_desktop_action_failed', outcome);
          return;
        }
        this.send({
          type: 'coven.desktop.action.result',
          requestId: msg.requestId,
          sessionId: msg.sessionId,
          action: msg.action,
          accepted: true,
        });
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
          await this.submitControl(this.buildCommand(
            'pane.resize',
            { paneId, cols: msg.cols, rows: msg.rows },
            { actorKind: 'human', idempotencyKey: randomUUID() },
          )).catch(() => {
            // best-effort; resize errors shouldn't kill the attach
          });
        }

        return;
      }
      case 'panes.detach': {
        if (this.activeStreams.delete(msg.streamId)) {
          this.streamLease.delete(msg.streamId);
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
        const outcome = await this.submitControl(this.buildCommand(
          'pane.focus',
          { paneId },
          { actorKind: 'human', idempotencyKey: randomUUID() },
        ));
        if (outcome.status === 'succeeded') {
          this.send({ type: 'ack', requestId: msg.requestId, ok: true });
        } else {
          this.sendControlError(msg.requestId, 'focus_failed', outcome);
        }
        return;
      }
      case 'panes.input': {
        const stream = this.activeStreams.get(msg.streamId);
        if (!stream) {
          this.send({ type: 'error', requestId: msg.requestId, code: 'no_stream', message: 'unknown streamId' });
          return;
        }
        const bytes = decodeBase64Payload(msg.data);
        if (!bytes) {
          this.send({ type: 'error', requestId: msg.requestId, code: 'bad_base64', message: 'input must be base64' });
          return;
        }
        // Interactive v0 input is a human takeover followed by human input.
        // We cache the lease per stream so repeated keystrokes reuse the same
        // revision instead of re-preempting the pane on every character. If a
        // keystroke fails because the pane was preempted (stale revision), we
        // re-acquire once with a fresh takeover and retry, preserving v0's
        // "last writer can always type" behavior.
        const acquire = async (fresh: boolean): Promise<CommandOutcome | null> => {
          if (!fresh && this.streamLease.has(msg.streamId)) return null;
          const prior = this.streamLease.get(msg.streamId);
          const nonce = fresh ? (prior?.nonce ?? 0) + 1 : (prior?.nonce ?? 1);
          const takeover = await this.submitControl(this.buildCommand(
            'pane.takeover',
            { paneId: stream.paneId },
            { actorKind: 'human', idempotencyKey: `v0:takeover:${this.actorId}:${msg.streamId}:${nonce}` },
          ));
          if (takeover.status === 'succeeded') {
            this.streamLease.set(msg.streamId, { revision: readLeaseRevision(takeover), nonce });
          }
          return takeover;
        };
        const sendInput = () => this.submitControl(this.buildCommand(
          'pane.input',
          {
            paneId: stream.paneId,
            dataBase64: msg.data,
            leaseRevision: this.streamLease.get(msg.streamId)?.revision ?? 0,
          },
          { actorKind: 'human', idempotencyKey: randomUUID() },
        ));

        const initialTakeover = await acquire(false);
        if (initialTakeover && initialTakeover.status !== 'succeeded') {
          this.sendControlError(msg.requestId, 'send_keys_failed', initialTakeover);
          return;
        }
        let input = await sendInput();
        if (input.status !== 'succeeded' && isStaleLeaseOutcome(input)) {
          const retakeover = await acquire(true);
          if (retakeover && retakeover.status !== 'succeeded') {
            this.sendControlError(msg.requestId, 'send_keys_failed', retakeover);
            return;
          }
          input = await sendInput();
        }
        if (input.status === 'succeeded') {
          this.send({ type: 'ack', requestId: msg.requestId, ok: true });
        } else {
          this.sendControlError(msg.requestId, 'send_keys_failed', input);
        }
        return;
      }
      case 'panes.resize': {
        const stream = this.activeStreams.get(msg.streamId);
        if (!stream) {
          this.send({ type: 'error', requestId: msg.requestId, code: 'no_stream', message: 'unknown streamId' });
          return;
        }
        const outcome = await this.submitControl(this.buildCommand(
          'pane.resize',
          { paneId: stream.paneId, cols: msg.cols, rows: msg.rows },
          { actorKind: 'human', idempotencyKey: randomUUID() },
        ));
        if (outcome.status === 'succeeded') {
          this.send({ type: 'ack', requestId: msg.requestId, ok: true });
        } else {
          this.sendControlError(msg.requestId, 'resize_failed', outcome);
        }
        return;
      }
      case 'panes.kill': {
        try {
          const paneId = await this.resolveScopedPaneId(msg.id);
          const outcome = await this.submitControl(this.buildCommand(
            'pane.kill',
            { paneId },
            { actorKind: 'human', idempotencyKey: randomUUID() },
          ));
          if (outcome.status !== 'succeeded') {
            this.sendControlError(msg.requestId, 'kill_failed', outcome);
            return;
          }
          for (const [sid, s] of this.activeStreams) {
            if (s.paneId !== paneId) continue;
            this.activeStreams.delete(sid);
            this.streamLease.delete(sid);
            this.send({ type: 'panes.stream.exit', streamId: sid, reason: 'killed' });
          }
          this.releaseOutputHandler();
          this.send({ type: 'ack', requestId: msg.requestId, ok: true });
          await this.emitWorkspaceChanged();
        } catch (e) {
          this.send({ type: 'error', requestId: msg.requestId, code: bridgeErrorCode(e, 'kill_failed'), message: bridgeErrorMessage(e) });
        }
        return;
      }
      case 'panes.meta': {
        try {
          const outcome = await this.submitControl(this.buildCommand(
            'pane.meta.update',
            { paneId: msg.id, title: msg.title, agent: msg.agent },
            { actorKind: 'human', idempotencyKey: randomUUID() },
          ));
          if (outcome.status === 'succeeded') {
            this.send({ type: 'ack', requestId: msg.requestId, ok: true });
            await this.emitWorkspaceChanged();
          } else {
            this.sendControlError(msg.requestId, 'meta_failed', outcome);
          }
        } catch (e) {
          // submit() itself can reject on runtime infrastructure failure (e.g. a
          // journal append error) before producing an outcome. Preserve the v0
          // wire behavior: a correlated meta_failed frame rather than letting
          // dispatch throw into the connection-level internal_error backstop.
          this.send({ type: 'error', requestId: msg.requestId, code: 'meta_failed', message: bridgeErrorMessage(e) });
        }
        return;
      }
      case 'panes.spawn': {
        try {
          const { result, replayed } = await this.spawnPane(msg, msg.idempotencyKey);
          this.send({
            type: 'panes.spawn.result',
            requestId: msg.requestId,
            id: result.id,
            pane: result.pane,
            worktreePath: result.worktreePath,
            branch: result.branch,
          });
          if (!replayed) await this.emitWorkspaceChanged();
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
      case 'panes.spawnMany': {
        if (!Array.isArray(msg.launches) || msg.launches.length < 1 ||
            msg.launches.length > MAX_BATCH_LANES) {
          this.send({
            type: 'error', requestId: msg.requestId, code: 'invalid_batch',
            message: `launches must contain 1-${MAX_BATCH_LANES} lanes`,
          });
          return;
        }
        if (!validIdempotencyKey(msg.idempotencyKey)) {
          this.send({
            type: 'error', requestId: msg.requestId, code: 'invalid_idempotency_key',
            message: 'idempotencyKey must be 1-128 safe characters',
          });
          return;
        }

        const outcomes = [];
        let changed = false;
        for (let index = 0; index < msg.launches.length; index += 1) {
          const launch = msg.launches[index];
          try {
            const spawned = await this.spawnPane(
              { ...launch, requestId: msg.requestId },
              batchLaneIdempotencyKey(msg.idempotencyKey, index),
            );
            outcomes.push({ index, ok: true as const, ...spawned.result });
            if (!spawned.replayed) changed = true;
          } catch (error) {
            outcomes.push({
              index,
              ok: false as const,
              code: bridgeErrorCode(error, 'spawn_failed'),
              message: bridgeErrorMessage(error),
            });
          }
        }
        this.send({ type: 'panes.spawnMany.result', requestId: msg.requestId, outcomes });
        if (changed) await this.emitWorkspaceChanged();
        return;
      }
      case 'orchestration.execute': {
        try {
          const executionIdempotencyKey = daemonOrchestrationControlIdempotencyKey({
            operationId: msg.operationId,
            connectionId: this.actorId,
            requestId: msg.requestId,
          });
          const requestLease = await this.submitControl(this.buildCommand(
            'lease.request',
            {
              taskId: msg.task.taskId,
              ttlMs: AGENT_CONTROL_LIMITS.leaseTtlMs,
              grants: [{
                target: { kind: 'project', id: this.deps.projectRoot },
                capabilities: ['pane.create'],
              }],
            },
            {
              actorKind: 'human',
              idempotencyKey: `v0:orchestration:${this.actorId}:${msg.requestId}:lease-request`,
            },
          ));
          if (requestLease.status !== 'succeeded') {
            this.sendControlError(msg.requestId, 'orchestration_failed', requestLease);
            return;
          }
          const leaseRequestId = (requestLease.value as { requestId?: string } | undefined)?.requestId;
          if (!leaseRequestId) {
            this.send({
              type: 'error',
              requestId: msg.requestId,
              code: 'orchestration_failed',
              message: 'control runtime returned no lease request ID',
            });
            return;
          }
          const grantLease = await this.submitControl(this.buildCommand(
            'lease.grant',
            { requestId: leaseRequestId },
            {
              actorKind: 'human',
              idempotencyKey: `v0:orchestration:${this.actorId}:${msg.requestId}:lease-grant`,
            },
          ));
          if (grantLease.status !== 'succeeded') {
            this.sendControlError(msg.requestId, 'orchestration_failed', grantLease);
            return;
          }
          const lease = (grantLease.value as {
            lease?: { id?: string; revision?: number };
          } | undefined)?.lease;
          if (!lease?.id || !lease.revision) {
            this.send({
              type: 'error',
              requestId: msg.requestId,
              code: 'orchestration_failed',
              message: 'control runtime returned no orchestration lease',
            });
            return;
          }
          const outcome = await this.submitControl(this.buildCommand(
            'orchestration.execute',
            {
              taskId: msg.task.taskId,
              leaseId: lease.id,
              leaseRevision: lease.revision,
              request: msg.task,
            },
            {
              actorKind: 'human',
              idempotencyKey: executionIdempotencyKey,
            },
          ));
          if (outcome.status !== 'succeeded') {
            this.sendControlError(msg.requestId, 'orchestration_failed', outcome);
            return;
          }
          this.send({
            type: 'orchestration.execute.result',
            requestId: msg.requestId,
            result: outcome.value as import('../orchestration/types.js').OrchestrationTaskResult,
          });
          await this.emitWorkspaceChanged();
        } catch (e) {
          this.send({
            type: 'error',
            requestId: msg.requestId,
            code: bridgeErrorCode(e, 'orchestration_failed'),
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

  private submitSpawn(request: BridgeSpawnRequest): Promise<BridgeSpawnResult> {
    return this.submitControl(this.buildCommand(
      'pane.spawn',
      {
        cwd: request.cwd,
        agent: request.agent,
        title: request.title,
        prompt: request.prompt,
        branch: request.branch,
        startPointBranch: request.startPointBranch,
        existingWorktree: request.existingWorktree,
        requestId: request.requestId,
      },
      { actorKind: 'compatibility', idempotencyKey: `v0:spawn:${randomUUID()}` },
    )).then((outcome) => {
      if (outcome.status === 'succeeded') return outcome.value as BridgeSpawnResult;
      throw Object.assign(new Error(outcome.message), { code: outcome.code });
    });
  }

  private spawnPane(
    request: BridgeSpawnRequest,
    idempotencyKey?: string,
  ): Promise<{ result: BridgeSpawnResult; replayed: boolean }> {
    if (idempotencyKey === undefined) {
      return this.submitSpawn(request)
        .then((result) => ({ result, replayed: false }));
    }
    if (!validIdempotencyKey(idempotencyKey)) {
      return Promise.reject(Object.assign(
        new Error('idempotencyKey must be 1-128 safe characters'),
        { code: 'invalid_idempotency_key' },
      ));
    }

    const fingerprint = JSON.stringify({
      cwd: request.cwd,
      branch: request.branch,
      startPointBranch: request.startPointBranch,
      agent: request.agent,
      title: request.title,
      prompt: request.prompt,
      existingWorktree: request.existingWorktree,
    });
    const existing = this.idempotentSpawns.get(idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(Object.assign(
          new Error('idempotencyKey was already used for a different lane'),
          { code: 'idempotency_conflict' },
        ));
      }
      return existing.result.then((result) => ({ result, replayed: true }));
    }

    const result = this.submitSpawn(request);
    this.idempotentSpawns.set(idempotencyKey, { fingerprint, result });
    if (this.idempotentSpawns.size > MAX_IDEMPOTENT_SPAWNS) {
      const oldest = this.idempotentSpawns.keys().next().value;
      if (oldest !== undefined) this.idempotentSpawns.delete(oldest);
    }
    return result.then((value) => ({ result: value, replayed: false }));
  }
}

function validIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

/** Read the lease revision a successful takeover reports. */
function readLeaseRevision(outcome: CommandOutcome): number {
  if (outcome.status !== 'succeeded') return 0;
  const value = outcome.value as { revision?: number; leaseRevision?: number } | undefined;
  return value?.revision ?? value?.leaseRevision ?? 0;
}

/** True when an input failed because our cached human lease is stale. */
function isStaleLeaseOutcome(outcome: CommandOutcome): boolean {
  if (outcome.status === 'succeeded') return false;
  return (
    outcome.code === 'lease_revision_mismatch' ||
    outcome.code === 'lane_conflict' ||
    outcome.code === 'lease_expired'
  );
}

function batchLaneIdempotencyKey(batchKey: string, index: number): string {
  const digest = createHash('sha256').update(batchKey).digest('hex').slice(0, 32);
  return `batch:${digest}:${index}`;
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
 * Re-exported from `./bridge.js`, where it lives so the control handler can
 * reach it without importing this daemon entrypoint. Kept here for existing
 * importers (tests).
 */
export { updatePaneMeta } from './bridge.js';

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
      opts.port = daemonPort(n);
    } else if (a === '--print-token') {
      opts.printToken = true;
    } else if (a === '--project-root' && argv[i + 1]) {
      opts.projectRoot = path.resolve(argv[++i]);
    }
  }
  return opts;
}

function daemonPort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new Error('--port requires an integer from 0 through 65535');
  }
  return value;
}
