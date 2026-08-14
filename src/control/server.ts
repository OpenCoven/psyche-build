import { createServer, type Server, type Socket } from 'node:net';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { canonicalizeProjectRoot } from './projectIdentity.js';
import { controlEndpointParent } from './endpoint.js';
import {
  type ControlCredentialStore,
  type ControlPrincipal,
} from './credentials.js';
import {
  decodeControlRequest,
  encodeControlMessage,
  type ControlResponse,
} from './protocol.js';
import type {
  BrowserProviderBroker,
  BrowserProviderRegistration,
  ProviderPush,
} from './browserProviderBroker.js';
import type {
  ControlActor,
  ControlActorKind,
  ControlCommand,
  ControlCommandInput,
  CommandOutcome,
  ActionReceipt,
  ControlSnapshot,
  ControlSnapshotScope,
} from './types.js';

/** The minimal runtime surface the control server drives. */
export interface ControlServerRuntime {
  submit(command: ControlCommand): Promise<CommandOutcome>;
  snapshot(): ControlSnapshot;
  readEvents(afterSequence: number, limit?: number): {
    events: unknown[];
    nextSequence: number;
    gap: boolean;
  };
}

export interface ControlServerOptions {
  endpoint: string;
  projectRoot: string;
  ownerEpoch: number;
  runtime: ControlServerRuntime;
  credentials: ControlCredentialStore;
  broker?: BrowserProviderBroker;
  /** Gates bearer operator commands and provider registration; never enable outside isolated tests. */
  operatorCommandPolicy?: 'disabled' | 'trusted-test-only';
}

/** Cap a single newline-delimited frame so a peer cannot exhaust host memory. */
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_QUEUED_FRAMES = 128;
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;

/** Every command kind the runtime knows how to execute. */
const KNOWN_COMMAND_KINDS: ReadonlySet<ControlCommand['kind']> = new Set([
  'orchestration.execute',
  'lease.request',
  'lease.grant',
  'lease.release',
  'lease.revoke',
  'pane.observe',
  'pane.action',
  'browser.inspect',
  'browser.action',
  'browser.script',
  'approval.resolve',
  'provider.resource.upsert',
  'provider.resource.remove',
  'pane.spawn',
  'pane.prompt',
  'pane.interrupt',
  'pane.delegate',
  'pane.takeover',
  'pane.input',
  'pane.terminal.open',
  'pane.resize',
  'pane.focus',
  'pane.kill',
  'pane.respawn',
  'pane.conflict.open',
  'pane.option.update',
  'pane.meta.update',
  'ritual.launch',
  'coven.session.launch',
  'coven.session.open',
  'coven.desktop.action',
  'coven.capability.execute',
]);

function actorKindForPrincipal(kind: ControlPrincipal['kind']): ControlActorKind {
  switch (kind) {
    case 'operator':
      return 'human';
    case 'agent':
      return 'psyche';
    case 'compatibility':
      return 'compatibility';
  }
}

function actorForPrincipal(principal: ControlPrincipal, clientId?: string): ControlActor {
  return {
    id: principal.id,
    kind: actorKindForPrincipal(principal.kind),
    ...(clientId ? { clientId } : {}),
  };
}

/**
 * Decide whether a principal may submit a command of the given kind.
 *
 * Returns a rejection outcome when the principal is not authorized, or
 * `null` when the command may proceed. `pane.takeover` and `pane.delegate`
 * are operator-only; a self-delegating agent must never escalate.
 */
export function authorizeCommand(
  principal: ControlPrincipal,
  kind: ControlCommand['kind'],
): CommandOutcome | null {
  const agentAllowedKinds: ReadonlySet<ControlCommand['kind']> = new Set([
    'orchestration.execute', 'lease.request', 'lease.release', 'pane.observe', 'pane.action',
    'browser.inspect', 'browser.action', 'browser.script',
  ]);
  const agentControlKinds: ReadonlySet<ControlCommand['kind']> = new Set([
    'lease.request', 'lease.grant', 'lease.release', 'lease.revoke', 'pane.observe',
    'pane.action', 'browser.inspect', 'browser.action', 'browser.script',
    'approval.resolve', 'provider.resource.upsert', 'provider.resource.remove',
  ]);
  if (principal.kind === 'compatibility' && agentControlKinds.has(kind)) {
    return {
      status: 'rejected', code: 'compatibility_not_authorized',
      message: 'compatibility principals cannot use agent surface controls',
    };
  }
  if (
    (kind === 'lease.grant' || kind === 'lease.revoke' || kind === 'approval.resolve'
      || kind === 'provider.resource.upsert' || kind === 'provider.resource.remove')
    && principal.kind !== 'operator'
  ) {
    return {
      status: 'rejected', code: 'operator_required',
      message: 'only an operator principal may administer surface authority',
    };
  }
  if (kind === 'pane.delegate') {
    if (principal.kind !== 'operator' || !principal.capabilities.includes('delegate')) {
      return {
        status: 'rejected',
        code: 'delegation_not_authorized',
        message: 'only an operator principal may delegate a lane',
      };
    }
  }
  if (kind === 'pane.takeover' && principal.kind !== 'operator') {
    return {
      status: 'rejected',
      code: 'takeover_not_authorized',
      message: 'only an operator principal may take over a lane',
    };
  }
  if (principal.kind === 'agent' && !agentAllowedKinds.has(kind)) {
    return {
      status: 'rejected', code: 'agent_not_authorized',
      message: 'agent principals may only use leased surface controls',
    };
  }
  return null;
}

/**
 * The authority core shared by the socket transport and tests.
 *
 * It ignores any caller-supplied actor or owner epoch, stamps the
 * authenticated principal's identity and the owner's epoch, and only then
 * submits to the runtime.
 */
export class ControlAuthority {
  constructor(
    private readonly runtime: ControlServerRuntime,
    private readonly ownerEpoch: number,
    private readonly canonicalProjectRoot: string,
  ) {}

  async submitAs(
    principal: ControlPrincipal,
    input: ControlCommandInput,
    clientId?: string,
  ): Promise<CommandOutcome> {
    const rejection = authorizeCommand(principal, input.kind);
    if (rejection) return rejection;

    const command = {
      ...input,
      projectRoot: this.canonicalProjectRoot,
      actor: actorForPrincipal(principal, clientId),
      ownerEpoch: this.ownerEpoch,
    } as ControlCommand;
    return this.runtime.submit(command);
  }

  snapshot(
    principal: ControlPrincipal,
    scope: ControlSnapshotScope = {},
  ): ControlSnapshot {
    const snapshot = this.runtime.snapshot();
    if (principal.kind === 'operator') return snapshot;
    if (scope.taskId) return taskScopedSnapshot(snapshot, scope.taskId);

    // Surface metadata, command history, and authority records are
    // operator-only. In particular, capability leases are bearer-like:
    // exposing their IDs, revisions, task IDs, grants, or the command
    // payloads that carry them would let another holder of the shared agent
    // credential replay a lease that was issued for a different task.
    return {
      ...snapshot,
      commands: {},
      leases: {},
      resources: [],
      capabilityLeases: [],
      leaseRequests: [],
      approvals: [],
      receipts: [],
    };
  }

  readEvents(
    principal: ControlPrincipal,
    afterSequence: number,
    limit?: number,
    scope: ControlSnapshotScope = {},
  ): {
    events: unknown[];
    nextSequence: number;
    gap: boolean;
  } {
    if (principal.kind === 'operator') return this.runtime.readEvents(afterSequence, limit);

    if (!scope.taskId) {
      const page = this.runtime.readEvents(afterSequence, limit);
      return { events: [], nextSequence: page.nextSequence, gap: page.gap };
    }

    const page = this.runtime.readEvents(afterSequence);
    const events: unknown[] = [];
    let nextSequence = page.nextSequence;
    for (const event of page.events) {
      const scoped = taskScopedEvent(event, scope.taskId);
      if (!scoped) continue;
      events.push(scoped);
      if (typeof limit === 'number' && events.length >= limit) {
        nextSequence = typeof (event as { sequence?: unknown }).sequence === 'number'
          ? (event as { sequence: number }).sequence
          : nextSequence;
        break;
      }
    }
    return { events, nextSequence, gap: page.gap };
  }

  welcomeFor(principal: ControlPrincipal): Extract<ControlResponse, { type: 'welcome' }> {
    return {
      version: 1,
      type: 'welcome',
      requestId: 'welcome',
      projectRoot: this.canonicalProjectRoot,
      ownerEpoch: this.ownerEpoch,
      principal: {
        id: principal.id,
        kind: principal.kind,
        capabilities: principal.capabilities,
      },
    };
  }
}

/**
 * Task-scoped agent reads only trust durable task ownership already stamped by
 * the owner: capability leases and pending lease requests carry `taskId`
 * directly, active approvals still reference the exact visible lease
 * id/revision, and receipts must carry a full task/lease ownership tuple.
 * Legacy unowned receipts remain operator-only because ownership cannot be
 * proven for a scoped read.
 */
function taskScopedSnapshot(
  snapshot: ControlSnapshot,
  taskId: string,
): ControlSnapshot {
  const capabilityLeases = snapshot.capabilityLeases.filter((lease) => lease.taskId === taskId);
  const leaseRequests = snapshot.leaseRequests.filter((request) => request.taskId === taskId);
  const activeLeasesById = new Map(capabilityLeases.map((lease) => [lease.id, lease] as const));
  const approvals = snapshot.approvals.filter((approval) => {
    const lease = activeLeasesById.get(approval.leaseId);
    return lease !== undefined
      && lease.revision === approval.leaseRevision
      && (approval.status === 'pending' || approval.status === 'approved');
  });
  const receipts = snapshot.receipts
    .filter((receipt) => hasTaskScopedOwnership(receipt, taskId))
    .map(publicTaskScopedReceipt);
  return {
    ...snapshot,
    commands: {},
    leases: {},
    resources: collectScopedResources(snapshot.resources, capabilityLeases, leaseRequests),
    capabilityLeases,
    leaseRequests,
    approvals,
    receipts,
  };
}

function collectScopedResources(
  resources: ControlSnapshot['resources'],
  capabilityLeases: ControlSnapshot['capabilityLeases'],
  leaseRequests: ControlSnapshot['leaseRequests'],
): readonly ControlSnapshot['resources'][number][] {
  const resourcesByKey = new Map(resources.map((resource) => [resourceKey(resource), resource] as const));
  const visibleKeys = new Set<string>();
  for (const lease of capabilityLeases) {
    for (const grant of lease.grants) addVisibleTarget(visibleKeys, resourcesByKey, grant.target);
  }
  for (const request of leaseRequests) {
    for (const grant of request.grants) addVisibleTarget(visibleKeys, resourcesByKey, grant.target);
  }
  return resources.filter((resource) => visibleKeys.has(resourceKey(resource)));
}

function addVisibleTarget(
  visibleKeys: Set<string>,
  resourcesByKey: ReadonlyMap<string, ControlSnapshot['resources'][number]>,
  target: { kind: string; id: string; generation?: number },
): void {
  const key = targetKey(target);
  if (!key || !resourcesByKey.has(key)) return;
  visibleKeys.add(key);
}

function targetKey(target: { kind: string; id: string; generation?: number }): string | undefined {
  if (target.kind === 'project' || typeof target.generation !== 'number') return undefined;
  return `${target.kind}\0${target.id}\0${target.generation}`;
}

function resourceKey(resource: ControlSnapshot['resources'][number]): string {
  return `${resource.kind}\0${resource.id}\0${resource.generation}`;
}

function hasTaskScopedOwnership(receipt: ActionReceipt, taskId: string): boolean {
  return receipt.taskId === taskId
    && typeof receipt.leaseId === 'string'
    && receipt.leaseId.length > 0
    && Number.isSafeInteger(receipt.leaseRevision)
    && (receipt.leaseRevision as number) >= 1;
}

function publicTaskScopedReceipt(receipt: ActionReceipt): ActionReceipt {
  const {
    taskId: _taskId,
    leaseId: _leaseId,
    leaseRevision: _leaseRevision,
    value: _value,
    message: _message,
    ...safeReceipt
  } = receipt;
  return Object.freeze(safeReceipt);
}

function taskScopedEvent(event: unknown, taskId: string): unknown | undefined {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return undefined;
  const payload = (event as { payload?: unknown }).payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const receipt = taskScopedEventReceipt((payload as { receipt?: unknown }).receipt, taskId);
  if (!receipt) return undefined;
  return {
    ...(event as Record<string, unknown>),
    payload: {
      ...(payload as Record<string, unknown>),
      receipt,
    },
  };
}

function taskScopedEventReceipt(receipt: unknown, taskId: string): ActionReceipt | undefined {
  if (
    !receipt
    || typeof receipt !== 'object'
    || Array.isArray(receipt)
    || (receipt as { schema?: unknown }).schema !== 'psyche.control.receipt/v1'
    || typeof (receipt as { actionId?: unknown }).actionId !== 'string'
  ) return undefined;
  return hasTaskScopedOwnership(receipt as ActionReceipt, taskId)
    ? publicTaskScopedReceipt(receipt as ActionReceipt)
    : undefined;
}

/** Build an in-process authority for authorization unit tests. */
export function createControlServerForTest(options: {
  runtime: ControlServerRuntime;
  ownerEpoch?: number;
  projectRoot?: string;
}): ControlAuthority {
  return new ControlAuthority(
    options.runtime,
    options.ownerEpoch ?? 1,
    options.projectRoot ?? '/canonical/project',
  );
}

/**
 * The only transport that decodes the versioned control protocol.
 *
 * Binds one project-derived socket, authenticates each connection through the
 * scoped credential store, and stamps identity server-side before handing
 * commands to the authority. Legacy automation that authenticates with no
 * matching credential is refused; the daemon adapter mints its own
 * compatibility principal in-process instead of over this socket.
 */
export class ControlServer {
  private readonly sockets = new Set<Socket>();

  private constructor(
    private readonly server: Server,
    private readonly endpoint: string,
    private readonly authority: ControlAuthority,
    private readonly credentials: ControlCredentialStore,
    private readonly canonicalRoot: string,
    private readonly operatorCommandPolicy: NonNullable<ControlServerOptions['operatorCommandPolicy']>,
    private readonly broker?: BrowserProviderBroker,
  ) {}

  static async start(options: ControlServerOptions): Promise<ControlServer> {
    const canonicalRoot = await canonicalizeProjectRoot(options.projectRoot);
    const authority = new ControlAuthority(options.runtime, options.ownerEpoch, canonicalRoot);

    const parent = controlEndpointParent(options.endpoint);
    if (parent) await mkdir(parent, { recursive: true, mode: 0o700 });
    await rm(options.endpoint, { force: true }).catch(() => undefined);

    const server = createServer();
    const control = new ControlServer(
      server,
      options.endpoint,
      authority,
      options.credentials,
      canonicalRoot,
      options.operatorCommandPolicy ?? 'disabled',
      options.broker,
    );

    server.on('connection', (socket) => {
      control.sockets.add(socket);
      socket.on('close', () => control.sockets.delete(socket));
      socket.on('error', () => control.sockets.delete(socket));
      control.handleConnection(socket);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.endpoint, () => {
        server.off('error', reject);
        resolve();
      });
    });

    if (process.platform !== 'win32') {
      await chmod(options.endpoint, 0o600).catch(() => undefined);
    }
    return control;
  }

  get address(): string {
    return this.endpoint;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await rm(this.endpoint, { force: true }).catch(() => undefined);
  }

  private handleConnection(socket: Socket): void {
    let principal: ControlPrincipal | null = null;
    let clientId: string | undefined;
    let provider: BrowserProviderRegistration | null = null;
    let buffer = '';
    let tail = Promise.resolve();
    let queuedFrames = 0;
    let queuedBytes = 0;

    const write = (message: ControlResponse | ProviderPush): void => {
      if (!socket.destroyed) socket.write(`${encodeControlMessage(message)}\n`);
    };

    const fail = (code: string, message: string, requestId?: string): void => {
      write({ version: 1, type: 'error', requestId, code, message });
      socket.destroy();
    };

    socket.setEncoding('utf8');
    socket.on('close', () => { void provider?.disconnect().catch(() => undefined); });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES && buffer.indexOf('\n') < 0) {
        fail('frame_too_large', 'control frame exceeds maximum size');
        buffer = '';
        return;
      }
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (line.trim().length === 0) continue;
        const frameBytes = Buffer.byteLength(line, 'utf8');
        if (frameBytes > MAX_FRAME_BYTES) {
          fail('frame_too_large', 'control frame exceeds maximum size');
          buffer = '';
          return;
        }
        queuedFrames += 1;
        queuedBytes += frameBytes;
        if (queuedFrames > MAX_QUEUED_FRAMES || queuedBytes > MAX_QUEUED_BYTES) {
          fail('backpressure', 'too many queued control frames');
          buffer = '';
          return;
        }
        tail = tail.then(() => this.handleLine(line, write, fail, {
          getPrincipal: () => principal,
          setPrincipal: (value, id) => {
            principal = value;
            clientId = id;
          },
          getClientId: () => clientId,
          getProvider: () => provider,
          setProvider: (value) => { provider = value; },
        })).catch((error) => {
          fail('internal', error instanceof Error ? error.message : 'internal error');
        }).finally(() => {
          queuedFrames -= 1;
          queuedBytes -= frameBytes;
        });
      }
    });
  }

  private async handleLine(
    line: string,
    write: (message: ControlResponse | ProviderPush) => void,
    fail: (code: string, message: string, requestId?: string) => void,
    session: {
      getPrincipal: () => ControlPrincipal | null;
      setPrincipal: (principal: ControlPrincipal, clientId?: string) => void;
      getClientId: () => string | undefined;
      getProvider: () => BrowserProviderRegistration | null;
      setProvider: (provider: BrowserProviderRegistration) => void;
    },
  ): Promise<void> {
    let request: ReturnType<typeof decodeControlRequest>;
    try {
      request = decodeControlRequest(line);
    } catch (error) {
      fail('bad_request', error instanceof Error ? error.message : 'invalid request');
      return;
    }

    const principal = session.getPrincipal();
    if (!principal) {
      if (request.type !== 'hello') {
        fail('unauthorized', 'hello required', request.requestId);
        return;
      }
      const authenticated = await this.credentials.authenticate(request.token);
      if (!authenticated) {
        fail('unauthorized', 'invalid control token', request.requestId);
        return;
      }
      let helloRoot: string;
      try {
        helloRoot = await canonicalizeProjectRoot(request.projectRoot);
      } catch {
        fail('project_mismatch', 'unknown project root', request.requestId);
        return;
      }
      if (helloRoot !== this.canonicalRoot) {
        fail('project_mismatch', 'project root does not match this owner', request.requestId);
        return;
      }
      session.setPrincipal(authenticated, request.clientName);
      write(this.authority.welcomeFor(authenticated));
      return;
    }

    await this.broker?.ready();
    const provider = session.getProvider();
    const isProviderFrame = request.type === 'provider.register'
      || request.type === 'provider.resource.upsert'
      || request.type === 'provider.resource.remove'
      || request.type === 'provider.effect.result';
    if (provider && !isProviderFrame) {
      write({
        version: 1, type: 'error', requestId: request.requestId,
        code: 'provider_mode_only', message: 'provider connections accept provider frames only',
      });
      return;
    }
    if (provider && request.type === 'provider.register') {
      write({
        version: 1, type: 'error', requestId: request.requestId,
        code: 'already_registered', message: 'provider connection is already registered',
      });
      return;
    }
    if (!provider && isProviderFrame && request.type !== 'provider.register') {
      write({
        version: 1, type: 'error', requestId: request.requestId,
        code: 'provider_not_registered', message: 'provider registration is required',
      });
      return;
    }

    switch (request.type) {
      case 'hello':
        write({
          version: 1,
          type: 'error',
          requestId: request.requestId,
          code: 'already_authenticated',
          message: 'connection already completed its handshake',
        });
        return;
      case 'command.submit': {
        if (!KNOWN_COMMAND_KINDS.has(request.command.kind)) {
          write({
            version: 1,
            type: 'command.result',
            requestId: request.requestId,
            commandId: request.command.id,
            outcome: {
              status: 'rejected',
              code: 'bad_request',
              message: `unknown command kind: ${String(request.command.kind)}`,
            },
          });
          return;
        }
        if (principal.kind === 'operator' && this.operatorCommandPolicy === 'disabled') {
          write({
            version: 1,
            type: 'command.result',
            requestId: request.requestId,
            commandId: request.command.id,
            outcome: {
              status: 'rejected',
              code: 'operator_authority_unavailable',
              message: 'operator commands require a native user-presence approval broker',
            },
          });
          return;
        }
        const outcome = await this.authority.submitAs(
          principal,
          request.command,
          session.getClientId(),
        );
        write({
          version: 1,
          type: 'command.result',
          requestId: request.requestId,
          commandId: request.command.id,
          outcome,
        });
        return;
      }
      case 'state.get':
        write({
          version: 1,
          type: 'state.result',
          requestId: request.requestId,
          snapshot: this.authority.snapshot(principal, {
            ...(request.taskId ? { taskId: request.taskId } : {}),
          }),
        });
        return;
      case 'events.read': {
        const page = this.authority.readEvents(principal, request.afterSequence, request.limit, {
          ...(request.taskId ? { taskId: request.taskId } : {}),
        });
        write({
          version: 1,
          type: 'events.result',
          requestId: request.requestId,
          events: page.events,
          nextSequence: page.nextSequence,
          gap: page.gap,
        });
        return;
      }
      case 'provider.register': {
        if (this.operatorCommandPolicy === 'disabled') {
          write({
            version: 1, type: 'error', requestId: request.requestId,
            code: 'provider_authority_unavailable',
            message: 'provider registration requires a native identity broker',
          });
          return;
        }
        if (principal.kind !== 'operator') {
          write({
            version: 1, type: 'error', requestId: request.requestId,
            code: 'operator_required', message: 'only an operator may register a provider',
          });
          return;
        }
        if (!this.broker) {
          write({
            version: 1, type: 'error', requestId: request.requestId,
            code: 'provider_unavailable', message: 'browser provider transport is unavailable',
          });
          return;
        }
        try {
          session.setProvider(this.broker.register(request.providerId, write));
          write({ version: 1, type: 'ack', requestId: request.requestId });
        } catch (error) {
          writeProviderError(write, request.requestId, error);
        }
        return;
      }
      case 'provider.resource.upsert':
        try {
          const resource = await provider!.upsert(request.resource);
          write({ version: 1, type: 'ack', requestId: request.requestId, resource });
        } catch (error) {
          writeProviderError(write, request.requestId, error);
        }
        return;
      case 'provider.resource.remove':
        try {
          await provider!.remove(request.id, request.generation);
          write({ version: 1, type: 'ack', requestId: request.requestId });
        } catch (error) {
          writeProviderError(write, request.requestId, error);
        }
        return;
      case 'provider.effect.result':
        try {
          provider!.complete(request.result);
          write({ version: 1, type: 'ack', requestId: request.requestId });
        } catch (error) {
          writeProviderError(write, request.requestId, error);
        }
        return;
    }
  }
}

function writeProviderError(
  write: (message: ControlResponse | ProviderPush) => void,
  requestId: string,
  error: unknown,
): void {
  const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'provider_error';
  write({
    version: 1,
    type: 'error',
    requestId,
    code,
    message: error instanceof Error ? error.message : 'browser provider error',
  });
}

export { compatibilityPrincipal } from './credentials.js';
