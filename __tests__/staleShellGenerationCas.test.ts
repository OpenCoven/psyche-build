import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PsychePane } from '../src/types.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('startup stale shell cleanup', () => {
  it('does not remove a same-ID same-pane replacement from a newer generation', async () => {
    const projectRoot = mkdtempSync(join(process.cwd(), '.psyche-stale-shell-'));
    roots.push(projectRoot);
    mkdirSync(join(projectRoot, '.psyche'), { recursive: true });
    const oldPane: PsychePane = {
      id: 'shell-1',
      slug: 'shell',
      prompt: '',
      paneId: '%7',
      tmuxServerIdentity: {
        pid: 111,
        processStartIdentity: 'old-start',
        socketPath: '/tmux.sock',
        sessionId: '$1',
      },
      type: 'shell',
    };
    const replacement: PsychePane = {
      ...oldPane,
      tmuxServerIdentity: {
        pid: 222,
        processStartIdentity: 'new-start',
        socketPath: '/tmux.sock',
        sessionId: '$2',
      },
    };
    const configPath = join(projectRoot, '.psyche', 'psyche.config.json');
    writeFileSync(configPath, JSON.stringify({
      projectName: 'project',
      projectRoot,
      panes: [replacement],
      settings: {},
    }));
    const module = await import('../src/hooks/usePaneLoading.js');
    const removeStaleShellPaneRecords = (
      module as typeof module & {
        removeStaleShellPaneRecords?: (
          projectRoot: string,
          stalePanes: PsychePane[],
        ) => Promise<unknown>;
      }
    ).removeStaleShellPaneRecords;
    expect(removeStaleShellPaneRecords).toEqual(expect.any(Function));

    await expect(removeStaleShellPaneRecords!(projectRoot, [oldPane]))
      .rejects.toThrow(/identity conflict/);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).panes).toEqual([replacement]);
  });
});
