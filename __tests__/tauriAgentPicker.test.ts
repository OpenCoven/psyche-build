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

function compileFunctionWithState<T extends (...args: never[]) => unknown>(
  source: string,
  dependencies: Record<string, unknown>,
  state: Record<string, unknown>,
) {
  const dependencyNames = Object.keys(dependencies);
  const dependencyValues = Object.values(dependencies);
  const stateNames = Object.keys(state);
  const stateValues = Object.values(state);
  const snapshotLines = stateNames.map(
    (name) => `${JSON.stringify(name)}: typeof ${name} === "undefined" ? undefined : ${name}`,
  );
  return Function(
    ...dependencyNames,
    ...stateNames,
    `"use strict";
    return {
      fn: (${source}),
      snapshot: function () {
        return {
          ${snapshotLines.join(',\n          ')}
        };
      },
    };`,
  )(...dependencyValues, ...stateValues) as {
    fn: T;
    snapshot: () => Record<string, unknown>;
  };
}

type PickerProject = {
  id: string;
  root: string;
};

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
    const registryArgs = ['--fixture-arg'];
    const project: PickerProject = { id: 'project', root: '/repo' };
    const spawnAgentThread = compileFunction<(
      agentId: string,
      project?: PickerProject,
    ) => Promise<Record<string, unknown> | null>>(
      functionSource('spawnAgentThread'),
      {
        activeProject: () => project,
        selectedWorktree: () => ({ path: '/repo/worktree' }),
        showTerminalView: async () => true,
        agentLaunchOptions: () => [
          { id: 'codex', label: 'Codex CLI', command: 'codex', args: registryArgs, kind: 'agent-codex' },
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

    expect(createCalls).toHaveLength(1);
    const created = createCalls[0]!;
    expect(result).toBe(created);
    expect(created).toMatchObject({
      name: 'Codex CLI',
      kind: 'agent-codex',
      command: 'codex',
      args: ['--fixture-arg'],
      launchKind: null,
      projectRoot: '/repo',
      cwd: '/repo/worktree',
      worktreePath: '/repo/worktree',
    });
    expect(created.args).toEqual(registryArgs);
    expect(created.args).not.toBe(registryArgs);
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
      kind: 'coven-chat',
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

  it('renders an accessible picker shell', () => {
    expect(indexHtml).toMatch(/id="agent-picker-overlay" hidden/);
    expect(indexHtml).toMatch(
      /id="agent-picker"[\s\S]*role="dialog"[\s\S]*aria-modal="true"[\s\S]*aria-labelledby="agent-picker-title"/,
    );
    expect(indexHtml).toMatch(
      /id="agent-picker-list"[\s\S]*role="listbox"[\s\S]*tabindex="0"/,
    );
    expect(stylesCss).toContain('.agent-picker-overlay[hidden] { display: none; }');
    expect(stylesCss).toContain('.agent-picker-option.is-selected');
  });

  it('wraps picker keyboard selection', () => {
    const nextAgentPickerIndex = compileFunction<
      (current: number, delta: number, count: number) => number
    >(functionSource('nextAgentPickerIndex'), {});

    expect(nextAgentPickerIndex(0, -1, 5)).toBe(4);
    expect(nextAgentPickerIndex(4, 1, 5)).toBe(0);
    expect(nextAgentPickerIndex(2, 1, 5)).toBe(3);
  });

  it('opens the picker by resetting selection, rendering, and focusing the list', () => {
    const overlay = { hidden: true };
    const previousFocus = { id: 'before-picker' };
    let renderCalls = 0;
    let focusCalls = 0;
    const controller = compileFunctionWithState<() => boolean>(
      functionSource('openAgentPicker'),
      {
        document: { activeElement: previousFocus },
        agentPickerOpen: () => false,
        renderAgentPicker: () => { renderCalls += 1; },
        setHelpOpen: () => undefined,
        closeNewPaneMenu: () => undefined,
        closeScopeMenu: () => undefined,
      },
      {
        agentPickerOverlayEl: overlay,
        agentPickerListEl: { focus: () => { focusCalls += 1; } },
        agentPickerIndex: 4,
        agentPickerPreviousFocus: null,
      },
    );

    expect(controller.fn()).toBe(true);
    expect(controller.snapshot().agentPickerIndex).toBe(0);
    expect(renderCalls).toBe(1);
    expect(focusCalls).toBe(1);
    expect(overlay.hidden).toBe(false);
    expect(controller.snapshot().agentPickerPreviousFocus).toBe(previousFocus);
  });

  it('uses Command-P and list keyboard controls to drive the picker', () => {
    const commandPIndex = mainJs.indexOf('String(e.key).toLowerCase() === "p"');
    const commandOIndex = mainJs.indexOf('if (e.key === "o")');
    expect(commandPIndex).toBeGreaterThan(-1);
    expect(commandPIndex).toBeLessThan(commandOIndex);
    const shortcutBlock = mainJs.slice(commandPIndex, commandPIndex + 200);
    expect(shortcutBlock).toContain('openAgentPicker()');

    const listKeydownIndex = mainJs.indexOf('agentPickerListEl.addEventListener("keydown"');
    expect(listKeydownIndex).toBeGreaterThan(-1);
    const listKeydownBlock = mainJs.slice(listKeydownIndex, listKeydownIndex + 1200);
    expect(listKeydownBlock).toContain('event.key === "ArrowDown"');
    expect(listKeydownBlock).toContain('event.key === "ArrowUp"');
    expect(listKeydownBlock).toContain('event.key === "Home"');
    expect(listKeydownBlock).toContain('event.key === "End"');
    expect(listKeydownBlock).toContain('event.key === "Enter"');
    expect(listKeydownBlock).toContain('event.key === "Escape"');
  });

  it('launches the selected agent from the picker', () => {
    let spawnedAgentId: string | null = null;
    let closed = false;
    const controller = compileFunctionWithState<() => string | null>(
      functionSource('launchSelectedAgent'),
      {
        agentLaunchOptions: () => [
          { id: 'coven-code' },
          { id: 'codex' },
        ],
        closeAgentPicker: () => { closed = true; },
        spawnAgentThread: (agentId: string) => {
          spawnedAgentId = agentId;
          return agentId;
        },
      },
      { agentPickerIndex: 1 },
    );

    expect(controller.fn()).toBe('codex');
    expect(closed).toBe(true);
    expect(spawnedAgentId).toBe('codex');
  });

  it('does not persist an agent preference and always reselects Coven Code', () => {
    expect(mainJs).not.toMatch(/localStorage\.(?:getItem|setItem)\([^)]*agent/i);
    expect(functionSource('openAgentPicker')).toContain('agentPickerIndex = 0;');
  });
});
