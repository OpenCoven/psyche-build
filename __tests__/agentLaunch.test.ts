import { describe, it, expect } from 'vitest';
import {
  AGENT_IDS,
  AGENT_REGISTRY,
  getAgentDefinitions,
  getPromptTransport,
  getAgentShortLabel,
  appendSlugSuffix,
  buildAgentCommand,
  buildAgentLaunchOptions,
  buildInitialPromptCommand,
  buildResumeCommand,
  buildAgentResumeOrLaunchCommand,
  getDefaultEnabledAgents,
  getAgentSlugSuffix,
  getPermissionFlags,
  getSendKeysPostPasteDelayMs,
  getSendKeysPrePrompt,
  getSendKeysReadyDelayMs,
  getSendKeysSubmit,
  isAgentName,
  type AgentName,
  type PromptTransport,
} from '../src/utils/agentLaunch.js';

describe('agent launch utils', () => {
  it('appends normalized slug suffix once', () => {
    expect(appendSlugSuffix('feature-a', 'Claude Code')).toBe('feature-a-claude-code');
    expect(appendSlugSuffix('feature-a-claude-code', 'claude-code')).toBe('feature-a-claude-code');
  });

  it('returns per-agent slug suffixes', () => {
    expect(getAgentSlugSuffix('claude')).toBe('claude-code');
    expect(getAgentSlugSuffix('opencode')).toBe('opencode');
    expect(getAgentSlugSuffix('codex')).toBe('codex');
    expect(getAgentSlugSuffix('gemini')).toBe('gemini');
  });

  it('returns default-enabled registry agents, led by Coven CLI', () => {
    expect(getDefaultEnabledAgents()).toEqual(['coven-code', 'claude', 'opencode', 'codex']);
  });

  it('lists Coven CLI first so it leads the new-pane picker', () => {
    expect(getAgentDefinitions()[0]?.id).toBe('coven-code');
  });

  it('builds single-agent options from available agents', () => {
    const options = buildAgentLaunchOptions(['claude', 'codex']);
    expect(options.map((option) => option.id)).toEqual([
      'claude',
      'codex',
    ]);
    expect(options[1]?.agents).toEqual(['codex']);
  });

  it('builds one option per available agent', () => {
    const options = buildAgentLaunchOptions(['claude', 'opencode', 'codex']);
    expect(options.map((option) => option.id)).toEqual([
      'claude',
      'opencode',
      'codex',
    ]);
  });

  it('uses 2-character short labels for all agents', () => {
    const definitions = getAgentDefinitions();
    for (const definition of definitions) {
      expect(getAgentShortLabel(definition.id)).toHaveLength(2);
    }
  });

  it('uses unique short labels for all agents', () => {
    const definitions = getAgentDefinitions();
    const labels = definitions.map((definition) => getAgentShortLabel(definition.id));
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('getPermissionFlags', () => {
  describe('claude', () => {
    it('returns no flags for empty/default mode', () => {
      expect(getPermissionFlags('claude', '')).toBe('');
      expect(getPermissionFlags('claude', undefined)).toBe('');
    });

    it('returns plan mode flags', () => {
      expect(getPermissionFlags('claude', 'plan')).toBe('--permission-mode plan');
    });

    it('returns accept edits flags', () => {
      expect(getPermissionFlags('claude', 'acceptEdits')).toBe('--permission-mode acceptEdits');
    });

    it('returns bypass permissions flags', () => {
      expect(getPermissionFlags('claude', 'bypassPermissions')).toBe('--dangerously-skip-permissions');
    });
  });

  describe('codex', () => {
    it('returns no flags for empty/default mode', () => {
      expect(getPermissionFlags('codex', '')).toBe('');
      expect(getPermissionFlags('codex', undefined)).toBe('');
    });

    it('returns no flags for unsupported plan mode', () => {
      expect(getPermissionFlags('codex', 'plan')).toBe('');
    });

    it('returns accept edits flags without requiring Codex workspace sandboxing', () => {
      expect(getPermissionFlags('codex', 'acceptEdits')).toBe('--ask-for-approval untrusted --sandbox danger-full-access');
    });

    it('returns bypass permissions flags', () => {
      expect(getPermissionFlags('codex', 'bypassPermissions')).toBe('--dangerously-bypass-approvals-and-sandbox');
    });
  });

  describe('opencode', () => {
    it('returns no flags for all modes', () => {
      expect(getPermissionFlags('opencode', '')).toBe('');
      expect(getPermissionFlags('opencode', undefined)).toBe('');
      expect(getPermissionFlags('opencode', 'plan')).toBe('');
      expect(getPermissionFlags('opencode', 'acceptEdits')).toBe('');
      expect(getPermissionFlags('opencode', 'bypassPermissions')).toBe('');
    });
  });

  describe('qwen', () => {
    it('returns plan/accept/bypass permission flags', () => {
      expect(getPermissionFlags('qwen', 'plan')).toBe('--approval-mode plan');
      expect(getPermissionFlags('qwen', 'acceptEdits')).toBe('--approval-mode auto-edit');
      expect(getPermissionFlags('qwen', 'bypassPermissions')).toBe('--approval-mode yolo');
    });
  });

  describe('gemini', () => {
    it('returns plan/accept/bypass permission flags', () => {
      expect(getPermissionFlags('gemini', 'plan')).toBe('--approval-mode plan');
      expect(getPermissionFlags('gemini', 'acceptEdits')).toBe('--approval-mode auto_edit');
      expect(getPermissionFlags('gemini', 'bypassPermissions')).toBe('--approval-mode yolo');
    });
  });
});

describe('command builders', () => {
  it('builds command without an initial prompt', () => {
    expect(buildAgentCommand('claude', 'acceptEdits')).toBe(
      'claude --permission-mode acceptEdits'
    );
  });

  it('ignores prompts and permission modes for coven-code launches', () => {
    expect(buildAgentCommand('coven-code', undefined)).toBe('coven');
    expect(buildAgentCommand('coven-code', 'plan')).toBe('coven');
    expect(buildInitialPromptCommand('coven-code', '"fix it"', undefined)).toBe('coven');
    expect(buildInitialPromptCommand('coven-code', '"fix it"', 'bypassPermissions')).toBe('coven');
    expect(buildResumeCommand('coven-code', 'acceptEdits')).toBeUndefined();
    expect(buildAgentResumeOrLaunchCommand('coven-code', 'plan')).toBe('coven');
  });

  it('builds option-style initial prompt command', () => {
    expect(buildInitialPromptCommand('copilot', '"fix it"', 'acceptEdits')).toBe(
      'copilot --allow-tool write -i "fix it"'
    );
  });

  it('builds stdin-style initial prompt command', () => {
    expect(buildInitialPromptCommand('amp', '"fix it"', 'bypassPermissions')).toBe(
      "printf '%s\\n' \"fix it\" | amp --dangerously-allow-all"
    );
  });

  it('uses send-keys startup mode for crush initial prompts', () => {
    expect(getPromptTransport('crush')).toBe('send-keys');
    expect(buildInitialPromptCommand('crush', '"fix it"', 'bypassPermissions')).toBe(
      'crush --yolo'
    );
    expect(getSendKeysPrePrompt('crush')).toEqual(['Escape', 'Tab']);
    expect(getSendKeysSubmit('crush')).toEqual(['Enter']);
    expect(getSendKeysPostPasteDelayMs('crush')).toBe(200);
    expect(getSendKeysReadyDelayMs('crush')).toBe(1200);
  });

  it('uses send-keys startup mode for cline initial prompts', () => {
    expect(getPromptTransport('cline')).toBe('send-keys');
    expect(buildInitialPromptCommand('cline', '"fix it"', 'acceptEdits')).toBe(
      'cline --act'
    );
    expect(getSendKeysPostPasteDelayMs('cline')).toBe(120);
    expect(getSendKeysReadyDelayMs('cline')).toBe(2500);
  });

  it('uses interactive prompt option for gemini', () => {
    expect(buildInitialPromptCommand('gemini', '"fix it"', 'bypassPermissions')).toBe(
      'gemini --approval-mode yolo --prompt-interactive "fix it"'
    );
  });

  it('builds gemini resume command', () => {
    expect(buildResumeCommand('gemini', 'bypassPermissions')).toBe(
      'gemini --resume latest --approval-mode yolo'
    );
  });

  it('builds codex resume command with per-agent permissions', () => {
    expect(buildResumeCommand('codex', 'bypassPermissions')).toBe(
      'codex resume --last --dangerously-bypass-approvals-and-sandbox'
    );
  });

  it('falls back to launch command when an agent has no resume template', () => {
    expect(buildAgentResumeOrLaunchCommand('opencode', 'bypassPermissions')).toBe(
      'opencode'
    );
  });
});

describe('getPromptTransport per agent', () => {
  const expectedTransports: Record<AgentName, PromptTransport> = {
    'coven-code': 'launch-only',
    claude: 'positional',
    codex: 'positional',
    opencode: 'option',
    gemini: 'option',
    qwen: 'option',
    copilot: 'option',
    amp: 'stdin',
    cline: 'send-keys',
    crush: 'send-keys',
    pi: 'positional',
    cursor: 'positional',
  };

  it.each(AGENT_IDS.map((agent) => [agent, expectedTransports[agent]]))(
    'returns %s transport for %s',
    (agent, expected) => {
      expect(getPromptTransport(agent as AgentName)).toBe(expected);
    },
  );
});

describe('buildInitialPromptCommand per agent and permission mode', () => {
  it('returns the bare coven command for coven-code', () => {
    expect(buildInitialPromptCommand('coven-code', '"fix it"', undefined))
      .toBe('coven');
    expect(buildInitialPromptCommand('coven-code', '"fix it"', 'plan'))
      .toBe('coven');
    expect(buildInitialPromptCommand('coven-code', '"fix it"', 'bypassPermissions'))
      .toBe('coven');
  });

  it('builds positional prompt commands for claude', () => {
    expect(buildInitialPromptCommand('claude', '"fix it"', undefined))
      .toBe('claude "fix it"');
    expect(buildInitialPromptCommand('claude', '"fix it"', 'plan'))
      .toBe('claude --permission-mode plan "fix it"');
    expect(buildInitialPromptCommand('claude', '"fix it"', 'bypassPermissions'))
      .toBe('claude --dangerously-skip-permissions "fix it"');
  });

  it('builds positional prompt commands for codex', () => {
    expect(buildInitialPromptCommand('codex', '"fix it"', undefined))
      .toBe('codex "fix it"');
    expect(buildInitialPromptCommand('codex', '"fix it"', 'bypassPermissions'))
      .toBe('codex --dangerously-bypass-approvals-and-sandbox "fix it"');
  });

  it('builds option-style prompt commands for opencode', () => {
    expect(buildInitialPromptCommand('opencode', '"fix it"', undefined))
      .toBe('opencode --prompt "fix it"');
  });

  it('builds option-style prompt commands for gemini with all permission modes', () => {
    expect(buildInitialPromptCommand('gemini', '"fix it"', undefined))
      .toBe('gemini --prompt-interactive "fix it"');
    expect(buildInitialPromptCommand('gemini', '"fix it"', 'plan'))
      .toBe('gemini --approval-mode plan --prompt-interactive "fix it"');
    expect(buildInitialPromptCommand('gemini', '"fix it"', 'bypassPermissions'))
      .toBe('gemini --approval-mode yolo --prompt-interactive "fix it"');
  });

  it('builds option-style prompt commands for qwen', () => {
    expect(buildInitialPromptCommand('qwen', '"fix it"', undefined))
      .toBe('qwen -i "fix it"');
    expect(buildInitialPromptCommand('qwen', '"fix it"', 'bypassPermissions'))
      .toBe('qwen --approval-mode yolo -i "fix it"');
  });

  it('builds stdin-style prompt commands for amp', () => {
    expect(buildInitialPromptCommand('amp', '"fix it"', undefined))
      .toBe("printf '%s\\n' \"fix it\" | amp");
    expect(buildInitialPromptCommand('amp', '"fix it"', 'bypassPermissions'))
      .toBe("printf '%s\\n' \"fix it\" | amp --dangerously-allow-all");
  });

  it('returns the no-prompt command for send-keys agents (cline)', () => {
    expect(buildInitialPromptCommand('cline', '"fix it"', 'bypassPermissions'))
      .toBe('cline --act --yolo');
  });

  it('returns the no-prompt command for send-keys agents (crush)', () => {
    expect(buildInitialPromptCommand('crush', '"fix it"', undefined))
      .toBe('crush');
    expect(buildInitialPromptCommand('crush', '"fix it"', 'bypassPermissions'))
      .toBe('crush --yolo');
  });

  it('builds positional prompt commands for pi', () => {
    expect(buildInitialPromptCommand('pi', '"fix it"', undefined))
      .toBe('pi "fix it"');
    expect(buildInitialPromptCommand('pi', '"fix it"', 'plan'))
      .toBe('pi --tools read,grep,find,ls "fix it"');
  });

  it('builds positional prompt commands for cursor', () => {
    expect(buildInitialPromptCommand('cursor', '"fix it"', undefined))
      .toBe('cursor-agent "fix it"');
  });

  it('builds option-style prompt commands for copilot', () => {
    expect(buildInitialPromptCommand('copilot', '"fix it"', undefined))
      .toBe('copilot -i "fix it"');
    expect(buildInitialPromptCommand('copilot', '"fix it"', 'bypassPermissions'))
      .toBe('copilot --allow-all -i "fix it"');
  });
});

describe('isAgentName', () => {
  it('accepts all registered agent names', () => {
    for (const agent of AGENT_IDS) {
      expect(isAgentName(agent)).toBe(true);
    }
  });

  it('rejects unknown names', () => {
    expect(isAgentName('unknown-agent')).toBe(false);
    expect(isAgentName('')).toBe(false);
  });
});

describe('AGENT_REGISTRY contract', () => {
  it('launches coven-code through coven with the approved contract', () => {
    const entry = AGENT_REGISTRY['coven-code'];
    expect(entry.name).toBe('Coven CLI');
    expect(entry.description).toContain('Coven CLI');
    expect(entry.installTestCommand).toBe(
      'command -v coven 2>/dev/null || which coven 2>/dev/null'
    );
    expect(entry.commonPaths).toContain('/opt/homebrew/bin/coven');
    expect(entry.commonPaths).not.toContain('/opt/homebrew/bin/coven-code');
    expect(entry.promptCommand).toBe('coven');
    expect(entry.promptTransport).toBe('launch-only');
    expect(entry.resumeCommandTemplate).toBeUndefined();
    expect(entry.permissionFlags).toEqual({});
  });

  it('every agent has a consistent promptCommand and promptTransport', () => {
    for (const agent of AGENT_IDS) {
      const entry = AGENT_REGISTRY[agent];
      expect(entry.promptCommand).toBeTruthy();
      expect(['launch-only', 'positional', 'option', 'stdin', 'send-keys']).toContain(entry.promptTransport);
    }
  });

  it('option-transport agents always declare a promptOption', () => {
    for (const agent of AGENT_IDS) {
      const entry = AGENT_REGISTRY[agent];
      if (entry.promptTransport === 'option') {
        expect(entry.promptOption).toBeTruthy();
      }
    }
  });
});
