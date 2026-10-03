/**
 * #523 integration: the argv-free paste transport against a REAL tmux server
 * on a PRIVATE socket, with a FAKE agent.
 *
 * - `tmux` on this test's PATH is a shim that always passes `-S <temp socket>`,
 *   so neither TmuxService nor anything else here can reach the developer's
 *   tmux server. The socket is checked before anything is typed.
 * - The pane runs a shell with a confined PATH in which every agent name
 *   resolves to the fake agent script; that is checked before typing too.
 * - The fake agent records its argv and the line it receives on its terminal.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../src/utils/geminiTrust.js', () => ({
  ensureGeminiFolderTrusted: vi.fn(() => {}),
}));

function findExecutable(name: string): string | null {
  try {
    const found = execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
    return found.startsWith('/') ? found : null;
  } catch {
    return null;
  }
}

const realTmux = findExecutable('tmux');
const paneShell = ['/bin/zsh', '/bin/bash'].find((candidate) => fs.existsSync(candidate));
// A shebang cannot carry a path with spaces portably.
const nodeUsable = !/\s/.test(process.execPath);

const PROMPT = 'zq-pasted-prompt "quoted" $HOME it\'s #1';
const AGENT_NAMES = [
  'claude', 'opencode', 'codex', 'cline', 'gemini', 'qwen',
  'amp', 'pi', 'cursor-agent', 'copilot', 'crush', 'coven',
];

// A node script, not a shell script: the pane must report a non-shell
// foreground for readiness, exactly as a real agent binary would. It records
// its argv, then the first line typed on its terminal.
const FAKE_AGENT_SCRIPT = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const name = path.basename(process.argv[1]);
const log = process.env.FAKE_AGENT_LOG;
fs.writeFileSync(path.join(log, name + '.argv'), process.argv.slice(2).join('\\n'));
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  const end = input.search(/[\\r\\n]/);
  if (end >= 0) {
    fs.writeFileSync(path.join(log, name + '.stdin'), input.slice(0, end));
    process.exit(0);
  }
});
`;

describe.skipIf(!realTmux || !paneShell || !nodeUsable)('pasted prompt on a private tmux socket (#523)', () => {
  let sandbox: string;
  let socket: string;
  let log: string;
  let savedPath: string | undefined;
  let savedTmux: string | undefined;

  const privateTmux = (...args: string[]): string =>
    execFileSync(realTmux!, ['-S', socket, ...args], { encoding: 'utf8' }).trim();

  beforeAll(() => {
    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'psyche-paste-')));
    socket = path.join(sandbox, 'tmux.sock');
    log = path.join(sandbox, 'log');
    fs.mkdirSync(log);

    const fakeBin = path.join(sandbox, 'agents');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, '.fake-agent'), FAKE_AGENT_SCRIPT, { mode: 0o755 });
    for (const name of AGENT_NAMES) {
      fs.symlinkSync(path.join(fakeBin, '.fake-agent'), path.join(fakeBin, name));
    }
    const confinedPath = `${fakeBin}:/usr/bin:/bin`;
    const resolved = execFileSync(
      '/bin/sh',
      ['-c', `for n in ${AGENT_NAMES.join(' ')}; do command -v "$n"; done`],
      { env: { PATH: confinedPath }, encoding: 'utf8' },
    ).trim().split('\n');
    expect(resolved.map((entry) => path.dirname(entry))).toEqual(AGENT_NAMES.map(() => fakeBin));

    const shimBin = path.join(sandbox, 'shim');
    fs.mkdirSync(shimBin);
    fs.writeFileSync(
      path.join(shimBin, 'tmux'),
      `#!/bin/sh\nexec '${realTmux}' -S '${socket}' "$@"\n`,
      { mode: 0o755 },
    );

    savedPath = process.env.PATH;
    savedTmux = process.env.TMUX;
    delete process.env.TMUX;
    process.env.PATH = `${shimBin}:${savedPath ?? '/usr/bin:/bin'}`;

    privateTmux(
      'new-session', '-d', '-s', 'psyche-argv', '-x', '120', '-y', '30',
      `env -i PATH='${confinedPath}' HOME='${sandbox}' FAKE_AGENT_LOG='${log}' ${paneShell} -f`,
    );
    // Every tmux call Psyche makes now goes through the shim to this socket.
    expect(execFileSync('tmux', ['display-message', '-p', '#{socket_path}'], { encoding: 'utf8' }).trim())
      .toBe(socket);
  });

  afterAll(() => {
    process.env.PATH = savedPath;
    if (savedTmux !== undefined) process.env.TMUX = savedTmux;
    try {
      privateTmux('kill-server');
    } catch {
      // Already gone.
    }
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('delivers the prompt to the agent terminal with no argv exposure and no leftover buffer', async () => {
    const { launchAgentInPane } = await import('../src/utils/agentLaunch.js');
    const { TmuxService } = await import('../src/services/TmuxService.js');

    const paneId = privateTmux('display-message', '-p', '-t', 'psyche-argv', '#{pane_id}');
    // The pane's shell is up before anything is typed.
    for (let i = 0; i < 50 && !/^(zsh|bash)$/.test(privateTmux('display-message', '-p', '-t', paneId, '#{pane_current_command}')); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const result = await launchAgentInPane({
      paneId,
      agent: 'cline',
      prompt: PROMPT,
      slug: 'paste-check',
      projectRoot: sandbox,
      tmuxService: TmuxService.getInstance(),
      promptSkipReport: { logWarn: vi.fn(), showToast: vi.fn() },
    });
    // On failure, show the pane (fake agent and shell output only) to tell a
    // slow host from a real regression.
    const diagnostics = () => `skipped=${String(result.initialPromptSkipped)}\n${privateTmux('capture-pane', '-p', '-t', paneId)}`;
    expect(result.initialPromptSkipped, diagnostics()).toBeNull();

    const stdinFile = path.join(log, 'cline.stdin');
    for (let i = 0; i < 200 && !fs.existsSync(stdinFile); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(fs.existsSync(stdinFile), diagnostics()).toBe(true);
    expect(fs.readFileSync(stdinFile, 'utf8')).toBe(PROMPT);
    expect(fs.readFileSync(path.join(log, 'cline.argv'), 'utf8')).not.toContain('zq-pasted-prompt');
    expect(privateTmux('list-buffers')).toBe('');
  }, 60_000);
});
