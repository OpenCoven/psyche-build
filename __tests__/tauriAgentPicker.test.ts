import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const mainJs = readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/web/main.js'),
  'utf8',
);
const indexHtml = readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/web/index.html'),
  'utf8',
);
const stylesCss = readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/web/styles.css'),
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
  name?: string;
  closing?: boolean;
};

describe('Tauri agent picker', () => {
  it('offers the fixed launch registry in product order', () => {
    const agentLaunchOptions = compileFunction<() => Array<Record<string, unknown>>>(
      functionSource('agentLaunchOptions'),
      {},
    );

    expect(agentLaunchOptions()).toEqual([
      { id: 'coven-code', label: 'Coven CLI', command: 'coven', args: [], kind: 'coven-code', harness: null },
      { id: 'copilot', label: 'Copilot CLI', command: 'coven', args: ['run', 'copilot'], kind: 'agent-copilot', harness: 'copilot' },
      { id: 'codex', label: 'Codex CLI', command: 'coven', args: ['run', 'codex'], kind: 'agent-codex', harness: 'codex' },
      { id: 'anthropic', label: 'Anthropic CLI', command: 'coven', args: ['run', 'claude'], kind: 'agent-anthropic', harness: 'claude' },
      { id: 'grok-build', label: 'Grok Build', command: 'coven', args: ['run', 'grok'], kind: 'agent-grok-build', harness: 'grok' },
    ]);
  });

  it('launches an agent through the Coven daemon with the prompt in the request body', async () => {
    const launchCalls: Array<[string, Record<string, unknown>]> = [];
    const events: string[] = [];
    const project: PickerProject = { id: 'project', root: '/repo' };
    const reservation: Record<string, unknown> = { id: 'reserved-thread' };
    let resolveLaunch!: (result: Record<string, unknown>) => void;
    let markPostStarted!: () => void;
    const postStarted = new Promise<void>((resolve) => {
      markPostStarted = resolve;
    });
    const launchResult = new Promise<Record<string, unknown>>((resolve) => {
      resolveLaunch = resolve;
    });
    const entry = {
      id: 'codex',
      label: 'Codex CLI',
      command: 'coven',
      args: ['run', 'codex'],
      kind: 'agent-codex',
      harness: 'codex',
    };
    const spawnAgentThread = compileFunction<(
      agentId: string,
      project?: PickerProject,
      prompt?: string,
    ) => Promise<Record<string, unknown> | null>>(
      functionSource('spawnAgentThread'),
      {
        activeProject: () => project,
        selectedWorktree: () => ({ path: '/repo/worktree' }),
        showTerminalView: async () => true,
        agentLaunchOptions: () => [entry],
        state: { env: { coven_path: '/opt/homebrew/bin/coven' } },
        setStatus: () => undefined,
        COVEN_LAUNCH_PROMPT_MAX_CHARS: 8192,
        hasCovenLaunchRecovery: () => false,
        covenPromptDigest: async () => 'sha256:0f1e2d3c4b5a6978',
        reserveCovenLaunchThread: (options: Record<string, unknown>) => {
          events.push('reserve');
          expect(options).toMatchObject({
            project,
            projectRoot: '/repo',
            worktreePath: '/repo/worktree',
          });
          return reservation;
        },
        invoke: async (command: string, args: Record<string, unknown>) => {
          events.push('post');
          launchCalls.push([command, args]);
          markPostStarted();
          return launchResult;
        },
        covenLaunchOutcome: (result: Record<string, unknown>) =>
          result && result.status === 'accepted' && result.sessionId ? 'accepted' : 'failed',
        covenLaunchFailureStatus: () => 'Codex CLI launch failed',
        acceptCovenLaunchReservation: (
          thread: Record<string, unknown>,
          options: Record<string, unknown>,
        ) => {
          events.push('persist-accepted-before-attach');
          expect(thread).toBe(reservation);
          return options;
        },
        markCovenLaunchRecoveryRequired: () => undefined,
        releaseCovenLaunchReservation: () => undefined,
      },
    );
    const launching = spawnAgentThread('codex', project, 'Fix the failing tests');
    await postStarted;
    expect(reservation.covenLaunchOutcomeInFlight).toBeInstanceOf(Promise);
    resolveLaunch({
      status: 'accepted',
      sessionId: '12345678-1234-4abc-8def-1234567890ab',
      harness: 'codex',
    });
    const result = await launching;

    expect(launchCalls).toEqual([
      [
        'coven_launch_session',
        {
          request: {
            projectRoot: '/repo',
            cwd: '/repo/worktree',
            harness: 'codex',
            prompt: 'Fix the failing tests',
            title: 'Codex CLI',
          },
        },
      ],
    ]);
    expect(events).toEqual([
      'reserve',
      'post',
      'persist-accepted-before-attach',
    ]);
    const created = result!;
    expect(result).toBe(created);
    expect(created).toMatchObject({
      name: 'Codex CLI',
      sessionId: '12345678-1234-4abc-8def-1234567890ab',
      harness: 'codex',
    });
    expect(created.promptDigest).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(JSON.stringify(created)).not.toContain('Fix the failing tests');
    expect(JSON.stringify(launchCalls[0]![1])).toContain('Fix the failing tests');
    expect(reservation.covenLaunchOutcomeInFlight).toBeNull();
  });

  it('does not reserve a delayed launch after project teardown starts', async () => {
    const statuses: Array<[string, string]> = [];
    let resolveDigest!: (value: string) => void;
    let markDigestStarted!: () => void;
    const digestStarted = new Promise<void>((resolve) => {
      markDigestStarted = resolve;
    });
    const digest = new Promise<string>((resolve) => {
      resolveDigest = resolve;
    });
    const project: PickerProject = {
      id: 'project',
      root: '/repo',
      name: 'Repo',
    };
    let reservationAttempts = 0;
    let postAttempts = 0;
    const spawnAgentThread = compileFunction<(
      agentId: string,
      project?: PickerProject,
      prompt?: string,
    ) => Promise<Record<string, unknown> | null>>(
      functionSource('spawnAgentThread'),
      {
        activeProject: () => project,
        selectedWorktree: () => ({ path: '/repo/worktree' }),
        showTerminalView: async () => true,
        agentLaunchOptions: () => [
          { id: 'codex', label: 'Codex CLI', harness: 'codex' },
        ],
        state: { env: { coven_path: '/bin/coven' } },
        setStatus: (message: string, level: string) => {
          statuses.push([message, level]);
        },
        COVEN_LAUNCH_PROMPT_MAX_CHARS: 8192,
        hasCovenLaunchRecovery: () => false,
        covenPromptDigest: () => {
          markDigestStarted();
          return digest;
        },
        reserveCovenLaunchThread: async () => {
          reservationAttempts += 1;
          return { id: 'reservation' };
        },
        invoke: async () => {
          postAttempts += 1;
          return null;
        },
        covenLaunchOutcome: () => 'failed',
        covenLaunchFailureStatus: () => 'failed',
        markCovenLaunchRecoveryRequired: () => undefined,
        releaseCovenLaunchReservation: () => undefined,
        acceptCovenLaunchReservation: () => undefined,
      },
    );

    const launch = spawnAgentThread('codex', project, 'Fix it');
    await digestStarted;
    project.closing = true;
    resolveDigest('sha256:abc');

    await expect(launch).resolves.toBeNull();
    expect(reservationAttempts).toBe(0);
    expect(postAttempts).toBe(0);
    expect(statuses.at(-1)).toEqual([
      'Repo is closing; wait before starting an agent',
      'warn',
    ]);
  });

  it('releases a reservation if project teardown starts before daemon submission', async () => {
    const statuses: Array<[string, string]> = [];
    const reservation = { id: 'reservation' };
    let finishReservation!: () => void;
    let markReservationStarted!: () => void;
    const reservationStarted = new Promise<void>((resolve) => {
      markReservationStarted = resolve;
    });
    const reservationReady = new Promise<Record<string, unknown>>((resolve) => {
      finishReservation = () => resolve(reservation);
    });
    const project: PickerProject = {
      id: 'project',
      root: '/repo',
      name: 'Repo',
    };
    let postAttempts = 0;
    const released: unknown[] = [];
    const spawnAgentThread = compileFunction<(
      agentId: string,
      project?: PickerProject,
      prompt?: string,
    ) => Promise<Record<string, unknown> | null>>(
      functionSource('spawnAgentThread'),
      {
        activeProject: () => project,
        selectedWorktree: () => ({ path: '/repo/worktree' }),
        showTerminalView: async () => true,
        agentLaunchOptions: () => [
          { id: 'codex', label: 'Codex CLI', harness: 'codex' },
        ],
        state: { env: { coven_path: '/bin/coven' } },
        setStatus: (message: string, level: string) => {
          statuses.push([message, level]);
        },
        COVEN_LAUNCH_PROMPT_MAX_CHARS: 8192,
        hasCovenLaunchRecovery: () => false,
        covenPromptDigest: async () => 'sha256:abc',
        reserveCovenLaunchThread: () => {
          markReservationStarted();
          return reservationReady;
        },
        releaseCovenLaunchReservation: async (thread: unknown) => {
          released.push(thread);
          return true;
        },
        invoke: async () => {
          postAttempts += 1;
          return null;
        },
        covenLaunchOutcome: () => 'failed',
        covenLaunchFailureStatus: () => 'failed',
        markCovenLaunchRecoveryRequired: () => undefined,
        acceptCovenLaunchReservation: () => undefined,
      },
    );

    const launch = spawnAgentThread('codex', project, 'Fix it');
    await reservationStarted;
    project.closing = true;
    finishReservation();

    await expect(launch).resolves.toBeNull();
    expect(released).toEqual([reservation]);
    expect(postAttempts).toBe(0);
    expect(statuses.at(-1)).toEqual([
      'Repo is closing; Coven launch was not submitted',
      'warn',
    ]);
  });

  it('keeps the composer prompt when the Coven daemon rejects the launch', async () => {
    const reservationCalls: Array<Record<string, unknown>> = [];
    const released: unknown[] = [];
    let status: [string, string] | null = null;
    const project: PickerProject = { id: 'project', root: '/repo' };
    const spawnAgentThread = compileFunction<(
      agentId: string,
      project?: PickerProject,
      prompt?: string,
    ) => Promise<Record<string, unknown> | null>>(
      functionSource('spawnAgentThread'),
      {
        activeProject: () => project,
        selectedWorktree: () => ({ path: '/repo/worktree' }),
        showTerminalView: async () => true,
        agentLaunchOptions: () => [
          { id: 'codex', label: 'Codex CLI', command: 'coven', args: ['run', 'codex'], kind: 'agent-codex', harness: 'codex' },
        ],
        state: { env: { coven_path: '/opt/homebrew/bin/coven' } },
        setStatus: (message: string, level: string) => { status = [message, level]; },
        COVEN_LAUNCH_PROMPT_MAX_CHARS: 8192,
        hasCovenLaunchRecovery: () => false,
        reserveCovenLaunchThread: (options: Record<string, unknown>) => {
          reservationCalls.push(options);
          return { id: 'reservation' };
        },
        invoke: async () => ({
          status: 'rejected',
          message: 'unknown harness `codex`',
        }),
        covenLaunchOutcome: (result: Record<string, unknown>) =>
          result && result.status === 'accepted' && result.sessionId
            ? 'accepted'
            : (result && (result.status === 'unavailable' || result.status === 'incompatible')
              ? 'recovery_required'
              : 'failed'),
        covenLaunchFailureStatus: (entry: { label: string }, result: Record<string, unknown>) =>
          result && result.status === 'rejected'
            ? entry.label + ' launch failed: ' + String(result.message)
            : 'Codex CLI launch failed',
        covenPromptDigest: async () => null,
        releaseCovenLaunchReservation: async (thread: unknown) => { released.push(thread); },
        markCovenLaunchRecoveryRequired: () => undefined,
        acceptCovenLaunchReservation: () => {
          throw new Error('rejected launch must not attach');
        },
      },
    );

    await expect(spawnAgentThread('codex', project, 'Fix the failing tests')).resolves.toBeNull();
    expect(reservationCalls).toHaveLength(1);
    expect(released).toHaveLength(1);
    expect(status).toEqual(['Codex CLI launch failed: unknown harness `codex`', 'error']);
  });

  it('maps an unavailable daemon to recovery-required guidance', async () => {
    let status: [string, string] | null = null;
    const project: PickerProject = { id: 'project', root: '/repo' };
    const spawnAgentThread = compileFunction<(
      agentId: string,
      project?: PickerProject,
      prompt?: string,
    ) => Promise<Record<string, unknown> | null>>(
      functionSource('spawnAgentThread'),
      {
        activeProject: () => project,
        selectedWorktree: () => ({ path: '/repo/worktree' }),
        showTerminalView: async () => true,
        agentLaunchOptions: () => [
          { id: 'codex', label: 'Codex CLI', command: 'coven', args: ['run', 'codex'], kind: 'agent-codex', harness: 'codex' },
        ],
        state: { env: { coven_path: '/opt/homebrew/bin/coven' } },
        setStatus: (message: string, level: string) => { status = [message, level]; },
        COVEN_LAUNCH_PROMPT_MAX_CHARS: 8192,
        hasCovenLaunchRecovery: () => false,
        reserveCovenLaunchThread: () => ({ id: 'reservation' }),
        invoke: async () => ({
          status: 'unavailable',
          message: 'Coven daemon is not running; run `coven daemon start`',
        }),
        covenLaunchOutcome: (result: Record<string, unknown>) =>
          result && (result.status === 'unavailable' || result.status === 'incompatible')
            ? 'recovery_required'
            : 'failed',
        covenLaunchFailureStatus: (_entry: unknown, result: Record<string, unknown>) =>
          String(result.message),
        covenPromptDigest: async () => null,
        releaseCovenLaunchReservation: async () => true,
        markCovenLaunchRecoveryRequired: () => undefined,
        acceptCovenLaunchReservation: () => {
          throw new Error('unavailable launch must not attach');
        },
      },
    );

    await expect(spawnAgentThread('codex', project, 'Fix the failing tests')).resolves.toBeNull();
    expect(status).toEqual([
      'Coven daemon is not running; run `coven daemon start`',
      'error',
    ]);
  });

  it('rejects over-long prompts before any Coven exchange', async () => {
    const invokeCalls: unknown[] = [];
    let status: [string, string] | null = null;
    const project: PickerProject = { id: 'project', root: '/repo' };
    const spawnAgentThread = compileFunction<(
      agentId: string,
      project?: PickerProject,
      prompt?: string,
    ) => Promise<Record<string, unknown> | null>>(
      functionSource('spawnAgentThread'),
      {
        activeProject: () => project,
        selectedWorktree: () => ({ path: '/repo/worktree' }),
        showTerminalView: async () => true,
        agentLaunchOptions: () => [
          { id: 'codex', label: 'Codex CLI', command: 'coven', args: ['run', 'codex'], kind: 'agent-codex', harness: 'codex' },
        ],
        state: { env: { coven_path: '/opt/homebrew/bin/coven' } },
        setStatus: (message: string, level: string) => { status = [message, level]; },
        COVEN_LAUNCH_PROMPT_MAX_CHARS: 8192,
        invoke: async (...args: unknown[]) => {
          invokeCalls.push(args);
          return { status: 'accepted', sessionId: 'x' };
        },
        covenLaunchOutcome: () => 'accepted',
        covenLaunchFailureStatus: () => 'unreachable',
        covenPromptDigest: async () => null,
        createThread: () => ({}),
      },
    );

    await expect(
      spawnAgentThread('codex', project, 'x'.repeat(8193)),
    ).resolves.toBeNull();
    expect(invokeCalls).toEqual([]);
    expect(status![0]).toContain('8192-character Coven launch limit');
  });

  it('requires a prompt before launching a Coven harness', async () => {
    const createCalls: Array<Record<string, unknown>> = [];
    let status: [string, string] | null = null;
    const project: PickerProject = { id: 'project', root: '/repo' };
    const spawnAgentThread = compileFunction<(
      agentId: string,
      project?: PickerProject,
      prompt?: string,
    ) => Promise<Record<string, unknown> | null>>(
      functionSource('spawnAgentThread'),
      {
        activeProject: () => project,
        selectedWorktree: () => ({ path: '/repo/worktree' }),
        showTerminalView: async () => true,
        agentLaunchOptions: () => [
          { id: 'codex', label: 'Codex CLI', command: 'coven', args: ['run', 'codex'], kind: 'agent-codex' },
        ],
        state: { env: { coven_path: '/opt/homebrew/bin/coven' } },
        setStatus: (message: string, level: string) => { status = [message, level]; },
        createThread: (options: Record<string, unknown>) => {
          createCalls.push(options);
          return options;
        },
      },
    );

    await expect(spawnAgentThread('codex', project, '   ')).resolves.toBeNull();
    expect(createCalls).toEqual([]);
    expect(status).toEqual([
      'Enter a prompt before starting an agent',
      'warn',
    ]);
  });

  it('delegates Coven CLI launches to ensureProjectCoven(project)', async () => {
    const project: PickerProject = { id: 'project', root: '/repo' };
    const result = { kind: 'coven-code' };
    let ensured: PickerProject | null = null;
    const spawnAgentThread = compileFunction<(agentId: string) => Promise<Record<string, unknown> | null>>(
      functionSource('spawnAgentThread'),
      {
        activeProject: () => project,
        selectedWorktree: () => ({ path: '/repo' }),
        showTerminalView: async () => { throw new Error('showTerminalView must not be called'); },
        agentLaunchOptions: () => [
          { id: 'coven-code', label: 'Coven CLI', command: 'coven', args: [], kind: 'coven-code' },
        ],
        state: { env: { coven_path: '/opt/homebrew/bin/coven' } },
        setStatus: () => undefined,
        ensureProjectCoven: async (value: PickerProject | null) => {
          ensured = value;
          return result;
        },
        createThread: () => { throw new Error('createThread must not be called'); },
      },
    );

    const launched = await spawnAgentThread('coven-code');

    expect(ensured).toBe(project);
    expect(launched).toBe(result);
  });

  it('does not fall back when Coven CLI is unavailable', async () => {
    let status: [string, string] | null = null;
    const spawnAgentThread = compileFunction<(agentId: string) => Promise<Record<string, unknown> | null>>(
      functionSource('spawnAgentThread'),
      {
        activeProject: () => ({ id: 'project', root: '/repo' }),
        selectedWorktree: () => ({ path: '/repo' }),
        showTerminalView: async () => true,
        agentLaunchOptions: () => [
          { id: 'coven-code', label: 'Coven CLI', command: 'coven', args: [], kind: 'coven-code' },
        ],
        state: { env: {} },
        setStatus: (message: string, level: string) => { status = [message, level]; },
        ensureProjectCoven: async () => { throw new Error('ensureProjectCoven must not be called'); },
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
    expect(indexHtml).toContain(
      '<span class="agent-picker-hint">prompt required except Coven CLI · enter to launch · esc to close</span>',
    );
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
    expect(mainJs).toContain(
      'escapeHtml([entry.command].concat(entry.args || []).join(" "))',
    );
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
        refreshCovenLaunchCapabilities: async () => undefined,
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

  it('routes exact D/F shortcuts and preserves picker list keyboard controls', () => {
    const documentShortcutIndex = mainJs.indexOf('async function routeGlobalShortcut(e) {');
    const modalRouteIndex = mainJs.indexOf('if (routeAgentPickerModalKeydown(e)) return;');
    const commandDIndex = mainJs.indexOf('String(e.key).toLowerCase() === "d"');
    const commandFIndex = mainJs.indexOf('String(e.key).toLowerCase() === "f"');
    const commandOIndex = mainJs.indexOf('if (e.key === "o")');
    const commandWIndex = mainJs.indexOf('if (e.key === "w")');
    const commandBIndex = mainJs.indexOf('e.code === "KeyB"');
    expect(modalRouteIndex).toBeGreaterThan(documentShortcutIndex);
    expect(commandDIndex).toBeGreaterThan(-1);
    expect(commandDIndex).toBeGreaterThan(modalRouteIndex);
    expect(commandDIndex).toBeLessThan(commandOIndex);
    expect(commandFIndex).toBeGreaterThan(-1);
    expect(commandFIndex).toBeGreaterThan(commandWIndex);
    expect(commandFIndex).toBeLessThan(commandBIndex);
    const pickerShortcutBlock = mainJs.slice(commandDIndex, commandDIndex + 200);
    expect(pickerShortcutBlock).toContain('if (openAgentPicker()) e.preventDefault();');
    const composerShortcutBlock = mainJs.slice(commandFIndex, commandFIndex + 220);
    expect(composerShortcutBlock).toContain('commandInput.focus();');
    expect(composerShortcutBlock).toContain('openPalette("/", true);');
    expect(composerShortcutBlock).toContain('e.preventDefault();');
    expect(composerShortcutBlock).toContain('return;');

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

  it('routes exact D and F shortcuts in the global handler', async () => {
    const calls = {
      picker: 0,
      focus: 0,
      palette: [] as Array<[string, boolean]>,
    };
    const routeGlobalShortcut = compileFunction<(
      event: {
        key: string;
        metaKey?: boolean;
        ctrlKey?: boolean;
        altKey?: boolean;
        shiftKey?: boolean;
        preventDefault: () => void;
      }
    ) => Promise<void> | void>(
      functionSource('routeGlobalShortcut'),
      {
        routeAgentPickerModalKeydown: () => false,
        routeGitPaneShortcut: () => false,
        routeFilesShortcut: () => false,
        handleExplicitFileSave: async () => undefined,
        createTerminalPane: async () => { throw new Error('terminal shortcut should not run'); },
        openAgentPicker: () => { calls.picker += 1; return true; },
        openProjectPicker: () => { throw new Error('project shortcut should not run'); },
        openPalette: (query: string, force: boolean) => { calls.palette.push([query, force]); },
        commandInput: { focus: () => { calls.focus += 1; } },
        state: { activeFileId: null, activeProjectId: null },
        switchTab: async () => { throw new Error('tab shortcut should not run'); },
        focusThread: async () => { throw new Error('thread shortcut should not run'); },
        activateFileTab: async () => { throw new Error('file tab shortcut should not run'); },
        setActiveProject: async () => { throw new Error('project switch shortcut should not run'); },
        closeFileTab: async () => { throw new Error('close-file shortcut should not run'); },
        removeProject: async () => { throw new Error('close-project shortcut should not run'); },
        canvasThreadIds: () => [],
        isTextEntryTarget: () => false,
      },
    );

    async function dispatch(overrides: Record<string, unknown>) {
      let prevented = 0;
      await routeGlobalShortcut({
        key: 'd',
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        preventDefault: () => { prevented += 1; },
        ...overrides,
      });
      return prevented;
    }

    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      calls.picker = 0;
      calls.focus = 0;
      calls.palette = [];
      expect(await dispatch({ key: 'd', ...modifier })).toBe(1);
      expect(calls).toEqual({ picker: 1, focus: 0, palette: [] });
    }

    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      calls.picker = 0;
      calls.focus = 0;
      calls.palette = [];
      expect(await dispatch({ key: 'f', ...modifier })).toBe(1);
      expect(calls).toEqual({ picker: 0, focus: 1, palette: [['/', true]] });
    }
  });

  it('does not prevent default when the picker declines exact D', async () => {
    let openCalls = 0;
    const routeGlobalShortcut = compileFunction<(
      event: {
        key: string;
        metaKey?: boolean;
        ctrlKey?: boolean;
        altKey?: boolean;
        shiftKey?: boolean;
        preventDefault: () => void;
      }
    ) => Promise<void> | void>(
      functionSource('routeGlobalShortcut'),
      {
        routeAgentPickerModalKeydown: () => false,
        routeGitPaneShortcut: () => false,
        routeFilesShortcut: () => false,
        handleExplicitFileSave: async () => undefined,
        createTerminalPane: async () => { throw new Error('terminal shortcut should not run'); },
        openAgentPicker: () => { openCalls += 1; return false; },
        openProjectPicker: () => { throw new Error('project shortcut should not run'); },
        openPalette: () => { throw new Error('composer shortcut should not run'); },
        commandInput: { focus: () => { throw new Error('composer focus should not run'); } },
        state: { activeFileId: null, activeProjectId: null },
        switchTab: async () => { throw new Error('tab shortcut should not run'); },
        focusThread: async () => { throw new Error('thread shortcut should not run'); },
        activateFileTab: async () => { throw new Error('file tab shortcut should not run'); },
        setActiveProject: async () => { throw new Error('project switch shortcut should not run'); },
        closeFileTab: async () => { throw new Error('close-file shortcut should not run'); },
        removeProject: async () => { throw new Error('close-project shortcut should not run'); },
        canvasThreadIds: () => [],
        isTextEntryTarget: () => false,
      },
    );

    let prevented = 0;
    await routeGlobalShortcut({
      key: 'd',
      metaKey: true,
      preventDefault: () => { prevented += 1; },
    });

    expect(openCalls).toBe(1);
    expect(prevented).toBe(0);
  });

  it('does not route P, K, or modified D/F shortcuts in the global handler', async () => {
    const calls = {
      picker: 0,
      focus: 0,
      palette: [] as Array<[string, boolean]>,
    };
    const routeGlobalShortcut = compileFunction<(
      event: {
        key: string;
        metaKey?: boolean;
        ctrlKey?: boolean;
        altKey?: boolean;
        shiftKey?: boolean;
        preventDefault: () => void;
      }
    ) => Promise<void> | void>(
      functionSource('routeGlobalShortcut'),
      {
        routeAgentPickerModalKeydown: () => false,
        routeGitPaneShortcut: () => false,
        routeFilesShortcut: () => false,
        handleExplicitFileSave: async () => undefined,
        createTerminalPane: async () => { throw new Error('terminal shortcut should not run'); },
        openAgentPicker: () => { calls.picker += 1; return true; },
        openProjectPicker: () => { throw new Error('project shortcut should not run'); },
        openPalette: (query: string, force: boolean) => { calls.palette.push([query, force]); },
        commandInput: { focus: () => { calls.focus += 1; } },
        state: { activeFileId: null, activeProjectId: null },
        switchTab: async () => { throw new Error('tab shortcut should not run'); },
        focusThread: async () => { throw new Error('thread shortcut should not run'); },
        activateFileTab: async () => { throw new Error('file tab shortcut should not run'); },
        setActiveProject: async () => { throw new Error('project switch shortcut should not run'); },
        closeFileTab: async () => { throw new Error('close-file shortcut should not run'); },
        removeProject: async () => { throw new Error('close-project shortcut should not run'); },
        canvasThreadIds: () => [],
        isTextEntryTarget: () => false,
      },
    );

    async function dispatch(overrides: Record<string, unknown>) {
      let prevented = 0;
      await routeGlobalShortcut({
        key: 'p',
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        preventDefault: () => { prevented += 1; },
        ...overrides,
      });
      return prevented;
    }

    for (const event of [
      { key: 'p', metaKey: true },
      { key: 'p', ctrlKey: true },
      { key: 'k', metaKey: true },
      { key: 'k', ctrlKey: true },
      { key: 'd', metaKey: true, altKey: true },
      { key: 'd', ctrlKey: true, shiftKey: true },
      { key: 'f', metaKey: true, altKey: true },
      { key: 'f', ctrlKey: true, shiftKey: true },
    ]) {
      calls.picker = 0;
      calls.focus = 0;
      calls.palette = [];
      expect(await dispatch(event)).toBe(0);
      expect(calls).toEqual({ picker: 0, focus: 0, palette: [] });
    }
  });

  it('routes Git only from an unmodified Command-G outside text and modal contexts', () => {
    const source = [
      'isTextEntryTarget', 'gitPaneShortcutBlocked', 'routeGitPaneShortcut',
    ].map(functionSource).join('\n');
    let opened = 0;
    let dirtyDialog = { open: false };
    const routeGitPaneShortcut = Function(
      'openOrFocusGitPane', 'dirtyFileDialogEl', 'agentPickerOpen', 'helpOverlayEl',
      `"use strict"; ${source}; return routeGitPaneShortcut;`,
    )(
      async () => { opened += 1; return { id: 'git' }; },
      dirtyDialog,
      () => false,
      { hidden: true },
    ) as (event: {
      key: string;
      metaKey?: boolean;
      ctrlKey?: boolean;
      altKey?: boolean;
      shiftKey?: boolean;
      target?: { tagName?: string; isContentEditable?: boolean };
      preventDefault: () => void;
    }) => boolean;
    const event = (overrides: Record<string, unknown> = {}) => {
      let prevented = 0;
      return {
        value: {
          key: 'g', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false,
          target: { tagName: 'DIV' },
          preventDefault: () => { prevented += 1; },
          ...overrides,
        },
        prevented: () => prevented,
      };
    };

    const commandG = event();
    expect(routeGitPaneShortcut(commandG.value)).toBe(true);
    expect(opened).toBe(1);
    expect(commandG.prevented()).toBe(1);

    for (const overrides of [
      { metaKey: false, ctrlKey: true },
      { altKey: true },
      { shiftKey: true },
      { target: { tagName: 'INPUT' } },
      { target: { tagName: 'DIV', isContentEditable: true } },
    ]) {
      const ignored = event(overrides);
      expect(routeGitPaneShortcut(ignored.value)).toBe(false);
      expect(ignored.prevented()).toBe(0);
    }
    dirtyDialog.open = true;
    const modal = event();
    expect(routeGitPaneShortcut(modal.value)).toBe(false);
    expect(modal.prevented()).toBe(0);
    expect(opened).toBe(1);
  });

  it('prevents existing Command shortcuts before later keydown listeners observe the event', async () => {
    const routeGlobalShortcut = compileFunction<(
      event: {
        key: string;
        metaKey?: boolean;
        ctrlKey?: boolean;
        altKey?: boolean;
        shiftKey?: boolean;
        code?: string;
        preventDefault: () => void;
      },
    ) => Promise<unknown>>(
      functionSource('routeGlobalShortcut'),
      {
        routeAgentPickerModalKeydown: () => false,
        routeGitPaneShortcut: () => false,
        filesPaneHasCanvasFocus: () => false,
        routeFilesShortcut: () => false,
        handleExplicitFileSave: (event: { preventDefault: () => void }) => {
          event.preventDefault();
          return Promise.resolve();
        },
        createTerminalPane: () => Promise.resolve(),
        openAgentPicker: () => false,
        openProjectPicker: () => undefined,
        state: { activeFileId: null, activeProjectId: 'project', projects: [] },
        closeFileTab: () => Promise.resolve(),
        removeProject: () => Promise.resolve(),
        commandInput: { focus: () => undefined },
        openPalette: () => undefined,
        toggleSidebar: () => undefined,
        canvasThreadIds: () => [],
        focusThread: () => Promise.resolve(),
        switchTab: () => Promise.resolve(),
        projectFiles: () => [],
        activateFileTab: () => Promise.resolve(),
        setActiveProject: () => Promise.resolve(),
      },
    );
    const observed: Array<{ key: string; prevented: boolean }> = [];
    async function dispatch(key: string, extra: Record<string, unknown> = {}) {
      let prevented = false;
      const event = {
        key, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false,
        preventDefault: () => { prevented = true; },
        ...extra,
      };
      const inFlight = routeGlobalShortcut(event);
      // This is the next document listener in the same dispatch, before the
      // promise continuation/microtask gets a chance to run.
      observed.push({ key, prevented });
      await inFlight;
    }

    await dispatch('s');
    await dispatch('t');
    await dispatch('w');
    expect(observed).toEqual([
      { key: 's', prevented: false },
      { key: 't', prevented: true },
      { key: 'w', prevented: true },
    ]);
  });

  it('prevents and dispatches non-Files shortcuts synchronously while Files owns focus', async () => {
    let prevented = false;
    let terminalCreates = 0;
    const routeFilesShortcut = compileFunction<(event: Record<string, unknown>) => boolean>(
      functionSource('routeFilesShortcut'),
      {
        filesPaneHasCanvasFocus: () => true,
      },
    );
    const routeGlobalShortcut = compileFunction<(event: Record<string, unknown>) => Promise<unknown>>(
      functionSource('routeGlobalShortcut'),
      {
        routeAgentPickerModalKeydown: () => false,
        routeGitPaneShortcut: () => false,
        filesPaneHasCanvasFocus: () => true,
        routeFilesShortcut,
        createTerminalPane: () => { terminalCreates += 1; return Promise.resolve(); },
        openAgentPicker: () => false,
        openProjectPicker: () => undefined,
        state: { activeProjectId: 'project', projects: [] },
        removeProject: () => Promise.resolve(),
        commandInput: { focus: () => undefined },
        openPalette: () => undefined,
        toggleSidebar: () => undefined,
        canvasThreadIds: () => [],
        focusThread: () => Promise.resolve(),
        switchTab: () => Promise.resolve(),
        setActiveProject: () => Promise.resolve(),
      },
    );
    const inFlight = routeGlobalShortcut({
      key: 't', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false,
      preventDefault: () => { prevented = true; },
    });

    expect(prevented).toBe(true);
    expect(terminalCreates).toBe(1);
    await inFlight;
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
        shiftKey?: boolean;
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
        shiftKey?: boolean;
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
        shiftKey?: boolean;
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

  it('keeps exact primary-modified D as a modal reset-and-refocus shortcut', () => {
    const opened: string[] = [];
    const consumed: string[] = [];
    const controller = compileFunction<(
      event: {
        key: string;
        metaKey?: boolean;
        ctrlKey?: boolean;
        altKey?: boolean;
        shiftKey?: boolean;
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

    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      const calls = { prevented: 0, immediateStopped: 0 };
      expect(controller({
        key: 'd',
        altKey: false,
        shiftKey: false,
        ...modifier,
        preventDefault: () => { calls.prevented += 1; },
        stopImmediatePropagation: () => { calls.immediateStopped += 1; },
      })).toBe(true);
      expect(calls).toEqual({ prevented: 1, immediateStopped: 1 });
    }

    expect(consumed).toEqual(['d', 'd']);
    expect(opened).toEqual(['picker', 'picker']);
  });

  it('does not reopen the picker for P or modified D while the modal is open', () => {
    const opened: string[] = [];
    const consumed: string[] = [];
    const controller = compileFunction<(
      event: {
        key: string;
        metaKey?: boolean;
        ctrlKey?: boolean;
        altKey?: boolean;
        shiftKey?: boolean;
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

    for (const event of [
      { key: 'p', metaKey: true },
      { key: 'p', ctrlKey: true },
      { key: 'd', metaKey: true, altKey: true },
      { key: 'd', ctrlKey: true, shiftKey: true },
    ]) {
      const calls = { prevented: 0, immediateStopped: 0 };
      expect(controller({
        preventDefault: () => { calls.prevented += 1; },
        stopImmediatePropagation: () => { calls.immediateStopped += 1; },
        ...event,
      })).toBe(true);
      expect(calls).toEqual({ prevented: 1, immediateStopped: 1 });
    }

    expect(opened).toEqual([]);
    expect(consumed).toEqual(['p', 'p', 'd', 'd']);
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

  it('launches the selected agent with the composer prompt', async () => {
    let spawned: [string, unknown, string] | null = null;
    let closed = false;
    let synced = 0;
    let hidden = 0;
    let focused = 0;
    const commandInput = {
      value: 'Fix the failing tests',
      focus: () => { focused += 1; },
    };
    const controller = compileFunctionWithState<() => Promise<string | null>>(
      functionSource('launchSelectedAgent'),
      {
        covenLaunchGate: () => null,
        agentLaunchOptions: () => [
          { id: 'coven-code' },
          { id: 'codex' },
        ],
        closeAgentPicker: () => { closed = true; },
        spawnAgentThread: async (agentId: string, project: unknown, prompt: string) => {
          spawned = [agentId, project, prompt];
          return agentId;
        },
        activeProject: () => ({ id: 'project', root: '/repo' }),
        commandInput,
        hidePalette: () => { hidden += 1; },
        syncComposerChrome: () => { synced += 1; },
      },
      { agentPickerIndex: 1, agentLaunchInFlight: false },
    );

    await expect(controller.fn()).resolves.toBe('codex');
    expect(closed).toBe(true);
    expect(spawned).toEqual([
      'codex',
      { id: 'project', root: '/repo' },
      'Fix the failing tests',
    ]);
    expect(commandInput.value).toBe('');
    expect(hidden).toBe(1);
    expect(synced).toBe(1);
    expect(focused).toBe(0);
  });

  it('keeps composer focus unchanged when a standalone Coven launch returns no thread', async () => {
    let focused = 0;
    const commandInput = {
      value: 'Keep this draft',
      focus: () => { focused += 1; },
    };
    const controller = compileFunctionWithState<() => Promise<null>>(
      functionSource('launchSelectedAgent'),
      {
        covenLaunchGate: () => null,
        agentLaunchOptions: () => [
          { id: 'coven-code' },
        ],
        closeAgentPicker: () => undefined,
        spawnAgentThread: async () => null,
        activeProject: () => ({ id: 'project', root: '/repo' }),
        commandInput,
        hidePalette: () => undefined,
        syncComposerChrome: () => undefined,
      },
      { agentPickerIndex: 0, agentLaunchInFlight: false },
    );

    await expect(controller.fn()).resolves.toBeNull();
    expect(commandInput.value).toBe('Keep this draft');
    expect(focused).toBe(0);
  });

  it('surfaces rejected agent launches without leaving an unhandled promise rejection', async () => {
    let focused = 0;
    let status: [string, string] | null = null;
    const commandInput = {
      value: 'Fix the failing tests',
      focus: () => { focused += 1; },
    };
    const controller = compileFunctionWithState<() => Promise<null>>(
      functionSource('launchSelectedAgent'),
      {
        covenLaunchGate: () => null,
        agentLaunchOptions: () => [
          { id: 'codex', label: 'Codex CLI' },
        ],
        closeAgentPicker: () => undefined,
        spawnAgentThread: async () => {
          throw new Error('launch exploded');
        },
        activeProject: () => ({ id: 'project', root: '/repo' }),
        commandInput,
        hidePalette: () => undefined,
        syncComposerChrome: () => undefined,
        setStatus: (message: string, kind: string) => {
          status = [message, kind];
        },
      },
      { agentPickerIndex: 0, agentLaunchInFlight: false },
    );

    await expect(controller.fn()).resolves.toBeNull();
    expect(status).toEqual([
      'Codex CLI failed to start: Error: launch exploded',
      'error',
    ]);
    expect(commandInput.value).toBe('Fix the failing tests');
    expect(focused).toBe(1);
  });

  it('serializes prompt-backed launches until the first PTY startup settles', async () => {
    let resolveLaunch!: (thread: string) => void;
    const pendingLaunch = new Promise<string>((resolve) => {
      resolveLaunch = resolve;
    });
    let spawnCalls = 0;
    let closeCalls = 0;
    const statuses: Array<[string, string]> = [];
    const commandInput = {
      value: 'Fix the failing tests',
      focus: () => undefined,
    };
    const controller = compileFunctionWithState<() => Promise<string | null>>(
      functionSource('launchSelectedAgent'),
      {
        covenLaunchGate: () => null,
        agentLaunchOptions: () => [
          { id: 'codex', label: 'Codex CLI' },
        ],
        closeAgentPicker: () => { closeCalls += 1; },
        spawnAgentThread: () => {
          spawnCalls += 1;
          return pendingLaunch;
        },
        activeProject: () => ({ id: 'project', root: '/repo' }),
        commandInput,
        hidePalette: () => undefined,
        syncComposerChrome: () => undefined,
        setStatus: (message: string, kind: string) => {
          statuses.push([message, kind]);
        },
      },
      { agentPickerIndex: 0, agentLaunchInFlight: false },
    );

    const firstLaunch = controller.fn();
    expect(controller.snapshot().agentLaunchInFlight).toBe(true);

    await expect(controller.fn()).resolves.toBeNull();
    expect(spawnCalls).toBe(1);
    expect(statuses).toEqual([
      ['Wait for the current agent launch to finish', 'warn'],
    ]);
    expect(commandInput.value).toBe('Fix the failing tests');

    resolveLaunch('codex');
    await expect(firstLaunch).resolves.toBe('codex');

    expect(closeCalls).toBe(2);
    expect(commandInput.value).toBe('');
    expect(controller.snapshot().agentLaunchInFlight).toBe(false);
  });

  it('keeps an effect-unknown reservation and blocks a blind retry', async () => {
    const project: PickerProject = { id: 'project', root: '/repo' };
    const worktree = { path: '/repo/worktree' };
    const reservation = { id: 'reserved-thread' };
    const invocations: string[] = [];
    const statuses: Array<[string, string]> = [];
    let recoveryExists = false;
    const dependencies = {
      activeProject: () => project,
      selectedWorktree: () => worktree,
      showTerminalView: async () => true,
      agentLaunchOptions: () => [
        { id: 'codex', label: 'Codex CLI', command: 'coven', args: ['run', 'codex'], kind: 'agent-codex', harness: 'codex' },
      ],
      state: { env: { coven_path: '/opt/homebrew/bin/coven' } },
      setStatus: (message: string, level: string) => { statuses.push([message, level]); },
      COVEN_LAUNCH_PROMPT_MAX_CHARS: 8192,
      hasCovenLaunchRecovery: () => recoveryExists,
      covenPromptDigest: async () => 'sha256:0f1e2d3c4b5a6978',
      reserveCovenLaunchThread: () => reservation,
      invoke: async (command: string) => {
        invocations.push(command);
        return {
          status: 'effect_unknown',
          message: 'Coven launch outcome is unknown; inspect Coven sessions before retrying',
        };
      },
      covenLaunchOutcome: (result: Record<string, unknown>) =>
        result.status === 'effect_unknown' ? 'recovery_required' : 'failed',
      covenLaunchFailureStatus: (_entry: unknown, result: Record<string, unknown>) =>
        String(result.message),
      markCovenLaunchRecoveryRequired: async () => {
        recoveryExists = true;
      },
      releaseCovenLaunchReservation: () => {
        throw new Error('effect-unknown reservation must not be released');
      },
      acceptCovenLaunchReservation: () => {
        throw new Error('effect-unknown launch must not attach');
      },
    };
    const spawnAgentThread = compileFunction<(
      agentId: string,
      selectedProject?: PickerProject,
      prompt?: string,
    ) => Promise<Record<string, unknown> | null>>(
      functionSource('spawnAgentThread'),
      dependencies,
    );

    await expect(spawnAgentThread('codex', project, 'Fix it')).resolves.toBe(reservation);
    await expect(spawnAgentThread('codex', project, 'Fix it')).resolves.toBeNull();

    expect(invocations).toEqual(['coven_launch_session']);
    expect(statuses.at(-1)?.[0]).toContain('inspect Coven sessions before retrying');
  });

  it('persists the recovery reservation before a launch can be submitted', async () => {
    const events: string[] = [];
    const reservation = { id: 'reserved-thread' };
    const reserveCovenLaunchThread = compileFunction<(
      options: Record<string, unknown>,
    ) => Promise<Record<string, unknown> | null>>(
      functionSource('reserveCovenLaunchThread'),
      {
        createThread: async () => {
          events.push('reserve');
          return reservation;
        },
        saveWorkspaceNow: async () => {
          events.push('persist');
          return true;
        },
      },
    );

    await expect(reserveCovenLaunchThread({
      project: { id: 'project', root: '/repo' },
      projectRoot: '/repo',
      worktreePath: '/repo/worktree',
      name: 'Codex CLI',
      promptDigest: 'sha256:abc',
    })).resolves.toBe(reservation);

    expect(events).toEqual(['reserve', 'persist']);
  });

  it('only releases a recovery reservation after a definitive pre-effect rejection', async () => {
    const options: Array<Record<string, unknown>> = [];
    const releaseCovenLaunchReservation = compileFunction<(
      thread: Record<string, unknown>,
    ) => Promise<boolean>>(
      functionSource('releaseCovenLaunchReservation'),
      {
        closeThread: async (_id: string, closeOptions: Record<string, unknown>) => {
          options.push(closeOptions);
          return true;
        },
      },
    );

    await expect(releaseCovenLaunchReservation({
      id: 'reserved-thread',
      launch: { launchKind: 'coven-recovery' },
    })).resolves.toBe(true);

    expect(options).toEqual([{
      skipNativeSessionStop: true,
      protectCovenRecovery: false,
    }]);
  });

  it('clears and persists recovery quarantine after canonical reattachment', async () => {
    const statuses: Array<[string, string]> = [];
    let saves = 0;
    const thread: Record<string, any> = {
      id: 'accepted-thread',
      projectId: 'project',
      name: 'Codex CLI',
      launch: {
        launchKind: 'coven-attach',
        covenSessionId: 'session-accepted',
        recoveryRequired: true,
      },
      startInFlight: false,
      closeStarted: false,
      ptyStarted: false,
      term: null,
    };
    const attachThreadClient = compileFunction<(
      candidate: Record<string, any>,
    ) => Promise<boolean>>(functionSource('attachThreadClient'), {
      isLiveThread: () => true,
      ensureThreadPtyController: () => ({
        prepareForPtyStart: () => null,
        markPtyStarted: async () => undefined,
        restoreAfterFailedPtyStart: () => undefined,
      }),
      attentionTracker: { forget: () => undefined },
      syncThreadAttentionChrome: () => undefined,
      syncThreadPaneMetadata: () => undefined,
      refreshSidebar: () => undefined,
      refreshTabs: () => undefined,
      invoke: async () => ({ generation: 1 }),
      stopThreadPty: async () => true,
      state: { activeThreadId: null },
      setProjectStatus: () => undefined,
      findProject: () => ({ id: 'project' }),
      saveWorkspaceNow: async () => { saves += 1; return true; },
      saveWorkspaceSoon: () => undefined,
      setStatus: (message: string, level: string) => { statuses.push([message, level]); },
    });

    await expect(attachThreadClient(thread)).resolves.toBe(true);

    expect(thread.launch.recoveryRequired).toBe(false);
    expect(saves).toBe(1);
    expect(statuses.at(-1)).toEqual([
      'Codex CLI Coven recovery resolved after successful reattachment',
      'ok',
    ]);
  });

  it('resolves inspected recovery only through an explicit bypass close', async () => {
    const closeOptions: Array<Record<string, unknown>> = [];
    const statuses: Array<[string, string]> = [];
    const resolveCovenLaunchRecovery = compileFunction<(
      thread: Record<string, any>,
    ) => Promise<boolean>>(functionSource('resolveCovenLaunchRecovery'), {
      isLiveThread: () => true,
      closeThread: async (_id: string, options: Record<string, unknown>) => {
        closeOptions.push(options);
        return true;
      },
      setStatus: (message: string, level: string) => { statuses.push([message, level]); },
    });

    await expect(resolveCovenLaunchRecovery({
      id: 'recovery-thread',
      name: 'Codex CLI',
      launch: { launchKind: 'coven-recovery' },
    })).resolves.toBe(true);

    expect(closeOptions).toEqual([{ protectCovenRecovery: false }]);
    expect(statuses.at(-1)).toEqual([
      'Codex CLI Coven recovery marked resolved after confirmed inspection',
      'ok',
    ]);
  });

  it('does not resolve recovery while the launch outcome is still settling', async () => {
    let closeAttempts = 0;
    const statuses: Array<[string, string]> = [];
    const resolveCovenLaunchRecovery = compileFunction<(
      thread: Record<string, any>,
    ) => Promise<boolean>>(functionSource('resolveCovenLaunchRecovery'), {
      isLiveThread: () => true,
      closeThread: async () => {
        closeAttempts += 1;
        return true;
      },
      setStatus: (message: string, level: string) => { statuses.push([message, level]); },
    });

    await expect(resolveCovenLaunchRecovery({
      id: 'recovery-thread',
      name: 'Codex CLI',
      launch: { launchKind: 'coven-recovery' },
      covenLaunchOutcomeInFlight: Promise.resolve(),
    })).resolves.toBe(false);

    expect(closeAttempts).toBe(0);
    expect(statuses.at(-1)).toEqual([
      'Codex CLI Coven launch is still settling; wait before resolving recovery',
      'warn',
    ]);
  });

  it('releases an unsubmitted reservation when pre-POST persistence fails', async () => {
    const state = { threads: [] as Array<Record<string, any>> };
    let persistenceFails = true;
    const reserveCovenLaunchThread = compileFunction<(
      options: Record<string, unknown>,
    ) => Promise<Record<string, unknown> | null>>(
      functionSource('reserveCovenLaunchThread'),
      {
        createThread: async () => {
          const reservation = {
            id: `reserved-${state.threads.length + 1}`,
            projectId: 'project',
            worktreePath: '/repo/worktree',
            launch: { launchKind: 'coven-recovery' },
          };
          state.threads.push(reservation);
          return reservation;
        },
        saveWorkspaceNow: async () => {
          if (persistenceFails) throw new Error('disk full');
          return true;
        },
        releaseCovenLaunchReservation: async (thread: Record<string, unknown>) => {
          state.threads = state.threads.filter(candidate => candidate !== thread);
          return true;
        },
      },
    );
    const hasCovenLaunchRecovery = compileFunction<(
      projectId: string,
      worktreePath: string,
    ) => boolean>(
      functionSource('hasCovenLaunchRecovery'),
      { state },
    );
    const options = {
      project: { id: 'project', root: '/repo' },
      projectRoot: '/repo',
      worktreePath: '/repo/worktree',
      name: 'Codex CLI',
      promptDigest: 'sha256:abc',
    };

    await expect(reserveCovenLaunchThread(options)).rejects.toThrow(
      'Coven launch was not submitted because its recovery reservation could not be saved: Error: disk full',
    );
    expect(hasCovenLaunchRecovery('project', '/repo/worktree')).toBe(false);

    persistenceFails = false;
    await expect(reserveCovenLaunchThread(options)).resolves.toBe(state.threads[0]);
    expect(hasCovenLaunchRecovery('project', '/repo/worktree')).toBe(true);
  });

  it('surfaces reservation persistence failure as an explicitly unsubmitted launch', async () => {
    const statuses: Array<[string, string]> = [];
    let postAttempts = 0;
    const spawnAgentThread = compileFunction<(
      agentId: string,
      project?: PickerProject,
      prompt?: string,
    ) => Promise<Record<string, unknown> | null>>(
      functionSource('spawnAgentThread'),
      {
        activeProject: () => ({ id: 'project', root: '/repo' }),
        selectedWorktree: () => ({ path: '/repo/worktree' }),
        showTerminalView: async () => true,
        agentLaunchOptions: () => [
          { id: 'codex', label: 'Codex CLI', harness: 'codex' },
        ],
        state: { env: { coven_path: '/bin/coven' } },
        setStatus: (message: string, level: string) => { statuses.push([message, level]); },
        COVEN_LAUNCH_PROMPT_MAX_CHARS: 8192,
        hasCovenLaunchRecovery: () => false,
        covenPromptDigest: async () => 'sha256:abc',
        reserveCovenLaunchThread: async () => {
          throw new Error(
            'Coven launch was not submitted because its recovery reservation could not be saved: Error: disk full',
          );
        },
        invoke: async () => {
          postAttempts += 1;
          return null;
        },
        covenLaunchOutcome: () => 'failed',
        covenLaunchFailureStatus: () => 'failed',
        markCovenLaunchRecoveryRequired: () => undefined,
        releaseCovenLaunchReservation: () => undefined,
        acceptCovenLaunchReservation: () => undefined,
      },
    );

    await expect(spawnAgentThread('codex', undefined, 'Fix it')).resolves.toBeNull();

    expect(postAttempts).toBe(0);
    expect(statuses.at(-1)).toEqual([
      'Codex CLI launch was not submitted: Error: Coven launch was not submitted because its recovery reservation could not be saved: Error: disk full',
      'error',
    ]);
  });

  it('persists an accepted session identity before creating its native attachment', async () => {
    const events: string[] = [];
    const thread = {
      id: 'reserved-thread',
      projectId: 'project',
      name: 'Codex CLI',
      kind: 'coven-recovery',
      launch: {
        launchKind: 'coven-recovery',
        projectRoot: '/repo',
        cwd: '/repo/worktree',
      },
      status: 'starting',
      spawning: true,
    };
    const state = {
      env: { coven_path: '/bin/coven' },
      threads: [thread],
    };
    const acceptCovenLaunchReservation = compileFunction<(
      thread: Record<string, any>,
      options: Record<string, any>,
    ) => Promise<Record<string, any>>>(
      functionSource('acceptCovenLaunchReservation'),
      {
        state,
        saveWorkspaceNow: async () => { events.push('persist'); },
        invoke: async (command: string, args: Record<string, unknown>) => {
          events.push(command);
          expect(args).toMatchObject({
            request: {
              id: 'reserved-thread',
              launchKind: 'coven-attach',
              covenSessionId: 'session-1',
            },
          });
        },
        nativeSessionRequest: (value: Record<string, unknown>) => ({
          id: value.id,
          launchKind: (value.launch as Record<string, unknown>).launchKind,
          covenSessionId: (value.launch as Record<string, unknown>).covenSessionId,
        }),
        attachThreadClient: async () => {
          events.push('attach');
          return false;
        },
        setStatus: () => undefined,
        syncThreadPaneMetadata: () => undefined,
        refreshSidebar: () => undefined,
        refreshTabs: () => undefined,
      },
    );

    const accepted = await acceptCovenLaunchReservation(thread, {
      sessionId: 'session-1',
      harness: 'codex',
      promptDigest: 'sha256:abc',
    });

    expect(events).toEqual(['persist', 'native_session_create', 'attach', 'persist']);
    expect(accepted).toBe(thread);
    expect(thread.launch).toMatchObject({
      launchKind: 'coven-attach',
      covenSessionId: 'session-1',
      promptDigest: 'sha256:abc',
      metricsProvider: 'codex',
    });
  });

  it('does not create a native attachment after an accepted reservation starts closing', async () => {
    const statuses: Array<[string, string]> = [];
    let finishFirstSave: (() => void) | undefined;
    let nativeAttachmentAttempts = 0;
    const thread: Record<string, any> = {
      id: 'reserved-thread',
      projectId: 'project',
      name: 'Codex CLI',
      kind: 'coven-recovery',
      launch: {
        launchKind: 'coven-recovery',
        projectRoot: '/repo',
        cwd: '/repo/worktree',
      },
      status: 'starting',
      spawning: true,
      closeStarted: false,
    };
    const state = {
      env: { coven_path: '/bin/coven' },
      threads: [thread],
    };
    const acceptCovenLaunchReservation = compileFunction<(
      thread: Record<string, any>,
      options: Record<string, any>,
    ) => Promise<Record<string, any> | null>>(
      functionSource('acceptCovenLaunchReservation'),
      {
        state,
        saveWorkspaceNow: () => new Promise<void>((resolve) => {
          finishFirstSave = resolve;
        }),
        invoke: async () => {
          nativeAttachmentAttempts += 1;
        },
        nativeSessionRequest: () => ({}),
        attachThreadClient: async () => {
          throw new Error('closing reservation must not attach');
        },
        setStatus: (message: string, level: string) => { statuses.push([message, level]); },
        syncThreadPaneMetadata: () => undefined,
        refreshSidebar: () => undefined,
        refreshTabs: () => undefined,
      },
    );

    const acceptance = acceptCovenLaunchReservation(thread, {
      sessionId: 'session-accepted',
      harness: 'codex',
      promptDigest: 'sha256:abc',
    });
    expect(thread.covenLaunchAcceptanceInFlight).toBeInstanceOf(Promise);
    thread.closeStarted = true;
    if (!finishFirstSave) throw new Error('accepted-session save did not start');
    finishFirstSave();

    await expect(acceptance).resolves.toBe(thread);
    expect(nativeAttachmentAttempts).toBe(0);
    expect(thread.covenLaunchAcceptanceInFlight).toBeNull();
    expect(statuses.at(-1)).toEqual([
      'Codex CLI was accepted by Coven after its local reservation was closed; no local attachment was created. Inspect Coven session session-accepted.',
      'error',
    ]);
  });

  it('waits for accepted-session conversion before stopping a closing native session', () => {
    const closeThread = functionSource('closeThread');
    expect(closeThread.indexOf('await covenLaunchAcceptanceInFlight')).toBeLessThan(
      closeThread.indexOf('invoke("native_session_stop"'),
    );
  });

  it('quarantines an accepted session when its first persistence attempt fails', async () => {
    const statuses: Array<[string, string]> = [];
    const writes: string[] = [];
    let saveAttempts = 0;
    const thread = {
      id: 'reserved-thread',
      projectId: 'project',
      name: 'Codex CLI',
      kind: 'coven-recovery',
      launch: {
        launchKind: 'coven-recovery',
        projectRoot: '/repo',
        cwd: '/repo/worktree',
      },
      status: 'starting',
      spawning: true,
      terminalController: {
        write: (value: string) => { writes.push(value); },
      },
    };
    const state = {
      env: { coven_path: '/bin/coven' },
      threads: [thread],
    };
    const acceptCovenLaunchReservation = compileFunction<(
      thread: Record<string, any>,
      options: Record<string, any>,
    ) => Promise<Record<string, any>>>(
      functionSource('acceptCovenLaunchReservation'),
      {
        state,
        saveWorkspaceNow: async () => {
          saveAttempts += 1;
          if (saveAttempts === 1) throw new Error('disk full');
          return true;
        },
        invoke: async () => {
          throw new Error('must not create a native attachment before accepted identity persists');
        },
        nativeSessionRequest: () => ({}),
        attachThreadClient: async () => {
          throw new Error('must not attach before accepted identity persists');
        },
        setStatus: (message: string, level: string) => { statuses.push([message, level]); },
        syncThreadPaneMetadata: () => undefined,
        refreshSidebar: () => undefined,
        refreshTabs: () => undefined,
      },
    );

    await expect(acceptCovenLaunchReservation(thread, {
      sessionId: 'session-accepted',
      harness: 'codex',
      promptDigest: 'sha256:abc',
    })).resolves.toBe(thread);

    expect(saveAttempts).toBe(2);
    expect(thread).toMatchObject({
      kind: 'coven-attach',
      status: 'failed',
      spawning: false,
      sidebarStatusKey: 'error',
      launch: {
        launchKind: 'coven-attach',
        covenSessionId: 'session-accepted',
        recoveryRequired: true,
      },
    });
    expect(writes.join('')).toContain('Coven session accepted');
    expect(statuses.at(-1)).toEqual([
      'Codex CLI was accepted by Coven but local recovery is required: Error: disk full',
      'error',
    ]);
    const persistableSession = compileFunction<(
      value: Record<string, unknown>,
    ) => Record<string, unknown> | null>(functionSource('persistableSession'), {});
    expect(persistableSession(thread)).toMatchObject({
      launchKind: 'coven-attach',
      covenSessionId: 'session-accepted',
      recoveryRequired: true,
    });
  });

  it('surfaces non-durable recovery when both accepted-session saves fail', async () => {
    const statuses: Array<[string, string]> = [];
    const writes: string[] = [];
    let saveAttempts = 0;
    let nativeAttachmentAttempts = 0;
    const thread = {
      id: 'reserved-thread',
      projectId: 'project',
      name: 'Codex CLI',
      kind: 'coven-recovery',
      launch: {
        launchKind: 'coven-recovery',
        projectRoot: '/repo',
        cwd: '/repo/worktree',
      },
      status: 'starting',
      spawning: true,
      terminalController: {
        write: (value: string) => { writes.push(value); },
      },
    };
    const state = {
      env: { coven_path: '/bin/coven' },
      threads: [thread],
    };
    const acceptCovenLaunchReservation = compileFunction<(
      thread: Record<string, any>,
      options: Record<string, any>,
    ) => Promise<Record<string, any>>>(
      functionSource('acceptCovenLaunchReservation'),
      {
        state,
        saveWorkspaceNow: async () => {
          saveAttempts += 1;
          throw new Error(saveAttempts === 1 ? 'disk full' : 'disk still full');
        },
        invoke: async () => {
          nativeAttachmentAttempts += 1;
        },
        nativeSessionRequest: () => ({}),
        attachThreadClient: async () => {
          nativeAttachmentAttempts += 1;
          return false;
        },
        setStatus: (message: string, level: string) => { statuses.push([message, level]); },
        syncThreadPaneMetadata: () => undefined,
        refreshSidebar: () => undefined,
        refreshTabs: () => undefined,
      },
    );

    await expect(acceptCovenLaunchReservation(thread, {
      sessionId: 'session-accepted',
      harness: 'codex',
      promptDigest: 'sha256:abc',
    })).resolves.toBe(thread);

    expect(saveAttempts).toBe(2);
    expect(nativeAttachmentAttempts).toBe(0);
    expect(thread.launch).toMatchObject({
      launchKind: 'coven-attach',
      covenSessionId: 'session-accepted',
      recoveryRequired: true,
    });
    expect(writes.join('')).toContain('recovery state is not durable');
    expect(writes.join('')).toContain('inspect Coven before closing');
    expect(statuses.at(-1)).toEqual([
      'Codex CLI was accepted by Coven, but its recovery state is not durable; inspect Coven before closing: Error: disk still full',
      'error',
    ]);
  });

  it('quarantines an accepted session when attachment-failure persistence fails', async () => {
    const statuses: Array<[string, string]> = [];
    const writes: string[] = [];
    let saveAttempts = 0;
    let nativeAttachmentAttempts = 0;
    let clientAttachmentAttempts = 0;
    const thread = {
      id: 'reserved-thread',
      projectId: 'project',
      worktreePath: '/repo/worktree',
      name: 'Codex CLI',
      kind: 'coven-recovery',
      launch: {
        launchKind: 'coven-recovery',
        projectRoot: '/repo',
        cwd: '/repo/worktree',
      },
      status: 'starting',
      spawning: true,
      terminalController: {
        write: (value: string) => { writes.push(value); },
      },
    };
    const state = {
      env: { coven_path: '/bin/coven' },
      threads: [thread],
    };
    const acceptCovenLaunchReservation = compileFunction<(
      thread: Record<string, any>,
      options: Record<string, any>,
    ) => Promise<Record<string, any>>>(
      functionSource('acceptCovenLaunchReservation'),
      {
        state,
        saveWorkspaceNow: async () => {
          saveAttempts += 1;
          if (saveAttempts === 2) throw new Error('attachment recovery save failed');
          return true;
        },
        invoke: async () => {
          nativeAttachmentAttempts += 1;
          throw new Error('tmux unavailable');
        },
        nativeSessionRequest: () => ({}),
        attachThreadClient: async () => {
          clientAttachmentAttempts += 1;
          return false;
        },
        setStatus: (message: string, level: string) => { statuses.push([message, level]); },
        syncThreadPaneMetadata: () => undefined,
        refreshSidebar: () => undefined,
        refreshTabs: () => undefined,
      },
    );
    const hasCovenLaunchRecovery = compileFunction<(
      projectId: string,
      worktreePath: string,
    ) => boolean>(functionSource('hasCovenLaunchRecovery'), { state });

    await expect(acceptCovenLaunchReservation(thread, {
      sessionId: 'session-accepted',
      harness: 'codex',
      promptDigest: 'sha256:abc',
    })).resolves.toBe(thread);

    expect(saveAttempts).toBe(2);
    expect(nativeAttachmentAttempts).toBe(1);
    expect(clientAttachmentAttempts).toBe(0);
    expect(thread.launch).toMatchObject({
      covenSessionId: 'session-accepted',
      recoveryRequired: true,
    });
    expect(hasCovenLaunchRecovery('project', '/repo/worktree')).toBe(true);
    expect(writes.join('')).toContain('recovery state is not durable');
    expect(statuses.at(-1)?.[0]).toContain('inspect Coven before closing');
  });

  it('quarantines an accepted session when final attachment persistence fails', async () => {
    const statuses: Array<[string, string]> = [];
    let saveAttempts = 0;
    let nativeAttachmentAttempts = 0;
    let clientAttachmentAttempts = 0;
    const thread = {
      id: 'reserved-thread',
      projectId: 'project',
      worktreePath: '/repo/worktree',
      name: 'Codex CLI',
      kind: 'coven-recovery',
      launch: {
        launchKind: 'coven-recovery',
        projectRoot: '/repo',
        cwd: '/repo/worktree',
      },
      status: 'starting',
      spawning: true,
      terminalController: { write: () => undefined },
    };
    const state = {
      env: { coven_path: '/bin/coven' },
      threads: [thread],
    };
    const acceptCovenLaunchReservation = compileFunction<(
      thread: Record<string, any>,
      options: Record<string, any>,
    ) => Promise<Record<string, any>>>(
      functionSource('acceptCovenLaunchReservation'),
      {
        state,
        saveWorkspaceNow: async () => {
          saveAttempts += 1;
          if (saveAttempts === 2) throw new Error('final attachment save failed');
          return true;
        },
        invoke: async () => {
          nativeAttachmentAttempts += 1;
        },
        nativeSessionRequest: () => ({}),
        attachThreadClient: async () => {
          clientAttachmentAttempts += 1;
          thread.status = 'running';
          thread.spawning = false;
          return true;
        },
        setStatus: (message: string, level: string) => { statuses.push([message, level]); },
        syncThreadPaneMetadata: () => undefined,
        refreshSidebar: () => undefined,
        refreshTabs: () => undefined,
      },
    );
    const hasCovenLaunchRecovery = compileFunction<(
      projectId: string,
      worktreePath: string,
    ) => boolean>(functionSource('hasCovenLaunchRecovery'), { state });

    await expect(acceptCovenLaunchReservation(thread, {
      sessionId: 'session-accepted',
      harness: 'codex',
      promptDigest: 'sha256:abc',
    })).resolves.toBe(thread);

    expect(saveAttempts).toBe(3);
    expect(nativeAttachmentAttempts).toBe(1);
    expect(clientAttachmentAttempts).toBe(1);
    expect(thread.launch).toMatchObject({
      covenSessionId: 'session-accepted',
      recoveryRequired: true,
    });
    expect(hasCovenLaunchRecovery('project', '/repo/worktree')).toBe(true);
    expect(statuses.at(-1)?.[0]).toContain(
      'was accepted by Coven but final attachment persistence failed',
    );
  });

  it('does not persist an agent preference and always reselects Coven CLI', () => {
    expect(mainJs).not.toMatch(/localStorage\.(?:getItem|setItem)\([^)]*agent/i);
    expect(functionSource('openAgentPicker')).toContain('agentPickerIndex = 0;');
  });

  it('keeps shell, agent, browser, and Git launch hints distinct across menus, empty state, and help', () => {
    expect(indexHtml).toMatch(
      /id="new-pane-term"[\s\S]*?Shell — login shell[\s\S]*?<span class="new-pane-key">⌃T<\/span>/,
    );
    expect(indexHtml).toMatch(
      /id="new-pane-agent"[\s\S]*?Agent — Coven CLI[\s\S]*?<span class="new-pane-key">⌃A<\/span>/,
    );
    expect(indexHtml).toMatch(
      /id="new-pane-web"[\s\S]*?Browser — web[\s\S]*?<span class="new-pane-key">Web \+<\/span>/,
    );
    expect(indexHtml).toMatch(
      /id="new-pane-git"[\s\S]*Git — changes and commits[\s\S]*<span class="new-pane-key">⌘G<\/span>/,
    );
    expect(indexHtml).not.toMatch(
      /id="new-pane-web"[\s\S]*?<span class="new-pane-key">⌘⌥B<\/span>/,
    );

    const emptyState = functionSource('renderTerminalEmptyState');
    expect(emptyState).toContain('data-empty-action="term"');
    expect(emptyState).toContain('<span class="glyph mono">❯_</span>Terminal<span class="key">⌘T</span>');
    expect(emptyState).toContain('data-empty-action="agent"');
    expect(emptyState).toContain('<span class="glyph">✳</span>Agent<span class="key">⌘D</span>');
    expect(emptyState).toContain('<span class="glyph">◍</span>Browser<span class="key">Web +</span>');
    expect(emptyState).not.toContain('<span class="glyph">◍</span>Browser<span class="key">⌘⌥B</span>');

    expect(mainJs).toMatch(/\["New terminal pane", "⌘T"\]/);
    expect(mainJs).toMatch(/\["New shell pane", "⌃T"\]/);
    expect(mainJs).toMatch(/\["Open the composer", "⌘F"\]/);
    expect(mainJs).toMatch(/\["Choose an agent", "⌘D"\]/);
    expect(mainJs).toMatch(/\["New agent pane \(Coven CLI\)", "⌃A"\]/);
    expect(mainJs).toMatch(/\["New browser tab", "Web pane \+"\]/);
    expect(mainJs).toMatch(/\["Open or focus Git", "⌘G"\]/);
    expect(mainJs).toContain('desc: "Spawn a new Coven CLI thread"');
    expect(mainJs).toContain('toast("Coven CLI opened")');
    expect(mainJs).not.toMatch(/\["Toggle the tools dock", "⌘⌥B"\]/);
    expect(mainJs).not.toMatch(/\["New agent pane \(Coven CLI\)", "⌘T"\]/);
    expect(mainJs).not.toMatch(/\["New browser tab", "focus Web, then ⌘T"\]/);
    expect(mainJs).not.toMatch(/\["Open the composer", "⌘K"\]/);
    expect(mainJs).not.toMatch(/\["Choose an agent", "⌘P"\]/);
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
      /onMenuClick\("new-pane-agent", async function \(\) \{[\s\S]*?runNewThreadCommand\(\)[\s\S]*?\}\);/,
    );
    expect(mainJs).toMatch(/onMenuClick\("new-pane-git", openGitPaneFromNewPaneMenu\)/);
    expect(functionSource('openGitPaneFromNewPaneMenu')).toContain('openOrFocusGitPane()');
    expect(mainJs).toMatch(
      /cmd: "\/git",[\s\S]*desc: "Open or focus the Git pane"[\s\S]*openOrFocusGitPane\(\)/,
    );

    const emptyState = functionSource('renderTerminalEmptyState');
    expect(emptyState).toContain('if (action === "term") createTerminalPane();');
    expect(emptyState).toContain('else if (action === "agent") openAgentPicker();');
    expect(emptyState).toContain('else openBlankBrowserTab();');
  });

  it('keeps the compositor hint until the transitioning element itself finishes', () => {
    const classes = new Set<string>();
    const listeners = new Map<string, (event: { target: unknown }) => void>();
    const timers = new Map<number, () => void>();
    let nextTimer = 1;
    const element = {
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
      },
      addEventListener: (type: string, listener: (event: { target: unknown }) => void) => {
        listeners.set(type, listener);
      },
      removeEventListener: (type: string) => {
        listeners.delete(type);
      },
      __compositorTransitionCleanup: null as null | (() => void),
    };
    const begin = Function(
      'window',
      `"use strict";
       ${functionSource('beginCompositorTransition')}
       return beginCompositorTransition;`,
    )({
      setTimeout(callback: () => void) {
        const id = nextTimer;
        nextTimer += 1;
        timers.set(id, callback);
        return id;
      },
      clearTimeout(id: number) {
        timers.delete(id);
      },
    }) as (target: typeof element) => void;

    begin(element);
    expect(classes.has('is-transitioning')).toBe(true);

    listeners.get('transitionend')?.({ target: {} });
    expect(classes.has('is-transitioning')).toBe(true);

    listeners.get('transitionend')?.({ target: element });
    expect(classes.has('is-transitioning')).toBe(false);
    expect(listeners.size).toBe(0);
    expect(timers.size).toBe(0);
  });

  it('supports standard non-modal keyboard navigation for the New Pane menu', () => {
    expect(indexHtml).toMatch(/id="rail-new-tab"[\s\S]*aria-controls="new-pane-menu"/);
    const items: Array<{ disabled: boolean; focus: () => void; click: () => void }> = [];
    const trigger = {
      attributes: {} as Record<string, string>,
      focusCalls: 0,
      setAttribute(name: string, value: string) { this.attributes[name] = value; },
      focus() { this.focusCalls += 1; },
    };
    const menu = {
      hidden: true,
      querySelectorAll: () => items,
    };
    const document = {
      activeElement: null as unknown,
      getElementById: (id: string) => id === 'rail-new-tab' ? trigger : null,
    };
    const clicks = [0, 0, 0];
    for (let index = 0; index < 3; index += 1) {
      items.push({
        disabled: false,
        focus: () => { document.activeElement = items[index]; },
        click: () => { clicks[index] += 1; },
      });
    }
    const source = [
      'beginCompositorTransition',
      'newPaneMenuItems', 'focusNewPaneMenuItem', 'closeNewPaneMenu',
      'toggleNewPaneMenu', 'handleNewPaneMenuKeydown',
    ].map(functionSource).join('\n');
    const api = Function(
      'document', 'menu',
      `"use strict";
       var newPaneMenuEl = menu;
       var newPaneMenuHeadEl = { textContent: '' };
       var activeProject = function () { return null; };
       var selectedWorktree = function () { return null; };
       var createTerminalPane = function () { throw new Error('menu is present'); };
       ${source}
       return { toggleNewPaneMenu, handleNewPaneMenuKeydown };`,
    )(document, menu) as {
      toggleNewPaneMenu: () => void;
      handleNewPaneMenuKeydown: (event: {
        key: string;
        preventDefault: () => void;
      }) => boolean;
    };
    const key = (value: string) => {
      let prevented = 0;
      return {
        event: { key: value, preventDefault: () => { prevented += 1; } },
        prevented: () => prevented,
      };
    };

    api.toggleNewPaneMenu();
    expect(menu.hidden).toBe(false);
    expect(document.activeElement).toBe(items[0]);
    expect(trigger.attributes['aria-expanded']).toBe('true');

    const down = key('ArrowDown');
    expect(api.handleNewPaneMenuKeydown(down.event)).toBe(true);
    expect(document.activeElement).toBe(items[1]);
    expect(down.prevented()).toBe(1);
    api.handleNewPaneMenuKeydown(key('End').event);
    expect(document.activeElement).toBe(items[2]);
    api.handleNewPaneMenuKeydown(key('Enter').event);
    expect(clicks).toEqual([0, 0, 1]);
    api.handleNewPaneMenuKeydown(key('Home').event);
    api.handleNewPaneMenuKeydown(key(' ').event);
    expect(clicks).toEqual([1, 0, 1]);

    const escape = key('Escape');
    expect(api.handleNewPaneMenuKeydown(escape.event)).toBe(true);
    expect(menu.hidden).toBe(true);
    expect(trigger.focusCalls).toBe(1);
    expect(escape.prevented()).toBe(1);

    api.toggleNewPaneMenu();
    const tab = key('Tab');
    expect(api.handleNewPaneMenuKeydown(tab.event)).toBe(false);
    expect(menu.hidden).toBe(true);
    expect(tab.prevented()).toBe(0);
  });

  it('moves keyboard New Pane Git activation into a visible Git control after it opens', async () => {
    let activation: Promise<unknown> | null = null;
    const trigger = {
      setAttribute: () => undefined,
      focus: () => undefined,
    };
    const document = {
      activeElement: null as unknown,
      getElementById: (id: string) => {
        if (id === 'rail-new-tab') return trigger;
        if (id === 'new-pane-git') return gitItem;
        if (id === 'git-surface') return gitSurface;
        return null;
      },
    };
    const gitTab = {
      focus: () => { document.activeElement = gitTab; },
    };
    const gitSurface = {
      isConnected: true,
      querySelector: () => gitTab,
    };
    let clickHandler: (() => unknown) | null = null;
    const gitItem = {
      disabled: false,
      focus: () => { document.activeElement = gitItem; },
      click: () => { activation = Promise.resolve(clickHandler && clickHandler()); },
      addEventListener: (type: string, handler: () => unknown) => {
        if (type === 'click') clickHandler = handler;
      },
    };
    const menu = {
      hidden: true,
      querySelectorAll: () => [gitItem],
    };
    const source = [
      'beginCompositorTransition',
      'newPaneMenuItems', 'focusNewPaneMenuItem', 'closeNewPaneMenu',
      'toggleNewPaneMenu', 'handleNewPaneMenuKeydown', 'onMenuClick',
      'focusGitPaneEntry', 'openGitPaneFromNewPaneMenu',
    ].map(functionSource).join('\n');
    const api = Function(
      'document', 'menu', 'openOrFocusGitPane',
      `"use strict";
       var newPaneMenuEl = menu;
       var newPaneMenuHeadEl = { textContent: '' };
       var activeProject = function () { return null; };
       var selectedWorktree = function () { return null; };
       var createTerminalPane = function () { throw new Error('menu is present'); };
       ${source}
       onMenuClick('new-pane-git', openGitPaneFromNewPaneMenu);
       return { toggleNewPaneMenu, handleNewPaneMenuKeydown };`,
    )(
      document,
      menu,
      async () => ({ id: 'git' }),
    ) as {
      toggleNewPaneMenu: () => void;
      handleNewPaneMenuKeydown: (event: {
        key: string;
        preventDefault: () => void;
      }) => boolean;
    };

    api.toggleNewPaneMenu();
    expect(document.activeElement).toBe(gitItem);
    api.handleNewPaneMenuKeydown({ key: 'Enter', preventDefault: () => undefined });
    await activation;
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(gitTab);
  });

  it('keeps Coven startup behind explicit launch surfaces', () => {
    expect(functionSource('setActiveProject')).not.toContain('ensureProjectCoven');
    expect(functionSource('setActiveProject')).not.toContain('openCovenSession');
    expect(functionSource('openProjectPicker')).not.toContain('ensureProjectCoven');
    expect(functionSource('openProjectPicker')).not.toContain('openCovenSession');
    expect(functionSource('boot')).not.toContain('ensureProjectCoven');
    expect(functionSource('boot')).not.toContain('openCovenSession');
  });
});
