import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOOLS, handleMcpRequest, setMcpDeps } from '../src/mcp/server.js';

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
  vi.restoreAllMocks();
});

async function call(name: string, args: Record<string, unknown>) {
  return await handleMcpRequest({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
  }) as { result?: any; error?: { code: number; message: string; data?: unknown } };
}

function payload(response: { result?: any }): any {
  return JSON.parse(response.result.content[0].text);
}

function client(overrides: Record<string, unknown> = {}) {
  return {
    principal: { id: 'agent', kind: 'agent', capabilities: ['read', 'mutate'] },
    getState: vi.fn(async () => ({ ownerEpoch: 2, sequence: 1, resources: [] })),
    submit: vi.fn(async () => ({ status: 'succeeded', value: { ok: true } })),
    actionStatus: vi.fn(async () => undefined),
    ...overrides,
  } as any;
}

function injectControl(control: any) {
  const controlClientForRoot = vi.fn(async () => control);
  restores.push(setMcpDeps({ controlClientForRoot }));
  return controlClientForRoot;
}

const root = process.cwd();
const lease = { task_id: 'task-1', lease_id: 'lease-1', lease_revision: 3 };

describe('canonical MCP agent control', () => {
  it('pins required schema fields without mutation auth inputs', () => {
    const byName = new Map(TOOLS.map((tool) => [tool.name, tool.inputSchema as any]));
    expect(byName.get('psyche_control_list').required).toEqual(['project_root']);
    expect(byName.get('psyche_pane_observe').required).toEqual([
      'project_root', 'task_id', 'lease_id', 'lease_revision', 'pane_id', 'generation',
    ]);
    expect(byName.get('psyche_browser_script').required).toEqual([
      'project_root', 'task_id', 'lease_id', 'lease_revision', 'tab_id', 'generation', 'source',
    ]);
    expect(byName.get('psyche_pane_action').oneOf.map((branch: any) => branch.required)).toEqual([
      ['project_root', 'task_id', 'lease_id', 'lease_revision', 'pane_id', 'generation', 'action'],
      ['project_root', 'task_id', 'lease_id', 'lease_revision', 'project_id', 'action'],
    ]);
    expect(byName.get('psyche_browser_action').oneOf).toHaveLength(2);
    for (const tool of TOOLS) {
      expect(Object.keys((tool.inputSchema as any).properties ?? {})).not.toContain('token');
      expect(Object.keys((tool.inputSchema as any).properties ?? {})).not.toContain('owner_epoch');
      expect(Object.keys((tool.inputSchema as any).properties ?? {})).not.toContain('actor');
    }
  });

  it('states that generic click application effects cannot be perfectly predicted', () => {
    const tool = TOOLS.find((candidate) => candidate.name === 'psyche_browser_action');
    expect(tool?.description).toContain('application-defined effects behind a generic click cannot be perfectly predicted');
  });

  it('warns that every browser script invocation requires a new approval', () => {
    const tool = TOOLS.find((candidate) => candidate.name === 'psyche_browser_script');
    expect(tool?.description).toContain('Every invocation requires a new operator approval');
  });

  it('rejects malformed target/action shapes before creating a control client', async () => {
    const controlClientForRoot = vi.fn();
    restores.push(setMcpDeps({ controlClientForRoot }));

    const response = await call('psyche_browser_action', {
      project_root: root, ...lease, tab_id: 'tab-1', generation: 5,
      action: { kind: 'click' },
    });

    expect(response.error?.code).toBe(-32602);
    expect(controlClientForRoot).not.toHaveBeenCalled();
  });

  it.each([
    ['extra top-level field', 'psyche_pane_observe', { ...lease, pane_id: 'pane-1', generation: 1, surprise: true }],
    ['extra nested field', 'psyche_pane_action', { ...lease, pane_id: 'pane-1', generation: 1, action: { kind: 'focus', surprise: true } }],
    ['wrong nested type', 'psyche_pane_action', { ...lease, pane_id: 'pane-1', generation: 1, action: { kind: 'send_keys', keys: ['Enter', 1] } }],
    ['missing action field', 'psyche_browser_action', { ...lease, tab_id: 'tab-1', generation: 1, snapshot_id: 's', action: { kind: 'type', elementRef: 'n' } }],
    ['extra grant target field', 'psyche_control_lease', {
      operation: 'request', task_id: 'task-1', ttl_ms: 1000,
      grants: [{ target: { kind: 'pane', id: 'pane-1', generation: 1, extra: true }, capabilities: ['pane.observe'] }],
    }],
  ])('rejects %s before connection', async (_label, tool, args) => {
    const controlClientForRoot = vi.fn();
    restores.push(setMcpDeps({ controlClientForRoot }));
    const response = await call(tool, { project_root: root, ...args } as any);
    expect(response.error).toMatchObject({ code: -32602, message: 'Invalid tool arguments' });
    expect(controlClientForRoot).not.toHaveBeenCalled();
  });

  it('uses recursively closed schemas for object and array inputs', () => {
    const canonical = TOOLS.filter((tool) => tool.name.startsWith('psyche_'));
    const visit = (schema: any): void => {
      if (!schema || typeof schema !== 'object') return;
      if (schema.type === 'object') expect(schema.additionalProperties).toBe(false);
      if (schema.type === 'array') expect(schema.items).toBeTruthy();
      for (const child of Object.values(schema.properties ?? {})) visit(child);
      for (const child of schema.oneOf ?? []) visit(child);
      if (schema.items) visit(schema.items);
    };
    canonical.forEach((tool) => visit(tool.inputSchema));
  });

  it('lists canonical live state through the project control client', async () => {
    const state = { ownerEpoch: 8, sequence: 4, resources: [{ id: 'pane-1', generation: 2 }] };
    const control = client({ getState: vi.fn(async () => state) });
    const connect = injectControl(control);
    await expect(call('psyche_control_list', { project_root: root }).then(payload)).resolves.toEqual(state);
    expect(connect).toHaveBeenCalledWith(root);
  });

  it('allows lease request, status, and release only', async () => {
    const control = client({
      getState: vi.fn(async () => ({
        capabilityLeases: [{ id: 'lease-1', taskId: 'task-1' }],
        leaseRequests: [{ id: 'request-1', taskId: 'task-1' }],
      })),
    });
    injectControl(control);

    await call('psyche_control_lease', {
      project_root: root, operation: 'request', task_id: 'task-1', ttl_ms: 1000,
      grants: [{ target: { kind: 'pane', id: 'pane-1', generation: 2 }, capabilities: ['pane.observe'] }],
    });
    await expect(call('psyche_control_lease', {
      project_root: root, operation: 'status', task_id: 'task-1',
    }).then(payload)).resolves.toEqual({
      leases: [{ id: 'lease-1', taskId: 'task-1' }],
      requests: [{ id: 'request-1', taskId: 'task-1' }],
    });
    await call('psyche_control_lease', {
      project_root: root, operation: 'release', ...lease,
    });

    expect(control.submit.mock.calls.map(([command]: any[]) => command.kind)).toEqual([
      'lease.request', 'lease.release',
    ]);
    for (const operation of ['grant', 'revoke', 'approve']) {
      expect((await call('psyche_control_lease', { project_root: root, operation })).error?.code)
        .toBe(-32602);
    }
  });

  it.each([
    ['psyche_pane_observe', { ...lease, pane_id: 'pane-1', generation: 2, after_sequence: 4 }, 'pane.observe'],
    ['psyche_pane_action', { ...lease, pane_id: 'pane-1', generation: 2, action: { kind: 'focus' } }, 'pane.action'],
    ['psyche_browser_inspect', { ...lease, tab_id: 'tab-1', generation: 5, include_screenshot: true }, 'browser.inspect'],
    ['psyche_browser_action', { ...lease, tab_id: 'tab-1', generation: 5, snapshot_id: 'snap-1', action: { kind: 'click', elementRef: 'n1' } }, 'browser.action'],
    ['psyche_browser_script', { ...lease, tab_id: 'tab-1', generation: 5, source: 'return 1', args: {} }, 'browser.script'],
  ])('routes %s as canonical %s and returns the live outcome unchanged', async (tool, args, kind) => {
    const outcome = { status: 'succeeded', value: { actionId: `action-${kind}`, text: 'ephemeral' } };
    const control = client({ submit: vi.fn(async () => outcome) });
    injectControl(control);
    await expect(call(tool, { project_root: root, ...args }).then(payload)).resolves.toEqual(outcome);
    expect(control.submit.mock.calls[0][0].kind).toBe(kind);
  });

  it('uses the canonical action.status request and returns its receipt unchanged', async () => {
    const receipt = {
      schema: 'psyche.control.receipt/v1', actionId: 'action-1', state: 'failed',
      resource: { kind: 'pane', id: 'pane-1', generation: 2 },
      createdAt: '2026-08-12T12:00:00.000Z', code: 'provider_unavailable',
    };
    const control = client({ actionStatus: vi.fn(async () => receipt) });
    injectControl(control);
    await expect(call('psyche_control_action_status', {
      project_root: root, action_id: 'action-1',
    }).then(payload)).resolves.toEqual(receipt);
    expect(control.actionStatus).toHaveBeenCalledWith('action-1');
  });

  it('preserves the pre-provider command_not_implemented outcome exactly', async () => {
    const outcome = {
      status: 'failed', code: 'command_not_implemented',
      message: 'surface command is not implemented',
    };
    injectControl(client({ submit: vi.fn(async () => outcome) }));
    await expect(call('psyche_browser_inspect', {
      project_root: root, ...lease, tab_id: 'tab-1', generation: 1,
    }).then(payload)).resolves.toEqual(outcome);
  });

  it('redacts raw control errors and paths from MCP responses', async () => {
    restores.push(setMcpDeps({
      controlClientForRoot: vi.fn(async () => {
        throw Object.assign(new Error('secret-token /private/project/path'), {
          code: 'control_protocol_error',
        });
      }),
    }));
    const response = await call('psyche_control_list', { project_root: root });
    expect(response.error).toMatchObject({
      code: -32603, message: 'control protocol error',
      data: { code: 'control_protocol_error' },
    });
    expect(JSON.stringify(response)).not.toMatch(/secret-token|private\/project/);
  });

  it.each(['success', 'error'])('closes each per-call client exactly once on %s', async (mode) => {
    const close = vi.fn(async () => undefined);
    const control = client({
      close,
      getState: mode === 'success'
        ? vi.fn(async () => ({ ownerEpoch: 1 }))
        : vi.fn(async () => { throw new Error('boom'); }),
    });
    injectControl(control);
    await call('psyche_control_list', { project_root: root });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rejects accessors, symbols, hidden fields, and prototype objects without invoking accessors', async () => {
    const getter = vi.fn(() => 'focus');
    const action: Record<string | symbol, unknown> = {};
    Object.defineProperty(action, 'kind', { enumerable: true, get: getter });
    Object.defineProperty(action, 'hidden', { enumerable: false, value: true });
    action[Symbol('extra')] = true;
    const controlClientForRoot = vi.fn();
    restores.push(setMcpDeps({ controlClientForRoot }));
    const response = await call('psyche_pane_action', {
      project_root: root, ...lease, pane_id: 'pane-1', generation: 1, action,
    });
    expect(response.error?.code).toBe(-32602);
    expect(getter).not.toHaveBeenCalled();
    expect(controlClientForRoot).not.toHaveBeenCalled();
  });

  it('accepts deeply nested frozen canonical JSON script args', async () => {
    const submit = vi.fn(async () => ({ status: 'succeeded' as const }));
    injectControl(client({ submit }));
    const args = Object.freeze({
      ok: true,
      nested: Object.freeze([null, 1, 'two', Object.freeze({ value: false })]),
    });
    await expect(call('psyche_browser_script', {
      project_root: root, ...lease, tab_id: 'tab-1', generation: 1,
      source: 'return args', args,
    }).then(payload)).resolves.toMatchObject({ status: 'succeeded' });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['sparse array', (() => { const value = new Array(2); value[1] = true; return value; })()],
    ['cycle', (() => { const value: any = {}; value.self = value; return value; })()],
    ['undefined', { value: undefined }],
    ['function', { value: () => true }],
    ['bigint', { value: 1n }],
    ['nonfinite', { value: Number.POSITIVE_INFINITY }],
    ['prototype', Object.create({ inherited: true })],
  ])('rejects non-canonical script args: %s', async (_label, args) => {
    const controlClientForRoot = vi.fn();
    restores.push(setMcpDeps({ controlClientForRoot }));
    const response = await call('psyche_browser_script', {
      project_root: root, ...lease, tab_id: 'tab-1', generation: 1,
      source: 'return args', args,
    });
    expect(response.error?.code).toBe(-32602);
    expect(controlClientForRoot).not.toHaveBeenCalled();
  });

  it('rejects script arg accessors, symbols, and hidden fields without invoking accessors', async () => {
    const getter = vi.fn(() => 'secret');
    const args: Record<string | symbol, unknown> = {};
    Object.defineProperty(args, 'value', { enumerable: true, get: getter });
    Object.defineProperty(args, 'hidden', { enumerable: false, value: true });
    args[Symbol('extra')] = true;
    const controlClientForRoot = vi.fn();
    restores.push(setMcpDeps({ controlClientForRoot }));
    const response = await call('psyche_browser_script', {
      project_root: root, ...lease, tab_id: 'tab-1', generation: 1,
      source: 'return args', args,
    });
    expect(response.error?.code).toBe(-32602);
    expect(getter).not.toHaveBeenCalled();
    expect(controlClientForRoot).not.toHaveBeenCalled();
  });

  it.each(['4294967295', '9007199254740991'])(
    'rejects script arg arrays with dropped numeric-looking key %s',
    async (key) => {
      const args: unknown[] = [true];
      Object.defineProperty(args, key, { enumerable: true, value: 'dropped' });
      const controlClientForRoot = vi.fn();
      restores.push(setMcpDeps({ controlClientForRoot }));
      const response = await call('psyche_browser_script', {
        project_root: root, ...lease, tab_id: 'tab-1', generation: 1,
        source: 'return args', args,
      });
      expect(response.error?.code).toBe(-32602);
      expect(controlClientForRoot).not.toHaveBeenCalled();
    },
  );

  it('rejects schema arrays with numeric-looking keys outside their length', async () => {
    const keys = ['Enter'];
    Object.defineProperty(keys, '4294967295', { enumerable: true, value: 'Escape' });
    const controlClientForRoot = vi.fn();
    restores.push(setMcpDeps({ controlClientForRoot }));
    const response = await call('psyche_pane_action', {
      project_root: root, ...lease, pane_id: 'pane-1', generation: 1,
      action: { kind: 'send_keys', keys },
    });
    expect(response.error?.code).toBe(-32602);
    expect(controlClientForRoot).not.toHaveBeenCalled();
  });

  it('contains no direct tmux, bridge mutation, or shell execution seam', () => {
    const source = readFileSync(new URL('../src/mcp/server.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/spawnBridgePane|killBridgePane|TmuxControl|execFileSync|ControlScope/);
  });
});
