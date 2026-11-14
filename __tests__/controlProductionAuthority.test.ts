import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlClient } from '../src/control/client.js';
import {
  createControlCredentialStore,
  issueControlTaskCredential,
} from '../src/control/credentials.js';
import { ControlServer, type ControlServerRuntime } from '../src/control/server.js';

// #504: the documents described an operator granting leases, approving
// actions and the desktop registering as a browser provider. The production
// daemon refuses all three. These cases start the control server the way the
// daemon does, with no operator command policy, and hold that refusal, so the
// documents cannot drift back to describing a path that does not exist and the
// path cannot be opened by a default changing unnoticed.

let cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.map((cleanup) => cleanup().catch(() => undefined)));
  cleanups = [];
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [file] : [];
  });
}

async function startAsProductionDoes(): Promise<{
  projectRoot: string;
  endpoint: string;
  operatorToken: string;
  submit: ReturnType<typeof vi.fn>;
  issueTask(taskId: string): ReturnType<typeof issueControlTaskCredential>;
}> {
  const projectRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'psyche-prod-authority-')));
  const filePath = path.join(projectRoot, 'creds.json');
  const stateRoot = path.join(projectRoot, '.control-state');
  const submit = vi.fn(async () => ({ status: 'succeeded' as const, value: { requestId: 'request-1' } }));
  const runtime: ControlServerRuntime = {
    submit: submit as unknown as ControlServerRuntime['submit'],
    snapshot: () => ({
      ownerEpoch: 3, sequence: 0, commands: {}, leases: {},
      resources: [], capabilityLeases: [], leaseRequests: [], approvals: [], receipts: [],
    }),
    readEvents: () => ({ events: [], nextSequence: 0, gap: false }),
  };
  const credentials = await createControlCredentialStore({ projectRoot, filePath, stateRoot });
  const endpoint = path.join(tmpdir(), `psyche-prod-${randomBytes(6).toString('hex')}.sock`);
  // The same options the daemon passes, less the browser broker: no
  // `operatorCommandPolicy`.
  const server = await ControlServer.start({
    endpoint, projectRoot, ownerEpoch: 3, runtime, credentials,
  });
  cleanups.push(async () => {
    await server.close();
    await rm(projectRoot, { recursive: true, force: true });
  });
  return {
    projectRoot,
    endpoint,
    operatorToken: await credentials.operatorToken(),
    submit: submit as unknown as ReturnType<typeof vi.fn>,
    issueTask: (taskId) => issueControlTaskCredential({ projectRoot, filePath, taskId, stateRoot }),
  };
}

function command(
  projectRoot: string,
  kind: string,
  payload: Record<string, unknown>,
): Parameters<ControlClient['submit']>[0] {
  return {
    id: `${kind}-1`,
    idempotencyKey: `${kind}-1`,
    kind,
    projectRoot,
    createdAt: '2026-11-14T00:00:00.000Z',
    payload,
  } as unknown as Parameters<ControlClient['submit']>[0];
}

const OPERATOR_ONLY_COMMANDS: Array<[string, Record<string, unknown>]> = [
  ['lease.grant', { requestId: 'request-1' }],
  ['lease.revoke', { leaseId: 'lease-1', leaseRevision: 1 }],
  ['approval.resolve', { approvalId: 'approval-1', payloadDigest: 'a'.repeat(64), decision: 'approve' }],
  ['provider.resource.upsert', { resource: { id: 'tab-1', kind: 'browser_tab', generation: 1 } }],
  ['provider.resource.remove', { resourceId: 'tab-1' }],
];

describe('production control authority documents', () => {
  const read = (file: string): string => readFileSync(path.resolve(file), 'utf8');

  it('states the refusals where the agent surface contract is defined', () => {
    const contract = read('docs/AGENT-SURFACE-CONTROL.md');
    const availability = contract.slice(
      contract.indexOf('## Production availability'),
      contract.indexOf('## Owner and project scope'),
    );

    expect(availability).toContain('`operator_authority_unavailable`');
    expect(availability).toContain('`provider_authority_unavailable`');
    expect(availability).toContain('`operator_required`');
    expect(availability).toMatch(/Lease grant, operator revoke, and approve-once are unavailable/);
    expect(availability).toMatch(/Browser provider registration is unavailable/);
    expect(availability).toMatch(/`trusted-test-only`[\s\S]*not a production workaround/);
    // The v0 composition is named so that it is not read as operator authority.
    expect(availability).toMatch(/`orchestration\.execute`[\s\S]*`pane\.create`/);
    expect(contract).toContain('## Approve-once operations (unavailable in production)');
    // The earlier text said this as a fact about a running desktop.
    expect(contract).not.toContain('The desktop registers as an operator-authenticated browser provider.');
  });

  it('marks the leased surface unavailable in the support matrix, README and product spec', () => {
    const leasedRow = read('docs/SUPPORT-MATRIX.md')
      .split('\n')
      .find((line) => line.includes('lease grant, approve-once, browser provider registration'));

    expect(leasedRow).toBeDefined();
    expect(leasedRow).toContain('| **Unavailable** |');
    expect(leasedRow).toContain('`operator_authority_unavailable`');
    expect(leasedRow).toContain('`provider_authority_unavailable`');

    const readme = read('README.md');
    expect(readme).toContain('**Leased operations are unavailable today.**');
    expect(readme).toContain('`operator_authority_unavailable`');
    expect(readme).toContain('AGENT-SURFACE-CONTROL.md#production-availability');

    expect(read('docs/PRODUCT-SPEC.md')).toContain(
      'AGENT-SURFACE-CONTROL.md#production-availability',
    );
  });
});

describe('production control authority', () => {
  it('mounts the control socket without an operator command policy', () => {
    const daemon = readFileSync(path.resolve('src/daemon/index.ts'), 'utf8');
    const mounts = [...daemon.matchAll(/ControlServer\.start\(\{([\s\S]*?)\n\s*\}\);/g)];

    expect(mounts).toHaveLength(1);
    expect(mounts[0][1]).not.toContain('operatorCommandPolicy');

    // The policy and its test-only value are named in the server that defines
    // them and nowhere else in product source, so no other composition root,
    // flag or environment variable can select it.
    const naming = sourceFiles(path.resolve('src'))
      .filter((file) => /operatorCommandPolicy|trusted-test-only/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(path.resolve('.'), file));
    expect(naming).toEqual([path.join('src', 'control', 'server.ts')]);
  });

  it.each(OPERATOR_ONLY_COMMANDS)(
    'refuses an operator %s before it reaches the runtime',
    async (kind, payload) => {
      const production = await startAsProductionDoes();
      const operator = await ControlClient.connect({
        projectRoot: production.projectRoot,
        endpoint: production.endpoint,
        token: production.operatorToken,
        clientName: 'desktop-drawer',
      });
      cleanups.push(() => operator.close());

      await expect(operator.submit(command(production.projectRoot, kind, payload))).resolves.toMatchObject({
        status: 'rejected',
        code: 'operator_authority_unavailable',
      });
      expect(production.submit).not.toHaveBeenCalled();
    },
  );

  it('refuses provider registration from an operator connection', async () => {
    const production = await startAsProductionDoes();
    const socket = connect(production.endpoint);
    cleanups.push(async () => { socket.destroy(); });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.setEncoding('utf8');
    let buffer = '';
    const lines: string[] = [];
    const waiters: Array<(line: string) => void> = [];
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const waiter = waiters.shift();
        if (waiter) waiter(line); else lines.push(line);
      }
    });
    const next = async (): Promise<Record<string, unknown>> => JSON.parse(
      lines.shift() ?? await new Promise<string>((resolve) => waiters.push(resolve)),
    ) as Record<string, unknown>;
    const send = (frame: unknown): void => { socket.write(`${JSON.stringify(frame)}\n`); };

    send({
      version: 1, type: 'hello', requestId: 'hello', token: production.operatorToken,
      clientName: 'desktop', projectRoot: production.projectRoot,
    });
    expect((await next()).type).toBe('welcome');
    send({ version: 1, type: 'provider.register', requestId: 'register', providerId: 'desktop-1' });

    expect(await next()).toMatchObject({
      type: 'error', requestId: 'register', code: 'provider_authority_unavailable',
    });
  });

  it('lets a task-bound agent ask for a lease that nothing in production can grant', async () => {
    const production = await startAsProductionDoes();
    const issued = await production.issueTask('task-1');
    const agent = await ControlClient.connect({
      projectRoot: production.projectRoot,
      endpoint: production.endpoint,
      token: issued.token,
      clientName: 'agent',
      taskBinding: issued.taskBinding,
    });
    cleanups.push(() => agent.close());

    // The request is accepted and stays pending.
    await expect(agent.submit(command(production.projectRoot, 'lease.request', {
      taskId: 'task-1', ttlMs: 60_000, grants: [],
    }))).resolves.toMatchObject({ status: 'succeeded' });
    expect(production.submit.mock.calls.map(([submitted]) => submitted.kind)).toEqual(['lease.request']);

    // The agent cannot grant it or approve an action itself.
    for (const [kind, payload] of OPERATOR_ONLY_COMMANDS) {
      await expect(agent.submit(command(production.projectRoot, kind, payload))).resolves.toMatchObject({
        status: 'rejected',
        code: 'operator_required',
      });
    }
    expect(production.submit).toHaveBeenCalledTimes(1);
  });
});
