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
    expect(response.workspace.projects[0].worktrees[0].panes[0].lastActivity)
      .toBe('2026-08-03T02:12:00.000Z');
    expect(response.workspace.projects[0].projectPanes[0].recoverability)
      .toBe('missing-worktree');
  });

  it('publishes bounded sanitized ritual metadata the client can decode', () => {
    const response: ServerResponse = WORKSPACE_SNAPSHOT_FIXTURE;
    if (response.type !== 'workspace.snapshot.result') return;
    const { rituals } = response.workspace.projects[0];

    expect(rituals.state).toBe('available');
    expect(rituals.rituals.map((ritual) => [ritual.id, ritual.scope])).toEqual([
      ['review-stack', 'builtIn'],
      ['release-checklist', 'project'],
    ]);

    // The published listing carries identifiers and descriptions only — no
    // launch mechanics, no unrestricted paths, no fixture-only data.
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain('"command"');
    expect(serialized).not.toContain('"prompt"');
    expect(serialized).not.toContain('"projectRoot"');
  });

  it('matches the generated cross-client JSON', () => {
    const fixturePath = path.join(process.cwd(), 'protocol-fixtures/workspace-snapshot.json');
    expect(fs.readFileSync(fixturePath, 'utf8')).toBe(serialize(WORKSPACE_SNAPSHOT_FIXTURE));
  });
});
