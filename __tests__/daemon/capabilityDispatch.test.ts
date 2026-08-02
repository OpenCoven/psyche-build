import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dispatchCovenCapabilityRequest } from '../../src/daemon/index.js';
import { AgenticCapabilityRouter, createCovenNativeCapabilityStrategy } from '../../src/orchestration/capabilityRouter.js';
import type { ClientRequest } from '../../src/daemon/protocol.js';

let tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots = [];
});

describe('daemon capability dispatch', () => {
  it('exposes session-scoped capability execution through the authenticated protocol', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'psyche-capability-dispatch-')));
    tempRoots.push(root);
    const request: Extract<ClientRequest, { type: 'coven.capabilities.execute' }> = {
      type: 'coven.capabilities.execute',
      requestId: 'request-1',
      sessionId: 'session-1',
      capability: {
        taskId: 'task-1',
        capability: 'planning',
        prompt: 'Plan the fix',
      },
    };

    const response = await dispatchCovenCapabilityRequest(
      root,
      request,
      new AgenticCapabilityRouter({
        strategies: [createCovenNativeCapabilityStrategy()],
      }),
      {
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
      },
    );

    expect(response).toMatchObject({
      type: 'coven.capabilities.execute.result',
      requestId: 'request-1',
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
