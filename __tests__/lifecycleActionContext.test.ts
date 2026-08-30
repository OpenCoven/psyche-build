import { describe, expect, it } from 'vitest';

import {
  DESTRUCTIVE_LIFECYCLE_ACTION_IDS,
  LIFECYCLE_ACTION_CONTEXT_MAX_AGE_MS,
  LIFECYCLE_ACTION_CONTEXT_VERSION,
  WORKTREE_REQUIRED_ACTION_IDS,
  consequenceSummary,
  isDestructiveLifecycleAction,
  isLifecycleActionContextStale,
  validateActionContext,
  type LifecycleActionContext,
  type LifecycleActionContextProblem,
  type LifecycleActionId,
} from '../src/mobile/lifecycleActionContext.js';

function baseContext(
  overrides: {
    actionId?: LifecycleActionId;
    withWorktree?: boolean;
    consequence?: string;
  } = {},
): LifecycleActionContext {
  const actionId = overrides.actionId ?? 'merge';
  const withWorktree = overrides.withWorktree ?? true;
  const context: LifecycleActionContext = {
    version: LIFECYCLE_ACTION_CONTEXT_VERSION,
    actionId,
    host: { name: 'build-host-1' },
    project: {
      canonicalRoot: '/opt/psyche-build',
      displayName: 'Psyche Build',
    },
    pane: {
      id: 'pane-1',
      tmuxPaneId: '%12',
      tmuxSessionName: 'psyche-build',
      tmuxServer: {
        pid: 4242,
        processStartIdentity: 'boot-1700000000',
        socketPath: '/tmp/tmux-1000/default',
        sessionId: '$2',
      },
      displayName: 'feat-x',
    },
    worktree: withWorktree
      ? {
          path: '/opt/psyche-build/.psyche/worktrees/feat-x',
          branch: 'psyche/feat-x',
        }
      : undefined,
    authority: { kind: 'lease', reference: 'lease-abc-123' },
    consequence:
      overrides.consequence
      ?? 'Merges the worktree branch into main and closes sibling panes on the worktree.',
    capturedAt: '2026-08-30T12:00:00.000Z',
  };
  if (!withWorktree) {
    delete (context as { worktree?: unknown }).worktree;
  }
  return context;
}

function problemCodes(problems: readonly LifecycleActionContextProblem[]): string[] {
  return problems.map((problem) => problem.code);
}

function problemPaths(problems: readonly LifecycleActionContextProblem[]): string[] {
  return problems.map((problem) => problem.path ?? '');
}

describe('validateActionContext acceptance', () => {
  it('accepts a complete merge context with worktree, branch, and authority reference', () => {
    const validation = validateActionContext(baseContext());
    expect(validation.ok).toBe(true);
    if (validation.ok) {
      expect(validation.context.actionId).toBe('merge');
      expect(validation.context.pane.tmuxPaneId).toBe('%12');
      expect(validation.context.worktree?.branch).toBe('psyche/feat-x');
    }
  });

  it('accepts stop and close on a shell pane without a worktree', () => {
    for (const actionId of ['stop', 'close', 'rename', 'files', 'rituals'] as const) {
      const validation = validateActionContext(baseContext({ actionId, withWorktree: false }));
      expect(validation.ok, actionId).toBe(true);
    }
  });
});

describe('validateActionContext strict schema', () => {
  it('rejects non-object inputs fail closed without throwing', () => {
    for (const bad of [null, undefined, 42, 'context', [], true]) {
      const validation = validateActionContext(bad);
      expect(validation.ok, String(typeof bad)).toBe(false);
      if (!validation.ok) {
        expect(problemCodes(validation.problems)).toContain('invalid-context');
      }
    }
  });

  it('rejects a wrong schema version', () => {
    const bad = { ...baseContext(), version: 2 };
    const validation = validateActionContext(bad);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(problemCodes(validation.problems)).toContain('invalid-version');
    }
  });

  it('rejects an unknown action id', () => {
    const bad = { ...baseContext(), actionId: 'rebase' };
    const validation = validateActionContext(bad);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(problemCodes(validation.problems)).toContain('invalid-field');
    }
  });

  it('rejects unknown top-level fields', () => {
    const bad = { ...baseContext(), token: 'not-allowed' };
    const validation = validateActionContext(bad);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(problemCodes(validation.problems)).toContain('unknown-field');
      expect(problemPaths(validation.problems)).toContain('context.token');
    }
  });

  it('rejects unknown nested fields on host, pane, worktree, and authority', () => {
    const bad = {
      ...baseContext(),
      host: { ...baseContext().host, ip: '10.0.0.1' },
      pane: { ...baseContext().pane, cwd: '/opt/psyche-build' },
      worktree: { ...baseContext().worktree, mode: 'recursive' },
      authority: { ...baseContext().authority, scopes: 'write:all' },
    };
    const validation = validateActionContext(bad);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      const paths = problemPaths(validation.problems);
      expect(paths).toContain('host.ip');
      expect(paths).toContain('pane.cwd');
      expect(paths).toContain('worktree.mode');
      expect(paths).toContain('authority.scopes');
    }
  });

  it('rejects an unknown field inside the tmux server identity', () => {
    const base = baseContext();
    const bad = {
      ...base,
      pane: {
        ...base.pane,
        tmuxServer: { ...base.pane.tmuxServer, command: 'tmux -L evil' },
      },
    };
    const validation = validateActionContext(bad);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(problemPaths(validation.problems)).toContain('pane.tmuxServer.command');
    }
  });
});

describe('validateActionContext required identities', () => {
  it('rejects a missing host identity', () => {
    const bad = baseContext() as unknown as Record<string, unknown>;
    delete bad.host;
    const validation = validateActionContext(bad);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(problemCodes(validation.problems)).toContain('missing-field');
    }
  });

  it('rejects a missing canonical project root', () => {
    const bad = baseContext() as unknown as { project: Record<string, unknown> };
    delete bad.project.canonicalRoot;
    const validation = validateActionContext(bad);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(problemPaths(validation.problems)).toContain('project.canonicalRoot');
    }
  });

  it('rejects a relative project root', () => {
    const base = baseContext();
    const bad = { ...base, project: { ...base.project, canonicalRoot: 'psyche-build' } };
    const validation = validateActionContext(bad);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(problemCodes(validation.problems)).toContain('invalid-field');
    }
  });

  it('rejects a missing tmux server generation', () => {
    const bad = baseContext() as unknown as { pane: Record<string, unknown> };
    delete bad.pane.tmuxServer;
    const validation = validateActionContext(bad);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(problemCodes(validation.problems)).toContain('missing-field');
    }
  });

  it('rejects a tmux pane id without the %N form', () => {
    const base = baseContext();
    const bad = { ...base, pane: { ...base.pane, tmuxPaneId: '12' } };
    const validation = validateActionContext(bad);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(problemPaths(validation.problems)).toContain('pane.tmuxPaneId');
    }
  });

  it('rejects a tmux server pid that is not a positive safe integer', () => {
    const base = baseContext();
    const bad = {
      ...base,
      pane: { ...base.pane, tmuxServer: { ...base.pane.tmuxServer, pid: 0 } },
    };
    const validation = validateActionContext(bad);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(problemPaths(validation.problems)).toContain('pane.tmuxServer.pid');
    }
  });

  it('rejects a missing authority reference', () => {
    const bad = baseContext() as unknown as Record<string, unknown>;
    delete bad.authority;
    const validation = validateActionContext(bad);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(problemCodes(validation.problems)).toContain('missing-field');
    }
  });

  it('rejects an unknown authority kind', () => {
    const base = baseContext();
    const bad = { ...base, authority: { kind: 'keyboard', reference: 'lease-abc-123' } };
    const validation = validateActionContext(bad);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(problemPaths(validation.problems)).toContain('authority.kind');
    }
  });

  it('rejects a missing consequence phrase', () => {
    const bad = baseContext() as unknown as Record<string, unknown>;
    delete bad.consequence;
    const validation = validateActionContext(bad);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(problemPaths(validation.problems)).toContain('consequence');
    }
  });

  it('rejects an unparseable capturedAt instant', () => {
    const bad = { ...baseContext(), capturedAt: 'not-a-date' };
    const validation = validateActionContext(bad);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(problemPaths(validation.problems)).toContain('capturedAt');
    }
  });
});

describe('validateActionContext worktree requirement', () => {
  it('requires a worktree identity for merge and create_pr', () => {
    for (const actionId of WORKTREE_REQUIRED_ACTION_IDS) {
      const validation = validateActionContext(baseContext({ actionId, withWorktree: false }));
      expect(validation.ok, actionId).toBe(false);
      if (!validation.ok) {
        expect(problemCodes(validation.problems), actionId).toContain('worktree-required');
      }
    }
  });

  it('accepts a worktree-less stop context while rejecting a merge on the same shape', () => {
    const stop = validateActionContext(baseContext({ actionId: 'stop', withWorktree: false }));
    const merge = validateActionContext(baseContext({ actionId: 'merge', withWorktree: false }));
    expect(stop.ok).toBe(true);
    expect(merge.ok).toBe(false);
  });
});

describe('validateActionContext fail-closed content policy', () => {
  it('rejects a GitHub-token-shaped value in an identity field', () => {
    const base = baseContext();
    const bad = {
      ...base,
      pane: { ...base.pane, tmuxSessionName: `ghp_${'a'.repeat(24)}` },
    };
    const validation = validateActionContext(bad);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(problemCodes(validation.problems)).toContain('unsafe-content');
    }
  });

  it('rejects a JWT-shaped host name', () => {
    const base = baseContext();
    const bad = {
      ...base,
      host: { name: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIx' },
    };
    const validation = validateActionContext(bad);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(problemCodes(validation.problems)).toContain('unsafe-content');
    }
  });

  it('rejects private key material in the consequence phrase', () => {
    const bad = baseContext({
      consequence: 'Wipes key material -----BEGIN RSA PRIVATE KEY----- from disk',
    });
    const validation = validateActionContext(bad);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(problemCodes(validation.problems)).toContain('unsafe-content');
    }
  });

  it('rejects a labeled secret in the consequence phrase', () => {
    const bad = baseContext({ consequence: 'Stores password: hunter2 in the config' });
    const validation = validateActionContext(bad);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(problemCodes(validation.problems)).toContain('unsafe-content');
    }
  });

  it('rejects a raw rm command in the consequence phrase', () => {
    const bad = baseContext({ consequence: 'Runs rm -rf /opt/scratch to clean up' });
    const validation = validateActionContext(bad);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(problemCodes(validation.problems)).toContain('unsafe-content');
    }
  });

  it('rejects tmux kill command literals in the consequence phrase', () => {
    const bad = baseContext({ consequence: 'Executes tmux kill-pane -t %12 when stale' });
    const validation = validateActionContext(bad);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(problemCodes(validation.problems)).toContain('unsafe-content');
    }
  });

  it('rejects shell substitution and chained-command operators', () => {
    const base = baseContext();
    const withSubstitution = {
      ...base,
      authority: { kind: 'host-session' as const, reference: '$(reboot)' },
    };
    const withChain = baseContext({
      consequence: 'Closes the pane && deletes the worktree without choices',
    });
    expect(validateActionContext(withSubstitution).ok).toBe(false);
    expect(validateActionContext(withChain).ok).toBe(false);
  });

  it('rejects shell metacharacters in identity fields', () => {
    const base = baseContext();
    const semicolonSession = {
      ...base,
      pane: { ...base.pane, tmuxSessionName: 'psyche; rm -rf /' },
    };
    const backtickDisplay = {
      ...base,
      pane: { ...base.pane, displayName: '`whoami`' },
    };
    expect(validateActionContext(semicolonSession).ok).toBe(false);
    expect(validateActionContext(backtickDisplay).ok).toBe(false);
  });

  it('rejects path traversal segments in project and worktree paths', () => {
    const base = baseContext();
    const traversalProject = {
      ...base,
      project: { ...base.project, canonicalRoot: '/opt/../etc/psyche-build' },
    };
    const validation = validateActionContext(traversalProject);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(problemPaths(validation.problems)).toContain('project.canonicalRoot');
    }
  });

  it('rejects non-conservative git branch names', () => {
    const base = baseContext();
    for (const branch of ['-rf-flag', 'a..b', 'has space', 'release.lock', 'feature//x']) {
      const bad = {
        ...base,
        worktree: { ...base.worktree, branch },
      };
      const validation = validateActionContext(bad);
      expect(validation.ok, branch).toBe(false);
      if (!validation.ok) {
        expect(problemPaths(validation.problems), branch).toContain('worktree.branch');
      }
    }
  });
});

describe('consequenceSummary', () => {
  it('names host, project, pane, worktree, branch, and consequence in order', () => {
    const summary = consequenceSummary(baseContext());
    expect(summary).not.toBeNull();
    const labels = (summary ?? '')
      .split(' · ')
      .map((segment) => segment.split(':')[0]);
    expect(labels).toEqual([
      'host',
      'project',
      'pane',
      'worktree',
      'branch',
      'consequence',
    ]);
    expect(summary).toContain('host: build-host-1');
    expect(summary).toContain('project: Psyche Build (/opt/psyche-build)');
    expect(summary).toContain('pane: feat-x (%12) [pane-1]');
    expect(summary).toContain('worktree: /opt/psyche-build/.psyche/worktrees/feat-x');
    expect(summary).toContain('branch: psyche/feat-x');
    expect(summary).toContain('consequence: Merges the worktree branch into main');
  });

  it('states none attached for a shell pane without a worktree', () => {
    const summary = consequenceSummary(baseContext({ actionId: 'stop', withWorktree: false }));
    expect(summary).toContain('worktree: none attached');
    expect(summary).toContain('branch: none');
  });

  it('falls back to bare ids when display names are absent', () => {
    const base = baseContext();
    const context: LifecycleActionContext = {
      ...base,
      project: { canonicalRoot: base.project.canonicalRoot },
      pane: {
        id: base.pane.id,
        tmuxPaneId: base.pane.tmuxPaneId,
        tmuxSessionName: base.pane.tmuxSessionName,
        tmuxServer: base.pane.tmuxServer,
      },
    };
    const summary = consequenceSummary(context);
    expect(summary).toContain('project: /opt/psyche-build');
    expect(summary).toContain('pane: %12 [pane-1]');
  });

  it('returns null for an incomplete context instead of a partial summary', () => {
    const incomplete = {
      ...baseContext(),
      consequence: undefined,
    } as unknown as LifecycleActionContext;
    expect(consequenceSummary(incomplete)).toBeNull();
    expect(consequenceSummary(null as unknown as LifecycleActionContext)).toBeNull();
  });
});

describe('destructive action classification', () => {
  it('classifies merge, stop, and close as destructive and the rest as not', () => {
    expect(DESTRUCTIVE_LIFECYCLE_ACTION_IDS).toEqual(['merge', 'stop', 'close']);
    expect(isDestructiveLifecycleAction('merge')).toBe(true);
    expect(isDestructiveLifecycleAction('stop')).toBe(true);
    expect(isDestructiveLifecycleAction('close')).toBe(true);
    expect(isDestructiveLifecycleAction('create_pr')).toBe(false);
    expect(isDestructiveLifecycleAction('rename')).toBe(false);
    expect(isDestructiveLifecycleAction('files')).toBe(false);
    expect(isDestructiveLifecycleAction('rituals')).toBe(false);
  });
});

describe('isLifecycleActionContextStale', () => {
  const NOW = Date.parse('2026-08-30T12:05:00.000Z');

  it('treats a fresh context as not stale', () => {
    const context = {
      ...baseContext(),
      capturedAt: '2026-08-30T12:04:00.000Z',
    };
    expect(isLifecycleActionContextStale(context, NOW)).toBe(false);
  });

  it('treats a context older than the max age as stale', () => {
    const context = {
      ...baseContext(),
      capturedAt: '2026-08-30T11:59:59.000Z',
    };
    expect(isLifecycleActionContextStale(context, NOW)).toBe(true);
    expect(isLifecycleActionContextStale(context, NOW, 1_000)).toBe(true);
  });

  it('treats a future capture instant as stale (clock skew fails closed)', () => {
    const context = {
      ...baseContext(),
      capturedAt: '2026-08-30T12:06:00.000Z',
    };
    expect(isLifecycleActionContextStale(context, NOW)).toBe(true);
  });

  it('treats an unparseable capture instant as stale', () => {
    const context = {
      ...baseContext(),
      capturedAt: 'not-a-date',
    };
    expect(isLifecycleActionContextStale(context, NOW)).toBe(true);
  });

  it('documents the max age alignment with the remote action-session TTL', () => {
    expect(LIFECYCLE_ACTION_CONTEXT_MAX_AGE_MS).toBe(5 * 60_000);
  });
});
