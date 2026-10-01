/**
 * Classifies an agent CLI that fails at launch inside a live shell (#475).
 *
 * An agent pane is a shell into which Psyche types the agent command. When
 * that command is missing or exits immediately, the shell simply returns to
 * its prompt: tmux sees a live pane, the process tree shows a shell, and the
 * cockpit had no product state for what happened.
 *
 * The signal used here is the agent's own exit status, recorded by the shell
 * that ran it. The typed launch command is followed by a recorder that writes
 * `<nonce>:<status>` into a tmux pane user option. A pane option dies with the
 * pane, needs no file under the project, and is scoped to exactly the pane the
 * agent ran in. The nonce ties a recorded status to one launch, so a value left
 * by an earlier launch in the same pane — or typed by the operator — is never
 * read as this launch's outcome.
 *
 * The classification is deliberately bounded: a closed exit bucket, the exit
 * code (an integer 0-255), and a closed next action. It never carries terminal
 * output, the prompt, or a path, and it never closes the pane: the shell and
 * whatever the operator has in it are preserved, which is the point.
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

/** Pane user option the launch recorder writes. */
export const AGENT_EXIT_PANE_OPTION = '@psyche_agent_exit';

/**
 * How long after launch an agent exit counts as a launch failure. Later exits
 * are an operator quitting the agent, not a failed launch, and are not watched.
 */
export const AGENT_LAUNCH_WINDOW_MS = 20_000;
const AGENT_LAUNCH_POLL_INTERVAL_MS = 500;
const TMUX_READ_TIMEOUT_MS = 2_000;

const NONCE_PATTERN = /^[a-f0-9]{8}$/u;
const RECORDED_EXIT_PATTERN = /^([a-f0-9]{8}):(\d{1,3})$/u;

export type AgentLaunchExitBucket =
  | 'command_not_found'
  | 'not_executable'
  | 'terminated_by_signal'
  | 'failed';

export type AgentLaunchNextAction = 'check_agent_install' | 'retry_launch';

export interface AgentLaunchFailure {
  readonly state: 'agent_launch_failed';
  readonly exit: AgentLaunchExitBucket;
  readonly exitCode: number;
  readonly nextAction: AgentLaunchNextAction;
  /** The classification never closes the pane or its shell. */
  readonly shellPreserved: true;
}

export interface AgentExitRecorder {
  /** Eight lowercase hex digits; ties a recorded status to one launch. */
  readonly nonce: string;
  /** Shell that will run the typed command; selects `$?` or fish's `$status`. */
  readonly shellPath?: string;
}

export function createAgentExitRecorder(
  shellPath: string | undefined = process.env.SHELL,
): AgentExitRecorder {
  return { nonce: randomBytes(4).toString('hex'), shellPath };
}

/**
 * Suffix appended directly after the agent invocation, so `$?` is the agent's
 * own status. stderr is discarded so a host without `tmux` on the pane's PATH
 * prints nothing into the operator's shell; the launch then simply goes
 * unclassified rather than misclassified.
 */
export function buildAgentExitRecorderSuffix(recorder: AgentExitRecorder): string {
  if (!NONCE_PATTERN.test(recorder.nonce)) {
    throw new Error('Agent exit recorder nonce must be eight lowercase hex digits');
  }
  const status = isFishShell(recorder.shellPath) ? '$status' : '$?';
  return `; tmux set-option -p -t "$TMUX_PANE" ${AGENT_EXIT_PANE_OPTION} "${recorder.nonce}:${status}" 2>/dev/null`;
}

/** Returns the recorded exit code for this launch, or null when there is none. */
export function parseRecordedAgentExit(
  raw: string | undefined,
  nonce: string,
): number | null {
  const match = RECORDED_EXIT_PATTERN.exec((raw ?? '').trim());
  if (!match || match[1] !== nonce) return null;
  const code = Number(match[2]);
  return code <= 255 ? code : null;
}

/** A clean exit is not a launch failure; every non-zero exit is. */
export function classifyAgentLaunchExit(exitCode: number): AgentLaunchFailure | null {
  if (exitCode === 0) return null;
  const exit: AgentLaunchExitBucket = exitCode === 127
    ? 'command_not_found'
    : exitCode === 126
      ? 'not_executable'
      : exitCode > 128
        ? 'terminated_by_signal'
        : 'failed';
  const nextAction: AgentLaunchNextAction = exit === 'command_not_found' || exit === 'not_executable'
    ? 'check_agent_install'
    : 'retry_launch';
  return { state: 'agent_launch_failed', exit, exitCode, nextAction, shellPreserved: true };
}

const EXIT_PHRASES: Readonly<Record<AgentLaunchExitBucket, string>> = {
  command_not_found: 'command not found',
  not_executable: 'command not executable',
  terminated_by_signal: 'terminated by a signal',
  failed: 'exited with an error',
};

const NEXT_ACTION_PHRASES: Readonly<Record<AgentLaunchNextAction, string>> = {
  check_agent_install: 'check the agent CLI is installed and on PATH, then relaunch it',
  retry_launch: 'check its output there, then relaunch it',
};

/**
 * Operator-facing text. Built only from the agent's registry label and the
 * closed fields above, so it cannot carry output, a prompt, or a path.
 */
export function describeAgentLaunchFailure(
  failure: AgentLaunchFailure,
  agentLabel: string,
): string {
  return `${agentLabel} did not start (${EXIT_PHRASES[failure.exit]}, exit ${failure.exitCode}). `
    + `The pane's shell is still open: ${NEXT_ACTION_PHRASES[failure.nextAction]}.`;
}

export interface ObserveAgentLaunchOptions {
  readonly nonce: string;
  readonly readExitOption: () => Promise<string | undefined>;
  readonly windowMs?: number;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Watches one launch for its recorded exit until the launch window closes.
 * Returns the failure when the agent exited non-zero inside the window, and
 * null for a clean exit or an agent still running when the window closes.
 */
export async function observeAgentLaunch(
  options: ObserveAgentLaunchOptions,
): Promise<AgentLaunchFailure | null> {
  const {
    nonce,
    readExitOption,
    windowMs = AGENT_LAUNCH_WINDOW_MS,
    intervalMs = AGENT_LAUNCH_POLL_INTERVAL_MS,
    now = Date.now,
    sleep = unrefSleep,
  } = options;
  const deadline = now() + windowMs;
  for (;;) {
    let raw: string | undefined;
    try {
      raw = await readExitOption();
    } catch {
      // A failed read is no evidence either way; keep watching.
      raw = undefined;
    }
    const exitCode = parseRecordedAgentExit(raw, nonce);
    if (exitCode !== null) return classifyAgentLaunchExit(exitCode);
    if (now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

export interface WatchAgentLaunchOptions extends ObserveAgentLaunchOptions {
  readonly agentLabel: string;
  readonly onFailure: (failure: AgentLaunchFailure, message: string) => void | Promise<void>;
}

/**
 * Fire-and-forget launch watch for the pane-creation path. Reports a failure
 * once through `onFailure`; never throws, and never touches the pane.
 */
export function watchAgentLaunch(options: WatchAgentLaunchOptions): Promise<void> {
  const { agentLabel, onFailure, ...observe } = options;
  return observeAgentLaunch(observe)
    .then(async (failure) => {
      if (failure) await onFailure(failure, describeAgentLaunchFailure(failure, agentLabel));
    })
    .catch(() => {
      // Reporting is best effort; it must never disturb the pane.
    });
}

/** Reads the recorder's pane option. An unset option reads as empty. */
export function readAgentExitPaneOption(tmuxPaneId: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    execFile(
      'tmux',
      ['show-options', '-p', '-v', '-t', tmuxPaneId, AGENT_EXIT_PANE_OPTION],
      { encoding: 'utf8', timeout: TMUX_READ_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** A launch watcher must never be the thing keeping a process alive. */
function unrefSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

function isFishShell(shellPath?: string): boolean {
  return path.basename(shellPath || '').toLowerCase() === 'fish';
}
