import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlClient } from '../src/control/client.js';
import {
  createControlCredentialStore,
  issueControlTaskCredential,
  issueControlTaskToken,
  revokeControlTaskCredential,
} from '../src/control/credentials.js';
import { controlEndpointForProject } from '../src/control/endpoint.js';
import { createHostControlPlane } from '../src/control/host.js';
import { ControlServer } from '../src/control/server.js';
import { createDaemonControlHandlers } from '../src/daemon/controlHandlers.js';
import { AgenticCapabilityRouter } from '../src/orchestration/capabilityRouter.js';
import { TmuxControl } from '../src/services/tmuxControl.js';
import {
  MCP_CONTROL_ERROR_CODE,
  TOOLS,
  closeMcpControlClients,
  createMcpControlClientForRoot,
  handleMcpRequest,
  parseMcpArgs,
  setMcpDeps,
  validateMcpTaskBinding,
} from '../src/mcp/server.js';
import { canonicalizeProjectRoot } from '../src/control/projectIdentity.js';
import type { ControlCommand } from '../src/control/types.js';
import {
  cleanupTestControlStatePaths,
  createWorktreeTestControlStatePaths,
  testControlStateRoot,
  type TestControlStatePaths,
} from './helpers/controlCredentialPaths.js';
import { createRestartActionStatusHarness } from './helpers/restartActionStatusHarness.js';
import { createTaskScopedControlHarness } from './helpers/taskScopedControlHarness.js';

const restores: Array<() => void> = [];
const integrationCleanups: Array<() => Promise<void>> = [];
let scratchRoots: TestControlStatePaths[] = [];
const projectRootFixtures: string[] = [];
afterEach(async () => {
  while (restores.length) restores.pop()!();
  await Promise.allSettled(integrationCleanups.map(async (close) => close()));
  integrationCleanups.length = 0;
  await Promise.all(projectRootFixtures.splice(0).map((root) => (
    rm(root, { recursive: true, force: true })
  )));
  await cleanupTestControlStatePaths(scratchRoots);
  scratchRoots = [];
  await closeMcpControlClients();
  vi.restoreAllMocks();
});

function inject(next: Parameters<typeof setMcpDeps>[0]): void {
  restores.push(setMcpDeps(next));
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  return handleMcpRequest({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
  });
}

function payload(response: any): any {
  return JSON.parse(response.result.content[0].text);
}

function fakeClient(overrides: Record<string, unknown> = {}): any {
  return {
    principal: { kind: 'operator' },
    submit: vi.fn(), getState: vi.fn(), actionStatus: vi.fn(), close: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function scratchProject(): Promise<string> {
  const fixture = await createWorktreeTestControlStatePaths('mc');
  scratchRoots.push(fixture);
  return fixture.projectRoot;
}

const leaseAuthorization = {
  lease_id: 'lease-1', lease_revision: 2,
};
const lease = {
  task_id: 'task-1', ...leaseAuthorization,
};
const boundTaskId = 'task-bound';
const conflictingTaskId = 'task-other';

function controlSnapshot(overrides: Record<string, unknown> = {}): any {
  return {
    ownerEpoch: 1,
    sequence: 1,
    commands: {},
    leases: {},
    resources: [],
    capabilityLeases: [],
    leaseRequests: [],
    approvals: [],
    receipts: [],
    ...overrides,
  };
}

interface TaskBindingToolCase {
  label: string;
  name: string;
  args: Record<string, unknown>;
  createClient(): any;
  assertCalled(client: any): void;
  assertNotCalled(client: any): void;
}

interface TaskScopedReadCase {
  label: string;
  name: string;
  args: Record<string, unknown>;
  createClient(): any;
  assertNotCalled(client: any): void;
}

function stateCase(label: string, name: string, args: Record<string, unknown>): TaskBindingToolCase {
  return {
    label,
    name,
    args,
    createClient: () => fakeClient({
      principal: { kind: 'agent' },
      taskBinding: { taskId: boundTaskId },
      getState: vi.fn(async () => controlSnapshot()),
    }),
    assertCalled: (client) => {
      expect(client.getState).toHaveBeenCalledTimes(1);
      expect(client.getState).toHaveBeenCalledWith({ taskId: boundTaskId });
    },
    assertNotCalled: (client) => {
      expect(client.getState).not.toHaveBeenCalled();
    },
  };
}

function actionStatusCase(label: string, name: string, args: Record<string, unknown>): TaskBindingToolCase {
  return {
    label,
    name,
    args,
    createClient: () => fakeClient({
      principal: { kind: 'agent' },
      taskBinding: { taskId: boundTaskId },
      actionStatus: vi.fn(async () => ({
        schema: 'psyche.control.receipt/v1',
        actionId: 'action-1',
        state: 'queued',
        resource: { kind: 'pane', id: 'pane-1', generation: 1 },
        createdAt: '2026-08-12T00:00:00.000Z',
      })),
    }),
    assertCalled: (client) => {
      expect(client.actionStatus).toHaveBeenCalledTimes(1);
      expect(client.actionStatus).toHaveBeenCalledWith('action-1', { taskId: boundTaskId });
    },
    assertNotCalled: (client) => {
      expect(client.actionStatus).not.toHaveBeenCalled();
    },
  };
}

function taskScopedReadCase(label: string, name: string, args: Record<string, unknown>): TaskScopedReadCase {
  return {
    label,
    name,
    args,
    createClient: () => fakeClient({
      principal: { kind: 'agent' },
      getState: vi.fn(async () => controlSnapshot()),
      actionStatus: vi.fn(async () => ({
        schema: 'psyche.control.receipt/v1',
        actionId: 'action-1',
        state: 'queued',
        resource: { kind: 'pane', id: 'pane-1', generation: 1 },
        createdAt: '2026-08-12T00:00:00.000Z',
      })),
      submit: vi.fn(),
    }),
    assertNotCalled: (client) => {
      expect(client.getState).not.toHaveBeenCalled();
      expect(client.actionStatus).not.toHaveBeenCalled();
      expect(client.submit).not.toHaveBeenCalled();
    },
  };
}

function submitCase(
  label: string,
  name: string,
  args: Record<string, unknown>,
  expectedCommand: Record<string, unknown>,
): TaskBindingToolCase {
  return {
    label,
    name,
    args,
    createClient: () => fakeClient({
      principal: { kind: 'agent' },
      taskBinding: { taskId: boundTaskId },
      submit: vi.fn(async () => ({ status: 'succeeded' })),
    }),
    assertCalled: (client) => {
      expect(client.submit).toHaveBeenCalledTimes(1);
      expect(client.submit.mock.calls[0][0]).toMatchObject(expectedCommand);
    },
    assertNotCalled: (client) => {
      expect(client.submit).not.toHaveBeenCalled();
    },
  };
}

const boundTaskCases: readonly TaskBindingToolCase[] = [
  stateCase('control list', 'psyche_control_list', { project_root: '/repo' }),
  stateCase('lease status', 'psyche_control_lease', {
    operation: 'status',
    project_root: '/repo',
    request_id: 'request-1',
  }),
  stateCase('pane list', 'psyche_list_panes', { project_root: '/repo' }),
  actionStatusCase('action status', 'psyche_control_action_status', {
    project_root: '/repo',
    action_id: 'action-1',
  }),
  submitCase('lease request', 'psyche_control_lease', {
    operation: 'request',
    project_root: '/repo',
    ttl_ms: 60_000,
    grants: [{}],
  }, {
    kind: 'lease.request',
    payload: { taskId: boundTaskId, ttlMs: 60_000 },
  }),
  submitCase('lease release', 'psyche_control_lease', {
    operation: 'release',
    project_root: '/repo',
    ...leaseAuthorization,
  }, {
    kind: 'lease.release',
    payload: { taskId: boundTaskId, leaseId: 'lease-1', leaseRevision: 2 },
  }),
  submitCase('pane observe', 'psyche_pane_observe', {
    project_root: '/repo',
    ...leaseAuthorization,
    pane_id: 'pane-1',
    generation: 1,
  }, {
    kind: 'pane.observe',
    payload: {
      taskId: boundTaskId,
      leaseId: 'lease-1',
      leaseRevision: 2,
      paneId: 'pane-1',
      generation: 1,
    },
  }),
  submitCase('pane action', 'psyche_pane_action', {
    project_root: '/repo',
    ...leaseAuthorization,
    pane_id: 'pane-1',
    generation: 1,
    action: { kind: 'focus' },
  }, {
    kind: 'pane.action',
    payload: {
      taskId: boundTaskId,
      leaseId: 'lease-1',
      leaseRevision: 2,
      paneId: 'pane-1',
      generation: 1,
      action: { kind: 'focus' },
    },
  }),
  submitCase('browser inspect', 'psyche_browser_inspect', {
    project_root: '/repo',
    ...leaseAuthorization,
    tab_id: 'tab-1',
    generation: 1,
  }, {
    kind: 'browser.inspect',
    payload: {
      taskId: boundTaskId,
      leaseId: 'lease-1',
      leaseRevision: 2,
      tabId: 'tab-1',
      generation: 1,
    },
  }),
  submitCase('browser action', 'psyche_browser_action', {
    project_root: '/repo',
    ...leaseAuthorization,
    tab_id: 'tab-1',
    generation: 1,
    action: { kind: 'reload' },
  }, {
    kind: 'browser.action',
    payload: {
      taskId: boundTaskId,
      leaseId: 'lease-1',
      leaseRevision: 2,
      tabId: 'tab-1',
      generation: 1,
      action: { kind: 'reload' },
    },
  }),
  submitCase('browser script', 'psyche_browser_script', {
    project_root: '/repo',
    ...leaseAuthorization,
    tab_id: 'tab-1',
    generation: 1,
    source: 'return true;',
  }, {
    kind: 'browser.script',
    payload: {
      taskId: boundTaskId,
      leaseId: 'lease-1',
      leaseRevision: 2,
      tabId: 'tab-1',
      generation: 1,
      source: 'return true;',
    },
  }),
  submitCase('execute task', 'psyche_execute_task', {
    project_root: '/repo',
    ...leaseAuthorization,
    prompt: 'test',
    lanes: [{ id: 'one', mode: 'terminal' }],
  }, {
    kind: 'orchestration.execute',
    payload: {
      taskId: boundTaskId,
      leaseId: 'lease-1',
      leaseRevision: 2,
      request: {
        taskId: boundTaskId,
        projectRoot: '/repo',
        prompt: 'test',
      },
    },
  }),
  submitCase('create pane', 'psyche_create_pane', {
    project_root: '/repo',
    ...leaseAuthorization,
    prompt: 'fix it',
    agent: 'codex',
  }, {
    kind: 'pane.action',
    payload: {
      taskId: boundTaskId,
      leaseId: 'lease-1',
      leaseRevision: 2,
      projectId: '/repo',
      action: { kind: 'create', cwd: '/repo', agent: 'codex', prompt: 'fix it' },
    },
  }),
  submitCase('kill pane', 'psyche_kill_pane', {
    project_root: '/repo',
    ...leaseAuthorization,
    pane_id: 'pane-1',
    generation: 1,
  }, {
    kind: 'pane.action',
    payload: {
      taskId: boundTaskId,
      leaseId: 'lease-1',
      leaseRevision: 2,
      paneId: 'pane-1',
      generation: 1,
      action: { kind: 'close' },
    },
  }),
  submitCase('pane output', 'psyche_get_pane_output', {
    project_root: '/repo',
    ...leaseAuthorization,
    pane_id: 'pane-1',
    generation: 1,
  }, {
    kind: 'pane.observe',
    payload: {
      taskId: boundTaskId,
      leaseId: 'lease-1',
      leaseRevision: 2,
      paneId: 'pane-1',
      generation: 1,
    },
  }),
];

const taskScopedReadCases: readonly TaskScopedReadCase[] = [
  taskScopedReadCase('control list', 'psyche_control_list', {
    project_root: '/repo',
    task_id: boundTaskId,
  }),
  taskScopedReadCase('lease status', 'psyche_control_lease', {
    operation: 'status',
    project_root: '/repo',
    task_id: boundTaskId,
    request_id: 'request-1',
  }),
  taskScopedReadCase('pane list', 'psyche_list_panes', {
    project_root: '/repo',
    task_id: boundTaskId,
  }),
  taskScopedReadCase('action status', 'psyche_control_action_status', {
    project_root: '/repo',
    task_id: boundTaskId,
    action_id: 'action-1',
  }),
] as const;

const taskSensitiveMutationCases = [
  {
    label: 'lease request',
    name: 'psyche_control_lease',
    args: { operation: 'request', project_root: '/repo', task_id: 'task-own', ttl_ms: 60_000, grants: [{}] },
  },
  {
    label: 'lease release',
    name: 'psyche_control_lease',
    args: { operation: 'release', project_root: '/repo', task_id: 'task-own', ...leaseAuthorization },
  },
  {
    label: 'pane observe',
    name: 'psyche_pane_observe',
    args: { project_root: '/repo', task_id: 'task-own', ...leaseAuthorization, pane_id: 'pane-1', generation: 1 },
  },
  {
    label: 'pane action',
    name: 'psyche_pane_action',
    args: {
      project_root: '/repo',
      task_id: 'task-own',
      ...leaseAuthorization,
      pane_id: 'pane-1',
      generation: 1,
      action: { kind: 'focus' },
    },
  },
  {
    label: 'browser inspect',
    name: 'psyche_browser_inspect',
    args: { project_root: '/repo', task_id: 'task-own', ...leaseAuthorization, tab_id: 'tab-1', generation: 1 },
  },
  {
    label: 'browser action',
    name: 'psyche_browser_action',
    args: {
      project_root: '/repo',
      task_id: 'task-own',
      ...leaseAuthorization,
      tab_id: 'tab-1',
      generation: 1,
      action: { kind: 'reload' },
    },
  },
  {
    label: 'browser script',
    name: 'psyche_browser_script',
    args: {
      project_root: '/repo',
      task_id: 'task-own',
      ...leaseAuthorization,
      tab_id: 'tab-1',
      generation: 1,
      source: 'return true;',
    },
  },
  {
    label: 'execute task',
    name: 'psyche_execute_task',
    args: {
      project_root: '/repo',
      task_id: 'task-own',
      ...leaseAuthorization,
      prompt: 'test',
      lanes: [{ id: 'one', mode: 'terminal' }],
    },
  },
  {
    label: 'create pane',
    name: 'psyche_create_pane',
    args: {
      project_root: '/repo',
      task_id: 'task-own',
      ...leaseAuthorization,
      prompt: 'fix it',
      agent: 'codex',
    },
  },
  {
    label: 'kill pane',
    name: 'psyche_kill_pane',
    args: {
      project_root: '/repo',
      task_id: 'task-own',
      ...leaseAuthorization,
      pane_id: 'pane-1',
      generation: 1,
    },
  },
  {
    label: 'pane output',
    name: 'psyche_get_pane_output',
    args: {
      project_root: '/repo',
      task_id: 'task-own',
      ...leaseAuthorization,
      pane_id: 'pane-1',
      generation: 1,
    },
  },
] as const;

describe('agent surface MCP tools', () => {
  it('keeps task_id optional wherever task-bound MCP context can supply it', () => {
    const names = [
      'psyche_control_list',
      'psyche_control_lease',
      'psyche_pane_observe',
      'psyche_pane_action',
      'psyche_browser_inspect',
      'psyche_browser_action',
      'psyche_browser_script',
      'psyche_control_action_status',
      'psyche_list_panes',
      'psyche_execute_task',
      'psyche_create_pane',
      'psyche_kill_pane',
      'psyche_get_pane_output',
    ];
    expect(names.every((name) => TOOLS.some((tool) => tool.name === name))).toBe(true);

    for (const name of [
      'psyche_control_lease',
      'psyche_pane_observe',
      'psyche_pane_action',
      'psyche_browser_inspect',
      'psyche_browser_action',
      'psyche_browser_script',
      'psyche_execute_task',
      'psyche_create_pane',
      'psyche_kill_pane',
      'psyche_get_pane_output',
    ]) {
      const required = (TOOLS.find((tool) => tool.name === name)!.inputSchema.required ?? []) as string[];
      expect(required).toEqual(expect.arrayContaining(name === 'psyche_control_lease'
        ? ['operation']
        : ['lease_id', 'lease_revision']));
      expect(required).not.toContain('task_id');
    }

    for (const name of ['psyche_control_list', 'psyche_control_action_status', 'psyche_list_panes']) {
      const required = (TOOLS.find((tool) => tool.name === name)!.inputSchema.required ?? []) as string[];
      expect(required).not.toContain('task_id');
    }
  });

  it('documents the generic click risk boundary', () => {
    const description = TOOLS.find((tool) => tool.name === 'psyche_browser_action')?.description;
    expect(description).toMatch(/generic click/i);
    expect(description).toMatch(/cannot be perfectly predicted/i);
  });

  it('keeps MCP unbound only when no binding input is present', async () => {
    await expect(parseMcpArgs([], {})).resolves.toEqual({});
  });

  it('binds task identity to the canonical environment root or launch cwd', async () => {
    const canonicalize = vi.fn(async (root: string) => `/canonical${root}`);
    await expect(parseMcpArgs(['--task-id', 'task-alpha'], {
      PSYCHE_CONTROL_TASK_ID: 'task-env',
      PSYCHE_CONTROL_TASK_TOKEN: 'alpha-token',
      PSYCHE_PROJECT_ROOT: '/environment/repo',
    }, '/launch/cwd', canonicalize)).resolves.toEqual({
      taskBinding: {
        taskId: 'task-alpha',
        token: 'alpha-token',
        canonicalProjectRoot: '/canonical/environment/repo',
      },
    });
    await expect(parseMcpArgs([], {
      PSYCHE_CONTROL_TASK_ID: 'task-env',
      PSYCHE_CONTROL_TASK_TOKEN: 'env-token',
    }, '/launch/cwd', canonicalize)).resolves.toEqual({
      taskBinding: {
        taskId: 'task-env',
        token: 'env-token',
        canonicalProjectRoot: '/canonical/launch/cwd',
      },
    });
    expect(canonicalize.mock.calls.map(([root]) => root)).toEqual([
      '/environment/repo',
      '/launch/cwd',
    ]);
  });

  it('rejects missing and explicitly blank CLI task IDs without falling back to the environment', async () => {
    await expect(parseMcpArgs(['--task-id'], {
      PSYCHE_CONTROL_TASK_ID: 'task-env',
      PSYCHE_CONTROL_TASK_TOKEN: 'env-token',
    })).rejects.toThrow(/requires a value/i);
    await expect(parseMcpArgs(['--task-id', ''], {})).rejects.toThrow(/task id/i);
    await expect(parseMcpArgs(['--task-id', '   '], {})).rejects.toThrow(/task id/i);
  });

  it('fails closed when either task-binding environment variable is explicitly blank', async () => {
    const secret = 'never-print-this-environment-token';
    const environments: NodeJS.ProcessEnv[] = [
      { PSYCHE_CONTROL_TASK_ID: '' },
      { PSYCHE_CONTROL_TASK_ID: '   ' },
      { PSYCHE_CONTROL_TASK_TOKEN: '' },
      { PSYCHE_CONTROL_TASK_TOKEN: '   ' },
      { PSYCHE_CONTROL_TASK_ID: '', PSYCHE_CONTROL_TASK_TOKEN: secret },
      { PSYCHE_CONTROL_TASK_ID: 'task-alpha', PSYCHE_CONTROL_TASK_TOKEN: '' },
      { PSYCHE_CONTROL_TASK_ID: 'task-alpha', PSYCHE_CONTROL_TASK_TOKEN: '   ' },
      { PSYCHE_CONTROL_TASK_ID: '   ', PSYCHE_CONTROL_TASK_TOKEN: secret },
      { PSYCHE_CONTROL_TASK_ID: '', PSYCHE_CONTROL_TASK_TOKEN: '' },
      { PSYCHE_CONTROL_TASK_ID: '   ', PSYCHE_CONTROL_TASK_TOKEN: '   ' },
    ];
    for (const env of environments) {
      let rejection: unknown;
      try {
        await parseMcpArgs([], env);
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(TypeError);
      expect(String(rejection)).not.toContain(secret);
    }
  });

  it('requires both task identity values or neither without exposing the token', async () => {
    const token = 'never-print-this-task-token';
    await expect(parseMcpArgs(['--task-id', 'task-alpha'], {}))
      .rejects.toThrow(/task token/i);
    await expect(parseMcpArgs([], { PSYCHE_CONTROL_TASK_TOKEN: token }))
      .rejects.toThrow(/task id/i);
    for (const args of [
      () => parseMcpArgs(['--task-id', 'task-alpha'], {}),
      () => parseMcpArgs([], { PSYCHE_CONTROL_TASK_TOKEN: token }),
    ]) {
      try {
        await args();
      } catch (error) {
        expect(String(error)).not.toContain(token);
      }
    }
  });

  it('accepts 256-character task IDs and rejects 257 characters', async () => {
    const token = 'task-token';
    const accepted = 'a'.repeat(256);
    await expect(parseMcpArgs(['--task-id', accepted], {
      PSYCHE_CONTROL_TASK_TOKEN: token,
    }, '/launch/repo', async (root) => root)).resolves.toEqual({
      taskBinding: { taskId: accepted, token, canonicalProjectRoot: '/launch/repo' },
    });
    await expect(parseMcpArgs(['--task-id', 'a'.repeat(257)], {
      PSYCHE_CONTROL_TASK_TOKEN: token,
    })).rejects.toThrow(/256/);
  });

  it.each([
    ' task-token',
    'task-token ',
    '\ttask-token\n',
  ])('directly rejects a task token with surrounding whitespace', (token) => {
    let rejection: unknown;
    try {
      validateMcpTaskBinding({
        taskId: 'task-alpha',
        token,
        canonicalProjectRoot: '/canonical/repo',
      });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(TypeError);
    expect(String(rejection)).toMatch(/whitespace/i);
    expect(String(rejection)).not.toContain(token);
  });

  it.each([
    ' environment-token',
    'environment-token ',
    '\tenvironment-token\n',
  ])('rejects environment task token whitespace before canonicalizing the launch root', async (token) => {
    const canonicalize = vi.fn(async (root: string) => root);
    const pending = parseMcpArgs([], {
      PSYCHE_CONTROL_TASK_ID: 'task-alpha',
      PSYCHE_CONTROL_TASK_TOKEN: token,
    }, '/launch/repo', canonicalize);

    await expect(pending).rejects.toThrow(/whitespace/i);
    await expect(pending).rejects.not.toThrow(token);
    expect(canonicalize).not.toHaveBeenCalled();
  });

  it('rejects oversized browser script arguments before client submission', async () => {
    const client = fakeClient();
    inject({ controlClientForRoot: vi.fn(async () => client) });
    const response = await call('psyche_browser_script', {
      ...lease, project_root: '/repo', tab_id: 'tab-1', generation: 1,
      source: 'return args;', args: { text: 'x'.repeat(256 * 1024 + 1) },
    });
    expect(response.error).toMatchObject({ code: -32602 });
    expect(client.submit).not.toHaveBeenCalled();
  });

  it('routes a pane action through the canonical client without forging actor or epoch', async () => {
    const receipt = {
      schema: 'psyche.control.receipt/v1', actionId: 'action-1', state: 'queued',
      resource: { kind: 'pane', id: 'pane-1', generation: 3 }, createdAt: '2026-08-12T00:00:00.000Z',
    };
    const client = fakeClient({
      submit: vi.fn(async () => ({ status: 'succeeded', value: receipt })),
    });
    const controlClientForRoot = vi.fn(async () => client);
    inject({ controlClientForRoot });

    const body = payload(await call('psyche_pane_action', {
      ...lease, project_root: '/repo', pane_id: 'pane-1', generation: 3,
      action: { kind: 'send_text', text: 'hello' },
    }));

    expect(body).toEqual(receipt);
    expect(controlClientForRoot).toHaveBeenCalledWith('/repo');
    const command = client.submit.mock.calls[0][0];
    expect(command).toMatchObject({
      kind: 'pane.action', projectRoot: '/repo',
      payload: {
        taskId: 'task-1', leaseId: 'lease-1', leaseRevision: 2,
        paneId: 'pane-1', generation: 3,
        action: { kind: 'send_text', text: 'hello' },
      },
    });
    expect(command.actor).toBeUndefined();
    expect(command.ownerEpoch).toBeUndefined();
  });

  it('supports request, status, and release but refuses grant and approval operations', async () => {
    const client = fakeClient({ getState: vi.fn(async () => ({
      capabilityLeases: [], leaseRequests: [], resources: [], approvals: [], receipts: [],
    })) });
    inject({ controlClientForRoot: vi.fn(async () => client) });

    for (const operation of ['grant', 'approve']) {
      const response = await call('psyche_control_lease', { operation, task_id: 'task-1' });
      expect(response.error.code).toBe(-32602);
    }
    expect(client.submit).not.toHaveBeenCalled();

    expect(payload(await call('psyche_control_lease', {
      operation: 'status', task_id: 'task-1', request_id: 'request-1', project_root: '/repo',
    }))).toMatchObject({ leases: [], requests: [] });
  });

  it.each(boundTaskCases)('accepts omitted or exact-bound task ids for bound $label', async (testCase) => {
    for (const suppliedTaskId of [undefined, boundTaskId]) {
      const client = testCase.createClient();
      const restore = setMcpDeps({ controlClientForRoot: vi.fn(async () => client) });
      try {
        const response = await call(testCase.name, {
          ...testCase.args,
          ...(suppliedTaskId ? { task_id: suppliedTaskId } : {}),
        });
        expect(response.error).toBeUndefined();
        payload(response);
        testCase.assertCalled(client);
      } finally {
        restore();
      }
    }
  });

  it.each(boundTaskCases)('rejects conflicting bound task ids before any control call for $label', async (testCase) => {
    const client = testCase.createClient();
    const restore = setMcpDeps({ controlClientForRoot: vi.fn(async () => client) });
    try {
      const response = await call(testCase.name, {
        ...testCase.args,
        task_id: conflictingTaskId,
      });
      expect(response.error).toMatchObject({
        code: -32602,
        message: expect.stringContaining('task_binding_mismatch'),
      });
      testCase.assertNotCalled(client);
    } finally {
      restore();
    }
  });

  it.each(taskSensitiveMutationCases)('fails unbound non-operator $label closed before submission', async (testCase) => {
    const client = fakeClient({
      principal: { kind: 'agent' },
      submit: vi.fn(),
    });
    const restore = setMcpDeps({ controlClientForRoot: vi.fn(async () => client) });
    try {
      expect(payload(await call(testCase.name, testCase.args))).toMatchObject({
        status: 'rejected',
        code: 'task_binding_required',
      });
      expect(client.submit).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('does not disclose reusable lease credentials through the project listing', async () => {
    const client = fakeClient({ getState: vi.fn(async () => ({
      ownerEpoch: 1, sequence: 1, resources: [], approvals: [], receipts: [],
      capabilityLeases: [{
        id: 'lease-victim', requestId: 'request-victim', revision: 3,
        actorId: 'agent', taskId: 'task-victim', grants: [],
      }],
      leaseRequests: [{ id: 'request-victim', taskId: 'task-victim' }],
    })) });
    inject({ controlClientForRoot: vi.fn(async () => client) });

    const body = payload(await call('psyche_control_list', { project_root: '/repo', task_id: 'task-victim' }));
    expect(body).not.toHaveProperty('leases');
    expect(body).not.toHaveProperty('lease_requests');
    expect(body).not.toHaveProperty('receipts');
    expect(JSON.stringify(body)).not.toContain('lease-victim');
    expect(JSON.stringify(body)).not.toContain('request-victim');
  });

  it('requires the originating request id to inspect a task lease', async () => {
    const client = fakeClient({ getState: vi.fn(async () => ({
      capabilityLeases: [], leaseRequests: [], resources: [], approvals: [], receipts: [],
    })) });
    inject({ controlClientForRoot: vi.fn(async () => client) });

    const response = await call('psyche_control_lease', {
      operation: 'status', task_id: 'task-victim', project_root: '/repo',
    });
    expect(response.error.code).toBe(-32602);
    expect(client.getState).not.toHaveBeenCalled();
  });

  it('returns a structured lease_missing result for unleased create and kill aliases', async () => {
    const client = fakeClient();
    inject({ controlClientForRoot: vi.fn(async () => client) });

    for (const [name, args] of [
      ['psyche_create_pane', { prompt: 'fix it', agent: 'codex' }],
      ['psyche_kill_pane', { pane_id: 'pane-1', generation: 1 }],
    ] as const) {
      expect(payload(await call(name, args))).toMatchObject({
        status: 'rejected', code: 'lease_missing',
      });
    }
    expect(client.submit).not.toHaveBeenCalled();
  });

  it('uses the connected client canonical root for alias pane creation scope', async () => {
    const client = fakeClient({
      projectRoot: '/canonical/repo',
      submit: vi.fn(async () => ({ status: 'succeeded' })),
    });
    inject({ controlClientForRoot: vi.fn(async () => client) });

    await call('psyche_create_pane', {
      ...lease, project_root: '/symlink/repo', prompt: 'fix it', agent: 'codex',
    });

    expect(client.submit.mock.calls[0][0]).toMatchObject({
      projectRoot: '/canonical/repo',
      payload: { projectId: '/canonical/repo', action: { cwd: '/canonical/repo' } },
    });
  });

  it('canonicalizes once across token load and owner connection retries', async () => {
    const canonicalize = vi.fn(async () => '/canonical/repo');
    const agentToken = vi.fn(async () => 'agent-token');
    const credentialStoreForCanonicalRoot = vi.fn(async () => ({ agentToken } as any));
    const client = fakeClient({ projectRoot: '/canonical/repo' });
    const connect = vi.fn()
      .mockRejectedValueOnce(connectionError('ENOENT'))
      .mockRejectedValueOnce(connectionError('ECONNREFUSED'))
      .mockResolvedValueOnce(client);
    let now = 0;

    const borrowed = await createMcpControlClientForRoot('/symlink/repo', {
      canonicalize,
      credentialStoreForCanonicalRoot,
      connect,
      spawn: vi.fn(() => ({ unref: vi.fn() } as never)),
      now: () => now,
      sleep: async (delay) => { now += delay; },
      entryPath: '/entry.js',
    });

    expect(canonicalize).toHaveBeenCalledOnce();
    expect(credentialStoreForCanonicalRoot).toHaveBeenCalledWith({
      canonicalProjectRoot: '/canonical/repo',
    });
    expect(agentToken).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(3);
    expect(connect.mock.calls.every(([options]) => options.projectRoot === '/canonical/repo')).toBe(true);
    await borrowed.close();
  });

  it('rejects a task-bound root mismatch before connect, spawn, or token transfer', async () => {
    const token = 'task-token-must-never-cross-the-wrong-socket';
    const transferredBytes: string[] = [];
    const connect = vi.fn(async (options) => {
      transferredBytes.push(JSON.stringify(options));
      return fakeClient({ projectRoot: '/canonical/sibling' });
    });
    const spawn = vi.fn(() => ({ unref: vi.fn() } as never));
    const credentialStoreForCanonicalRoot = vi.fn();

    const pending = createMcpControlClientForRoot('/requested/sibling', {
      canonicalize: async () => '/canonical/sibling',
      credentialStoreForCanonicalRoot,
      connect,
      spawn,
      entryPath: '/entry.js',
      taskBinding: {
        taskId: 'task-alpha',
        token,
        canonicalProjectRoot: '/canonical/launch',
      },
    });

    await expect(pending).rejects.toMatchObject({ code: 'task_project_mismatch' });
    await expect(pending).rejects.not.toThrow(token);
    expect(connect).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(credentialStoreForCanonicalRoot).not.toHaveBeenCalled();
    expect(transferredBytes.join('')).not.toContain(token);
  });

  it('rejects a wrong MCP tool root locally and accepts a symlink of the launch root', async () => {
    const fixture = await mkdtemp(path.join(process.cwd(), '.mcp-task-project-'));
    projectRootFixtures.push(fixture);
    const launchRoot = path.join(fixture, 'launch');
    const siblingRoot = path.join(fixture, 'sibling');
    const aliasRoot = path.join(fixture, 'launch-alias');
    await mkdir(launchRoot);
    await mkdir(siblingRoot);
    await symlink(launchRoot, aliasRoot, 'dir');
    const canonicalLaunchRoot = await canonicalizeProjectRoot(launchRoot);
    const token = 'tool-token-must-never-cross-the-wrong-socket';
    const controlClientForRoot = vi.fn(async () => fakeClient({
      projectRoot: canonicalLaunchRoot,
      taskBinding: { taskId: 'task-alpha' },
      getState: vi.fn(async () => controlSnapshot({
        ownerEpoch: 1,
        sequence: 2,
        resources: [],
        approvals: [],
      })),
    }));
    const canonicalize = vi.fn((root: string) => canonicalizeProjectRoot(root));
    const taskBinding = {
      taskId: 'task-alpha',
      token,
      canonicalProjectRoot: canonicalLaunchRoot,
    };
    inject({
      taskProjectRoot: taskBinding.canonicalProjectRoot,
      canonicalizeProjectRoot: canonicalize,
      controlClientForRoot,
    });

    const mismatch = await call('psyche_control_list', { project_root: siblingRoot });
    expect(mismatch.error).toEqual({
      code: MCP_CONTROL_ERROR_CODE,
      message: 'task_project_mismatch: requested project does not match task launch project',
      data: { code: 'task_project_mismatch' },
    });
    expect(JSON.stringify(mismatch)).not.toContain(token);
    expect(controlClientForRoot).not.toHaveBeenCalled();

    expect(payload(await call('psyche_control_list', {
      project_root: aliasRoot,
    }))).toMatchObject({
      project_root: canonicalLaunchRoot,
      owner_epoch: 1,
      sequence: 2,
      resources: [],
      approvals: [],
    });
    expect(controlClientForRoot).toHaveBeenCalledOnce();
    expect(controlClientForRoot).toHaveBeenCalledWith(canonicalLaunchRoot);
    expect(canonicalize).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      tool: 'psyche_list_rituals',
      dependency: 'listRitualsForRoot',
      result: { builtin: [{ id: 'start' }], project: [] },
    },
    {
      tool: 'psyche_list_worktrees',
      dependency: 'listWorktreesForRoot',
      result: [{ path: '/canonical/launch', head: 'abc' }],
    },
  ] as const)('scopes $tool reads to the canonical task launch root', async ({
    tool,
    dependency,
    result,
  }) => {
    const fixture = await mkdtemp(path.join(process.cwd(), '.mcp-task-read-'));
    projectRootFixtures.push(fixture);
    const launchRoot = path.join(fixture, 'launch');
    const siblingRoot = path.join(fixture, 'sibling');
    const aliasRoot = path.join(fixture, 'launch-alias');
    await mkdir(launchRoot);
    await mkdir(siblingRoot);
    await symlink(launchRoot, aliasRoot, 'dir');
    const canonicalLaunchRoot = await canonicalizeProjectRoot(launchRoot);
    const readDependency = vi.fn(async () => result);
    inject({
      taskProjectRoot: canonicalLaunchRoot,
      canonicalizeProjectRoot,
      [dependency]: readDependency,
    });

    const mismatch = await call(tool, { project_root: siblingRoot });
    expect(mismatch.error).toEqual({
      code: MCP_CONTROL_ERROR_CODE,
      message: 'task_project_mismatch: requested project does not match task launch project',
      data: { code: 'task_project_mismatch' },
    });
    expect(readDependency).not.toHaveBeenCalled();

    expect(payload(await call(tool, { project_root: aliasRoot }))).toMatchObject({
      project_root: canonicalLaunchRoot,
      count: 1,
    });
    expect(readDependency).toHaveBeenCalledOnce();
    expect(readDependency).toHaveBeenCalledWith(canonicalLaunchRoot);
  });

  it('starts a task-bound MCP control client without loading the shared agent token', async () => {
    const canonicalize = vi.fn(async () => '/canonical/repo');
    const credentialStoreForCanonicalRoot = vi.fn(async () => ({
      agentToken: vi.fn(async () => 'shared-agent-token'),
    } as any));
    const client = fakeClient({
      projectRoot: '/canonical/repo',
      taskBinding: { taskId: 'task-own' },
    });
    const connect = vi.fn(async (_options: Parameters<typeof ControlClient.connectCanonical>[0]) => client);

    const borrowed = await createMcpControlClientForRoot('/repo-link', {
      canonicalize,
      credentialStoreForCanonicalRoot,
      connect,
      taskBinding: { taskId: 'task-own', token: 'task-token' },
      entryPath: '/entry.js',
    });

    expect(credentialStoreForCanonicalRoot).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot: '/canonical/repo',
      token: 'task-token',
      taskBinding: { taskId: 'task-own' },
    }));
    expect(borrowed.taskBinding).toEqual({ taskId: 'task-own' });
    await borrowed.close();
  });

  it('reuses only an identical task credential, invalidates revoked cache entries, and fails closed for a shared token', async () => {
    const projectRoot = await scratchProject();
    const harness = await createTaskScopedControlHarness({
      projectRoot,
      endpoint: controlEndpointForProject(projectRoot),
    });
    integrationCleanups.push(() => harness.server.close());
    const connect = vi.fn(async (options: Parameters<typeof ControlClient.connectCanonical>[0]) => (
      ControlClient.connectCanonical(options)
    ));

    const first = await createMcpControlClientForRoot(projectRoot, {
      connect,
      taskBinding: {
        taskId: harness.ownTaskId,
        subjectId: harness.ownSubjectId,
        token: harness.ownTaskToken,
      },
      entryPath: '/entry.js',
    });
    const reused = await createMcpControlClientForRoot(projectRoot, {
      connect,
      taskBinding: {
        taskId: harness.ownTaskId,
        subjectId: harness.ownSubjectId,
        token: harness.ownTaskToken,
      },
      entryPath: '/entry.js',
    });
    expect(connect).toHaveBeenCalledTimes(1);

    const rotated = await issueControlTaskCredential({
      projectRoot,
      filePath: path.join(projectRoot, 'control-credentials.json'),
      taskId: harness.ownTaskId,
      previousSubjectId: harness.ownSubjectId,
      stateRoot: harness.stateRoot,
    });
    const distinctCredential = await createMcpControlClientForRoot(projectRoot, {
      connect,
      taskBinding: {
        taskId: harness.ownTaskId,
        subjectId: rotated.taskBinding.subjectId,
        token: rotated.token,
      },
      entryPath: '/entry.js',
    });
    expect(connect).toHaveBeenCalledTimes(2);

    await expect(first.getState()).rejects.toThrow(/unauthorized|closed|token/i);
    await expect(createMcpControlClientForRoot(projectRoot, {
      connect,
      taskBinding: {
        taskId: harness.ownTaskId,
        subjectId: harness.ownSubjectId,
        token: harness.ownTaskToken,
      },
      entryPath: '/entry.js',
    }).then(async (client) => {
      try {
        return await client.getState();
      } finally {
        await client.close().catch(() => undefined);
      }
    })).rejects.toThrow(/invalid control token|unauthorized|closed/i);
    expect(connect).toHaveBeenCalledTimes(3);

    await expect(createMcpControlClientForRoot(projectRoot, {
      connect,
      taskBinding: { taskId: harness.ownTaskId, token: await harness.credentials.agentToken() },
      entryPath: '/entry.js',
    })).rejects.toThrow(/task binding/i);
    expect(connect).toHaveBeenCalledTimes(4);

    const snapshot = await distinctCredential.getState();
    expect(snapshot.resources).toEqual([]);
    expect(snapshot.capabilityLeases).toEqual([]);

    await expect(revokeControlTaskCredential({
      projectRoot,
      filePath: path.join(projectRoot, 'control-credentials.json'),
      taskId: harness.ownTaskId,
      subjectId: rotated.taskBinding.subjectId,
      stateRoot: harness.stateRoot,
    })).resolves.toEqual({
      principalId: rotated.principalId,
      taskBinding: rotated.taskBinding,
    });
    await expect(distinctCredential.getState()).rejects.toThrow(/unauthorized|closed|token/i);
    await expect(createMcpControlClientForRoot(projectRoot, {
      connect,
      taskBinding: {
        taskId: harness.ownTaskId,
        subjectId: rotated.taskBinding.subjectId,
        token: rotated.token,
      },
      entryPath: '/entry.js',
    }).then(async (client) => {
      try {
        return await client.getState();
      } finally {
        await client.close().catch(() => undefined);
      }
    })).rejects.toThrow(/invalid control token|unauthorized|closed/i);
    expect(connect).toHaveBeenCalledTimes(5);

    await Promise.all([distinctCredential.close(), reused.close(), first.close()]);
  });

  it('separates cached task-bound clients for different valid task bindings', async () => {
    const projectRoot = await scratchProject();
    const harness = await createTaskScopedControlHarness({
      projectRoot,
      endpoint: controlEndpointForProject(projectRoot),
    });
    integrationCleanups.push(() => harness.server.close());
    const connect = vi.fn(async (options: Parameters<typeof ControlClient.connectCanonical>[0]) => (
      ControlClient.connectCanonical(options)
    ));

    const own = await createMcpControlClientForRoot(projectRoot, {
      connect,
      taskBinding: { taskId: harness.ownTaskId, token: harness.ownTaskToken },
      entryPath: '/entry.js',
    });
    const other = await createMcpControlClientForRoot(projectRoot, {
      connect,
      taskBinding: { taskId: harness.otherTaskId, token: harness.otherTaskToken },
      entryPath: '/entry.js',
    });

    expect(connect).toHaveBeenCalledTimes(2);
    expect((await own.getState()).resources.map((resource) => resource.id).sort())
      .toEqual([harness.ownPane.id, harness.ownTab.id].sort());
    expect((await other.getState()).resources.map((resource) => resource.id).sort())
      .toEqual([harness.otherPane.id, harness.otherTab.id].sort());

    await Promise.all([own.close(), other.close()]);
  });

  it('maps an unavailable action transaction to unknown', async () => {
    inject({ controlClientForRoot: vi.fn(async () => fakeClient({
      actionStatus: vi.fn(async () => undefined),
    })) });

    expect(payload(await call('psyche_control_action_status', {
      action_id: 'missing-action', task_id: 'task-1', project_root: '/repo',
    }))).toEqual({ status: 'unknown', action_id: 'missing-action' });
  });

  it('serializes replayed action status receipts without inventing live resource ids', async () => {
    inject({ controlClientForRoot: vi.fn(async () => fakeClient({
      actionStatus: vi.fn(async () => ({
        schema: 'psyche.control.receipt/v1',
        actionId: 'replayed-action',
        state: 'failed',
        resource: { kind: 'browser_tab', idDigest: 'f'.repeat(64), generation: 1 },
        createdAt: '2026-08-12T00:00:00.000Z',
        completedAt: '2026-08-12T00:00:01.000Z',
        code: 'action_invalidated',
      })),
    })) });

    const status = payload(await call('psyche_control_action_status', {
      action_id: 'replayed-action',
      task_id: 'task-1',
      project_root: '/repo',
    }));
    expect(status).toMatchObject({
      schema: 'psyche.control.receipt/v1',
      actionId: 'replayed-action',
      state: 'failed',
      resource: { kind: 'browser_tab', idDigest: 'f'.repeat(64), generation: 1 },
      code: 'action_invalidated',
    });
    expect(status.resource).not.toHaveProperty('id');
  });

  it('releases the control client after every tool operation', async () => {
    const close = vi.fn(async () => undefined);
    inject({ controlClientForRoot: vi.fn(async () => fakeClient({
      close,
      getState: vi.fn(async () => ({
        ownerEpoch: 1, sequence: 0, commands: {}, leases: {}, resources: [],
        capabilityLeases: [], leaseRequests: [], approvals: [], receipts: [],
      })),
    })) });

    await call('psyche_control_list', { project_root: '/repo', task_id: 'task-1' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('single-flights 32 concurrent cold starts and closes the shared client once', async () => {
    const canonicalize = vi.fn(async () => '/canonical/repo');
    const underlying = fakeClient({ projectRoot: '/canonical/repo' });
    const connect = vi.fn()
      .mockRejectedValueOnce(connectionError('ENOENT'))
      .mockResolvedValueOnce(underlying);
    const spawn = vi.fn(() => ({ unref: vi.fn() } as never));
    const credentials = { agentToken: vi.fn(async () => 'token') } as any;
    let now = 0;
    const options = {
      canonicalize,
      credentialStoreForCanonicalRoot: vi.fn(async () => credentials),
      connect,
      spawn,
      now: () => now,
      sleep: async (delay: number) => { now += delay; },
      entryPath: '/entry.js',
    };

    const borrowed = await Promise.all(Array.from(
      { length: 32 },
      () => createMcpControlClientForRoot('/repo-link', options),
    ));

    expect(spawn).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(options.credentialStoreForCanonicalRoot).toHaveBeenCalledTimes(32);
    expect(credentials.agentToken).toHaveBeenCalledTimes(32);
    await Promise.all(borrowed.map((client) => client.close()));
    expect(underlying.close).toHaveBeenCalledOnce();
  });

  it('does not coalesce concurrent shared-agent credential loads before token identity is known', async () => {
    const projectRoot = await scratchProject();
    const harness = await createTaskScopedControlHarness({
      projectRoot,
      endpoint: controlEndpointForProject(projectRoot),
    });
    integrationCleanups.push(() => harness.server.close());
    const sharedAgentToken = await harness.credentials.agentToken();

    let releaseBadTokenLoad!: () => void;
    let markBadTokenLoadStarted!: () => void;
    let markGoodTokenLoadStarted!: () => void;
    const badTokenLoadStarted = new Promise<void>((resolve) => { markBadTokenLoadStarted = resolve; });
    const goodTokenLoadStarted = new Promise<void>((resolve) => { markGoodTokenLoadStarted = resolve; });
    const badTokenLoadBlocked = new Promise<void>((resolve) => { releaseBadTokenLoad = resolve; });
    let tokenLoadCount = 0;
    const agentToken = vi.fn(async () => {
      tokenLoadCount += 1;
      if (tokenLoadCount === 1) {
        markBadTokenLoadStarted();
        await badTokenLoadBlocked;
        return 'bad-token';
      }
      markGoodTokenLoadStarted();
      return sharedAgentToken;
    });
    const credentialStoreForCanonicalRoot = vi.fn(async () => ({ agentToken } as any));
    const connect = vi.fn(async (options: Parameters<typeof ControlClient.connectCanonical>[0]) => (
      ControlClient.connectCanonical(options)
    ));
    const bootstrap = {
      credentialStoreForCanonicalRoot,
      connect,
      entryPath: '/entry.js',
    };

    const rejected = createMcpControlClientForRoot(projectRoot, bootstrap);
    await badTokenLoadStarted;
    const succeeded = createMcpControlClientForRoot(projectRoot, bootstrap);
    await goodTokenLoadStarted;
    releaseBadTokenLoad();

    const [badResult, goodResult] = await Promise.allSettled([rejected, succeeded]);
    expect(credentialStoreForCanonicalRoot).toHaveBeenCalledTimes(2);
    expect(agentToken).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(new Set(connect.mock.calls.map(([options]) => options.token)))
      .toEqual(new Set(['bad-token', sharedAgentToken]));
    expect(badResult).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: expect.stringMatching(/unauthorized/i) }),
    });
    expect(goodResult.status).toBe('fulfilled');
    if (goodResult.status === 'fulfilled') {
      await goodResult.value.close();
    }
  });

  it('opens a fresh shared-agent client when the resolved token rotates', async () => {
    const firstClient = fakeClient({ projectRoot: '/canonical/repo' });
    const rotatedClient = fakeClient({ projectRoot: '/canonical/repo' });
    let token = 'token-1';
    const options = {
      canonicalize: async () => '/canonical/repo',
      credentialStoreForCanonicalRoot: vi.fn(async () => ({
        agentToken: async () => token,
      } as any)),
      connect: vi.fn(async ({ token: resolvedToken }: Parameters<typeof ControlClient.connectCanonical>[0]) => (
        resolvedToken === 'token-1' ? firstClient : rotatedClient
      )),
      entryPath: '/entry.js',
    };

    const first = await createMcpControlClientForRoot('/repo', options);
    const reused = await createMcpControlClientForRoot('/repo', options);
    expect(options.connect).toHaveBeenCalledTimes(1);

    token = 'token-2';
    const rotated = await createMcpControlClientForRoot('/repo', options);
    expect(options.connect).toHaveBeenCalledTimes(2);
    expect(options.credentialStoreForCanonicalRoot).toHaveBeenCalledTimes(3);

    await reused.close();
    await first.close();
    expect(firstClient.close).toHaveBeenCalledOnce();
    expect(rotatedClient.close).not.toHaveBeenCalled();

    await rotated.close();
    expect(rotatedClient.close).toHaveBeenCalledOnce();
  });

  it('server cleanup closes an outstanding shared control client', async () => {
    const underlying = fakeClient({ projectRoot: '/canonical/repo' });
    const borrowed = await createMcpControlClientForRoot('/repo', {
      canonicalize: async () => '/canonical/repo',
      credentialStoreForCanonicalRoot: async () => ({ agentToken: async () => 'token' } as any),
      connect: async () => underlying,
      entryPath: '/entry.js',
    });

    await closeMcpControlClients();
    expect(underlying.close).toHaveBeenCalledOnce();
    await borrowed.close();
    expect(underlying.close).toHaveBeenCalledOnce();
  });

  it('coalesces an authentication failure once and allows a fresh later attempt', async () => {
    const authFailure = new Error('authentication_failed: invalid credentials');
    const connect = vi.fn()
      .mockRejectedValueOnce(authFailure)
      .mockResolvedValueOnce(fakeClient({ projectRoot: '/canonical/repo' }));
    const options = {
      canonicalize: async () => '/canonical/repo',
      credentialStoreForCanonicalRoot: async () => ({ agentToken: async () => 'token' } as any),
      connect,
      spawn: vi.fn(),
      entryPath: '/entry.js',
    };

    const first = await Promise.allSettled(Array.from(
      { length: 8 },
      () => createMcpControlClientForRoot('/repo', options),
    ));
    expect(first.every((result) => result.status === 'rejected')).toBe(true);
    expect(connect).toHaveBeenCalledOnce();
    expect(options.spawn).not.toHaveBeenCalled();

    const recovered = await createMcpControlClientForRoot('/repo', options);
    expect(connect).toHaveBeenCalledTimes(2);
    await recovered.close();
  });

  it.each(taskScopedReadCases)('fails unbound non-operator $label closed before any control read', async (testCase) => {
    const client = testCase.createClient();
    const restore = setMcpDeps({ controlClientForRoot: vi.fn(async () => client) });
    try {
      const response = await call(testCase.name, testCase.args);
      expect(response.error).toBeUndefined();
      expect(payload(response)).toMatchObject({
        status: 'rejected',
        code: 'task_binding_required',
      });
      testCase.assertNotCalled(client);
    } finally {
      restore();
    }
  });

  it('reads own-task runtime state through a task-bound control client and denies cross-task probes', async () => {
    const projectRoot = await scratchProject();
    const harness = await createTaskScopedControlHarness({
      projectRoot,
      endpoint: controlEndpointForProject(projectRoot),
    });
    integrationCleanups.push(() => harness.server.close());
    inject({
      controlClientForRoot: vi.fn(async (root) => ControlClient.connect({
        projectRoot: root,
        endpoint: harness.endpoint,
        token: harness.ownTaskToken,
        clientName: 'psyche-mcp-test',
        taskBinding: { taskId: harness.ownTaskId },
      })),
    });

    const list = payload(await call('psyche_control_list', { project_root: projectRoot }));
    expect(list.resources.map((resource: { id: string }) => resource.id).sort())
      .toEqual([harness.ownPane.id, harness.ownTab.id].sort());
    expect(list.resources.map((resource: { id: string }) => resource.id)).not.toContain(harness.laneOnlyPane.id);
    expect(list.resources.map((resource: { id: string }) => resource.id)).not.toContain(harness.otherPane.id);
    expect(list.resources.map((resource: { id: string }) => resource.id)).not.toContain(harness.otherTab.id);
    expect(list.approvals).toEqual([expect.objectContaining({ actionId: harness.ownApprovalActionId })]);
    expect(list).not.toHaveProperty('receipts');

    const conflictingList = await call('psyche_control_list', {
      project_root: projectRoot,
      task_id: harness.otherTaskId,
    });
    expect(conflictingList.error).toMatchObject({
      code: -32602,
      message: expect.stringContaining('task_binding_mismatch'),
    });

    const granted = payload(await call('psyche_control_lease', {
      operation: 'status',
      request_id: harness.ownTabRequestId,
      project_root: projectRoot,
    }));
    expect(granted.leases).toEqual([expect.objectContaining({
      id: harness.ownTabLease.id,
      requestId: harness.ownTabRequestId,
      taskId: harness.ownTaskId,
    })]);
    expect(granted.requests).toEqual([]);

    const conflictingLeaseStatus = await call('psyche_control_lease', {
      operation: 'status',
      task_id: harness.otherTaskId,
      request_id: harness.ownTabRequestId,
      project_root: projectRoot,
    });
    expect(conflictingLeaseStatus.error).toMatchObject({
      code: -32602,
      message: expect.stringContaining('task_binding_mismatch'),
    });

    const pending = payload(await call('psyche_control_lease', {
      operation: 'status',
      request_id: harness.ownPaneRequestId,
      project_root: projectRoot,
    }));
    expect(pending.leases).toEqual([]);
    expect(pending.requests).toEqual([expect.objectContaining({
      id: harness.ownPaneRequestId,
      taskId: harness.ownTaskId,
    })]);

    const panes = payload(await call('psyche_list_panes', {
      project_root: projectRoot,
    }));
    expect(panes).toMatchObject({
      project_root: projectRoot,
      count: 1,
      panes: [expect.objectContaining({ id: harness.ownPane.id, generation: harness.ownPane.generation })],
    });
    const conflictingPanes = await call('psyche_list_panes', {
      project_root: projectRoot,
      task_id: harness.otherTaskId,
    });
    expect(conflictingPanes.error).toMatchObject({
      code: -32602,
      message: expect.stringContaining('task_binding_mismatch'),
    });

    const ownStatus = payload(await call('psyche_control_action_status', {
      project_root: projectRoot,
      action_id: harness.ownApprovalActionId,
    }));
    expect(ownStatus).toMatchObject({
      schema: 'psyche.control.receipt/v1',
      actionId: harness.ownApprovalActionId,
      state: 'approval_required',
    });
    expect(ownStatus).not.toHaveProperty('taskId');
    expect(ownStatus).not.toHaveProperty('leaseId');
    expect(ownStatus).not.toHaveProperty('leaseRevision');

    const conflictingOtherStatus = await call('psyche_control_action_status', {
      project_root: projectRoot,
      task_id: harness.otherTaskId,
      action_id: harness.otherApprovalActionId,
    });
    expect(conflictingOtherStatus.error).toMatchObject({
      code: -32602,
      message: expect.stringContaining('task_binding_mismatch'),
    });
    const conflictingLegacyStatus = await call('psyche_control_action_status', {
      project_root: projectRoot,
      task_id: harness.otherTaskId,
      action_id: harness.legacyActionId,
    });
    expect(conflictingLegacyStatus.error).toMatchObject({
      code: -32602,
      message: expect.stringContaining('task_binding_mismatch'),
    });
  });

  it('executes leased MCP orchestration through the daemon handler and rejects a stale lease first', async () => {
    const projectRoot = await scratchProject();
    const taskId = 'task-orchestration';
    const credentialPath = path.join(projectRoot, 'control-credentials.json');
    const stateRoot = testControlStateRoot(projectRoot);
    const credential = await issueControlTaskCredential({
      projectRoot,
      filePath: credentialPath,
      stateRoot,
      taskId,
    });
    const credentials = await createControlCredentialStore({
      projectRoot,
      filePath: credentialPath,
      stateRoot,
    });
    const completed = {
      taskId,
      traceId: 'trace-mcp',
      status: 'completed' as const,
      startedAt: '2026-08-17T12:00:00.000Z',
      completedAt: '2026-08-17T12:00:01.000Z',
      lanes: [],
    };
    const execute = vi.fn(async () => completed);
    const handlers = createDaemonControlHandlers({
      tmux: new TmuxControl('psyche-mcp-orchestration'),
      projectRoot,
      sessionName: 'psyche-mcp-orchestration',
      capabilityRouter: new AgenticCapabilityRouter({ strategies: [] }),
      orchestrator: { execute },
    });
    const host = await createHostControlPlane(projectRoot, {
      handlers,
      bootstrap: async () => undefined,
      readActiveTaskCredential: credentials.currentTaskCredential,
    });
    const endpoint = controlEndpointForProject(projectRoot);
    const server = await ControlServer.start({
      endpoint,
      projectRoot,
      ownerEpoch: host.epoch,
      runtime: host.runtime,
      credentials,
    });
    integrationCleanups.push(async () => {
      await server.close();
      await host.close();
    });
    inject({
      controlClientForRoot: vi.fn(async (root) => ControlClient.connect({
        projectRoot: root,
        endpoint,
        token: credential.token,
        clientName: 'psyche-mcp-orchestration',
        taskBinding: credential.taskBinding,
      })),
    });

    const grant = {
      requestId: 'request-orchestration',
      actorId: credential.principalId,
      taskId,
      grantedBy: 'operator-1',
      ttlMs: 60_000,
      grants: [{
        target: { kind: 'project' as const, id: projectRoot },
        capabilities: ['pane.create' as const],
      }],
    };
    const lease = host.runtime.capabilityLeases.grant(grant);
    const response = payload(await call('psyche_execute_task', {
      project_root: projectRoot,
      lease_id: lease.id,
      lease_revision: lease.revision,
      prompt: 'test',
      lanes: [{ id: 'one', mode: 'terminal' }],
    }));

    expect(response).toMatchObject({ status: 'succeeded', value: completed });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ taskId, projectRoot }));

    host.runtime.capabilityLeases.grant(grant);
    const stale = payload(await call('psyche_execute_task', {
      project_root: projectRoot,
      lease_id: lease.id,
      lease_revision: lease.revision,
      prompt: 'stale',
      lanes: [{ id: 'stale', mode: 'terminal' }],
    }));

    expect(stale).toMatchObject({ status: 'failed', code: 'lease_revision_mismatch' });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('reports restart-invalidated action status through operator and task-bound MCP clients', async () => {
    const projectRoot = await scratchProject();
    const harness = await createRestartActionStatusHarness({ projectRoot });
    integrationCleanups.push(() => harness.server.close());

    inject({
      controlClientForRoot: vi.fn(async (root) => ControlClient.connect({
        projectRoot: root,
        endpoint: harness.endpoint,
        token: harness.operatorToken,
        clientName: 'psyche-mcp-operator',
      })),
    });
    expect(payload(await call('psyche_control_action_status', {
      project_root: projectRoot,
      action_id: harness.ownActionId,
    }))).toMatchObject({
      schema: 'psyche.control.receipt/v1',
      actionId: harness.ownActionId,
      state: 'failed',
      code: 'action_invalidated',
    });
    expect(payload(await call('psyche_control_action_status', {
      project_root: projectRoot,
      action_id: harness.legacyActionId,
    }))).toMatchObject({
      schema: 'psyche.control.receipt/v1',
      actionId: harness.legacyActionId,
      state: 'failed',
      code: 'action_invalidated',
    });

    inject({
      controlClientForRoot: vi.fn(async (root) => ControlClient.connect({
        projectRoot: root,
        endpoint: harness.endpoint,
        token: harness.ownTaskToken,
        clientName: 'psyche-mcp-own-task',
        taskBinding: { taskId: harness.ownTaskId },
      })),
    });
    const ownStatus = payload(await call('psyche_control_action_status', {
      project_root: projectRoot,
      action_id: harness.ownActionId,
    }));
    expect(ownStatus).toMatchObject({
      schema: 'psyche.control.receipt/v1',
      actionId: harness.ownActionId,
      state: 'failed',
      code: 'action_invalidated',
    });
    expect(ownStatus).not.toHaveProperty('taskId');
    expect(ownStatus).not.toHaveProperty('leaseId');
    expect(ownStatus).not.toHaveProperty('leaseRevision');
    expect(payload(await call('psyche_control_action_status', {
      project_root: projectRoot,
      action_id: harness.legacyActionId,
    }))).toEqual({ status: 'unknown', action_id: harness.legacyActionId });

    inject({
      controlClientForRoot: vi.fn(async (root) => ControlClient.connect({
        projectRoot: root,
        endpoint: harness.endpoint,
        token: harness.otherTaskToken,
        clientName: 'psyche-mcp-other-task',
        taskBinding: { taskId: harness.otherTaskId },
      })),
    });
    expect(payload(await call('psyche_control_action_status', {
      project_root: projectRoot,
      action_id: harness.ownActionId,
    }))).toEqual({ status: 'unknown', action_id: harness.ownActionId });
  });

  it('returns task-bound validation receipts only to the owning MCP subject', async () => {
    const projectRoot = await scratchProject();
    const endpoint = controlEndpointForProject(projectRoot);
    const harness = await createTaskScopedControlHarness({ projectRoot, endpoint });
    integrationCleanups.push(() => harness.server.close());

    const randomIds = ['stale-revision-action', 'replaced-generation-action'];
    inject({ randomId: vi.fn(() => randomIds.shift() ?? 'extra-action') });

    const callAs = async (
      token: string,
      clientName: string,
      taskBinding: { taskId: string; subjectId: string } | undefined,
      name: string,
      args: Record<string, unknown>,
    ) => {
      inject({
        controlClientForRoot: vi.fn(async (root) => ControlClient.connect({
          projectRoot: root,
          endpoint: harness.endpoint,
          token,
          clientName,
          ...(taskBinding ? { taskBinding } : {}),
        })),
      });
      return payload(await call(name, args));
    };

    const expectScopedStatus = async (
      actionId: string,
      expected: Record<string, unknown>,
    ) => {
      expect(await callAs(
        await harness.credentials.operatorToken(),
        'psyche-mcp-operator',
        undefined,
        'psyche_control_action_status',
        { project_root: projectRoot, action_id: actionId },
      )).toMatchObject(expected);
      const ownStatus = await callAs(
        harness.ownTaskToken,
        'psyche-mcp-own-task',
        { taskId: harness.ownTaskId, subjectId: harness.ownSubjectId },
        'psyche_control_action_status',
        { project_root: projectRoot, action_id: actionId },
      );
      expect(ownStatus).toMatchObject(expected);
      expect(ownStatus).not.toHaveProperty('taskId');
      expect(ownStatus).not.toHaveProperty('actorId');
      expect(await callAs(
        harness.otherTaskToken,
        'psyche-mcp-other-task',
        { taskId: harness.otherTaskId, subjectId: harness.otherSubjectId },
        'psyche_control_action_status',
        { project_root: projectRoot, action_id: actionId },
      )).toEqual({ status: 'unknown', action_id: actionId });
    };

    const renewedLease = harness.runtime.capabilityLeases.grant({
      requestId: harness.ownTabRequestId,
      actorId: harness.ownPrincipalId,
      taskId: harness.ownTaskId,
      grantedBy: 'operator-1',
      ttlMs: 60_000,
      grants: [{
        target: { kind: 'browser_tab', id: harness.ownTab.id, generation: harness.ownTab.generation },
        capabilities: ['browser.interact'],
      }],
    });
    expect(renewedLease.revision).toBe(harness.ownTabLease.revision + 1);

    expect(await callAs(
      harness.ownTaskToken,
      'psyche-mcp-own-task',
      { taskId: harness.ownTaskId, subjectId: harness.ownSubjectId },
      'psyche_browser_action',
      {
        project_root: projectRoot,
        lease_id: harness.ownTabLease.id,
        lease_revision: harness.ownTabLease.revision,
        tab_id: harness.ownTab.id,
        generation: harness.ownTab.generation,
        action: { kind: 'reload' },
      },
    )).toMatchObject({ status: 'failed', code: 'action_validation_failed' });
    await expectScopedStatus('stale-revision-action', {
      schema: 'psyche.control.receipt/v1',
      actionId: 'stale-revision-action',
      state: 'failed',
      code: 'action_validation_failed',
    });

    await harness.runtime.submit({
      id: 'replace-own-tab',
      idempotencyKey: 'replace-own-tab',
      kind: 'provider.resource.upsert',
      projectRoot,
      actor: { id: 'operator-1', kind: 'human' },
      ownerEpoch: harness.runtime.snapshot().ownerEpoch,
      createdAt: new Date().toISOString(),
      payload: { resource: { ...harness.ownTab, webviewLabel: 'own-replacement' } },
    } as ControlCommand);

    expect(await callAs(
      harness.ownTaskToken,
      'psyche-mcp-own-task',
      { taskId: harness.ownTaskId, subjectId: harness.ownSubjectId },
      'psyche_browser_action',
      {
        project_root: projectRoot,
        lease_id: renewedLease.id,
        lease_revision: renewedLease.revision,
        tab_id: harness.ownTab.id,
        generation: harness.ownTab.generation,
        action: { kind: 'reload' },
      },
    )).toMatchObject({ status: 'failed', code: 'action_validation_failed' });
    await expectScopedStatus('replaced-generation-action', {
      schema: 'psyche.control.receipt/v1',
      actionId: 'replaced-generation-action',
      state: 'failed',
      code: 'action_validation_failed',
    });
  });

  it('contains no direct mutation dependencies', () => {
    const source = readFileSync(new URL('../src/mcp/server.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/spawnBridgePane|killBridgePane|TmuxControl|execFileSync/);
  });
});

function connectionError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}
