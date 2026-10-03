import { randomBytes } from 'node:crypto';
import type { TmuxService } from '../services/TmuxService.js';

const DEFAULT_STARTUP_TIMEOUT_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 75;

// Common shell process names reported by tmux for inactive panes.
const SHELL_PROCESS_NAMES = new Set([
  'bash',
  'zsh',
  'sh',
  'fish',
  'dash',
  'ksh',
  'tcsh',
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The tmux calls the paste transport makes; injectable so tests never run tmux. */
export type PromptPasteTmux = Pick<
  TmuxService,
  'getPaneCurrentCommand' | 'sendTmuxKeys' | 'loadBufferFromStdin' | 'pasteBufferAndDelete' | 'deleteBuffer'
>;

export interface PromptPasteClock {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface WaitForForegroundCommandOptions extends PromptPasteClock {
  paneId: string;
  tmuxService: Pick<TmuxService, 'getPaneCurrentCommand'>;
  expectedCommand?: string;
  baselineCommand?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

function isAgentForeground(
  currentCommand: string,
  expectedCommand: string | undefined,
  baselineCommand: string | undefined,
): boolean {
  if (!currentCommand) return false;
  if (expectedCommand && currentCommand === expectedCommand) return true;
  if (baselineCommand && currentCommand !== baselineCommand) return true;
  return !expectedCommand && !baselineCommand && !SHELL_PROCESS_NAMES.has(currentCommand);
}

async function readForeground(
  tmuxService: Pick<TmuxService, 'getPaneCurrentCommand'>,
  paneId: string,
): Promise<string> {
  try {
    return await tmuxService.getPaneCurrentCommand(paneId);
  } catch {
    return '';
  }
}

/**
 * Wait, within `timeoutMs`, for a pane to hand off from its shell to a
 * foreground command. Uses tmux process metadata, not output heuristics.
 *
 * Returns false when the hand-off was never observed. A caller must then not
 * type into the pane: the agent may be missing, and its shell would run the
 * input as commands.
 */
export async function waitForForegroundCommand(
  options: WaitForForegroundCommandOptions
): Promise<boolean> {
  const {
    paneId,
    tmuxService,
    expectedCommand,
    baselineCommand,
    timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    now = Date.now,
    sleep: wait = sleep,
  } = options;

  const deadline = now() + timeoutMs;

  for (;;) {
    const currentCommand = await readForeground(tmuxService, paneId);
    if (isAgentForeground(currentCommand, expectedCommand, baselineCommand)) {
      return true;
    }
    if (now() + pollIntervalMs > deadline) {
      return false;
    }
    await wait(pollIntervalMs);
  }
}

/** Why a pasted prompt was not delivered. Closed, so it can be logged safely. */
export type PromptPasteSkipReason = 'agent_not_ready' | 'prompt_paste_failed';

export type PromptPasteResult =
  | { readonly delivered: true }
  | { readonly delivered: false; readonly reason: PromptPasteSkipReason };

interface SendPromptViaTmuxOptions extends PromptPasteClock {
  paneId: string;
  prompt: string;
  tmuxService: PromptPasteTmux;
  expectedCommand?: string;
  baselineCommand?: string;
  prePromptKeys?: string[];
  submitKeys?: string[];
  postPasteDelayMs?: number;
  readyDelayMs?: number;
  /** Bound on the foreground hand-off wait. */
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * Paste a prompt into an interactive agent that has just been launched bare.
 *
 * The prompt never enters an argv (#523): it reaches tmux on stdin
 * (`load-buffer -`), and `paste-buffer -d` writes it into the pane and deletes
 * the buffer in one command. A failed load or paste deletes the buffer too.
 *
 * Nothing is typed until the agent has visibly taken the foreground and still
 * holds it after the ready delay. Otherwise the result is `agent_not_ready`
 * and the caller reports the existing `initial_prompt_skipped` warning.
 */
export async function sendPromptViaTmux(
  options: SendPromptViaTmuxOptions
): Promise<PromptPasteResult> {
  const {
    paneId,
    prompt,
    tmuxService,
    expectedCommand,
    baselineCommand,
    prePromptKeys = [],
    submitKeys = ['Enter'],
    postPasteDelayMs = 0,
    readyDelayMs = 0,
    startupTimeoutMs,
    pollIntervalMs,
    now,
    sleep: wait = sleep,
  } = options;

  const ready = await waitForForegroundCommand({
    paneId,
    tmuxService,
    expectedCommand,
    baselineCommand,
    timeoutMs: startupTimeoutMs,
    pollIntervalMs,
    now,
    sleep: wait,
  });
  if (!ready) {
    return { delivered: false, reason: 'agent_not_ready' };
  }

  if (readyDelayMs > 0) {
    await wait(readyDelayMs);
  }

  // An agent that exited during the delay has handed the pane back to its
  // shell, which would run the prompt as commands.
  const stillForeground = await readForeground(tmuxService, paneId);
  if (!isAgentForeground(stillForeground, expectedCommand, baselineCommand)) {
    return { delivered: false, reason: 'agent_not_ready' };
  }

  const bufferName = `psyche-prompt-${Date.now()}-${randomBytes(6).toString('hex')}`;
  const interKeyDelayMs = 120;
  const interSubmitDelayMs = 60;

  for (const prePromptKey of prePromptKeys) {
    await tmuxService.sendTmuxKeys(paneId, prePromptKey);
    await wait(interKeyDelayMs);
  }

  try {
    await tmuxService.loadBufferFromStdin(bufferName, prompt);
    await tmuxService.pasteBufferAndDelete(bufferName, paneId);
  } catch {
    try {
      await tmuxService.deleteBuffer(bufferName);
    } catch {
      // Already gone, or tmux is unreachable; a buffer is server memory only.
    }
    return { delivered: false, reason: 'prompt_paste_failed' };
  }

  if (postPasteDelayMs > 0) {
    await wait(postPasteDelayMs);
  }
  for (let i = 0; i < submitKeys.length; i += 1) {
    await tmuxService.sendTmuxKeys(paneId, submitKeys[i]);
    if (i < submitKeys.length - 1) {
      await wait(interSubmitDelayMs);
    }
  }
  return { delivered: true };
}
