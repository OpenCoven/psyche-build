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
  /** Why the prompt was not delivered, or null when it was. */
  readonly initialPromptSkipped: PromptBootstrapSkipReason | null;
}

async function defaultReportSkipped(
  agent: AgentName,
  reason: PromptBootstrapSkipReason,
): Promise<void> {
  await reportPromptBootstrapSkipped(agent, reason, 'mergePane', 'merge');
  // The TUI clears the screen and hands the terminal to the agent, so a toast
  // may never render; the same bounded message goes to stderr as well.
  try {
    process.stderr.write(`${describePromptBootstrapSkipped(agent, reason)}\n`);
  } catch {
    // Best effort.
  }
}

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

  let initialPromptSkipped: PromptBootstrapSkipReason | null = null;
  const noteSkipped = async (agent: AgentName, reason: PromptBootstrapSkipReason): Promise<void> => {
    if (initialPromptSkipped) return;
    initialPromptSkipped = reason;
    try {
      await reportSkipped(agent, reason);
    } catch {
      // Reporting must never stop the launch.
    }
  };

  const hasPrompt = prompt.trim().length > 0;
  for (const agent of MERGE_CONFLICT_AGENTS) {
    let promptPath: string | null = null;
    let line = buildAgentCommand(agent, permissionMode);

    if (hasPrompt && shell.dialect === null) {
      await noteSkipped(agent, shell.reason);
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
        await noteSkipped(agent, 'prompt_file_unwritable');
      }
    }

    try {
      execFileSync(shellPath, ['-c', line], { cwd, stdio: 'inherit' });
      return { launchedAgent: agent, initialPromptSkipped };
    } catch {
      // Not installed or exited non-zero: try the next agent.
    } finally {
      // The shell deletes the file once read; this covers a shell that never
      // got that far.
      if (promptPath) await deletePromptFile(promptPath);
    }
  }

  return { launchedAgent: null, initialPromptSkipped };
}
