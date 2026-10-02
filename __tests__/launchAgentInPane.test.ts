import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { LogService } from '../src/services/LogService.js';
import {
  AGENT_IDS,
  buildAgentCommand,
  getPromptTransport,
  launchAgentInPane,
  type LaunchAgentInPaneOptions,
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

function createTmux(paneCommand = 'zsh') {
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
    getPaneCurrentCommand: vi.fn(async () => paneCommand),
  };
}

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(process.cwd(), '.psyche-launch-'));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

async function launch(
  agent: AgentName,
  prompt = 'Fix the failing tests',
  extra: Partial<LaunchAgentInPaneOptions> = {},
  paneCommand = 'zsh',
) {
  const tmux = createTmux(paneCommand);
  const result = await launchAgentInPane({
    paneId: '%1',
    agent,
    prompt,
    slug: 'fix-tests',
    projectRoot,
    psychePaneId: 'psyche-1',
    tmuxService: tmux as never,
    ...extra,
  });
  return Object.assign(tmux, { result });
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

  it('launches coven-code bare even when a prompt is provided', async () => {
    const tmux = await launch('coven-code');

    expect(tmux.shellCommands[0]).toBe('coven');
  });

  it('suppresses coven-code permission flags', async () => {
    const tmux = await launch('coven-code', '', { permissionMode: 'plan' });

    expect(tmux.shellCommands[0]).toBe('coven');
  });

  describe('prompt transports', () => {
    it('treats coven-code as a launch-only transport', async () => {
      expect(getPromptTransport('coven-code')).toBe('launch-only');
      const tmux = await launch('coven-code', 'Fix the failing tests');

      expect(tmux.shellCommands[0]).toBe('coven');
      expect(tmux.shellCommands[0]).not.toContain('PSYCHE_PROMPT_CONTENT');
      expect(sendPromptViaTmux).not.toHaveBeenCalled();
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
      expect(tmux.shellCommands[0]).toBe('coven');
      expect(sendPromptViaTmux).not.toHaveBeenCalled();
    });

    it('treats a whitespace-only prompt as no prompt', async () => {
      const tmux = await launch('coven-code', '   \n  ');
      expect(tmux.shellCommands[0]).toBe('coven');
    });
  });

  describe('agent-specific setup', () => {
    it('wraps codex in its hook command', async () => {
      const tmux = await launch('codex', 'Fix it', {
        codexHookEventFile: path.join(projectRoot, 'events.json'),
      });
      expect(tmux.shellCommands[0]).toContain('PSYCHE_PANE_ID');
    });

    it('does not wrap non-codex agents in codex hooks', async () => {
      const tmux = await launch('coven-code');
      expect(tmux.shellCommands[0]).not.toContain('PSYCHE_TMUX_PANE_ID=');
    });

    it('trusts the worktree folder for gemini', async () => {
      const worktreePath = fs.mkdtempSync(path.join(process.cwd(), '.psyche-wt-'));
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
    it('never bootstraps a prompt file for coven-code', async () => {
      const tmux = await launch('coven-code', 'a "quoted" $prompt with `backticks`');

      // Launch-only agents must never receive the prompt at all.
      expect(tmux.shellCommands[0]).not.toContain('backticks');
      expect(tmux.shellCommands[0]).toBe('coven');
      expect(tmux.shellCommands[0]).not.toContain('$PSYCHE_PROMPT_CONTENT');
    });

    it('still launches coven-code bare when prompt-file writes fail', async () => {
      const tmux = await launch('coven-code', 'say "hi"', {
        projectRoot: '/nonexistent-root-for-prompt-file',
      });

      expect(tmux.shellCommands[0]).toBe('coven');
      expect(tmux.shellCommands[0]).not.toContain('PSYCHE_PROMPT_CONTENT');
    });
  });
  describe('exit recording', () => {
    it('appends the exit recorder after the agent command when asked', async () => {
      const tmux = await launch('coven-code', '', {
        exitRecorder: { nonce: '0a1b2c3d' },
      });

      expect(tmux.shellCommands[0]).toBe(
        'coven; tmux set-option -p -t "$TMUX_PANE" @psyche_agent_exit "0a1b2c3d:$?" 2>/dev/null',
      );
    });

    it('records the status of the agent, not of the prompt bootstrap', async () => {
      const tmux = await launch('opencode', 'Fix it', {
        exitRecorder: { nonce: '0a1b2c3d' },
      });

      const command = tmux.shellCommands[0];
      // The recorder must follow the agent invocation directly, so `$?` is
      // the agent's own exit status.
      expect(command).toMatch(
        /--prompt "\$PSYCHE_PROMPT_CONTENT"; tmux set-option -p -t "\$TMUX_PANE" @psyche_agent_exit "0a1b2c3d:\$\?" 2>\/dev\/null$/u,
      );
      expect(command).not.toContain('Fix it');
    });

    it('wraps the hooked codex command too', async () => {
      const tmux = await launch('codex', '', {
        exitRecorder: { nonce: '0a1b2c3d' },
      });

      expect(tmux.shellCommands[0]).toMatch(/codex.*; tmux set-option -p .*"0a1b2c3d:\$\?" 2>\/dev\/null$/u);
    });

    it('sends no recorder when none is requested', async () => {
      const tmux = await launch('coven-code', '');
      expect(tmux.shellCommands[0]).not.toContain('@psyche_agent_exit');
      expect(tmux.result.exitRecorderArmed).toBe(false);
    });

    it('reports the recorder armed for a POSIX shell', async () => {
      const tmux = await launch('coven-code', '', { exitRecorder: { nonce: '0a1b2c3d' } }, 'bash');
      expect(tmux.result.exitRecorderArmed).toBe(true);
    });

    it('uses $status when the pane runs fish, whatever $SHELL says', async () => {
      const savedShell = process.env.SHELL;
      process.env.SHELL = '/bin/zsh';
      try {
        const tmux = await launch('coven-code', '', { exitRecorder: { nonce: '0a1b2c3d' } }, 'fish');
        expect(tmux.shellCommands[0]).toBe(
          'coven; tmux set-option -p -t "$TMUX_PANE" @psyche_agent_exit "0a1b2c3d:$status" 2>/dev/null',
        );
        expect(tmux.result.exitRecorderArmed).toBe(true);
      } finally {
        process.env.SHELL = savedShell;
      }
    });

    it('uses $? when the pane runs zsh even if $SHELL is fish', async () => {
      const savedShell = process.env.SHELL;
      process.env.SHELL = '/opt/homebrew/bin/fish';
      try {
        const tmux = await launch('coven-code', '', { exitRecorder: { nonce: '0a1b2c3d' } }, 'zsh');
        expect(tmux.shellCommands[0]).toContain('"0a1b2c3d:$?"');
      } finally {
        process.env.SHELL = savedShell;
      }
    });

    // An unknown shell would reject the suffix and the agent would never
    // start, which is worse than an unclassified launch.
    it.each(['nu', 'tcsh', 'xonsh', ''])('launches bare and unarmed in a %j pane', async (paneCommand) => {
      const tmux = await launch('coven-code', '', { exitRecorder: { nonce: '0a1b2c3d' } }, paneCommand);
      expect(tmux.shellCommands[0]).toBe('coven');
      expect(tmux.result.exitRecorderArmed).toBe(false);
    });

    it('launches bare and unarmed when the pane shell cannot be read', async () => {
      const tmux = createTmux();
      tmux.getPaneCurrentCommand.mockRejectedValueOnce(new Error('tmux busy'));
      const result = await launchAgentInPane({
        paneId: '%1',
        agent: 'coven-code',
        prompt: '',
        slug: 'fix-tests',
        projectRoot,
        exitRecorder: { nonce: '0a1b2c3d' },
        tmuxService: tmux as never,
      });
      expect(tmux.shellCommands[0]).toBe('coven');
      expect(result.exitRecorderArmed).toBe(false);
    });

    // The suffix is joined with `;`. A command ending in `#` (comment), `&`
    // (background), or `\` (continuation) would swallow or detach it.
    const suffix = '; tmux set-option -p -t "$TMUX_PANE" @psyche_agent_exit "0a1b2c3d:$?" 2>/dev/null';
    it.each(AGENT_IDS.flatMap((agent) => [
      [agent, 'Fix the failing tests'],
      [agent, ''],
    ] as const))('ends the %s launch (prompt %j) with the recorder intact', async (agent, prompt) => {
      const tmux = await launch(agent as AgentName, prompt, { exitRecorder: { nonce: '0a1b2c3d' } }, 'sh');
      const command = tmux.shellCommands[0];

      expect(command.endsWith(suffix)).toBe(true);
      const agentPart = command.slice(0, -suffix.length);
      expect(agentPart).not.toMatch(/[#&\\]\s*$/u);
      expect(agentPart).not.toMatch(/(^|\s)#/u);
      expect(tmux.result.exitRecorderArmed).toBe(true);
    });
  });
});

/** Absolute path of a shell on this host, or null when it is not installed. */
function findShell(name: string): string | null {
  for (const dir of ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin']) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Parses (never runs) a typed line with a real shell when the host has it:
 * `-n` / `--no-execute` checks syntax only, so no agent CLI is launched.
 */
function assertParses(shellName: string, line: string): void {
  const shell = findShell(shellName);
  if (!shell) return;
  const args = shellName === 'fish' ? ['--no-execute', '-c', line] : ['-n', '-c', line];
  execFileSync(shell, args, { stdio: 'pipe' });
}

function promptFilesIn(root: string): string[] {
  const dir = path.join(root, '.psyche', 'prompts');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

describe('prompt bootstrap follows the pane shell (#508)', () => {
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
    const tmux = await launch('opencode', 'Fix it', {}, 'zsh');
    const line = tmux.shellCommands[0];
    expect(line).toMatch(/^PSYCHE_PROMPT_FILE='[^']+'; PSYCHE_PROMPT_CONTENT="\$\(cat /u);
    expect(line).not.toMatch(/(^|; )set /u);
    expect(line).not.toContain('Fix it');
    assertParses('zsh', line);
  });

  it('uses fish syntax in a fish pane even when $SHELL is zsh', async () => {
    process.env.SHELL = '/bin/zsh';
    const tmux = await launch('opencode', 'Fix it', {}, 'fish');
    const line = tmux.shellCommands[0];
    expect(line).toMatch(/^set PSYCHE_PROMPT_FILE '[^']+'; set PSYCHE_PROMPT_CONTENT /u);
    expect(line).not.toContain('PSYCHE_PROMPT_FILE=');
    expect(line).not.toContain('Fix it');
    assertParses('fish', line);
  });

  it.each(['nu', 'tcsh', 'xonsh', ''])(
    'launches bare, writes no prompt file, and warns in a %j pane',
    async (paneCommand) => {
      const tmux = await launch('opencode', 'Fix "it" $now', {}, paneCommand);
      expect(tmux.shellCommands[0]).toBe(buildAgentCommand('opencode', undefined));
      expect(promptFilesIn(projectRoot)).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      const [message, source, paneId] = warn.mock.calls[0] as [string, string, string];
      expect(message).toContain('without its initial prompt');
      expect(message).not.toContain('Fix');
      expect(message).not.toContain(projectRoot);
      expect(source).toBe('agentLaunch');
      expect(paneId).toBe('%1');
    },
  );

  it('launches bare and warns when the pane shell cannot be read', async () => {
    const tmux = createTmux();
    tmux.getPaneCurrentCommand.mockRejectedValueOnce(new Error('tmux busy'));
    await launchAgentInPane({
      paneId: '%1',
      agent: 'claude',
      prompt: 'Fix it',
      slug: 'fix-tests',
      projectRoot,
      tmuxService: tmux as never,
    });
    expect(tmux.shellCommands[0]).toBe('claude');
    expect(promptFilesIn(projectRoot)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('could not be read');
  });

  it('does not inline the prompt for an unknown shell even when the prompt file cannot be written', async () => {
    const tmux = await launch('claude', 'say "hi" $x', {
      projectRoot: '/nonexistent-root-for-prompt-file',
    }, 'nu');
    expect(tmux.shellCommands[0]).toBe('claude');
  });

  it('does not warn when the agent takes no command-line prompt', async () => {
    await launch('cline', 'Fix it', {}, 'nu');
    await launch('coven-code', 'Fix it', {}, 'nu');
    await launch('opencode', '', {}, 'nu');
    expect(warn).not.toHaveBeenCalled();
  });

  // Every agent and transport, in every pane shell: the typed line must be one
  // that shell parses, must keep the prompt off the line, and must leave no
  // prompt file behind when it cannot be read back.
  const PANE_SHELLS = ['sh', 'bash', 'zsh', 'dash', 'ksh', '-zsh', 'fish', 'nu', 'tcsh', 'xonsh', '<unreadable>'];
  const PROMPT = 'Fix "the" $tests `now`; it\'s #1 & done';
  it.each(AGENT_IDS.flatMap((agent) => PANE_SHELLS.map((shell) => [agent, getPromptTransport(agent), shell] as const)))(
    '%s (%s) in a %s pane types a line valid for that shell',
    async (agent, transport, paneShell) => {
      const tmux = createTmux(paneShell);
      if (paneShell === '<unreadable>') {
        tmux.getPaneCurrentCommand.mockRejectedValue(new Error('no pane'));
      }
      await launchAgentInPane({
        paneId: '%1',
        agent,
        prompt: PROMPT,
        slug: 'table',
        projectRoot,
        psychePaneId: 'psyche-1',
        tmuxService: tmux as never,
      });
      const line = tmux.shellCommands[0];
      expect(line).toBeTruthy();
      // The prompt itself is never typed into the shell.
      expect(line).not.toContain('the" $tests');
      expect(line).not.toContain('Fix');

      const name = paneShell.replace(/^-/u, '');
      const takesCommandLinePrompt = transport === 'positional' || transport === 'option' || transport === 'stdin';
      if (['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(name)) {
        if (takesCommandLinePrompt) expect(line).toMatch(/(^|; )PSYCHE_PROMPT_FILE='/u);
        expect(line).not.toMatch(/(^|; )set PSYCHE_/u);
        assertParses(name, line);
      } else if (name === 'fish') {
        if (takesCommandLinePrompt) expect(line).toMatch(/(^|; )set PSYCHE_PROMPT_FILE '/u);
        expect(line).not.toContain('PSYCHE_PROMPT_FILE=');
        assertParses('fish', line);
      } else {
        // No dialect: nothing shell-specific about the prompt, and no file.
        expect(line).not.toContain('PSYCHE_PROMPT');
        expect(promptFilesIn(projectRoot)).toEqual([]);
        if (agent !== 'codex') expect(line).toBe(buildAgentCommand(agent, undefined));
        if (name === 'tcsh') assertParses('tcsh', line);
      }
    },
  );
});
