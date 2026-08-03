import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  spawnBridgePane,
  type BridgeSpawnPromptKeysRequest,
} from '../../src/daemon/bridge.js';

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'psyche-spawn-transport-')));
  execSync('git init', { cwd: root, stdio: 'ignore' });
  execSync('git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', {
    cwd: root,
    stdio: 'ignore',
  });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function harness() {
  const commands: string[] = [];
  const sendPromptKeys = vi.fn(async (_request: BridgeSpawnPromptKeysRequest) => {});
  return {
    commands,
    sendPromptKeys,
    deps: {
      tmuxSessionExists: () => true,
      createTmuxPane: () => '%9',
      sendTmuxCommand: (_paneId: string, command: string) => {
        commands.push(command);
      },
      sendPromptKeys,
    },
  };
}

async function spawn(agent: string, prompt: string | undefined, h = harness()) {
  const result = await spawnBridgePane(
    root,
    'psyche-test',
    { requestId: 'req-1', cwd: root, agent, prompt, title: `${agent}-lane` },
    h.deps,
  );
  return { ...h, result };
}

/** Prompt files land under <root>/.psyche/prompts. */
function promptFiles(): string[] {
  const dir = path.join(root, '.psyche', 'prompts');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

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

  it('leaves no orphaned prompt file for send-keys agents', async () => {
    await spawn('cline', 'Fix the failing auth tests');
    expect(promptFiles()).toEqual([]);
  });

  it.each([
    ['coven-code', 'positional'],
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
