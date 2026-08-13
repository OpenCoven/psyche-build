import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SERVER_NAME,
  TOOLS,
  handleMcpRequest,
  listLegacyWorktrees,
  setMcpDeps,
} from '../src/mcp/server.js';

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
  vi.restoreAllMocks();
});

function inject(next: Parameters<typeof setMcpDeps>[0]): void {
  restores.push(setMcpDeps(next));
}

async function call(name: string, args: Record<string, unknown> = {}) {
  return await handleMcpRequest({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
  }) as { result?: any; error?: { code: number; message: string } };
}

function payload(response: { result?: any }): any {
  return JSON.parse(response.result.content[0].text);
}

describe('MCP protocol and registry', () => {
  it('advertises the psyche server and canonical tools plus leased legacy aliases', async () => {
    const initialized = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect((initialized as any).result.serverInfo.name).toBe(SERVER_NAME);

    const listed = await handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect((listed as any).result.tools.map((tool: any) => tool.name)).toEqual([
      'psyche_control_list',
      'psyche_control_lease',
      'psyche_pane_observe',
      'psyche_pane_action',
      'psyche_browser_inspect',
      'psyche_browser_action',
      'psyche_browser_script',
      'psyche_control_action_status',
      'psyche_execute_task',
      'psyche_create_pane',
      'psyche_kill_pane',
      'psyche_list_panes',
      'psyche_get_pane_output',
      'psyche_list_rituals',
      'psyche_list_worktrees',
    ]);
  });

  it('documents exactly the eight canonical tools and both aliases', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    for (const tool of TOOLS) expect(readme).toContain(`\`${tool.name}\``);
  });

  it('returns method errors and ignores notifications', async () => {
    expect((await call('psyche_nope')).error?.code).toBe(-32601);
    await expect(handleMcpRequest({
      jsonrpc: '2.0', method: 'notifications/initialized',
    })).resolves.toBeNull();
  });
});

describe('read-only compatibility tools', () => {
  it('preserves pane listing and bounded capture without creating a control client', async () => {
    const controlClientForRoot = vi.fn();
    inject({
      controlClientForRoot,
      listPanes: vi.fn(async () => [{ id: '%1', cwd: '/repo', title: 'one' }] as any),
      capturePane: vi.fn(() => Buffer.from('\u001b[31mhello\u001b[0m')),
    });
    expect(payload(await call('psyche_list_panes', { project_root: process.cwd() })))
      .toMatchObject({ count: 1, panes: [{ id: '%1' }] });
    expect(payload(await call('psyche_get_pane_output', { pane_id: '%1', strip_ansi: true })))
      .toMatchObject({ pane_id: '%1', bytes: 14, content: 'hello' });
    expect(controlClientForRoot).not.toHaveBeenCalled();
  });

  it('preserves injected ritual and worktree reads', async () => {
    const builtin = { id: 'start', name: 'Start', scope: 'builtin' as const, projects: [] };
    const project = { id: 'local', name: 'Local', scope: 'project' as const, projects: [] };
    const worktrees = [
      { path: '/repo', head: 'abc', branch: 'refs/heads/main' },
      { path: '/repo/w', head: 'def', detached: true, locked: true },
    ];
    inject({
      listRitualsLegacy: vi.fn(() => ({ builtin: [builtin], project: [project] } as any)),
      listWorktreesLegacy: vi.fn(async () => worktrees),
    });
    expect(payload(await call('psyche_list_rituals', { project_root: process.cwd() })))
      .toEqual({
        project_root: process.cwd(), builtin: [builtin], project: [project], count: 2,
      });
    expect(payload(await call('psyche_list_worktrees', { project_root: process.cwd() })))
      .toEqual({ project_root: process.cwd(), count: 2, worktrees });
  });

  it('runs the legacy worktree read with exact formatting and a five-second timeout', async () => {
    const run = vi.fn(async () => ({ stdout: [
      'worktree /repo',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree /repo/w',
      'HEAD def',
      'detached',
      'locked reason ignored by legacy DTO',
      '',
    ].join('\n') }));

    await expect(listLegacyWorktrees('/repo', run as never)).resolves.toEqual([
      { path: '/repo', head: 'abc', branch: 'refs/heads/main' },
      { path: '/repo/w', head: 'def', detached: true, locked: true },
    ]);
    expect(run).toHaveBeenCalledWith(
      'git', ['-C', '/repo', 'worktree', 'list', '--porcelain'],
      { encoding: 'utf8', timeout: 5000 },
    );
  });
});

describe('leased compatibility aliases', () => {
  it('keeps execute_task listed but rejects without a canonical orchestration capability', async () => {
    const controlClientForRoot = vi.fn();
    inject({ controlClientForRoot });
    expect(payload(await call('psyche_execute_task', {
      prompt: 'compare implementations', lanes: [{ id: 'a', agent: 'codex' }],
    }))).toEqual({
      status: 'rejected', code: 'capability_denied',
      message: 'agent orchestration requires a capability that is not available on the canonical control surface',
    });
    expect(controlClientForRoot).not.toHaveBeenCalled();
  });
  it.each(['psyche_create_pane', 'psyche_kill_pane'])(
    '%s returns lease_missing without connecting when lease metadata is absent',
    async (name) => {
      const controlClientForRoot = vi.fn();
      inject({ controlClientForRoot });
      const result = payload(await call(name, name === 'psyche_create_pane'
        ? { project_root: process.cwd(), prompt: 'fix it', agent: 'codex' }
        : { project_root: process.cwd(), pane_id: 'pane-1', generation: 2 }));
      expect(result).toMatchObject({ status: 'rejected', code: 'lease_missing' });
      expect(controlClientForRoot).not.toHaveBeenCalled();
    },
  );

  it('translates create into a project-scoped pane.action', async () => {
    const submit = vi.fn(async () => ({ status: 'succeeded' as const, value: { actionId: 'a-1' } }));
    inject({ controlClientForRoot: vi.fn(async () => ({ submit } as any)) });
    const root = process.cwd();
    const result = payload(await call('psyche_create_pane', {
      project_root: root, project_id: root, task_id: 'task-1', lease_id: 'lease-1',
      lease_revision: 3, agent: 'codex', title: 'Fix',
    }));
    expect(result).toEqual({ status: 'succeeded', value: { actionId: 'a-1' } });
    expect((submit.mock.calls as any[][])[0][0]).toMatchObject({
      kind: 'pane.action',
      payload: {
        taskId: 'task-1', leaseId: 'lease-1', leaseRevision: 3, projectId: root,
        action: { kind: 'create', cwd: root, title: 'Fix', agent: 'codex' },
      },
    });
  });

  it('rejects a legacy create prompt explicitly instead of silently dropping it', async () => {
    const controlClientForRoot = vi.fn();
    inject({ controlClientForRoot });
    expect(payload(await call('psyche_create_pane', {
      project_root: process.cwd(), project_id: process.cwd(), task_id: 'task-1',
      lease_id: 'lease-1', lease_revision: 1, agent: 'codex', prompt: 'secret prompt',
    }))).toEqual({
      status: 'rejected', code: 'command_not_implemented',
      message: 'legacy create prompts are not supported by canonical pane creation',
    });
    expect(controlClientForRoot).not.toHaveBeenCalled();
  });

  it('translates kill into an existing-pane close with generation CAS', async () => {
    const submit = vi.fn(async () => ({ status: 'succeeded' as const, value: { actionId: 'a-2' } }));
    inject({ controlClientForRoot: vi.fn(async () => ({ submit } as any)) });
    const result = payload(await call('psyche_kill_pane', {
      project_root: process.cwd(), task_id: 'task-1', lease_id: 'lease-1', lease_revision: 4,
      pane_id: 'pane-1', generation: 9,
    }));
    expect(result).toEqual({ status: 'succeeded', value: { actionId: 'a-2' } });
    expect((submit.mock.calls as any[][])[0][0]).toMatchObject({
      kind: 'pane.action',
      payload: {
        taskId: 'task-1', leaseId: 'lease-1', leaseRevision: 4,
        paneId: 'pane-1', generation: 9, action: { kind: 'close' },
      },
    });
  });
});
