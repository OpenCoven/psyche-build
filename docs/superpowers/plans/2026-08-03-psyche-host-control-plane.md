# Psyche Host Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish one fenced Psyche host owner that journals and authorizes every terminal mutation, exposes one canonical protocol, prevents duplicate prompt replay, and converts the current daemon, mobile bridge, MCP, and TUI mutation paths into clients.

**Architecture:** Add a transport-independent `src/control/` domain around the implemented orchestration and pane primitives. The `psyche daemon` process acquires the per-project owner lock, owns the command journal and lane leases, and exposes canonical control requests; existing protocols remain compatibility adapters but cannot call tmux, worktree, or Coven mutation functions directly. Program B's durable `SoulTask` and model continuation loop are intentionally excluded.

**Tech Stack:** TypeScript 5.9, Node.js 18 file APIs, WebSocket, newline-delimited JSON, atomic JSON snapshots, tmux control mode, existing orchestration backends, Vitest.

---

## Scope Boundary

This plan implements **Program A** from
`docs/superpowers/specs/2026-08-03-psyche-soul-orchestrator-design.md`.

It does not add the Psyche model loop, durable coding-task completion, LLM
attention summaries, cloud relay, merge automation, or new autonomy profiles.
It creates the trustworthy host boundary those features require.

## File Map

### New control-domain files

- `src/control/types.ts` — canonical command, actor, lease, journal, and result contracts.
- `src/control/protocol.ts` — versioned request/response codec and structural validation.
- `src/control/ownerLock.ts` — exclusive project-owner acquisition and monotonically increasing epochs.
- `src/control/projectIdentity.ts` — filesystem-canonical project identity shared by locks, endpoints, journals, and welcome messages.
- `src/control/journal.ts` — single-writer NDJSON append, replay, idempotency lookup, and snapshots.
- `src/control/leases.ts` — lane automation leases and explicit human takeover.
- `src/control/scope.ts` — canonical path containment and pane/session ownership validation.
- `src/control/promptDispatch.ts` — prompt envelopes and no-replay dispatch outcomes.
- `src/control/runtime.ts` — serialized command execution, policy checks, journal lifecycle, and injected resource handlers.
- `src/control/client.ts` — local authenticated WebSocket client used by MCP and compatibility adapters.
- `src/control/credentials.ts` — scoped operator and agent credentials used to bind server-side principals.
- `src/control/endpoint.ts` — collision-free per-project Unix socket or Windows named-pipe identity.
- `src/control/server.ts` — canonical v1 request/response transport for the host runtime.
- `src/control/host.ts` — composition root for owner lock, journal, runtime, orchestration backends, and daemon protocol handlers.
- `src/control/hostProcess.ts` — health check and detached daemon startup for CLI clients.
- `src/control/resources/panes.ts` — host-only adapter over pane creation, attachment, reopen, conflict, and tmux primitives.
- `src/control/resources/coven.ts` — host-only adapter over Coven launch, open, capability, and desktop mutations.
- `src/control/resources/sessionBootstrap.ts` — host-owned tmux session bootstrap performed only after owner acquisition.

### Existing files modified

- `src/daemon/protocol.ts` — add canonical control request/response envelopes while retaining v0 messages.
- `src/daemon/index.ts` — instantiate the host owner and translate v0 mutations into control commands.
- `src/services/bridge/wireProtocol.ts` — add v2 command acknowledgements and takeover-aware input payloads.
- `src/services/bridge/BridgeDaemon.ts` — forward all mutations to `ControlClient`.
- `src/services/bridge/PaneStreamHub.ts` — keep output streaming but remove direct input authority.
- `src/mcp/server.ts` — call `ControlClient` for task execution, pane creation, prompt delivery, and pane termination; expose neither delegation nor takeover.
- `src/hooks/usePaneCreation.ts` — submit provisioning through the host owner and consume the returned pane records.
- `src/orchestration/controlAdapter.ts` — pure conversion from TUI creation input to canonical control commands.
- `src/index.ts` — ensure the local control daemon exists before enabling mutating TUI or bridge actions.
- `README.md` — document host ownership, takeover, and MCP control tools.
- `docs/PRODUCT-SPEC.md` — distinguish provisioning completion from coding-task completion.

### Tests and fixtures

- `__tests__/controlProtocol.test.ts`
- `__tests__/controlOwnerLock.test.ts`
- `__tests__/controlProjectIdentity.test.ts`
- `__tests__/controlJournal.test.ts`
- `__tests__/controlLeases.test.ts`
- `__tests__/controlScope.test.ts`
- `__tests__/controlPromptDispatch.test.ts`
- `__tests__/controlRuntime.test.ts`
- `__tests__/controlClient.test.ts`
- `__tests__/controlCredentials.test.ts`
- `__tests__/controlHostProcess.test.ts`
- `__tests__/controlMutationBoundaries.test.ts`
- `__tests__/daemon/controlAdapter.test.ts`
- `__tests__/bridge/BridgeDaemon.test.ts`
- `__tests__/bridge/PaneStreamHub.test.ts`
- `__tests__/mcpServer.test.ts`
- `__tests__/orchestrationControlAdapter.test.ts`
- `protocol-fixtures/control-v1/*.json`

### Commit discipline

Each task below ends in one commit. Do not combine tasks. Use the required
Copilot trailer on every commit:

```text
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

## Task 1: Define the Canonical Control Contract

**Files:**
- Create: `src/control/types.ts`
- Create: `src/control/protocol.ts`
- Create: `__tests__/controlProtocol.test.ts`
- Create: `protocol-fixtures/control-v1/command-submit.json`
- Create: `protocol-fixtures/control-v1/command-result.json`

- [ ] **Step 1: Write the failing protocol tests**

Create `__tests__/controlProtocol.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CONTROL_PROTOCOL_VERSION,
  decodeControlRequest,
  encodeControlMessage,
} from '../src/control/protocol.js';

describe('control protocol v1', () => {
  it('decodes the checked-in command fixture', () => {
    const raw = readFileSync(
      new URL('../protocol-fixtures/control-v1/command-submit.json', import.meta.url),
      'utf8',
    );
    expect(decodeControlRequest(raw)).toMatchObject({
      version: CONTROL_PROTOCOL_VERSION,
      type: 'command.submit',
      requestId: 'req-1',
      command: {
        id: 'cmd-1',
        idempotencyKey: 'idem-1',
        kind: 'pane.takeover',
      },
    });

  });

  it('rejects an unsupported protocol version', () => {
    expect(() => decodeControlRequest(JSON.stringify({
      version: 99,
      type: 'state.get',
      requestId: 'req-1',
    }))).toThrow('unsupported control protocol version');
  });

  it('uses stable JSON key ordering', () => {
    expect(encodeControlMessage({
      version: CONTROL_PROTOCOL_VERSION,
      type: 'ack',
      requestId: 'req-1',
    })).toBe('{"requestId":"req-1","type":"ack","version":1}');
  });
});
```

- [ ] **Step 2: Run the test and verify the missing-module failure**

Run:

```bash
pnpm exec vitest --run __tests__/controlProtocol.test.ts
```

Expected: FAIL because `src/control/protocol.ts` does not exist.

- [ ] **Step 3: Add the control types**

Create `src/control/types.ts`:

```ts
import type { OrchestrationTaskRequest } from '../orchestration/types.js';

export type ControlActorKind = 'human' | 'psyche' | 'compatibility';

export interface ControlActor {
  id: string;
  kind: ControlActorKind;
  clientId?: string;
}

export interface CommandBase<K extends string, P> {
  id: string;
  idempotencyKey: string;
  kind: K;
  projectRoot: string;
  actor: ControlActor;
  ownerEpoch: number;
  createdAt: string;
  expiresAt?: string;
  payload: P;
}

export interface PromptEnvelope {
  promptId: string;
  paneId: string;
  taskId?: string;
  harness?: string;
  utf8: string;
  contentHash: string;
  readinessRevision?: string;
  submitMode: 'text' | 'text-and-enter';
  leaseRevision: number;
}

export type ControlCommand =
  | CommandBase<'orchestration.execute', { request: OrchestrationTaskRequest }>
  | CommandBase<'pane.spawn', {
      cwd: string;
      agent?: string;
      title?: string;
      prompt?: string;
      branch?: string;
    }>
  | CommandBase<'pane.prompt', PromptEnvelope>
  | CommandBase<'pane.interrupt', {
      paneId: string;
      key: 'C-c' | 'Escape';
      leaseRevision: number;
    }>
  | CommandBase<'pane.delegate', {
      paneId: string;
      automationActorId: string;
      taskId: string;
      ttlMs: number;
    }>
  | CommandBase<'pane.takeover', { paneId: string }>
  | CommandBase<'pane.input', {
      paneId: string;
      dataBase64: string;
      leaseRevision: number;
    }>
  | CommandBase<'pane.terminal.open', { cwd: string; title?: string }>
  | CommandBase<'pane.resize', { paneId: string; cols: number; rows: number }>
  | CommandBase<'pane.focus', { paneId: string }>
  | CommandBase<'pane.kill', { paneId: string }>
  | CommandBase<'pane.respawn', { paneId: string; cwd: string; command: string }>
  | CommandBase<'pane.conflict.open', {
      sourcePaneId: string;
      targetRepoPath: string;
      targetBranch: string;
      agent?: string;
    }>
  | CommandBase<'pane.option.update', {
      paneId: string;
      option: string;
      value?: string;
    }>
  | CommandBase<'pane.meta.update', { paneId: string; title?: string; agent?: string }>
  | CommandBase<'ritual.launch', {
      projectId: string;
      ritualId: string;
      params: Record<string, string>;
    }>
  | CommandBase<'coven.session.launch', {
      harness: string;
      prompt: string;
      cwd?: string;
      title?: string;
    }>
  | CommandBase<'coven.session.open', { sessionId: string }>
  | CommandBase<'coven.desktop.action', { sessionId: string; action: string }>
  | CommandBase<'coven.capability.execute', {
      sessionId: string;
      capability: string;
      prompt: string;
      provider?: string;
      taskId: string;
      traceId?: string;
      idempotencyKey?: string;
    }>;

export type ControlCommandInput =
  ControlCommand extends infer Command
    ? Command extends ControlCommand
      ? Omit<Command, 'ownerEpoch' | 'actor'>
      : never
    : never;

export type CommandOutcome =
  | { status: 'rejected'; code: string; message: string }
  | { status: 'succeeded'; value?: unknown }
  | { status: 'failed'; code: string; message: string }
  | { status: 'unknown'; code: string; message: string };

export interface CommandRecord {
  command: ControlCommand;
  outcome: CommandOutcome;
  sequence: number;
}

export interface ControlSnapshot {
  ownerEpoch: number;
  sequence: number;
  commands: Record<string, CommandRecord>;
  leases: Record<string, {
    paneId: string;
    actorId: string;
    taskId?: string;
    revision: number;
    expiresAt: string;
  }>;
}
```

- [ ] **Step 4: Add the protocol codec**

Create `src/control/protocol.ts`:

```ts
import type {
  CommandOutcome,
  ControlCommandInput,
  ControlSnapshot,
} from './types.js';

export const CONTROL_PROTOCOL_VERSION = 1;

export type ControlRequest =
  | {
      version: 1;
      type: 'hello';
      requestId: 'hello';
      token: string;
      clientName: string;
      projectRoot: string;
    }
  | {
      version: 1;
      type: 'command.submit';
      requestId: string;
      command: ControlCommandInput;
    }
  | {
      version: 1;
      type: 'state.get';
      requestId: string;
    }
  | {
      version: 1;
      type: 'events.read';
      requestId: string;
      afterSequence: number;
      limit?: number;
    };

export type ControlResponse =
  | {
      version: 1;
      type: 'welcome';
      requestId: 'welcome';
      projectRoot: string;
      ownerEpoch: number;
      principal: {
        id: string;
        kind: 'operator' | 'agent' | 'compatibility';
        capabilities: readonly string[];
      };
    }
  | { version: 1; type: 'ack'; requestId: string }
  | {
      version: 1;
      type: 'command.result';
      requestId: string;
      commandId: string;
      outcome: CommandOutcome;
    }
  | {
      version: 1;
      type: 'state.result';
      requestId: string;
      snapshot: ControlSnapshot;
    }
  | {
      version: 1;
      type: 'events.result';
      requestId: string;
      events: unknown[];
      nextSequence: number;
      gap: boolean;
    }
  | {
      version: 1;
      type: 'error';
      requestId?: string;
      code: string;
      message: string;
    };

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      return Object.fromEntries(
        Object.entries(current as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right)),
      );
    }
    return current;
  });
}

export function encodeControlMessage(message: ControlRequest | ControlResponse): string {
  return stableStringify(message);
}

export function decodeControlRequest(raw: string): ControlRequest {
  const value = JSON.parse(raw) as Partial<ControlRequest>;
  if (value.version !== CONTROL_PROTOCOL_VERSION) {
    throw new Error(`unsupported control protocol version: ${String(value.version)}`);
  }
  if (typeof value.type !== 'string' || typeof value.requestId !== 'string') {
    throw new Error('invalid control request envelope');
  }
  if (value.type === 'command.submit') {
    const command = (value as { command?: Partial<ControlCommandInput> }).command;
    if (!command || typeof command.id !== 'string' || typeof command.kind !== 'string') {
      throw new Error('invalid command.submit payload');
    }
  }
  return value as ControlRequest;
}
```

- [ ] **Step 5: Add the golden fixtures**

Create `protocol-fixtures/control-v1/command-submit.json`:

```json
{
  "version": 1,
  "type": "command.submit",
  "requestId": "req-1",
  "command": {
    "id": "cmd-1",
    "idempotencyKey": "idem-1",
    "kind": "pane.takeover",
    "projectRoot": "/repo",
    "createdAt": "2026-08-03T20:00:00.000Z",
    "payload": {
      "paneId": "%3"
    }
  }
}
```

Create `protocol-fixtures/control-v1/command-result.json`:

```json
{
  "version": 1,
  "type": "command.result",
  "requestId": "req-1",
  "commandId": "cmd-1",
  "outcome": {
    "status": "succeeded"
  }
}
```

- [ ] **Step 6: Run the protocol tests**

Run:

```bash
pnpm exec vitest --run __tests__/controlProtocol.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/control/types.ts src/control/protocol.ts \
  __tests__/controlProtocol.test.ts protocol-fixtures/control-v1
git commit -m "feat: define canonical control protocol" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 2: Fence the Single Host Owner

**Files:**
- Create: `src/control/projectIdentity.ts`
- Create: `src/control/ownerLock.ts`
- Create: `__tests__/controlProjectIdentity.test.ts`
- Create: `__tests__/controlOwnerLock.test.ts`

- [ ] **Step 1: Write failing ownership tests**

Create `__tests__/controlProjectIdentity.test.ts`:

```ts
import { mkdir, mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalizeProjectRoot } from '../src/control/projectIdentity.js';

it('maps a symlink alias to one canonical project root', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'psyche-project-'));
  const real = path.join(parent, 'real');
  const alias = path.join(parent, 'alias');
  await mkdir(real);
  await symlink(real, alias, 'dir');
  expect(await canonicalizeProjectRoot(alias))
    .toBe(await canonicalizeProjectRoot(real));
});
```

Create `__tests__/controlOwnerLock.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireOwnerLock } from '../src/control/ownerLock.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('project owner lock', () => {
  it('rejects a second live owner', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-owner-'));
    roots.push(root);
    const first = await acquireOwnerLock(root, { pid: 101, isProcessAlive: () => true });
    await expect(acquireOwnerLock(root, { pid: 202, isProcessAlive: () => true }))
      .rejects.toThrow('already owned');
    await first.release();
  });

  it('increments the epoch after a dead owner', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-owner-'));
    roots.push(root);
    const first = await acquireOwnerLock(root, { pid: 101, isProcessAlive: () => false });
    const firstEpoch = first.epoch;
    await first.release();
    const second = await acquireOwnerLock(root, { pid: 202, isProcessAlive: () => false });
    expect(second.epoch).toBe(firstEpoch + 1);
    await second.release();
  });

  it('allows only one contender to replace a stale owner', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-owner-'));
    roots.push(root);
    const stale = await acquireOwnerLock(root, { pid: 101, isProcessAlive: () => false });
    const liveContender = (pid: number) => pid === 202 || pid === 303;
    const results = await Promise.allSettled([
      acquireOwnerLock(root, { pid: 202, isProcessAlive: liveContender }),
      acquireOwnerLock(root, { pid: 303, isProcessAlive: liveContender }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'fulfilled') await result.value.release();
    }
    await stale.release().catch(() => {});
  });

  it('recovers a provisional lock whose creator died before epoch finalization', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-owner-'));
    roots.push(root);
    const lockDir = path.join(root, '.psyche', 'runtime', 'owner.lock');
    await mkdir(lockDir, { recursive: true });
    await writeFile(path.join(lockDir, 'owner.json'), JSON.stringify({
      pid: 101,
      nonce: 'provisional',
      epoch: 0,
      acquiredAt: '2026-08-03T20:00:00.000Z',
    }));
    const recovered = await acquireOwnerLock(root, {
      pid: 202,
      isProcessAlive: () => false,
    });
    expect(recovered.epoch).toBeGreaterThan(0);
    await recovered.release();
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
pnpm exec vitest --run __tests__/controlOwnerLock.test.ts
```

Expected: FAIL because `src/control/ownerLock.ts` does not exist.

- [ ] **Step 3: Implement canonical project identity**

Create `src/control/projectIdentity.ts`:

```ts
import { realpath } from 'node:fs/promises';
import path from 'node:path';

export async function canonicalizeProjectRoot(projectRoot: string): Promise<string> {
  const canonical = await realpath(path.resolve(projectRoot));
  return process.platform === 'darwin'
    ? canonical.normalize('NFC')
    : canonical;
}
```

Every caller must canonicalize once before deriving the owner lock, journal
path, endpoint hash, session name, or welcome identity.

- [ ] **Step 4: Implement exclusive acquisition and epochs**

Create `src/control/ownerLock.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface OwnerRecord {
  pid: number;
  nonce: string;
  epoch: number;
  acquiredAt: string;
}

export interface OwnerLock {
  epoch: number;
  nonce: string;
  release: () => Promise<void>;
}

export interface OwnerLockOptions {
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

export async function acquireOwnerLock(
  projectRoot: string,
  options: OwnerLockOptions = {},
): Promise<OwnerLock> {
  const runtimeDir = path.join(projectRoot, '.psyche', 'runtime');
  const lockDir = path.join(runtimeDir, 'owner.lock');
  const recordPath = path.join(lockDir, 'owner.json');
  const epochPath = path.join(runtimeDir, 'owner-epoch.json');
  const pid = options.pid ?? process.pid;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  await mkdir(runtimeDir, { recursive: true });
  const nonce = randomUUID();

  while (true) {
    const candidateDir = path.join(runtimeDir, `owner.candidate.${nonce}`);
    await mkdir(candidateDir, { recursive: true });
    await writeFile(path.join(candidateDir, 'owner.json'), JSON.stringify({
      pid,
      nonce,
      epoch: 0,
      acquiredAt: new Date().toISOString(),
    }));
    try {
      await rename(candidateDir, lockDir);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
      await rm(candidateDir, { recursive: true });
      const previous = JSON.parse(await readFile(recordPath, 'utf8')) as OwnerRecord;
      if (isProcessAlive(previous.pid)) {
        throw new Error(`psyche control plane already owned by pid ${previous.pid}`);
      }
      const quarantine = path.join(runtimeDir, `owner.stale.${randomUUID()}`);
      try {
        await rename(lockDir, quarantine);
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw renameError;
      }
      await rm(quarantine, { recursive: true });
      await sleep(10);
    }
  }

  const epoch = await nextEpoch(epochPath);
  const record: OwnerRecord = {
    pid,
    nonce,
    epoch,
    acquiredAt: new Date().toISOString(),
  };
  const recordTemp = path.join(lockDir, `owner.${nonce}.tmp`);
  const handle = await open(recordTemp, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(recordTemp, recordPath);

  return {
    epoch,
    nonce,
    release: async () => {
      const current = JSON.parse(await readFile(recordPath, 'utf8')) as OwnerRecord;
      if (current.nonce === nonce) await rm(lockDir, { recursive: true });
    },
  };
}

async function nextEpoch(epochPath: string): Promise<number> {
  let epoch = 0;
  try {
    epoch = (JSON.parse(await readFile(epochPath, 'utf8')) as { epoch: number }).epoch;
  } catch {
    epoch = 0;
  }
  const next = epoch + 1;
  const temporary = `${epochPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ epoch: next })}\n`, 'utf8');
  await rename(temporary, epochPath);
  return next;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run the ownership tests**

Run:

```bash
pnpm exec vitest --run \
  __tests__/controlProjectIdentity.test.ts \
  __tests__/controlOwnerLock.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/control/projectIdentity.ts src/control/ownerLock.ts \
  __tests__/controlProjectIdentity.test.ts __tests__/controlOwnerLock.test.ts
git commit -m "feat: fence the Psyche host owner" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 3: Add the Durable Command Journal

**Files:**
- Create: `src/control/journal.ts`
- Create: `__tests__/controlJournal.test.ts`

- [ ] **Step 1: Write failing journal tests**

Create `__tests__/controlJournal.test.ts` with cases for ordered append,
idempotency lookup, incomplete-final-line recovery, and mid-file corruption:

```ts
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ControlJournal } from '../src/control/journal.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ControlJournal', () => {
  it('assigns monotonic sequences and restores idempotency records', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-journal-'));
    roots.push(root);
    const journal = await ControlJournal.open(root, 3);
    await journal.append('command.requested', { commandId: 'c1', idempotencyKey: 'i1' });
    await journal.append('command.succeeded', { commandId: 'c1', idempotencyKey: 'i1' });
    const reopened = await ControlJournal.open(root, 3);
    expect(reopened.sequence).toBe(2);
    expect(reopened.findByIdempotencyKey('i1')?.kind).toBe('command.succeeded');
  });

  it('truncates only an incomplete final line', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-journal-'));
    roots.push(root);
    const journal = await ControlJournal.open(root, 1);
    await journal.append('command.requested', { commandId: 'c1' });
    await appendFile(journal.path, '{"sequence":2');
    const reopened = await ControlJournal.open(root, 1);
    expect(reopened.sequence).toBe(1);
    expect(await readFile(reopened.path, 'utf8')).toMatch(/\n$/);
  });

  it('rejects corruption before the final line', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-journal-'));
    roots.push(root);
    const runtime = path.join(root, '.psyche', 'runtime');
    await mkdir(runtime, { recursive: true });
    await writeFile(path.join(runtime, 'events.ndjson'), '{"sequence":1}\nnot-json\n');
    await expect(ControlJournal.open(root, 1)).rejects.toThrow('journal corruption');
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
pnpm exec vitest --run __tests__/controlJournal.test.ts
```

Expected: FAIL because `src/control/journal.ts` does not exist.

- [ ] **Step 3: Implement append, replay, and snapshot primitives**

Create `src/control/journal.ts` with these public contracts:

```ts
export interface ControlEvent {
  sequence: number;
  id: string;
  ownerEpoch: number;
  timestamp: string;
  kind: string;
  payload: Record<string, unknown>;
}

export class ControlJournal {
  static open(projectRoot: string, ownerEpoch: number): Promise<ControlJournal>;
  readonly path: string;
  readonly sequence: number;
  append(kind: string, payload: Record<string, unknown>): Promise<ControlEvent>;
  read(afterSequence: number, limit?: number): ControlEvent[];
  findByIdempotencyKey(key: string): ControlEvent | undefined;
  loadSnapshot(): Promise<(ControlSnapshot & { coveredSequence: number }) | undefined>;
  writeSnapshot(snapshot: ControlSnapshot, coveredSequence: number): Promise<void>;
  recoverNonterminalCommands(): Promise<ControlEvent[]>;
}
```

Implement `open()` so it:

1. creates `.psyche/runtime/`;
2. parses complete lines in `events.ndjson`;
3. verifies contiguous sequences and owner epochs;
4. truncates one incomplete final line;
5. throws `journal corruption at line N` for any earlier malformed line;
6. rebuilds an in-memory idempotency index from terminal command events.

Implement `append()` behind one global promise tail so concurrent pane queues
cannot reorder sequence assignment or file writes:

```ts
private appendTail: Promise<void> = Promise.resolve();

append(kind: string, payload: Record<string, unknown>): Promise<ControlEvent> {
  let resolveEvent!: (event: ControlEvent) => void;
  let rejectEvent!: (error: unknown) => void;
  const result = new Promise<ControlEvent>((resolve, reject) => {
    resolveEvent = resolve;
    rejectEvent = reject;
  });
  this.appendTail = this.appendTail.then(async () => {
    const event = this.buildNextEvent(kind, payload);
    const handle = await open(this.path, 'a');
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.publish(event);
    resolveEvent(event);
  }).catch((error) => {
    rejectEvent(error);
  });
  return result;
}
```

Implement `writeSnapshot()` by writing
`snapshot.json.<pid>.tmp`, syncing it, and atomically renaming it to
`snapshot.json`. Store `coveredSequence` in the snapshot and replay only later
events. `recoverNonterminalCommands()` must append `command.unknown` for every
restored `requested`, `accepted`, or `running` mutation that has no terminal
event, and flush those recovery events before the runtime accepts new commands.

- [ ] **Step 4: Run the journal tests**

Run:

```bash
pnpm exec vitest --run __tests__/controlJournal.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/control/journal.ts __tests__/controlJournal.test.ts
git commit -m "feat: add the control command journal" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 4: Add Lane Leases and Explicit Takeover

**Files:**
- Create: `src/control/leases.ts`
- Create: `src/control/scope.ts`
- Create: `__tests__/controlLeases.test.ts`
- Create: `__tests__/controlScope.test.ts`

- [ ] **Step 1: Write failing lease tests**

Create `__tests__/controlLeases.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { LaneLeaseStore } from '../src/control/leases.js';

describe('LaneLeaseStore', () => {
  it('increments revisions and rejects stale automation', () => {
    const leases = new LaneLeaseStore(() => new Date('2026-08-03T20:00:00Z'));
    const lease = leases.delegate('%3', 'psyche-1', 'task-1', 60_000);
    leases.takeover('%3', 'human-1');
    expect(() => leases.assertAutomation('%3', 'psyche-1', lease.revision))
      .toThrow('lease revision mismatch');
  });

  it('allows protocol-observed human input after takeover', () => {
    const leases = new LaneLeaseStore(() => new Date('2026-08-03T20:00:00Z'));
    leases.delegate('%3', 'psyche-1', 'task-1', 60_000);
    const takeover = leases.takeover('%3', 'human-1');
    expect(leases.assertHuman('%3', 'human-1', takeover.revision).actorId)
      .toBe('human-1');
  });
});
```

Create `__tests__/controlScope.test.ts`:

```ts
import { mkdir, mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ControlScope } from '../src/control/scope.js';

it('rejects cross-project and symlink-escape paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'psyche-scope-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'psyche-outside-'));
  await mkdir(path.join(root, 'worktree'));
  await symlink(outside, path.join(root, 'escape'), 'dir');
  const scope = await ControlScope.create(root, {
    panes: [{ paneId: '%3', cwd: path.join(root, 'worktree') }],
  });
  await expect(scope.requireContainedPath(path.join(root, 'escape')))
    .rejects.toThrow('outside the canonical project');
  await expect(scope.requireContainedPath(outside))
    .rejects.toThrow('outside the canonical project');
  expect(scope.requireOwnedPane('%3').paneId).toBe('%3');
  expect(() => scope.requireOwnedPane('%99')).toThrow('pane is not owned');
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
pnpm exec vitest --run \
  __tests__/controlLeases.test.ts \
  __tests__/controlScope.test.ts
```

Expected: FAIL because `src/control/leases.ts` and `src/control/scope.ts` do not
exist.

- [ ] **Step 3: Implement the lease store**

Create `src/control/leases.ts`:

```ts
export interface LaneLease {
  paneId: string;
  actorId: string;
  actorKind: 'human' | 'psyche';
  taskId?: string;
  revision: number;
  expiresAt: string;
}

export class LaneLeaseStore {
  private readonly leases = new Map<string, LaneLease>();
  private readonly revisions = new Map<string, number>();

  constructor(private readonly clock: () => Date = () => new Date()) {}

  delegate(paneId: string, actorId: string, taskId: string, ttlMs: number): LaneLease {
    return this.replace(paneId, actorId, 'psyche', ttlMs, taskId);
  }

  takeover(paneId: string, actorId: string): LaneLease {
    return this.replace(paneId, actorId, 'human', 24 * 60 * 60 * 1000);
  }

  assertAutomation(paneId: string, actorId: string, revision: number): LaneLease {
    return this.assert(paneId, actorId, 'psyche', revision);
  }

  assertHuman(paneId: string, actorId: string, revision: number): LaneLease {
    return this.assert(paneId, actorId, 'human', revision);
  }

  snapshot(): Record<string, LaneLease> {
    return Object.fromEntries(this.leases);
  }

  private replace(
    paneId: string,
    actorId: string,
    actorKind: LaneLease['actorKind'],
    ttlMs: number,
    taskId?: string,
  ): LaneLease {
    const revision = (this.revisions.get(paneId) ?? 0) + 1;
    this.revisions.set(paneId, revision);
    const lease: LaneLease = {
      paneId,
      actorId,
      actorKind,
      revision,
      expiresAt: new Date(this.clock().getTime() + ttlMs).toISOString(),
      ...(taskId ? { taskId } : {}),
    };
    this.leases.set(paneId, lease);
    return lease;
  }

  private assert(
    paneId: string,
    actorId: string,
    actorKind: LaneLease['actorKind'],
    revision: number,
  ): LaneLease {
    const lease = this.leases.get(paneId);
    if (!lease || lease.revision !== revision) throw new Error('lease revision mismatch');
    if (lease.actorId !== actorId || lease.actorKind !== actorKind) {
      throw new Error('lane is controlled by another actor');
    }
    if (Date.parse(lease.expiresAt) <= this.clock().getTime()) throw new Error('lease expired');
    return lease;
  }
}
```

Create `src/control/scope.ts`. `ControlScope.create()` receives the canonical
project root plus current registered pane, worktree, and Coven-session
identities. It must:

- resolve every path with `realpath`;
- accept only the project root or a registered worktree contained by it;
- reject `..`, absolute cross-project paths, and symlink escapes;
- require pane and session ids to be registered to the canonical project;
- validate every command payload path before lease or side-effect handling.

- [ ] **Step 4: Run the lease tests**

Run:

```bash
pnpm exec vitest --run \
  __tests__/controlLeases.test.ts \
  __tests__/controlScope.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/control/leases.ts src/control/scope.ts \
  __tests__/controlLeases.test.ts __tests__/controlScope.test.ts
git commit -m "feat: add terminal controller leases" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 5: Implement No-Replay Prompt Dispatch

**Files:**
- Create: `src/control/promptDispatch.ts`
- Create: `__tests__/controlPromptDispatch.test.ts`
- Modify: `src/daemon/tmuxControl.ts`
- Modify: `__tests__/daemon/tmuxControl.test.ts`

- [ ] **Step 1: Write failing prompt-dispatch tests**

Create `__tests__/controlPromptDispatch.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PromptDispatcher } from '../src/control/promptDispatch.js';

function envelope() {
  const utf8 = 'Continue with the failing test';
  return {
    promptId: 'prompt-1',
    paneId: '%3',
    harness: 'codex',
    utf8,
    contentHash: createHash('sha256').update(utf8).digest('hex'),
    submitMode: 'text-and-enter' as const,
    leaseRevision: 2,
  };
}

describe('PromptDispatcher', () => {
  it('dispatches a valid prompt once per runtime invocation', async () => {
    const send = vi.fn(async () => {});
    const dispatcher = new PromptDispatcher(send);
    expect(await dispatcher.dispatch(envelope())).toMatchObject({
      status: 'dispatched',
      promptId: 'prompt-1',
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('marks a dispatch unknown when tmux acceptance is ambiguous', async () => {
    const dispatcher = new PromptDispatcher(async () => {
      throw Object.assign(new Error('socket closed'), { ambiguous: true });
    });
    expect(await dispatcher.dispatch(envelope())).toMatchObject({
      status: 'unknown',
      code: 'prompt_dispatch_ambiguous',
    });
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
pnpm exec vitest --run __tests__/controlPromptDispatch.test.ts
```

Expected: FAIL because `src/control/promptDispatch.ts` does not exist.

- [ ] **Step 3: Implement prompt hashing and dispatch outcomes**

Create `src/control/promptDispatch.ts`:

```ts
import { createHash } from 'node:crypto';
import type { PromptEnvelope } from './types.js';

export type PromptDispatchOutcome =
  | { status: 'dispatched'; promptId: string }
  | { status: 'confirmed'; promptId: string; receiptId: string }
  | { status: 'failed'; promptId: string; code: string; message: string }
  | { status: 'unknown'; promptId: string; code: string; message: string };

export class PromptDispatcher {
  constructor(
    private readonly send: (envelope: PromptEnvelope) => Promise<{ receiptId?: string } | void>,
  ) {}

  async dispatch(envelope: PromptEnvelope): Promise<PromptDispatchOutcome> {
    const hash = createHash('sha256').update(envelope.utf8).digest('hex');
    if (hash !== envelope.contentHash) {
      return {
        status: 'failed',
        promptId: envelope.promptId,
        code: 'prompt_hash_mismatch',
        message: 'prompt content does not match its declared hash',
      };
    }
    try {
      const result = await this.send(envelope);
      return result?.receiptId
        ? { status: 'confirmed', promptId: envelope.promptId, receiptId: result.receiptId }
        : { status: 'dispatched', promptId: envelope.promptId };
    } catch (error) {
      const ambiguous = (error as { ambiguous?: boolean }).ambiguous === true;
      return {
        status: ambiguous ? 'unknown' : 'failed',
        promptId: envelope.promptId,
        code: ambiguous ? 'prompt_dispatch_ambiguous' : 'prompt_dispatch_failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
```

- [ ] **Step 4: Add exact prompt submission to daemon tmux control**

Modify `src/daemon/tmuxControl.ts` so mutations use acknowledged control-mode
transactions. Add:

```ts
private commandTail: Promise<void> = Promise.resolve();
private pending?: {
  number?: string;
  resolve: () => void;
  reject: (error: Error & { ambiguous?: boolean }) => void;
};

executeCommand(line: string): Promise<void> {
  const run = async () => {
    if (!this.proc) throw new Error('tmux control mode not started');
    await new Promise<void>((resolve, reject) => {
      this.pending = { resolve, reject };
      this.proc!.stdin.write(`${line}\n`, (error) => {
        if (error) {
          const ambiguous = Object.assign(error, { ambiguous: true });
          this.pending = undefined;
          reject(ambiguous);
        }
      });
    });
  };
  const result = this.commandTail.then(run, run);
  this.commandTail = result.catch(() => {});
  return result;
}

async sendPrompt(
  paneId: string,
  utf8: string,
  submitMode: 'text' | 'text-and-enter',
): Promise<void> {
  const hex = Array.from(
    Buffer.from(utf8, 'utf8'),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join(' ');
  await this.executeCommand(`send-keys -t ${quote(paneId)} -H ${hex}`);
  if (submitMode === 'text-and-enter') {
    await this.executeCommand(`send-keys -t ${quote(paneId)} Enter`);
  }
}
```

Extend `onLine()` to correlate `%begin ... <command-number> ...`, resolve the
pending transaction on the matching `%end`, and reject it on `%error`. When the
control subprocess exits with a pending command, reject with
`Object.assign(new Error('tmux command outcome is unknown'), { ambiguous: true })`.

Add these tests to `__tests__/daemon/tmuxControl.test.ts` using an injected fake
control subprocess:

```ts
it('waits for tmux acknowledgement of text and Enter', async () => {
  const fake = createFakeControlProcess();
  const tmux = new TmuxControl('psyche-test', { spawnControl: () => fake.process });
  tmux.start();
  const pending = tmux.sendPrompt('%3', 'continue 🧪', 'text-and-enter');
  expect(fake.commands()).toEqual([
    "send-keys -t '%3' -H 63 6f 6e 74 69 6e 75 65 20 f0 9f a7 aa",
  ]);
  fake.acknowledgeNext();
  await Promise.resolve();
  expect(fake.commands()).toEqual([
    "send-keys -t '%3' -H 63 6f 6e 74 69 6e 75 65 20 f0 9f a7 aa",
    "send-keys -t '%3' Enter",
  ]);
  fake.acknowledgeNext();
  await expect(pending).resolves.toBeUndefined();
});

it.each(['before-text-ack', 'between-text-and-enter', 'after-enter-write'])(
  'marks a disconnect %s as ambiguous',
  async (point) => {
    const fake = createFakeControlProcess();
    const tmux = new TmuxControl('psyche-test', { spawnControl: () => fake.process });
    tmux.start();
    const pending = tmux.sendPrompt('%3', 'continue', 'text-and-enter');
    if (point !== 'before-text-ack') fake.acknowledgeNext();
    if (point === 'after-enter-write') await Promise.resolve();
    fake.disconnect();
    await expect(pending).rejects.toMatchObject({ ambiguous: true });
  },
);
});
```

- [ ] **Step 5: Run prompt and existing launch tests**

Run:

```bash
pnpm exec vitest --run \
  __tests__/controlPromptDispatch.test.ts \
  __tests__/daemon/tmuxControl.test.ts \
  __tests__/agentLaunch.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/control/promptDispatch.ts src/daemon/tmuxControl.ts \
  __tests__/controlPromptDispatch.test.ts __tests__/daemon/tmuxControl.test.ts
git commit -m "feat: add no-replay prompt dispatch" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 6: Build the Host Runtime

**Files:**
- Create: `src/control/runtime.ts`
- Create: `src/control/host.ts`
- Create: `src/control/resources/panes.ts`
- Create: `src/control/resources/coven.ts`
- Create: `src/control/resources/sessionBootstrap.ts`
- Modify: `src/orchestration/bridgePaneBackend.ts`
- Modify: `src/orchestration/covenSessionBackend.ts`
- Modify: `src/orchestration/localPaneBackend.ts`
- Create: `__tests__/controlRuntime.test.ts`

- [ ] **Step 1: Write failing runtime tests**

Create `__tests__/controlRuntime.test.ts`. Use these injected spies:

```ts
import { describe, expect, it, vi } from 'vitest';
import { ControlRuntime, type ControlHandlers } from '../src/control/runtime.js';

const handlers: ControlHandlers = {
  executeOrchestration: vi.fn(),
  spawnPane: vi.fn(),
  sendPrompt: vi.fn(),
  interruptPane: vi.fn(),
  sendInput: vi.fn(),
  openTerminal: vi.fn(),
  resizePane: vi.fn(),
  focusPane: vi.fn(),
  killPane: vi.fn(),
  respawnPane: vi.fn(),
  openConflictPane: vi.fn(),
  updatePaneOption: vi.fn(),
  updatePaneMeta: vi.fn(),
  launchRitual: vi.fn(),
  launchCovenSession: vi.fn(),
  openCovenSession: vi.fn(),
  runCovenDesktopAction: vi.fn(),
  executeCovenCapability: vi.fn(),
};

function command(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cmd-1',
    idempotencyKey: 'idem-1',
    kind: 'pane.takeover',
    projectRoot: '/repo',
    actor: { id: 'human-1', kind: 'human' },
    ownerEpoch: 4,
    createdAt: '2026-08-03T20:00:00.000Z',
    payload: { paneId: '%3' },
    ...overrides,
  } as const;
}

function createMemoryJournal() {
  const events: Array<{ sequence: number; kind: string; payload: Record<string, unknown> }> = [];
  return {
    append: vi.fn(async (kind: string, payload: Record<string, unknown>) => {
      const event = { sequence: events.length + 1, kind, payload };
      events.push(event);
      return event;
    }),
    read: () => [...events],
    findByIdempotencyKey: (key: string) =>
      [...events].reverse().find((event) => event.payload.idempotencyKey === key),
    recoverNonterminalCommands: vi.fn(async () => []),
  };
}

describe('ControlRuntime', () => {
  it('returns the prior outcome for a duplicate idempotency key', async () => {
    const runtime = await ControlRuntime.create({
      ownerEpoch: 4,
      handlers,
      journal: createMemoryJournal(),
    });
    const first = await runtime.submit(command());
    const second = await runtime.submit(command({ id: 'cmd-2' }));
    expect(second).toEqual(first);
    expect(runtime.events().filter((event) => event.kind === 'command.requested'))
      .toHaveLength(1);
  });

  it('rejects a stale owner epoch before side effects', async () => {
    const runtime = await ControlRuntime.create({
      ownerEpoch: 4,
      handlers,
      journal: createMemoryJournal(),
    });
    await expect(runtime.submit(command({ ownerEpoch: 3 })))
      .resolves.toMatchObject({ status: 'rejected', code: 'stale_owner_epoch' });
    expect(handlers.sendInput).not.toHaveBeenCalled();
  });

  it('revokes automation before accepting human input', async () => {
    const runtime = await ControlRuntime.create({
      ownerEpoch: 4,
      handlers,
      journal: createMemoryJournal(),
    });
    const delegated = runtime.leases.delegate('%3', 'psyche-1', 'task-1', 60_000);
    await runtime.submit(command());
    await runtime.submit(command({
      id: 'cmd-input',
      idempotencyKey: 'idem-input',
      kind: 'pane.input',
      payload: {
        paneId: '%3',
        dataBase64: Buffer.from('status').toString('base64'),
        leaseRevision: delegated.revision + 1,
      },
    }));
    expect(handlers.sendInput).toHaveBeenCalledTimes(1);
    expect(() => runtime.leases.assertAutomation('%3', 'psyche-1', delegated.revision))
      .toThrow('lease revision mismatch');
  });

  it('journals human delegation to a task-bound Psyche actor', async () => {
    const journal = createMemoryJournal();
    const runtime = await ControlRuntime.create({ ownerEpoch: 4, handlers, journal });
    const outcome = await runtime.submit(command({
      kind: 'pane.delegate',
      payload: {
        paneId: '%3',
        automationActorId: 'psyche-1',
        taskId: 'task-1',
        ttlMs: 60_000,
      },
    }));
    expect(outcome).toMatchObject({
      status: 'succeeded',
      value: { actorId: 'psyche-1', taskId: 'task-1', revision: 1 },
    });
    expect(journal.read().map((event) => event.kind)).toContain('lease.delegated');
  });

  it('records unknown and never retries an ambiguous prompt', async () => {
    handlers.sendPrompt = vi.fn(async () => {
      throw Object.assign(new Error('connection closed'), { ambiguous: true });
    });
    const runtime = await ControlRuntime.create({
      ownerEpoch: 4,
      handlers,
      journal: createMemoryJournal(),
    });
    const lease = runtime.leases.delegate('%3', 'psyche-1', 'task-1', 60_000);
    const prompt = command({
      kind: 'pane.prompt',
      actor: { id: 'psyche-1', kind: 'psyche' },
      payload: {
        promptId: 'prompt-1',
        paneId: '%3',
        utf8: 'continue',
        contentHash: 'e256ee8e7aff6957a781d8328f0f68e26996564c81fa458da59fbca2305138ad',
        submitMode: 'text-and-enter',
        leaseRevision: lease.revision,
      },
    });
    expect(await runtime.submit(prompt)).toMatchObject({ status: 'unknown' });
    expect(await runtime.submit({ ...prompt, id: 'cmd-2' })).toMatchObject({ status: 'unknown' });
    expect(handlers.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('terminalizes an accepted crash-window command as unknown on restart', async () => {
    const journal = createMemoryJournal();
    await journal.append('command.requested', {
      commandId: 'cmd-crash',
      idempotencyKey: 'idem-crash',
    });
    await journal.append('command.accepted', {
      commandId: 'cmd-crash',
      idempotencyKey: 'idem-crash',
    });
    journal.recoverNonterminalCommands = vi.fn(async () => [
      await journal.append('command.unknown', {
        commandId: 'cmd-crash',
        idempotencyKey: 'idem-crash',
        code: 'recovered_ambiguous_command',
      }),
    ]);
    const runtime = await ControlRuntime.create({ ownerEpoch: 5, handlers, journal });
    expect(journal.recoverNonterminalCommands).toHaveBeenCalledTimes(1);
    expect(await runtime.submit(command({
      id: 'cmd-after-restart',
      idempotencyKey: 'idem-crash',
      ownerEpoch: 5,
    }))).toMatchObject({ status: 'unknown' });
    expect(handlers.sendPrompt).not.toHaveBeenCalled();
  });

  it('cancels queued automation before completing takeover', async () => {
    const runtime = await ControlRuntime.create({
      ownerEpoch: 4,
      handlers,
      journal: createMemoryJournal(),
    });
    const lease = runtime.leases.delegate('%3', 'psyche-1', 'task-1', 60_000);
    const release = runtime.testOnlyBlockPane('%3');
    const queued = runtime.submit(command({
      id: 'cmd-prompt',
      idempotencyKey: 'idem-prompt',
      kind: 'pane.prompt',
      actor: { id: 'psyche-1', kind: 'psyche' },
      payload: {
        promptId: 'prompt-queued',
        paneId: '%3',
        utf8: 'continue',
        contentHash: 'e256ee8e7aff6957a781d8328f0f68e26996564c81fa458da59fbca2305138ad',
        submitMode: 'text-and-enter',
        leaseRevision: lease.revision,
      },
    }));
    const takeover = runtime.submit(command({
      id: 'cmd-takeover',
      idempotencyKey: 'idem-takeover',
      kind: 'pane.takeover',
    }));
    release();
    await expect(queued).resolves.toMatchObject({
      status: 'rejected',
      code: 'automation_preempted',
    });
    await expect(takeover).resolves.toMatchObject({ status: 'succeeded' });
    expect(handlers.sendPrompt).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
pnpm exec vitest --run __tests__/controlRuntime.test.ts
```

Expected: FAIL because `src/control/runtime.ts` does not exist.

- [ ] **Step 3: Implement the runtime contract**

Create `src/control/runtime.ts` with:

```ts
export interface ControlHandlers {
  executeOrchestration: (payload: Extract<ControlCommand, { kind: 'orchestration.execute' }>['payload']) => Promise<unknown>;
  spawnPane: (payload: Extract<ControlCommand, { kind: 'pane.spawn' }>['payload']) => Promise<unknown>;
  sendPrompt: (payload: PromptEnvelope) => Promise<unknown>;
  interruptPane: (payload: Extract<ControlCommand, { kind: 'pane.interrupt' }>['payload']) => Promise<unknown>;
  sendInput: (payload: Extract<ControlCommand, { kind: 'pane.input' }>['payload']) => Promise<unknown>;
  openTerminal: (payload: Extract<ControlCommand, { kind: 'pane.terminal.open' }>['payload']) => Promise<unknown>;
  resizePane: (payload: Extract<ControlCommand, { kind: 'pane.resize' }>['payload']) => Promise<unknown>;
  focusPane: (payload: Extract<ControlCommand, { kind: 'pane.focus' }>['payload']) => Promise<unknown>;
  killPane: (payload: Extract<ControlCommand, { kind: 'pane.kill' }>['payload']) => Promise<unknown>;
  respawnPane: (payload: Extract<ControlCommand, { kind: 'pane.respawn' }>['payload']) => Promise<unknown>;
  openConflictPane: (payload: Extract<ControlCommand, { kind: 'pane.conflict.open' }>['payload']) => Promise<unknown>;
  updatePaneOption: (payload: Extract<ControlCommand, { kind: 'pane.option.update' }>['payload']) => Promise<unknown>;
  updatePaneMeta: (payload: Extract<ControlCommand, { kind: 'pane.meta.update' }>['payload']) => Promise<unknown>;
  launchRitual: (payload: Extract<ControlCommand, { kind: 'ritual.launch' }>['payload']) => Promise<unknown>;
  launchCovenSession: (payload: Extract<ControlCommand, { kind: 'coven.session.launch' }>['payload']) => Promise<unknown>;
  openCovenSession: (payload: Extract<ControlCommand, { kind: 'coven.session.open' }>['payload']) => Promise<unknown>;
  runCovenDesktopAction: (payload: Extract<ControlCommand, { kind: 'coven.desktop.action' }>['payload']) => Promise<unknown>;
  executeCovenCapability: (payload: Extract<ControlCommand, { kind: 'coven.capability.execute' }>['payload']) => Promise<unknown>;
}
```

`ControlRuntime.submit(command)` must:

1. load the snapshot, replay events after `coveredSequence`, rebuild command
   outcomes and leases, then call and await
   `journal.recoverNonterminalCommands()` during `ControlRuntime.create()`
   before setting the runtime ready flag;
2. compare `command.ownerEpoch` to the active epoch;
3. return the previous terminal result reduced from the journal for an existing
   idempotency key;
4. append `command.requested`;
5. use `ControlScope` to validate every cwd, worktree, target repository, pane,
   and session identity;
6. validate expiry and actor/lease requirements;
7. append `command.rejected` or `command.accepted`;
8. execute through the pane command queue for pane mutations;
9. append exactly one terminal event;
10. reduce and return the terminal outcome from that event.

`pane.delegate` is accepted only from a human actor. It binds one Psyche actor,
task id, pane id, TTL, and revision, appends `lease.delegated`, and returns the
lease. `pane.takeover` is a lease operation with no external resource handler,
but appends the lease revision to the journal and includes it in snapshots.

Implement pane queues as explicit pending-command lists, not only promise
tails. Takeover immediately marks a new pane barrier generation and
terminalizes every not-yet-started Psyche command as
`automation_preempted`. It then waits for any in-flight transaction to finish,
installs the human lease, and only then permits human input. Every queued
automation command revalidates owner epoch, barrier generation, lease revision,
and scope immediately before invoking its resource handler.

For `pane.input`, require a human lease for human actors and an automation lease
for Psyche actors. For `pane.prompt`, require an automation lease.

The server must authorize `pane.delegate` and `pane.takeover` from an operator
principal before the runtime maps that principal to the internal `human`
actor. Agent and compatibility principals are rejected even if a malformed
credential record contains the `delegate` capability.

- [ ] **Step 4: Compose real handlers**

Create `src/control/host.ts`. Export:

```ts
export interface HostControlPlane {
  epoch: number;
  runtime: ControlRuntime;
  close(): Promise<void>;
}

export interface HostControlPlaneOptions {
  handlers?: Partial<ControlHandlers>;
  ownerLock?: typeof acquireOwnerLock;
  journalOpen?: typeof ControlJournal.open;
  tmuxControl?: TmuxControl;
}

export async function createHostControlPlane(
  projectRoot: string,
  options: HostControlPlaneOptions = {},
): Promise<HostControlPlane>;
```

The first operation in `createHostControlPlane()` is
`canonicalizeProjectRoot(projectRoot)`. Pass only that result to
`acquireOwnerLock`, `ControlJournal.open`, `controlEndpointForProject`,
orchestration requests, and the welcome response.

`src/control/resources/panes.ts` is the only module imported by `host.ts` for
pane/worktree/tmux mutations. It wraps `paneCreation`, `attachAgent`,
`reopenWorktree`, `conflictResolutionPane`, `TmuxService`, and
`TmuxControl`. `src/control/resources/coven.ts` is the equivalent boundary for
Coven mutation functions.

Make all orchestration backends effect-free:

- `createBridgePaneBackend` requires an injected `spawnPane` capability and
  has no default import of `spawnBridgePane`;
- `createCovenSessionBackend` requires injected launch/open capabilities and
  has no default import of daemon bridge mutation functions;
- `createLocalPaneBackend` requires injected pane creation/attachment
  capabilities and has no default import of `createPane`.

Only `src/control/resources/*.ts` constructs those capabilities. This makes the
backend files safe policy/translation units rather than alternate effect
owners.

`src/control/resources/sessionBootstrap.ts` contains only tmux session creation,
theme, and metadata operations. `createHostControlPlane()` acquires the owner
lock and opens the journal first, appends `runtime.bootstrap.started`, performs
bootstrap once, and appends `runtime.bootstrap.succeeded` before accepting
connections. Concurrent startup therefore loses at owner acquisition before
any tmux mutation.

Compose existing functions rather than duplicating them:

- `Orchestrator` + `createBridgePaneBackend` + `createCovenSessionBackend`;
- `spawnBridgePane`;
- `killBridgePane`;
- `updatePaneMeta`;
- host-owned terminal split/open, respawn, focus, resize, and pane-option
  operations;
- conflict-pane creation and merge-conflict setup through
  `pane.conflict.open`;
- `launchProjectCovenSession`;
- `openProjectCovenSession`;
- Coven desktop action dispatch;
- acknowledged `TmuxControl.executeCommand()` and `sendPrompt()` transactions
  for input, resize, focus, and kill.

The host owns exactly one `TmuxControl` instance per project session.

- [ ] **Step 5: Run runtime and orchestration regression tests**

Run:

```bash
pnpm exec vitest --run \
  __tests__/controlRuntime.test.ts \
  __tests__/orchestrator.test.ts \
  __tests__/orchestrationAdapters.test.ts \
  __tests__/daemon/bridgePaneBackend.test.ts \
  __tests__/daemon/covenSessionBackend.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/control/runtime.ts src/control/host.ts \
  src/control/resources/panes.ts src/control/resources/coven.ts \
  src/control/resources/sessionBootstrap.ts \
  src/orchestration/bridgePaneBackend.ts \
  src/orchestration/covenSessionBackend.ts \
  src/orchestration/localPaneBackend.ts \
  __tests__/controlRuntime.test.ts
git commit -m "feat: add the fenced host control runtime" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 7: Expose the Runtime Through the Daemon and Client

**Files:**
- Create: `src/control/client.ts`
- Create: `src/control/credentials.ts`
- Create: `src/control/endpoint.ts`
- Create: `src/control/server.ts`
- Modify: `src/daemon/index.ts`
- Create: `__tests__/controlClient.test.ts`
- Create: `__tests__/controlCredentials.test.ts`
- Create: `__tests__/daemon/controlAdapter.test.ts`

- [ ] **Step 1: Write failing daemon-adapter tests**

Create `__tests__/daemon/controlAdapter.test.ts` around the existing daemon
connection test harness:

```ts
it('translates v0 pane input into takeover followed by human input', async () => {
  const submit = vi.fn()
    .mockResolvedValueOnce({ status: 'succeeded', value: { leaseRevision: 7 } })
    .mockResolvedValueOnce({ status: 'succeeded' });
  const client = await connectDaemon({ controlRuntime: { submit } as never });

  await client.send({
    type: 'panes.input',
    requestId: 'req-1',
    streamId: 'stream-1',
    data: Buffer.from('status').toString('base64'),
  });

  expect(submit.mock.calls.map(([value]) => value.kind)).toEqual([
    'pane.takeover',
    'pane.input',
  ]);
  expect(submit.mock.calls[1][0]).toMatchObject({
    payload: { paneId: '%3', leaseRevision: 7 },
  });
});

it.each([
  ['panes.spawn', 'pane.spawn'],
  ['panes.kill', 'pane.kill'],
])('translates %s through %s', async (messageType, commandKind) => {
  const submit = vi.fn(async () => ({ status: 'succeeded' }));
  const client = await connectDaemon({ controlRuntime: { submit } as never });
  await client.send(buildV0Mutation(messageType));
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ kind: commandKind }));
});
```

Add a source-boundary assertion:

```ts
it('contains no direct pane mutation calls in Connection.dispatch', () => {
  const source = readFileSync(
    new URL('../../src/daemon/index.ts', import.meta.url),
    'utf8',
  );
  expect(source).not.toMatch(
    /this\.deps\.tmux\.(sendKeysHex|resizePane|selectPane|killPane)|spawnBridgePane\(/,
  );
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
pnpm exec vitest --run \
  __tests__/controlClient.test.ts \
  __tests__/daemon/controlAdapter.test.ts
```

Expected: FAIL because the client and control message handlers do not exist.

- [ ] **Step 3: Add the project-scoped canonical endpoint**

Create `src/control/endpoint.ts`:

```ts
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

export function controlEndpointForProject(canonicalProjectRoot: string): string {
  const id = createHash('sha256').update(canonicalProjectRoot).digest('hex').slice(0, 20);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\psyche-control-${id}`
    : path.join(homedir(), '.psyche', 'runtime', 'sockets', `${id}.sock`);
}
```

Create `src/control/server.ts` as the only transport that decodes the versioned
messages from `src/control/protocol.ts`. It creates the socket parent with mode
`0700`, removes only its own stale socket after acquiring the project owner
lock, listens on the project-derived endpoint, sets the socket mode to `0600`,
authenticates through the scoped control credential store, and returns a welcome
message containing:

```ts
{
  version: 1,
  type: 'welcome',
  requestId: 'welcome',
  projectRoot: canonicalProjectRoot,
  ownerEpoch: host.epoch,
}
```

Create `src/control/credentials.ts` with two scoped credentials, both stored
with mode `0600`:

```ts
export type ControlPrincipalKind = 'operator' | 'agent' | 'compatibility';

export interface ControlPrincipal {
  id: string;
  kind: ControlPrincipalKind;
  capabilities: readonly ('read' | 'mutate' | 'delegate')[];
}

export interface ControlCredentialStore {
  authenticate(token: string): Promise<ControlPrincipal | null>;
  operatorToken(): Promise<string>;
  agentToken(): Promise<string>;
}
```

The TUI and authenticated human-device bridge connect as operator principals.
MCP connects with the agent credential. Legacy v0 automation uses a
server-created compatibility principal.
The server ignores any caller-supplied actor fields, stamps `actor` and
`ownerEpoch` from the authenticated connection, and permits `pane.delegate`
only when `principal.kind === 'operator'` and the principal has `delegate`.
It permits `pane.takeover` only when `principal.kind === 'operator'`.

Add tests proving:

```ts
it('rejects agent self-delegation and stamps operator identity', async () => {
  const runtime = { submit: vi.fn(async (command) => ({
    status: 'succeeded',
    value: command.actor,
  })) };
  const server = createControlServerForTest({ runtime: runtime as never });
  await expect(server.submitAs(
    { id: 'agent-1', kind: 'agent', capabilities: ['read', 'mutate', 'delegate'] },
    delegationInput(),
  )).resolves.toMatchObject({
    status: 'rejected',
    code: 'delegation_not_authorized',
  });

  await expect(server.submitAs(
    { id: 'operator-1', kind: 'operator', capabilities: ['read', 'mutate', 'delegate'] },
    delegationInput(),
  )).resolves.toMatchObject({
    status: 'succeeded',
    value: { id: 'operator-1', kind: 'human' },
  });
  expect(runtime.submit).toHaveBeenCalledTimes(1);
});

it.each([
  { id: 'agent-1', kind: 'agent', capabilities: ['read', 'mutate', 'delegate'] },
  { id: 'compat-1', kind: 'compatibility', capabilities: ['read', 'mutate', 'delegate'] },
])('rejects delegation and takeover for $kind principals', async (principal) => {
  const server = createControlServerForTest();
  await expect(server.submitAs(principal as never, delegationInput()))
    .resolves.toMatchObject({ status: 'rejected', code: 'delegation_not_authorized' });
  await expect(server.submitAs(principal as never, takeoverInput()))
    .resolves.toMatchObject({ status: 'rejected', code: 'takeover_not_authorized' });
});
```

Add `welcome` to `ControlResponse`. The server rejects a request whose declared
project identity does not match its canonical project root.

- [ ] **Step 4: Instantiate the host owner in `runDaemon()`**

At daemon startup:

```ts
const canonicalProjectRoot = await canonicalizeProjectRoot(projectRoot);
const host = await createHostControlPlane(canonicalProjectRoot);
```

Pass `host` into every `Connection`. On shutdown, call `await host.close()`
before process exit.

Start `ControlServer` on `controlEndpointForProject(projectRoot)` and dispatch
the canonical `command.submit`, `state.get`, and `events.read` envelopes
through `decodeControlRequest()`.

Stop treating port `47123` as the owner-discovery mechanism. When no explicit
legacy `--port` is supplied, bind the v0 compatibility listener to loopback
port `0` and atomically write the chosen port, canonical project root, PID, and
owner epoch to `.psyche/runtime/legacy-daemon.json`. Existing v0 clients that
know the project root read that file; the canonical client always uses the
project-derived socket. Add a test that starts owners for two temporary
projects concurrently and verifies distinct canonical endpoints and no port
collision.

Translate v0 mutation cases into `ControlCommand` objects with:

- actor `{ id: connectionActorId, kind: 'compatibility', clientId }` for
  translated automation and lifecycle commands;
- actor `{ id: connectionActorId, kind: 'human', clientId }` for interactive
  v0 input;
- current `host.epoch`;
- stable request-derived command and idempotency keys;
- explicit human takeover before `panes.input`.

Translate attach-time resize through `pane.resize`. Translate
`coven.sessions.launch`, `coven.sessions.open`, `coven.desktop.action`, and
`coven.capabilities.execute` through their canonical commands. Delete direct
calls to `tmux.sendKeysHex`, `tmux.resizePane`, `tmux.selectPane`,
`tmux.killPane`, `spawnBridgePane`, `launchProjectCovenSession`,
`openProjectCovenSession`, and `routeProjectCovenSessionCapability` from
`Connection.dispatch`.

- [ ] **Step 5: Implement the local client**

Create `src/control/client.ts` with:

```ts
export class ControlClient {
  readonly projectRoot: string;
  readonly ownerEpoch: number;

  static connect(options: {
    projectRoot: string;
    endpoint?: string;
    token: string;
    clientName: string;
  }): Promise<ControlClient>;

  submit(command: ControlCommandInput): Promise<CommandOutcome>;
  getState(): Promise<ControlSnapshot>;
  readEvents(afterSequence: number, limit?: number): Promise<{
    events: ControlEvent[];
    nextSequence: number;
    gap: boolean;
  }>;
  close(): Promise<void>;
}
```

The client connects to `controlEndpointForProject(projectRoot)`, learns the
canonical project root and current owner epoch from `welcome`, rejects a
project mismatch, attaches the epoch to commands, correlates responses by
request id, rejects pending requests on disconnect, and never retries a
mutation automatically.

`ControlClient.connect()` must first call
`canonicalizeProjectRoot(options.projectRoot)`, derive the endpoint from that
canonical value, send that value in `hello`, expose it as `client.projectRoot`,
and replace every submitted command's `projectRoot` with the canonical value.
It never sends an actor kind; the server-assigned principal is returned in the
welcome response and exposed read-only for UI display.

- [ ] **Step 6: Run daemon and client tests**

Run:

```bash
pnpm exec vitest --run \
  __tests__/controlClient.test.ts \
  __tests__/daemon/controlAdapter.test.ts \
  __tests__/daemon/bridge.test.ts \
  __tests__/daemon/tmuxControl.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/control/client.ts src/control/credentials.ts \
  src/control/endpoint.ts src/control/server.ts \
  src/daemon/index.ts \
  __tests__/controlClient.test.ts __tests__/controlCredentials.test.ts \
  __tests__/daemon/controlAdapter.test.ts
git commit -m "feat: expose the canonical host control API" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 8: Convert Mobile Bridge v2 Into an Adapter

**Files:**
- Modify: `src/services/bridge/wireProtocol.ts`
- Modify: `src/services/bridge/BridgeDaemon.ts`
- Modify: `src/services/bridge/PaneStreamHub.ts`
- Modify: `src/services/bridge/tmuxControl.ts`
- Modify: `__tests__/bridge/wireProtocol.test.ts`
- Modify: `__tests__/bridge/wireProtocolContract.test.ts`
- Modify: `__tests__/bridge/BridgeDaemon.test.ts`
- Modify: `__tests__/bridge/PaneStreamHub.test.ts`
- Modify: `native/ios/PsycheCore/Sources/PsycheCore/Protocol/BridgeMessages.swift`
- Modify: `native/ios/PsycheCore/Sources/PsycheCore/Connection/ConnectionManager.swift`
- Modify: `native/ios/PsycheCore/Tests/PsycheCoreTests/BridgeMessagesTests.swift`
- Modify: `native/ios/PsycheCore/Tests/PsycheCoreTests/ConnectionManagerTests.swift`

- [ ] **Step 1: Add failing adapter tests**

```ts
it('submits takeover before input and preserves unknown', async () => {
  const submit = vi.fn()
    .mockResolvedValueOnce({ status: 'succeeded', value: { leaseRevision: 9 } })
    .mockResolvedValueOnce({
      status: 'unknown',
      code: 'prompt_dispatch_ambiguous',
      message: 'connection closed',
    });
  const daemon = createBridgeDaemon({ control: { submit } as never });
  const session = authenticatedSession();
  await daemon.receive(session, {
    type: 'sendInput',
    payload: {
      paneId: '%3',
      data: Buffer.from('status').toString('base64'),
      commandId: 'cmd-input',
      idempotencyKey: 'idem-input',
    },
  });
  expect(submit.mock.calls.map(([command]) => command.kind)).toEqual([
    'pane.takeover',
    'pane.input',
  ]);
  expect(session.messages.at(-1)).toMatchObject({
    type: 'commandResult',
    payload: { commandId: 'cmd-input', outcome: { status: 'unknown' } },
  });
});

it('routes ritual launch with caller-provided idempotency', async () => {
  const submit = vi.fn(async () => ({ status: 'succeeded' }));
  const daemon = createBridgeDaemon({ control: { submit } as never });
  await daemon.receive(authenticatedSession(), {
    type: 'launchRitual',
    payload: {
      projectId: '/repo',
      ritualId: 'review-stack',
      params: {},
      commandId: 'cmd-ritual',
      idempotencyKey: 'idem-ritual',
    },
  });
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({
    id: 'cmd-ritual',
    idempotencyKey: 'idem-ritual',
    kind: 'ritual.launch',
  }));
});
```

Retain the existing pane subscription tests unchanged. Add a compile-time
assertion that `PaneStreamHub` has no `sendInput` member:

```ts
type HasSendInput = 'sendInput' extends keyof PaneStreamHub ? true : false;
const hasSendInput: HasSendInput = false;
expect(hasSendInput).toBe(false);
```

- [ ] **Step 2: Run the bridge tests and verify they fail**

Run:

```bash
pnpm exec vitest --run __tests__/bridge
```

Expected: FAIL on the new control-adapter expectations.

- [ ] **Step 3: Extend the v2 wire contract**

Change `SendInputPayload` to:

```ts
export interface SendInputPayload {
  paneId: string;
  data: string;
  commandId: string;
  idempotencyKey: string;
}
```

Add server messages:

```ts
| {
    type: 'commandResult';
    payload: {
      commandId: string;
      outcome:
        | { status: 'succeeded'; value?: unknown }
        | { status: 'rejected'; code: string; message: string }
        | { status: 'failed'; code: string; message: string }
        | { status: 'unknown'; code: string; message: string };
    };
  }
```

Add `commandId` and `idempotencyKey` to `LaunchRitualPayload` as well.

Update `CLIENT_MESSAGE_TYPES`, `SERVER_MESSAGE_TYPES`,
`BridgeMessages.swift`, `ConnectionManager.swift`, and both Swift test files.
The Swift connection manager must surface `unknown` distinctly and must not
resubmit it after reconnect. Run the TypeScript contract fixtures and the
`PsycheCoreTests` Swift package together so the mirrors remain mutually
exhaustive.

- [ ] **Step 4: Forward bridge mutations to `ControlClient`**

Add `controlClient: ControlClient` to `BridgeDaemonOptions`.

For `sendInput`:

1. submit `pane.takeover` with the authenticated device as the human actor;
2. read the returned lease revision from state;
3. submit `pane.input`;
4. return `commandResult` with the exact canonical outcome.

For `launchRitual`, submit `ritual.launch`; remove the direct
`ritualLauncher` callback and boot-time mutation fallback.

- [ ] **Step 5: Remove bridge-side mutation authority**

Delete `PaneStreamHub.sendInput()` and remove `sendKeysHex`, `resizePane`, and
`killPane` from `src/services/bridge/tmuxControl.ts`. Keep only read-only
control-mode output buffering, replay, and subscription behavior.

- [ ] **Step 6: Run bridge tests**

Run:

```bash
pnpm exec vitest --run __tests__/bridge
swift test --package-path native/ios/PsycheCore
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/services/bridge/wireProtocol.ts \
  src/services/bridge/BridgeDaemon.ts \
  src/services/bridge/PaneStreamHub.ts \
  src/services/bridge/tmuxControl.ts \
  __tests__/bridge \
  native/ios/PsycheCore/Sources/PsycheCore/Protocol/BridgeMessages.swift \
  native/ios/PsycheCore/Sources/PsycheCore/Connection/ConnectionManager.swift \
  native/ios/PsycheCore/Tests/PsycheCoreTests/BridgeMessagesTests.swift \
  native/ios/PsycheCore/Tests/PsycheCoreTests/ConnectionManagerTests.swift
git commit -m "refactor: route mobile bridge mutations through the host owner" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 9: Convert MCP Into an Agent-Facing Control Adapter

**Files:**
- Modify: `src/mcp/server.ts`
- Modify: `__tests__/mcpServer.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write failing MCP adapter tests**

Replace direct collaborator expectations with a mocked `ControlClient`.

```ts
it.each([
  ['psyche_create_pane', { prompt: 'fix tests', agent: 'codex' }, 'pane.spawn'],
  [
    'psyche_execute_task',
    { prompt: 'fix tests', lanes: [{ id: 'codex', agent: 'codex' }] },
    'orchestration.execute',
  ],
  ['psyche_kill_pane', { pane_id: '%3' }, 'pane.kill'],
])('routes %s through canonical control', async (tool, args, commandKind) => {
  const submit = vi.fn(async () => ({ status: 'succeeded' }));
  inject({ control: { submit } as never });
  await call(tool, args);
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ kind: commandKind }));
});

it('returns unknown prompt outcome without retrying', async () => {
  const submit = vi.fn(async () => ({
    status: 'unknown',
    code: 'prompt_dispatch_ambiguous',
    message: 'tmux disconnected',
  }));
  inject({ control: { submit } as never });
  const body = payload(await call('psyche_send_prompt', {
    pane_id: '%3',
    prompt_id: 'prompt-1',
    idempotency_key: 'idem-1',
    prompt: 'continue',
    lease_revision: 7,
    submit: true,
  }));
  expect(body.status).toBe('unknown');
  expect(submit).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run the MCP tests and verify they fail**

Run:

```bash
pnpm exec vitest --run __tests__/mcpServer.test.ts
```

Expected: FAIL because MCP still imports mutation primitives directly.

- [ ] **Step 3: Replace mutation dependencies**

Change `McpDeps` to:

```ts
export interface McpDeps {
  control: Pick<ControlClient, 'submit' | 'getState' | 'readEvents'>;
  listPanes: typeof listPanes;
  capturePane: typeof capturePaneSync;
  listRituals: typeof listProjectRituals;
}
```

Remove imports of `spawnBridgePane`, `killBridgePane`, `Orchestrator`,
`createBridgePaneBackend`, and `createCovenSessionBackend`.

`runMcpServer()` resolves the project root, calls `ensureHostControlPlane()`,
and injects the connected client before reading stdin. If the owner cannot be
started or project identity does not match, write the error to stderr and exit
nonzero; do not fall back to direct mutation.

Map existing tools to canonical commands and preserve their public response
shape. Add:

```text
psyche_send_prompt
```

`psyche_send_prompt` requires `pane_id`, `prompt_id`, `idempotency_key`,
`prompt`, `lease_revision`, and optional `submit`. Hash the prompt locally and
submit `pane.prompt`. If the outcome is `unknown`, return it as unknown and do
not retry.

- [ ] **Step 4: Update README MCP documentation**

Document:

- MCP is a client of the running host owner;
- mutating tools require the daemon;
- takeover fences automation before human input;
- takeover is available only through operator TUI/device surfaces, not MCP;
- delegation is granted by the operator TUI, never self-issued by MCP;
- prompt delivery may be `dispatched`, `confirmed`, or `unknown`;
- unknown input is never replayed automatically.

- [ ] **Step 5: Run MCP and documentation contract tests**

Run:

```bash
pnpm exec vitest --run __tests__/mcpServer.test.ts __tests__/renamedRuntimeContracts.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.ts __tests__/mcpServer.test.ts README.md
git commit -m "refactor: make MCP a host control client" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 10: Route TUI Provisioning Through the Host Owner

**Files:**
- Create: `src/control/hostProcess.ts`
- Create: `src/orchestration/controlAdapter.ts`
- Modify: `src/hooks/usePaneCreation.ts`
- Modify: `src/hooks/usePaneRunner.ts`
- Modify: `src/hooks/useInputHandling.ts`
- Modify: `src/hooks/usePaneLoading.ts`
- Modify: `src/hooks/useWorktreeActions.ts`
- Modify: `src/PsycheApp.tsx`
- Modify: `src/actions/implementations/closeAction.ts`
- Modify: `src/actions/implementations/index.ts`
- Modify: `src/actions/merge/conflictResolution.ts`
- Modify: `src/actions/merge/multiMergeOrchestrator.ts`
- Modify: `src/actions/merge/mergeExecution.ts`
- Modify: `src/actions/merge/issueHandlers/mergeConflictHandler.ts`
- Modify: `src/utils/asciiArt.ts`
- Modify: `src/utils/resumeBranches.ts`
- Modify: `src/services/PopupManager.ts`
- Modify: `src/services/PsycheFocusService.ts`
- Modify: `src/services/StatusDetector.ts`
- Modify: `src/workers/PaneWorker.ts`
- Modify: `src/services/bridge/tmuxControl.ts`
- Modify: `src/index.ts`
- Create: `__tests__/controlHostProcess.test.ts`
- Create: `__tests__/orchestrationControlAdapter.test.ts`
- Create: `__tests__/controlMutationBoundaries.test.ts`

- [ ] **Step 1: Write failing TUI control tests**

Create `__tests__/orchestrationControlAdapter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildTuiProvisionCommand } from '../src/orchestration/controlAdapter.js';

describe('buildTuiProvisionCommand', () => {
  it('preserves TUI lane ordering in one orchestration command', () => {
    const command = buildTuiProvisionCommand({
      commandId: 'cmd-1',
      idempotencyKey: 'idem-1',
      projectRoot: '/repo',
      taskId: 'task-1',
      prompt: 'fix tests',
      agents: ['codex', 'claude'],
      concurrency: 2,
    });
    expect(command.kind).toBe('orchestration.execute');
    expect(command.payload.request.lanes.map((lane) => lane.agent)).toEqual([
      'codex',
      'claude',
    ]);
  });
});
```

Create `__tests__/controlHostProcess.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { ensureHostControlPlane } from '../src/control/hostProcess.js';

describe('ensureHostControlPlane', () => {
  it('starts one detached daemon and waits for health', async () => {
    const spawn = vi.fn(() => ({ unref: vi.fn() }));
    const client = { projectRoot: '/repo', ownerEpoch: 4 };
    const connect = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(client);
    expect(await ensureHostControlPlane('/repo', {
      spawn: spawn as never,
      connect,
      sleep: async () => {},
      executable: '/repo/dist/index.js',
    })).toBe(client);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ['/repo/dist/index.js', 'daemon', '--project-root', '/repo'],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
  });

  it('does not start another daemon when health succeeds', async () => {
    const spawn = vi.fn();
    await ensureHostControlPlane('/repo', {
      spawn: spawn as never,
      connect: async () => ({ projectRoot: '/repo', ownerEpoch: 4 } as never),
      sleep: async () => {},
      executable: '/repo/dist/index.js',
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});
```

Create `__tests__/controlMutationBoundaries.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const EFFECTFUL_IMPLEMENTATIONS = new Set([
  'src/daemon/bridge.ts',
  'src/daemon/tmuxControl.ts',
  'src/services/TmuxService.ts',
  'src/utils/agentLaunch.ts',
  'src/utils/agentPromptDispatch.ts',
  'src/utils/attachAgent.ts',
  'src/utils/conflictResolutionPane.ts',
  'src/utils/paneCreation.ts',
  'src/utils/reopenWorktree.ts',
  'src/utils/tmux.ts',
  'src/utils/welcomePane.ts',
]);

const ALLOWED_EFFECT_IMPORTERS = new Set([
  ...EFFECTFUL_IMPLEMENTATIONS,
  'src/control/resources/panes.ts',
  'src/control/resources/coven.ts',
  'src/control/resources/sessionBootstrap.ts',
]);

function sourceFiles(entry: string): string[] {
  if (statSync(entry).isFile()) return [entry];
  return readdirSync(entry).flatMap((name) => {
    const child = path.join(entry, name);
    return statSync(child).isDirectory()
      ? sourceFiles(child)
      : /\.(ts|tsx)$/.test(child) ? [child] : [];
  });
}

describe('control mutation boundaries', () => {
  it.each(sourceFiles('src'))('%s obeys the host capability boundary', (file) => {
    const source = readFileSync(file, 'utf8');
    if (!ALLOWED_EFFECT_IMPORTERS.has(file)) {
      expect(source).not.toMatch(
        /(?:from|import\()\s*['"][^'"]*(?:TmuxService|paneCreation|attachAgent|conflictResolutionPane|reopenWorktree|utils\/tmux|daemon\/bridge|daemon\/tmuxControl)[^'"]*['"]/,
      );
    }
    if (!EFFECTFUL_IMPLEMENTATIONS.has(file) && !file.startsWith('src/control/resources/')) {
      expect(source).not.toMatch(
        /spawnBridgePane|killBridgePane|createLocalPaneBackend|createPane\(|attachAgentToWorktree|createConflictResolutionPane|reopenWorktree|sendKeysHex|sendShellCommand|sendTmuxKeys|splitPane\(|selectPane\(|killPane\(|resizePane\(|respawnPane\(|setPaneOption|unsetPaneOption|launchProjectCovenSession|openProjectCovenSession|routeProjectCovenSessionCapability/,
      );
    }
  });

  it('host composition imports only resource adapters for effects', () => {
    const source = readFileSync('src/control/host.ts', 'utf8');
    expect(source).not.toMatch(
      /TmuxService|paneCreation|attachAgent|conflictResolutionPane|reopenWorktree|daemon\/bridge|daemon\/tmuxControl/,
    );
    expect(source).toMatch(/control\/resources\/panes|\.\/resources\/panes/);
    expect(source).toMatch(/control\/resources\/coven|\.\/resources\/coven/);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
pnpm exec vitest --run \
  __tests__/controlHostProcess.test.ts \
  __tests__/orchestrationControlAdapter.test.ts \
  __tests__/controlMutationBoundaries.test.ts
```

Expected: FAIL because `usePaneCreation` constructs and executes the local
backend directly.

- [ ] **Step 3: Ensure the daemon before enabling mutations**

Create `src/control/hostProcess.ts`:

```ts
import { spawn, type SpawnOptions } from 'node:child_process';
import type { ControlClient } from './client.js';
import { canonicalizeProjectRoot } from './projectIdentity.js';

export interface EnsureHostOptions {
  executable: string;
  spawn?: typeof spawn;
  connect: () => Promise<ControlClient>;
  sleep?: (ms: number) => Promise<void>;
}

export async function ensureHostControlPlane(
  projectRoot: string,
  options: EnsureHostOptions,
): Promise<ControlClient> {
  const canonicalProjectRoot = await canonicalizeProjectRoot(projectRoot);
  try {
    const client = await options.connect();
    if (client.projectRoot !== canonicalProjectRoot) {
      await client.close();
      throw new Error('control daemon project mismatch');
    }
    return client;
  } catch {
    const spawnProcess = options.spawn ?? spawn;
    const child = spawnProcess(
      process.execPath,
      [options.executable, 'daemon', '--project-root', canonicalProjectRoot],
      { detached: true, stdio: 'ignore' } satisfies SpawnOptions,
    );
    child.unref();
  }

  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    await sleep(100);
    try {
      const client = await options.connect();
      if (client.projectRoot !== canonicalProjectRoot) {
        await client.close();
        throw new Error('control daemon project mismatch');
      }
      return client;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `psyche control daemon did not become ready: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}
```

Call it from `src/index.ts` before constructing mutating TUI and bridge
dependencies. The function:

1. checks daemon health on the configured local port;
2. starts `node <resolved-dist>/index.js daemon --project-root <root>` as a
   detached child when absent;
3. waits up to five seconds for authenticated health;
4. returns a connected `ControlClient`;
5. surfaces an actionable error without falling back to direct mutation.

Do not kill the daemon when the TUI exits. The owner is intentionally
long-lived and must reconcile existing tmux state after UI restart.

- [ ] **Step 4: Replace TUI orchestration execution**

Create `src/orchestration/controlAdapter.ts`:

```ts
import type { ControlCommand } from '../control/types.js';
import type { AgentName } from '../utils/agentLaunch.js';
import { buildMultiAgentTaskRequest } from './adapters.js';

export interface TuiProvisionInput {
  commandId: string;
  idempotencyKey: string;
  projectRoot: string;
  taskId: string;
  prompt: string;
  agents: AgentName[];
  concurrency?: number;
  startPointBranch?: string;
}

export function buildTuiProvisionCommand(
  input: TuiProvisionInput,
): Omit<Extract<ControlCommand, { kind: 'orchestration.execute' }>, 'ownerEpoch'> {
  return {
    id: input.commandId,
    idempotencyKey: input.idempotencyKey,
    kind: 'orchestration.execute',
    projectRoot: input.projectRoot,
    createdAt: new Date().toISOString(),
    payload: {
      request: buildMultiAgentTaskRequest({
        taskId: input.taskId,
        projectRoot: input.projectRoot,
        prompt: input.prompt,
        agents: input.agents,
        concurrency: input.concurrency,
        startPointBranch: input.startPointBranch,
      }),
    },
  };
}
```

In `src/hooks/usePaneCreation.ts`, inject `ControlClient` and submit the result
of `buildTuiProvisionCommand()` instead of constructing this object inline:

```ts
{
  kind: 'orchestration.execute',
  payload: {
    request: buildMultiAgentTaskRequest({
      taskId,
      projectRoot,
      prompt,
      agents,
      startPointBranch,
      concurrency,
    }),
  },
}
```

Use the returned provisioning result to preserve existing status messages,
partial outcomes, pane persistence, and pruning behavior. Remove direct
construction of `createLocalPaneBackend` and `Orchestrator`.

Route every remaining client-side mutation reported by
`controlMutationBoundaries.test.ts`:

- `src/hooks/usePaneRunner.ts`, `src/hooks/usePaneLoading.ts`, and
  `src/PsycheApp.tsx` use `pane.terminal.open`, `pane.takeover`, `pane.input`,
  `pane.focus`, `pane.respawn`, and `pane.option.update`;
- `src/hooks/useInputHandling.ts` uses `coven.session.launch`,
  `coven.session.open`, `pane.terminal.open`, `pane.takeover`, `pane.input`,
  and shared-worktree `orchestration.execute` for agent attachment;
- `src/hooks/useWorktreeActions.ts` uses `pane.kill`;
- close and merge action modules use `pane.kill`, `pane.respawn`,
  `pane.terminal.open`, and host-owned conflict-pane commands;
- `src/utils/asciiArt.ts` receives a host input capability instead of
  `TmuxService`;
- `src/utils/resumeBranches.ts` submits provisioning through
  `orchestration.execute`;
- `src/index.ts` starts or connects to the daemon before tmux session creation;
  the host invokes `sessionBootstrap.ts`, and the TUI uses `ControlClient` for
  every lane mutation;
- `src/services/StatusDetector.ts` forwards requested input to the host client
  instead of a worker mutation message;
- `src/services/PopupManager.ts` and `src/services/PsycheFocusService.ts` use
  host focus and pane-option commands;
- `src/workers/PaneWorker.ts` stops accepting `send-keys` and `resize`
  mutation messages;
- strip `sendKeysHex`, `resizePane`, and `killPane` from
  `src/services/bridge/tmuxControl.ts`; it remains a read-only output observer
  until the unified terminal stream replaces it.

Keep low-level mutation implementations in the host-owned adapter graph
(`src/control/host.ts`, `src/daemon/tmuxControl.ts`,
`src/daemon/bridge.ts`, and the orchestration backends). No UI, bridge, MCP, or
worker module may import them.

- [ ] **Step 5: Run TUI and orchestration tests**

Run:

```bash
pnpm exec vitest --run \
  __tests__/controlHostProcess.test.ts \
  __tests__/orchestrationControlAdapter.test.ts \
  __tests__/controlMutationBoundaries.test.ts \
  __tests__/orchestrationPlanner.test.ts \
  __tests__/orchestrator.test.ts \
  __tests__/orchestrationAdapters.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/control/hostProcess.ts src/orchestration/controlAdapter.ts \
  src/index.ts src/PsycheApp.tsx \
  src/hooks/usePaneCreation.ts src/hooks/usePaneRunner.ts \
  src/hooks/useInputHandling.ts src/hooks/usePaneLoading.ts \
  src/hooks/useWorktreeActions.ts \
  src/actions/implementations/closeAction.ts \
  src/actions/implementations/index.ts \
  src/actions/merge/conflictResolution.ts \
  src/actions/merge/multiMergeOrchestrator.ts \
  src/actions/merge/mergeExecution.ts \
  src/actions/merge/issueHandlers/mergeConflictHandler.ts \
  src/utils/asciiArt.ts src/utils/resumeBranches.ts \
  src/services/PopupManager.ts src/services/PsycheFocusService.ts \
  src/services/StatusDetector.ts src/workers/PaneWorker.ts \
  src/services/bridge/tmuxControl.ts \
  __tests__/controlHostProcess.test.ts \
  __tests__/orchestrationControlAdapter.test.ts \
  __tests__/controlMutationBoundaries.test.ts
git commit -m "refactor: route TUI provisioning through the host owner" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 11: Prove Restart, Takeover, and Compatibility

**Files:**
- Create: `__tests__/fixtures/integration/controlPlane.ts`
- Create: `__tests__/controlPlane.integration.test.ts`
- Modify: `docs/PRODUCT-SPEC.md`
- Modify: `docs/SMOKE.md`

- [ ] **Step 1: Build an isolated integration fixture**

Create `__tests__/fixtures/integration/controlPlane.ts` that:

- creates a temporary Git repository;
- launches an isolated tmux server with a unique socket;
- starts the Psyche daemon against that project;
- returns a connected `ControlClient`;
- records daemon PID and owner epoch;
- shuts down only fixture-owned processes by exact PID;
- removes only the fixture directory.

- [ ] **Step 2: Write the end-to-end Program A tests**

Create `__tests__/controlPlane.integration.test.ts` with:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { startControlPlaneFixture } from './fixtures/integration/controlPlane.js';

const fixtures: Awaited<ReturnType<typeof startControlPlaneFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.stop()));
});

describe('Psyche host control plane', () => {
  it('deduplicates creation and preserves resources across restart', async () => {
    const fixture = await startControlPlaneFixture();
    fixtures.push(fixture);
    const command = fixture.orchestrationCommand({
      id: 'cmd-create',
      idempotencyKey: 'idem-create',
      agents: ['codex', 'claude'],
    });
    const first = await fixture.client.submit(command);
    const duplicate = await fixture.client.submit({ ...command, id: 'cmd-duplicate' });
    expect(duplicate).toEqual(first);
    const before = await fixture.listPanes();
    const previousEpoch = fixture.epoch;
    await fixture.restartDaemon();
    expect(fixture.epoch).toBe(previousEpoch + 1);
    expect(await fixture.listPanes()).toEqual(before);
  });

  it('never replays an ambiguous prompt after restart', async () => {
    const fixture = await startControlPlaneFixture({ ambiguousPrompt: true });
    fixtures.push(fixture);
    const outcome = await fixture.client.submit(fixture.promptCommand('prompt-1'));
    expect(outcome.status).toBe('unknown');
    await fixture.restartDaemon();
    const repeated = await fixture.client.submit(fixture.promptCommand('prompt-1'));
    expect(repeated.status).toBe('unknown');
    expect(await fixture.promptDispatchCount('prompt-1')).toBe(1);
  });

  it('fences automation before protocol-observed human input', async () => {
    const fixture = await startControlPlaneFixture();
    fixtures.push(fixture);
    const automation = await fixture.delegate('%3', 'psyche-1', 'task-1');
    const takeover = await fixture.takeover('%3', 'human-1');
    await expect(fixture.sendAutomationInput('%3', automation.revision, 'continue'))
      .resolves.toMatchObject({ status: 'rejected' });
    await expect(fixture.sendHumanInput('%3', takeover.revision, 'status'))
      .resolves.toMatchObject({ status: 'succeeded' });
  });

  it('uses operator delegation before an MCP agent prompt', async () => {
    const fixture = await startControlPlaneFixture();
    fixtures.push(fixture);
    const lease = await fixture.operatorClient.submit({
      id: 'cmd-delegate',
      idempotencyKey: 'idem-delegate',
      kind: 'pane.delegate',
      projectRoot: fixture.projectRoot,
      createdAt: new Date().toISOString(),
      payload: {
        paneId: '%3',
        automationActorId: fixture.mcpPrincipal.id,
        taskId: 'task-1',
        ttlMs: 60_000,
      },
    });
    const outcome = await fixture.callMcp('psyche_send_prompt', {
      pane_id: '%3',
      prompt_id: 'prompt-mcp-1',
      idempotency_key: 'idem-mcp-1',
      prompt: 'continue',
      lease_revision: fixture.requireLeaseRevision(lease),
      submit: true,
    });
    expect(outcome.status).toMatch(/confirmed|dispatched/);
  });

  it('rejects a stale client and preserves adapter identity', async () => {
    const fixture = await startControlPlaneFixture();
    fixtures.push(fixture);
    const staleEpoch = fixture.epoch;
    await fixture.restartDaemon();
    await expect(fixture.rawSubmit({
      ...fixture.takeoverCommand('%3'),
      ownerEpoch: staleEpoch,
    }))
      .resolves.toMatchObject({ status: 'rejected', code: 'stale_owner_epoch' });
    const canonical = await fixture.createViaCanonical();
    expect(await fixture.createViaV0()).toMatchObject(canonical.identity);
    expect(await fixture.createViaV2()).toMatchObject(canonical.identity);
    expect(await fixture.createViaMcp()).toMatchObject(canonical.identity);
  });

  it('treats a symlink alias as the same owned project', async () => {
    const fixture = await startControlPlaneFixture();
    fixtures.push(fixture);
    const alias = await fixture.createProjectSymlink();
    await expect(fixture.startSecondDaemon(alias))
      .rejects.toThrow('already owned');
    expect(fixture.endpointFor(alias)).toBe(fixture.endpointFor(fixture.projectRoot));
    const aliasClient = await fixture.connect(alias);
    expect(aliasClient.projectRoot).toBe(fixture.projectRoot);
    await aliasClient.close();
  });

  it('bootstraps tmux exactly once under concurrent startup', async () => {
    const fixture = await startControlPlaneFixture({ deferDaemonStart: true });
    fixtures.push(fixture);
    const starts = await Promise.allSettled([
      fixture.startDaemon(),
      fixture.startDaemon(),
    ]);
    expect(starts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await fixture.bootstrapCount()).toBe(1);
  });

  it('rejects path escapes and foreign pane identities before side effects', async () => {
    const fixture = await startControlPlaneFixture();
    fixtures.push(fixture);
    await expect(fixture.client.submit(fixture.openTerminalCommand('/tmp')))
      .resolves.toMatchObject({ status: 'rejected', code: 'project_scope_violation' });
    await expect(fixture.client.submit(fixture.killPaneCommand('%foreign')))
      .resolves.toMatchObject({ status: 'rejected', code: 'pane_not_owned' });
    expect(await fixture.tmuxMutationCount()).toBe(0);
  });
});
```

Construct the host with `HostControlPlaneOptions` injections for
`executeOrchestration`, pane mutation handlers, and prompt transport. The
orchestration injection returns deterministic pane identities for the valid
registered agent ids `codex` and `claude` without requiring either CLI to be
installed. The prompt transport uses fixture-owned fake harness processes that
print `PSYCHE_READY <revision>` and `PSYCHE_RECEIPT <prompt-id>` markers. Add
one generic shell lane and assert that prompts without a receipt return only
`dispatched` or `unknown`, never `confirmed`.

- [ ] **Step 3: Run the integration test**

Run:

```bash
pnpm exec vitest --run __tests__/controlPlane.integration.test.ts
```

Expected: PASS with no surviving fixture process, tmux server, or temp
directory.

- [ ] **Step 4: Update product and smoke documentation**

In `docs/PRODUCT-SPEC.md`, state:

- orchestration `completed` means resource provisioning completed;
- coding-task completion belongs to the future SoulTask runtime;
- the daemon is the sole mutation owner;
- direct tmux attachment bypasses takeover fencing and is unsafe during
  delegated automation.

In `docs/SMOKE.md`, add a control-plane section that verifies daemon ownership,
MCP mutation routing, takeover, restart epoch change, and no prompt replay.

- [ ] **Step 5: Run the focused Program A suite**

Run:

```bash
pnpm exec vitest --run \
  __tests__/controlProtocol.test.ts \
  __tests__/controlOwnerLock.test.ts \
  __tests__/controlJournal.test.ts \
  __tests__/controlLeases.test.ts \
  __tests__/controlPromptDispatch.test.ts \
  __tests__/controlRuntime.test.ts \
  __tests__/controlClient.test.ts \
  __tests__/controlMutationBoundaries.test.ts \
  __tests__/controlPlane.integration.test.ts \
  __tests__/daemon \
  __tests__/bridge \
  __tests__/mcpServer.test.ts \
  __tests__/controlHostProcess.test.ts \
  __tests__/orchestrationControlAdapter.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run repository quality gates**

Run:

```bash
pnpm run typecheck
pnpm test
pnpm run build
pnpm smoke
npm pack --dry-run
```

Expected: all commands exit 0.

- [ ] **Step 7: Run the bypass audit**

Run:

```bash
rg -n \
  "spawnBridgePane|killBridgePane|sendKeysHex|createLocalPaneBackend|new Orchestrator" \
  src/mcp src/services/bridge src/hooks
```

Expected: no mutating client imports. Read-only stream implementations may
reference tmux output types but not mutation functions.

- [ ] **Step 8: Commit**

```bash
git add __tests__/fixtures/integration/controlPlane.ts \
  __tests__/controlPlane.integration.test.ts \
  docs/PRODUCT-SPEC.md docs/SMOKE.md
git commit -m "test: prove the Psyche host control plane" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Final Program A Acceptance

Program A is complete only when all of the following are true:

- exactly one process owns the project mutation lock and owner epoch;
- a second live owner fails closed;
- two different project owners can run concurrently without endpoint or port
  collision;
- daemon restart increments the epoch and reconciles without recreating or
  deleting panes or worktrees;
- every mutating v0, v2, MCP, and TUI path reaches `ControlRuntime`;
- no compatibility adapter imports direct tmux/worktree/Coven mutation
  primitives;
- duplicate idempotency keys return the original result;
- an ambiguous prompt is never replayed;
- prompt confirmation requires a harness receipt;
- protocol-observed human takeover revokes the automation lease before input;
- direct out-of-band tmux input is documented as outside the fencing guarantee;
- provisioning completion is not represented as coding-task completion;
- the focused integration suite and every repository quality gate pass.
