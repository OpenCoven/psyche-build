import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { ControlClient } from '../../src/control/client.js';
import { createControlCredentialStore, issueControlTaskCredential } from '../../src/control/credentials.js';

function fixtureEnvironment(fixtureRoot: string, inherited = process.env): NodeJS.ProcessEnv {
  const home = path.join(fixtureRoot, 'home');
  const scratch = path.join(fixtureRoot, 'tmp');
  // Whitelist process necessities, not ambient user authority or app settings.
  return {
    PATH: inherited.PATH ?? inherited.Path,
    SystemRoot: inherited.SystemRoot ?? inherited.SYSTEMROOT,
    COMSPEC: inherited.COMSPEC ?? inherited.ComSpec,
    LANG: inherited.LANG ?? 'C.UTF-8',
    SHELL: process.platform === 'win32' ? undefined : '/bin/sh',
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_RUNTIME_DIR: path.join(fixtureRoot, 'run'),
    TMUX_TMPDIR: path.join(fixtureRoot, 'tmux'),
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
  };
}

function fixtureAuthorityPaths(projectRoot: string, env: NodeJS.ProcessEnv): {
  endpoint: string;
  stateRoot: string;
  tokenPath: string;
} {
  const moduleUrl = (file: string) => JSON.stringify(pathToFileURL(path.resolve(file)).href);
  return JSON.parse(execFileSync(process.execPath, [
    '--import', 'tsx', '--input-type=module', '--eval',
    `import { controlEndpointForProject } from ${moduleUrl('src/control/endpoint.ts')};
     import { defaultControlStateRoot } from ${moduleUrl('src/control/credentialPaths.ts')};
     import { tokenFilePath } from ${moduleUrl('src/daemon/token.ts')};
     process.stdout.write(JSON.stringify({ endpoint: controlEndpointForProject(process.argv[1]),
       stateRoot: defaultControlStateRoot(), tokenPath: tokenFilePath() }));`,
    projectRoot,
  ], { env, encoding: 'utf8', timeout: 10_000, maxBuffer: 8_192 }));
}

it('does not inherit outer tmux authority into the daemon fixture', async ({ onTestFinished }) => {
  const base = process.platform === 'win32' ? tmpdir() : '/tmp';
  const root = await realpath(await mkdtemp(path.join(base, 'pb504-env-')));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const env = fixtureEnvironment(root, {
    ...process.env,
    TMUX: `${path.join(root, 'foreign.sock')},123,0`,
    TMUX_PANE: '%999',
  });
  const observed = JSON.parse(execFileSync(process.execPath, [
    '-e', 'process.stdout.write(JSON.stringify({ tmux: process.env.TMUX ?? null, pane: process.env.TMUX_PANE ?? null }))',
  ], { env, encoding: 'utf8', timeout: 5_000, maxBuffer: 1_024 }));
  expect(observed).toEqual({ tmux: null, pane: null });
});

it('routes default authority paths into the disposable fixture home', async ({ onTestFinished }) => {
  const base = process.platform === 'win32' ? tmpdir() : '/tmp';
  const root = await realpath(await mkdtemp(path.join(base, 'pb504-env-')));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const foreignHome = path.join(root, 'foreign-home');
  const env = fixtureEnvironment(root, { ...process.env, HOME: foreignHome, USERPROFILE: foreignHome });
  const paths = fixtureAuthorityPaths(path.join(root, 'project'), env);
  for (const value of [paths.stateRoot, paths.tokenPath]) {
    expect(value.startsWith(path.join(root, 'home') + path.sep)).toBe(true);
  }
  if (process.platform !== 'win32') {
    expect(paths.endpoint.startsWith(path.join(root, 'home') + path.sep)).toBe(true);
  }
});

// Exercise runDaemon itself: no reconstructed server options, runtime mock,
// policy override, provider mock, or production-source regular expression.
it('keeps operator and provider authority unavailable in the running production daemon', async ({ onTestFinished }) => {
  const base = process.platform === 'win32' ? tmpdir() : '/tmp';
  const projectRoot = await realpath(await mkdtemp(path.join(base, 'pb504-')));
  const env = fixtureEnvironment(projectRoot);
  let finishFixture = () => rm(projectRoot, { recursive: true, force: true });
  onTestFinished(() => finishFixture());
  await Promise.all(['home', 'tmux', 'tmp', 'run'].map((directory) => (
    mkdir(path.join(projectRoot, directory), { recursive: true, mode: 0o700 })
  )));
  const paths = fixtureAuthorityPaths(projectRoot, env);
  // Fail before daemon startup if future environment changes escape the fixture.
  expect(env.TMUX).toBeUndefined();
  expect(env.TMUX_PANE).toBeUndefined();
  for (const value of [paths.stateRoot, paths.tokenPath]) {
    expect(value.startsWith(env.HOME! + path.sep)).toBe(true);
  }
  if (process.platform !== 'win32') {
    expect(paths.endpoint.startsWith(env.HOME! + path.sep)).toBe(true);
  }
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
    // Address only the owned socket, even if ambient tmux variables regress.
    const tmuxSocket = path.join(env.TMUX_TMPDIR!, `tmux-${process.getuid?.() ?? 0}`, 'default');
    try { execFileSync('tmux', ['-S', tmuxSocket, 'kill-server'], { env, stdio: 'ignore', timeout: 3_000 }); } catch { /* already stopped */ }
    await rm(projectRoot, { recursive: true, force: true });
  };
  finishFixture = cleanup;
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
    const credentials = await createControlCredentialStore({ projectRoot, stateRoot: paths.stateRoot });
    const operatorToken = await credentials.operatorToken();
    const endpoint = paths.endpoint;
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

    const issued = await issueControlTaskCredential({ projectRoot, taskId: 'task-production', stateRoot: paths.stateRoot });
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
