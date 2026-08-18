import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDaemonControlHandlers } from '../../src/daemon/controlHandlers.js';
import {
  AgenticCapabilityRouter,
  CapabilityRoutingError,
  createCovenNativeCapabilityStrategy,
} from '../../src/orchestration/capabilityRouter.js';
import { TmuxControl } from '../../src/services/tmuxControl.js';
import type { Payload } from '../../src/control/runtime.js';

let tempRoots: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots = [];
});

describe('daemon capability dispatch', () => {
  it('executes session-scoped capabilities through the canonical control handler', async () => {
    const root = await tempDir('psyche-capability-dispatch-');

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

  it('rejects requests for unavailable providers', async () => {
    const root = await tempDir('psyche-capability-provider-unavail-');

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
      provider: 'psyche',
    };

    await expect(handlers.executeCovenCapability(payload)).rejects.toMatchObject({
      code: 'capability_provider_unavailable',
    });
  });

  it('rejects requests for non-live sessions', async () => {
    const root = await tempDir('psyche-capability-nonlive-');

    for (const status of ['created', 'completed', 'failed', 'killed', 'orphaned', 'archived'] as const) {
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
            title: 'Done',
            status,
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

      await expect(handlers.executeCovenCapability(payload)).rejects.toMatchObject({
        code: 'coven_session_not_live',
      });
    }
  });

  it('detects contract violations from the capability provider', async () => {
    const root = await tempDir('psyche-capability-contract-');

    const handlers = createDaemonControlHandlers({
      tmux: new TmuxControl('psyche-test'),
      projectRoot: root,
      sessionName: 'psyche-test',
      capabilityRouter: new AgenticCapabilityRouter({
        strategies: [{
          id: 'coven-native',
          supports: () => true,
          execute: async (request) => ({
            output: {
              ...request.input,
              harness: 'different-harness',
            },
          }),
        }],
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

    await expect(handlers.executeCovenCapability(payload)).rejects.toEqual(
      expect.objectContaining<Partial<CapabilityRoutingError>>({
        code: 'capability_contract_violation',
      }),
    );
  });
});
