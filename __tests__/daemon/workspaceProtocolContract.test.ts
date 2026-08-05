import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { WORKSPACE_SNAPSHOT_FIXTURE } from '../../protocol-fixtures/fixtures.js';
import { serialize } from '../../scripts/generate-protocol-fixtures.js';
import type { ServerResponse } from '../../src/daemon/protocol.js';

describe('workspace snapshot protocol fixture', () => {
  it('is a complete daemon response with worktree and recovery states', () => {
    const response: ServerResponse = WORKSPACE_SNAPSHOT_FIXTURE;
    expect(response.type).toBe('workspace.snapshot.result');
    if (response.type !== 'workspace.snapshot.result') return;
    expect(response.workspace.projects[0].worktrees).toHaveLength(2);
    expect(response.workspace.projects[0].projectPanes[0].recoverability)
      .toBe('missing-worktree');
  });

  it('matches the generated cross-client JSON', () => {
    const fixturePath = path.join(process.cwd(), 'protocol-fixtures/workspace-snapshot.json');
    expect(fs.readFileSync(fixturePath, 'utf8')).toBe(serialize(WORKSPACE_SNAPSHOT_FIXTURE));
  });
});
