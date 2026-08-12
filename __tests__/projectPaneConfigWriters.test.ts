import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// These modules receive the shared `<project>/.psyche/psyche.config.json`
// path or derive it from the active project. They must always use
// ProjectPaneConfig's cross-process lease instead of independently replacing
// the whole file.
const SHARED_CONFIG_WRITERS = [
  'src/index.ts',
  'src/hooks/useProjectSettings.ts',
  'src/services/AutoUpdater.ts',
  'src/hooks/usePaneSync.ts',
  'src/hooks/usePanes.ts',
  'src/hooks/usePaneLoading.ts',
  'src/utils/agentSession.ts',
  'src/utils/controlPaneRecovery.ts',
  'src/utils/paneCreation.ts',
  'src/utils/reopenWorktree.ts',
  'src/utils/welcomePaneManager.ts',
  'src/services/WorktreeCleanupService.ts',
  'src/daemon/bridge.ts',
  'src/daemon/index.ts',
] as const;

describe('shared project pane config writer contract', () => {
  it.each(SHARED_CONFIG_WRITERS)(
    '%s does not write the registry directly',
    (relativePath) => {
      const source = readFileSync(path.join(process.cwd(), relativePath), 'utf8');

      expect(source).not.toMatch(/\b(?:\w+\.)?writeFile(?:Sync)?\s*\(/);
      expect(source).not.toMatch(/\batomicWriteJson(?:Sync)?\s*\(/);
    },
  );
});
