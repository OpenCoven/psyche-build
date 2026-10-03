/**
 * #523: what each prompt transport leaves in the AGENT's own argv.
 *
 * Every registry agent is launched through the real `launchAgentInPane`
 * against a fake tmux (no tmux runs). The line it types is then run by
 * /bin/sh on a confined PATH whose agent names all resolve to one FAKE agent
 * script that records its argv and its stdin. For the paste transport, the
 * bytes Psyche loaded into the tmux buffer are what the pane would deliver to
 * the agent's terminal, so they are fed to the fake on stdin.
 *
 * No real agent CLI is ever executed: the PATH is verified to resolve every
 * agent name to the fake directory before anything runs.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AGENT_IDS,
  AGENT_REGISTRY,
  getAgentProcessName,
  getPromptTransport,
  launchAgentInPane,
  promptReachesAgentArgv,
  type AgentName,
} from '../src/utils/agentLaunch.js';

vi.mock('../src/utils/geminiTrust.js', () => ({
  ensureGeminiFolderTrusted: vi.fn(() => {}),
}));

const PROMPT = 'zq-secret-prompt "quoted" $HOME `tick` it\'s #1';
const PROMPT_MARKER = 'zq-secret-prompt';

const FAKE_AGENT_SCRIPT = `#!/bin/sh
name=$(basename "$0")
: > "$FAKE_AGENT_LOG/$name.argv"
for arg in "$@"; do printf '%s\\n' "$arg" >> "$FAKE_AGENT_LOG/$name.argv"; done
if [ -t 0 ]; then
  IFS= read -r line
  printf '%s' "$line" > "$FAKE_AGENT_LOG/$name.stdin"
else
  cat > "$FAKE_AGENT_LOG/$name.stdin"
fi
`;

/** Every executable name any registry command can start. */
const AGENT_EXECUTABLES = [...new Set(
  AGENT_IDS.flatMap((agent) => {
    const entry = AGENT_REGISTRY[agent];
    return [entry.promptCommand, entry.noPromptCommand ?? '']
      .map((command) => command.trim().split(/\s+/)[0])
      .filter(Boolean);
  }),
)];

let sandbox: string;
let fakeBin: string;
let confinedPath: string;

beforeAll(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'psyche-argv-')));
  fakeBin = path.join(sandbox, 'bin');
  fs.mkdirSync(fakeBin);
  const script = path.join(fakeBin, '.fake-agent');
  fs.writeFileSync(script, FAKE_AGENT_SCRIPT, { mode: 0o755 });
  for (const name of AGENT_EXECUTABLES) {
    fs.symlinkSync(script, path.join(fakeBin, name));
  }
  confinedPath = `${fakeBin}:/usr/bin:/bin`;

  // Never run a real agent: every name must resolve inside the fake dir.
  const resolved = execFileSync(
    '/bin/sh',
    ['-c', `for n in ${AGENT_EXECUTABLES.join(' ')}; do command -v "$n"; done`],
    { env: { PATH: confinedPath }, encoding: 'utf8' },
  ).trim().split('\n');
  expect(resolved).toHaveLength(AGENT_EXECUTABLES.length);
  for (const entry of resolved) {
    expect(path.dirname(entry)).toBe(fakeBin);
  }
});

afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

interface FakeTmuxRecord {
  typedLines: string[];
  tmuxArgs: string[];
  pastedBuffers: Map<string, string>;
  pastedIntoPane: string[];
}

/** Records every argument; the buffer content arrives only as stdin data. */
function fakeTmux(agent: AgentName) {
  const record: FakeTmuxRecord = {
    typedLines: [],
    tmuxArgs: [],
    pastedBuffers: new Map(),
    pastedIntoPane: [],
  };
  let launched = false;
  const tmux = {
    sendShellCommand: vi.fn(async (paneId: string, command: string) => {
      record.tmuxArgs.push(paneId, command);
      record.typedLines.push(command);
    }),
    sendTmuxKeys: vi.fn(async (paneId: string, keys: string) => {
      record.tmuxArgs.push(paneId, keys);
      if (keys === 'Enter' && record.typedLines.length > 0) launched = true;
    }),
    getPaneCurrentCommand: vi.fn(async (paneId: string) => {
      record.tmuxArgs.push(paneId);
      return launched ? getAgentProcessName(agent) : 'sh';
    }),
    loadBufferFromStdin: vi.fn(async (name: string, content: string) => {
      record.tmuxArgs.push(name);
      record.pastedBuffers.set(name, content);
    }),
    pasteBufferAndDelete: vi.fn(async (name: string, paneId: string) => {
      record.tmuxArgs.push(name, paneId);
      record.pastedIntoPane.push(record.pastedBuffers.get(name) ?? '');
      record.pastedBuffers.delete(name);
    }),
    deleteBuffer: vi.fn(async (name: string) => {
      record.tmuxArgs.push(name);
      record.pastedBuffers.delete(name);
    }),
  };
  return { tmux, record };
}

function zeroClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

interface AgentRun {
  argv: string[];
  stdin: string;
  record: FakeTmuxRecord;
  promptDir: string;
}

async function runAgent(agent: AgentName): Promise<AgentRun> {
  const projectRoot = fs.mkdtempSync(path.join(sandbox, `${agent}-`));
  const log = path.join(projectRoot, 'log');
  fs.mkdirSync(log);
  const { tmux, record } = fakeTmux(agent);

  await launchAgentInPane({
    paneId: '%1',
    agent,
    prompt: PROMPT,
    slug: 'argv-check',
    projectRoot,
    psychePaneId: 'psyche-1',
    tmuxService: tmux as never,
    paneShellProbe: zeroClock(),
    promptPasteClock: zeroClock(),
    promptSkipReport: { logWarn: vi.fn(), showToast: vi.fn() },
  });

  expect(record.typedLines).toHaveLength(1);
  execFileSync('/bin/sh', ['-c', record.typedLines[0]], {
    cwd: projectRoot,
    env: { PATH: confinedPath, HOME: projectRoot, FAKE_AGENT_LOG: log },
    input: record.pastedIntoPane.join(''),
    stdio: ['pipe', 'ignore', 'ignore'],
    timeout: 10_000,
  });

  const executable = getAgentProcessName(agent);
  const argvFile = path.join(log, `${executable}.argv`);
  const stdinFile = path.join(log, `${executable}.stdin`);
  return {
    argv: fs.existsSync(argvFile) ? fs.readFileSync(argvFile, 'utf8').split('\n') : [],
    stdin: fs.existsSync(stdinFile) ? fs.readFileSync(stdinFile, 'utf8') : '',
    record,
    promptDir: path.join(projectRoot, '.psyche', 'prompts'),
  };
}

describe('agent prompt argv exposure (#523)', () => {
  it.each(AGENT_IDS.map((agent) => [agent, getPromptTransport(agent)] as const))(
    '%s (%s): the prompt is in the agent argv only when the registry records why',
    async (agent, transport) => {
      const run = await runAgent(agent);
      const argvHasPrompt = run.argv.some((arg) => arg.includes(PROMPT_MARKER));

      // The fake agent actually started.
      expect(run.argv.length).toBeGreaterThan(0);

      // Psyche itself never puts the prompt in a tmux argument or typed line.
      expect(run.record.tmuxArgs.join('\n')).not.toContain(PROMPT_MARKER);
      // No prompt buffer outlives the paste.
      expect(run.record.pastedBuffers.size).toBe(0);
      // Read-and-delete: no prompt file is left behind.
      expect(fs.existsSync(run.promptDir) ? fs.readdirSync(run.promptDir) : []).toEqual([]);

      expect(argvHasPrompt).toBe(promptReachesAgentArgv(agent));
      if (promptReachesAgentArgv(agent)) {
        expect(AGENT_REGISTRY[agent].promptArgvExposure?.trim()).toBeTruthy();
        expect(run.argv).toContain(PROMPT);
      } else if (transport === 'launch-only') {
        expect(run.stdin).not.toContain(PROMPT_MARKER);
      } else {
        // stdin and send-keys: the agent receives the exact prompt off-argv.
        expect(run.stdin.replace(/\n$/, '')).toBe(PROMPT);
      }
    },
  );

  it('records the residual argv exposure as an explicit, closed set', () => {
    expect(AGENT_IDS.filter(promptReachesAgentArgv)).toEqual([
      'claude', 'opencode', 'codex', 'gemini', 'qwen', 'pi', 'cursor', 'copilot',
    ]);
  });
});
