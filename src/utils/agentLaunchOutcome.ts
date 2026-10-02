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
import { paneShellDialectForCommand, type PaneShellDialect } from './paneShellDialect.js';

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
}

export function createAgentExitRecorder(): AgentExitRecorder {
  return { nonce: randomBytes(4).toString('hex') };
}

/** How the pane's shell spells the last exit status, when it is known. */
export type AgentExitRecorderSyntax = PaneShellDialect;

/**
 * Chooses the recorder syntax from the shell actually running in the pane
 * (`#{pane_current_command}`), never from Psyche's own `$SHELL`: tmux's
 * `default-shell` can differ from the login shell. Any shell not known to
 * accept the suffix gets none, so its launch is unclassified rather than
 * broken — a nushell or tcsh pane would otherwise reject the whole line and
 * the agent would never start. Shares its parsing with the prompt bootstrap
 * so the two cannot disagree about a pane (#508).
 */
export function exitRecorderSyntaxForPaneCommand(
  paneCommand: string | undefined,
): AgentExitRecorderSyntax | null {
  return paneShellDialectForCommand(paneCommand);
}

/**
 * Suffix appended directly after the agent invocation, so the status is the
 * agent's own. stderr is discarded so a host without `tmux` on the pane's PATH
 * prints nothing into the operator's shell; the launch then simply goes
 * unclassified rather than misclassified.
 */
export function buildAgentExitRecorderSuffix(
  recorder: AgentExitRecorder,
  syntax: AgentExitRecorderSyntax,
): string {
  if (!NONCE_PATTERN.test(recorder.nonce)) {
    throw new Error('Agent exit recorder nonce must be eight lowercase hex digits');
  }
  const status = syntax === 'fish' ? '$status' : '$?';
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

/**
 * Exit status of a process ended by SIGINT, which is also what raw-mode TUIs
 * return when the operator presses Ctrl-C to leave them. That is the operator
 * cancelling, not the agent failing to start.
 */
const USER_CANCEL_EXIT_CODE = 130;

/** A clean exit or an operator cancel is not a launch failure; any other non-zero exit is. */
export function classifyAgentLaunchExit(exitCode: number): AgentLaunchFailure | null {
  if (exitCode === 0 || exitCode === USER_CANCEL_EXIT_CODE) return null;
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
    // The window is enforced around every read, so neither a late wake-up nor
    // a slow read can stretch it: no read starts after the deadline, and a
    // value that only arrives after it is not a launch outcome.
    if (now() > deadline) return null;
    let raw: string | undefined;
    try {
      raw = await readExitOption();
    } catch (error) {
      // The pane is gone, so nothing can ever be recorded there.
      if (isMissingPaneError(error)) return null;
      // Any other failed read is no evidence either way; keep watching.
      raw = undefined;
    }
    if (now() > deadline) return null;
    const exitCode = parseRecordedAgentExit(raw, nonce);
    if (exitCode !== null) return classifyAgentLaunchExit(exitCode);
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

function isMissingPaneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /can't find pane|no such pane/iu.test(message);
}
