import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const mainJs = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/main.js'),
  'utf8',
);
const indexHtml = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/index.html'),
  'utf8',
);
const stylesCss = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/styles.css'),
  'utf8',
);
void indexHtml;
void stylesCss;

function functionSource(name: string) {
  const asyncStart = mainJs.indexOf(`async function ${name}(`);
  const syncStart = mainJs.indexOf(`function ${name}(`);
  const start = asyncStart === -1 ? syncStart : asyncStart;
  if (start === -1) throw new Error(`missing function ${name}`);
  const bodyStart = mainJs.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < mainJs.length; index += 1) {
    if (mainJs[index] === '{') depth += 1;
    if (mainJs[index] === '}') depth -= 1;
    if (depth === 0) return mainJs.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function compileFunction<T extends (...args: never[]) => unknown>(
  source: string,
  dependencies: Record<string, unknown>,
) {
  const names = Object.keys(dependencies);
  const values = Object.values(dependencies);
  return Function(...names, `"use strict"; return (${source});`)(...values) as T;
}

describe('Tauri agent picker', () => {
  it('offers the fixed launch registry in product order', () => {
    const agentLaunchOptions = compileFunction<() => Array<Record<string, unknown>>>(
      functionSource('agentLaunchOptions'),
      {},
    );

    expect(agentLaunchOptions()).toEqual([
      { id: 'coven-code', label: 'Coven Code', command: null, args: ['chat'], kind: 'coven-chat' },
      { id: 'copilot', label: 'Copilot CLI', command: 'copilot', args: [], kind: 'agent-copilot' },
      { id: 'codex', label: 'Codex CLI', command: 'codex', args: [], kind: 'agent-codex' },
      { id: 'anthropic', label: 'Anthropic CLI', command: 'claude', args: [], kind: 'agent-anthropic' },
      { id: 'grok-build', label: 'Grok Build', command: 'grok', args: [], kind: 'agent-grok-build' },
    ]);
  });

  it('launches an agent in the selected worktree', async () => {
    const createCalls: Array<Record<string, unknown>> = [];
    const project = { id: 'project', root: '/repo' };
    const spawnAgentThread = compileFunction<(
      agentId: string,
      project?: typeof project,
    ) => Promise<Record<string, unknown> | null>>(
      functionSource('spawnAgentThread'),
      {
        activeProject: () => project,
        selectedWorktree: () => ({ path: '/repo/worktree' }),
        showTerminalView: async () => true,
        agentLaunchOptions: () => [
          { id: 'codex', label: 'Codex CLI', command: 'codex', args: [], kind: 'agent-codex' },
        ],
        state: { env: { coven_path: '/opt/homebrew/bin/coven' } },
        setStatus: () => undefined,
        createThread: (options: Record<string, unknown>) => {
          createCalls.push(options);
          return options;
        },
      },
    );

    const result = await spawnAgentThread('codex');

    expect(result).toMatchObject({
      name: 'Codex CLI',
      kind: 'agent-codex',
      command: 'codex',
      args: [],
      cwd: '/repo/worktree',
      worktreePath: '/repo/worktree',
    });
    expect(createCalls).toHaveLength(1);
  });

  it('resolves Coven Code through the discovered Coven executable', async () => {
    const spawnAgentThread = compileFunction<(agentId: string) => Promise<Record<string, unknown> | null>>(
      functionSource('spawnAgentThread'),
      {
        activeProject: () => ({ id: 'project', root: '/repo' }),
        selectedWorktree: () => ({ path: '/repo' }),
        showTerminalView: async () => true,
        agentLaunchOptions: () => [
          { id: 'coven-code', label: 'Coven Code', command: null, args: ['chat'], kind: 'coven-chat' },
        ],
        state: { env: { coven_path: '/opt/homebrew/bin/coven' } },
        setStatus: () => undefined,
        createThread: (options: Record<string, unknown>) => options,
      },
    );

    const result = await spawnAgentThread('coven-code');

    expect(result).toMatchObject({
      command: '/opt/homebrew/bin/coven',
      args: ['chat'],
      launchKind: 'coven-chat',
    });
  });

  it('does not fall back when Coven Code is unavailable', async () => {
    let status: [string, string] | null = null;
    const spawnAgentThread = compileFunction<(agentId: string) => Promise<Record<string, unknown> | null>>(
      functionSource('spawnAgentThread'),
      {
        activeProject: () => ({ id: 'project', root: '/repo' }),
        selectedWorktree: () => ({ path: '/repo' }),
        showTerminalView: async () => true,
        agentLaunchOptions: () => [
          { id: 'coven-code', label: 'Coven Code', command: null, args: ['chat'], kind: 'coven-chat' },
        ],
        state: { env: {} },
        setStatus: (message: string, level: string) => { status = [message, level]; },
        createThread: () => { throw new Error('createThread must not be called'); },
      },
    );

    await expect(spawnAgentThread('coven-code')).resolves.toBeNull();
    expect(status).toEqual([
      'Coven CLI not found — install @opencoven/cli and restart Psyche',
      'error',
    ]);
  });

  it('names the selected CLI when PTY startup fails', () => {
    expect(functionSource('spawnPty')).toContain(
      'setStatus(thread.name + " failed to start: " + msg, "error")',
    );
  });
});
