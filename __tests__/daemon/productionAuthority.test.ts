import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { ControlClient } from '../../src/control/client.js';
import { createControlCredentialStore, issueControlTaskCredential } from '../../src/control/credentials.js';
import { controlEndpointForProject } from '../../src/control/endpoint.js';

// Exercise runDaemon itself: no reconstructed server options, runtime mock,
// policy override, provider mock, or production-source regular expression.
it('keeps operator and provider authority unavailable in the running production daemon', async ({ onTestFinished }) => {
  const base = process.platform === 'win32' ? tmpdir() : '/tmp';
  const projectRoot = await realpath(await mkdtemp(path.join(base, 'pb504-')));
  const env = { ...process.env, TMUX_TMPDIR: projectRoot };
  const entry = pathToFileURL(path.resolve('src/daemon/index.ts')).href;
  const child = spawn(process.execPath, [
    '--import', 'tsx', '--input-type=module', '--eval',
    `import { runDaemon } from ${JSON.stringify(entry)}; await runDaemon({ projectRoot: process.argv[1], port: 0 });`,
    projectRoot,
  ], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = once(child, 'exit');
  const clients: ControlClient[] = [];
  let provider: ReturnType<typeof connect> | undefined;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    provider?.destroy();
    await Promise.all(clients.map((client) => client.close()));
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 3_000);
      try { await exited; } finally { clearTimeout(killTimer); }
    }
    // TMUX_TMPDIR gives this test a private server. Never address the user's
    // default server or leave the bootstrapped detached shell behind.
    try { execFileSync('tmux', ['kill-server'], { env, stdio: 'ignore' }); } catch { /* already stopped */ }
    await rm(projectRoot, { recursive: true, force: true });
  };
  onTestFinished(cleanup);
  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        let tail = '';
        child.stdout!.on('data', (chunk: Buffer) => {
          tail = (tail + chunk.toString('utf8')).slice(-512);
          if (tail.includes('control socket:')) resolve();
        });
      }),
      exited.then(([code]) => { throw new Error(`production daemon exited before readiness (${String(code)})`); }),
    ]);
    const credentials = await createControlCredentialStore({ projectRoot });
    const operatorToken = await credentials.operatorToken();
    const endpoint = controlEndpointForProject(projectRoot);
    const operator = await ControlClient.connect({ projectRoot, endpoint, token: operatorToken, clientName: 'production-operator-test' });
    clients.push(operator);
    const command = (kind: string, payload: Record<string, unknown>) => ({
      id: `production-${kind}`, idempotencyKey: `production-${kind}`,
      kind, projectRoot, createdAt: new Date().toISOString(), payload,
    }) as Parameters<ControlClient['submit']>[0];
    const refused: Array<[string, Record<string, unknown>]> = [
      ['lease.grant', { requestId: 'request-1' }],
      ['lease.revoke', { leaseId: 'lease-1', leaseRevision: 1 }],
      ['approval.resolve', { approvalId: 'approval-1', payloadDigest: 'a'.repeat(64), decision: 'approve' }],
    ];
    for (const [kind, payload] of refused) {
      await expect(operator.submit(command(kind, payload))).resolves.toMatchObject({
        status: 'rejected', code: 'operator_authority_unavailable',
      });
    }

    provider = connect(endpoint);
    await once(provider, 'connect');
    provider.setEncoding('utf8');
    let buffer = '';
    const lines: string[] = [];
    const waiters: Array<(line: string) => void> = [];
    provider.on('data', (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const waiter = waiters.shift();
        if (waiter) waiter(line); else lines.push(line);
      }
    });
    const next = async () => JSON.parse(lines.shift() ?? await new Promise<string>((resolve) => waiters.push(resolve)));
    provider.write(`${JSON.stringify({ version: 1, type: 'hello', requestId: 'hello', token: operatorToken, projectRoot, clientName: 'production-provider-test' })}\n`);
    expect((await next()).type).toBe('welcome');
    provider.write(`${JSON.stringify({ version: 1, type: 'provider.register', requestId: 'provider', providerId: 'desktop' })}\n`);
    expect(await next()).toMatchObject({ type: 'error', code: 'provider_authority_unavailable' });

    const issued = await issueControlTaskCredential({ projectRoot, taskId: 'task-production' });
    const agent = await ControlClient.connect({ projectRoot, endpoint, token: issued.token, taskBinding: issued.taskBinding, clientName: 'production-agent-test' });
    clients.push(agent);
    await expect(agent.submit(command('lease.request', {
      taskId: 'task-production', ttlMs: 60_000, grants: [],
    }))).resolves.toMatchObject({ status: 'succeeded' });
    expect((await agent.getState()).leaseRequests).toEqual([
      expect.objectContaining({ id: 'production-lease.request', taskId: 'task-production', status: 'pending' }),
    ]);
    expect((await operator.getState()).capabilityLeases).toEqual([]);
    await expect(agent.submit(command('lease.grant', { requestId: 'production-lease.request' })))
      .resolves.toMatchObject({ status: 'rejected', code: 'operator_required' });
  } finally {
    await cleanup();
  }
}, 60_000);
