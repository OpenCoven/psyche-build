/**
 * Launches an agent in the current terminal to resolve merge conflicts left by
 * the MergePane flow.
 *
 * The prompt travels only through a 0600 prompt file that the launching shell
 * reads into `$PSYCHE_PROMPT_CONTENT` and deletes before starting the agent,
 * the same transport `launchAgentInPane` uses. It never appears in the argv of
 * the shell Psyche spawns or on a typed line (AGENTS.md, #518). When the
 * shell's dialect is unknown or the file cannot be written, the agent starts
 * without its prompt and the bounded `initial_prompt_skipped` warning is
 * reported instead.
 *
 * Residual exposure (#523): claude and opencode take the prompt as a
 * positional argument / `--prompt`, so the shell expands it into the AGENT's
 * argv for its lifetime. This launch has no tmux pane, so the argv-free paste
 * transport cannot apply; see docs/AGENT-PROMPT-TRANSPORT.md.
 */

import { execFileSync as nodeExecFileSync } from 'child_process';
import {
  buildAgentCommand,
  buildInitialPromptCommand,
  type AgentName,
  type PermissionMode,
} from './agentLaunch.js';
import {
  describePromptBootstrapSkipped,
  reportPromptBootstrapSkipped,
  resolvePaneShell,
  type PromptBootstrapSkipReason,
} from './paneShellDialect.js';
import {
  buildPromptReadAndDeleteSnippet,
  deletePromptFile as storeDeletePromptFile,
  writePromptFile as storeWritePromptFile,
} from './promptStore.js';

/** Tried in order; the next one runs only if the previous exits non-zero. */
const MERGE_CONFLICT_AGENTS: readonly AgentName[] = ['claude', 'opencode'];

/** The shell Node's own `execSync` would use; its dialect is read, not assumed. */
const DEFAULT_LAUNCH_SHELL = '/bin/sh';

export interface MergeConflictAgentLaunchDeps {
  readonly execFileSync?: (
    file: string,
    args: readonly string[],
    options: { cwd: string; stdio: 'inherit' },
  ) => unknown;
  readonly writePromptFile?: (projectRoot: string, slug: string, prompt: string) => Promise<string>;
  readonly deletePromptFile?: (promptPath: string) => Promise<void>;
  readonly reportSkipped?: (agent: AgentName, reason: PromptBootstrapSkipReason) => void | Promise<void>;
  readonly writeStderr?: (text: string) => unknown;
}

export interface MergeConflictAgentLaunchOptions {
  readonly prompt: string;
  /** Repository the agent works in; the prompt file lives under its `.psyche/prompts`. */
  readonly cwd: string;
  readonly slug: string;
  readonly permissionMode?: PermissionMode;
  /** Shell that parses the launch line. Injectable for tests. */
  readonly shellPath?: string;
  readonly deps?: MergeConflictAgentLaunchDeps;
}

export interface MergeConflictAgentLaunchResult {
  /** The agent that exited cleanly, or null when every candidate failed. */
  readonly launchedAgent: AgentName | null;
  /** Why the launched agent got no prompt; null when it got one or none launched. */
  readonly initialPromptSkipped: PromptBootstrapSkipReason | null;
}

async function defaultReportSkipped(
  agent: AgentName,
  reason: PromptBootstrapSkipReason,
): Promise<void> {
  await reportPromptBootstrapSkipped(agent, reason, 'mergePane', 'merge');
}

/**
 * Agent-neutral stand-in for the skip warning, written before an attempt
 * starts: which candidate will actually run is not known until it does.
 */
const NEUTRAL_AGENT_LABEL = 'The merge-conflict agent';

export async function launchMergeConflictAgent(
  options: MergeConflictAgentLaunchOptions,
): Promise<MergeConflictAgentLaunchResult> {
  const {
    prompt,
    cwd,
    slug,
    permissionMode,
    shellPath = DEFAULT_LAUNCH_SHELL,
    deps = {},
  } = options;
  const execFileSync = deps.execFileSync
    ?? ((file: string, args: readonly string[], execOptions: { cwd: string; stdio: 'inherit' }) =>
      nodeExecFileSync(file, [...args], execOptions));
  const writePromptFile = deps.writePromptFile ?? storeWritePromptFile;
  const deletePromptFile = deps.deletePromptFile ?? storeDeletePromptFile;
  const reportSkipped = deps.reportSkipped ?? defaultReportSkipped;

  // The dialect comes from the shell that will parse the line, classified by
  // the same rules as a pane's shell. It is a fixed binary, so one read with
  // no polling is the whole answer.
  const shell = await resolvePaneShell(async () => shellPath, { timeoutMs: 0 });

  const writeStderr = deps.writeStderr ?? ((text: string) => process.stderr.write(text));
  const writeNotice = (text: string): void => {
    try {
      writeStderr(`${text}\n`);
    } catch {
      // Best effort.
    }
  };

  const hasPrompt = prompt.trim().length > 0;
  for (const agent of MERGE_CONFLICT_AGENTS) {
    let promptPath: string | null = null;
    let line = buildAgentCommand(agent, permissionMode);
    // Per attempt: a skip belongs to the attempt that hit it, and is reported
    // for an agent only once that agent has actually run.
    let attemptSkipped: PromptBootstrapSkipReason | null = null;

    if (hasPrompt && shell.dialect === null) {
      attemptSkipped = shell.reason;
    } else if (hasPrompt && shell.dialect) {
      try {
        promptPath = await writePromptFile(cwd, slug, prompt);
      } catch {
        promptPath = null;
      }
      if (promptPath) {
        line = `${buildPromptReadAndDeleteSnippet(promptPath, shell.dialect)}; ${buildInitialPromptCommand(
          agent,
          '"$PSYCHE_PROMPT_CONTENT"',
          permissionMode,
        )}`;
      } else {
        attemptSkipped = 'prompt_file_unwritable';
      }
    }

    // The TUI has cleared the screen and a toast would never render, so the
    // operator is told here, before the agent takes the terminal.
    if (attemptSkipped) {
      writeNotice(describePromptBootstrapSkipped(NEUTRAL_AGENT_LABEL, attemptSkipped));
    }

    let launched = false;
    try {
      execFileSync(shellPath, ['-c', line], { cwd, stdio: 'inherit' });
      launched = true;
    } catch {
      // Not installed or exited non-zero: try the next agent.
    } finally {
      // The shell deletes the file once read; this covers a shell that never
      // got that far.
      if (promptPath) await deletePromptFile(promptPath);
    }

    if (launched) {
      if (attemptSkipped) {
        try {
          await reportSkipped(agent, attemptSkipped);
        } catch {
          // Reporting must never disturb the outcome.
        }
      }
      return { launchedAgent: agent, initialPromptSkipped: attemptSkipped };
    }
  }

  // Nothing started (no agent installed, every attempt failed, or no
  // /bin/sh on this platform): say so, since the TUI is about to exit.
  writeNotice(
    `No merge-conflict agent could be started (tried ${MERGE_CONFLICT_AGENTS.join(', ')}). Resolve the conflicts manually.`,
  );
  return { launchedAgent: null, initialPromptSkipped: null };
}
