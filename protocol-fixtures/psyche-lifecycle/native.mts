import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ControlClient } from '../../src/control/client.js';
import { ControlServer } from '../../src/control/server.js';
import { createControlCredentialStore } from '../../src/control/credentials.js';
import { ControlJournal } from '../../src/control/journal.js';
import { createCanonicalElementSemantics } from '../../src/control/policy.js';
import { ControlRuntime } from '../../src/control/runtime.js';
import { SurfaceRegistry } from '../../src/control/surfaces.js';

export const projectRoot = process.cwd();
export const actor = { id: 'fixture-agent', kind: 'psyche' } as const;
export const human = { id: 'fixture-human', kind: 'human' } as const;
export const effects = () => existsSync('effects') ? readFileSync('effects', 'utf8').split('\n').length - 1 : 0;

export async function openNative(epoch: number, uncertain = false, onEffect?: () => void) {
  const journal = await ControlJournal.open(projectRoot, epoch);
  const surfaces = new SurfaceRegistry();
  const tab = surfaces.upsertBrowserTab({
    id: 'fixture-tab', projectRoot, worktreeRoot: projectRoot, providerId: 'fixture',
    webviewLabel: 'fixture', url: 'https://example.test', title: 'Fixture',
    loading: false, viewport: { width: 800, height: 600 },
  });
  // The only effect is appending one independent witness per handler invocation.
  const handlers = {
    async actOnBrowser() {
      onEffect?.();
      appendFileSync('effects', 'submit\n', { mode: 0o600 });
      if (uncertain) throw Object.assign(new Error('lost acknowledgment'), { ambiguous: true });
    },
  };
  const runtime = await ControlRuntime.create({
    ownerEpoch: epoch, handlers: handlers as Parameters<typeof ControlRuntime.create>[0]['handlers'],
    journal, surfaces, resolveBrowserElementSemantics: () => createCanonicalElementSemantics({ role: 'button', submit: true }),
  });
  return { runtime, journal, tab };
}

export function observe({ runtime, journal }: Awaited<ReturnType<typeof openNative>>, taskId: string, actionId: string) {
  const receipt = runtime.receiptForTask(actionId, taskId);
  assert(receipt && receipt.state !== 'approval_required');
  const events = journal.read(0);
  const approvals = events.filter(event => event.kind === 'approval.requested' && event.payload.commandId === actionId && event.payload.taskId === taskId);
  assert.equal(approvals.length, 1);
  const { approvalId, payloadDigest } = approvals[0].payload;
  const terminal = events.filter(event => event.payload.commandId === actionId && event.payload.receipt).at(-1);
  const bytes = JSON.stringify(terminal?.payload.receipt);
  assert(bytes);
  const recorded = JSON.parse(bytes);
  assert.equal(recorded.state, receipt.state);
  assert.equal(recorded.actionId, actionId);
  assert.equal(recorded.taskId, taskId);
  return { task_id: taskId, action_id: actionId, approval_id: approvalId, approval_digest: payloadDigest,
    receipt_hex: Buffer.from(bytes).toString('hex'), state: recorded.state, executions: effects() };
}

/** Two separate authenticated read connections to the native host over fixture-local IPC. */
export async function reconnect(native: Awaited<ReturnType<typeof openNative>>, epoch: number, taskId: string, actionId: string) {
  const credentials = await createControlCredentialStore({
    projectRoot, filePath: path.join(projectRoot, 'fixture-credentials.json'), stateRoot: projectRoot,
  });
  const endpoint = 'fixture-control.sock';
  const server = await ControlServer.start({ endpoint, projectRoot, ownerEpoch: epoch, credentials, runtime: native.runtime });
  try {
    const expected = native.runtime.receiptForTask(actionId, taskId);
    assert(expected);
    for (let connection = 0; connection < 2; connection++) {
      const client = await ControlClient.connect({ endpoint, projectRoot, clientName: 'offline-canary', token: await credentials.operatorToken() });
      try {
        const receipt = await client.actionStatus(actionId, { taskId });
        assert.equal(receipt?.taskId, taskId);
        assert.equal(receipt?.actionId, actionId);
        assert.equal(receipt?.state, expected.state);
      } finally {
        await client.close();
      }
    }
  } finally {
    await server.close();
  }
}
