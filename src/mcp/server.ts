/** psyche MCP server (newline-delimited JSON-RPC 2.0 over stdio). */

import { execFile } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import {
  ControlClient,
  ControlResponseError,
  type ControlClientPrincipal,
  type ControlClientTaskBinding,
} from '../control/client.js';
import {
  createControlCredentialStoreForCanonicalRoot,
  fingerprintControlToken,
  type ControlCredentialStore,
} from '../control/credentials.js';
import {
  ensureCanonicalHostControlPlane,
  type ConnectControl,
  type EnsureHostOptions,
} from '../control/hostProcess.js';
import { canonicalizeProjectRoot } from '../control/projectIdentity.js';
import { controlEndpointForProject } from '../control/endpoint.js';
import {
  MAX_CONTROL_TASK_ID_LENGTH,
  normalizeControlTaskId,
} from '../control/taskIdentity.js';
import {
  isActionReceipt,
} from '../control/types.js';
import type {
  ActionReceipt,
  ActionStatusReceipt,
  CommandOutcome,
  ControlCommandInput,
  ControlSnapshot,
  ControlSnapshotScope,
} from '../control/types.js';
import type { CapabilityLeaseGrantItem } from '../control/capabilityLeases.js';
import { AGENT_CONTROL_LIMITS } from '../control/limits.js';
import { canonicalizeBoundedJson } from '../control/boundedJson.js';
import { getBuiltInRituals, listProjectRituals } from '../utils/rituals.js';
import type { OrchestrationTaskRequest } from '../orchestration/types.js';

const PROTOCOL_VERSION = '2025-06-18';
export const SERVER_NAME = 'psyche';
const SERVER_VERSION = '0.0.1';

type JsonRpcId = string | number | null;
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}
interface JsonRpcSuccess<T = unknown> { jsonrpc: '2.0'; id: JsonRpcId; result: T }
interface JsonRpcError {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}
type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL = -32603;
export const MCP_CONTROL_ERROR_CODE = -32001;

function writeResponse(response: JsonRpcResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function fail(id: JsonRpcId, code: number, message: string, data?: unknown): void {
  writeResponse({ jsonrpc: '2.0', id, error: { code, message, data } });
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface McpControlClient {
  readonly projectRoot?: string;
  readonly principal?: Pick<ControlClientPrincipal, 'kind'>;
  readonly taskBinding?: ControlClientTaskBinding;
  submit(command: ControlCommandInput): Promise<CommandOutcome>;
  getState(scope?: ControlSnapshotScope): Promise<ControlSnapshot>;
  actionStatus(actionId: string, scope?: ControlSnapshotScope): Promise<ActionStatusReceipt | undefined>;
  close(): Promise<void>;
}

export interface McpDeps {
  taskProjectRoot?: string;
  canonicalizeProjectRoot: typeof canonicalizeProjectRoot;
  controlClientForRoot(projectRoot: string): Promise<McpControlClient>;
  listRitualsForRoot(projectRoot: string): Promise<{
    builtin: readonly unknown[];
    project: readonly unknown[];
  }>;
  listWorktreesForRoot(projectRoot: string): Promise<readonly WorktreeSummary[]>;
  now(): Date;
  randomId(): string;
}

interface WorktreeSummary {
  path: string;
  head?: string;
  branch?: string;
  bare?: boolean;
  detached?: boolean;
  locked?: boolean;
}

const entryPath = fileURLToPath(new URL('../index.js', import.meta.url));

export interface McpControlClientBootstrapOptions {
  taskBinding?: McpTaskBinding;
  canonicalize?: typeof canonicalizeProjectRoot;
  credentialStoreForCanonicalRoot?: (options: {
    canonicalProjectRoot: string;
  }) => Promise<ControlCredentialStore>;
  connect?: ConnectControl;
  spawn?: EnsureHostOptions['spawn'];
  now?: EnsureHostOptions['now'];
  sleep?: EnsureHostOptions['sleep'];
  entryPath?: string;
}

export interface McpTaskBinding extends ControlClientTaskBinding {
  token: string;
  canonicalProjectRoot?: string;
}

export interface McpRunOptions {
  taskBinding?: McpTaskBinding;
}

type McpControlCredentialSource = 'shared-agent-token' | 'task-bound-token';

interface ResolvedMcpControlCredential {
  source: McpControlCredentialSource;
  token: string;
  tokenFingerprint: string;
  taskBinding?: ControlClientTaskBinding;
}

interface SharedControlClient {
  key: string;
  canonicalRoot: string;
  endpoint: string;
  credentialSource: McpControlCredentialSource;
  requestedTaskId?: string;
  requestedSubjectId?: string;
  tokenFingerprint: string;
  refs: number;
  promise: Promise<ControlClient>;
  principal?: Pick<ControlClientPrincipal, 'kind'>;
  taskBinding?: ControlClientTaskBinding;
  closePromise?: Promise<void>;
}

const sharedControlClients = new Map<string, SharedControlClient>();
const controlStartupFlights = new Map<string, Promise<ControlClient>>();
let mcpRunOptions: McpRunOptions = {};

export async function createMcpControlClientForRoot(
  projectRoot: string,
  options: McpControlClientBootstrapOptions = {},
): Promise<McpControlClient> {
  const canonicalize = options.canonicalize ?? canonicalizeProjectRoot;
  const requestedCanonicalRoot = await canonicalize(projectRoot);
  const authenticatedBinding = validateMcpTaskBinding(options.taskBinding);
  const canonicalRoot = await canonicalizeMcpProjectRoot(
    requestedCanonicalRoot,
    authenticatedBinding?.canonicalProjectRoot,
    canonicalize,
    true,
  );
  const credential = await resolveMcpControlCredential(canonicalRoot, {
    ...options,
    ...(authenticatedBinding === undefined ? {} : { taskBinding: authenticatedBinding }),
  });
  const endpoint = controlEndpointForProject(canonicalRoot);
  const key = [
    canonicalRoot,
    endpoint,
    credential.source,
    credential.taskBinding?.taskId ?? '',
    credential.taskBinding?.subjectId ?? '',
    credential.tokenFingerprint,
  ].join('\0');
  let shared = sharedControlClients.get(key);
  if (shared && !sameMcpControlCredentialIdentity(shared, canonicalRoot, credential)) {
    shared = undefined;
  }
  if (!shared) {
    let startup = controlStartupFlights.get(key);
    if (!startup) {
      startup = startMcpControlClient(canonicalRoot, credential, options);
      controlStartupFlights.set(key, startup);
      void startup.finally(() => {
        if (controlStartupFlights.get(key) === startup) controlStartupFlights.delete(key);
      }).catch(() => undefined);
    }
    shared = {
      key,
      canonicalRoot,
      endpoint,
      credentialSource: credential.source,
      requestedTaskId: credential.taskBinding?.taskId,
      requestedSubjectId: credential.taskBinding?.subjectId,
      tokenFingerprint: credential.tokenFingerprint,
      refs: 0,
      promise: startup,
    };
    sharedControlClients.set(key, shared);
    void startup.catch(() => {
      if (sharedControlClients.get(key) === shared) sharedControlClients.delete(key);
    });
  }
  shared.refs += 1;
  try {
    const resolved = await shared.promise;
    shared.principal = resolved.principal;
    shared.taskBinding = resolved.taskBinding;
  } catch (error) {
    shared.refs -= 1;
    await invalidateSharedControlClient(shared);
    throw error;
  }
  return borrowedControlClient(shared);
}

async function startMcpControlClient(
  canonicalRoot: string,
  credential: ResolvedMcpControlCredential,
  options: McpControlClientBootstrapOptions,
): Promise<ControlClient> {
  return ensureCanonicalHostControlPlane(canonicalRoot, {
    token: credential.token,
    clientName: 'psyche-mcp',
    entryPath: options.entryPath ?? entryPath,
    ...(credential.taskBinding ? { taskBinding: { ...credential.taskBinding } } : {}),
    ...(options.connect === undefined ? {} : { connect: options.connect }),
    ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
}

async function resolveMcpControlCredential(
  canonicalRoot: string,
  options: McpControlClientBootstrapOptions,
): Promise<ResolvedMcpControlCredential> {
  if (options.taskBinding) {
    return {
      source: 'task-bound-token',
      token: options.taskBinding.token,
      tokenFingerprint: fingerprintControlToken(options.taskBinding.token),
      taskBinding: {
        taskId: options.taskBinding.taskId,
        ...(options.taskBinding.subjectId ? { subjectId: options.taskBinding.subjectId } : {}),
      },
    };
  }
  const token = await ((
    options.credentialStoreForCanonicalRoot ?? createControlCredentialStoreForCanonicalRoot
  )({ canonicalProjectRoot: canonicalRoot })).then((credentials) => credentials.agentToken());
  return {
    source: 'shared-agent-token',
    token,
    tokenFingerprint: fingerprintControlToken(token),
  };
}

function sameMcpControlCredentialIdentity(
  shared: SharedControlClient,
  canonicalRoot: string,
  credential: ResolvedMcpControlCredential,
): boolean {
  return shared.canonicalRoot === canonicalRoot
    && shared.endpoint === controlEndpointForProject(canonicalRoot)
    && shared.credentialSource === credential.source
    && shared.requestedTaskId === credential.taskBinding?.taskId
    && shared.requestedSubjectId === credential.taskBinding?.subjectId
    && constantTimeHexEquals(shared.tokenFingerprint, credential.tokenFingerprint);
}

function constantTimeHexEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function borrowedControlClient(shared: SharedControlClient): McpControlClient {
  let released = false;
  const use = async <T>(operation: (client: ControlClient) => Promise<T>): Promise<T> => {
    try {
      return await operation(await shared.promise);
    } catch (error) {
      await invalidateSharedControlClient(shared);
      throw error;
    }
  };
  return {
    projectRoot: shared.canonicalRoot,
    principal: shared.principal,
    taskBinding: shared.taskBinding,
    submit: (command) => use((client) => client.submit(command)),
    getState: (scope) => use((client) => client.getState(scope)),
    actionStatus: (actionId, scope) => use((client) => client.actionStatus(actionId, scope)),
    async close() {
      if (released) return;
      released = true;
      shared.refs -= 1;
      if (shared.refs <= 0) await closeSharedControlClient(shared);
    },
  };
}

async function invalidateSharedControlClient(shared: SharedControlClient): Promise<void> {
  if (sharedControlClients.get(shared.key) === shared) sharedControlClients.delete(shared.key);
  await closeSharedControlClient(shared);
}

async function closeSharedControlClient(shared: SharedControlClient): Promise<void> {
  if (sharedControlClients.get(shared.key) === shared) sharedControlClients.delete(shared.key);
  shared.closePromise ??= shared.promise.then(
    (client) => client.close(),
    () => undefined,
  );
  await shared.closePromise;
}

export async function closeMcpControlClients(): Promise<void> {
  const active = [...sharedControlClients.values()];
  sharedControlClients.clear();
  await Promise.all(active.map((shared) => closeSharedControlClient(shared)));
}

export const defaultMcpDeps: McpDeps = {
  canonicalizeProjectRoot,
  controlClientForRoot: (projectRoot) => createMcpControlClientForRoot(projectRoot, {
    ...(mcpRunOptions.taskBinding ? { taskBinding: { ...mcpRunOptions.taskBinding } } : {}),
  }),
  async listRitualsForRoot(projectRoot) {
    return {
      builtin: getBuiltInRituals().map((ritual) => ({ ...ritual, scope: 'builtin' as const })),
      project: listProjectRituals(projectRoot).map((ritual) => ({ ...ritual, scope: 'project' as const })),
    };
  },
  listWorktreesForRoot: readWorktrees,
  now: () => new Date(),
  randomId: randomUUID,
};

let deps: McpDeps = defaultMcpDeps;

/** Test seam. Returns a restore function. */
export function setMcpDeps(next: Partial<McpDeps>): () => void {
  const previous = deps;
  deps = { ...deps, ...next };
  return () => { deps = previous; };
}

export async function parseMcpArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  launchCwd: string = process.cwd(),
  canonicalize: typeof canonicalizeProjectRoot = canonicalizeProjectRoot,
): Promise<McpRunOptions> {
  let cliTaskId: string | undefined;
  let hasCliTaskId = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--task-id') continue;
    const value = argv[index + 1];
    if (value === undefined) throw new TypeError('--task-id requires a value');
    hasCliTaskId = true;
    cliTaskId = value;
    index += 1;
  }

  const hasEnvTaskId = Object.hasOwn(env, 'PSYCHE_CONTROL_TASK_ID');
  const hasEnvToken = Object.hasOwn(env, 'PSYCHE_CONTROL_TASK_TOKEN');
  if (!hasCliTaskId && !hasEnvTaskId && !hasEnvToken) return {};

  const credential = validateMcpTaskCredential({
    taskId: hasCliTaskId ? cliTaskId : env.PSYCHE_CONTROL_TASK_ID,
    token: env.PSYCHE_CONTROL_TASK_TOKEN,
  });
  if (credential === undefined) return {};

  const canonicalProjectRoot = await canonicalize(
    env.PSYCHE_PROJECT_ROOT ?? launchCwd,
  );
  return {
    taskBinding: {
      ...credential,
      canonicalProjectRoot,
    },
  };
}

export function validateMcpTaskBinding(binding: {
  taskId?: unknown;
  token?: unknown;
  subjectId?: unknown;
  canonicalProjectRoot?: unknown;
} | undefined): McpTaskBinding | undefined {
  const credential = validateMcpTaskCredential(binding);
  if (credential === undefined) return undefined;

  let subjectId: string | undefined;
  if (binding?.subjectId !== undefined) {
    if (typeof binding.subjectId !== 'string' || binding.subjectId.trim().length === 0) {
      throw new TypeError('task-bound MCP subject id must be non-blank');
    }
    if (binding.subjectId !== binding.subjectId.trim()) {
      throw new TypeError('task-bound MCP subject id must not contain surrounding whitespace');
    }
    subjectId = binding.subjectId;
  }

  let canonicalProjectRoot: string | undefined;
  if (binding?.canonicalProjectRoot !== undefined) {
    if (
      typeof binding.canonicalProjectRoot !== 'string'
      || binding.canonicalProjectRoot.length === 0
    ) {
      throw new TypeError('task-bound MCP requires a canonical launch project root');
    }
    canonicalProjectRoot = binding.canonicalProjectRoot;
  }

  return {
    ...credential,
    ...(subjectId === undefined ? {} : { subjectId }),
    ...(canonicalProjectRoot === undefined ? {} : { canonicalProjectRoot }),
  };
}

function validateMcpTaskCredential(binding: {
  taskId?: unknown;
  token?: unknown;
} | undefined): Pick<McpTaskBinding, 'taskId' | 'token'> | undefined {
  if (binding === undefined) return undefined;
  const taskId = normalizeControlTaskId(binding.taskId);
  if (taskId === undefined) {
    if (binding.taskId === undefined && binding.token === undefined) return undefined;
    throw new TypeError(
      `MCP task ID must be non-blank and at most ${MAX_CONTROL_TASK_ID_LENGTH} characters`,
    );
  }
  if (typeof binding.token !== 'string' || binding.token.trim().length === 0) {
    throw new TypeError('task-bound MCP requires a task token');
  }
  if (binding.token !== binding.token.trim()) {
    throw new TypeError('task-bound MCP task token must not contain surrounding whitespace');
  }
  return { taskId, token: binding.token };
}

async function canonicalizeMcpProjectRoot(
  projectRoot: string,
  taskProjectRoot: string | undefined,
  canonicalize: typeof canonicalizeProjectRoot,
  alreadyCanonicalized = false,
): Promise<string> {
  const canonicalRoot = alreadyCanonicalized ? projectRoot : await canonicalize(projectRoot);
  if (
    taskProjectRoot !== undefined
    && canonicalRoot !== taskProjectRoot
  ) {
    throw new ControlResponseError(
      'task_project_mismatch',
      'task_project_mismatch: requested project does not match task launch project',
    );
  }
  return canonicalRoot;
}

async function resolveProjectRoot(args: Record<string, unknown>): Promise<string> {
  const raw = args.project_root ?? args.projectRoot;
  const requestedRoot = typeof raw === 'string' && raw.trim()
    ? raw
    : process.env.PSYCHE_PROJECT_ROOT ?? process.cwd();
  if (deps.taskProjectRoot === undefined) return requestedRoot;
  return canonicalizeMcpProjectRoot(
    requestedRoot,
    deps.taskProjectRoot,
    deps.canonicalizeProjectRoot,
  );
}

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: ERR_INVALID_PARAMS });
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) invalid(`requires \`${key}\``);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requiredPositiveInteger(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(`requires positive integer \`${key}\``);
  return value as number;
}

function suppliedTaskId(args: Record<string, unknown>): string | undefined {
  if (!Object.hasOwn(args, 'task_id')) return undefined;
  const taskId = normalizeControlTaskId(args.task_id);
  if (taskId === undefined) {
    invalid(`requires non-blank \`task_id\` of at most ${MAX_CONTROL_TASK_ID_LENGTH} characters`);
  }
  return taskId;
}

type TaskScopedMode = 'read' | 'mutation';

interface TaskScopedAccessOptions {
  mode: TaskScopedMode;
  requireTaskId?: boolean;
  requireLease?: boolean;
}

interface TaskScopedAccess {
  requestedTaskId?: string;
  taskId?: string;
  scope: ControlSnapshotScope;
  authorization?: {
    taskId: string;
    leaseId: string;
    leaseRevision: number;
  };
}

type TaskScopedAccessResult = TaskScopedAccess | { outcome: CommandOutcome };

interface TaskScopedToolContext extends TaskScopedAccess {
  client: McpControlClient;
  requestedRoot: string;
  projectRoot: string;
}

function resolveLeaseAuthorization(
  taskId: string | undefined,
  args: Record<string, unknown>,
): {
  taskId: string;
  leaseId: string;
  leaseRevision: number;
} | undefined {
  if (
    !taskId
    || typeof args.lease_id !== 'string' || !args.lease_id.trim()
    || !Number.isSafeInteger(args.lease_revision) || (args.lease_revision as number) < 1
  ) return undefined;
  return {
    taskId,
    leaseId: args.lease_id.trim(),
    leaseRevision: args.lease_revision as number,
  };
}

function taskBindingRequired(): CommandOutcome {
  return {
    status: 'rejected',
    code: 'task_binding_required',
    message: 'task-bound credentials are required for agent surface commands',
  };
}

function leaseMissing(): CommandOutcome {
  return {
    status: 'rejected',
    code: 'lease_missing',
    message: 'a bound task or explicit `task_id`, plus `lease_id` and `lease_revision`, are required for this surface operation',
  };
}

function resolveTaskScopedAccess(
  client: Pick<McpControlClient, 'principal' | 'taskBinding'>,
  args: Record<string, unknown>,
  options: TaskScopedAccessOptions,
): TaskScopedAccessResult {
  const requestedTaskId = suppliedTaskId(args);
  const boundTaskId = client.taskBinding?.taskId;
  if (boundTaskId) {
    if (requestedTaskId && requestedTaskId !== boundTaskId) {
      invalid('task_binding_mismatch: supplied `task_id` does not match bound task');
    }
    return finalize(boundTaskId, requestedTaskId, options.requireLease === true, args);
  }
  const principalKind = client.principal?.kind ?? 'operator';
  if (options.mode === 'mutation' && principalKind !== 'operator') return { outcome: taskBindingRequired() };
  if (options.requireTaskId && !requestedTaskId) invalid('requires `task_id`');
  const taskId = principalKind === 'operator' ? requestedTaskId : undefined;
  return finalize(taskId, requestedTaskId, options.requireLease === true, args);
}

function finalize(
  taskId: string | undefined,
  requestedTaskId: string | undefined,
  requireLease: boolean,
  args: Record<string, unknown>,
): TaskScopedAccessResult {
  const scope = taskId ? { taskId } : {};
  if (!requireLease) return { requestedTaskId, taskId, scope };
  const authorization = resolveLeaseAuthorization(taskId, args);
  if (!authorization) return { outcome: leaseMissing() };
  return { requestedTaskId, taskId, scope, authorization };
}

function hasOutcome(result: TaskScopedAccessResult): result is { outcome: CommandOutcome } {
  return 'outcome' in result;
}

async function withTaskScopedControl<T>(
  args: Record<string, unknown>,
  options: TaskScopedAccessOptions,
  operation: (context: TaskScopedToolContext) => Promise<T>,
): Promise<T | CommandOutcome> {
  const requestedRoot = await resolveProjectRoot(args);
  return withControlClient(requestedRoot, async (client) => {
    const resolved = resolveTaskScopedAccess(client, args, options);
    if (hasOutcome(resolved)) return resolved.outcome;
    const projectRoot = client.projectRoot ?? requestedRoot;
    return operation({
      client,
      requestedRoot,
      projectRoot,
      ...resolved,
    });
  });
}

function command(
  kind: ControlCommandInput['kind'],
  projectRoot: string,
  payload: unknown,
): ControlCommandInput {
  const id = deps.randomId();
  return {
    id,
    idempotencyKey: `mcp:${id}`,
    kind,
    projectRoot,
    createdAt: deps.now().toISOString(),
    payload,
  } as ControlCommandInput;
}

async function withControlClient<T>(
  projectRoot: string,
  operation: (client: McpControlClient) => Promise<T>,
): Promise<T> {
  const client = await deps.controlClientForRoot(projectRoot);
  try {
    return await operation(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function actionResult(outcome: CommandOutcome): ActionReceipt | CommandOutcome {
  if (outcome.status === 'succeeded' && isActionReceipt(outcome.value)) return outcome.value;
  return outcome;
}

const projectRootProperty = {
  type: 'string',
  description: 'Absolute project root. Defaults to PSYCHE_PROJECT_ROOT, then the current directory.',
};
const taskIdProperty = {
  type: 'string',
  description: 'Optional compatibility field. Task-bound MCP clients resolve omitted values from the authenticated binding, accept exact matches, and reject conflicts before any read or command. An unbound non-operator caller cannot authorize access with `task_id` alone.',
};
const authorizationProperties = {
  task_id: taskIdProperty,
  lease_id: { type: 'string' },
  lease_revision: { type: 'integer', minimum: 1 },
};
const authorizationRequired = ['lease_id', 'lease_revision'];
const taskScopedReadProperties = {
  task_id: taskIdProperty,
  project_root: projectRootProperty,
};

export const TOOLS: ToolDef[] = [
  {
    name: 'psyche_control_list',
    description: 'List the bounded pane and browser resources and approvals visible to this connection.',
    inputSchema: { type: 'object', properties: taskScopedReadProperties },
    handler: async (args) => withTaskScopedControl(args, { mode: 'read' }, async ({
      client,
      projectRoot,
      scope,
    }) => {
      const snapshot = await client.getState(scope);
      return {
        project_root: projectRoot,
        owner_epoch: snapshot.ownerEpoch,
        sequence: snapshot.sequence,
        resources: snapshot.resources,
        approvals: snapshot.approvals,
      };
    }),
  },
  {
    name: 'psyche_control_lease',
    description: 'Request, inspect, or release agent surface authority. This tool cannot grant, expand, or approve authority.',
    inputSchema: {
      type: 'object',
      required: ['operation'],
      properties: {
        operation: { type: 'string', enum: ['request', 'status', 'release'] },
        task_id: taskIdProperty,
        request_id: { type: 'string' },
        lease_id: { type: 'string' },
        lease_revision: { type: 'integer', minimum: 1 },
        ttl_ms: { type: 'integer', minimum: 1 },
        grants: { type: 'array', minItems: 1 },
        project_root: projectRootProperty,
      },
    },
    handler: async (args) => {
      const operation = requiredString(args, 'operation');
      if (!['request', 'status', 'release'].includes(operation)) {
        invalid('psyche_control_lease supports only request, status, and release');
      }
      if (operation === 'status') {
        return withTaskScopedControl(args, { mode: 'read', requireTaskId: true }, async ({
          client,
          requestedTaskId,
          taskId,
          scope,
        }) => {
          const requestId = requiredString(args, 'request_id');
          const snapshot = await client.getState(scope);
          const scopedTaskId = taskId ?? requestedTaskId;
          const leaseId = optionalString(args, 'lease_id');
          return {
            leases: snapshot.capabilityLeases.filter((lease) => (
              (!scopedTaskId || lease.taskId === scopedTaskId)
              && lease.requestId === requestId
              && (!leaseId || lease.id === leaseId)
            )),
            requests: snapshot.leaseRequests.filter((request) => (
              (!scopedTaskId || request.taskId === scopedTaskId)
              && request.id === requestId
            )),
          };
        });
      }
      if (operation === 'release') {
        return withTaskScopedControl(args, {
          mode: 'mutation',
          requireLease: true,
        }, async ({ client, projectRoot, authorization }) => (
          client.submit(command('lease.release', projectRoot, authorization!))
        ));
      }
      return withTaskScopedControl(args, { mode: 'mutation', requireTaskId: true }, async ({
        client,
        projectRoot,
        taskId,
      }) => {
        if (!Array.isArray(args.grants) || args.grants.length === 0) invalid('lease request requires `grants`');
        const grants = args.grants as CapabilityLeaseGrantItem[];
        return client.submit(command('lease.request', projectRoot, {
          taskId: taskId!,
          ttlMs: requiredPositiveInteger(args, 'ttl_ms'),
          grants,
        }));
      });
    },
  },
  {
    name: 'psyche_pane_observe',
    description: 'Read bounded pane output and status through an exact leased pane generation.',
    inputSchema: {
      type: 'object',
      required: [...authorizationRequired, 'pane_id', 'generation'],
      properties: {
        ...authorizationProperties,
        pane_id: { type: 'string' }, generation: { type: 'integer', minimum: 1 },
        after_sequence: { type: 'integer', minimum: 0 }, project_root: projectRootProperty,
      },
    },
    handler: async (args) => withTaskScopedControl(args, {
      mode: 'mutation',
      requireLease: true,
    }, async ({ client, projectRoot, authorization }) => (
      actionResult(await client.submit(command('pane.observe', projectRoot, {
        ...authorization!,
        paneId: requiredString(args, 'pane_id'),
        generation: requiredPositiveInteger(args, 'generation'),
        ...(Number.isSafeInteger(args.after_sequence) ? { afterSequence: args.after_sequence as number } : {}),
      })))
    )),
  },
  {
    name: 'psyche_pane_action',
    description: 'Perform one typed pane action through an exact capability lease.',
    inputSchema: {
      type: 'object',
      required: [...authorizationRequired, 'action'],
      properties: {
        ...authorizationProperties,
        pane_id: { type: 'string' }, generation: { type: 'integer', minimum: 1 },
        project_id: { type: 'string' }, action: { type: 'object' }, project_root: projectRootProperty,
      },
    },
    handler: async (args) => withTaskScopedControl(args, {
      mode: 'mutation',
      requireLease: true,
    }, async ({ client, projectRoot, authorization }) => {
      if (!args.action || typeof args.action !== 'object' || Array.isArray(args.action)) invalid('requires `action`');
      const action = args.action as Record<string, unknown>;
      const payload = action.kind === 'create'
        ? { ...authorization!, projectId: requiredString(args, 'project_id'), action }
        : {
            ...authorization!,
            paneId: requiredString(args, 'pane_id'),
            generation: requiredPositiveInteger(args, 'generation'),
            action,
          };
      return actionResult(await client.submit(command('pane.action', projectRoot, payload as never)));
    }),
  },
  {
    name: 'psyche_browser_inspect',
    description: 'Capture a bounded semantic snapshot of an exact leased browser tab generation.',
    inputSchema: {
      type: 'object',
      required: [...authorizationRequired, 'tab_id', 'generation'],
      properties: {
        ...authorizationProperties,
        tab_id: { type: 'string' }, generation: { type: 'integer', minimum: 1 },
        include_screenshot: { type: 'boolean' }, project_root: projectRootProperty,
      },
    },
    handler: async (args) => withTaskScopedControl(args, {
      mode: 'mutation',
      requireLease: true,
    }, async ({ client, projectRoot, authorization }) => (
      actionResult(await client.submit(command('browser.inspect', projectRoot, {
        ...authorization!,
        tabId: requiredString(args, 'tab_id'),
        generation: requiredPositiveInteger(args, 'generation'),
        ...(args.include_screenshot === true ? { includeScreenshot: true } : {}),
      })))
    )),
  },
  {
    name: 'psyche_browser_action',
    description: 'Perform one typed browser action through an exact leased tab generation. Application-defined effects behind a generic click cannot be perfectly predicted.',
    inputSchema: {
      type: 'object',
      required: [...authorizationRequired, 'tab_id', 'generation', 'action'],
      properties: {
        ...authorizationProperties,
        tab_id: { type: 'string' }, generation: { type: 'integer', minimum: 1 },
        snapshot_id: { type: 'string' }, action: { type: 'object' }, project_root: projectRootProperty,
      },
    },
    handler: async (args) => withTaskScopedControl(args, {
      mode: 'mutation',
      requireLease: true,
    }, async ({ client, projectRoot, authorization }) => {
      if (!args.action || typeof args.action !== 'object' || Array.isArray(args.action)) invalid('requires `action`');
      return actionResult(await client.submit(command('browser.action', projectRoot, {
        ...authorization!,
        tabId: requiredString(args, 'tab_id'),
        generation: requiredPositiveInteger(args, 'generation'),
        ...(typeof args.snapshot_id === 'string' ? { snapshotId: args.snapshot_id } : {}),
        action: args.action,
      } as never)));
    }),
  },
  {
    name: 'psyche_browser_script',
    description: 'Run an explicitly approved script in an exact leased browser tab generation.',
    inputSchema: {
      type: 'object',
      required: [...authorizationRequired, 'tab_id', 'generation', 'source'],
      properties: {
        ...authorizationProperties,
        tab_id: { type: 'string' }, generation: { type: 'integer', minimum: 1 },
        source: { type: 'string' }, args: {}, project_root: projectRootProperty,
      },
    },
    handler: async (args) => withTaskScopedControl(args, {
      mode: 'mutation',
      requireLease: true,
    }, async ({ client, projectRoot, authorization }) => {
      let scriptArgs: unknown;
      if ('args' in args) {
        try {
          scriptArgs = canonicalizeBoundedJson(args.args, {
            maxBytes: AGENT_CONTROL_LIMITS.scriptResultBytes,
            invalidCode: 'invalid_browser_script_arguments',
            sizeCode: 'invalid_browser_script_arguments',
            label: 'browser script arguments',
          }).value;
        } catch { invalid('requires bounded plain JSON `args`'); }
      }
      return actionResult(await client.submit(command('browser.script', projectRoot, {
        ...authorization!,
        tabId: requiredString(args, 'tab_id'),
        generation: requiredPositiveInteger(args, 'generation'),
        source: requiredString(args, 'source'),
        ...('args' in args ? { args: scriptArgs } : {}),
      })));
    }),
  },
  {
    name: 'psyche_control_action_status',
    description: 'Read the latest live or replay receipt for an action without retrying the action.',
    inputSchema: {
      type: 'object',
      required: ['action_id'],
      properties: { action_id: { type: 'string' }, ...taskScopedReadProperties },
    },
    handler: async (args) => {
      const actionId = requiredString(args, 'action_id');
      return withTaskScopedControl(args, { mode: 'read' }, async ({ client, scope }) => (
        (await client.actionStatus(actionId, scope))
          ?? { status: 'unknown', action_id: actionId }
      ));
    },
  },
  {
    name: 'psyche_list_panes',
    description: 'Compatibility alias for listing pane resources visible to this connection.',
    inputSchema: { type: 'object', properties: taskScopedReadProperties },
    handler: async (args) => withTaskScopedControl(args, { mode: 'read' }, async ({
      client,
      projectRoot,
      scope,
    }) => {
      const snapshot = await client.getState(scope);
      const panes = snapshot.resources.filter((resource) => resource.kind === 'pane');
      return { project_root: projectRoot, count: panes.length, panes };
    }),
  },
  {
    name: 'psyche_execute_task',
    description: 'Compatibility alias that submits leased orchestration to the project control owner.',
    inputSchema: {
      type: 'object', required: ['prompt', 'lanes', ...authorizationRequired],
      properties: {
        prompt: { type: 'string' }, lanes: { type: 'array', minItems: 1 },
        ...authorizationProperties,
        concurrency: { type: 'integer', minimum: 1 }, branch: { type: 'string' }, project_root: projectRootProperty,
      },
    },
    handler: async (args) => withTaskScopedControl(args, {
      mode: 'mutation',
      requireLease: true,
    }, async ({ client, projectRoot, authorization }) => {
      const prompt = requiredString(args, 'prompt');
      if (!Array.isArray(args.lanes) || args.lanes.length === 0) invalid('requires at least one lane');
      const request: OrchestrationTaskRequest = {
        taskId: authorization!.taskId,
        projectRoot,
        prompt,
        lanes: args.lanes as OrchestrationTaskRequest['lanes'],
        ...(typeof args.branch === 'string' ? { startPointBranch: args.branch } : {}),
        ...(typeof args.concurrency === 'number' ? { concurrency: args.concurrency } : {}),
      };
      return client.submit(command('orchestration.execute', projectRoot, { ...authorization!, request }));
    }),
  },
  {
    name: 'psyche_create_pane',
    description: 'Compatibility alias for leased pane creation through the project control owner.',
    inputSchema: {
      type: 'object', required: ['prompt', 'agent', ...authorizationRequired],
      properties: {
        prompt: { type: 'string' }, agent: { type: 'string' }, branch: { type: 'string' },
        title: { type: 'string' }, ...authorizationProperties, project_root: projectRootProperty,
      },
    },
    handler: async (args) => withTaskScopedControl(args, {
      mode: 'mutation',
      requireLease: true,
    }, async ({ client, projectRoot, authorization }) => (
      actionResult(await client.submit(command('pane.action', projectRoot, {
        ...authorization!,
        projectId: projectRoot,
        action: {
          kind: 'create', cwd: projectRoot,
          agent: requiredString(args, 'agent'), prompt: requiredString(args, 'prompt'),
          ...(typeof args.branch === 'string' ? { branch: args.branch } : {}),
          ...(typeof args.title === 'string' ? { title: args.title } : {}),
        } as never,
      })))
    )),
  },
  {
    name: 'psyche_kill_pane',
    description: 'Compatibility alias for approved pane close. It does NOT delete the worktree or branch.',
    inputSchema: {
      type: 'object', required: ['pane_id', 'generation', ...authorizationRequired],
      properties: {
        pane_id: { type: 'string' }, generation: { type: 'integer', minimum: 1 },
        ...authorizationProperties, project_root: projectRootProperty,
      },
    },
    handler: async (args) => withTaskScopedControl(args, {
      mode: 'mutation',
      requireLease: true,
    }, async ({ client, projectRoot, authorization }) => (
      actionResult(await client.submit(command('pane.action', projectRoot, {
        ...authorization!,
        paneId: requiredString(args, 'pane_id'),
        generation: requiredPositiveInteger(args, 'generation'),
        action: { kind: 'close' },
      })))
    )),
  },
  {
    name: 'psyche_get_pane_output',
    description: 'Compatibility alias for bounded leased pane observation.',
    inputSchema: {
      type: 'object', required: ['pane_id', 'generation', ...authorizationRequired],
      properties: {
        pane_id: { type: 'string' }, generation: { type: 'integer', minimum: 1 },
        after_sequence: { type: 'integer', minimum: 0 }, ...authorizationProperties,
        project_root: projectRootProperty,
      },
    },
    handler: async (args) => withTaskScopedControl(args, {
      mode: 'mutation',
      requireLease: true,
    }, async ({ client, projectRoot, authorization }) => (
      actionResult(await client.submit(command('pane.observe', projectRoot, {
        ...authorization!,
        paneId: requiredString(args, 'pane_id'),
        generation: requiredPositiveInteger(args, 'generation'),
        ...(Number.isSafeInteger(args.after_sequence) ? { afterSequence: args.after_sequence as number } : {}),
      })))
    )),
  },
  {
    name: 'psyche_list_rituals',
    description: 'List built-in and project rituals without mutating the host.',
    inputSchema: { type: 'object', properties: { project_root: projectRootProperty } },
    handler: async (args) => {
      const projectRoot = await resolveProjectRoot(args);
      const rituals = await deps.listRitualsForRoot(projectRoot);
      return {
        project_root: projectRoot,
        ...rituals,
        count: rituals.builtin.length + rituals.project.length,
      };
    },
  },
  {
    name: 'psyche_list_worktrees',
    description: 'List git worktrees for the project without mutating the host.',
    inputSchema: { type: 'object', properties: { project_root: projectRootProperty } },
    handler: async (args) => {
      const projectRoot = await resolveProjectRoot(args);
      const worktrees = await deps.listWorktreesForRoot(projectRoot);
      return { project_root: projectRoot, count: worktrees.length, worktrees };
    },
  },
];

async function handleInitialize(): Promise<unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    capabilities: { tools: { listChanged: false } },
  };
}

async function handleToolsList(): Promise<unknown> {
  return {
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  };
}

async function handleToolsCall(params: unknown): Promise<unknown> {
  const parsed = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
  if (!parsed.name || typeof parsed.name !== 'string') invalid('tools/call requires `name`');
  const tool = TOOLS.find((candidate) => candidate.name === parsed.name);
  if (!tool) throw Object.assign(new Error(`Unknown tool: ${parsed.name}`), { code: ERR_METHOD_NOT_FOUND });
  const result = await tool.handler(parsed.arguments ?? {});
  return {
    content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
  };
}

export async function handleMcpRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  try {
    let result: unknown;
    switch (req.method) {
      case 'initialize': result = await handleInitialize(); break;
      case 'notifications/initialized': return null;
      case 'tools/list': result = await handleToolsList(); break;
      case 'tools/call': result = await handleToolsCall(req.params); break;
      case 'ping': result = {}; break;
      default:
        return { jsonrpc: '2.0', id, error: { code: ERR_METHOD_NOT_FOUND, message: `Method not found: ${req.method}` } };
    }
    return { jsonrpc: '2.0', id, result };
  } catch (error) {
    if (error instanceof ControlResponseError) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: MCP_CONTROL_ERROR_CODE,
          message: error.message,
          data: { code: error.code },
        },
      };
    }
    const code = (error as { code?: number }).code ?? ERR_INTERNAL;
    const message = error instanceof Error ? error.message : String(error);
    return { jsonrpc: '2.0', id, error: { code, message } };
  }
}

async function dispatch(request: JsonRpcRequest): Promise<void> {
  const response = await handleMcpRequest(request);
  if (response) writeResponse(response);
}

export async function runMcpServer(
  options?: McpRunOptions,
): Promise<void> {
  const resolvedOptions = options ?? await parseMcpArgs(process.argv.slice(3), process.env);
  const previousRunOptions = mcpRunOptions;
  const restore = resolvedOptions.taskBinding?.canonicalProjectRoot === undefined
    ? undefined
    : setMcpDeps({
        taskProjectRoot: resolvedOptions.taskBinding.canonicalProjectRoot,
      });
  mcpRunOptions = resolvedOptions.taskBinding
    ? { taskBinding: { ...resolvedOptions.taskBinding } }
    : {};
  const lines = createInterface({ input: process.stdin, terminal: false });
  lines.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      fail(null, ERR_PARSE, 'Parse error: stdin is not valid JSON');
      return;
    }
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      fail(request.id ?? null, ERR_INVALID_REQUEST, 'Invalid JSON-RPC 2.0 request');
      return;
    }
    void dispatch(request);
  });
  try {
    await new Promise<void>((resolve) => { lines.on('close', resolve); });
  } finally {
    restore?.();
    mcpRunOptions = previousRunOptions;
    await closeMcpControlClients();
  }
}

async function readWorktrees(projectRoot: string): Promise<readonly WorktreeSummary[]> {
  const raw = await new Promise<string>((resolve, reject) => {
    execFile('git', ['-C', projectRoot, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8', timeout: 5_000,
    }, (error, stdout) => {
      if (error) reject(Object.assign(new Error(`git worktree list failed: ${error.message}`), { code: ERR_INTERNAL }));
      else resolve(stdout);
    });
  });
  const worktrees: WorktreeSummary[] = [];
  let current: WorktreeSummary | undefined;
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push(current);
      current = { path: line.slice('worktree '.length) };
    } else if (current && line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length);
    else if (current && line.startsWith('branch ')) current.branch = line.slice('branch '.length);
    else if (current && line === 'bare') current.bare = true;
    else if (current && line === 'detached') current.detached = true;
    else if (current && line.startsWith('locked')) current.locked = true;
  }
  if (current) worktrees.push(current);
  return worktrees;
}
