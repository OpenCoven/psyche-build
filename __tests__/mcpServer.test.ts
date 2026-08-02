import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  SERVER_NAME,
  TOOLS,
  handleMcpRequest,
  setMcpDeps,
} from '../src/mcp/server.js';

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
  vi.restoreAllMocks();
});

function inject(next: Parameters<typeof setMcpDeps>[0]) {
  restores.push(setMcpDeps(next));
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const response = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  return response as { result?: any; error?: { code: number; message: string } };
}

/** tools/call wraps results in a single JSON text block. */
function payload(response: { result?: any }) {
  return JSON.parse(response.result.content[0].text);
}

describe('MCP tool registry', () => {
  it('advertises the psyche server name', async () => {
    const response = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect((response as any).result.serverInfo.name).toBe(SERVER_NAME);
  });

  it('lists every tool', async () => {
    const response = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect((response as any).result.tools.map((t: any) => t.name).sort()).toEqual([
      'psyche_create_pane',
      'psyche_get_pane_output',
      'psyche_kill_pane',
      'psyche_list_panes',
      'psyche_list_rituals',
      'psyche_list_worktrees',
    ]);
  });

  // These tools shipped as stubs that threw. Nothing may claim to be unwired.
  it('advertises no stub or unimplemented tools', () => {
    for (const tool of TOOLS) {
      expect(tool.description).not.toMatch(/STUB|wiring in progress|not yet wired|coming in the next/i);
    }
  });

  // This repo has drifted twice between documented and real behaviour (the
  // hook env-var table, and the agent count). The MCP surface is the contract
  // other agents dispatch on, so pin the README against the registry.
  it('documents exactly the tools it implements', async () => {
    const { readFileSync } = await import('node:fs');
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const documented = [...new Set(
      [...readme.matchAll(/`(psyche_[a-z_]+)`/g)].map((m) => m[1]),
    )].sort();

    expect(documented).toEqual(TOOLS.map((t) => t.name).sort());
  });

  it('returns a JSON-RPC error for an unknown tool', async () => {
    const response = await call('psyche_nope');
    expect(response.error?.code).toBe(-32601);
  });

  it('returns null for notifications', async () => {
    expect(await handleMcpRequest({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })).toBeNull();
  });
});

describe('psyche_create_pane', () => {
  it('spawns a pane through the bridge and returns its identity', async () => {
    const spawnPane = vi.fn(async () => ({
      id: '%7',
      pane: { id: '%7', title: 'fix-auth' } as any,
      worktreePath: '/repo/.psyche/worktrees/fix-auth',
      branch: 'psyche/fix-auth',
    }));
    inject({ spawnPane, sessionNameForRoot: () => 'psyche-repo' });

    const body = payload(await call('psyche_create_pane', {
      prompt: 'Fix the failing auth tests',
      agent: 'coven-code',
      project_root: '/repo',
    }));

    expect(spawnPane).toHaveBeenCalledTimes(1);
    const [projectRoot, sessionName, request] = spawnPane.mock.calls[0] as any[];
    expect(projectRoot).toBe('/repo');
    expect(sessionName).toBe('psyche-repo');
    expect(request).toMatchObject({
      agent: 'coven-code',
      prompt: 'Fix the failing auth tests',
      cwd: '/repo',
    });

    expect(body).toMatchObject({
      pane_id: '%7',
      worktree_path: '/repo/.psyche/worktrees/fix-auth',
      branch: 'psyche/fix-auth',
    });
  });

  it('passes an explicit branch and title through', async () => {
    const spawnPane = vi.fn(async () => ({
      id: '%1', pane: {} as any, worktreePath: '/w', branch: 'custom',
    }));
    inject({ spawnPane, sessionNameForRoot: () => 's' });

    await call('psyche_create_pane', {
      prompt: 'p', agent: 'coven-code', branch: 'custom', title: 'My Lane', project_root: '/repo',
    });

    expect((spawnPane.mock.calls[0] as any[])[2]).toMatchObject({
      branch: 'custom',
      title: 'My Lane',
    });
  });

  it.each([
    ['prompt', { agent: 'coven-code' }],
    ['agent', { prompt: 'do a thing' }],
  ])('rejects a call missing %s', async (_field, args) => {
    inject({ spawnPane: vi.fn(), sessionNameForRoot: () => 's' });
    const response = await call('psyche_create_pane', args);
    expect(response.error?.code).toBe(-32602);
  });

  it('rejects a blank prompt rather than launching an empty lane', async () => {
    const spawnPane = vi.fn();
    inject({ spawnPane, sessionNameForRoot: () => 's' });

    const response = await call('psyche_create_pane', { prompt: '   ', agent: 'coven-code' });

    expect(response.error?.code).toBe(-32602);
    expect(spawnPane).not.toHaveBeenCalled();
  });

  it('surfaces bridge failures as JSON-RPC errors', async () => {
    inject({
      spawnPane: vi.fn(async () => {
        throw Object.assign(new Error('psyche tmux session is not running'), {
          code: 'tmux_session_missing',
        });
      }),
      sessionNameForRoot: () => 's',
    });

    const response = await call('psyche_create_pane', { prompt: 'p', agent: 'coven-code' });
    expect(response.error?.message).toMatch(/tmux session is not running/);
  });
});

describe('psyche_kill_pane', () => {
  it('kills the pane and reports what was left behind', async () => {
    const killPane = vi.fn(async () => ({
      id: 'psyche-1',
      paneId: '%3',
      killed: true,
      worktreePath: '/repo/.psyche/worktrees/fix-auth',
      branch: 'psyche/fix-auth',
    }));
    inject({ killPane });

    const body = payload(await call('psyche_kill_pane', { pane_id: '%3', project_root: '/repo' }));

    expect(killPane).toHaveBeenCalledWith('/repo', '%3');
    expect(body).toMatchObject({
      pane_id: '%3',
      killed: true,
      worktree_path: '/repo/.psyche/worktrees/fix-auth',
      branch: 'psyche/fix-auth',
    });
  });

  // The tool must never be a route to destroying uncommitted work.
  it('states that the worktree and branch survive', async () => {
    inject({
      killPane: vi.fn(async () => ({
        id: 'psyche-1', paneId: '%3', killed: true,
        worktreePath: '/w', branch: 'b',
      })),
    });

    const body = payload(await call('psyche_kill_pane', { pane_id: '%3' }));
    expect(body.note).toMatch(/left in place/i);

    const tool = TOOLS.find((t) => t.name === 'psyche_kill_pane')!;
    expect(tool.description).toMatch(/does NOT delete/i);
    expect(tool.description).not.toMatch(/clean up its worktree/i);
  });

  it('reports killed:false when the tmux pane was already gone', async () => {
    inject({
      killPane: vi.fn(async () => ({ id: 'psyche-1', paneId: '%3', killed: false })),
    });
    expect(payload(await call('psyche_kill_pane', { pane_id: '%3' })).killed).toBe(false);
  });

  it('rejects a missing pane_id', async () => {
    const killPane = vi.fn();
    inject({ killPane });

    const response = await call('psyche_kill_pane', {});

    expect(response.error?.code).toBe(-32602);
    expect(killPane).not.toHaveBeenCalled();
  });

  it('surfaces an unregistered pane as an error', async () => {
    inject({
      killPane: vi.fn(async () => {
        throw Object.assign(new Error('pane is not registered in this psyche project'), {
          code: 'pane_not_found',
        });
      }),
    });

    const response = await call('psyche_kill_pane', { pane_id: '%99' });
    expect(response.error?.message).toMatch(/not registered/);
  });
});
