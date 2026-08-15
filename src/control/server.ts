import { createHash } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { canonicalizeProjectRoot } from './projectIdentity.js';
import { controlEndpointParent } from './endpoint.js';
import {
  type AuthenticatedControlIdentity,
  type ControlCredentialStore,
  type ControlPrincipal,
} from './credentials.js';
import {
  decodeControlRequest,
  encodeControlMessage,
  type ControlResponse,
} from './protocol.js';
import { isActionStatusReceipt } from './types.js';
import type {
  BrowserProviderBroker,
  BrowserProviderRegistration,
  ProviderPush,
} from './browserProviderBroker.js';
import type {
  ActionStatusReceipt,
  CommandOutcome,
  ControlSnapshot,
  ControlSnapshotScope,
  ControlActor,
  ControlActorKind,
  ControlCommand,
  ControlCommandInput,
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
const INTERNAL_IDEMPOTENCY_PREFIX = 'psyche-control-idempotency-v1';

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

const AGENT_ALLOWED_COMMAND_KINDS: ReadonlySet<ControlCommand['kind']> = new Set([
  'orchestration.execute', 'lease.request', 'lease.release', 'pane.observe', 'pane.action',
  'browser.inspect', 'browser.action', 'browser.script',
]);

const AGENT_CONTROL_COMMAND_KINDS: ReadonlySet<ControlCommand['kind']> = new Set([
  'lease.request', 'lease.grant', 'lease.release', 'lease.revoke', 'pane.observe',
  'pane.action', 'browser.inspect', 'browser.action', 'browser.script',
  'approval.resolve', 'provider.resource.upsert', 'provider.resource.remove',
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
  if (principal.kind === 'compatibility' && AGENT_CONTROL_COMMAND_KINDS.has(kind)) {
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
  if (principal.kind === 'agent' && !AGENT_ALLOWED_COMMAND_KINDS.has(kind)) {
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
    authenticated: ControlPrincipal | AuthenticatedControlIdentity,
    input: ControlCommandInput,
    clientId?: string,
  ): Promise<CommandOutcome> {
    const identity = normalizeIdentity(authenticated);
    const principal = identity.principal;
    const rejection = authorizeCommand(principal, input.kind);
    if (rejection) return rejection;
    if (principal.kind !== 'operator'
      && AGENT_ALLOWED_COMMAND_KINDS.has(input.kind)
      && !identity.taskBinding) {
      return taskBindingRequired();
    }
    const boundInput = applyTaskBinding(input, identity.taskBinding?.taskId);
    if (isOutcome(boundInput)) return boundInput;

    const command = {
      ...boundInput,
      idempotencyKey: runtimeIdempotencyKey(
        identity,
        this.canonicalProjectRoot,
        boundInput.idempotencyKey,
      ),
      projectRoot: this.canonicalProjectRoot,
      actor: actorForPrincipal(principal, clientId),
      ownerEpoch: this.ownerEpoch,
    } as ControlCommand;
    return this.runtime.submit(command);
  }

  snapshot(
    authenticated: ControlPrincipal | AuthenticatedControlIdentity,
    scope: ControlSnapshotScope = {},
  ): ControlSnapshot {
    const identity = normalizeIdentity(authenticated);
    const snapshot = this.runtime.snapshot();
    const principal = identity.principal;
    if (principal.kind === 'operator') return snapshot;
    const taskScope = effectiveTaskScope(identity, scope);
    if (taskScope) return taskScopedSnapshot(snapshot, taskScope);

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
      leaseHistory: [],
      leaseRequests: [],
      approvals: [],
      receipts: [],
    };
  }

  readEvents(
    authenticated: ControlPrincipal | AuthenticatedControlIdentity,
    afterSequence: number,
    limit?: number,
    scope: ControlSnapshotScope = {},
  ): {
    events: unknown[];
    nextSequence: number;
    gap: boolean;
  } {
    const identity = normalizeIdentity(authenticated);
    const principal = identity.principal;
    if (principal.kind === 'operator') return this.runtime.readEvents(afterSequence, limit);

    const taskScope = effectiveTaskScope(identity, scope);
    if (!taskScope) {
      const page = this.runtime.readEvents(afterSequence, limit);
      return { events: [], nextSequence: page.nextSequence, gap: page.gap };
    }

    const page = this.runtime.readEvents(afterSequence, limit);
    const events: unknown[] = [];
    let nextSequence = page.nextSequence;
    for (const event of page.events) {
      const scoped = taskScopedEvent(event, taskScope);
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

  welcomeFor(authenticated: ControlPrincipal | AuthenticatedControlIdentity): Extract<ControlResponse, { type: 'welcome' }> {
    const identity = normalizeIdentity(authenticated);
    const principal = identity.principal;
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
      ...(identity.taskBinding ? {
        taskBinding: {
          taskId: identity.taskBinding.taskId,
          subjectId: identity.taskBinding.subjectId,
        },
      } : {}),
    };
  }
}

function normalizeIdentity(
  authenticated: ControlPrincipal | AuthenticatedControlIdentity,
): AuthenticatedControlIdentity {
  return 'principal' in authenticated
    ? authenticated
    : { principal: authenticated };
}

function runtimeIdempotencyKey(
  identity: AuthenticatedControlIdentity,
  canonicalProjectRoot: string,
  callerKey: string,
): string {
  if (identity.principal.kind === 'operator') return callerKey;
  const hash = createHash('sha256');
  for (const component of idempotencyNamespaceComponents(identity, canonicalProjectRoot, callerKey)) {
    const bytes = Buffer.from(component, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return `${INTERNAL_IDEMPOTENCY_PREFIX}:${hash.digest('hex')}`;
}

function idempotencyNamespaceComponents(
  identity: AuthenticatedControlIdentity,
  canonicalProjectRoot: string,
  callerKey: string,
): readonly string[] {
  const scope = [
    INTERNAL_IDEMPOTENCY_PREFIX,
    'project',
    canonicalProjectRoot,
    'principal-kind',
    identity.principal.kind,
  ];
  return identity.taskBinding
    ? [
        ...scope,
        'task',
        identity.taskBinding.taskId,
        'subject',
        identity.taskBinding.subjectId,
        'principal',
        identity.principal.id,
        'caller',
        callerKey,
      ]
    : [
        ...scope,
        'principal',
        identity.principal.id,
        'caller',
        callerKey,
      ];
}

interface TaskScopedIdentity {
  taskId: string;
  actorId: string;
}

function effectiveTaskScope(
  identity: AuthenticatedControlIdentity,
  _scope: ControlSnapshotScope,
): TaskScopedIdentity | undefined {
  return identity.taskBinding
    ? { taskId: identity.taskBinding.taskId, actorId: identity.principal.id }
    : undefined;
}

function applyTaskBinding(
  input: ControlCommandInput,
  taskId: string | undefined,
): ControlCommandInput | CommandOutcome {
  if (!taskId) return input;
  switch (input.kind) {
    case 'lease.request':
      return input.payload.taskId === taskId
        ? ({ ...input, payload: { ...input.payload, taskId } } as typeof input)
        : taskBindingMismatch();
    case 'lease.release':
      return input.payload.taskId === taskId
        ? ({ ...input, payload: { ...input.payload, taskId } } as typeof input)
        : taskBindingMismatch();
    case 'pane.observe':
    case 'browser.inspect':
    case 'browser.action':
    case 'browser.script':
      return input.payload.taskId === taskId
        ? ({ ...input, payload: { ...input.payload, taskId } } as typeof input)
        : taskBindingMismatch();
    case 'pane.action':
      return input.payload.taskId === taskId
        ? ({ ...input, payload: { ...input.payload, taskId } } as typeof input)
        : taskBindingMismatch();
    case 'orchestration.execute':
      return input.payload.taskId === taskId && input.payload.request.taskId === taskId
        ? {
            ...input,
            payload: {
              ...input.payload,
              taskId,
              request: { ...input.payload.request, taskId },
            },
          } as typeof input
        : taskBindingMismatch();
    case 'coven.capability.execute':
      return input.payload.taskId === taskId
        ? ({ ...input, payload: { ...input.payload, taskId } } as typeof input)
        : taskBindingMismatch();
    default:
      return input;
  }
}

function taskBindingMismatch(): CommandOutcome {
  return {
    status: 'rejected',
    code: 'task_binding_mismatch',
    message: 'bound task identity does not authorize the requested task',
  };
}

function taskBindingRequired(): CommandOutcome {
  return {
    status: 'rejected',
    code: 'task_binding_required',
    message: 'task-bound credentials are required for agent surface commands',
  };
}

function isOutcome(value: ControlCommandInput | CommandOutcome): value is CommandOutcome {
  return value && typeof value === 'object' && 'status' in value;
}

/**
 * Task-scoped agent reads only trust durable task ownership already stamped by
 * the owner: capability leases and pending lease requests carry `taskId`
 * directly, active approvals now carry the durable task/actor ownership tuple
 * directly, and both live and replay receipts must carry exact task/actor
 * ownership plus a complete lease tuple whenever the owner could safely prove
 * that lease context.
 * Legacy approvals still fall back to the exact visible lease id/revision,
 * while legacy unowned receipts remain operator-only because ownership cannot
 * be proven for a scoped read.
 */
function taskScopedSnapshot(
  snapshot: ControlSnapshot,
  scope: TaskScopedIdentity,
): ControlSnapshot {
  const capabilityLeases = snapshot.capabilityLeases.filter((lease) => (
    lease.taskId === scope.taskId && lease.actorId === scope.actorId
  ));
  const leaseRequests = snapshot.leaseRequests.filter((request) => (
    request.taskId === scope.taskId && request.actorId === scope.actorId
  ));
  const activeLeasesById = new Map(capabilityLeases.map((lease) => [lease.id, lease] as const));
  const approvals = snapshot.approvals.filter((approval) => (
    (approval.status === 'pending' || approval.status === 'approved')
    && approvalMatchesTaskScope(approval, scope, activeLeasesById)
  ));
  const receipts = snapshot.receipts
    .filter((receipt) => hasTaskScopedOwnership(receipt, scope))
    .map(publicTaskScopedReceipt);
  return {
    ...snapshot,
    commands: {},
    leases: {},
    resources: collectScopedResources(snapshot.resources, capabilityLeases, leaseRequests),
    capabilityLeases,
    leaseHistory: [],
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

function hasTaskScopedOwnership(receipt: ActionStatusReceipt, scope: TaskScopedIdentity): boolean {
  if (receipt.taskId !== scope.taskId || receipt.actorId !== scope.actorId) return false;
  const hasLeaseId = typeof receipt.leaseId === 'string';
  const hasLeaseRevision = receipt.leaseRevision !== undefined;
  if (hasLeaseId !== hasLeaseRevision) return false;
  if (!hasLeaseId || !hasLeaseRevision) return true;
  const leaseId = receipt.leaseId as string;
  const leaseRevision = receipt.leaseRevision as number;
  return leaseId.length > 0
    && Number.isSafeInteger(leaseRevision)
    && leaseRevision >= 1;
}

function approvalMatchesTaskScope(
  approval: ControlSnapshot['approvals'][number],
  scope: TaskScopedIdentity,
  activeLeasesById: ReadonlyMap<string, ControlSnapshot['capabilityLeases'][number]>,
): boolean {
  if (
    typeof approval.taskId === 'string'
    && typeof approval.actorId === 'string'
    && approval.taskId === scope.taskId
    && approval.actorId === scope.actorId
  ) return true;
  const lease = activeLeasesById.get(approval.leaseId);
  return lease !== undefined
    && lease.taskId === scope.taskId
    && lease.actorId === scope.actorId
    && lease.revision === approval.leaseRevision;
}

function publicTaskScopedReceipt<T extends ActionStatusReceipt>(receipt: T): T {
  const {
    taskId: _taskId,
    actorId: _actorId,
    leaseId: _leaseId,
    leaseRevision: _leaseRevision,
    value: _value,
    message: _message,
    ...safeReceipt
  } = receipt as T & {
    value?: unknown;
    message?: string;
  };
  return Object.freeze(safeReceipt) as T;
}

function taskScopedEvent(event: unknown, scope: TaskScopedIdentity): unknown | undefined {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return undefined;
  const payload = (event as { payload?: unknown }).payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const receipt = taskScopedEventReceipt((payload as { receipt?: unknown }).receipt, scope);
  if (!receipt) return undefined;
  return {
    ...(event as Record<string, unknown>),
    payload: {
      ...(payload as Record<string, unknown>),
      receipt,
    },
  };
}

function taskScopedEventReceipt(receipt: unknown, scope: TaskScopedIdentity): ActionStatusReceipt | undefined {
  if (!isActionStatusReceipt(receipt)) return undefined;
  return hasTaskScopedOwnership(receipt, scope)
    ? publicTaskScopedReceipt(receipt)
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
    let identity: AuthenticatedControlIdentity | null = null;
    let clientId: string | undefined;
    let token: string | undefined;
    let provider: BrowserProviderRegistration | null = null;
    let buffer = '';
    let tail = Promise.resolve();
    let queuedFrames = 0;
    let queuedBytes = 0;
    let closing = false;

    const write = (message: ControlResponse | ProviderPush): void => {
      if (!socket.destroyed) socket.write(`${encodeControlMessage(message)}\n`);
    };

    const fail = (code: string, message: string, requestId?: string): void => {
      closing = true;
      identity = null;
      clientId = undefined;
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
        if (closing) continue;
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
        tail = tail.then(() => {
          if (closing) return;
          return this.handleLine(line, write, fail, {
            getIdentity: () => identity,
            getToken: () => token,
            setIdentity: (value, id, authenticatedToken) => {
              identity = value;
              clientId = id;
              token = authenticatedToken;
            },
            getClientId: () => clientId,
            getProvider: () => provider,
            setProvider: (value) => { provider = value; },
          });
        }).catch((error) => {
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
      getIdentity: () => AuthenticatedControlIdentity | null;
      getToken: () => string | undefined;
      setIdentity: (
        identity: AuthenticatedControlIdentity,
        clientId?: string,
        authenticatedToken?: string,
      ) => void;
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

    const identity = session.getIdentity();
    if (!identity) {
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
      session.setIdentity(authenticated, request.clientName, request.token);
      write(this.authority.welcomeFor(authenticated));
      return;
    }
    const refreshed = await this.reauthenticateSession(session.getToken(), identity);
    if (refreshed === 'missing') {
      fail('unauthorized', 'control token is no longer valid', request.requestId);
      return;
    }
    if (refreshed === 'unavailable') {
      fail('credential_unavailable', 'task credential state is temporarily unavailable', request.requestId);
      return;
    }
    if (refreshed === 'changed') {
      fail('credentials_rotated', 'control token identity changed; reconnect with a fresh credential', request.requestId);
      return;
    }
    const currentIdentity = refreshed;
    const principal = currentIdentity.principal;

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
          currentIdentity,
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
          snapshot: this.authority.snapshot(currentIdentity, {
            ...(request.taskId ? { taskId: request.taskId } : {}),
          }),
        });
        return;
      case 'events.read': {
        const page = this.authority.readEvents(currentIdentity, request.afterSequence, request.limit, {
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

  private async reauthenticateSession(
    token: string | undefined,
    identity: AuthenticatedControlIdentity,
  ): Promise<AuthenticatedControlIdentity | 'missing' | 'changed' | 'unavailable'> {
    if (!token) return 'missing';
    if (identity.taskBinding && identity.principal.kind === 'agent' && this.credentials.currentTaskCredential) {
      let current;
      try {
        current = await this.credentials.currentTaskCredential(identity.taskBinding.taskId);
      } catch {
        return 'unavailable';
      }
      if (!current) return 'missing';
      return current.principalId === identity.principal.id
        && current.taskBinding.subjectId === identity.taskBinding.subjectId
        ? identity
        : 'changed';
    }
    const refreshed = await this.credentials.authenticate(token);
    if (!refreshed) return 'missing';
    return sameAuthenticatedIdentity(identity, refreshed) ? refreshed : 'changed';
  }
}

function sameAuthenticatedIdentity(
  left: AuthenticatedControlIdentity,
  right: AuthenticatedControlIdentity,
): boolean {
  return left.principal.id === right.principal.id
    && left.principal.kind === right.principal.kind
    && left.principal.capabilities.length === right.principal.capabilities.length
    && left.principal.capabilities.every((capability, index) => (
      capability === right.principal.capabilities[index]
    ))
    && sameTaskBinding(left.taskBinding, right.taskBinding);
}

function sameTaskBinding(
  left: AuthenticatedControlIdentity['taskBinding'],
  right: AuthenticatedControlIdentity['taskBinding'],
): boolean {
  if (!left || !right) return left === right;
  return left.taskId === right.taskId && left.subjectId === right.subjectId;
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
