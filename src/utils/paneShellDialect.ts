/**
 * Which shell syntax a tmux pane will accept for a line Psyche types into it.
 *
 * The pane runs tmux's `default-shell`, which can differ from Psyche's own
 * `$SHELL`. The only trustworthy answer is the pane's own
 * `#{pane_current_command}`, read before anything is typed. Every launch line
 * that depends on shell syntax (the prompt-file bootstrap, the exit recorder)
 * derives its dialect here, so the two cannot drift apart (#475, #508).
 *
 * A shell not listed here has no dialect. Callers must then type nothing that
 * depends on shell syntax: a nushell, tcsh or xonsh pane would reject the whole
 * line and the agent would never start.
 */

import path from 'node:path';

export type PaneShellDialect = 'posix' | 'fish';

const POSIX_SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

export function paneShellDialectForCommand(
  paneCommand: string | undefined,
): PaneShellDialect | null {
  // Login shells can report as `-zsh`; a path can appear on some platforms.
  const name = path.basename((paneCommand ?? '').trim()).replace(/^-/u, '').toLowerCase();
  if (POSIX_SHELLS.has(name)) return 'posix';
  if (name === 'fish') return 'fish';
  return null;
}

/** Why a pane has no dialect. Closed, so it can be logged without leaking anything. */
export type PaneShellUnknownReason = 'unrecognized_shell' | 'unreadable_shell';

export type PaneShellResolution =
  | { readonly dialect: PaneShellDialect; readonly paneCommand: string }
  | { readonly dialect: null; readonly paneCommand: string | undefined; readonly reason: PaneShellUnknownReason };

/**
 * Reads the pane's current command through the injected reader and resolves
 * its dialect. Never throws: a failed or missing reader is an unknown shell.
 */
export async function resolvePaneShell(
  readPaneCommand: (() => Promise<string | undefined>) | undefined,
): Promise<PaneShellResolution> {
  if (!readPaneCommand) {
    return { dialect: null, paneCommand: undefined, reason: 'unreadable_shell' };
  }
  let paneCommand: string | undefined;
  try {
    paneCommand = await readPaneCommand();
  } catch {
    return { dialect: null, paneCommand: undefined, reason: 'unreadable_shell' };
  }
  const dialect = paneShellDialectForCommand(paneCommand);
  if (dialect) return { dialect, paneCommand: paneCommand ?? '' };
  return { dialect: null, paneCommand, reason: 'unrecognized_shell' };
}

/**
 * Operator-facing warning for an agent launched without its initial prompt
 * because the pane's shell could not be trusted with the prompt bootstrap.
 * Built only from the agent id and the closed reason: it never carries the
 * prompt, a path, or the raw pane command.
 */
export function describePromptBootstrapSkipped(
  agent: string,
  reason: PaneShellUnknownReason,
): string {
  const why = reason === 'unreadable_shell'
    ? 'the pane\'s shell could not be read'
    : 'the pane runs a shell Psyche cannot safely type a prompt into (supported: sh, bash, zsh, dash, ksh, fish)';
  return `${agent.slice(0, 32)} was launched without its initial prompt: ${why}. Paste the prompt into the agent once it starts.`;
}
