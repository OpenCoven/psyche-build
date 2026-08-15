/** psyche MCP server (newline-delimited JSON-RPC 2.0 over stdio). */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { ControlClient } from '../control/client.js';
import {
  createControlCredentialStoreForCanonicalRoot,
  type ControlCredentialStore,
  type ControlTaskBinding,
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
import type {
  ActionReceipt,
  CommandOutcome,
  ControlCommandInput,
  ControlSnapshot,
} from '../control/types.js';
import type {
  LeaseStatusResultData,
  TaskResourcesResultData,
} from '../control/protocol.js';
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
const UNBOUND_MCP_TASK_ID = 'unbound-mcp-client';

export interface McpTaskBinding {
  taskId: string;
  token: string;
}

export interface McpRunOptions {
  taskBinding?: McpTaskBinding;
}

export function parseMcpArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): McpRunOptions {
  let cliTaskId: string | undefined;
  let hasCliTaskId = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--task-id') continue;
    const value = args[index + 1];
    if (value === undefined) throw new TypeError('--task-id requires a value');
    hasCliTaskId = true;
    cliTaskId = value;
    index += 1;
  }

  const hasEnvTaskId = Object.hasOwn(env, 'PSYCHE_CONTROL_TASK_ID');
  const hasEnvToken = Object.hasOwn(env, 'PSYCHE_CONTROL_TASK_TOKEN');
  if (!hasCliTaskId && !hasEnvTaskId && !hasEnvToken) return {};

  const taskBinding = validateMcpTaskBinding({
    taskId: hasCliTaskId ? cliTaskId : env.PSYCHE_CONTROL_TASK_ID,
    token: env.PSYCHE_CONTROL_TASK_TOKEN,
  });
  return taskBinding === undefined ? {} : { taskBinding };
}

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
  readonly taskBinding?: ControlTaskBinding;
  submit(command: ControlCommandInput): Promise<CommandOutcome>;
  getState(): Promise<ControlSnapshot>;
  taskResources(): Promise<TaskResourcesResultData>;
  leaseStatus(leaseRequestId: string, leaseId?: string): Promise<LeaseStatusResultData>;
  actionStatus(actionId: string): Promise<ActionReceipt | undefined>;
  close(): Promise<void>;
}

export interface McpDeps {
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
  canonicalize?: typeof canonicalizeProjectRoot;
  credentialStoreForCanonicalRoot?: (options: {
    canonicalProjectRoot: string;
  }) => Promise<ControlCredentialStore>;
  connect?: ConnectControl;
  spawn?: EnsureHostOptions['spawn'];
  now?: EnsureHostOptions['now'];
  sleep?: EnsureHostOptions['sleep'];
  entryPath?: string;
  taskBinding?: McpTaskBinding;
}

interface SharedControlClient {
  key: string;
  canonicalRoot: string;
  taskBinding?: ControlTaskBinding;
  refs: number;
  promise: Promise<ControlClient>;
  closePromise?: Promise<void>;
}

const sharedControlClients = new Map<string, SharedControlClient>();
const controlStartupFlights = new Map<string, Promise<ControlClient>>();

export async function createMcpControlClientForRoot(
  projectRoot: string,
  options: McpControlClientBootstrapOptions = {},
): Promise<McpControlClient> {
  const authenticatedBinding = validateMcpTaskBinding(options.taskBinding);
  const canonicalRoot = await (options.canonicalize ?? canonicalizeProjectRoot)(projectRoot);
  const endpoint = controlEndpointForProject(canonicalRoot);
  const taskBinding = authenticatedBinding === undefined
    ? undefined
    : { taskId: authenticatedBinding.taskId };
  const key = JSON.stringify([
    canonicalRoot,
    endpoint,
    taskBinding === undefined ? ['unbound'] : ['task', taskBinding.taskId],
  ]);
  let shared = sharedControlClients.get(key);
  if (!shared) {
    let startup = controlStartupFlights.get(key);
    if (!startup) {
      startup = startMcpControlClient(canonicalRoot, options, authenticatedBinding);
      controlStartupFlights.set(key, startup);
      void startup.finally(() => {
        if (controlStartupFlights.get(key) === startup) controlStartupFlights.delete(key);
      }).catch(() => undefined);
    }
    shared = { key, canonicalRoot, taskBinding, refs: 0, promise: startup };
    sharedControlClients.set(key, shared);
    void startup.catch(() => {
      if (sharedControlClients.get(key) === shared) sharedControlClients.delete(key);
    });
  }
  shared.refs += 1;
  try {
    await shared.promise;
  } catch (error) {
    shared.refs -= 1;
    throw error;
  }
  return borrowedControlClient(shared);
}

async function startMcpControlClient(
  canonicalRoot: string,
  options: McpControlClientBootstrapOptions,
  binding: McpTaskBinding | undefined,
): Promise<ControlClient> {
  let token: string;
  if (binding === undefined) {
    const credentials = await (
      options.credentialStoreForCanonicalRoot ?? createControlCredentialStoreForCanonicalRoot
    )({ canonicalProjectRoot: canonicalRoot });
    token = await credentials.agentToken();
  } else {
    token = binding.token;
  }
  return ensureCanonicalHostControlPlane(canonicalRoot, {
    token, clientName: 'psyche-mcp', entryPath: options.entryPath ?? entryPath,
    ...(binding === undefined ? {} : { taskBinding: { taskId: binding.taskId } }),
    ...(options.connect === undefined ? {} : { connect: options.connect }),
    ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
}

function validateMcpTaskBinding(binding: {
  taskId?: unknown;
  token?: unknown;
} | undefined): McpTaskBinding | undefined {
  if (binding === undefined) return undefined;
  const taskId = normalizeControlTaskId(binding.taskId);
  if (taskId === undefined) {
    throw new TypeError(
      `MCP task ID must be non-blank and at most ${MAX_CONTROL_TASK_ID_LENGTH} characters`,
    );
  }
  if (typeof binding.token !== 'string' || binding.token.trim().length === 0) {
    throw new TypeError('task-bound MCP requires a task token');
  }
  return { taskId, token: binding.token };
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
    taskBinding: shared.taskBinding,
    submit: (command) => use((client) => client.submit(command)),
    getState: () => use((client) => client.getState()),
    taskResources: () => use((client) => client.taskResources()),
    leaseStatus: (requestId, leaseId) => (
      use((client) => client.leaseStatus(requestId, leaseId))
    ),
    actionStatus: (actionId) => use((client) => client.actionStatus(actionId)),
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
  controlClientForRoot: createMcpControlClientForRoot,
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

function resolveProjectRoot(args: Record<string, unknown>): string {
  const raw = args.project_root ?? args.projectRoot;
  if (typeof raw === 'string' && raw.trim()) return raw;
  return process.env.PSYCHE_PROJECT_ROOT ?? process.cwd();
}

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: ERR_INVALID_PARAMS });
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) invalid(`requires \`${key}\``);
  return value.trim();
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

function taskIdForClient(
  client: McpControlClient,
  args: Record<string, unknown>,
): string {
  const supplied = suppliedTaskId(args);
  const authenticated = client.taskBinding?.taskId;
  if (authenticated !== undefined && supplied !== undefined && supplied !== authenticated) {
    invalid('supplied `task_id` does not match the authenticated task binding');
  }
  return authenticated ?? UNBOUND_MCP_TASK_ID;
}

function leaseAuthorization(
  args: Record<string, unknown>,
  client: McpControlClient,
): {
  taskId: string;
  leaseId: string;
  leaseRevision: number;
} | undefined {
  const taskId = taskIdForClient(client, args);
  if (
    typeof args.lease_id !== 'string' || !args.lease_id.trim()
    || !Number.isSafeInteger(args.lease_revision) || (args.lease_revision as number) < 1
  ) return undefined;
  return {
    taskId,
    leaseId: args.lease_id.trim(),
    leaseRevision: args.lease_revision as number,
  };
}

function leaseMissing(): CommandOutcome {
  return {
    status: 'rejected',
    code: 'lease_missing',
    message: 'lease_id and lease_revision are required for this surface operation',
  };
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

async function submit(
  args: Record<string, unknown>,
  kind: ControlCommandInput['kind'],
  payload: unknown | ((client: McpControlClient) => unknown | CommandOutcome),
): Promise<CommandOutcome> {
  const requestedRoot = resolveProjectRoot(args);
  return withControlClient(requestedRoot, async (client) => {
    const resolved = typeof payload === 'function' ? payload(client) : payload;
    if (isCommandOutcome(resolved)) return resolved;
    return client.submit(command(kind, client.projectRoot ?? requestedRoot, resolved));
  });
}

function isCommandOutcome(value: unknown): value is CommandOutcome {
  return typeof value === 'object' && value !== null
    && ['rejected', 'succeeded', 'failed', 'unknown']
      .includes(String((value as { status?: unknown }).status));
}

function actionResult(outcome: CommandOutcome): ActionReceipt | CommandOutcome {
  if (
    outcome.status === 'succeeded'
    && outcome.value
    && typeof outcome.value === 'object'
    && (outcome.value as { schema?: unknown }).schema === 'psyche.control.receipt/v1'
  ) return outcome.value as ActionReceipt;
  return outcome;
}

const projectRootProperty = {
  type: 'string',
  description: 'Absolute project root. Defaults to PSYCHE_PROJECT_ROOT, then the current directory.',
};
const authorizationProperties = {
  task_id: { type: 'string' },
  lease_id: { type: 'string' },
  lease_revision: { type: 'integer', minimum: 1 },
};
const authorizationRequired = ['lease_id', 'lease_revision'];

export const TOOLS: ToolDef[] = [
  {
    name: 'psyche_control_list',
    description: 'List the bounded pane and browser resources and approvals owned by this project.',
    inputSchema: { type: 'object', properties: { project_root: projectRootProperty } },
    handler: async (args) => {
      const requestedRoot = resolveProjectRoot(args);
      return withControlClient(requestedRoot, async (client) => {
        const projectRoot = client.projectRoot ?? requestedRoot;
        const scoped = await client.taskResources();
        return {
          project_root: projectRoot,
          owner_epoch: scoped.ownerEpoch,
          sequence: scoped.sequence,
          resources: scoped.resources,
          approvals: [],
          receipts: [],
        };
      });
    },
  },
  {
    name: 'psyche_control_lease',
    description: 'Request, inspect, or release agent surface authority. This tool cannot grant, expand, or approve authority.',
    inputSchema: {
      type: 'object',
      required: ['operation'],
      properties: {
        operation: { type: 'string', enum: ['request', 'status', 'release'] },
        task_id: { type: 'string' },
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
      const projectRoot = resolveProjectRoot(args);
      return withControlClient(projectRoot, async (client) => {
        const canonicalRoot = client.projectRoot ?? projectRoot;
        const taskId = taskIdForClient(client, args);
        if (operation === 'status') {
          const requestId = requiredString(args, 'request_id');
          const leaseId = typeof args.lease_id === 'string' ? args.lease_id : undefined;
          return client.leaseStatus(requestId, leaseId);
        }
        if (operation === 'release') return client.submit(command('lease.release', canonicalRoot, {
          taskId,
          leaseId: requiredString(args, 'lease_id'),
          leaseRevision: requiredPositiveInteger(args, 'lease_revision'),
        }));
        if (!Array.isArray(args.grants) || args.grants.length === 0) invalid('lease request requires `grants`');
        const grants = args.grants as CapabilityLeaseGrantItem[];
        return client.submit(command('lease.request', canonicalRoot, {
          taskId, ttlMs: requiredPositiveInteger(args, 'ttl_ms'), grants,
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
    handler: async (args) => {
      return actionResult(await submit(args, 'pane.observe', (client: McpControlClient) => {
        const auth = leaseAuthorization(args, client);
        if (!auth) return leaseMissing();
        return {
          ...auth,
          paneId: requiredString(args, 'pane_id'),
          generation: requiredPositiveInteger(args, 'generation'),
          ...(Number.isSafeInteger(args.after_sequence) ? { afterSequence: args.after_sequence as number } : {}),
        };
      }));
    },
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
    handler: async (args) => {
      if (!args.action || typeof args.action !== 'object' || Array.isArray(args.action)) invalid('requires `action`');
      const action = args.action as Record<string, unknown>;
      return actionResult(await submit(args, 'pane.action', (client: McpControlClient) => {
        const auth = leaseAuthorization(args, client);
        if (!auth) return leaseMissing();
        return action.kind === 'create'
          ? { ...auth, projectId: requiredString(args, 'project_id'), action }
          : {
              ...auth,
              paneId: requiredString(args, 'pane_id'),
              generation: requiredPositiveInteger(args, 'generation'),
              action,
            };
      }));
    },
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
    handler: async (args) => {
      return actionResult(await submit(args, 'browser.inspect', (client: McpControlClient) => {
        const auth = leaseAuthorization(args, client);
        if (!auth) return leaseMissing();
        return {
          ...auth,
          tabId: requiredString(args, 'tab_id'),
          generation: requiredPositiveInteger(args, 'generation'),
          ...(args.include_screenshot === true ? { includeScreenshot: true } : {}),
        };
      }));
    },
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
    handler: async (args) => {
      if (!args.action || typeof args.action !== 'object' || Array.isArray(args.action)) invalid('requires `action`');
      return actionResult(await submit(args, 'browser.action', (client: McpControlClient) => {
        const auth = leaseAuthorization(args, client);
        if (!auth) return leaseMissing();
        return {
          ...auth,
          tabId: requiredString(args, 'tab_id'),
          generation: requiredPositiveInteger(args, 'generation'),
          ...(typeof args.snapshot_id === 'string' ? { snapshotId: args.snapshot_id } : {}),
          action: args.action,
        };
      }));
    },
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
    handler: async (args) => {
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
      return actionResult(await submit(args, 'browser.script', (client: McpControlClient) => {
        const auth = leaseAuthorization(args, client);
        if (!auth) return leaseMissing();
        return {
          ...auth,
          tabId: requiredString(args, 'tab_id'),
          generation: requiredPositiveInteger(args, 'generation'),
          source: requiredString(args, 'source'),
          ...('args' in args ? { args: scriptArgs } : {}),
        };
      }));
    },
  },
  {
    name: 'psyche_control_action_status',
    description: 'Read the latest canonical receipt for an action without retrying the action.',
    inputSchema: {
      type: 'object', required: ['action_id'],
      properties: { action_id: { type: 'string' }, project_root: projectRootProperty },
    },
    handler: async (args) => {
      const actionId = requiredString(args, 'action_id');
      return withControlClient(resolveProjectRoot(args), async (client) => (
        (await client.actionStatus(actionId)) ?? { status: 'unknown', action_id: actionId }
      ));
    },
  },
  {
    name: 'psyche_list_panes',
    description: 'Compatibility alias for listing pane resources through the project control owner.',
    inputSchema: { type: 'object', properties: { project_root: projectRootProperty } },
    handler: async (args) => {
      const requestedRoot = resolveProjectRoot(args);
      return withControlClient(requestedRoot, async (client) => {
        const projectRoot = client.projectRoot ?? requestedRoot;
        const scoped = await client.taskResources();
        const panes = scoped.resources.filter((resource) => resource.kind === 'pane');
        return { project_root: projectRoot, count: panes.length, panes };
      });
    },
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
    handler: async (args) => {
      const prompt = requiredString(args, 'prompt');
      if (!Array.isArray(args.lanes) || args.lanes.length === 0) invalid('requires at least one lane');
      const requestedRoot = resolveProjectRoot(args);
      return withControlClient(requestedRoot, (client) => {
        const auth = leaseAuthorization(args, client);
        if (!auth) return Promise.resolve(leaseMissing());
        const projectRoot = client.projectRoot ?? requestedRoot;
        const request: OrchestrationTaskRequest = {
          taskId: auth.taskId,
          projectRoot, prompt, lanes: args.lanes as OrchestrationTaskRequest['lanes'],
          ...(typeof args.branch === 'string' ? { startPointBranch: args.branch } : {}),
          ...(typeof args.concurrency === 'number' ? { concurrency: args.concurrency } : {}),
        };
        return client.submit(command('orchestration.execute', projectRoot, { ...auth, request }));
      });
    },
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
    handler: async (args) => {
      const requestedRoot = resolveProjectRoot(args);
      return withControlClient(requestedRoot, async (client) => {
        const auth = leaseAuthorization(args, client);
        if (!auth) return leaseMissing();
        const projectRoot = client.projectRoot ?? requestedRoot;
        return actionResult(await client.submit(command('pane.action', projectRoot, {
          ...auth,
          projectId: projectRoot,
          action: {
            kind: 'create', cwd: projectRoot,
            agent: requiredString(args, 'agent'), prompt: requiredString(args, 'prompt'),
            ...(typeof args.branch === 'string' ? { branch: args.branch } : {}),
            ...(typeof args.title === 'string' ? { title: args.title } : {}),
          } as never,
        })));
      });
    },
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
    handler: async (args) => {
      return actionResult(await submit(args, 'pane.action', (client: McpControlClient) => {
        const auth = leaseAuthorization(args, client);
        if (!auth) return leaseMissing();
        return {
          ...auth,
          paneId: requiredString(args, 'pane_id'),
          generation: requiredPositiveInteger(args, 'generation'),
          action: { kind: 'close' },
        };
      }));
    },
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
    handler: async (args) => {
      return actionResult(await submit(args, 'pane.observe', (client: McpControlClient) => {
        const auth = leaseAuthorization(args, client);
        if (!auth) return leaseMissing();
        return {
          ...auth,
          paneId: requiredString(args, 'pane_id'),
          generation: requiredPositiveInteger(args, 'generation'),
          ...(Number.isSafeInteger(args.after_sequence) ? { afterSequence: args.after_sequence as number } : {}),
        };
      }));
    },
  },
  {
    name: 'psyche_list_rituals',
    description: 'List built-in and project rituals without mutating the host.',
    inputSchema: { type: 'object', properties: { project_root: projectRootProperty } },
    handler: async (args) => {
      const projectRoot = resolveProjectRoot(args);
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
      const projectRoot = resolveProjectRoot(args);
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
  options: McpRunOptions = parseMcpArgs(process.argv.slice(3), process.env),
): Promise<void> {
  const restore = options.taskBinding === undefined
    ? undefined
    : setMcpDeps({
        controlClientForRoot: (projectRoot) => createMcpControlClientForRoot(projectRoot, {
          taskBinding: options.taskBinding,
        }),
      });
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
    try {
      await closeMcpControlClients();
    } finally {
      restore?.();
    }
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
