import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every managed tmux allocation must record its server generation. Keep this
 * enumerated rather than relying on a broad grep so a new allocator requires
 * an explicit ownership decision during review.
 */
const allocationSites = [
  ['worktree pane creation', 'src/utils/paneCreation.ts', "captureTmuxGeneration(\n    tmuxService,\n    'pane allocation'"],
  // attachAgent.ts no longer allocates tmux panes directly; it delegates
  // to createPane (worktree pane creation above) via the shared-worktree
  // existingWorktree flow.
  // Reopen and conflict flows delegate generation capture and settlement to
  // createTransactionalPane.
  ['reopened worktree pane', 'src/utils/reopenWorktree.ts', "operation: 'reopen-worktree'"],
  ['conflict resolution pane', 'src/utils/conflictResolutionPane.ts', "operation: 'conflict-resolution-pane'"],
  ['startup restoration pane', 'src/hooks/usePaneLoading.ts', 'getServerIdentity?.(newPaneId)'],
  ['detected shell pane', 'src/utils/shellPaneDetection.ts', 'getServerIdentity?.(paneId)'],
  ['background test/dev window', 'src/hooks/usePaneRunner.ts', 'getTmuxServerIdentity: () => tmuxService.getServerIdentity?.()'],
  ['terminal input flow', 'src/hooks/useInputHandling.ts', 'operation: "terminal-pane"'],
  ['desktop-use input flow', 'src/hooks/useInputHandling.ts', 'operation: "desktop-use-pane"'],
  ['browser input flow', 'src/hooks/useInputHandling.ts', 'operation: "file-browser-pane"'],
  ['ritual terminal flow', 'src/PsycheApp.tsx', 'operation: "ritual-terminal-pane"'],
  ['bridge/MCP worktree pane', 'src/daemon/bridge.ts', "operation: 'daemon-new-worktree-pane'"],
  ['Coven open pane', 'src/daemon/bridge.ts', "operation: 'daemon-coven-session-pane'"],
] as const;

describe('tmux allocation ownership contract', () => {
  it.each(allocationSites)(
    '%s captures a generation before it can become a managed record',
    (_name, relativePath, requiredMarker) => {
      const source = readFileSync(path.join(process.cwd(), relativePath), 'utf8');
      expect(source).toContain(requiredMarker);
    },
  );

  it('routes every direct input split through transactional pane creation', () => {
    const input = readFileSync(
      path.join(process.cwd(), 'src/hooks/useInputHandling.ts'),
      'utf8',
    );
    const app = readFileSync(path.join(process.cwd(), 'src/PsycheApp.tsx'), 'utf8');

    expect(input.match(/createTransactionalPane\(/g)).toHaveLength(4);
    expect(app).toContain('createTransactionalPane({');
  });
});
