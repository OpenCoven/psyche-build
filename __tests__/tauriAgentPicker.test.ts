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

  it('uses the planned picker command class and visual contract', () => {
    expect(mainJs).toContain('<span class="agent-picker-option-command">');
    expect(mainJs).not.toContain('agent-picker-command');
    expect(stylesCss).not.toContain('.agent-picker-command');
    expect(stylesCss).toMatch(
      /\.agent-picker-overlay \{[\s\S]*position: fixed;[\s\S]*inset: 0;[\s\S]*z-index: 210;[\s\S]*display: flex;[\s\S]*align-items: center;[\s\S]*justify-content: center;[\s\S]*padding: 30px;[\s\S]*background: rgba\(5, 5, 8, 0\.62\);[\s\S]*animation: menu-rise 140ms ease-out;[\s\S]*\}/,
    );
    expect(stylesCss).toMatch(
      /\.agent-picker \{[\s\S]*width: min\(440px, 100%\);[\s\S]*border: 1px solid var\(--border-strong\);[\s\S]*border-radius: 12px;[\s\S]*padding: 14px;[\s\S]*background: rgba\(var\(--rgb-s1\), calc\(var\(--bg-opacity\) \* 0\.99\)\);[\s\S]*box-shadow: 0 40px 100px rgba\(0, 0, 0, 0\.7\);[\s\S]*backdrop-filter: blur\(30px\);[\s\S]*-webkit-backdrop-filter: blur\(30px\);[\s\S]*\}/,
    );
    expect(stylesCss).toMatch(
      /\.agent-picker-head \{[\s\S]*display: flex;[\s\S]*align-items: baseline;[\s\S]*justify-content: space-between;[\s\S]*gap: 16px;[\s\S]*padding: 4px 6px 12px;[\s\S]*\}/,
    );
    expect(stylesCss).toMatch(
      /\.agent-picker-title \{[\s\S]*font-size: 15px;[\s\S]*font-weight: 700;[\s\S]*\}/,
    );
    expect(stylesCss).toMatch(
      /\.agent-picker-hint \{[\s\S]*font-size: 11px;[\s\S]*color: var\(--muted\);[\s\S]*\}/,
    );
    expect(stylesCss).toMatch(
      /\.agent-picker-list \{[\s\S]*display: grid;[\s\S]*gap: 4px;[\s\S]*outline: none;[\s\S]*\}/,
    );
    expect(stylesCss).toMatch(
      /\.agent-picker-option \{[\s\S]*display: flex;[\s\S]*align-items: center;[\s\S]*justify-content: space-between;[\s\S]*width: 100%;[\s\S]*padding: 10px 11px;[\s\S]*border: 1px solid transparent;[\s\S]*border-radius: 8px;[\s\S]*background: transparent;[\s\S]*color: var\(--text-soft\);[\s\S]*font: inherit;[\s\S]*text-align: left;[\s\S]*\}/,
    );
    expect(stylesCss).toMatch(
      /\.agent-picker-option:hover,[\s\S]*\.agent-picker-option\.is-selected \{[\s\S]*border-color: var\(--border-strong\);[\s\S]*background: var\(--surface-3\);[\s\S]*color: var\(--text\);[\s\S]*\}/,
    );
    expect(stylesCss).toMatch(
      /\.agent-picker-option-command \{[\s\S]*color: var\(--muted\);[\s\S]*font-family: var\(--font-mono\);[\s\S]*font-size: 11px;[\s\S]*\}/,
    );
    expect(stylesCss).toContain('@media (prefers-reduced-motion: reduce) {\n  .agent-picker-overlay { animation: none; }\n}');
  });

  it('wraps picker keyboard selection', () => {
    const nextAgentPickerIndex = compileFunction<
      (current: number, delta: number, count: number) => number
    >(functionSource('nextAgentPickerIndex'), {});

    expect(nextAgentPickerIndex(0, -1, 5)).toBe(4);
    expect(nextAgentPickerIndex(4, 1, 5)).toBe(0);
    expect(nextAgentPickerIndex(2, 1, 5)).toBe(3);
  });

  it('opens the picker by closing the session context menu, resetting selection, and focusing the list', () => {
    const overlay = { hidden: true };
    const previousFocus = { id: 'before-picker' };
    let renderCalls = 0;
    let focusCalls = 0;
    let closeSessionContextMenuCalls = 0;
    const controller = compileFunctionWithState<() => boolean>(
      functionSource('openAgentPicker'),
      {
        document: { activeElement: previousFocus },
        agentPickerOpen: () => false,
        renderAgentPicker: () => { renderCalls += 1; },
        focusAgentPickerList: () => { focusCalls += 1; },
        setHelpOpen: () => undefined,
        closeNewPaneMenu: () => undefined,
        closeScopeMenu: () => undefined,
        closeSessionContextMenu: () => { closeSessionContextMenuCalls += 1; },
      },
      {
        agentPickerOverlayEl: overlay,
        dirtyFileDialogEl: { open: false },
        agentPickerListEl: { focus: () => { throw new Error('focus should route through focusAgentPickerList'); } },
        agentPickerIndex: 4,
        agentPickerPreviousFocus: null,
      },
    );

    expect(controller.fn()).toBe(true);
    expect(controller.snapshot().agentPickerIndex).toBe(0);
    expect(renderCalls).toBe(1);
    expect(focusCalls).toBe(1);
    expect(closeSessionContextMenuCalls).toBe(1);
    expect(overlay.hidden).toBe(false);
    expect(controller.snapshot().agentPickerPreviousFocus).toBe(previousFocus);
  });

  it('refuses to open the picker while the native dirty-file dialog owns modality', () => {
    const overlay = { hidden: true };
    const originalFocus = { id: 'existing-focus' };
    const preservedFocus = { id: 'previous-picker-focus' };
    const calls: string[] = [];
    const controller = compileFunctionWithState<() => boolean>(
      functionSource('openAgentPicker'),
      {
        document: { activeElement: originalFocus },
        agentPickerOpen: () => false,
        renderAgentPicker: () => { calls.push('render'); },
        focusAgentPickerList: () => { calls.push('focus'); },
        setHelpOpen: () => { calls.push('help'); },
        closeNewPaneMenu: () => { calls.push('new-pane'); },
        closeScopeMenu: () => { calls.push('scope'); },
        closeSessionContextMenu: () => { calls.push('context-menu'); },
      },
      {
        agentPickerOverlayEl: overlay,
        dirtyFileDialogEl: { open: true },
        agentPickerListEl: { focus: () => { throw new Error('picker should not focus'); } },
        agentPickerIndex: 3,
        agentPickerPreviousFocus: preservedFocus,
      },
    );

    expect(controller.fn()).toBe(false);
    expect(calls).toEqual([]);
    expect(overlay.hidden).toBe(true);
    expect(controller.snapshot().agentPickerIndex).toBe(3);
    expect(controller.snapshot().agentPickerPreviousFocus).toBe(preservedFocus);
  });

  it('uses Command-P and list keyboard controls to drive the picker', () => {
    const documentShortcutIndex = mainJs.indexOf('document.addEventListener("keydown", async function (e) {');
    const modalRouteIndex = mainJs.indexOf('if (routeAgentPickerModalKeydown(e)) return;', documentShortcutIndex);
    const commandPIndex = mainJs.indexOf('String(e.key).toLowerCase() === "p"');
    const commandOIndex = mainJs.indexOf('if (e.key === "o")');
    expect(modalRouteIndex).toBeGreaterThan(documentShortcutIndex);
    expect(modalRouteIndex).toBeLessThan(commandPIndex);
    expect(commandPIndex).toBeGreaterThan(-1);
    expect(commandPIndex).toBeLessThan(commandOIndex);
    const shortcutBlock = mainJs.slice(commandPIndex, commandPIndex + 200);
    expect(shortcutBlock).toContain('if (openAgentPicker()) e.preventDefault();');

    expect(mainJs).toContain('agentPickerListEl.addEventListener("keydown", handleAgentPickerListKeydown)');
    const listKeydownSource = functionSource('handleAgentPickerListKeydown');
    expect(listKeydownSource).toContain('event.key === "Tab"');
    expect(listKeydownSource).toContain('event.key === "ArrowDown"');
    expect(listKeydownSource).toContain('event.key === "ArrowUp"');
    expect(listKeydownSource).toContain('event.key === "Home"');
    expect(listKeydownSource).toContain('event.key === "End"');
    expect(listKeydownSource).toContain('event.key === "Enter"');
    expect(listKeydownSource).toContain('event.key === "Escape"');
  });

  it('stops propagation for picker-owned keys, especially Escape', () => {
    let renderCalls = 0;
    let launchCalls = 0;
    let closeCalls = 0;
    let focusCalls = 0;
    const consumeEvents: string[] = [];
    const controller = compileFunctionWithState<
      (
        event: {
          key: string;
          preventDefault: () => void;
          stopImmediatePropagation: () => void;
        }
      ) => boolean
    >(
      functionSource('handleAgentPickerListKeydown'),
      {
        agentLaunchOptions: () => [
          { id: 'coven-code' },
          { id: 'copilot' },
          { id: 'codex' },
        ],
        nextAgentPickerIndex: (current: number, delta: number, count: number) =>
          (((current + delta) % count) + count) % count,
        renderAgentPicker: () => { renderCalls += 1; },
        focusAgentPickerList: () => { focusCalls += 1; },
        launchSelectedAgent: () => { launchCalls += 1; },
        closeAgentPicker: () => { closeCalls += 1; },
        consumeAgentPickerKey: (
          event: {
            key: string;
            preventDefault: () => void;
            stopImmediatePropagation: () => void;
          }
        ) => {
          event.preventDefault();
          event.stopImmediatePropagation();
          consumeEvents.push(event.key);
        },
      },
      { agentPickerIndex: 1 },
    );

    const makeEvent = (key: string) => {
      const calls = { prevented: 0, immediateStopped: 0 };
      return {
        event: {
          key,
          preventDefault: () => { calls.prevented += 1; },
          stopImmediatePropagation: () => { calls.immediateStopped += 1; },
        },
        calls,
      };
    };

    const down = makeEvent('ArrowDown');
    expect(controller.fn(down.event)).toBe(true);
    expect(down.calls).toEqual({ prevented: 1, immediateStopped: 1 });
    expect(controller.snapshot().agentPickerIndex).toBe(2);

    const tab = makeEvent('Tab');
    expect(controller.fn(tab.event)).toBe(true);
    expect(tab.calls).toEqual({ prevented: 1, immediateStopped: 1 });

    const enter = makeEvent('Enter');
    expect(controller.fn(enter.event)).toBe(true);
    expect(enter.calls).toEqual({ prevented: 1, immediateStopped: 1 });

    const escape = makeEvent('Escape');
    expect(controller.fn(escape.event)).toBe(true);
    expect(escape.calls).toEqual({ prevented: 1, immediateStopped: 1 });

    expect(renderCalls).toBe(1);
    expect(focusCalls).toBe(1);
    expect(launchCalls).toBe(1);
    expect(closeCalls).toBe(1);
    expect(consumeEvents).toEqual(['ArrowDown', 'Tab', 'Enter', 'Escape']);
  });

  it('routes modal Tab and Shift-Tab back into the picker listbox', () => {
    let focusCalls = 0;
    const consumeEvents: string[] = [];
    const controller = compileFunctionWithState<(
      event: {
        key: string;
        shiftKey?: boolean;
        preventDefault: () => void;
        stopImmediatePropagation: () => void;
      }
    ) => boolean>(
      functionSource('handleAgentPickerListKeydown'),
      {
        agentLaunchOptions: () => [
          { id: 'coven-code' },
          { id: 'copilot' },
        ],
        nextAgentPickerIndex: (current: number, delta: number, count: number) =>
          (((current + delta) % count) + count) % count,
        renderAgentPicker: () => undefined,
        focusAgentPickerList: () => { focusCalls += 1; },
        launchSelectedAgent: () => undefined,
        closeAgentPicker: () => undefined,
        consumeAgentPickerKey: (
          event: {
            key: string;
            preventDefault: () => void;
            stopImmediatePropagation: () => void;
          }
        ) => {
          event.preventDefault();
          event.stopImmediatePropagation();
          consumeEvents.push(event.key);
        },
      },
      { agentPickerIndex: 0 },
    );

    const makeEvent = (shiftKey = false) => {
      const calls = { prevented: 0, immediateStopped: 0 };
      return {
        event: {
          key: 'Tab',
          shiftKey,
          preventDefault: () => { calls.prevented += 1; },
          stopImmediatePropagation: () => { calls.immediateStopped += 1; },
        },
        calls,
      };
    };

    const tab = makeEvent(false);
    expect(controller.fn(tab.event)).toBe(true);
    expect(tab.calls).toEqual({ prevented: 1, immediateStopped: 1 });

    const shiftTab = makeEvent(true);
    expect(controller.fn(shiftTab.event)).toBe(true);
    expect(shiftTab.calls).toEqual({ prevented: 1, immediateStopped: 1 });
    expect(focusCalls).toBe(2);
    expect(consumeEvents).toEqual(['Tab', 'Tab']);
  });

  it('suppresses background modifier shortcuts while the picker is open', () => {
    const opened: string[] = [];
    const consumed: string[] = [];
    const controller = compileFunction<(
      event: {
        key: string;
        metaKey?: boolean;
        ctrlKey?: boolean;
        altKey?: boolean;
        preventDefault: () => void;
        stopImmediatePropagation: () => void;
      }
    ) => boolean>(
      functionSource('routeAgentPickerModalKeydown'),
      {
        agentPickerOpen: () => true,
        openAgentPicker: () => { opened.push('picker'); },
        handleAgentPickerListKeydown: () => false,
        consumeAgentPickerKey: (
          event: {
            key: string;
            preventDefault: () => void;
            stopImmediatePropagation: () => void;
          }
        ) => {
          event.preventDefault();
          event.stopImmediatePropagation();
          consumed.push(event.key);
        },
        dirtyFileDialogEl: { open: false },
      },
    );

    const calls = { prevented: 0, immediateStopped: 0 };
    expect(controller({
      key: 't',
      metaKey: true,
      preventDefault: () => { calls.prevented += 1; },
      stopImmediatePropagation: () => { calls.immediateStopped += 1; },
    })).toBe(true);

    expect(calls).toEqual({ prevented: 1, immediateStopped: 1 });
    expect(consumed).toEqual(['t']);
    expect(opened).toEqual([]);
  });

  it('does not intercept keys when the picker is closed', () => {
    const controller = compileFunction<(
      event: {
        key: string;
        metaKey?: boolean;
        ctrlKey?: boolean;
        altKey?: boolean;
        preventDefault: () => void;
        stopImmediatePropagation: () => void;
      }
    ) => boolean>(
      functionSource('routeAgentPickerModalKeydown'),
      {
        agentPickerOpen: () => false,
        openAgentPicker: () => { throw new Error('picker is closed'); },
        handleAgentPickerListKeydown: () => { throw new Error('picker is closed'); },
        consumeAgentPickerKey: () => { throw new Error('picker is closed'); },
      },
    );

    expect(controller({
      key: 't',
      metaKey: true,
      preventDefault: () => undefined,
      stopImmediatePropagation: () => undefined,
    })).toBe(false);
  });

  it('does not hijack dirty-file dialog keys when a native dialog is open', () => {
    const controller = compileFunction<(
      event: {
        key: string;
        metaKey?: boolean;
        ctrlKey?: boolean;
        altKey?: boolean;
        preventDefault: () => void;
        stopImmediatePropagation: () => void;
      }
    ) => boolean>(
      functionSource('routeAgentPickerModalKeydown'),
      {
        agentPickerOpen: () => true,
        openAgentPicker: () => { throw new Error('native dialogs must block picker resets'); },
        handleAgentPickerListKeydown: () => { throw new Error('native dialogs must keep their own key handling'); },
        consumeAgentPickerKey: () => { throw new Error('native dialogs must retain input'); },
        dirtyFileDialogEl: { open: true },
      },
    );

    expect(controller({
      key: 'Escape',
      preventDefault: () => undefined,
      stopImmediatePropagation: () => undefined,
    })).toBe(false);
  });

  it('keeps Command-P as a modal reset-and-refocus shortcut', () => {
    const opened: string[] = [];
    const consumed: string[] = [];
    const controller = compileFunction<(
      event: {
        key: string;
        metaKey?: boolean;
        ctrlKey?: boolean;
        altKey?: boolean;
        preventDefault: () => void;
        stopImmediatePropagation: () => void;
      }
    ) => boolean>(
      functionSource('routeAgentPickerModalKeydown'),
      {
        agentPickerOpen: () => true,
        openAgentPicker: () => { opened.push('picker'); return true; },
        handleAgentPickerListKeydown: () => false,
        consumeAgentPickerKey: (
          event: {
            key: string;
            preventDefault: () => void;
            stopImmediatePropagation: () => void;
          }
        ) => {
          event.preventDefault();
          event.stopImmediatePropagation();
          consumed.push(event.key);
        },
        dirtyFileDialogEl: { open: false },
      },
    );

    const calls = { prevented: 0, immediateStopped: 0 };
    expect(controller({
      key: 'p',
      metaKey: true,
      preventDefault: () => { calls.prevented += 1; },
      stopImmediatePropagation: () => { calls.immediateStopped += 1; },
    })).toBe(true);

    expect(calls).toEqual({ prevented: 1, immediateStopped: 1 });
    expect(consumed).toEqual(['p']);
    expect(opened).toEqual(['picker']);
  });

  it('blocks later same-document keydown listeners only while the picker is open', () => {
    const consumeAgentPickerKey = compileFunction<
      (
        event: {
          preventDefault: () => void;
          stopPropagation: () => void;
          stopImmediatePropagation: () => void;
        }
      ) => void
    >(functionSource('consumeAgentPickerKey'), {});

    const openRouter = compileFunction<(
      event: {
        key: string;
        metaKey?: boolean;
        ctrlKey?: boolean;
        altKey?: boolean;
        preventDefault: () => void;
        stopPropagation: () => void;
        stopImmediatePropagation: () => void;
      }
    ) => boolean>(
      functionSource('routeAgentPickerModalKeydown'),
      {
        agentPickerOpen: () => true,
        openAgentPicker: () => false,
        handleAgentPickerListKeydown: () => false,
        consumeAgentPickerKey,
        dirtyFileDialogEl: { open: false },
      },
    );

    const closedRouter = compileFunction<(
      event: {
        key: string;
        metaKey?: boolean;
        ctrlKey?: boolean;
        altKey?: boolean;
        preventDefault: () => void;
        stopPropagation: () => void;
        stopImmediatePropagation: () => void;
      }
    ) => boolean>(
      functionSource('routeAgentPickerModalKeydown'),
      {
        agentPickerOpen: () => false,
        openAgentPicker: () => false,
        handleAgentPickerListKeydown: () => false,
        consumeAgentPickerKey,
        dirtyFileDialogEl: { open: false },
      },
    );

    const dispatchDocumentKeydown = (
      router: (event: {
        key: string;
        metaKey?: boolean;
        ctrlKey?: boolean;
        altKey?: boolean;
        preventDefault: () => void;
        stopPropagation: () => void;
        stopImmediatePropagation: () => void;
      }) => boolean,
    ) => {
      let helpCalls = 0;
      const calls = { prevented: 0, stopped: 0, immediateStopped: 0 };
      const event = {
        key: '?',
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        immediateStopped: false,
        preventDefault: () => { calls.prevented += 1; },
        stopPropagation: () => { calls.stopped += 1; },
        stopImmediatePropagation: () => {
          calls.immediateStopped += 1;
          event.immediateStopped = true;
        },
      };
      const listeners = [
        () => { router(event); },
        () => { helpCalls += 1; },
      ];

      for (const listener of listeners) {
        listener();
        if (event.immediateStopped) break;
      }

      return { helpCalls, calls };
    };

    expect(dispatchDocumentKeydown(openRouter)).toEqual({
      helpCalls: 0,
      calls: { prevented: 1, stopped: 0, immediateStopped: 1 },
    });
    expect(dispatchDocumentKeydown(closedRouter)).toEqual({
      helpCalls: 1,
      calls: { prevented: 0, stopped: 0, immediateStopped: 0 },
    });
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

  it('keeps shell and agent labels distinct across menus, empty state, and help', () => {
    expect(indexHtml).toMatch(
      /id="new-pane-term"[\s\S]*?Shell — login shell[\s\S]*?<span class="new-pane-key">⌘T<\/span>/,
    );
    expect(indexHtml).toMatch(
      /id="new-pane-agent"[\s\S]*?Agent — choose CLI[\s\S]*?<span class="new-pane-key">⌘P<\/span>/,
    );

    const emptyState = functionSource('renderTerminalEmptyState');
    expect(emptyState).toContain('data-empty-action="term"');
    expect(emptyState).toContain('<span class="glyph mono">❯_</span>Terminal<span class="key">⌘T</span>');
    expect(emptyState).toContain('data-empty-action="agent"');
    expect(emptyState).toContain('<span class="glyph">✳</span>Agent<span class="key">⌘P</span>');

    expect(mainJs).toMatch(/\["New terminal pane", "⌘T"\]/);
    expect(mainJs).toMatch(/\["Choose an agent", "⌘P"\]/);
    expect(mainJs).toMatch(/\["New browser tab", "Web pane \+"\]/);
    expect(mainJs).not.toMatch(/\["New agent pane \(coven chat\)", "⌘T"\]/);
    expect(mainJs).not.toMatch(/\["New browser tab", "focus Web, then ⌘T"\]/);
  });

  it('routes manual shell and agent launch surfaces through the intended entry points', () => {
    const toggleSource = functionSource('toggleNewPaneMenu');
    expect(toggleSource).toContain('if (!newPaneMenuEl) { createTerminalPane(); return; }');

    expect(mainJs).toMatch(
      /onMenuClick\("new-pane-term", async function \(\) \{[\s\S]*?createTerminalPane\(\)[\s\S]*?\}\);/,
    );
    expect(mainJs).not.toMatch(
      /onMenuClick\("new-pane-term", async function \(\) \{[\s\S]*?runNewShellCommand\(\)/,
    );
    expect(mainJs).toMatch(
      /onMenuClick\("new-pane-agent", function \(\) \{[\s\S]*?openAgentPicker\(\);[\s\S]*?\}\);/,
    );
    expect(mainJs).not.toMatch(
      /onMenuClick\("new-pane-agent", async function \(\) \{[\s\S]*?runNewThreadCommand\(\)/,
    );

    const emptyState = functionSource('renderTerminalEmptyState');
    expect(emptyState).toContain('if (action === "term") createTerminalPane();');
    expect(emptyState).toContain('else if (action === "agent") openAgentPicker();');
    expect(emptyState).toContain('else openBlankBrowserTab();');
  });

  it('keeps automatic project startup on Coven while the picker handles manual agent choice', () => {
    expect(functionSource('setActiveProject')).toContain('await ensureProjectCoven(project);');
    expect(functionSource('openProjectPicker')).toContain('await ensureProjectCoven(project);');
    expect(functionSource('boot')).toContain('await ensureProjectCoven(project);');
  });
});
