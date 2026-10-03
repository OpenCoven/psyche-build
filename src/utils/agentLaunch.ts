import { existsSync } from 'node:fs';
import { TmuxService } from '../services/TmuxService.js';
import {
  buildPromptReadAndDeleteSnippet,
  writePromptFile,
} from './promptStore.js';
import {
  buildCodexHookedCommand,
} from './codexHooks.js';
import { ensureGeminiFolderTrusted } from './geminiTrust.js';
import { sendPromptViaTmux, type PromptPasteClock } from './agentPromptDispatch.js';
import {
  buildAgentExitRecorderSuffix,
  type AgentExitRecorder,
} from './agentLaunchOutcome.js';
import {
  reportPromptBootstrapSkipped,
  resolvePaneShell,
  type PaneShellProbeOptions,
  type PromptBootstrapSkipReason,
  type PromptSkipReportDeps,
} from './paneShellDialect.js';

/**
 * Registry order is user-visible: it drives the new-pane agent picker, the
 * enabled-agents settings list, and the default-enabled set. Coven CLI leads
 * because Coven CLI is this project's own default agent experience.
 */
export const AGENT_IDS = [
  'coven-code',
  'claude',
  'opencode',
  'codex',
  'cline',
  'gemini',
  'qwen',
  'amp',
  'pi',
  'cursor',
  'copilot',
  'crush',
] as const;

export type AgentName = typeof AGENT_IDS[number];
export type PermissionMode = '' | 'plan' | 'acceptEdits' | 'bypassPermissions';
/**
 * How an initial prompt reaches the agent. See docs/AGENT-PROMPT-TRANSPORT.md.
 *
 * - `send-keys`: launched bare, then the prompt is pasted into the TUI through
 *   a tmux buffer loaded over stdin. It is in no process argv.
 * - `stdin`: piped to the agent from the prompt file by the pane's shell
 *   (`printf` is a shell builtin there). It is not in the agent's argv.
 * - `launch-only`: no initial prompt is delivered.
 * - `positional` / `option`: the pane's shell expands the prompt into the
 *   AGENT's argv, visible in `ps` for the agent's lifetime (#523). Every such
 *   entry must carry `promptArgvExposure` saying why no argv-free transport is
 *   used yet.
 */
export type PromptTransport = 'launch-only' | 'positional' | 'option' | 'stdin' | 'send-keys';

export interface AgentLaunchOption {
  id: string;
  label: string;
  agents: AgentName[];
  isPair: boolean;
}

export interface AgentRegistryEntry {
  id: AgentName;
  name: string;
  shortLabel: string;
  description: string;
  slugSuffix: string;
  installTestCommand: string;
  commonPaths: string[];
  promptCommand: string;
  noPromptCommand?: string;
  promptTransport: PromptTransport;
  promptOption?: string;
  /**
   * Required for `positional` and `option` transports: why the prompt still
   * reaches this agent's argv rather than an argv-free transport (#523).
   */
  promptArgvExposure?: string;
  sendKeysPrePrompt?: string[];
  sendKeysSubmit?: string[];
  sendKeysPostPasteDelayMs?: number;
  sendKeysReadyDelayMs?: number;
  permissionFlags: Partial<Record<Exclude<PermissionMode, ''>, string>>;
  defaultEnabled: boolean;
  resumeCommandTemplate?: string;
}

const HOME = process.env.HOME || '';
const homePath = (suffix: string): string[] =>
  HOME ? [`${HOME}/${suffix}`] : [];

export const AGENT_REGISTRY: Readonly<Record<AgentName, AgentRegistryEntry>> = {
  claude: {
    id: 'claude',
    name: 'Claude Code',
    shortLabel: 'cc',
    description: 'Anthropic Claude Code CLI',
    slugSuffix: 'claude-code',
    installTestCommand: 'command -v claude 2>/dev/null || which claude 2>/dev/null',
    commonPaths: [
      ...homePath('.claude/local/claude'),
      ...homePath('.local/bin/claude'),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      '/usr/bin/claude',
      ...homePath('bin/claude'),
    ],
    promptCommand: 'claude',
    promptTransport: 'positional',
    promptArgvExposure:
      'No documented initial-prompt file flag (--system-prompt-file and --append-system-prompt-file set the system prompt); piped stdin is documented only with -p (non-interactive). Pasting after launch is unverified, and would race the workspace-trust dialog Psyche auto-answers.',
    permissionFlags: {
      plan: '--permission-mode plan',
      acceptEdits: '--permission-mode acceptEdits',
      bypassPermissions: '--dangerously-skip-permissions',
    },
    defaultEnabled: true,
    resumeCommandTemplate: 'claude --continue{permissions}',
  },
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    shortLabel: 'oc',
    description: 'OpenCode CLI',
    slugSuffix: 'opencode',
    installTestCommand: 'command -v opencode 2>/dev/null || which opencode 2>/dev/null',
    commonPaths: [
      '/opt/homebrew/bin/opencode',
      '/usr/local/bin/opencode',
      ...homePath('.local/bin/opencode'),
      ...homePath('bin/opencode'),
    ],
    promptCommand: 'opencode',
    promptTransport: 'option',
    promptOption: '--prompt',
    promptArgvExposure:
      "Piped stdin becomes the TUI's initial prompt in source (packages/opencode/src/cli/cmd/tui.ts), but that is undocumented and keyboard input after stdin EOF is unverified. No prompt-file flag (run --file attaches). Pasting after launch is unverified (see docs/AGENT-PROMPT-TRANSPORT.md).",
    permissionFlags: {},
    defaultEnabled: true,
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    shortLabel: 'cx',
    description: 'OpenAI Codex CLI',
    slugSuffix: 'codex',
    installTestCommand: 'command -v codex 2>/dev/null || which codex 2>/dev/null',
    commonPaths: [
      '/usr/local/bin/codex',
      '/opt/homebrew/bin/codex',
      ...homePath('.local/bin/codex'),
      ...homePath('bin/codex'),
      ...homePath('.npm-global/bin/codex'),
    ],
    promptCommand: 'codex',
    promptTransport: 'positional',
    promptArgvExposure:
      'No prompt-file flag; the interactive TUI refuses a non-terminal stdin (codex exec - is non-interactive). Pasting after launch is unverified (see docs/AGENT-PROMPT-TRANSPORT.md).',
    permissionFlags: {
      acceptEdits: '--ask-for-approval untrusted --sandbox danger-full-access',
      bypassPermissions: '--dangerously-bypass-approvals-and-sandbox',
    },
    defaultEnabled: true,
    resumeCommandTemplate: 'codex resume --last{permissions}',
  },
  cline: {
    id: 'cline',
    name: 'Cline CLI',
    shortLabel: 'cl',
    description: 'Cline terminal coding agent',
    slugSuffix: 'cline',
    installTestCommand: 'command -v cline 2>/dev/null || which cline 2>/dev/null',
    commonPaths: [
      '/usr/local/bin/cline',
      '/opt/homebrew/bin/cline',
      ...homePath('.local/bin/cline'),
      ...homePath('bin/cline'),
    ],
    promptCommand: 'cline',
    promptTransport: 'send-keys',
    sendKeysPostPasteDelayMs: 120,
    sendKeysReadyDelayMs: 2500,
    permissionFlags: {
      plan: '--plan',
      acceptEdits: '--act',
      bypassPermissions: '--act --yolo',
    },
    defaultEnabled: false,
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini CLI',
    shortLabel: 'gm',
    description: 'Google Gemini CLI',
    slugSuffix: 'gemini',
    installTestCommand: 'command -v gemini 2>/dev/null || which gemini 2>/dev/null',
    commonPaths: [
      '/usr/local/bin/gemini',
      '/opt/homebrew/bin/gemini',
      ...homePath('.local/bin/gemini'),
      ...homePath('bin/gemini'),
      ...homePath('.npm-global/bin/gemini'),
    ],
    promptCommand: 'gemini',
    promptTransport: 'option',
    promptOption: '--prompt-interactive',
    promptArgvExposure:
      '--prompt-interactive refuses piped stdin; @path only attaches file content and needs the file at submit time. Pasting after launch is unverified (see docs/AGENT-PROMPT-TRANSPORT.md).',
    permissionFlags: {
      plan: '--approval-mode plan',
      acceptEdits: '--approval-mode auto_edit',
      bypassPermissions: '--approval-mode yolo',
    },
    defaultEnabled: false,
    resumeCommandTemplate: 'gemini --resume latest{permissions}',
  },
  qwen: {
    id: 'qwen',
    name: 'Qwen CLI',
    shortLabel: 'qn',
    description: 'Qwen Code CLI',
    slugSuffix: 'qwen',
    installTestCommand: 'command -v qwen 2>/dev/null || which qwen 2>/dev/null',
    commonPaths: [
      '/usr/local/bin/qwen',
      '/opt/homebrew/bin/qwen',
      ...homePath('.local/bin/qwen'),
      ...homePath('bin/qwen'),
      ...homePath('.npm-global/bin/qwen'),
    ],
    promptCommand: 'qwen',
    promptTransport: 'option',
    promptOption: '-i',
    promptArgvExposure:
      'Same as gemini (fork): -i refuses piped stdin; @path only attaches file content. Pasting after launch is unverified (see docs/AGENT-PROMPT-TRANSPORT.md).',
    permissionFlags: {
      plan: '--approval-mode plan',
      acceptEdits: '--approval-mode auto-edit',
      bypassPermissions: '--approval-mode yolo',
    },
    defaultEnabled: false,
    resumeCommandTemplate: 'qwen --continue{permissions}',
  },
  amp: {
    id: 'amp',
    name: 'Amp CLI',
    shortLabel: 'ap',
    description: 'Sourcegraph Amp CLI',
    slugSuffix: 'amp',
    installTestCommand: 'command -v amp 2>/dev/null || which amp 2>/dev/null',
    commonPaths: [
      '/usr/local/bin/amp',
      '/opt/homebrew/bin/amp',
      ...homePath('.local/bin/amp'),
      ...homePath('bin/amp'),
      ...homePath('.npm-global/bin/amp'),
    ],
    promptCommand: 'amp',
    promptTransport: 'stdin',
    permissionFlags: {
      bypassPermissions: '--dangerously-allow-all',
    },
    defaultEnabled: false,
  },
  pi: {
    id: 'pi',
    name: 'pi CLI',
    shortLabel: 'pi',
    description: 'pi coding agent CLI',
    slugSuffix: 'pi',
    installTestCommand: 'command -v pi 2>/dev/null || which pi 2>/dev/null',
    commonPaths: [
      '/usr/local/bin/pi',
      '/opt/homebrew/bin/pi',
      ...homePath('.local/bin/pi'),
      ...homePath('bin/pi'),
      ...homePath('.npm-global/bin/pi'),
    ],
    promptCommand: 'pi',
    promptTransport: 'positional',
    promptArgvExposure:
      'pi @file is documented, but it wraps the content in a <file name=ABS> block (changing the prompt and exposing the path) and the file must outlive startup; piped stdin forces print mode. Pasting after launch is unverified (see docs/AGENT-PROMPT-TRANSPORT.md).',
    permissionFlags: {
      plan: '--tools read,grep,find,ls',
    },
    defaultEnabled: false,
    resumeCommandTemplate: 'pi --continue{permissions}',
  },
  cursor: {
    id: 'cursor',
    name: 'Cursor CLI',
    shortLabel: 'cr',
    description: 'Cursor agent CLI',
    slugSuffix: 'cursor',
    installTestCommand: 'command -v cursor-agent 2>/dev/null || which cursor-agent 2>/dev/null',
    commonPaths: [
      ...homePath('.cursor/bin/cursor-agent'),
      '/usr/local/bin/cursor-agent',
      '/opt/homebrew/bin/cursor-agent',
      ...homePath('.local/bin/cursor-agent'),
      ...homePath('bin/cursor-agent'),
    ],
    promptCommand: 'cursor-agent',
    promptTransport: 'positional',
    promptArgvExposure:
      'No documented prompt-file flag or interactive stdin; @ only adds files to context. Pasting after launch is unverified (see docs/AGENT-PROMPT-TRANSPORT.md).',
    permissionFlags: {},
    defaultEnabled: false,
  },
  copilot: {
    id: 'copilot',
    name: 'Copilot CLI',
    shortLabel: 'co',
    description: 'GitHub Copilot CLI',
    slugSuffix: 'copilot',
    installTestCommand: 'command -v copilot 2>/dev/null || which copilot 2>/dev/null',
    commonPaths: [
      '/usr/local/bin/copilot',
      '/opt/homebrew/bin/copilot',
      ...homePath('.local/bin/copilot'),
      ...homePath('bin/copilot'),
      ...homePath('.npm-global/bin/copilot'),
    ],
    promptCommand: 'copilot',
    promptTransport: 'option',
    promptOption: '-i',
    promptArgvExposure:
      'No prompt-file flag; a piped prompt is treated like -p (non-interactive); @FILE only adds context. Pasting after launch is unverified (see docs/AGENT-PROMPT-TRANSPORT.md).',
    permissionFlags: {
      acceptEdits: '--allow-tool write',
      bypassPermissions: '--allow-all',
    },
    defaultEnabled: false,
    resumeCommandTemplate: 'copilot --continue{permissions}',
  },
  crush: {
    id: 'crush',
    name: 'Crush CLI',
    shortLabel: 'cs',
    description: 'Charmbracelet Crush CLI',
    slugSuffix: 'crush',
    installTestCommand: 'command -v crush 2>/dev/null || which crush 2>/dev/null',
    commonPaths: [
      '/usr/local/bin/crush',
      '/opt/homebrew/bin/crush',
      ...homePath('.local/bin/crush'),
      ...homePath('bin/crush'),
      ...homePath('.npm-global/bin/crush'),
    ],
    promptCommand: 'crush run',
    noPromptCommand: 'crush',
    promptTransport: 'send-keys',
    sendKeysPrePrompt: ['Escape', 'Tab'],
    sendKeysSubmit: ['Enter'],
    sendKeysPostPasteDelayMs: 200,
    sendKeysReadyDelayMs: 1200,
    permissionFlags: {
      bypassPermissions: '--yolo',
    },
    defaultEnabled: false,
  },
  'coven-code': {
    id: 'coven-code',
    name: 'Coven CLI',
    shortLabel: 'cv',
    description: 'OpenCoven Coven CLI terminal interface',
    slugSuffix: 'coven-code',
    installTestCommand: 'command -v coven 2>/dev/null || which coven 2>/dev/null',
    commonPaths: [
      ...homePath('.local/bin/coven'),
      '/opt/homebrew/bin/coven',
      '/usr/local/bin/coven',
      ...homePath('bin/coven'),
      ...homePath('.npm-global/bin/coven'),
    ],
    promptCommand: 'coven',
    promptTransport: 'launch-only',
    permissionFlags: {},
    defaultEnabled: true,
  },
};

for (const agentId of AGENT_IDS) {
  const shortLabel = AGENT_REGISTRY[agentId].shortLabel;
  if (shortLabel.length !== 2) {
    throw new Error(
      `Invalid shortLabel for agent "${agentId}": expected 2 characters, received "${shortLabel}"`
    );
  }
}

// #523: an agent whose prompt reaches its own argv must say why, so the
// exposure is a recorded decision rather than a silent default.
for (const agentId of AGENT_IDS) {
  const entry = AGENT_REGISTRY[agentId];
  const exposesArgv = entry.promptTransport === 'positional' || entry.promptTransport === 'option';
  if (exposesArgv && !entry.promptArgvExposure?.trim()) {
    throw new Error(
      `Agent "${agentId}" passes its prompt in argv (${entry.promptTransport}) without promptArgvExposure`
    );
  }
  if (!exposesArgv && entry.promptArgvExposure !== undefined) {
    throw new Error(
      `Agent "${agentId}" declares promptArgvExposure but its ${entry.promptTransport} transport keeps the prompt out of argv`
    );
  }
}

const shortLabelSet = new Set<string>();
for (const agentId of AGENT_IDS) {
  const shortLabel = AGENT_REGISTRY[agentId].shortLabel;
  if (shortLabelSet.has(shortLabel)) {
    throw new Error(`Duplicate shortLabel "${shortLabel}" in agent registry`);
  }
  shortLabelSet.add(shortLabel);
}

export function isAgentName(value: string): value is AgentName {
  return (AGENT_IDS as readonly string[]).includes(value);
}

export function getAgentDefinitions(): AgentRegistryEntry[] {
  return AGENT_IDS.map((agent) => AGENT_REGISTRY[agent]);
}

export function getAgentDefinition(agent: AgentName): AgentRegistryEntry {
  return AGENT_REGISTRY[agent];
}

export function getAgentLabel(agent: AgentName): string {
  return AGENT_REGISTRY[agent].name;
}

export function getAgentShortLabel(agent: AgentName): string {
  return AGENT_REGISTRY[agent].shortLabel;
}

export function getAgentDescription(agent: AgentName): string {
  return AGENT_REGISTRY[agent].description;
}

export function getPromptTransport(agent: AgentName): PromptTransport {
  return AGENT_REGISTRY[agent].promptTransport;
}

/**
 * True when the agent's initial prompt is expanded into the agent's own argv
 * (#523). Such agents carry `promptArgvExposure` explaining why.
 */
export function promptReachesAgentArgv(agent: AgentName): boolean {
  const transport = AGENT_REGISTRY[agent].promptTransport;
  return transport === 'positional' || transport === 'option';
}

export function getAgentSlugSuffix(agent: AgentName): string {
  return AGENT_REGISTRY[agent].slugSuffix;
}

export function getAgentProcessName(agent: AgentName): string {
  const definition = AGENT_REGISTRY[agent];
  const baseCommand = (definition.noPromptCommand || definition.promptCommand).trim();
  const commandToken = baseCommand.split(/\s+/)[0] || '';
  const pathSegments = commandToken.split('/');
  return pathSegments[pathSegments.length - 1] || commandToken;
}

export function getSendKeysSubmit(agent: AgentName): string[] {
  const configured = AGENT_REGISTRY[agent].sendKeysSubmit;
  if (configured && configured.length > 0) {
    return [...configured];
  }
  return ['Enter'];
}

export function getSendKeysPrePrompt(agent: AgentName): string[] {
  const configured = AGENT_REGISTRY[agent].sendKeysPrePrompt;
  if (configured && configured.length > 0) {
    return [...configured];
  }
  return [];
}

export function getSendKeysPostPasteDelayMs(agent: AgentName): number {
  const value = AGENT_REGISTRY[agent].sendKeysPostPasteDelayMs;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return 0;
}

export function getSendKeysReadyDelayMs(agent: AgentName): number {
  const value = AGENT_REGISTRY[agent].sendKeysReadyDelayMs;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return 0;
}

export function getDefaultEnabledAgents(): AgentName[] {
  return AGENT_IDS.filter((agent) => AGENT_REGISTRY[agent].defaultEnabled);
}

/**
 * Resolve enabled agent list from settings.
 * If the user has not configured enabledAgents, fall back to registry defaults.
 */
export function resolveEnabledAgentsSelection(
  enabledAgents: readonly string[] | undefined
): AgentName[] {
  if (Array.isArray(enabledAgents)) {
    const configured = new Set(enabledAgents.filter(isAgentName));
    return AGENT_IDS.filter((agent) => configured.has(agent));
  }

  return getDefaultEnabledAgents();
}

function appendFlags(base: string, flags: string): string {
  return flags ? `${base} ${flags}` : base;
}

export function appendSlugSuffix(baseSlug: string, slugSuffix?: string): string {
  if (!slugSuffix) return baseSlug;

  const normalizedSuffix = slugSuffix
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!normalizedSuffix) return baseSlug;
  if (baseSlug === normalizedSuffix || baseSlug.endsWith(`-${normalizedSuffix}`)) {
    return baseSlug;
  }

  return `${baseSlug}-${normalizedSuffix}`;
}

export function buildAgentLaunchOptions(
  availableAgents: AgentName[]
): AgentLaunchOption[] {
  const uniqueAgents = availableAgents.filter(
    (agent, index) => availableAgents.indexOf(agent) === index
  );

  return uniqueAgents.map((agent) => ({
    id: agent,
    label: getAgentLabel(agent),
    agents: [agent],
    isPair: false,
  }));
}

/**
 * Resolve CLI permission flags for a given agent and psyche permissionMode.
 */
export function getPermissionFlags(
  agent: AgentName,
  permissionMode: PermissionMode | undefined
): string {
  const mode = permissionMode || '';
  if (mode === '') return '';
  return AGENT_REGISTRY[agent].permissionFlags[mode] || '';
}

export function buildAgentCommand(
  agent: AgentName,
  permissionMode: PermissionMode | undefined,
): string {
  const definition = AGENT_REGISTRY[agent];
  const baseCommand = definition.noPromptCommand || definition.promptCommand;
  return appendFlags(
    baseCommand,
    getPermissionFlags(agent, permissionMode)
  );
}

export function buildInitialPromptCommand(
  agent: AgentName,
  promptToken: string,
  permissionMode: PermissionMode | undefined,
): string {
  const definition = AGENT_REGISTRY[agent];
  if (
    definition.promptTransport === 'launch-only'
    || definition.promptTransport === 'send-keys'
  ) {
    return buildAgentCommand(agent, permissionMode);
  }

  const baseCommand = appendFlags(
    definition.promptCommand,
    getPermissionFlags(agent, permissionMode)
  );

  if (definition.promptTransport === 'stdin') {
    return `printf '%s\\n' ${promptToken} | ${baseCommand}`;
  }

  if (definition.promptTransport === 'option' && definition.promptOption) {
    return `${baseCommand} ${definition.promptOption} ${promptToken}`;
  }

  return `${baseCommand} ${promptToken}`;
}

export function buildResumeCommand(
  agent: AgentName,
  permissionMode: PermissionMode | undefined
): string | undefined {
  const template = AGENT_REGISTRY[agent].resumeCommandTemplate;
  if (!template) return undefined;

  const permissionFlags = getPermissionFlags(agent, permissionMode);
  const permissionSuffix = permissionFlags ? ` ${permissionFlags}` : '';

  if (template.includes('{permissions}')) {
    return template.replace('{permissions}', permissionSuffix);
  }

  return appendFlags(template, permissionFlags);
}

export function buildAgentResumeOrLaunchCommand(
  agent: AgentName,
  permissionMode: PermissionMode | undefined
): string {
  return buildResumeCommand(agent, permissionMode)
    || buildAgentCommand(agent, permissionMode);
}

/**
 * Launch an agent CLI inside an already-existing tmux pane.
 *
 * Shared by `createPane()` (new worktree panes) and `attachAgentToWorktree()`
 * (sibling panes reusing an existing worktree).
 */
export interface LaunchAgentInPaneOptions {
  paneId: string;
  agent: AgentName;
  prompt: string;
  slug: string;
  projectRoot: string;
  /** Worktree the agent runs in, when the lane has one. */
  worktreePath?: string;
  permissionMode?: PermissionMode;
  psychePaneId?: string;
  codexHookEventFile?: string;
  /**
   * Records the agent's exit status on the pane after it returns, so a launch
   * that fails inside the live shell can be classified (#475). Applied only
   * when the pane's own shell is one known to accept the suffix.
   */
  exitRecorder?: AgentExitRecorder;
  /** Clock and sleep for the bounded pane-shell probe; injectable for tests. */
  paneShellProbe?: PaneShellProbeOptions;
  /** Log and toast seams for a skipped prompt; injectable for tests. */
  promptSkipReport?: PromptSkipReportDeps;
  /** Clock and sleep for the pasted-prompt readiness wait; injectable for tests. */
  promptPasteClock?: PromptPasteClock;
  /** Injectable for tests. */
  tmuxService?: Pick<
    TmuxService,
    | 'sendShellCommand'
    | 'sendTmuxKeys'
    | 'getPaneCurrentCommand'
    | 'loadBufferFromStdin'
    | 'pasteBufferAndDelete'
    | 'deleteBuffer'
  >;
}

/**
 * Start an agent in an already-created tmux pane.
 *
 * This is the single launch path for every entry in AGENT_REGISTRY. It drives
 * the registry rather than branching per agent — an earlier version hardcoded
 * claude/codex/opencode and silently did nothing for the other nine, including
 * coven-code.
 *
 * Claude's workspace-trust monitoring is deliberately NOT handled here: it
 * lives in paneCreation, which would be a circular import.
 */
export interface LaunchAgentInPaneResult {
  /** True only when the exit recorder was appended to the typed command. */
  readonly exitRecorderArmed: boolean;
  /** Why a command-line prompt was not delivered, or null when it was (or none was due). */
  readonly initialPromptSkipped: PromptBootstrapSkipReason | null;
}

export async function launchAgentInPane(
  options: LaunchAgentInPaneOptions
): Promise<LaunchAgentInPaneResult> {
  const {
    paneId,
    agent,
    prompt,
    slug,
    projectRoot,
    worktreePath,
    permissionMode,
    psychePaneId,
    codexHookEventFile,
    exitRecorder,
    paneShellProbe,
    promptSkipReport,
    promptPasteClock,
    tmuxService = TmuxService.getInstance(),
  } = options;

  if (agent === 'gemini') {
    const workspacePath = worktreePath && existsSync(worktreePath)
      ? worktreePath
      : projectRoot;
    ensureGeminiFolderTrusted(workspacePath);
  }

  const hasInitialPrompt = !!(prompt && prompt.trim());
  const promptTransport = getPromptTransport(agent);
  const omitsPromptDelivery = promptTransport === 'launch-only';
  // send-keys agents are launched bare, then typed into once their TUI is up.
  const shouldSendPromptViaTmux = hasInitialPrompt && promptTransport === 'send-keys';

  const takesCommandLinePrompt = hasInitialPrompt && !shouldSendPromptViaTmux && !omitsPromptDelivery;

  // The pane's current command is its shell before the agent is typed. It is
  // the send-keys baseline and the only trustworthy answer to which shell will
  // parse the prompt bootstrap and the exit recorder (#475, #508). Callers own
  // a fresh pane (see paneShellDialect.ts), so a program still in the
  // foreground after the bounded probe is an rc-file leftover, not an editor.
  const paneShell = shouldSendPromptViaTmux || exitRecorder || takesCommandLinePrompt
    ? await resolvePaneShell(() => tmuxService.getPaneCurrentCommand(paneId), paneShellProbe)
    : null;
  const dialect = paneShell?.dialect ?? null;
  const baselineCommand = shouldSendPromptViaTmux ? paneShell?.paneCommand : undefined;

  let launchCommand = buildAgentCommand(agent, permissionMode);
  let initialPromptSkipped: PromptBootstrapSkipReason | null = null;
  if (takesCommandLinePrompt && paneShell && paneShell.dialect === null) {
    // No known dialect: the bootstrap is shell syntax, and a line the pane's
    // shell rejects would stop the agent from starting at all. Launch it bare
    // and write no prompt file.
    initialPromptSkipped = paneShell.reason;
  } else if (takesCommandLinePrompt && dialect) {
    // The prompt travels only through a file read by the pane's own shell; it
    // is never typed or placed in argv (AGENTS.md). If the file cannot be
    // written, the agent launches bare rather than inlining the prompt.
    let promptFilePath: string | null = null;
    try {
      promptFilePath = await writePromptFile(projectRoot, slug, prompt);
    } catch {
      promptFilePath = null;
    }

    if (promptFilePath) {
      const promptBootstrap = buildPromptReadAndDeleteSnippet(promptFilePath, dialect);
      launchCommand = `${promptBootstrap}; ${buildInitialPromptCommand(
        agent,
        '"$PSYCHE_PROMPT_CONTENT"',
        permissionMode,
      )}`;
    } else {
      initialPromptSkipped = 'prompt_file_unwritable';
    }
  }

  if (agent === 'codex') {
    launchCommand = buildCodexHookedCommand(launchCommand, {
      psychePaneId: psychePaneId || '',
      tmuxPaneId: paneId,
      eventFile: codexHookEventFile,
    });
  }

  const recorderSyntax = exitRecorder ? dialect : null;
  if (exitRecorder && recorderSyntax) {
    launchCommand += buildAgentExitRecorderSuffix(exitRecorder, recorderSyntax);
  }

  await tmuxService.sendShellCommand(paneId, launchCommand);
  await tmuxService.sendTmuxKeys(paneId, 'Enter');

  if (initialPromptSkipped) {
    await reportPromptBootstrapSkipped(agent, initialPromptSkipped, 'agentLaunch', paneId, promptSkipReport);
  }

  if (shouldSendPromptViaTmux) {
    const pasted = await sendPromptViaTmux({
      paneId,
      prompt,
      tmuxService,
      expectedCommand: getAgentProcessName(agent),
      baselineCommand,
      prePromptKeys: getSendKeysPrePrompt(agent),
      submitKeys: getSendKeysSubmit(agent),
      postPasteDelayMs: getSendKeysPostPasteDelayMs(agent),
      readyDelayMs: getSendKeysReadyDelayMs(agent),
      ...promptPasteClock,
    });
    if (!pasted.delivered) {
      initialPromptSkipped = pasted.reason;
      await reportPromptBootstrapSkipped(agent, pasted.reason, 'agentLaunch', paneId, promptSkipReport);
    }
  }

  return {
    exitRecorderArmed: Boolean(exitRecorder && recorderSyntax),
    initialPromptSkipped,
  };
}
