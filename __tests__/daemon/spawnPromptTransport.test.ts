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
