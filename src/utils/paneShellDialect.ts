/**
 * Which shell syntax a tmux pane will accept for a line Psyche types into it.
 *
 * The pane runs tmux's `default-shell`, which can differ from Psyche's own
 * `$SHELL`. The only trustworthy answer is the pane's own
 * `#{pane_current_command}`, read before anything is typed. Every launch line
 * that depends on shell syntax (the prompt-file bootstrap, the exit recorder)
 * derives its dialect here, so the two cannot drift apart (#475, #508).
 *
 * A pane with no dialect must receive nothing that depends on shell syntax: a
 * nushell, tcsh or xonsh pane would reject the whole line and the agent would
 * never start.
 *
 * Fresh-pane assumption: every caller types into a pane it has just created,
 * whose root process is tmux's default shell. A non-shell foreground program
 * there (an rc file running fastfetch, say) is transient and its parent is
 * still the shell, so callers poll briefly and, if it persists, launch the
 * agent bare rather than typing shell-specific syntax. A caller that types
 * into an existing pane must instead refuse when the pane reports
 * `not_a_shell`: there the foreground program may be an editor or an agent.
 */

import path from 'node:path';
import { LogService } from '../services/LogService.js';

export type PaneShellDialect = 'posix' | 'fish';

const POSIX_SHELLS: ReadonlySet<string> = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'mksh', 'yash',
]);

/** Shells with no supported dialect. Anything else unrecognized is a program. */
const OTHER_SHELLS: ReadonlySet<string> = new Set([
  'nu', 'nushell', 'tcsh', 'csh', 'xonsh', 'elvish', 'pwsh', 'powershell',
  'ion', 'osh', 'oil', 'ysh', 'murex', 'rc', 'es', 'oksh', 'loksh',
]);

function paneCommandName(paneCommand: string | undefined): string {
  // Login shells can report as `-zsh`; a path can appear on some platforms.
  return path.basename((paneCommand ?? '').trim()).replace(/^-/u, '').toLowerCase();
}

export function paneShellDialectForCommand(
  paneCommand: string | undefined,
): PaneShellDialect | null {
  const name = paneCommandName(paneCommand);
  if (POSIX_SHELLS.has(name)) return 'posix';
  if (name === 'fish') return 'fish';
  return null;
}

/** Why a pane has no dialect. Closed, so it can be logged without leaking anything. */
export type PaneShellUnknownReason = 'unrecognized_shell' | 'not_a_shell' | 'unreadable_shell';

/** Why an agent was launched without its initial prompt. */
export type PromptBootstrapSkipReason = PaneShellUnknownReason | 'prompt_file_unwritable';

export type PaneShellResolution =
  | { readonly dialect: PaneShellDialect; readonly paneCommand: string }
  | { readonly dialect: null; readonly paneCommand: string | undefined; readonly reason: PaneShellUnknownReason };

export interface PaneShellProbeOptions {
  /** Total time to keep re-reading while the shell is unknown. */
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export const PANE_SHELL_PROBE_TIMEOUT_MS = 3_000;
export const PANE_SHELL_PROBE_INTERVAL_MS = 200;

async function readOnce(
  readPaneCommand: () => Promise<string | undefined>,
): Promise<PaneShellResolution> {
  let paneCommand: string | undefined;
  try {
    paneCommand = await readPaneCommand();
  } catch {
    return { dialect: null, paneCommand: undefined, reason: 'unreadable_shell' };
  }
  const dialect = paneShellDialectForCommand(paneCommand);
  if (dialect) return { dialect, paneCommand: paneCommand ?? '' };
  const name = paneCommandName(paneCommand);
  if (!name) return { dialect: null, paneCommand, reason: 'unreadable_shell' };
  return {
    dialect: null,
    paneCommand,
    reason: OTHER_SHELLS.has(name) ? 'unrecognized_shell' : 'not_a_shell',
  };
}

/**
 * Reads the pane's current command through the injected reader and resolves
 * its dialect. While the answer is transient (an rc file's foreground program,
 * a shell still starting, a failed read) it re-reads at a short
 * interval for a bounded time, stopping at the first recognized shell. Never
 * throws: a failed or missing reader is an unreadable shell.
 */
export async function resolvePaneShell(
  readPaneCommand: (() => Promise<string | undefined>) | undefined,
  options: PaneShellProbeOptions = {},
): Promise<PaneShellResolution> {
  if (!readPaneCommand) {
    return { dialect: null, paneCommand: undefined, reason: 'unreadable_shell' };
  }
  const {
    timeoutMs = PANE_SHELL_PROBE_TIMEOUT_MS,
    intervalMs = PANE_SHELL_PROBE_INTERVAL_MS,
    now = Date.now,
    sleep = unrefSleep,
  } = options;
  const deadline = now() + timeoutMs;
  // The attempt cap bounds the probe even when the clock is frozen or stalled;
  // the deadline bounds it when reads themselves are slow.
  const maxSleeps = Math.max(0, Math.floor(timeoutMs / Math.max(1, intervalMs)));
  let result = await readOnce(readPaneCommand);
  // A recognized-but-unsupported shell (nu, tcsh) will not change; only a
  // transient answer (a foreground program, an empty or failed read) is
  // worth waiting out.
  for (
    let sleeps = 0;
    result.dialect === null
      && result.reason !== 'unrecognized_shell'
      && sleeps < maxSleeps
      && now() + intervalMs <= deadline;
    sleeps += 1
  ) {
    await sleep(intervalMs);
    result = await readOnce(readPaneCommand);
  }
  return result;
}

const SKIP_REASON_PHRASES: Readonly<Record<PromptBootstrapSkipReason, string>> = {
  unreadable_shell: 'the pane\'s shell could not be read',
  unrecognized_shell: 'the pane runs a shell Psyche cannot safely type a prompt into (supported: POSIX shells and fish)',
  not_a_shell: 'the pane was running a program rather than its shell',
  prompt_file_unwritable: 'the prompt file could not be written',
};

/**
 * Operator-facing warning for an agent launched without its initial prompt.
 * Built only from the agent id and the closed reason: it never carries the
 * prompt, a path, or the raw pane command.
 */
export function describePromptBootstrapSkipped(
  agent: string,
  reason: PromptBootstrapSkipReason,
): string {
  return `${agent.slice(0, 32)} was launched without its initial prompt: ${SKIP_REASON_PHRASES[reason]}. Paste the prompt into the agent once it starts.`;
}

export interface PromptSkipReportDeps {
  readonly logWarn?: (message: string, source: string, paneId: string) => void;
  readonly showToast?: (message: string) => void | Promise<void>;
}

/**
 * Reports a skipped prompt in the TUI: one log line and one warning toast, the
 * same channels #484 uses for a failed launch. Never throws.
 */
export async function reportPromptBootstrapSkipped(
  agent: string,
  reason: PromptBootstrapSkipReason,
  source: string,
  paneId: string,
  deps: PromptSkipReportDeps = {},
): Promise<void> {
  const message = describePromptBootstrapSkipped(agent, reason);
  try {
    const logWarn = deps.logWarn ?? ((text: string, src: string, id: string) => {
      LogService.getInstance().warn(text, src, id);
    });
    logWarn(`${message} [initial_prompt_skipped:${reason}]`, source, paneId);
    const showToast = deps.showToast ?? (async (text: string) => {
      const { ToastService } = await import('../services/ToastService.js');
      ToastService.getInstance().showToast(text, 'warning');
    });
    await showToast(message);
  } catch {
    // Reporting is best effort; it must never disturb the launch.
  }
}

/** A probe must never be the thing keeping a process alive. */
function unrefSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}
