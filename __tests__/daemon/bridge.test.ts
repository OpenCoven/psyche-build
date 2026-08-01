import { execSync } from 'node:child_process';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCovenAttachCommand,
  buildScopedProject,
  capturePaneText,
  createCovenClient,
  launchProjectCovenSession,
  listProjectCovenSessions,
  openProjectCovenSession,
  listScopedProjects,
  readPaneStatus,
  resolveCovenEndpoint,
  resolveScopedCwd,
  routeProjectCovenSessionCapability,
  spawnBridgePane,
  tailTextLines,
} from '../../src/daemon/bridge.js';
import {
  AgenticCapabilityRouter,
  createCovenNativeCapabilityStrategy,
} from '../../src/orchestration/capabilityRouter.js';

let tempRoots: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  tempRoots.push(root);
  return root;
}

async function writeConfig(root: string, config: unknown): Promise<void> {
  await mkdir(path.join(root, '.comux'), { recursive: true });
  await writeFile(path.join(root, '.comux', 'comux.config.json'), JSON.stringify(config, null, 2));
}

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots = [];
});

describe('daemon bridge project scope helpers', () => {
  it('rejects cwd outside the daemon project root', async () => {
    const root = await tempDir('comux-bridge-root-');
    const outside = await tempDir('comux-bridge-outside-');

    await expect(resolveScopedCwd(root, outside)).rejects.toThrow(/outside the comux project root/);
  });

  it('returns the daemon-scoped project for list and open', async () => {
    const root = await tempDir('comux-bridge-project-');
    await mkdir(path.join(root, 'src'));

    await expect(listScopedProjects(root)).resolves.toEqual([
      {
        id: root,
        root,
        cwd: root,
        title: path.basename(root),
        autonomyProfile: undefined,
      },
    ]);

    await expect(buildScopedProject(root, 'src', { title: 'Demo', autonomyProfile: 'assist' })).resolves.toEqual({
      id: root,
      root,
      cwd: root,
      title: 'Demo',
      autonomyProfile: 'assist',
    });
  });
});

describe('daemon bridge Coven helpers', () => {
  it('only displays Coven sessions inside the current project root', async () => {
    const root = await tempDir('comux-bridge-coven-root-');
    const outside = await tempDir('comux-bridge-coven-outside-');
    await mkdir(path.join(root, 'worktree'));

    const sessions = await listProjectCovenSessions(root, {
      listSessions: async () => [
        {
          id: 'inside-root',
          projectRoot: root,
          harness: 'codex',
          title: 'Inside root',
          status: 'running',
          createdAt: '2026-04-27T10:00:00Z',
          updatedAt: '2026-04-27T10:01:00Z',
        },
        {
          id: 'inside-child',
          projectRoot: path.join(root, 'worktree'),
          harness: 'claude',
          title: 'Inside child',
          status: 'waiting',
          createdAt: '2026-04-27T10:02:00Z',
          updatedAt: '2026-04-27T10:03:00Z',
        },
        {
          id: 'outside',
          projectRoot: outside,
          harness: 'codex',
          title: 'Outside',
          status: 'running',
          createdAt: '2026-04-27T10:04:00Z',
          updatedAt: '2026-04-27T10:05:00Z',
        },
      ],
    });

    expect(sessions.map((session) => session.id)).toEqual(['inside-root', 'inside-child']);
  });

  it('launches a Coven session scoped to the current comux project', async () => {
    const root = await tempDir('comux-bridge-coven-launch-');
    await mkdir(path.join(root, 'app'));
    const launches: unknown[] = [];

    const session = await launchProjectCovenSession(
      root,
      {
        harness: ' codex ',
        prompt: ' build the thing ',
        title: ' Build ',
        cwd: 'app',
      },
      {
        listSessions: async () => [],
        launchSession: async (request) => {
          launches.push(request);
          return {
            id: 'session-1',
            projectRoot: request.projectRoot,
            harness: request.harness,
            title: request.title || request.prompt,
            status: 'running',
            createdAt: '2026-04-27T10:00:00Z',
            updatedAt: '2026-04-27T10:01:00Z',
          };
        },
      },
    );

    expect(launches).toEqual([
      { harness: 'codex', prompt: 'build the thing', title: 'Build', projectRoot: root, cwd: path.join(root, 'app') },
    ]);
    expect(session).toMatchObject({ id: 'session-1', projectRoot: root, harness: 'codex', status: 'running' });
  });

  it('routes a capability only after resolving an authoritative scoped Coven session', async () => {
    const root = await tempDir('comux-bridge-capability-route-');
    await mkdir(path.join(root, 'worktree'));
    const lifecycle: string[] = [];
    const router = new AgenticCapabilityRouter({
      strategies: [
        createCovenNativeCapabilityStrategy(),
        {
          id: 'psyche',
          supports: (capability) => capability === 'planning',
          execute: async (request) => {
            lifecycle.push('psyche.execute');
            expect(request.context).toMatchObject({
              sessionId: 'session-1',
              projectRoot: root,
              cwd: path.join(root, 'worktree'),
            });
            return {
              output: {
                ...request.input,
                prompt: `Planned by Psyche:\n${request.input.prompt}`,
              },
              instrumentation: {
                deltas: [{
                  deltaId: 'plan-1',
                  kind: 'plan',
                  summary: 'Prepared session plan',
                }],
              },
            };
          },
        },
      ],
    });

    const execution = await routeProjectCovenSessionCapability(
      root,
      'session-1',
      {
        prompt: 'Fix tests',
        capability: 'planning',
        provider: 'psyche',
        taskId: 'task-123',
        traceId: 'trace-123',
        idempotencyKey: 'task-123:planning',
        attempt: 1,
      },
      router,
      {
        listSessions: async () => [],
        getSession: async () => {
          lifecycle.push('coven.getSession');
          return {
            id: 'session-1',
            projectRoot: root,
            cwd: path.join(root, 'worktree'),
            harness: 'codex',
            title: 'Fix tests',
            status: 'running',
            createdAt: '2026-08-01T14:00:00Z',
            updatedAt: '2026-08-01T14:00:01Z',
          };
        },
      },
    );

    expect(lifecycle).toEqual(['coven.getSession', 'psyche.execute']);
    expect(execution.output).toMatchObject({
      harness: 'codex',
      prompt: 'Planned by Psyche:\nFix tests',
    });
    expect(execution.trace).toMatchObject({
      taskId: 'task-123',
      traceId: 'trace-123',
      capability: 'planning',
      provider: 'psyche',
      deltas: [{ deltaId: 'plan-1', kind: 'plan' }],
    });
  });

  it('does not execute Psyche for a session outside the project boundary', async () => {
    const root = await tempDir('comux-bridge-capability-root-');
    const outside = await tempDir('comux-bridge-capability-outside-');
    let executed = false;
    const router = new AgenticCapabilityRouter({
      strategies: [{
        id: 'psyche',
        supports: () => true,
        execute: async (request) => {
          executed = true;
          return { output: { ...request.input } };
        },
      }],
    });

    await expect(routeProjectCovenSessionCapability(
      root,
      'session-1',
      {
        prompt: 'Fix tests',
        capability: 'planning',
        provider: 'psyche',
        taskId: 'task-123',
      },
      router,
      {
        listSessions: async () => [],
        getSession: async () => ({
          id: 'session-1',
          projectRoot: outside,
          harness: 'codex',
          title: 'Outside',
          status: 'running',
          createdAt: '2026-08-01T14:00:00Z',
          updatedAt: '2026-08-01T14:00:01Z',
        }),
      },
    )).rejects.toMatchObject({ code: 'coven_session_scope_violation' });

    expect(executed).toBe(false);
  });

  it.each(['created', 'completed', 'failed', 'killed', 'orphaned', 'archived'] as const)(
    'does not execute Psyche for a %s session',
    async (status) => {
      const root = await tempDir(`comux-bridge-capability-${status}-`);
      let executed = false;
      const router = new AgenticCapabilityRouter({
        strategies: [{
          id: 'psyche',
          supports: () => true,
          execute: async (request) => {
            executed = true;
            return { output: { ...request.input } };
          },
        }],
      });

      await expect(routeProjectCovenSessionCapability(
        root,
        'session-1',
        {
          prompt: 'Fix tests',
          capability: 'planning',
          provider: 'psyche',
          taskId: 'task-123',
        },
        router,
        {
          listSessions: async () => [],
          getSession: async () => ({
            id: 'session-1',
            projectRoot: root,
            harness: 'codex',
            title: 'Terminal session',
            status,
            createdAt: '2026-08-01T14:00:00Z',
            updatedAt: '2026-08-01T14:00:01Z',
          }),
        },
      )).rejects.toMatchObject({ code: 'coven_session_not_live' });

      expect(executed).toBe(false);
    },
  );

  it('rejects Coven launch cwd outside the current project before calling Coven', async () => {
    const root = await tempDir('comux-bridge-coven-launch-root-');
    const outside = await tempDir('comux-bridge-coven-launch-outside-');

    await expect(launchProjectCovenSession(
      root,
      {
        harness: 'codex',
        prompt: 'hello',
        cwd: outside,
      },
      {
        listSessions: async () => [],
        launchSession: async () => {
          throw new Error('should not launch outside project scope');
        },
      },
    )).rejects.toThrow(/outside the comux project root/);
  });

  it('opens an in-scope Coven session as a comux shell pane', async () => {
    const root = await tempDir('comux-bridge-coven-open-');
    const commands: string[] = [];

    const result = await openProjectCovenSession(
      root,
      'comux-test',
      'session-1',
      {
        listSessions: async () => [
          {
            id: 'session-1',
            projectRoot: root,
            harness: 'codex',
            title: 'Fix tests',
            status: 'running',
            createdAt: '2026-04-27T10:00:00Z',
            updatedAt: '2026-04-27T10:01:00Z',
          },
        ],
      },
      {
        tmuxSessionExists: () => true,
        createTmuxPane: (_sessionName, cwd, title) => {
          expect(cwd).toBe(root);
          expect(title).toBe('coven:Fix tests');
          return '%42';
        },
        sendTmuxCommand: (paneId, command) => {
          commands.push(`${paneId}:${command}`);
        },
      },
    );

    const config = JSON.parse(await readFile(path.join(root, '.comux', 'comux.config.json'), 'utf8'));
    expect(result.id).toBe('%42');
    expect(result.pane.title).toBe('coven:Fix tests');
    expect(commands).toEqual(['%42:coven attach session-1']);
    expect(config.panes[0]).toMatchObject({
      paneId: '%42',
      shellType: 'coven',
      type: 'shell',
      covenSession: { id: 'session-1', harness: 'codex', status: 'running' },
    });
  });

  it('refuses to open Coven sessions outside the current project scope', async () => {
    const root = await tempDir('comux-bridge-coven-root-');
    const outside = await tempDir('comux-bridge-coven-outside-');

    await expect(openProjectCovenSession(root, 'comux-test', 'outside', {
      listSessions: async () => [
        {
          id: 'outside',
          projectRoot: outside,
          harness: 'codex',
          title: 'Outside',
          status: 'running',
          createdAt: '2026-04-27T10:00:00Z',
          updatedAt: '2026-04-27T10:01:00Z',
        },
      ],
    }, {
      tmuxSessionExists: () => true,
      createTmuxPane: () => { throw new Error('should not create pane'); },
      sendTmuxCommand: () => { throw new Error('should not send command'); },
    })).rejects.toThrow(/not in this comux project scope/);
  });

  it('builds safe Coven attach commands only for safe ids', () => {
    expect(buildCovenAttachCommand('abc-123_def:ghi')).toBe('coven attach abc-123_def:ghi');
    expect(() => buildCovenAttachCommand('abc; rm -rf /')).toThrow(/unsupported characters/);
  });
});

describe('daemon bridge Coven API client', () => {
  it('accepts the current Coven daemon v1 health contract without legacy supported versions', async () => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/v1/health') {
        res.end(JSON.stringify({
          ok: true,
          apiVersion: 'coven.daemon.v1',
          capabilities: {
            sessions: true,
            events: true,
            eventCursor: 'sequence',
            structuredErrors: true,
          },
          daemon: null,
        }));
        return;
      }
      if (req.url === '/api/v1/sessions') {
        res.end(JSON.stringify([]));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { code: 'not_found', message: 'not found' } }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('expected TCP server');
      const client = createCovenClient({ baseUrl: `http://127.0.0.1:${address.port}` });

      await expect(client.listSessions()).resolves.toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('accepts newer daemon API versions when v1 remains supported', async () => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/v1/health') {
        res.end(JSON.stringify({ ok: true, apiVersion: 'v2', supportedApiVersions: ['v2', 'v1'], daemon: null }));
        return;
      }
      if (req.url === '/api/v1/sessions') {
        res.end(JSON.stringify([]));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('expected TCP server');
      const client = createCovenClient({ baseUrl: `http://127.0.0.1:${address.port}` });

      await expect(client.listSessions()).resolves.toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('normalizes missing Coven session status to created', async () => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/v1/health') {
        res.end(JSON.stringify({ ok: true, apiVersion: 'v1', supportedApiVersions: ['v1'], daemon: null }));
        return;
      }
      if (req.url === '/api/v1/sessions') {
        res.end(JSON.stringify([
          {
            id: 'session-1',
            project_root: '/repo',
            harness: 'codex',
            title: 'Missing status',
            created_at: '2026-04-27T10:00:00Z',
            updated_at: '2026-04-27T10:01:00Z',
          },
        ]));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('expected TCP server');
      const client = createCovenClient({ baseUrl: `http://127.0.0.1:${address.port}` });

      await expect(client.listSessions()).resolves.toMatchObject([
        { id: 'session-1', status: 'created' },
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('defaults to the user Coven socket when no endpoint override is configured', async () => {
    const previous = {
      COVEN_HOME: process.env.COVEN_HOME,
      COVEN_PORT: process.env.COVEN_PORT,
      COVEN_SOCKET: process.env.COVEN_SOCKET,
      COVEN_URL: process.env.COVEN_URL,
      HOME: process.env.HOME,
    };
    try {
      delete process.env.COVEN_HOME;
      delete process.env.COVEN_PORT;
      delete process.env.COVEN_SOCKET;
      delete process.env.COVEN_URL;
      const home = await tempDir('comux-coven-home-');
      process.env.HOME = home;

      expect(resolveCovenEndpoint({})).toEqual({ socketPath: path.join(home, '.coven', 'coven.sock') });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key as keyof NodeJS.ProcessEnv];
        } else {
          process.env[key as keyof NodeJS.ProcessEnv] = value;
        }
      }
    }
  });

  it('uses os homedir instead of a relative socket path when HOME is unset', async () => {
    const previous = {
      COVEN_HOME: process.env.COVEN_HOME,
      COVEN_PORT: process.env.COVEN_PORT,
      COVEN_SOCKET: process.env.COVEN_SOCKET,
      COVEN_URL: process.env.COVEN_URL,
      HOME: process.env.HOME,
    };
    try {
      delete process.env.COVEN_HOME;
      delete process.env.COVEN_PORT;
      delete process.env.COVEN_SOCKET;
      delete process.env.COVEN_URL;
      delete process.env.HOME;

      expect(resolveCovenEndpoint({})).toEqual({ socketPath: path.join(homedir(), '.coven', 'coven.sock') });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key as keyof NodeJS.ProcessEnv];
        } else {
          process.env[key as keyof NodeJS.ProcessEnv] = value;
        }
      }
    }
  });

  it('requests Coven events after a sequence cursor when provided', async () => {
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
      requests.push(req.url || '/');
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/v1/health') {
        res.end(JSON.stringify({ ok: true, apiVersion: 'coven.daemon.v1', capabilities: { eventCursor: 'sequence' }, daemon: null }));
        return;
      }
      if (req.url?.startsWith('/api/v1/events?')) {
        res.end(JSON.stringify({ events: [], nextCursor: null, hasMore: false }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('expected TCP server');
      const client = createCovenClient({ baseUrl: `http://127.0.0.1:${address.port}` });

      await expect(client.listEvents?.('session-1', { afterSeq: 42 })).resolves.toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(requests).toContain('/api/v1/events?sessionId=session-1&afterSeq=42');
  });

  it('surfaces structured Coven API errors by code and message', async () => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/v1/health') {
        res.end(JSON.stringify({ ok: true, apiVersion: 'coven.daemon.v1', capabilities: { structuredErrors: true }, daemon: null }));
        return;
      }
      res.statusCode = 409;
      res.end(JSON.stringify({
        error: {
          code: 'session_not_live',
          message: 'Session is not live.',
          details: { sessionId: 'session-1' },
        },
      }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('expected TCP server');
      const client = createCovenClient({ baseUrl: `http://127.0.0.1:${address.port}` });

      await expect(client.getSession?.('session-1')).rejects.toMatchObject({
        code: 'session_not_live',
        message: 'Session is not live.',
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('retries Coven health after a transient failure', async () => {
    let healthRequests = 0;
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/v1/health') {
        healthRequests += 1;
        if (healthRequests === 1) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'starting' }));
          return;
        }
        res.end(JSON.stringify({ ok: true, apiVersion: 'v1', supportedApiVersions: ['v1'], daemon: null }));
        return;
      }
      if (req.url === '/api/v1/sessions') {
        res.end(JSON.stringify([]));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('expected TCP server');
      const client = createCovenClient({ baseUrl: `http://127.0.0.1:${address.port}` });

      await expect(client.listSessions()).rejects.toThrow(/starting/);
      await expect(client.listSessions()).resolves.toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(healthRequests).toBe(2);
  });

  it('uses the versioned localhost API after checking /api/v1/health', async () => {
    const requests: Array<{ method: string; url: string; body: string }> = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        requests.push({ method: req.method || 'GET', url: req.url || '/', body });
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api/v1/health') {
          res.end(JSON.stringify({ ok: true, apiVersion: 'v1', supportedApiVersions: ['v1'], daemon: null }));
          return;
        }
        if (req.url === '/api/v1/sessions') {
          res.end(JSON.stringify([
            {
              id: 'session-1',
              project_root: '/repo',
              harness: 'codex',
              title: 'Desktop use',
              status: 'running',
              created_at: '2026-05-10T08:00:00Z',
              updated_at: '2026-05-10T08:00:01Z',
            },
          ]));
          return;
        }
        if (req.url === '/api/v1/events?sessionId=session-1') {
          res.end(JSON.stringify({
            events: [
              {
                seq: 42,
                id: 'event-1',
                session_id: 'session-1',
                kind: 'output',
                payload_json: '{"data":"hello"}',
                created_at: '2026-05-10T08:00:02Z',
              },
            ],
            nextCursor: { afterSeq: 42 },
            hasMore: false,
          }));
          return;
        }
        if (req.url === '/api/v1/sessions/session-1/input') {
          res.end(JSON.stringify({ ok: true, accepted: true }));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found' }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('expected TCP server');
      const client = createCovenClient({ baseUrl: `http://127.0.0.1:${address.port}` });

      await expect(client.listSessions()).resolves.toMatchObject([{ id: 'session-1', projectRoot: '/repo' }]);
      await expect(client.listEvents?.('session-1')).resolves.toMatchObject([{ seq: 42, id: 'event-1', sessionId: 'session-1' }]);
      await expect(client.sendInput?.('session-1', 'hello')).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'GET /api/v1/health',
      'GET /api/v1/sessions',
      'GET /api/v1/events?sessionId=session-1',
      'POST /api/v1/sessions/session-1/input',
    ]);
    expect(JSON.parse(requests[3].body)).toEqual({ data: 'hello' });
  });
});

describe('daemon bridge pane helpers', () => {
  it('bounds captured pane output to a safe line count', () => {
    expect(tailTextLines('a\nb\nc\nd', 2)).toBe('c\nd');
    const captured = capturePaneText('%1', 9999, () => Buffer.from(Array.from({ length: 2100 }, (_, i) => `l${i}`).join('\n')));
    expect(captured.lines).toBe(2000);
    expect(captured.text.split('\n')).toHaveLength(2000);
    expect(captured.text.startsWith('l100')).toBe(true);
  });

  it('does not probe tmux for panes outside the project config', async () => {
    const root = await tempDir('comux-bridge-status-missing-');
    await writeConfig(root, { panes: [], settings: {} });

    await expect(readPaneStatus(root, '%999', () => {
      throw new Error('unregistered pane should not be probed');
    })).resolves.toEqual({ id: '%999', status: 'unknown' });
  });

  it('reports pane status from comux config metadata', async () => {
    const root = await tempDir('comux-bridge-status-');
    await writeConfig(root, {
      projectName: 'demo',
      projectRoot: root,
      panes: [
        {
          id: 'comux-1',
          paneId: '%7',
          title: 'Fix tests',
          worktreePath: '/repo/.comux/worktrees/fix-tests',
          branchName: 'comux/fix-tests',
          agent: 'codex',
          agentStatus: 'waiting',
          needsAttention: true,
          lastUpdated: '2026-04-27T00:00:00.000Z',
        },
      ],
      settings: {},
      lastUpdated: '2026-04-27T00:00:00.000Z',
    });

    await expect(readPaneStatus(root, '%7', (id) => id === '%7')).resolves.toEqual({
      id: '%7',
      exists: true,
      status: 'waiting',
      pane: {
        id: '%7',
        cwd: '/repo/.comux/worktrees/fix-tests',
        branch: 'comux/fix-tests',
        agent: 'codex',
        title: 'Fix tests',
        lastActivity: '2026-04-27T00:00:00.000Z',
      },
      metadata: {
        comuxId: 'comux-1',
        title: 'Fix tests',
        agent: 'codex',
        branch: 'comux/fix-tests',
        cwd: '/repo/.comux/worktrees/fix-tests',
        needsAttention: true,
        lastActivity: '2026-04-27T00:00:00.000Z',
      },
    });
  });

  it('rejects spawn cwd outside the daemon project root before tmux or git work', async () => {
    const root = await tempDir('comux-bridge-spawn-root-');
    const outside = await tempDir('comux-bridge-spawn-outside-');

    await expect(spawnBridgePane(root, 'comux-demo', {
      requestId: 'req-1',
      cwd: outside,
      title: 'outside',
    }, {
      tmuxSessionExists: () => {
        throw new Error('tmux should not be checked for out-of-scope cwd');
      },
      createTmuxPane: () => {
        throw new Error('tmux pane should not be created');
      },
      sendTmuxCommand: () => {
        throw new Error('agent should not launch');
      },
    })).rejects.toThrow(/outside the comux project root/);
  });

  it('requires an existing comux tmux session before creating a worktree', async () => {
    const root = await tempDir('comux-bridge-missing-session-');
    execSync('git init', { cwd: root, stdio: 'ignore' });

    await expect(spawnBridgePane(root, 'comux-demo', {
      requestId: 'req-2',
      cwd: root,
      title: 'missing session',
    }, {
      tmuxSessionExists: () => false,
      createTmuxPane: () => {
        throw new Error('tmux pane should not be created');
      },
      sendTmuxCommand: () => {
        throw new Error('agent should not launch');
      },
    })).rejects.toMatchObject({ code: 'tmux_session_missing' });
  });

  it('creates a scoped worktree pane and persists metadata through injectable tmux helpers', async () => {
    const root = await tempDir('comux-bridge-spawn-');
    execSync('git init', { cwd: root, stdio: 'ignore' });
    execSync('git config user.email test@example.invalid', { cwd: root, stdio: 'ignore' });
    execSync('git config user.name Test', { cwd: root, stdio: 'ignore' });
    await writeFile(path.join(root, 'README.md'), '# demo\n');
    execSync('git add README.md && git -c commit.gpgsign=false commit -m init', { cwd: root, stdio: 'ignore' });
    await writeConfig(root, {
      projectName: 'demo',
      projectRoot: root,
      panes: [],
      settings: {},
      lastUpdated: '2026-04-27T00:00:00.000Z',
    });

    const commands: string[] = [];
    const result = await spawnBridgePane(root, 'comux-demo', {
      requestId: 'req-3',
      cwd: root,
      title: 'Fix bug',
      agent: 'codex',
      prompt: 'Fix the bug',
    }, {
      tmuxSessionExists: () => true,
      createTmuxPane: (_sessionName, cwd, title) => {
        expect(cwd).toMatch(/\.comux\/worktrees\/fix-bug$/);
        expect(title).toBe('Fix bug');
        return '%42';
      },
      sendTmuxCommand: (_paneId, command) => commands.push(command),
    });

    expect(result).toMatchObject({
      id: '%42',
      branch: 'comux/fix-bug',
      pane: {
        id: '%42',
        cwd: path.join(root, '.comux', 'worktrees', 'fix-bug'),
        branch: 'comux/fix-bug',
        agent: 'codex',
        title: 'Fix bug',
      },
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('COMUX_PROMPT_FILE=');
    expect(commands[0]).toContain('codex');

    const raw = await readFile(path.join(root, '.comux', 'comux.config.json'), 'utf8');
    expect(JSON.parse(raw)).toMatchObject({
      panes: [
        {
          id: expect.stringMatching(/^comux-/),
          paneId: '%42',
          slug: 'fix-bug',
          title: 'Fix bug',
          worktreePath: path.join(root, '.comux', 'worktrees', 'fix-bug'),
          branchName: 'comux/fix-bug',
          agent: 'codex',
        },
      ],
    });
  });
});
