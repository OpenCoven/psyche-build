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
import { sendPromptViaTmux } from './agentPromptDispatch.js';

/**
 * Registry order is user-visible: it drives the new-pane agent picker, the
 * enabled-agents settings list, and the default-enabled set. Coven Code leads
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
  /** Injectable for tests. */
  tmuxService?: Pick<
    TmuxService,
    'sendShellCommand' | 'sendTmuxKeys' | 'getPaneCurrentCommand'
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
export async function launchAgentInPane(
  options: LaunchAgentInPaneOptions
): Promise<void> {
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

  let baselineCommand: string | undefined;
  if (shouldSendPromptViaTmux) {
    try {
      baselineCommand = await tmuxService.getPaneCurrentCommand(paneId);
    } catch {
      baselineCommand = undefined;
    }
  }

  let launchCommand: string;
  if (hasInitialPrompt && !shouldSendPromptViaTmux && !omitsPromptDelivery) {
    // Prefer a prompt file so the prompt never has to survive shell quoting.
    let promptFilePath: string | null = null;
    try {
      promptFilePath = await writePromptFile(projectRoot, slug, prompt);
    } catch {
      // Fall back to inline escaping if the prompt file cannot be written.
    }

    if (promptFilePath) {
      const promptBootstrap = buildPromptReadAndDeleteSnippet(promptFilePath);
      launchCommand = `${promptBootstrap}; ${buildInitialPromptCommand(
        agent,
        '"$PSYCHE_PROMPT_CONTENT"',
        permissionMode,
      )}`;
    } else {
      const escapedPrompt = prompt
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/`/g, '\\`')
        .replace(/\$/g, '\\$');
      launchCommand = buildInitialPromptCommand(
        agent,
        `"${escapedPrompt}"`,
        permissionMode,
      );
    }
  } else {
    launchCommand = buildAgentCommand(agent, permissionMode);
  }

  if (agent === 'codex') {
    launchCommand = buildCodexHookedCommand(launchCommand, {
      psychePaneId: psychePaneId || '',
      tmuxPaneId: paneId,
      eventFile: codexHookEventFile,
    });
  }

  await tmuxService.sendShellCommand(paneId, launchCommand);
  await tmuxService.sendTmuxKeys(paneId, 'Enter');

  if (shouldSendPromptViaTmux) {
    await sendPromptViaTmux({
      paneId,
      prompt,
      tmuxService: tmuxService as TmuxService,
      expectedCommand: getAgentProcessName(agent),
      baselineCommand,
      prePromptKeys: getSendKeysPrePrompt(agent),
      submitKeys: getSendKeysSubmit(agent),
      postPasteDelayMs: getSendKeysPostPasteDelayMs(agent),
      readyDelayMs: getSendKeysReadyDelayMs(agent),
    });
  }
}
