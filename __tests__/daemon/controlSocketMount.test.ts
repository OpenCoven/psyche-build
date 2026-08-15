import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlServer } from '../../src/control/server.js';
import { ControlClient } from '../../src/control/client.js';
import { createControlCredentialStore } from '../../src/control/credentials.js';
import { createHostControlPlane } from '../../src/control/host.js';
import { canonicalizeProjectRoot } from '../../src/control/projectIdentity.js';
import { createDaemonControlHandlers } from '../../src/daemon/controlHandlers.js';
import { AgenticCapabilityRouter } from '../../src/orchestration/capabilityRouter.js';
import { TmuxControl } from '../../src/services/tmuxControl.js';
import type { CovenClient } from '../../src/daemon/bridge.js';
import type { CovenSessionSummary } from '../../src/daemon/protocol.js';

let cleanups: Array<() => Promise<void>> = [];
let tempRoots: string[] = [];

function socketPath(): string {
  return path.join(tmpdir(), `psyche-mount-${randomBytes(6).toString('hex')}.sock`);
}

function inputCommand(kind: string, payload: unknown) {
  const id = randomBytes(4).toString('hex');
  return {
    id,
    idempotencyKey: `idem-${id}`,
    kind,
    projectRoot: '/will-be-overwritten',
    createdAt: new Date().toISOString(),
    payload,
  } as Parameters<ControlClient['submit']>[0];
}

async function startMountedDaemon(): Promise<{
  projectRoot: string;
  endpoint: string;
  operatorToken: string;
  recordedKeys: string[];
  recordedResizes: Array<{ paneId: string; cols: number; rows: number }>;
  recordedFocuses: string[];
  recordedKills: string[];
  launched: Array<{ harness: string; prompt: string }>;
}> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'psyche-mount-proj-'));
  tempRoots.push(projectRoot);
  const canonicalRoot = await canonicalizeProjectRoot(projectRoot);
  await mkdir(path.join(canonicalRoot, '.psyche'), { recursive: true });
  await writeFile(
    path.join(canonicalRoot, '.psyche', 'psyche.config.json'),
    JSON.stringify({ panes: [{ id: 'psyche-1', paneId: '%1' }] }),
  );

  // Recording tmux: capture the effect-boundary calls so a mutation driven
  // through the mounted socket can be asserted to reach real tmux.
  const recordedKeys: string[] = [];
  const recordedResizes: Array<{ paneId: string; cols: number; rows: number }> = [];
  const recordedFocuses: string[] = [];
  const recordedKills: string[] = [];
  const tmux = new TmuxControl('psyche-mount-test');
  vi.spyOn(tmux, 'sendKeysHex').mockImplementation((_paneId: string, data: Buffer) => {
    recordedKeys.push(data.toString('hex'));
  });
  vi.spyOn(tmux, 'resizePane').mockImplementation((paneId: string, cols: unknown, rows: unknown) => {
    recordedResizes.push({ paneId, cols: Number(cols), rows: Number(rows) });
  });
  vi.spyOn(tmux, 'selectPane').mockImplementation((paneId: string) => {
    recordedFocuses.push(paneId);
  });
  vi.spyOn(tmux, 'killPane').mockImplementation((paneId: string) => {
    recordedKills.push(paneId);
  });

  // Stub coven client: launchSession returns a summary scoped INSIDE the
  // project root (the bridge enforces scope via realpath).
  const launched: Array<{ harness: string; prompt: string }> = [];
  const covenClient: CovenClient = {
    listSessions: async () => [],
    launchSession: async (req) => {
      launched.push({ harness: req.harness, prompt: req.prompt });
      const now = new Date().toISOString();
      const summary: CovenSessionSummary = {
        id: 'sess-mounted',
        projectRoot: canonicalRoot,
        harness: req.harness,
        title: req.title ?? 'mounted',
        status: 'starting',
        createdAt: now,
        updatedAt: now,
      };
      return summary;
    },
  };

  const handlers = createDaemonControlHandlers({
    tmux,
    projectRoot: canonicalRoot,
    sessionName: 'psyche-mount-test',
    capabilityRouter: new AgenticCapabilityRouter({ strategies: [] }),
    createCovenClient: () => covenClient,
  });

  const host = await createHostControlPlane(canonicalRoot, { handlers });
  cleanups.push(() => host.close());

  const credentials = await createControlCredentialStore({
    projectRoot: canonicalRoot,
    filePath: path.join(canonicalRoot, 'creds.json'),
  });
  const endpoint = socketPath();
  const server = await ControlServer.start({
    endpoint,
    projectRoot: canonicalRoot,
    ownerEpoch: host.epoch,
    runtime: host.runtime,
    credentials,
    operatorCommandPolicy: 'trusted-test-only',
  });
  cleanups.push(() => server.close());

  return {
    projectRoot: canonicalRoot,
    endpoint,
    operatorToken: await credentials.operatorToken(),
    recordedKeys,
    recordedResizes,
    recordedFocuses,
    recordedKills,
    launched,
  };
}

afterEach(async () => {
  await Promise.all(cleanups.map((fn) => fn().catch(() => undefined)));
  cleanups = [];
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots = [];
  vi.restoreAllMocks();
});

describe('mounted control socket end-to-end', () => {
  it('drives a pane mutation through the mounted socket', async () => {
    const daemon = await startMountedDaemon();
    const client = await ControlClient.connect({
      projectRoot: daemon.projectRoot,
      endpoint: daemon.endpoint,
      token: daemon.operatorToken,
      clientName: 'test-operator',
    });
    cleanups.push(() => client.close());

    const outcome = await client.submit(
      inputCommand('pane.resize', { paneId: '%1', cols: 100, rows: 40 }),
    );

    expect(outcome.status).toBe('succeeded');
    expect(daemon.recordedResizes).toEqual([{ paneId: '%1', cols: 100, rows: 40 }]);
  });

  it('refuses to mutate a pane outside the project registry', async () => {
    const daemon = await startMountedDaemon();
    const client = await ControlClient.connect({
      projectRoot: daemon.projectRoot,
      endpoint: daemon.endpoint,
      token: daemon.operatorToken,
      clientName: 'test-operator',
    });
    cleanups.push(() => client.close());

    const outcome = await client.submit(
      inputCommand('pane.resize', { paneId: '%999', cols: 100, rows: 40 }),
    );

    expect(outcome).toMatchObject({ status: 'failed', code: 'pane_not_found' });
    expect(daemon.recordedResizes).toEqual([]);
  });

  it('sendInput rejects a request without a current pane lease', async () => {
    const daemon = await startMountedDaemon();
    const client = await ControlClient.connect({
      projectRoot: daemon.projectRoot,
      endpoint: daemon.endpoint,
      token: daemon.operatorToken,
      clientName: 'test-operator',
    });
    cleanups.push(() => client.close());

    const outcome = await client.submit(
      inputCommand('pane.input', { paneId: '%999', dataBase64: Buffer.from('x').toString('base64') }),
    );

    expect(outcome).toMatchObject({ status: 'failed', code: 'lease_revision_mismatch' });
    expect(daemon.recordedKeys).toEqual([]);
  });

  it('focusPane rejects an unregistered pane with pane_not_found', async () => {
    const daemon = await startMountedDaemon();
    const client = await ControlClient.connect({
      projectRoot: daemon.projectRoot,
      endpoint: daemon.endpoint,
      token: daemon.operatorToken,
      clientName: 'test-operator',
    });
    cleanups.push(() => client.close());

    const outcome = await client.submit(
      inputCommand('pane.focus', { paneId: '%999' }),
    );

    expect(outcome).toMatchObject({ status: 'failed', code: 'pane_not_found' });
    expect(daemon.recordedFocuses).toEqual([]);
  });

  it('killPane rejects an unregistered pane with pane_not_found', async () => {
    const daemon = await startMountedDaemon();
    const client = await ControlClient.connect({
      projectRoot: daemon.projectRoot,
      endpoint: daemon.endpoint,
      token: daemon.operatorToken,
      clientName: 'test-operator',
    });
    cleanups.push(() => client.close());

    const outcome = await client.submit(
      inputCommand('pane.kill', { paneId: '%999' }),
    );

    expect(outcome).toMatchObject({ status: 'failed', code: 'pane_not_found' });
    expect(daemon.recordedKills).toEqual([]);
  });

  it('drives a coven session launch and returns a typed summary', async () => {
    const daemon = await startMountedDaemon();
    const client = await ControlClient.connect({
      projectRoot: daemon.projectRoot,
      endpoint: daemon.endpoint,
      token: daemon.operatorToken,
      clientName: 'test-operator',
    });
    cleanups.push(() => client.close());

    const outcome = await client.submit(
      inputCommand('coven.session.launch', {
        harness: 'codex',
        prompt: 'do the thing',
        title: 'mounted launch',
      }),
    );

    expect(outcome.status).toBe('succeeded');
    expect(daemon.launched).toEqual([{ harness: 'codex', prompt: 'do the thing' }]);
    if (outcome.status === 'succeeded') {
      const summary = outcome.value as CovenSessionSummary;
      expect(summary.id).toBe('sess-mounted');
      expect(summary.harness).toBe('codex');
    }
  });

  it('refuses a client presenting a bogus token', async () => {
    const daemon = await startMountedDaemon();
    // The rejection must be the server-side auth failure, not a transport error;
    // ControlClient surfaces hello errors as "<code>: <message>".
    await expect(
      ControlClient.connect({
        projectRoot: daemon.projectRoot,
        endpoint: daemon.endpoint,
        token: 'not-the-real-token',
        clientName: 'intruder',
      }),
    ).rejects.toThrow('unauthorized: invalid control token');
  });
});
