import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildRemotePaneActionBindingCommandArgs,
  buildRemotePaneActionBindingCommands,
  buildRemotePaneActionCleanupCommandArgs,
  buildRemotePaneActionCleanupCommands,
  clearRemotePaneActions,
  drainRemotePaneActions,
  enqueueRemotePaneAction,
  getRemotePaneActionQueuePath,
} from '../src/utils/remotePaneActions.js';

let tempHomeDir: string | null = null;

afterEach(async () => {
  if (tempHomeDir) {
    await fs.rm(tempHomeDir, { recursive: true, force: true });
    tempHomeDir = null;
  }
});

async function createTempHomeDir(): Promise<string> {
  tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'psyche-remote-pane-actions-'));
  return tempHomeDir;
}

describe('remotePaneActions', () => {
  it('round-trips queued pane action requests without losing order', async () => {
    const homeDir = await createTempHomeDir();

    await enqueueRemotePaneAction('psyche-test', '%10', 'x', homeDir);
    await enqueueRemotePaneAction('psyche-test', '%11', 'm', homeDir);

    const drained = await drainRemotePaneActions('psyche-test', homeDir);

    expect(drained).toHaveLength(2);
    expect(drained[0]).toMatchObject({
      type: 'pane-shortcut',
      targetPaneId: '%10',
      shortcut: 'x',
    });
    expect(drained[1]).toMatchObject({
      type: 'pane-shortcut',
      targetPaneId: '%11',
      shortcut: 'm',
    });

    expect(await drainRemotePaneActions('psyche-test', homeDir)).toEqual([]);
  });

  it('ignores malformed queue entries while keeping valid actions', async () => {
    const homeDir = await createTempHomeDir();
    const queuePath = getRemotePaneActionQueuePath('psyche-test', homeDir);

    await fs.mkdir(path.dirname(queuePath), { recursive: true });
    await fs.writeFile(
      queuePath,
      [
        JSON.stringify({ type: 'pane-shortcut', targetPaneId: '%20', shortcut: 'h' }),
        'not-json',
        JSON.stringify({ type: 'pane-shortcut', targetPaneId: '%21', shortcut: 'Z' }),
      ].join('\n'),
      'utf-8'
    );

    const drained = await drainRemotePaneActions('psyche-test', homeDir);

    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({
      targetPaneId: '%20',
      shortcut: 'h',
    });
  });

  it('clears the queue file explicitly', async () => {
    const homeDir = await createTempHomeDir();

    await enqueueRemotePaneAction('psyche-test', '%42', 'P', homeDir);
    await clearRemotePaneActions('psyche-test', homeDir);

    expect(await drainRemotePaneActions('psyche-test', homeDir)).toEqual([]);
  });

  it('builds trigger and cleanup commands for focused-pane mouse shortcuts', () => {
    const setupCommands = buildRemotePaneActionBindingCommands();
    const setupCommandArgs = buildRemotePaneActionBindingCommandArgs();
    const cleanupCommands = buildRemotePaneActionCleanupCommands();
    const cleanupCommandArgs = buildRemotePaneActionCleanupCommandArgs();

    expect(setupCommands).toHaveLength(2);
    expect(setupCommands[0]).toContain('bind-key -n M-M');
    expect(setupCommands[0]).toContain('--remote-pane-action m');
    expect(setupCommands[1]).toContain('bind-key -n DoubleClick1Pane');
    expect(setupCommands[1]).toContain('#{||:#{==:#{mouse_y},#{pane_top}},#{==:#{mouse_y},#{-:#{pane_top},1}}}');
    expect(setupCommands[1]).toContain('--remote-pane-action e');
    expect(setupCommandArgs).toHaveLength(2);
    expect(setupCommandArgs[0]).toEqual(expect.arrayContaining(['bind-key', '-n', 'M-M', 'run-shell']));
    expect(setupCommandArgs[0].join(' ')).toContain('--remote-pane-action m');
    expect(setupCommandArgs[1]).toEqual(expect.arrayContaining(['bind-key', '-n', 'DoubleClick1Pane', 'if-shell']));
    expect(setupCommandArgs[1].join(' ')).toContain('--remote-pane-action e');
    expect(cleanupCommands.some((command) => command.includes('unbind-key -n M-M'))).toBe(true);
    expect(cleanupCommands.some((command) => command.includes('unbind-key -n DoubleClick1Pane'))).toBe(true);
    expect(cleanupCommands.some((command) => command.includes('unbind-key -n M-D'))).toBe(true);
    expect(cleanupCommands.some((command) => command.includes('unbind-key -T psyche-pane-action e'))).toBe(true);
    expect(cleanupCommands.some((command) => command.includes('unbind-key -T psyche-pane-action x'))).toBe(true);
    expect(cleanupCommandArgs.some((command) => command.join(' ').includes('unbind-key -n M-M'))).toBe(true);
    expect(cleanupCommandArgs.some((command) => command.join(' ').includes('unbind-key -n DoubleClick1Pane'))).toBe(true);
    expect(cleanupCommandArgs.some((command) => command.join(' ').includes('unbind-key -T psyche-pane-action e'))).toBe(true);
    expect(cleanupCommandArgs.some((command) => command.join(' ').includes('unbind-key -T psyche-pane-action x'))).toBe(true);
  });
});
