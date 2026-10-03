import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  spawnBridgePane,
  type BridgeSpawnDeps,
  type BridgeSpawnPromptKeysRequest,
} from '../../src/daemon/bridge.js';
import { LogService } from '../../src/services/LogService.js';
import { generateSiblingSlugForTargetPane } from '../../src/utils/attachAgent.js';
import {
  mutateProjectPaneConfig,
  readProjectPaneConfigUnderLock,
  withProjectPaneSlugAllocationLock,
} from '../../src/services/ProjectPaneConfig.js';
import {
  acknowledgeWorktreeRecoveryMarker,
  listWorktreeRecoveryMarkers,
} from '../../src/services/WorktreeRecoveryMarker.js';

// These tests provide their own tmux effect boundary and exercise bridge
// transaction semantics, not the machine-wide live-pane guard. Keep rollback
// assertions isolated from unrelated tmux servers started by parallel suites.
vi.mock('../../src/services/LiveTmuxWorktreeGuard.js', () => ({
  inspectLiveTmuxWorktreeConsumers: () => ({ state: 'safe' }),
  describeLiveTmuxWorktreeGuard: () => 'no live tmux pane is using the worktree',
}));

let root: string;
let nextMockPaneId = 9;
const mockTmuxServerIdentity = {
  pid: 4242,
  processStartIdentity: 'mock-tmux-server-start',
  socketPath: '/mock/tmux.sock',
  sessionId: '$1',
};

beforeEach(() => {
  nextMockPaneId = 9;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'psyche-spawn-transport-')));
  execSync('git init', { cwd: root, stdio: 'ignore' });
  execSync('git -c commit.gpgsign=false -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', {
    cwd: root,
    stdio: 'ignore',
  });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A fake clock for the pane-shell probe: it advances only when the probe sleeps. */
function fakeProbe() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

function harness(paneShell: string | Error = 'zsh') {
  const commands: string[] = [];
  const sendPromptKeys = vi.fn(async (_request: BridgeSpawnPromptKeysRequest) => {});
  const readPaneCommand = vi.fn(async (_paneId: string) => {
    if (paneShell instanceof Error) throw paneShell;
    return paneShell;
  });
  const deps: BridgeSpawnDeps = {
    tmuxSessionExists: () => true,
    createTmuxPane: () => `%${nextMockPaneId++}`,
    getTmuxServerIdentity: () => mockTmuxServerIdentity,
    sendTmuxCommand: (_paneId: string, command: string) => {
      commands.push(command);
    },
    sendPromptKeys,
    readPaneCommand,
    paneShellProbe: fakeProbe(),
  };
  return {
    commands,
    sendPromptKeys,
    readPaneCommand,
    deps,
  };
}

async function spawn(
  agent: string,
  prompt: string | undefined,
  h = harness(),
  permissionMode?: '' | 'plan' | 'acceptEdits' | 'bypassPermissions',
) {
  const result = await spawnBridgePane(
    root,
    'psyche-test',
    {
      requestId: 'req-1',
      cwd: root,
      agent,
      prompt,
      title: `${agent}-lane`,
      ...(permissionMode !== undefined ? { permissionMode } : {}),
    },
    h.deps,
  );
  return { ...h, result };
}

/** Prompt files land under <root>/.psyche/prompts. */
function promptFiles(): string[] {
  const dir = path.join(root, '.psyche', 'prompts');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

async function waitForSlugAllocationWaiter(): Promise<void> {
  const runtimeDir = path.join(root, '.psyche', 'runtime');
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const entries = fs.existsSync(runtimeDir) ? fs.readdirSync(runtimeDir) : [];
    if (entries.some((entry) => (
      entry.startsWith('pane-slug-allocation.lock.candidate.')
    ))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('daemon did not wait for the shared pane slug allocation lock');
}

describe('spawnBridgePane prompt bootstrap follows the pane shell (#508)', () => {
  const savedShell = process.env.SHELL;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(LogService.getInstance(), 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    process.env.SHELL = savedShell;
    warn.mockRestore();
  });

  it('uses POSIX syntax in a zsh pane even when $SHELL is fish', async () => {
    process.env.SHELL = '/opt/homebrew/bin/fish';
    const h = await spawn('opencode', 'Fix it', harness('zsh'));
    expect(h.readPaneCommand).toHaveBeenCalledWith('%9');
    expect(h.commands[0]).toMatch(/^PSYCHE_PROMPT_FILE='[^']+'; PSYCHE_PROMPT_CONTENT=/u);
    expect(h.commands[0]).not.toContain('Fix it');
  });

  it('uses fish syntax in a fish pane even when $SHELL is zsh', async () => {
    process.env.SHELL = '/bin/zsh';
    const h = await spawn('opencode', 'Fix it', harness('fish'));
    expect(h.commands[0]).toMatch(/^set PSYCHE_PROMPT_FILE '[^']+'; set PSYCHE_PROMPT_CONTENT /u);
    expect(h.commands[0]).not.toContain('PSYCHE_PROMPT_FILE=');
  });

  it.each([
    ['an unknown shell', 'nu', 'unrecognized_shell'],
    ['a program in the foreground', 'vim', 'not_a_shell'],
    ['a read error', new Error('no pane'), 'unreadable_shell'],
  ] as const)('launches bare with no prompt file and returns a warning for %s', async (_label, paneShell, reason) => {
    const h = await spawn('opencode', 'Fix it', harness(paneShell));
    expect(h.commands[0]).toBe('opencode');
    expect(promptFiles()).toEqual([]);
    expect(h.result.warnings).toEqual([{
      code: 'initial_prompt_skipped',
      message: expect.stringContaining('without its initial prompt'),
    }]);
    const message = h.result.warnings![0].message;
    expect(message).not.toContain('Fix it');
    expect(message).not.toContain(root);
    expect(message.length).toBeLessThanOrEqual(1_024);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`[initial_prompt_skipped:${reason}]`), 'bridge', '%9');
  });

  it('keeps the prompt when an rc-file program gives way to the shell', async () => {
    const h = harness();
    h.readPaneCommand
      .mockResolvedValueOnce('fastfetch')
      .mockResolvedValueOnce('fastfetch');
    const result = await spawn('opencode', 'Fix it', h);
    expect(result.commands[0]).toMatch(/^PSYCHE_PROMPT_FILE='/u);
    expect(result.result.warnings).toBeUndefined();
  });

  // AGENTS.md: the prompt is never typed or put in argv. A failed prompt-file
  // write used to throw before any command was typed.
  it('launches bare and warns when the prompt file cannot be written', async () => {
    fs.mkdirSync(path.join(root, '.psyche'), { recursive: true });
    fs.writeFileSync(path.join(root, '.psyche', 'prompts'), 'not a directory');
    const h = await spawn('opencode', 'Fix it', harness('zsh'));
    expect(h.commands[0]).toBe('opencode');
    expect(h.result.warnings).toEqual([{
      code: 'initial_prompt_skipped',
      message: expect.stringContaining('prompt file could not be written'),
    }]);
  });

  it('treats a missing pane-shell reader as unreadable', async () => {
    const h = harness();
    delete (h.deps as { readPaneCommand?: unknown }).readPaneCommand;
    const result = await spawn('claude', 'Fix it', h);
    expect(result.commands[0]).toBe('claude');
    expect(promptFiles()).toEqual([]);
    expect(result.result.warnings?.[0]?.code).toBe('initial_prompt_skipped');
  });
});

describe('spawnBridgePane prompt transports', () => {
  // Regression: buildLaunchCommand ran every agent through
  // buildInitialPromptCommand, which returns a BARE command for send-keys
  // agents. The daemon and MCP paths therefore wrote a prompt file, read it
  // into a shell variable, deleted the file, and launched `cline` with no
  // prompt — silently, and with the prompt unrecoverable.
  it.each(['cline', 'crush'])('types the prompt into %s instead of dropping it', async (agent) => {
    const h = await spawn(agent, 'Fix the failing auth tests');

    // Launched bare: no prompt on the command line, no prompt-file plumbing.
    expect(h.commands[0]).toBe(agent);
    expect(h.commands[0]).not.toContain('PSYCHE_PROMPT_CONTENT');

    // ...and the prompt is actually delivered.
    expect(h.sendPromptKeys).toHaveBeenCalledTimes(1);
    expect(h.sendPromptKeys.mock.calls[0][0]).toMatchObject({
      paneId: '%9',
      prompt: 'Fix the failing auth tests',
      agent,
    });
  });

  // #523: the paste is not attempted blindly. When the agent never takes the
  // foreground, the client is told the prompt was withheld.
  it.each(['agent_not_ready', 'prompt_paste_failed'] as const)(
    'warns initial_prompt_skipped when the paste reports %s',
    async (reason) => {
      const h = harness();
      h.sendPromptKeys.mockResolvedValueOnce(reason as never);
      const { result } = await spawn('cline', 'Fix the failing auth tests', h);

      expect(result.warnings?.map((w) => w.code)).toEqual(['initial_prompt_skipped']);
      expect(result.warnings?.[0]?.message).not.toContain('auth tests');
    },
  );

  // #523 review, finding 1: read after the launch line, the "baseline" could
  // already be the agent, and an agent that crashed back to the shell would
  // then look ready. The baseline is the shell, read before anything is sent.
  it('reads the paste baseline from the pane before sending the launch line', async () => {
    const order: string[] = [];
    const h = harness();
    h.readPaneCommand.mockImplementation(async () => {
      order.push('read');
      return order.includes('launch') ? 'cline' : 'zsh';
    });
    const sendTmuxCommand = h.deps.sendTmuxCommand;
    h.deps.sendTmuxCommand = (paneId: string, command: string) => {
      order.push('launch');
      sendTmuxCommand(paneId, command);
    };
    await spawn('cline', 'Fix the failing auth tests', h);

    expect(order.indexOf('read')).toBeLessThan(order.indexOf('launch'));
    expect(h.sendPromptKeys.mock.calls[0][0].baselineCommand).toBe('zsh');
  });

  it('passes no baseline when the pane cannot be read, rather than guessing', async () => {
    const h = harness(new Error('no pane'));
    await spawn('cline', 'Fix the failing auth tests', h);
    expect(h.sendPromptKeys).toHaveBeenCalledTimes(1);
    expect(h.sendPromptKeys.mock.calls[0][0].baselineCommand).toBeUndefined();
  });

  it('adds no warning when the paste was delivered', async () => {
    const h = harness();
    h.sendPromptKeys.mockResolvedValueOnce(null as never);
    const { result } = await spawn('cline', 'Fix the failing auth tests', h);
    expect(result.warnings ?? []).toEqual([]);
  });

  it('leaves no orphaned prompt file for send-keys agents', async () => {
    await spawn('cline', 'Fix the failing auth tests');
    expect(promptFiles()).toEqual([]);
  });

  it('launches coven-code bare without prompt bootstrap files or prompt keys', async () => {
    const h = await spawn('coven-code', 'Fix the failing auth tests', harness(), 'bypassPermissions');

    expect(h.commands[0]).toBe('coven');
    expect(h.commands[0]).not.toContain('PSYCHE_PROMPT_CONTENT');
    expect(h.commands[0]).not.toContain('read');
    expect(h.sendPromptKeys).not.toHaveBeenCalled();
    expect(promptFiles()).toEqual([]);
  });

  it.each([
    ['opencode', 'option'],
    ['amp', 'stdin'],
  ])('keeps passing the prompt on the command line for %s (%s)', async (agent) => {
    const h = await spawn(agent, 'Fix the failing auth tests');

    expect(h.commands[0]).toContain('PSYCHE_PROMPT_CONTENT');
    expect(h.sendPromptKeys).not.toHaveBeenCalled();
  });

  it('does not dispatch keys when there is no prompt', async () => {
    const h = await spawn('cline', undefined);

    expect(h.commands[0]).toBe('cline');
    expect(h.sendPromptKeys).not.toHaveBeenCalled();
  });

  it('does not dispatch keys for a whitespace-only prompt', async () => {
    const h = await spawn('cline', '   \n ');
    expect(h.sendPromptKeys).not.toHaveBeenCalled();
  });

  it('dispatches keys after the launch command, not before', async () => {
    const order: string[] = [];
    const h = harness();
    h.deps.sendTmuxCommand = (_p, command) => {
      order.push(`launch:${command}`);
    };
    h.deps.sendPromptKeys = vi.fn(async () => {
      order.push('keys');
    }) as never;

    await spawn('cline', 'Fix it', h);

    expect(order).toEqual(['launch:cline', 'keys']);
  });

  it('uses the request permission mode instead of broader project settings', async () => {
    fs.mkdirSync(path.join(root, '.psyche'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.psyche', 'psyche.config.json'),
      JSON.stringify({ settings: { permissionMode: 'bypassPermissions' }, panes: [] }),
    );

    const h = await spawn('claude', 'Fix it', harness(), 'plan');
    const config = JSON.parse(
      fs.readFileSync(path.join(root, '.psyche', 'psyche.config.json'), 'utf8'),
    );

    expect(h.commands[0]).toContain('--permission-mode plan');
    expect(h.commands[0]).not.toContain('--dangerously-skip-permissions');
    expect(config.panes[0].permissionMode).toBe('plan');
  });

  it('persists an explicit empty permission mode as the agent default', async () => {
    fs.mkdirSync(path.join(root, '.psyche'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.psyche', 'psyche.config.json'),
      JSON.stringify({ settings: { permissionMode: 'bypassPermissions' }, panes: [] }),
    );

    const h = await spawn('claude', 'Fix it', harness(), '');
    const config = JSON.parse(
      fs.readFileSync(path.join(root, '.psyche', 'psyche.config.json'), 'utf8'),
    );

    expect(h.commands[0]).not.toContain('--dangerously-skip-permissions');
    expect(config.panes[0]).toHaveProperty('permissionMode', '');
  });

  it('returns the exact identity persisted for the spawned pane', async () => {
    const h = await spawn('codex', 'Fix it');
    const config = JSON.parse(
      fs.readFileSync(path.join(root, '.psyche', 'psyche.config.json'), 'utf8'),
    );
    const pane = config.panes[0];

    expect(h.result.persistedPane).toEqual({
      id: pane.id,
      slug: pane.slug,
      paneId: pane.paneId,
      worktreePath: pane.worktreePath,
      branchName: pane.branchName,
    });
  });
});

// Regression: uniqueSlug and resolveSpawnBranch are check-then-act — they scan
// for a free name, but nothing reserves it until `git worktree add` runs. Two
// concurrent spawns picked the SAME slug and the second died with
// "already exists". Invisible while fan-out lived only in the TUI, which
// created panes one at a time; running lanes in parallel exposed it at once.
describe('concurrent spawnBridgePane allocation', () => {
  it('gives every concurrent lane a distinct slug and branch', async () => {
    const h = harness();
    const results = await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        spawnBridgePane(
          root,
          'psyche-test',
          { requestId: id, cwd: root, agent: 'coven-code', prompt: 'Fix the failing auth tests' },
          h.deps,
        )),
    );

    const worktrees = results.map((r) => r.worktreePath);
    const branches = results.map((r) => r.branch);
    expect(new Set(worktrees).size).toBe(3);
    expect(new Set(branches).size).toBe(3);
    for (const worktreePath of worktrees) {
      expect(fs.existsSync(worktreePath)).toBe(true);
    }
  });

  it('registers every concurrent lane in the config', async () => {
    const h = harness();
    await Promise.all(['a', 'b', 'c'].map((id) =>
      spawnBridgePane(
        root,
        'psyche-test',
        { requestId: id, cwd: root, agent: 'coven-code', prompt: 'Same prompt' },
        h.deps,
      )));

    const config = JSON.parse(
      fs.readFileSync(path.join(root, '.psyche', 'psyche.config.json'), 'utf8'),
    );
    expect(config.panes).toHaveLength(3);
  });
});

describe('failed lane cleanup', () => {
  // The worktree exists before the pane does, so a failure after the claim
  // would otherwise leave an orphan worktree and branch behind.
  it('removes the worktree and branch when pane creation fails', async () => {
    const h = harness();
    h.deps.createTmuxPane = () => { throw new Error('no space for a new pane'); };

    await expect(spawnBridgePane(
      root,
      'psyche-test',
      { requestId: 'r', cwd: root, agent: 'coven-code', prompt: 'Fix auth' },
      h.deps,
    )).rejects.toThrow(/no space/);

    const worktreesDir = path.join(root, '.psyche', 'worktrees');
    const leftover = fs.existsSync(worktreesDir) ? fs.readdirSync(worktreesDir) : [];
    expect(leftover).toEqual([]);

    // Parentheses are shell metacharacters, so the format must be quoted.
    const branches = execSync("git for-each-ref --format='%(refname:short)' refs/heads", { cwd: root })
      .toString().split('\n').filter(Boolean);
    expect(branches.filter((b) => b.startsWith('psyche/'))).toEqual([]);
  });

  it('frees the slug so a retry gets the original name', async () => {
    const failing = harness();
    failing.deps.createTmuxPane = () => { throw new Error('boom'); };
    await expect(spawnBridgePane(
      root, 'psyche-test',
      { requestId: 'r1', cwd: root, agent: 'coven-code', prompt: 'Fix auth' },
      failing.deps,
    )).rejects.toThrow();

    const ok = harness();
    const result = await spawnBridgePane(
      root, 'psyche-test',
      { requestId: 'r2', cwd: root, agent: 'coven-code', prompt: 'Fix auth' },
      ok.deps,
    );

    // Not fix-auth-2: the failed attempt left nothing behind to collide with.
    expect(path.basename(result.worktreePath)).toBe('fix-auth');
    expect(result.branch).toBe('psyche/fix-auth');
  });

  it('rolls back provisional ownership when post-create Git verification fails', async () => {
    // `git worktree add` creates and registers the directory before Psyche
    // performs its fallible branch verification. Make only that later check
    // fail while retaining a real, removable worktree.
    const h = harness();
    h.deps.readCreatedWorktreeBranch = () => null;

    await expect(spawnBridgePane(
      root,
      'psyche-test',
      { requestId: 'verify-failure', cwd: root, agent: 'coven-code', prompt: 'Fix auth' },
      h.deps,
    )).rejects.toThrow(/failed to create scoped worktree/);

    const worktreesDir = path.join(root, '.psyche', 'worktrees');
    expect(fs.existsSync(worktreesDir) ? fs.readdirSync(worktreesDir) : []).toEqual([]);
    const branches = execSync("git for-each-ref --format='%(refname:short)' refs/heads", { cwd: root })
      .toString().split('\n').filter(Boolean);
    expect(branches.filter((branch) => branch.startsWith('psyche/'))).toEqual([]);
  });

  it('surfaces a guarded rollback failure to daemon callers', async () => {
    const h = harness();
    h.deps.createTmuxPane = (_sessionName, worktreePath) => {
      // A concurrent owner registering the path makes rollback deliberately
      // refuse deletion. The daemon must expose that critical condition.
      fs.writeFileSync(
        path.join(root, '.psyche', 'psyche.config.json'),
        JSON.stringify({
          panes: [{
            id: 'concurrent-owner',
            paneId: '%concurrent',
            slug: 'concurrent-owner',
            prompt: '',
            worktreePath,
          }],
        }),
        'utf8',
      );
      throw new Error('no space for a new pane');
    };

    await expect(spawnBridgePane(
      root,
      'psyche-test',
      { requestId: 'rollback-failure', cwd: root, agent: 'coven-code', prompt: 'Fix auth' },
      h.deps,
    )).rejects.toThrow(
      /no space for a new pane; rollback failed: newly created worktree is referenced by current pane config/,
    );
  });
});

describe('shared-worktree attach', () => {
  /** Create a real worktree the way a first lane would, then attach to it. */
  async function seedWorktree() {
    const h = harness();
    const first = await spawnBridgePane(
      root, 'psyche-test',
      { requestId: 'first', cwd: root, agent: 'coven-code', prompt: 'Fix auth' },
      h.deps,
    );
    return first;
  }

  it('reuses the existing worktree instead of creating another', async () => {
    const first = await seedWorktree();
    const before = fs.readdirSync(path.join(root, '.psyche', 'worktrees'));

    const h = harness();
    const second = await spawnBridgePane(
      root, 'psyche-test',
      {
        requestId: 'second', cwd: root, agent: 'claude', prompt: 'Review it',
        existingWorktree: {
          slug: path.basename(first.worktreePath),
          worktreePath: first.worktreePath,
          branchName: first.branch,
        },
      },
      h.deps,
    );

    expect(second.worktreePath).toBe(first.worktreePath);
    expect(second.branch).toBe(first.branch);
    expect(fs.readdirSync(path.join(root, '.psyche', 'worktrees'))).toEqual(before);
  });

  it('gives the attached pane a sibling slug', async () => {
    const first = await seedWorktree();
    const base = path.basename(first.worktreePath);

    const h = harness();
    await spawnBridgePane(
      root, 'psyche-test',
      {
        requestId: 'second', cwd: root, agent: 'claude', prompt: 'Review it',
        existingWorktree: { slug: base, worktreePath: first.worktreePath, branchName: first.branch },
      },
      h.deps,
    );

    const config = JSON.parse(fs.readFileSync(path.join(root, '.psyche', 'psyche.config.json'), 'utf8'));
    expect(config.panes.map((p: any) => p.slug)).toEqual([base, `${base}-a2`]);
  });

  it('quarantines an unrecorded pane slug before another daemon attach allocates', async () => {
    const first = await seedWorktree();
    const base = path.basename(first.worktreePath);
    const configPath = path.join(root, '.psyche', 'psyche.config.json');
    const stableConfig = fs.readFileSync(configPath, 'utf8');
    const failed = harness();
    failed.deps.beforeExistingWorktreePersist = () => {
      fs.rmSync(configPath);
      fs.mkdirSync(configPath);
    };
    failed.deps.killTmuxPane = vi.fn();
    failed.deps.probeTmuxPane = () => 'present';

    await expect(spawnBridgePane(
      root,
      'psyche-test',
      {
        requestId: 'uncertain',
        cwd: root,
        agent: 'claude',
        prompt: 'Review it',
        existingWorktree: {
          slug: base,
          worktreePath: first.worktreePath,
          branchName: first.branch,
        },
      },
      failed.deps,
    )).rejects.toThrow(/recovery persist failed/);

    const markers = await listWorktreeRecoveryMarkers(root);
    expect(markers).toEqual([
      expect.objectContaining({
        worktreePath: first.worktreePath,
        pane: expect.objectContaining({
          paneId: '%10',
          slug: `${base}-a2`,
        }),
        allowWorktreeReuse: true,
      }),
    ]);

    fs.rmSync(configPath, { recursive: true });
    fs.writeFileSync(configPath, stableConfig);
    const next = await spawnBridgePane(
      root,
      'psyche-test',
      {
        requestId: 'next',
        cwd: root,
        agent: 'claude',
        prompt: 'Review it safely',
        existingWorktree: {
          slug: base,
          worktreePath: first.worktreePath,
          branchName: first.branch,
        },
      },
      harness().deps,
    );
    expect(next.persistedPane?.slug).toBe(`${base}-a3`);

    await acknowledgeWorktreeRecoveryMarker(root, markers[0].id);
  });

  it('releases the failed sibling slug after teardown is confirmed absent', async () => {
    const first = await seedWorktree();
    const base = path.basename(first.worktreePath);
    const configPath = path.join(root, '.psyche', 'psyche.config.json');
    const stableConfig = fs.readFileSync(configPath, 'utf8');
    const failed = harness();
    let panePresent = true;
    failed.deps.beforeExistingWorktreePersist = () => {
      fs.rmSync(configPath);
      fs.mkdirSync(configPath);
    };
    failed.deps.killTmuxPane = () => {
      panePresent = false;
    };
    failed.deps.probeTmuxPane = () => panePresent ? 'present' : 'absent';

    await expect(spawnBridgePane(
      root,
      'psyche-test',
      {
        requestId: 'closed',
        cwd: root,
        agent: 'claude',
        prompt: 'Review it',
        existingWorktree: {
          slug: base,
          worktreePath: first.worktreePath,
          branchName: first.branch,
        },
      },
      failed.deps,
    )).rejects.toThrow();
    expect(await listWorktreeRecoveryMarkers(root)).toEqual([]);

    fs.rmSync(configPath, { recursive: true });
    fs.writeFileSync(configPath, stableConfig);
    const retry = await spawnBridgePane(
      root,
      'psyche-test',
      {
        requestId: 'retry',
        cwd: root,
        agent: 'claude',
        prompt: 'Review it',
        existingWorktree: {
          slug: base,
          worktreePath: first.worktreePath,
          branchName: first.branch,
        },
      },
      harness().deps,
    );
    expect(retry.persistedPane?.slug).toBe(`${base}-a2`);
  });

  // The property that matters most: a shared worktree belongs to other panes.
  // A failure while attaching must never take it — or their work — with it.
  it('does NOT delete the shared worktree when the attach fails', async () => {
    const first = await seedWorktree();
    fs.writeFileSync(path.join(first.worktreePath, 'UNCOMMITTED.txt'), 'precious\n');

    const h = harness();
    h.deps.createTmuxPane = () => { throw new Error('no space for a new pane'); };

    await expect(spawnBridgePane(
      root, 'psyche-test',
      {
        requestId: 'second', cwd: root, agent: 'claude', prompt: 'Review it',
        existingWorktree: {
          slug: path.basename(first.worktreePath),
          worktreePath: first.worktreePath,
          branchName: first.branch,
        },
      },
      h.deps,
    )).rejects.toThrow(/no space/);

    expect(fs.existsSync(first.worktreePath)).toBe(true);
    expect(fs.readFileSync(path.join(first.worktreePath, 'UNCOMMITTED.txt'), 'utf8')).toBe('precious\n');
    const branches = execSync("git for-each-ref --format='%(refname:short)' refs/heads", { cwd: root })
      .toString().split('\n').filter(Boolean);
    expect(branches).toContain(first.branch);
  });


  // The request's branchName is caller-supplied. spawnBridgePane is reachable
  // without the planner, so a wrong value would be persisted verbatim and every
  // later report and merge decision would inherit it.
  it('records the branch actually checked out, not the one the request claims', async () => {
    const seed = harness();
    const first = await spawnBridgePane(
      root, 'psyche-test',
      { requestId: 'first', cwd: root, agent: 'coven-code', prompt: 'Fix auth' },
      seed.deps,
    );

    const attached = await spawnBridgePane(
      root, 'psyche-test',
      {
        requestId: 'second', cwd: root, agent: 'claude', prompt: 'Review',
        existingWorktree: {
          slug: path.basename(first.worktreePath),
          worktreePath: first.worktreePath,
          branchName: 'psyche/totally-wrong-branch',
        },
      },
      harness().deps,
    );

    expect(attached.branch).toBe(first.branch);
    expect(attached.branch).not.toBe('psyche/totally-wrong-branch');

    const config = JSON.parse(
      fs.readFileSync(path.join(root, '.psyche', 'psyche.config.json'), 'utf8'),
    );
    const record = config.panes.find((p: any) => p.paneId === attached.id);
    expect(record.branchName).toBe(first.branch);
  });

  it('aborts an attach when the verified worktree OID changes before persistence', async () => {
    const first = await seedWorktree();
    const h = harness();
    h.deps.beforeExistingWorktreePersist = () => {
      execSync(
        'git -c commit.gpgsign=false -c user.email=t@t -c user.name=t commit -q --allow-empty -m changed-under-lease',
        { cwd: first.worktreePath },
      );
    };

    await expect(spawnBridgePane(
      root,
      'psyche-test',
      {
        requestId: 'identity-race',
        cwd: root,
        agent: 'claude',
        prompt: 'Review',
        existingWorktree: {
          slug: path.basename(first.worktreePath),
          worktreePath: first.worktreePath,
          branchName: first.branch,
        },
      },
      h.deps,
    )).rejects.toMatchObject({ code: 'worktree_identity_changed' });
  });

  it('rejects a worktree outside the project root', async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'psyche-outside-')));
    try {
      const h = harness();
      await expect(spawnBridgePane(
        root, 'psyche-test',
        {
          requestId: 'r', cwd: root, agent: 'claude', prompt: 'p',
          existingWorktree: { slug: 'x', worktreePath: outside, branchName: 'b' },
        },
        h.deps,
      )).rejects.toMatchObject({ code: 'invalid_worktree_path' });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects a path that is inside the project but not a registered worktree', async () => {
    const decoy = path.join(root, '.psyche', 'worktrees', 'not-a-worktree');
    fs.mkdirSync(decoy, { recursive: true });

    const h = harness();
    await expect(spawnBridgePane(
      root, 'psyche-test',
      {
        requestId: 'r', cwd: root, agent: 'claude', prompt: 'p',
        existingWorktree: { slug: 'x', worktreePath: decoy, branchName: 'b' },
      },
      h.deps,
    )).rejects.toMatchObject({ code: 'invalid_worktree_path' });
  });
});

describe('concurrent shared-worktree attach', () => {
  // Regression: the sibling slug was allocated from config BEFORE entering the
  // serialized config mutation, so two concurrent attaches to the same worktree
  // both computed fix-auth-a2. Same check-then-act shape as the worktree claim
  // and the config write, reintroduced in the attach path.
  it('gives concurrent attaches distinct sibling slugs', async () => {
    const seed = harness();
    const first = await spawnBridgePane(
      root, 'psyche-test',
      { requestId: 'first', cwd: root, agent: 'coven-code', prompt: 'Fix auth' },
      seed.deps,
    );
    const existingWorktree = {
      slug: path.basename(first.worktreePath),
      worktreePath: first.worktreePath,
      branchName: first.branch,
    };

    await Promise.all(['a', 'b', 'c'].map((id) =>
      spawnBridgePane(
        root, 'psyche-test',
        { requestId: id, cwd: root, agent: 'claude', prompt: 'Review', existingWorktree },
        harness().deps,
      )));

    const config = JSON.parse(
      fs.readFileSync(path.join(root, '.psyche', 'psyche.config.json'), 'utf8'),
    );
    const slugs = config.panes.map((p: any) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).toHaveLength(4);
  });

  it('serializes mixed daemon and local sibling allocation through persistence', async () => {
    const seed = await spawnBridgePane(
      root,
      'psyche-test',
      { requestId: 'seed', cwd: root, agent: 'coven-code', prompt: 'Fix auth' },
      harness().deps,
    );
    const targetPane = {
      slug: path.basename(seed.worktreePath),
      worktreePath: seed.worktreePath,
    };
    const existingWorktree = {
      ...targetPane,
      branchName: seed.branch,
    };

    let releaseLocalPersistence!: () => void;
    const localMayPersist = new Promise<void>((resolve) => {
      releaseLocalPersistence = resolve;
    });
    let localAllocated!: () => void;
    const localHasAllocated = new Promise<void>((resolve) => {
      localAllocated = resolve;
    });

    let localSlug = '';
    const localAttach = withProjectPaneSlugAllocationLock(root, async () => {
      const config = await readProjectPaneConfigUnderLock(root);
      const freshPanes = Array.isArray(config.panes)
        ? config.panes.map((pane) => ({ slug: String(pane.slug ?? '') }))
        : [];
      localSlug = generateSiblingSlugForTargetPane(targetPane, freshPanes);
      localAllocated();
      await localMayPersist;
      await mutateProjectPaneConfig(root, (freshConfig) => {
        const panes = Array.isArray(freshConfig.panes) ? freshConfig.panes : [];
        freshConfig.panes = [
          ...panes,
          {
            id: 'local-sibling',
            paneId: '%local',
            slug: localSlug,
            worktreePath: seed.worktreePath,
            branchName: seed.branch,
          },
        ];
      });
    });

    await localHasAllocated;
    let daemonReachedPersistence = false;
    const daemonAttach = spawnBridgePane(
      root,
      'psyche-test',
      {
        requestId: 'daemon-sibling',
        cwd: root,
        agent: 'claude',
        prompt: 'Review',
        existingWorktree,
      },
      {
        ...harness().deps,
        beforeExistingWorktreePersist: () => {
          daemonReachedPersistence = true;
        },
      },
    );

    await waitForSlugAllocationWaiter();
    expect(daemonReachedPersistence).toBe(false);

    releaseLocalPersistence();
    const [, daemonResult] = await Promise.all([localAttach, daemonAttach]);

    expect(localSlug).toBe(`${targetPane.slug}-a2`);
    expect(daemonResult.persistedPane?.slug).toBe(`${targetPane.slug}-a3`);
    const config = JSON.parse(
      fs.readFileSync(path.join(root, '.psyche', 'psyche.config.json'), 'utf8'),
    );
    const siblingSlugs = config.panes
      .map((pane: any) => pane.slug)
      .filter((slug: string) => slug.startsWith(`${targetPane.slug}-a`));
    expect(siblingSlugs).toEqual([localSlug, daemonResult.persistedPane?.slug]);
  });
});
