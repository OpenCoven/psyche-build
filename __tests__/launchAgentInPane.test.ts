import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AGENT_IDS,
  getPromptTransport,
  launchAgentInPane,
  type AgentName,
} from '../src/utils/agentLaunch.js';

vi.mock('../src/utils/agentPromptDispatch.js', () => ({
  sendPromptViaTmux: vi.fn(async () => {}),
}));
vi.mock('../src/utils/geminiTrust.js', () => ({
  ensureGeminiFolderTrusted: vi.fn(() => {}),
}));

const { sendPromptViaTmux } = await import('../src/utils/agentPromptDispatch.js');
const { ensureGeminiFolderTrusted } = await import('../src/utils/geminiTrust.js');

function createTmux() {
  const shellCommands: string[] = [];
  const keys: Array<[string, string]> = [];
  return {
    shellCommands,
    keys,
    sendShellCommand: vi.fn(async (_paneId: string, command: string) => {
      shellCommands.push(command);
    }),
    sendTmuxKeys: vi.fn(async (paneId: string, key: string) => {
      keys.push([paneId, key]);
    }),
    getPaneCurrentCommand: vi.fn(async () => 'zsh'),
  };
}

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'psyche-launch-'));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

async function launch(agent: AgentName, prompt = 'Fix the failing tests', extra = {}) {
  const tmux = createTmux();
  await launchAgentInPane({
    paneId: '%1',
    agent,
    prompt,
    slug: 'fix-tests',
    projectRoot,
    psychePaneId: 'psyche-1',
    tmuxService: tmux as never,
    ...extra,
  });
  return tmux;
}

describe('launchAgentInPane', () => {
  // The regression that motivated making this generic: the previous
  // implementation branched on claude/codex/opencode and fell off the end for
  // every other registered agent, sending no command at all. coven-code — the
  // primary harness — was one of the silent ones.
  it.each(AGENT_IDS.map((agent) => [agent]))(
    'sends a launch command for %s',
    async (agent) => {
      const tmux = await launch(agent as AgentName);

      expect(tmux.sendShellCommand).toHaveBeenCalledTimes(1);
      expect(tmux.shellCommands[0]).toBeTruthy();
      expect(tmux.keys).toContainEqual(['%1', 'Enter']);
    },
  );

  it('launches coven-code with its prompt', async () => {
    const tmux = await launch('coven-code');

    expect(tmux.shellCommands[0]).toContain('coven-code');
    expect(tmux.shellCommands[0]).toContain('$PSYCHE_PROMPT_CONTENT');
  });

  it('applies coven-code permission flags', async () => {
    const tmux = await launch('coven-code', '', { permissionMode: 'plan' });

    expect(tmux.shellCommands[0]).toBe('coven-code --permission-mode plan');
  });

  describe('prompt transports', () => {
    it('passes the prompt positionally for coven-code', async () => {
      const tmux = await launch('coven-code');
      expect(tmux.shellCommands[0]).toMatch(/coven-code "\$PSYCHE_PROMPT_CONTENT"$/);
    });

    it('uses the configured option flag for option-transport agents', async () => {
      const tmux = await launch('opencode');
      expect(tmux.shellCommands[0]).toContain('--prompt "$PSYCHE_PROMPT_CONTENT"');
    });

    it('pipes over stdin for stdin-transport agents', async () => {
      const tmux = await launch('amp');
      expect(tmux.shellCommands[0]).toContain('printf');
      expect(tmux.shellCommands[0]).toContain('| amp');
    });

    it('launches send-keys agents bare and types the prompt afterwards', async () => {
      expect(getPromptTransport('cline')).toBe('send-keys');
      const tmux = await launch('cline');

      // The prompt must NOT be on the command line for these.
      expect(tmux.shellCommands[0]).not.toContain('PSYCHE_PROMPT_CONTENT');
      expect(sendPromptViaTmux).toHaveBeenCalledTimes(1);
      expect(vi.mocked(sendPromptViaTmux).mock.calls[0][0]).toMatchObject({
        paneId: '%1',
        prompt: 'Fix the failing tests',
        baselineCommand: 'zsh',
      });
    });

    it('does not invoke the send-keys path for positional agents', async () => {
      await launch('coven-code');
      expect(sendPromptViaTmux).not.toHaveBeenCalled();
    });
  });

  describe('no-prompt launches', () => {
    it('starts the bare command when there is no prompt', async () => {
      const tmux = await launch('coven-code', '');
      expect(tmux.shellCommands[0]).toBe('coven-code');
      expect(sendPromptViaTmux).not.toHaveBeenCalled();
    });

    it('treats a whitespace-only prompt as no prompt', async () => {
      const tmux = await launch('coven-code', '   \n  ');
      expect(tmux.shellCommands[0]).toBe('coven-code');
    });
  });

  describe('agent-specific setup', () => {
    it('wraps codex in its hook command', async () => {
      const tmux = await launch('codex', 'Fix it', {
        codexHookEventFile: '/tmp/events.json',
      });
      expect(tmux.shellCommands[0]).toContain('PSYCHE_PANE_ID');
    });

    it('does not wrap non-codex agents in codex hooks', async () => {
      const tmux = await launch('coven-code');
      expect(tmux.shellCommands[0]).not.toContain('PSYCHE_TMUX_PANE_ID=');
    });

    it('trusts the worktree folder for gemini', async () => {
      const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'psyche-wt-'));
      try {
        await launch('gemini', 'Fix it', { worktreePath });
        expect(ensureGeminiFolderTrusted).toHaveBeenCalledWith(worktreePath);
      } finally {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }
    });

    it('falls back to the project root when the worktree does not exist', async () => {
      await launch('gemini', 'Fix it', { worktreePath: '/does/not/exist' });
      expect(ensureGeminiFolderTrusted).toHaveBeenCalledWith(projectRoot);
    });

    it('does not run gemini trust setup for other agents', async () => {
      await launch('coven-code');
      expect(ensureGeminiFolderTrusted).not.toHaveBeenCalled();
    });
  });

  describe('prompt delivery safety', () => {
    it('writes the prompt to a file rather than inlining it', async () => {
      const tmux = await launch('coven-code', 'a "quoted" $prompt with `backticks`');

      // The raw prompt must never reach the command line.
      expect(tmux.shellCommands[0]).not.toContain('backticks');
      expect(tmux.shellCommands[0]).toContain('$PSYCHE_PROMPT_CONTENT');
    });

    it('escapes inline when the prompt file cannot be written', async () => {
      const tmux = await launch('coven-code', 'say "hi"', {
        projectRoot: '/nonexistent-root-for-prompt-file',
      });

      expect(tmux.shellCommands[0]).toContain('\\"hi\\"');
      expect(tmux.shellCommands[0]).not.toContain('PSYCHE_PROMPT_CONTENT');
    });
  });
});
