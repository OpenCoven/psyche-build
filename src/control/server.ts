import { createServer, type Server, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
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
  type LeaseStatusResultData,
  type TaskResourcesResultData,
} from './protocol.js';
import type {
  BrowserProviderBroker,
  BrowserProviderRegistration,
  ProviderPush,
} from './browserProviderBroker.js';
import type { CapabilityLease, LeaseTarget } from './capabilityLeases.js';
import type { SurfaceResource } from './surfaces.js';
import type {
  ControlActor,
  ControlActorKind,
  ControlCommand,
  ControlCommandInput,
  CommandOutcome,
  ControlSnapshot,
  LeaseGrant,
} from './types.js';

type LeaseRequest = ControlSnapshot['leaseRequests'][number];

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

type ControlAuthorityIdentity = AuthenticatedControlIdentity | ControlPrincipal;

function normalizeControlIdentity(identity: ControlAuthorityIdentity): AuthenticatedControlIdentity {
  if ('principal' in identity) return identity;
  return { ...identity, principal: identity };
}

function runtimeIdempotencyKey(
  identity: AuthenticatedControlIdentity,
  canonicalProjectRoot: string,
  callerKey: string,
): string {
  if (identity.principal.kind === 'operator') return callerKey;

  const scope = identity.taskBinding === undefined
    ? ['principal', canonicalProjectRoot, identity.principal.kind, identity.principal.id]
    : ['task', canonicalProjectRoot, identity.taskBinding.taskId];
  const hash = createHash('sha256');
  for (const component of [
    INTERNAL_IDEMPOTENCY_PREFIX,
    ...scope,
    'caller',
    callerKey,
  ]) {
    const bytes = Buffer.from(component, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return `${INTERNAL_IDEMPOTENCY_PREFIX}:${hash.digest('hex')}`;
}

const TASK_SENSITIVE_COMMAND_KINDS: ReadonlySet<ControlCommand['kind']> = new Set([
  'orchestration.execute',
  'lease.request',
  'lease.release',
  'pane.observe',
  'pane.action',
  'browser.inspect',
  'browser.action',
  'browser.script',
]);

function requestedTaskId(input: ControlCommandInput): string | undefined {
  if (!TASK_SENSITIVE_COMMAND_KINDS.has(input.kind)) return undefined;
  const payload: unknown = input.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  const taskId = (payload as Record<string, unknown>).taskId;
  return typeof taskId === 'string' ? taskId : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireTaskBinding(
  identity: AuthenticatedControlIdentity,
  taskId: string | undefined,
): CommandOutcome | undefined {
  if (identity.principal.kind === 'operator') return undefined;
  const authenticatedTaskId = identity.taskBinding?.taskId;
  if (!authenticatedTaskId) {
    return {
      status: 'rejected',
      code: 'task_binding_required',
      message: 'task-bound control credential required',
    };
  }
  if (taskId !== authenticatedTaskId) {
    return {
      status: 'rejected',
      code: 'task_binding_mismatch',
      message: 'command task does not match authenticated task',
    };
  }
  return undefined;
}

function taskIdForDedicatedRead(identity: AuthenticatedControlIdentity): string {
  const taskId = identity.taskBinding?.taskId;
  if (!taskId) {
    throw Object.assign(new Error('task-bound control credential required'), {
      code: 'task_binding_required',
    });
  }
  return taskId;
}

function targetKey(target: LeaseTarget): string | undefined {
  if (target.kind === 'project') return undefined;
  return JSON.stringify([target.kind, target.id, target.generation]);
}

function resourceKey(resource: SurfaceResource): string {
  return JSON.stringify([resource.kind, resource.id, resource.generation]);
}

function cloneTarget(target: LeaseTarget): LeaseTarget {
  return target.kind === 'project'
    ? Object.freeze({ kind: 'project', id: target.id })
    : Object.freeze({
      kind: target.kind,
      id: target.id,
      generation: target.generation,
    });
}

function cloneGrants(grants: readonly LeaseGrant[]): readonly LeaseGrant[] {
  return Object.freeze(grants.map((grant) => Object.freeze({
    target: cloneTarget(grant.target),
    capabilities: Object.freeze([...grant.capabilities]),
  })));
}

function cloneLeaseRequest(request: LeaseRequest): LeaseRequest {
  return Object.freeze({
    id: request.id,
    ownerEpoch: request.ownerEpoch,
    actorId: request.actorId,
    taskId: request.taskId,
    status: request.status,
    createdAt: request.createdAt,
    ttlMs: request.ttlMs,
    grants: cloneGrants(request.grants),
  });
}

function cloneCapabilityLease(lease: CapabilityLease): CapabilityLease {
  return Object.freeze({
    id: lease.id,
    requestId: lease.requestId,
    revision: lease.revision,
    ownerEpoch: lease.ownerEpoch,
    actorId: lease.actorId,
    taskId: lease.taskId,
    grantedBy: lease.grantedBy,
    grants: cloneGrants(lease.grants),
    createdAt: lease.createdAt,
    expiresAt: lease.expiresAt,
  });
}

function cloneSurfaceResource(resource: SurfaceResource): SurfaceResource {
  if (resource.kind === 'pane') {
    return Object.freeze({
      id: resource.id,
      kind: resource.kind,
      generation: resource.generation,
      projectRoot: resource.projectRoot,
      worktreeRoot: resource.worktreeRoot,
      tmuxPaneId: resource.tmuxPaneId,
      ...(resource.title === undefined ? {} : { title: resource.title }),
      ...(resource.agent === undefined ? {} : { agent: resource.agent }),
      writable: resource.writable,
      outputSequence: resource.outputSequence,
    });
  }
  return Object.freeze({
    id: resource.id,
    kind: resource.kind,
    generation: resource.generation,
    projectRoot: resource.projectRoot,
    worktreeRoot: resource.worktreeRoot,
    providerId: resource.providerId,
    webviewLabel: resource.webviewLabel,
    url: resource.url,
    title: resource.title,
    loading: resource.loading,
    viewport: Object.freeze({
      width: resource.viewport.width,
      height: resource.viewport.height,
    }),
  });
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
    identity: ControlAuthorityIdentity,
    input: ControlCommandInput,
    clientId?: string,
  ): Promise<CommandOutcome> {
    const authenticated = normalizeControlIdentity(identity);
    const { principal } = authenticated;
    if (TASK_SENSITIVE_COMMAND_KINDS.has(input.kind)) {
      const bindingRejection = requireTaskBinding(authenticated, requestedTaskId(input));
      if (bindingRejection) return bindingRejection;
    }
    const rejection = authorizeCommand(principal, input.kind);
    if (rejection) return rejection;

    let trustedInput: ControlCommandInput = input;
    if (input.kind === 'orchestration.execute') {
      const nestedRequest: unknown = input.payload.request;
      const trustedTaskId = principal.kind === 'operator'
        ? input.payload.taskId
        : authenticated.taskBinding?.taskId;
      if (
        typeof trustedTaskId !== 'string'
        || !isPlainObject(nestedRequest)
        || nestedRequest.taskId !== trustedTaskId
      ) {
        return {
          status: 'rejected',
          code: 'task_binding_mismatch',
          message: 'orchestration task does not match authenticated task',
        };
      }
      if (nestedRequest.projectRoot !== this.canonicalProjectRoot) {
        return {
          status: 'rejected',
          code: 'project_mismatch',
          message: 'orchestration project root does not match this owner',
        };
      }
      trustedInput = {
        ...input,
        payload: {
          ...input.payload,
          request: {
            ...input.payload.request,
            taskId: trustedTaskId,
            projectRoot: this.canonicalProjectRoot,
          },
        },
      };
    }

    const command = {
      ...trustedInput,
      idempotencyKey: runtimeIdempotencyKey(
        authenticated,
        this.canonicalProjectRoot,
        trustedInput.idempotencyKey,
      ),
      projectRoot: this.canonicalProjectRoot,
      actor: actorForPrincipal(principal, clientId),
      ownerEpoch: this.ownerEpoch,
    } as ControlCommand;
    return this.runtime.submit(command);
  }

  taskResources(identity: AuthenticatedControlIdentity): TaskResourcesResultData {
    const taskId = taskIdForDedicatedRead(identity);
    const snapshot = this.runtime.snapshot();
    const authorizedTargets = new Set<string>();

    for (const lease of snapshot.capabilityLeases) {
      if (
        lease.ownerEpoch !== this.ownerEpoch
        || lease.taskId !== taskId
      ) continue;
      for (const grant of lease.grants) {
        const key = targetKey(grant.target);
        if (key) authorizedTargets.add(key);
      }
    }

    const emitted = new Set<string>();
    const resources: SurfaceResource[] = [];
    for (const resource of snapshot.resources) {
      const key = resourceKey(resource);
      if (!authorizedTargets.has(key) || emitted.has(key)) continue;
      emitted.add(key);
      resources.push(cloneSurfaceResource(resource));
    }
    return Object.freeze({
      ownerEpoch: this.ownerEpoch,
      sequence: snapshot.sequence,
      resources: Object.freeze(resources),
    });
  }

  leaseStatus(
    identity: AuthenticatedControlIdentity,
    leaseRequestId: string,
    leaseId?: string,
  ): LeaseStatusResultData {
    const taskId = taskIdForDedicatedRead(identity);
    const snapshot = this.runtime.snapshot();
    const requests = snapshot.leaseRequests
      .filter((request) => (
        request.ownerEpoch === this.ownerEpoch
        && request.taskId === taskId
        && request.id === leaseRequestId
      ))
      .map(cloneLeaseRequest);
    const leases = snapshot.capabilityLeases
      .filter((lease) => (
        lease.ownerEpoch === this.ownerEpoch
        && lease.taskId === taskId
        && lease.requestId === leaseRequestId
        && (leaseId === undefined || lease.id === leaseId)
      ))
      .map(cloneCapabilityLease);
    return Object.freeze({
      requests: Object.freeze(requests),
      leases: Object.freeze(leases),
    });
  }

  snapshot(identity: ControlAuthorityIdentity): ControlSnapshot {
    const { principal } = normalizeControlIdentity(identity);
    const snapshot = this.runtime.snapshot();
    if (principal.kind === 'operator') return snapshot;

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

  readEvents(afterSequence: number, limit?: number): {
    events: unknown[];
    nextSequence: number;
    gap: boolean;
  };
  readEvents(identity: ControlAuthorityIdentity, afterSequence: number, limit?: number): {
    events: unknown[];
    nextSequence: number;
    gap: boolean;
  };
  readEvents(
    identityOrAfterSequence: ControlAuthorityIdentity | number,
    afterSequenceOrLimit?: number,
    limit?: number,
  ): {
    events: unknown[];
    nextSequence: number;
    gap: boolean;
  } {
    if (typeof identityOrAfterSequence === 'number') {
      return this.runtime.readEvents(identityOrAfterSequence, afterSequenceOrLimit);
    }
    if (afterSequenceOrLimit === undefined) {
      throw new TypeError('afterSequence is required');
    }
    const { principal } = normalizeControlIdentity(identityOrAfterSequence);
    if (principal.kind !== 'operator') {
      throw Object.assign(new Error('raw control events require operator authority'), {
        code: 'operator_required',
      });
    }
    const afterSequence = afterSequenceOrLimit;
    return this.runtime.readEvents(afterSequence, limit);
  }

  welcomeFor(identity: ControlAuthorityIdentity): Extract<ControlResponse, { type: 'welcome' }> {
    const authenticated = normalizeControlIdentity(identity);
    const { principal } = authenticated;
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
      ...(authenticated.taskBinding === undefined
        ? {}
        : { taskBinding: authenticated.taskBinding }),
    };
  }
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
          getIdentity: () => identity,
          setIdentity: (value, id) => {
            identity = value;
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
      getIdentity: () => AuthenticatedControlIdentity | null;
      setIdentity: (identity: AuthenticatedControlIdentity, clientId?: string) => void;
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
      session.setIdentity(authenticated, request.clientName);
      write(this.authority.welcomeFor(authenticated));
      return;
    }
    const { principal } = identity;

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
          identity,
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
          snapshot: this.authority.snapshot(identity),
        });
        return;
      case 'task.resources.get':
        try {
          write({
            version: 1,
            type: 'task.resources.result',
            requestId: request.requestId,
            ...this.authority.taskResources(identity),
          });
        } catch (error) {
          writeCodedError(
            write,
            request.requestId,
            error,
            'task_resources_failed',
            'failed to read task resources',
          );
        }
        return;
      case 'lease.status.get':
        try {
          write({
            version: 1,
            type: 'lease.status.result',
            requestId: request.requestId,
            ...this.authority.leaseStatus(identity, request.leaseRequestId, request.leaseId),
          });
        } catch (error) {
          writeCodedError(
            write,
            request.requestId,
            error,
            'lease_status_failed',
            'failed to read lease status',
          );
        }
        return;
      case 'events.read': {
        let page: ReturnType<ControlAuthority['readEvents']>;
        try {
          page = this.authority.readEvents(identity, request.afterSequence, request.limit);
        } catch (error) {
          writeCodedError(
            write,
            request.requestId,
            error,
            'events_read_failed',
            'failed to read control events',
          );
          return;
        }
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
  writeCodedError(write, requestId, error, 'provider_error', 'browser provider error');
}

function writeCodedError(
  write: (message: ControlResponse | ProviderPush) => void,
  requestId: string,
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): void {
  const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : fallbackCode;
  write({
    version: 1,
    type: 'error',
    requestId,
    code,
    message: error instanceof Error ? error.message : fallbackMessage,
  });
}

export { compatibilityPrincipal } from './credentials.js';
