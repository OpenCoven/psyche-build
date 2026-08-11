import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDaemonControlHandlers } from '../../src/daemon/controlHandlers.js';
import { AgenticCapabilityRouter, createCovenNativeCapabilityStrategy } from '../../src/orchestration/capabilityRouter.js';
import { TmuxControl } from '../../src/services/tmuxControl.js';
import type { Payload } from '../../src/control/runtime.js';

let tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots = [];
});

describe('daemon capability dispatch', () => {
  it('executes session-scoped capabilities through the canonical control handler', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'psyche-capability-dispatch-')));
    tempRoots.push(root);

    const handlers = createDaemonControlHandlers({
      tmux: new TmuxControl('psyche-test'),
      projectRoot: root,
      sessionName: 'psyche-test',
      capabilityRouter: new AgenticCapabilityRouter({
        strategies: [createCovenNativeCapabilityStrategy()],
      }),
      createCovenClient: () => ({
        listSessions: async () => [],
        getSession: async () => ({
          id: 'session-1',
          projectRoot: root,
          harness: 'codex',
          title: 'Plan',
          status: 'running',
          createdAt: '2026-08-01T14:00:00Z',
          updatedAt: '2026-08-01T14:00:01Z',
        }),
      }),
    });

    const payload: Payload<'coven.capability.execute'> = {
      sessionId: 'session-1',
      capability: 'planning',
      prompt: 'Plan the fix',
      taskId: 'task-1',
    };

    const result = await handlers.executeCovenCapability(payload);

    expect(result).toMatchObject({
      sessionId: 'session-1',
      execution: {
        output: {
          harness: 'codex',
          prompt: 'Plan the fix',
        },
        trace: {
          taskId: 'task-1',
          capability: 'planning',
          provider: 'coven-native',
        },
      },
    });
  });
});
