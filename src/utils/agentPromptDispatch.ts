import { randomBytes } from 'node:crypto';
import type { TmuxService } from '../services/TmuxService.js';
import { isShellCommandName } from './paneShellDialect.js';

const DEFAULT_STARTUP_TIMEOUT_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 75;

/**
 * Foreground names that are never the agent unless they ARE the expected
 * command: a shell (the pane's own, or one an agent crashed back to) and tmux
 * itself (the exit recorder briefly runs `tmux set-option` in the pane).
 */
function isNeverAgentForeground(command: string): boolean {
  return command === 'tmux' || isShellCommandName(command);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The tmux calls the paste transport makes; injectable so tests never run tmux. */
export type PromptPasteTmux = Pick<
  TmuxService,
  | 'getPaneCurrentCommand'
  | 'getPaneBracketPasteFlag'
  | 'sendTmuxKeys'
  | 'loadBufferFromStdin'
  | 'pasteBufferAndDelete'
  | 'deleteBuffer'
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
  // A shell or tmux is never "the agent" just because it differs from a
  // baseline: the baseline may have been sampled after the agent started,
  // and the agent may have exited back to its shell since (#523 review).
  if (isNeverAgentForeground(currentCommand)) return false;
  if (baselineCommand && currentCommand !== baselineCommand) return true;
  return !expectedCommand && !baselineCommand;
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

interface WaitForShellForegroundOptions extends PromptPasteClock {
  paneId: string;
  tmuxService: Pick<TmuxService, 'getPaneCurrentCommand'>;
  /** The pane's own shell, read before anything was typed into it. */
  shellCommand: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * Wait, within `timeoutMs`, until the pane's foreground is its own shell
 * again. A caller that typed earlier commands into the pane (the conflict
 * pane's `git merge`) must see this before typing an agent launch line it
 * will paste into: otherwise a still-running merge or hook is a non-shell
 * foreground that passes paste readiness, and the paste would queue behind
 * the launch line for the shell to run if the agent fails to start.
 */
export async function waitForShellForeground(
  options: WaitForShellForegroundOptions,
): Promise<boolean> {
  const {
    paneId,
    tmuxService,
    shellCommand,
    timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    now = Date.now,
    sleep: wait = sleep,
  } = options;
  const deadline = now() + timeoutMs;
  for (;;) {
    if ((await readForeground(tmuxService, paneId)) === shellCommand) {
      return true;
    }
    if (now() + pollIntervalMs > deadline) {
      return false;
    }
    await wait(pollIntervalMs);
  }
}

/** Why a pasted prompt was not delivered. Closed, so it can be logged safely. */
export type PromptPasteSkipReason =
  | 'agent_not_ready'
  | 'prompt_paste_failed'
  /** Multi-line prompt, but the agent has not enabled bracketed paste. */
  | 'prompt_paste_unsafe_multiline';

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
  const stillAgent = async (): Promise<boolean> => isAgentForeground(
    await readForeground(tmuxService, paneId),
    expectedCommand,
    baselineCommand,
  );
  const discardBuffer = async (): Promise<void> => {
    try {
      await tmuxService.deleteBuffer(bufferName);
    } catch {
      // Already gone (paste-buffer -d), or tmux is unreachable; a buffer is
      // server memory only.
    }
  };
  // The agent left the foreground mid-sequence: whatever reached the line is
  // now in front of a shell. Clear it and never submit it.
  const abandon = async (): Promise<PromptPasteResult> => {
    // In a confirmed shell, C-c discards the whole edit buffer, including a
    // bracketed multi-line paste that zsh's line editor holds as one buffer
    // (C-u would clear only the current line). Elsewhere C-c could interrupt
    // a program, so only the line is cleared.
    const foreground = await readForeground(tmuxService, paneId);
    try {
      await tmuxService.sendTmuxKeys(paneId, isShellCommandName(foreground) ? 'C-c' : 'C-u');
    } catch {
      // Best effort.
    }
    await discardBuffer();
    return { delivered: false, reason: 'agent_not_ready' };
  };

  // Without bracketed paste, tmux sends each LF as CR, so every line of a
  // multi-line prompt would be submitted separately. `-p` only brackets the
  // paste when the program asked for it, so ask tmux first.
  if (/[\r\n]/.test(prompt)) {
    let bracketed = false;
    try {
      bracketed = await tmuxService.getPaneBracketPasteFlag(paneId);
    } catch {
      bracketed = false;
    }
    if (!bracketed) {
      return { delivered: false, reason: 'prompt_paste_unsafe_multiline' };
    }
  }

  // After the multi-line check, so a withheld prompt sends the agent nothing.
  for (const prePromptKey of prePromptKeys) {
    await tmuxService.sendTmuxKeys(paneId, prePromptKey);
    await wait(interKeyDelayMs);
  }

  try {
    await tmuxService.loadBufferFromStdin(bufferName, prompt);
  } catch {
    await discardBuffer();
    return { delivered: false, reason: 'prompt_paste_failed' };
  }

  if (!(await stillAgent())) {
    return abandon();
  }

  try {
    await tmuxService.pasteBufferAndDelete(bufferName, paneId);
  } catch {
    await discardBuffer();
    return { delivered: false, reason: 'prompt_paste_failed' };
  }

  if (postPasteDelayMs > 0) {
    await wait(postPasteDelayMs);
  }
  for (let i = 0; i < submitKeys.length; i += 1) {
    if (!(await stillAgent())) {
      return abandon();
    }
    await tmuxService.sendTmuxKeys(paneId, submitKeys[i]);
    if (i < submitKeys.length - 1) {
      await wait(interSubmitDelayMs);
    }
  }
  return { delivered: true };
}
