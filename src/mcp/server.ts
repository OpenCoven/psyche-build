/** psyche MCP stdio server backed exclusively by the canonical control owner. */

import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ControlClient } from '../control/client.js';
import { createControlCredentialStore } from '../control/credentials.js';
import { AGENT_CONTROL_LIMITS } from '../control/limits.js';
import { ensureHostControlPlane } from '../control/hostProcess.js';
import { canonicalizeProjectRoot } from '../control/projectIdentity.js';
import type { ControlCommandInput, CommandOutcome } from '../control/types.js';
import { capturePaneSync, listPanes } from '../daemon/panes.js';
import type { PaneSummary } from '../daemon/protocol.js';
import {
  getBuiltInRituals,
  listProjectRituals,
  type RitualDefinition,
} from '../utils/rituals.js';

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

type McpControlClient = Pick<ControlClient,
  'principal' | 'getState' | 'submit' | 'actionStatus'> & { close?: () => Promise<void> };

type LegacyScopedRitual = RitualDefinition & { scope: 'builtin' | 'project' };
interface LegacyRitualLists {
  builtin: LegacyScopedRitual[];
  project: LegacyScopedRitual[];
}
interface LegacyWorktree {
  path: string;
  head?: string;
  branch?: string;
  bare?: boolean;
  detached?: boolean;
  locked?: boolean;
}
type GitWorktreeRunner = (
  command: string,
  args: string[],
  options: { encoding: 'utf8'; timeout: number },
) => Promise<{ stdout: string }>;

const runGitWorktree: GitWorktreeRunner = promisify(execFile) as GitWorktreeRunner;

function listLegacyRituals(projectRoot: string): LegacyRitualLists {
  return {
    builtin: getBuiltInRituals().map((ritual) => ({ ...ritual, scope: 'builtin' as const })),
    project: listProjectRituals(projectRoot).map((ritual) => ({ ...ritual, scope: 'project' as const })),
  };
}

/** Exact legacy porcelain projection, now using the non-blocking read API. */
export async function listLegacyWorktrees(
  projectRoot: string,
  run: GitWorktreeRunner = runGitWorktree,
): Promise<LegacyWorktree[]> {
  const { stdout: raw } = await run(
    'git',
    ['-C', projectRoot, 'worktree', 'list', '--porcelain'],
    { encoding: 'utf8', timeout: 5000 },
  );
  const worktrees: LegacyWorktree[] = [];
  let current: LegacyWorktree | null = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push(current);
      current = { path: line.slice('worktree '.length) };
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    } else if (current && line === 'bare') {
      current.bare = true;
    } else if (current && line === 'detached') {
      current.detached = true;
    } else if (current && line.startsWith('locked')) {
      current.locked = true;
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

export interface McpDeps {
  controlClientForRoot(projectRoot: string): Promise<McpControlClient>;
  listPanes(projectRoot: string): Promise<PaneSummary[]>;
  capturePane(paneId: string): Buffer;
  listRitualsLegacy(projectRoot: string): LegacyRitualLists;
  listWorktreesLegacy(projectRoot: string): Promise<LegacyWorktree[]>;
}

const entryPath = process.argv[1]
  ?? fileURLToPath(new URL('../index.js', import.meta.url));

export const defaultMcpDeps: McpDeps = {
  controlClientForRoot: async (projectRoot) => {
    const credentials = await createControlCredentialStore({ projectRoot });
    return ensureHostControlPlane({
      projectRoot,
      token: await credentials.agentToken(),
      clientName: 'psyche-mcp',
      entryPath,
    });
  },
  listPanes,
  capturePane: capturePaneSync,
  listRitualsLegacy: listLegacyRituals,
  listWorktreesLegacy: listLegacyWorktrees,
};

let deps = defaultMcpDeps;

/** Test seam. Returns a restore function. */
export function setMcpDeps(next: Partial<McpDeps>): () => void {
  const previous = deps;
  deps = { ...deps, ...next };
  return () => { deps = previous; };
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

const projectRootProperty = {
  type: 'string',
  description: 'Absolute existing project root. The owner canonicalizes and scopes it.',
};
const stringProperty = { type: 'string', minLength: 1 };
const positiveIntegerProperty = { type: 'integer', minimum: 1 };
const leaseProperties = {
  task_id: stringProperty,
  lease_id: stringProperty,
  lease_revision: positiveIntegerProperty,
};
const paneTargetProperties = {
  pane_id: stringProperty,
  generation: positiveIntegerProperty,
};
const browserTargetProperties = {
  tab_id: stringProperty,
  generation: positiveIntegerProperty,
};

function exactObject(
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): Record<string, unknown> {
  return { type: 'object', properties, required: [...required], additionalProperties: false };
}

const existingPaneActionVariants = [
    exactObject({ kind: { const: 'send_text' }, text: stringProperty }, ['kind', 'text']),
    exactObject({
      kind: { const: 'send_keys' },
      keys: {
        type: 'array', minItems: 1,
        items: { type: 'string', enum: ['Enter', 'Tab', 'Escape', 'Backspace', 'Up', 'Down', 'Left', 'Right', 'C-c', 'C-d'] },
      },
    }, ['kind', 'keys']),
    exactObject({ kind: { const: 'interrupt' }, key: { type: 'string', enum: ['C-c', 'Escape'] } }, ['kind']),
    exactObject({ kind: { const: 'focus' } }, ['kind']),
    exactObject({ kind: { const: 'resize' }, cols: positiveIntegerProperty, rows: positiveIntegerProperty }, ['kind', 'cols', 'rows']),
    exactObject({ kind: { const: 'close' } }, ['kind']),
] as const;
const existingPaneActionSchema = { oneOf: existingPaneActionVariants };
const paneCreateActionSchema = exactObject({
  kind: { const: 'create' }, cwd: stringProperty, title: stringProperty,
  agent: stringProperty, branch: stringProperty,
}, ['kind', 'cwd']);

const semanticProperty = exactObject({
  role: stringProperty, name: stringProperty, submit: { type: 'boolean' }, secret: { type: 'boolean' },
});
const elementBase = {
  elementRef: stringProperty,
  semantic: semanticProperty,
};
const browserElementActionVariants = [
    exactObject({ kind: { const: 'click' }, ...elementBase }, ['kind', 'elementRef']),
    exactObject({ kind: { const: 'type' }, ...elementBase, text: stringProperty, append: { type: 'boolean' } }, ['kind', 'elementRef', 'text']),
    exactObject({ kind: { const: 'select' }, ...elementBase, values: { type: 'array', minItems: 1, items: stringProperty } }, ['kind', 'elementRef', 'values']),
    exactObject({ kind: { const: 'submit' }, ...elementBase }, ['kind', 'elementRef']),
    exactObject({ kind: { const: 'upload' }, ...elementBase, path: stringProperty }, ['kind', 'elementRef', 'path']),
    exactObject({ kind: { const: 'download' }, ...elementBase, destination: stringProperty }, ['kind', 'elementRef', 'destination']),
    exactObject({ kind: { const: 'scroll' }, elementRef: stringProperty, deltaX: { type: 'number' }, deltaY: { type: 'number' } }, ['kind', 'elementRef']),
    exactObject({ kind: { const: 'focus' }, ...elementBase }, ['kind', 'elementRef']),
] as const;
const browserSurfaceActionVariants = [
    exactObject({ kind: { const: 'navigate' }, url: stringProperty }, ['kind', 'url']),
    exactObject({
      kind: { const: 'permission_response' }, permission: stringProperty, origin: stringProperty,
      decision: { type: 'string', enum: ['allow', 'deny'] },
    }, ['kind', 'permission', 'origin', 'decision']),
    ...['reload', 'back', 'forward', 'screenshot', 'close'].map((kind) => (
      exactObject({ kind: { const: kind } }, ['kind'])
    )),
] as const;
const browserElementActionSchema = { oneOf: browserElementActionVariants };
const browserSurfaceActionSchema = { oneOf: browserSurfaceActionVariants };

const surfaceCapabilities = [
  'pane.observe', 'pane.input', 'pane.interrupt', 'pane.focus', 'pane.resize', 'pane.create', 'pane.close',
  'browser.inspect', 'browser.screenshot', 'browser.navigate', 'browser.interact', 'browser.history',
  'browser.close', 'browser.script',
];
const leaseGrantSchema = exactObject({
  target: {
    oneOf: [
      exactObject({ kind: { const: 'project' }, id: stringProperty }, ['kind', 'id']),
      exactObject({ kind: { const: 'pane' }, id: stringProperty, generation: positiveIntegerProperty }, ['kind', 'id', 'generation']),
      exactObject({ kind: { const: 'browser_tab' }, id: stringProperty, generation: positiveIntegerProperty }, ['kind', 'id', 'generation']),
    ],
  },
  capabilities: {
    type: 'array', minItems: 1, uniqueItems: true,
    items: { type: 'string', enum: surfaceCapabilities },
  },
}, ['target', 'capabilities']);

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: ERR_INVALID_PARAMS });
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (!/^(0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index)
    && index >= 0
    && index < 0xFFFF_FFFF
    && index < length
    && String(index) === key;
}

function matchesSchema(value: unknown, schema: Record<string, any>): boolean {
  if (schema.oneOf) {
    if (schema.oneOf.filter((candidate: Record<string, any>) => matchesSchema(value, candidate)).length !== 1) {
      return false;
    }
  }
  if ('const' in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  switch (schema.type) {
    case undefined: break;
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      if (Object.getPrototypeOf(value) !== Object.prototype) return false;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Reflect.ownKeys(value).some((key) => (
        typeof key !== 'string'
        || !descriptors[key]?.enumerable
        || !('value' in descriptors[key])
      ))) return false;
      const record = value as Record<string, unknown>;
      if ((schema.required ?? []).some((key: string) => !(key in record))) return false;
      if (schema.additionalProperties === false
        && Object.keys(record).some((key) => !(key in (schema.properties ?? {})))) return false;
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        if (key in record && !matchesSchema(descriptors[key].value, child as Record<string, any>)) return false;
      }
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) return false;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Reflect.ownKeys(value).some((key) => {
        if (key === 'length') return false;
        return typeof key !== 'string' || !isCanonicalArrayIndex(key, value.length)
          || !descriptors[key]?.enumerable || !('value' in descriptors[key]);
      })) return false;
      if (schema.minItems !== undefined && value.length < schema.minItems) return false;
      if (Array.from({ length: value.length }, (_, index) => String(index))
        .some((key) => !(key in descriptors))) return false;
      const items = Array.from({ length: value.length }, (_, index) => descriptors[index].value);
      if (schema.uniqueItems && new Set(items.map((item) => JSON.stringify(item))).size !== value.length) return false;
      if (schema.items && items.some((item) => !matchesSchema(item, schema.items))) return false;
      break;
    }
    case 'string':
      if (typeof value !== 'string') return false;
      if (schema.minLength !== undefined && value.length < schema.minLength) return false;
      break;
    case 'integer':
      if (!Number.isInteger(value)) return false;
      if (schema.minimum !== undefined && (value as number) < schema.minimum) return false;
      break;
    case 'number': if (typeof value !== 'number' || !Number.isFinite(value)) return false; break;
    case 'boolean': if (typeof value !== 'boolean') return false; break;
    case 'null': if (value !== null) return false; break;
    default: return false;
  }
  return true;
}

function isCanonicalJson(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || seen.has(value)) return false;
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => {
      if (key === 'length') return false;
      return typeof key !== 'string'
        || !isCanonicalArrayIndex(key, value.length)
        || !descriptors[key]?.enumerable
        || !('value' in descriptors[key]);
    })) return false;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return false;
      if (!isCanonicalJson(descriptor.value, seen)) return false;
    }
    seen.delete(value);
    return true;
  }
  if (typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype || seen.has(value as object)) return false;
    seen.add(value as object);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return false;
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !('value' in descriptor)) return false;
      if (!isCanonicalJson(descriptor.value, seen)) return false;
    }
    seen.delete(value as object);
    return true;
  }
  return false;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) invalid(`requires \`${key}\``);
  return value.trim();
}

function integerArg(args: Record<string, unknown>, key: string, minimum = 0): number {
  const value = args[key];
  if (!Number.isInteger(value) || (value as number) < minimum) invalid(`requires integer \`${key}\``);
  return value as number;
}

function objectArg(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = args[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`requires object \`${key}\``);
  return value as Record<string, unknown>;
}

async function projectRootArg(args: Record<string, unknown>): Promise<string> {
  const raw = stringArg(args, 'project_root');
  if (!path.isAbsolute(raw)) invalid('`project_root` must be absolute');
  try {
    return await canonicalizeProjectRoot(raw);
  } catch {
    invalid('`project_root` must be an existing project path');
  }
}

function leaseAuthorization(args: Record<string, unknown>) {
  return {
    taskId: stringArg(args, 'task_id'),
    leaseId: stringArg(args, 'lease_id'),
    leaseRevision: integerArg(args, 'lease_revision', 1),
  };
}

function command<K extends ControlCommandInput['kind']>(
  projectRoot: string,
  kind: K,
  payload: Extract<ControlCommandInput, { kind: K }>['payload'],
): Extract<ControlCommandInput, { kind: K }> {
  const id = randomUUID();
  return {
    id,
    idempotencyKey: id,
    kind,
    projectRoot,
    createdAt: new Date().toISOString(),
    payload,
  } as Extract<ControlCommandInput, { kind: K }>;
}

async function withClient<T>(
  args: Record<string, unknown>,
  operation: (client: McpControlClient, projectRoot: string) => Promise<T>,
): Promise<T> {
  const projectRoot = await projectRootArg(args);
  return withCanonicalClient(projectRoot, operation);
}

async function withCanonicalClient<T>(
  projectRoot: string,
  operation: (client: McpControlClient, projectRoot: string) => Promise<T>,
): Promise<T> {
  const client = await deps.controlClientForRoot(projectRoot);
  try {
    return await operation(client, projectRoot);
  } finally {
    await client.close?.().catch(() => undefined);
  }
}

function paneActionArg(args: Record<string, unknown>): Record<string, unknown> {
  const action = objectArg(args, 'action');
  const kind = stringArg(action, 'kind');
  switch (kind) {
    case 'send_text': stringArg(action, 'text'); break;
    case 'send_keys':
      if (!Array.isArray(action.keys) || action.keys.length === 0) invalid('send_keys requires non-empty `keys`');
      break;
    case 'interrupt':
    case 'focus':
    case 'close': break;
    case 'resize':
      integerArg(action, 'cols', 1);
      integerArg(action, 'rows', 1);
      break;
    case 'create': stringArg(action, 'cwd'); break;
    default: invalid(`unsupported pane action: ${kind}`);
  }
  return action;
}

function browserActionArg(
  args: Record<string, unknown>,
): { action: Record<string, unknown>; needsSnapshot: boolean } {
  const action = objectArg(args, 'action');
  const kind = stringArg(action, 'kind');
  const elementKinds = ['click', 'type', 'select', 'submit', 'upload', 'download', 'scroll', 'focus'];
  if (elementKinds.includes(kind)) {
    stringArg(action, 'elementRef');
    stringArg(args, 'snapshot_id');
    if (kind === 'type') stringArg(action, 'text');
    if (kind === 'select' && !Array.isArray(action.values)) invalid('select requires `values`');
    if (kind === 'upload') stringArg(action, 'path');
    if (kind === 'download') stringArg(action, 'destination');
    return { action, needsSnapshot: true };
  }
  switch (kind) {
    case 'navigate': stringArg(action, 'url'); break;
    case 'permission_response':
      stringArg(action, 'permission');
      stringArg(action, 'origin');
      if (action.decision !== 'allow' && action.decision !== 'deny') {
        invalid('permission_response decision must be allow or deny');
      }
      break;
    case 'reload':
    case 'back':
    case 'forward':
    case 'screenshot':
    case 'close': break;
    default: invalid(`unsupported browser action: ${kind}`);
  }
  return { action, needsSnapshot: false };
}

function leaseMissing(args: Record<string, unknown>): CommandOutcome | null {
  if (typeof args.task_id === 'string'
    && typeof args.lease_id === 'string'
    && Number.isInteger(args.lease_revision)) return null;
  return {
    status: 'rejected',
    code: 'lease_missing',
    message: 'task_id, lease_id, and lease_revision are required for pane mutations',
  };
}

async function readProjectRoot(args: Record<string, unknown>): Promise<string> {
  const raw = args.project_root;
  return typeof raw === 'string' && raw.length > 0
    ? projectRootArg(args)
    : process.env.PSYCHE_PROJECT_ROOT ?? process.cwd();
}

export const CANONICAL_CONTROL_TOOL_NAMES = Object.freeze([
  'psyche_control_list',
  'psyche_control_lease',
  'psyche_pane_observe',
  'psyche_pane_action',
  'psyche_browser_inspect',
  'psyche_browser_action',
  'psyche_browser_script',
  'psyche_control_action_status',
] as const);

export const TOOLS: ToolDef[] = [
  {
    name: 'psyche_control_list',
    description: 'List canonical managed pane and browser resources with generations and lease state.',
    inputSchema: {
      type: 'object', required: ['project_root'], additionalProperties: false,
      properties: { project_root: projectRootProperty },
    },
    handler: (args) => withClient(args, (client) => client.getState()),
  },
  {
    name: 'psyche_control_lease',
    description: 'Request, inspect, or release an agent surface lease. Cannot grant, revoke, or approve.',
    inputSchema: {
      oneOf: [
        exactObject({
          project_root: projectRootProperty, operation: { const: 'request' }, task_id: stringProperty,
          ttl_ms: positiveIntegerProperty,
          grants: { type: 'array', minItems: 1, items: leaseGrantSchema },
        }, ['project_root', 'operation', 'task_id', 'ttl_ms', 'grants']),
        exactObject({
          project_root: projectRootProperty, operation: { const: 'status' }, task_id: stringProperty,
        }, ['project_root', 'operation', 'task_id']),
        exactObject({
          project_root: projectRootProperty, operation: { const: 'release' }, ...leaseProperties,
        }, ['project_root', 'operation', 'task_id', 'lease_id', 'lease_revision']),
      ],
    },
    handler: async (args) => {
      const operation = stringArg(args, 'operation');
      if (!['request', 'status', 'release'].includes(operation)) {
        invalid('lease operation must be request, status, or release');
      }
      return withClient(args, async (client, projectRoot) => {
        if (operation === 'status') {
          const taskId = stringArg(args, 'task_id');
          const state = await client.getState();
          return {
            leases: (state.capabilityLeases ?? []).filter((lease) => lease.taskId === taskId),
            requests: (state.leaseRequests ?? []).filter((request) => request.taskId === taskId),
          };
        }
        if (operation === 'request') {
          const taskId = stringArg(args, 'task_id');
          const ttlMs = integerArg(args, 'ttl_ms', 1);
          if (!Array.isArray(args.grants) || args.grants.length === 0) invalid('requires non-empty `grants`');
          return client.submit(command(projectRoot, 'lease.request', {
            taskId, ttlMs, grants: args.grants as never,
          }));
        }
        return client.submit(command(projectRoot, 'lease.release', {
          ...leaseAuthorization(args),
        }));
      });
    },
  },
  {
    name: 'psyche_pane_observe',
    description: 'Read bounded ephemeral output from an exact managed pane generation.',
    inputSchema: {
      type: 'object',
      required: ['project_root', 'task_id', 'lease_id', 'lease_revision', 'pane_id', 'generation'],
      additionalProperties: false,
      properties: {
        project_root: projectRootProperty, ...leaseProperties, ...paneTargetProperties,
        after_sequence: { type: 'integer', minimum: 0 },
      },
    },
    handler: (args) => withClient(args, (client, projectRoot) => client.submit(command(
      projectRoot,
      'pane.observe',
      {
        ...leaseAuthorization(args), paneId: stringArg(args, 'pane_id'),
        generation: integerArg(args, 'generation', 1),
        ...(args.after_sequence === undefined
          ? {} : { afterSequence: integerArg(args, 'after_sequence', 0) }),
      },
    ))),
  },
  {
    name: 'psyche_pane_action',
    description: 'Submit one typed leased pane action against an exact generation or canonical project.',
    inputSchema: {
      oneOf: [
        exactObject({
          project_root: projectRootProperty, ...leaseProperties, ...paneTargetProperties,
          action: existingPaneActionSchema,
        }, ['project_root', 'task_id', 'lease_id', 'lease_revision', 'pane_id', 'generation', 'action']),
        exactObject({
          project_root: projectRootProperty, ...leaseProperties, project_id: stringProperty,
          action: paneCreateActionSchema,
        }, ['project_root', 'task_id', 'lease_id', 'lease_revision', 'project_id', 'action']),
      ],
    },
    handler: async (args) => {
      const action = paneActionArg(args);
      const authorization = leaseAuthorization(args);
      const projectRoot = await projectRootArg(args);
      if (action.kind === 'create') {
        const projectId = stringArg(args, 'project_id');
        const cwd = stringArg(action, 'cwd');
        return withCanonicalClient(projectRoot, (client) => client.submit(command(
          projectRoot, 'pane.action', {
            ...authorization, projectId, action: { ...action, cwd },
          } as never,
        )));
      }
      const paneId = stringArg(args, 'pane_id');
      const generation = integerArg(args, 'generation', 1);
      return withCanonicalClient(projectRoot, (client) => client.submit(command(
        projectRoot, 'pane.action', { ...authorization, paneId, generation, action } as never,
      )));
    },
  },
  {
    name: 'psyche_browser_inspect',
    description: 'Request a canonical semantic snapshot for an exact browser tab generation.',
    inputSchema: {
      type: 'object',
      required: ['project_root', 'task_id', 'lease_id', 'lease_revision', 'tab_id', 'generation'],
      additionalProperties: false,
      properties: {
        project_root: projectRootProperty, ...leaseProperties, ...browserTargetProperties,
        include_screenshot: { type: 'boolean' },
      },
    },
    handler: (args) => withClient(args, (client, projectRoot) => client.submit(command(
      projectRoot, 'browser.inspect', {
        ...leaseAuthorization(args), tabId: stringArg(args, 'tab_id'),
        generation: integerArg(args, 'generation', 1),
        ...(args.include_screenshot === undefined
          ? {} : { includeScreenshot: args.include_screenshot === true }),
      },
    ))),
  },
  {
    name: 'psyche_browser_action',
    description: 'Submit one typed browser action using exact tab, generation, and snapshot references; application-defined effects behind a generic click cannot be perfectly predicted.',
    inputSchema: {
      oneOf: [
        exactObject({
          project_root: projectRootProperty, ...leaseProperties, ...browserTargetProperties,
          snapshot_id: stringProperty, action: browserElementActionSchema,
        }, ['project_root', 'task_id', 'lease_id', 'lease_revision', 'tab_id', 'generation', 'snapshot_id', 'action']),
        exactObject({
          project_root: projectRootProperty, ...leaseProperties, ...browserTargetProperties,
          action: browserSurfaceActionSchema,
        }, ['project_root', 'task_id', 'lease_id', 'lease_revision', 'tab_id', 'generation', 'action']),
      ],
    },
    handler: async (args) => {
      const authorization = leaseAuthorization(args);
      const tabId = stringArg(args, 'tab_id');
      const generation = integerArg(args, 'generation', 1);
      const parsed = browserActionArg(args);
      const action = parsed.action;
      const projectRoot = await projectRootArg(args);
      return withCanonicalClient(projectRoot, (client) => client.submit(command(projectRoot, 'browser.action', {
        ...authorization, tabId, generation, action,
        ...(parsed.needsSnapshot ? { snapshotId: stringArg(args, 'snapshot_id') } : {}),
      } as never)));
    },
  },
  {
    name: 'psyche_browser_script',
    description: 'Submit an approval-gated browser script with bounded JSON-compatible arguments.',
    inputSchema: {
      type: 'object',
      required: ['project_root', 'task_id', 'lease_id', 'lease_revision', 'tab_id', 'generation', 'source'],
      additionalProperties: false,
      properties: {
        project_root: projectRootProperty, ...leaseProperties, ...browserTargetProperties,
        source: stringProperty, args: {},
      },
    },
    handler: (args) => {
      if (args.args !== undefined && !isCanonicalJson(args.args)) invalid('script args must be canonical JSON');
      if (Buffer.byteLength(stringArg(args, 'source'), 'utf8') > AGENT_CONTROL_LIMITS.scriptSourceBytes) {
        invalid('script source exceeds the control limit');
      }
      if (args.args !== undefined
        && Buffer.byteLength(JSON.stringify(args.args), 'utf8') > AGENT_CONTROL_LIMITS.scriptResultBytes) {
        invalid('script args exceed the control limit');
      }
      return withClient(args, (client, projectRoot) => client.submit(command(projectRoot, 'browser.script', {
        ...leaseAuthorization(args), tabId: stringArg(args, 'tab_id'),
        generation: integerArg(args, 'generation', 1), source: stringArg(args, 'source'),
        ...(args.args === undefined ? {} : { args: args.args }),
      })));
    },
  },
  {
    name: 'psyche_control_action_status',
    description: 'Read the canonical live receipt for an action ID.',
    inputSchema: {
      type: 'object', required: ['project_root', 'action_id'], additionalProperties: false,
      properties: { project_root: projectRootProperty, action_id: { type: 'string' } },
    },
    handler: (args) => withClient(args, async (client) => (
      await client.actionStatus(stringArg(args, 'action_id'))
      ?? { actionId: stringArg(args, 'action_id'), state: 'unknown' }
    )),
  },
  {
    name: 'psyche_execute_task',
    description: 'Compatibility task entrypoint. Agent orchestration is unavailable until a lease-mediated orchestration capability exists.',
    inputSchema: exactObject({
      prompt: stringProperty,
      lanes: {
        type: 'array', minItems: 1,
        items: exactObject({
          id: stringProperty, agent: stringProperty,
          mode: { type: 'string', enum: ['isolated-worktree', 'shared-worktree', 'terminal', 'coven-session'] },
        }, ['id']),
      },
      task_id: stringProperty,
      concurrency: positiveIntegerProperty,
      branch: stringProperty,
      project_root: projectRootProperty,
    }, ['prompt', 'lanes']),
    handler: async () => ({
      status: 'rejected', code: 'capability_denied',
      message: 'agent orchestration requires a capability that is not available on the canonical control surface',
    }),
  },
  {
    name: 'psyche_create_pane',
    description: 'Legacy alias for a leased project-scoped psyche_pane_action create command.',
    inputSchema: {
      type: 'object',
      required: ['project_root', 'project_id', 'task_id', 'lease_id', 'lease_revision', 'agent'],
      additionalProperties: false,
      properties: {
        project_root: projectRootProperty, project_id: { type: 'string' }, ...leaseProperties,
        prompt: { type: 'string' }, agent: { type: 'string' }, branch: { type: 'string' },
        title: { type: 'string' }, cwd: { type: 'string' },
      },
    },
    handler: async (args) => {
      const missing = leaseMissing(args);
      if (missing) return missing;
      if (typeof args.prompt === 'string' && args.prompt.length > 0) {
        return {
          status: 'rejected', code: 'command_not_implemented',
          message: 'legacy create prompts are not supported by canonical pane creation',
        };
      }
      const projectRoot = await projectRootArg(args);
      return TOOLS.find((tool) => tool.name === 'psyche_pane_action')!.handler({
        project_root: projectRoot,
        project_id: args.project_id ?? projectRoot,
        ...leasePropertiesFromArgs(args),
        action: {
          kind: 'create', cwd: args.cwd ?? projectRoot,
          ...(typeof args.title === 'string' ? { title: args.title } : {}),
          ...(typeof args.agent === 'string' ? { agent: args.agent } : {}),
          ...(typeof args.branch === 'string' ? { branch: args.branch } : {}),
        },
      });
    },
  },
  {
    name: 'psyche_kill_pane',
    description: 'Legacy alias for a leased psyche_pane_action close command.',
    inputSchema: {
      type: 'object',
      required: ['project_root', 'task_id', 'lease_id', 'lease_revision', 'pane_id', 'generation'],
      additionalProperties: false,
      properties: { project_root: projectRootProperty, ...leaseProperties, ...paneTargetProperties },
    },
    handler: async (args) => {
      const missing = leaseMissing(args);
      if (missing) return missing;
      return TOOLS.find((tool) => tool.name === 'psyche_pane_action')!.handler({
        project_root: args.project_root, ...leasePropertiesFromArgs(args),
        pane_id: args.pane_id, generation: args.generation, action: { kind: 'close' },
      });
    },
  },
  {
    name: 'psyche_list_panes',
    description: 'Read the legacy project pane summary without mutation authority.',
    inputSchema: exactObject({ project_root: projectRootProperty }),
    handler: async (args) => {
      const projectRoot = await readProjectRoot(args);
      const panes = await deps.listPanes(projectRoot);
      return { project_root: projectRoot, count: panes.length, panes };
    },
  },
  {
    name: 'psyche_get_pane_output',
    description: 'Read the current legacy pane buffer and scrollback without attaching.',
    inputSchema: exactObject({
      pane_id: stringProperty,
      strip_ansi: { type: 'boolean' },
    }, ['pane_id']),
    handler: async (args) => {
      const paneId = stringArg(args, 'pane_id');
      const buffer = deps.capturePane(paneId);
      let content = buffer.toString('utf8');
      if (args.strip_ansi === true) {
        content = content.replace(/\x1B\][^\x07]*\x07/g, '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
      }
      return { pane_id: paneId, bytes: buffer.length, content };
    },
  },
  {
    name: 'psyche_list_rituals',
    description: 'Read built-in and project ritual definitions without launching them.',
    inputSchema: exactObject({ project_root: projectRootProperty }),
    handler: async (args) => {
      const projectRoot = await readProjectRoot(args);
      const rituals = deps.listRitualsLegacy(projectRoot);
      return {
        project_root: projectRoot,
        ...rituals,
        count: rituals.builtin.length + rituals.project.length,
      };
    },
  },
  {
    name: 'psyche_list_worktrees',
    description: 'Read project git worktree metadata without mutating git state.',
    inputSchema: exactObject({ project_root: projectRootProperty }),
    handler: async (args) => {
      const projectRoot = await readProjectRoot(args);
      const worktrees = await deps.listWorktreesLegacy(projectRoot);
      return { project_root: projectRoot, count: worktrees.length, worktrees };
    },
  },
];

function leasePropertiesFromArgs(args: Record<string, unknown>): Record<string, unknown> {
  return {
    task_id: args.task_id,
    lease_id: args.lease_id,
    lease_revision: args.lease_revision,
  };
}

function writeResponse(response: JsonRpcResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function fail(id: JsonRpcId, code: number, message: string, data?: unknown): void {
  writeResponse({ jsonrpc: '2.0', id, error: { code, message, data } });
}

async function handleInitialize(): Promise<unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    capabilities: { tools: { listChanged: false } },
  };
}

async function handleToolsCall(params: unknown): Promise<unknown> {
  const call = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
  if (typeof call.name !== 'string') invalid('tools/call requires `name`');
  const tool = TOOLS.find((candidate) => candidate.name === call.name);
  if (!tool) throw Object.assign(new Error(`Unknown tool: ${call.name}`), { code: ERR_METHOD_NOT_FOUND });
  const args = call.arguments ?? {};
  if ((call.name === 'psyche_create_pane' || call.name === 'psyche_kill_pane')
    && leaseMissing(args)) {
    const result = await tool.handler(args);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
  if (!matchesSchema(args, tool.inputSchema)) invalid('arguments do not match the tool schema');
  const result = await tool.handler(args);
  return {
    content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
  };
}

function safeRpcError(error: unknown): JsonRpcError['error'] {
  const rawCode = (error as { code?: unknown } | undefined)?.code;
  if (rawCode === ERR_INVALID_PARAMS) {
    return { code: ERR_INVALID_PARAMS, message: 'Invalid tool arguments', data: { code: 'invalid_tool_arguments' } };
  }
  if (rawCode === ERR_METHOD_NOT_FOUND) {
    return { code: ERR_METHOD_NOT_FOUND, message: 'Unknown MCP method or tool', data: { code: 'method_not_found' } };
  }
  const rawMessage = error instanceof Error ? error.message : '';
  const prefixedCode = /^([a-z][a-z0-9_]+):/.exec(rawMessage)?.[1];
  const typedCode = typeof rawCode === 'string' ? rawCode : prefixedCode;
  const safeMessages: Record<string, string> = {
    control_owner_unavailable: 'control owner unavailable',
    control_authentication_failed: 'control authentication failed',
    control_permission_denied: 'control permission denied',
    control_protocol_error: 'control protocol error',
  };
  if (typedCode && safeMessages[typedCode]) {
    return { code: ERR_INTERNAL, message: safeMessages[typedCode], data: { code: typedCode } };
  }
  return { code: ERR_INTERNAL, message: 'MCP tool call failed', data: { code: 'internal_error' } };
}

export async function handleMcpRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  try {
    let result: unknown;
    switch (req.method) {
      case 'initialize': result = await handleInitialize(); break;
      case 'notifications/initialized': return null;
      case 'tools/list':
        result = { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
        break;
      case 'tools/call': result = await handleToolsCall(req.params); break;
      case 'ping': result = {}; break;
      default:
        return { jsonrpc: '2.0', id, error: { code: ERR_METHOD_NOT_FOUND, message: `Method not found: ${req.method}` } };
    }
    return { jsonrpc: '2.0', id, result };
  } catch (error) {
    return { jsonrpc: '2.0', id, error: safeRpcError(error) };
  }
}

async function dispatch(req: JsonRpcRequest): Promise<void> {
  const response = await handleMcpRequest(req);
  if (response) writeResponse(response);
}

export async function runMcpServer(): Promise<void> {
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      fail(null, ERR_PARSE, 'Parse error: stdin is not valid JSON');
      return;
    }
    if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      fail(req.id ?? null, ERR_INVALID_REQUEST, 'Invalid JSON-RPC 2.0 request');
      return;
    }
    void dispatch(req);
  });
  await new Promise<void>((resolve) => rl.on('close', resolve));
}
