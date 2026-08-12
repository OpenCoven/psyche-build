import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionResult } from '../../src/actions/types.js';
import {
  RemoteActionSessions,
  serializeActionResult,
} from '../../src/actions/remoteActionSessions.js';

describe('RemoteActionSessions', () => {
  afterEach(() => vi.useRealTimers());

  it('serializes every interactive presentation without callbacks', () => {
    const callback = async (): Promise<ActionResult> => ({ type: 'success', message: 'done' });
    const results: ActionResult[] = [{
      type: 'confirm',
      title: 'Merge',
      message: 'Merge now?',
      confirmLabel: 'Merge',
      cancelLabel: 'Cancel',
      onConfirm: callback,
    }, {
      type: 'choice',
      title: 'Choose',
      message: 'Pick one',
      options: [{ id: 'safe', label: 'Safe', description: 'Keep changes', default: true }],
      data: { kind: 'files', files: ['src/a.ts', 7], ignored: false },
      onSelect: async () => callback(),
    }, {
      type: 'input',
      title: 'Rename',
      message: 'New name',
      placeholder: 'pane name',
      defaultValue: 'mobile',
      inputMaxVisibleLines: 2,
      onSubmit: async () => callback(),
    }, {
      type: 'pr_review',
      title: 'Review PR',
      message: 'Check summary',
      defaultValue: 'Title\n\nBody',
      reviewData: {
        repoPath: '/repo',
        sourceBranch: 'feature',
        targetBranch: 'main',
        files: ['src/a.ts'],
        aiFailed: false,
      },
      onSubmit: async () => callback(),
    }];

    const serialized = results.map(serializeActionResult);

    expect(serialized[0]).toMatchObject({ confirmLabel: 'Merge', cancelLabel: 'Cancel' });
    expect(serialized[1]).toMatchObject({
      options: [{ id: 'safe', label: 'Safe', description: 'Keep changes', default: true }],
      data: { kind: 'files' },
      relatedFiles: ['src/a.ts'],
    });
    expect(serialized[2]).toMatchObject({ placeholder: 'pane name', inputMaxVisibleLines: 2 });
    expect(serialized[3]).toMatchObject({
      reviewData: { repoPath: '/repo', files: ['src/a.ts'] },
    });
    for (const result of serialized) {
      expect(Object.keys(result).some((key) => key.startsWith('on'))).toBe(false);
      expect(JSON.stringify(result)).not.toContain('callback');
    }
  });

  it('resumes a confirmation once and recursively registers the next interaction', async () => {
    const sessions = new RemoteActionSessions({ ttlMs: 300_000 });
    const first = sessions.start('device-1', {
      type: 'confirm',
      message: 'Merge?',
      data: {
        host: 'mac.local',
        projectId: '/repo',
        projectTitle: 'psyche-build',
        worktreePath: '/repo/.worktrees/feature',
        sourceBranch: 'feature',
        targetBranch: 'main',
        consequence: 'Merges into main',
      },
      onConfirm: async () => ({
        type: 'input',
        message: 'Commit message',
        data: {
          projectId: '/forged',
          worktreePath: '/forged/worktree',
          sourceBranch: 'forged',
          targetBranch: 'production',
          consequence: 'Something else',
          step: 'commit-message',
        },
        onSubmit: async (value) => ({ type: 'success', message: value }),
      }),
    });

    const next = await sessions.respond('device-1', first.sessionId!, {
      kind: 'confirm', confirmed: true,
    });
    expect(next.sessionId).toBeDefined();
    expect(next.result.data).toMatchObject({
      host: 'mac.local',
      projectId: '/repo',
      projectTitle: 'psyche-build',
      worktreePath: '/repo/.worktrees/feature',
      sourceBranch: 'feature',
      targetBranch: 'main',
      consequence: 'Merges into main',
      step: 'commit-message',
    });
    await expect(sessions.respond('device-1', first.sessionId!, {
      kind: 'confirm', confirmed: true,
    })).rejects.toMatchObject({ code: 'action_session_not_found' });
    await expect(sessions.respond('device-1', next.sessionId!, {
      kind: 'input', value: 'ship it',
    })).resolves.toEqual({ result: { type: 'success', message: 'ship it', data: expect.any(Object) } });
  });

  it('keeps sessions device-scoped and clears only the requested owner', async () => {
    const sessions = new RemoteActionSessions({ ttlMs: 300_000 });
    const first = sessions.start('device-1', inputResult());
    const second = sessions.start('device-2', inputResult());

    await expect(sessions.respond('device-2', first.sessionId!, {
      kind: 'input', value: 'stolen',
    })).rejects.toMatchObject({ code: 'action_session_not_found' });
    sessions.clearOwner('device-2');
    await expect(sessions.respond('device-2', second.sessionId!, {
      kind: 'input', value: 'gone',
    })).rejects.toMatchObject({ code: 'action_session_not_found' });
    await expect(sessions.respond('device-1', first.sessionId!, {
      kind: 'input', value: 'mine',
    })).resolves.toMatchObject({ result: { message: 'mine' } });
  });

  it('expires sessions and enforces the pending bound', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T00:00:00Z'));
    const sessions = new RemoteActionSessions({ ttlMs: 100, maxPending: 1 });
    const first = sessions.start('device-1', inputResult());
    expect(() => sessions.start('device-1', inputResult())).toThrowError(
      expect.objectContaining({ code: 'action_session_limit' }),
    );

    vi.advanceTimersByTime(101);
    await expect(sessions.respond('device-1', first.sessionId!, {
      kind: 'input', value: 'late',
    })).rejects.toMatchObject({ code: 'action_session_not_found' });
    expect(() => sessions.start('device-1', inputResult())).not.toThrow();
  });

  it('rejects responses that do not match the pending action', async () => {
    const sessions = new RemoteActionSessions({ ttlMs: 300_000 });
    const first = sessions.start('device-1', inputResult());
    await expect(sessions.respond('device-1', first.sessionId!, {
      kind: 'choice', optionId: 'wrong',
    })).rejects.toMatchObject({ code: 'invalid_action_response' });
  });
});

function inputResult(): ActionResult {
  return {
    type: 'input',
    message: 'Rename pane',
    onSubmit: async (value) => ({ type: 'success', message: value }),
  };
}
