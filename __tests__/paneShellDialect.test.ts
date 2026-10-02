import { describe, expect, it } from 'vitest';
import {
  describePromptBootstrapSkipped,
  paneShellDialectForCommand,
  resolvePaneShell,
} from '../src/utils/paneShellDialect.js';
import { exitRecorderSyntaxForPaneCommand } from '../src/utils/agentLaunchOutcome.js';

const PANE_COMMANDS = [
  'sh', 'bash', 'zsh', 'dash', 'ksh', '-zsh', '/bin/bash', 'ZSH', ' fish ', 'fish', '-fish',
  'nu', 'tcsh', 'csh', 'xonsh', 'elvish', 'pwsh', 'node', 'claude', '', undefined,
];

describe('paneShellDialectForCommand', () => {
  it.each(['sh', 'bash', 'zsh', 'dash', 'ksh', '-zsh', '/bin/bash', 'ZSH'])('reads %j as posix', (command) => {
    expect(paneShellDialectForCommand(command)).toBe('posix');
  });

  it.each(['fish', '-fish', ' fish '])('reads %j as fish', (command) => {
    expect(paneShellDialectForCommand(command)).toBe('fish');
  });

  it.each(['nu', 'tcsh', 'csh', 'xonsh', 'elvish', 'pwsh', 'node', '', undefined])(
    'has no dialect for %j',
    (command) => {
      expect(paneShellDialectForCommand(command)).toBeNull();
    },
  );

  // The exit recorder and the prompt bootstrap must agree on every pane.
  it.each(PANE_COMMANDS.map((command) => [command]))('agrees with the exit recorder for %j', (command) => {
    expect(exitRecorderSyntaxForPaneCommand(command)).toBe(paneShellDialectForCommand(command));
  });
});

describe('resolvePaneShell', () => {
  it('resolves a known shell', async () => {
    await expect(resolvePaneShell(async () => 'zsh')).resolves.toEqual({ dialect: 'posix', paneCommand: 'zsh' });
  });

  it('reports an unrecognized shell', async () => {
    await expect(resolvePaneShell(async () => 'nu')).resolves.toMatchObject({
      dialect: null,
      reason: 'unrecognized_shell',
    });
  });

  it('reports a read error as unreadable without throwing', async () => {
    await expect(resolvePaneShell(async () => {
      throw new Error('tmux busy');
    })).resolves.toMatchObject({ dialect: null, reason: 'unreadable_shell' });
  });

  it('reports a missing reader as unreadable', async () => {
    await expect(resolvePaneShell(undefined)).resolves.toMatchObject({
      dialect: null,
      reason: 'unreadable_shell',
    });
  });
});

describe('describePromptBootstrapSkipped', () => {
  it('is bounded to the agent id and closed reason', () => {
    const message = describePromptBootstrapSkipped('opencode', 'unrecognized_shell');
    expect(message).toContain('opencode');
    expect(message.length).toBeLessThan(300);
    expect(describePromptBootstrapSkipped('x'.repeat(500), 'unreadable_shell').length).toBeLessThan(300);
  });
});
