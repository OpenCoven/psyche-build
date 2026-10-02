/**
 * Agent-launch-failure observation for the recovery harness (#475).
 *
 * An agent pane is a live shell into which the cockpit types the agent
 * command. When that command is missing or exits at once, the shell returns to
 * its prompt and nothing else changes: the pane is alive, tmux is healthy, and
 * before #475 the product had no state for what happened.
 *
 * This module starts a disposable tmux server whose panes run a plain `sh`
 * with a PATH holding only fake agent CLIs, then drives the production launch
 * path (`launchAgentInPane` through the real `TmuxService`) and the production
 * classifier (`observeAgentLaunch` reading the pane option the shell recorded).
 * Nothing under observation is mocked.
 *
 * Three launches are observed, each in its own pane:
 *   1. a CLI that writes a sentinel to stderr and exits 1;
 *   2. a CLI that is not on PATH at all (the shell reports 127);
 *   3. a positive control: a CLI that stays running past the launch window.
 */

import { execFileSync } from 'node:child_process';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { TmuxService } from '../services/TmuxService.js';
import { getAgentLabel, launchAgentInPane, type AgentName } from '../utils/agentLaunch.js';
import {
  createAgentExitRecorder,
  describeAgentLaunchFailure,
  observeAgentLaunch,
  readAgentExitPaneOption,
  type AgentLaunchFailure,
} from '../utils/agentLaunchOutcome.js';

const TMUX_COMMAND_TIMEOUT_MS = 5_000;
/** Bounds the harness; a failure is reported as soon as the shell records it. */
const FAILURE_WINDOW_MS = 5_000;
/** Long enough for a failing CLI to have exited; short enough to keep the run cheap. */
const RUNNING_CONTROL_WINDOW_MS = 1_500;
const SHELL_PROBE_TIMEOUT_MS = 3_000;
const SHELL_PROBE_OPTION = '@psyche_harness_probe';
const SHELL_PATH_OPTION = '@psyche_harness_path';

/** Written by the failing CLI; must never reach a classification or message. */
export const AGENT_STDERR_SENTINEL = 'HARNESS-AGENT-STDERR-SENTINEL';
/** Prompt for the failing launch; must never reach a classification or message. */
export const AGENT_PROMPT_SENTINEL = 'HARNESS-AGENT-PROMPT-SENTINEL';

/** Raised when the panes' PATH could not be confined, so nothing was launched. */
export class RecoveryAgentLaunchConfinementError extends Error {
  constructor() {
    super('Agent launch failure was not observed: pane PATH could not be confined');
  }
}

/** Raised when the host cannot run tmux, so the scenario observes nothing. */
export class RecoveryAgentLaunchTmuxUnavailableError extends Error {
  constructor() {
    super('Agent launch failure could not be observed: tmux did not run');
  }
}

export interface AgentLaunchFailureObservation {
  /** The exit-1 CLI is classified as a failed launch whose next action is a retry. */
  readonly failingCliClassified: boolean;
  /** The absent CLI is classified as not found, pointing at the install. */
  readonly missingCliClassified: boolean;
  /** Positive control: a running agent is never reported as a failed launch. */
  readonly runningAgentNotClassified: boolean;
  /** Both failed panes are alive and their shells still execute typed input. */
  readonly shellsPreserved: boolean;
  /** Neither classification nor message carries the stderr, prompt, or a path. */
  readonly reportBounded: boolean;
}

/**
 * Drives the three launches inside `projectRoot`. The caller owns the
 * disposable workspace.
 */
export async function observeAgentLaunchFailure(
  projectRoot: string,
): Promise<AgentLaunchFailureObservation> {
  const tmuxTmpdir = path.join(projectRoot, 'tmux');
  const socketPath = path.join(tmuxTmpdir, `tmux-${process.getuid?.() ?? 0}`, 'default');
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  const fakeBin = path.join(projectRoot, 'fake-bin');
  await prepareFakeBin(fakeBin);

  // Production tmux calls inherit `process.env`. Without this a run started
  // inside tmux would type into the operator's own panes.
  const savedEnv = {
    TMUX: process.env.TMUX,
    TMUX_PANE: process.env.TMUX_PANE,
    TMUX_TMPDIR: process.env.TMUX_TMPDIR,
  };
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  process.env.TMUX_TMPDIR = tmuxTmpdir;

  try {
    // `env` execs `sh`, so the pane's current command is the shell itself,
    // as in a real pane. tmux's own `-e PATH=` is not used: tmux replaces it
    // with the client's PATH, which would launch the host's real agents.
    const shellCommand = `/usr/bin/env PATH=${fakeBin} ENV= /bin/sh`;
    tmux(socketPath, '-f', '/dev/null', 'new-session', '-d', '-s', 'harness', '-x', '120', '-y', '30', shellCommand);
    const failingPane = tmux(socketPath, 'display-message', '-p', '-t', 'harness', '#{pane_id}');
    const missingPane = tmux(socketPath, 'split-window', '-d', '-P', '-F', '#{pane_id}', '-t', 'harness', shellCommand);
    const runningPane = tmux(socketPath, 'split-window', '-d', '-P', '-F', '#{pane_id}', '-t', 'harness', shellCommand);

    // Fail closed before typing any agent command: every pane's shell must be
    // up and its PATH must be exactly the fake directory. Anything else could
    // start a real agent CLI installed on the host.
    for (const pane of [failingPane, missingPane, runningPane]) {
      if (await shellProbe(socketPath, pane, SHELL_PATH_OPTION, '"$PATH"') !== fakeBin) {
        throw new RecoveryAgentLaunchConfinementError();
      }
    }

    const [failing, missing, running] = await Promise.all([
      launchAndObserve(projectRoot, failingPane, 'opencode', AGENT_PROMPT_SENTINEL, FAILURE_WINDOW_MS),
      launchAndObserve(projectRoot, missingPane, 'claude', '', FAILURE_WINDOW_MS),
      launchAndObserve(projectRoot, runningPane, 'coven-code', '', RUNNING_CONTROL_WINDOW_MS),
    ]);

    const shellsPreserved = (await shellStillExecutes(socketPath, failingPane))
      && (await shellStillExecutes(socketPath, missingPane));

    const reports = [failing, missing]
      .filter((failure): failure is { failure: AgentLaunchFailure; message: string } => (
        failure.failure !== null
      ))
      .map((entry) => `${JSON.stringify(entry.failure)}\n${entry.message}`)
      .join('\n');
    const reportBounded = reports.length > 0
      && !reports.includes(AGENT_STDERR_SENTINEL)
      && !reports.includes(AGENT_PROMPT_SENTINEL)
      && !reports.includes(projectRoot)
      && !reports.includes('/');

    return {
      failingCliClassified: failing.failure?.exit === 'failed'
        && failing.failure.exitCode === 1
        && failing.failure.nextAction === 'retry_launch',
      missingCliClassified: missing.failure?.exit === 'command_not_found'
        && missing.failure.nextAction === 'check_agent_install',
      runningAgentNotClassified: running.failure === null,
      shellsPreserved,
      reportBounded,
    };
  } finally {
    try {
      tmux(socketPath, 'kill-server');
    } catch {
      // A server that already exited is the intended end state.
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function launchAndObserve(
  projectRoot: string,
  tmuxPaneId: string,
  agent: AgentName,
  prompt: string,
  windowMs: number,
): Promise<{ failure: AgentLaunchFailure | null; message: string }> {
  const recorder = createAgentExitRecorder();
  const launch = await launchAgentInPane({
    paneId: tmuxPaneId,
    agent,
    prompt,
    slug: `harness-${agent}`,
    projectRoot,
    exitRecorder: recorder,
    tmuxService: TmuxService.getInstance(),
  });
  if (!launch.exitRecorderArmed) {
    // The launch path did not recognise the pane's shell, so nothing could be
    // recorded. Reported as no classification, which fails the invariants.
    return { failure: null, message: '' };
  }
  const failure = await observeAgentLaunch({
    nonce: recorder.nonce,
    readExitOption: () => readAgentExitPaneOption(tmuxPaneId),
    windowMs,
    intervalMs: 100,
    // The production watcher unrefs its timer so it never holds a process
    // open. The harness is the only thing running here, so it must.
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  return {
    failure,
    message: failure ? describeAgentLaunchFailure(failure, getAgentLabel(agent)) : '',
  };
}

/**
 * The pane must be alive and its shell must still run what the operator
 * types. Pane liveness alone would pass for a shell wedged behind the failed
 * agent, so the probe is a command typed into it.
 */
async function shellStillExecutes(socketPath: string, tmuxPaneId: string): Promise<boolean> {
  const dead = tmux(socketPath, 'display-message', '-p', '-t', tmuxPaneId, '#{pane_dead}');
  if (dead !== '0') return false;
  return await shellProbe(socketPath, tmuxPaneId, SHELL_PROBE_OPTION, 'alive') === 'alive';
}

/**
 * Types a command that makes the pane's shell write `value` (shell-expanded)
 * into a pane option, and returns what arrived, or undefined on timeout.
 */
async function shellProbe(
  socketPath: string,
  tmuxPaneId: string,
  option: string,
  value: string,
): Promise<string | undefined> {
  tmux(
    socketPath,
    'send-keys',
    '-t',
    tmuxPaneId,
    `tmux set-option -p -t "$TMUX_PANE" ${option} ${value}`,
    'Enter',
  );
  const deadline = Date.now() + SHELL_PROBE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const observed = paneOption(socketPath, tmuxPaneId, option);
    if (observed) return observed;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

/**
 * The panes' PATH holds only this directory, so no agent CLI installed on the
 * host can be launched by accident. `tmux`, `cat`, and `rm` are linked in
 * because the exit recorder and the prompt bootstrap need them.
 */
async function prepareFakeBin(fakeBin: string): Promise<void> {
  await mkdir(fakeBin, { recursive: true });
  for (const tool of ['tmux', 'cat', 'rm']) {
    await symlink(resolveHostTool(tool), path.join(fakeBin, tool));
  }
  await writeExecutable(
    path.join(fakeBin, 'opencode'),
    `#!/bin/sh\necho ${AGENT_STDERR_SENTINEL} >&2\nexit 1\n`,
  );
  await writeExecutable(path.join(fakeBin, 'coven'), '#!/bin/sh\nexec /bin/sleep 30\n');
  // `claude` is deliberately absent.
}

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content, 'utf8');
  await chmod(filePath, 0o755);
}

function resolveHostTool(tool: string): string {
  try {
    const resolved = execFileSync('/bin/sh', ['-c', `command -v ${tool}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: TMUX_COMMAND_TIMEOUT_MS,
    }).trim();
    if (!resolved.startsWith('/')) throw new Error('not a path');
    return resolved;
  } catch {
    throw new RecoveryAgentLaunchTmuxUnavailableError();
  }
}

function paneOption(socketPath: string, tmuxPaneId: string, option: string): string {
  try {
    return tmux(socketPath, 'show-options', '-p', '-v', '-t', tmuxPaneId, option);
  } catch {
    return '';
  }
}

function tmux(socketPath: string, ...args: string[]): string {
  try {
    // `-S` pins the server by path, so this cannot reach the default socket
    // even if the isolating environment above were ignored.
    return execFileSync('tmux', ['-S', socketPath, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: TMUX_COMMAND_TIMEOUT_MS,
    }).trim();
  } catch {
    throw new RecoveryAgentLaunchTmuxUnavailableError();
  }
}
