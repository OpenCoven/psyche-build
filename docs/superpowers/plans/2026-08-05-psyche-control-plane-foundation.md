# Psyche Control-Plane Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the trustworthy host boundary for the Psyche soul orchestrator as pure, fully unit-tested `src/control/` modules with zero runtime behavior change.

**Architecture:** Six leaf modules under `src/control/` — canonical contract (`types.ts`, `protocol.ts`), project identity + owner fencing (`projectIdentity.ts`, `ownerLock.ts`), durable journal (`journal.ts`), lane leases + scope (`leases.ts`, `scope.ts`), and no-replay prompt dispatch (`promptDispatch.ts`). Nothing is imported by the daemon, bridge, MCP, TUI, or cockpit yet; the modules are additive and proven independently.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node `fs/promises`/`crypto`, Vitest. Commands run via `pnpm exec vitest`, `pnpm typecheck`, `pnpm build`, `pnpm smoke`.

**Spec:** `docs/superpowers/specs/2026-08-05-psyche-control-plane-foundation-design.md`
**Parent plan:** `docs/superpowers/plans/2026-08-03-psyche-host-control-plane.md` (this is the foundation subset, Tasks 1–5, with the Task 5 `tmuxControl.ts` change deferred to the wiring PR).

**Every commit uses the trailer:** `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`

---

## File Structure

- Create: `src/control/types.ts` — shared vocabulary (commands, actors, envelopes, outcomes, snapshot). No logic/I/O.
- Create: `src/control/protocol.ts` — versioned codec over `types.ts`; deterministic encode, validated decode.
- Create: `src/control/projectIdentity.ts` — single `realpath`+NFC canonicalization primitive.
- Create: `src/control/ownerLock.ts` — exclusive owner acquisition with monotonic epochs; fail-closed.
- Create: `src/control/journal.ts` — single-writer NDJSON journal, replay, idempotency, snapshots.
- Create: `src/control/leases.ts` — in-memory lane leases + explicit human takeover.
- Create: `src/control/scope.ts` — path/pane/session containment gate.
- Create: `src/control/promptDispatch.ts` — pure dispatch-outcome mapper (hash verify + no-replay).
- Create: `protocol-fixtures/control-v1/command-submit.json`, `protocol-fixtures/control-v1/command-result.json`.
- Create tests: `__tests__/controlProtocol.test.ts`, `__tests__/controlProjectIdentity.test.ts`, `__tests__/controlOwnerLock.test.ts`, `__tests__/controlJournal.test.ts`, `__tests__/controlLeases.test.ts`, `__tests__/controlScope.test.ts`, `__tests__/controlPromptDispatch.test.ts`.
- Dependency on existing code: `src/orchestration/types.ts` (imports `OrchestrationTaskRequest`) — read-only, unchanged.

**Deferred to the wiring PR (NOT in this plan):** modifying `src/daemon/tmuxControl.ts` and `__tests__/daemon/tmuxControl.test.ts` (parent Task 5 Step 4), plus all of parent Tasks 6–11.

---

## Task 1: Define the Canonical Control Contract

**Files:**
- Create: `src/control/types.ts`
- Create: `src/control/protocol.ts`
- Test: `__tests__/controlProtocol.test.ts`
- Create: `protocol-fixtures/control-v1/command-submit.json`
- Create: `protocol-fixtures/control-v1/command-result.json`

- [ ] **Step 1: Write the failing protocol test**

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

Run: `pnpm exec vitest --run __tests__/controlProtocol.test.ts`
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
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
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
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid control request envelope');
  }
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

Run: `pnpm exec vitest --run __tests__/controlProtocol.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/control/types.ts src/control/protocol.ts \
  __tests__/controlProtocol.test.ts protocol-fixtures/control-v1
git commit -m "feat: define canonical control protocol" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: Fence the Single Host Owner

**Files:**
- Create: `src/control/projectIdentity.ts`
- Create: `src/control/ownerLock.ts`
- Test: `__tests__/controlProjectIdentity.test.ts`
- Test: `__tests__/controlOwnerLock.test.ts`

- [ ] **Step 1: Write the failing project-identity test**

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

- [ ] **Step 2: Write the failing owner-lock test**

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

- [ ] **Step 3: Run the tests and verify they fail**

Run: `pnpm exec vitest --run __tests__/controlProjectIdentity.test.ts __tests__/controlOwnerLock.test.ts`
Expected: FAIL because `src/control/projectIdentity.ts` and `src/control/ownerLock.ts` do not exist.

- [ ] **Step 4: Implement canonical project identity**

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

- [ ] **Step 5: Implement exclusive acquisition and epochs**

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

  let epoch: number;
  try {
    epoch = await nextEpoch(epochPath);
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
  } catch (error) {
    await rm(lockDir, { recursive: true, force: true });
    throw error;
  }

  return {
    epoch,
    nonce,
    release: async () => {
      let current: OwnerRecord;
      try {
        current = JSON.parse(await readFile(recordPath, 'utf8')) as OwnerRecord;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      if (current.nonce === nonce) await rm(lockDir, { recursive: true, force: true });
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

- [ ] **Step 6: Run the ownership tests**

Run: `pnpm exec vitest --run __tests__/controlProjectIdentity.test.ts __tests__/controlOwnerLock.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/control/projectIdentity.ts src/control/ownerLock.ts \
  __tests__/controlProjectIdentity.test.ts __tests__/controlOwnerLock.test.ts
git commit -m "feat: fence the Psyche host owner" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: Add the Durable Command Journal

**Files:**
- Create: `src/control/journal.ts`
- Test: `__tests__/controlJournal.test.ts`

- [ ] **Step 1: Write the failing journal tests**

Create `__tests__/controlJournal.test.ts`:

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

Run: `pnpm exec vitest --run __tests__/controlJournal.test.ts`
Expected: FAIL because `src/control/journal.ts` does not exist.

- [ ] **Step 3: Implement the journal**

Create `src/control/journal.ts`. It must expose exactly this public surface and satisfy the behaviors below:

```ts
import { mkdir, open, readFile, rename, stat, truncate } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ControlSnapshot } from './types.js';

export interface ControlEvent {
  sequence: number;
  id: string;
  ownerEpoch: number;
  timestamp: string;
  kind: string;
  payload: Record<string, unknown>;
}

type EventListener = (event: ControlEvent) => void;

export class ControlJournal {
  readonly path: string;
  private readonly snapshotPath: string;
  private currentSequence: number;
  private readonly ownerEpoch: number;
  private readonly events: ControlEvent[];
  private readonly idempotencyIndex = new Map<string, ControlEvent>();
  private readonly listeners = new Set<EventListener>();
  private appendTail: Promise<void> = Promise.resolve();

  private constructor(
    journalPath: string,
    snapshotPath: string,
    ownerEpoch: number,
    events: ControlEvent[],
  ) {
    this.path = journalPath;
    this.snapshotPath = snapshotPath;
    this.ownerEpoch = ownerEpoch;
    this.events = events;
    this.currentSequence = events.length > 0 ? events[events.length - 1].sequence : 0;
    for (const event of events) this.indexIdempotency(event);
  }

  static async open(projectRoot: string, ownerEpoch: number): Promise<ControlJournal> {
    const runtimeDir = path.join(projectRoot, '.psyche', 'runtime');
    await mkdir(runtimeDir, { recursive: true });
    const journalPath = path.join(runtimeDir, 'events.ndjson');
    const snapshotPath = path.join(runtimeDir, 'snapshot.json');
    const events = await ControlJournal.replay(journalPath);
    return new ControlJournal(journalPath, snapshotPath, ownerEpoch, events);
  }

  private static async replay(journalPath: string): Promise<ControlEvent[]> {
    let raw: Buffer;
    try {
      raw = await readFile(journalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (raw.length === 0) return [];
    const endsWithNewline = raw[raw.length - 1] === 0x0a;
    const segments: Buffer[] = [];
    let start = 0;
    for (let index = 0; index < raw.length; index += 1) {
      if (raw[index] === 0x0a) {
        segments.push(raw.subarray(start, index));
        start = index + 1;
      }
    }
    if (start < raw.length) segments.push(raw.subarray(start));
    while (segments.length > 0 && segments[segments.length - 1].length === 0) {
      segments.pop();
    }
    const events: ControlEvent[] = [];
    let expectedSequence = 1;
    for (let index = 0; index < segments.length; index += 1) {
      const isLastLine = index === segments.length - 1;
      const lineBuffer = segments[index];
      let parsed: ControlEvent;
      try {
        parsed = JSON.parse(lineBuffer.toString('utf8')) as ControlEvent;
      } catch (error) {
        if (isLastLine && !endsWithNewline) {
          await truncate(journalPath, raw.length - lineBuffer.length);
          break;
        }
        throw new Error(`journal corruption at line ${index + 1}`);
      }
      if (parsed.sequence !== expectedSequence) {
        throw new Error(`journal corruption at line ${index + 1}`);
      }
      events.push(parsed);
      expectedSequence += 1;
    }
    return events;
  }

  get sequence(): number {
    return this.currentSequence;
  }

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
      this.currentSequence = event.sequence;
      this.events.push(event);
      this.indexIdempotency(event);
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          // A subscriber error must not undo a durably committed append.
        }
      }
      resolveEvent(event);
    }).catch((error) => {
      rejectEvent(error);
    });
    return result;
  }

  read(afterSequence: number, limit?: number): ControlEvent[] {
    const slice = this.events.filter((event) => event.sequence > afterSequence);
    return typeof limit === 'number' ? slice.slice(0, limit) : slice;
  }

  findByIdempotencyKey(key: string): ControlEvent | undefined {
    return this.idempotencyIndex.get(key);
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async loadSnapshot(): Promise<(ControlSnapshot & { coveredSequence: number }) | undefined> {
    try {
      const raw = await readFile(this.snapshotPath, 'utf8');
      return JSON.parse(raw) as ControlSnapshot & { coveredSequence: number };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async writeSnapshot(snapshot: ControlSnapshot, coveredSequence: number): Promise<void> {
    const temporary = `${this.snapshotPath}.${process.pid}.tmp`;
    const handle = await open(temporary, 'w');
    try {
      await handle.writeFile(JSON.stringify({ ...snapshot, coveredSequence }), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.snapshotPath);
  }

  async recoverNonterminalCommands(): Promise<ControlEvent[]> {
    const terminalByCommand = new Map<string, boolean>();
    const nonterminal = new Map<string, ControlEvent>();
    const terminalKinds = new Set(['command.succeeded', 'command.failed', 'command.unknown', 'command.rejected']);
    const openKinds = new Set(['command.requested', 'command.accepted', 'command.running']);
    for (const event of this.events) {
      const commandId = event.payload.commandId as string | undefined;
      if (!commandId) continue;
      if (terminalKinds.has(event.kind)) terminalByCommand.set(commandId, true);
      else if (openKinds.has(event.kind)) nonterminal.set(commandId, event);
    }
    const recovered: ControlEvent[] = [];
    for (const [commandId, event] of nonterminal) {
      if (terminalByCommand.get(commandId)) continue;
      recovered.push(await this.append('command.unknown', {
        commandId,
        idempotencyKey: event.payload.idempotencyKey,
        reason: 'recovered-nonterminal',
      }));
    }
    return recovered;
  }

  private buildNextEvent(kind: string, payload: Record<string, unknown>): ControlEvent {
    return {
      sequence: this.currentSequence + 1,
      id: randomUUID(),
      ownerEpoch: this.ownerEpoch,
      timestamp: new Date().toISOString(),
      kind,
      payload,
    };
  }

  private indexIdempotency(event: ControlEvent): void {
    const key = event.payload.idempotencyKey as string | undefined;
    if (key) this.idempotencyIndex.set(key, event);
  }
}
```

Note: `stat` is imported for symmetry with future snapshot sizing; if `pnpm typecheck` flags it as unused, remove it from the import line before committing.

- [ ] **Step 4: Run the journal tests**

Run: `pnpm exec vitest --run __tests__/controlJournal.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/control/journal.ts __tests__/controlJournal.test.ts
git commit -m "feat: add the control command journal" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: Add Lane Leases and Scope Validation

**Files:**
- Create: `src/control/leases.ts`
- Create: `src/control/scope.ts`
- Test: `__tests__/controlLeases.test.ts`
- Test: `__tests__/controlScope.test.ts`

- [ ] **Step 1: Write the failing lease test**

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

- [ ] **Step 2: Write the failing scope test**

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

- [ ] **Step 3: Run the tests and verify they fail**

Run: `pnpm exec vitest --run __tests__/controlLeases.test.ts __tests__/controlScope.test.ts`
Expected: FAIL because `src/control/leases.ts` and `src/control/scope.ts` do not exist.

- [ ] **Step 4: Implement the lease store**

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

- [ ] **Step 5: Implement the scope gate**

Create `src/control/scope.ts`:

```ts
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { canonicalizeProjectRoot } from './projectIdentity.js';

export interface RegisteredPane {
  paneId: string;
  cwd: string;
}

export interface ControlScopeInput {
  panes?: RegisteredPane[];
  worktrees?: string[];
  sessionIds?: string[];
}

function isContained(parent: string, candidate: string): boolean {
  if (candidate === parent) return true;
  const relative = path.relative(parent, candidate);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export class ControlScope {
  private constructor(
    private readonly canonicalRoot: string,
    private readonly panes: Map<string, RegisteredPane>,
    private readonly sessionIds: Set<string>,
    private readonly worktrees: string[],
  ) {}

  static async create(projectRoot: string, input: ControlScopeInput = {}): Promise<ControlScope> {
    const canonicalRoot = await canonicalizeProjectRoot(projectRoot);
    const panes = new Map<string, RegisteredPane>();
    for (const pane of input.panes ?? []) panes.set(pane.paneId, pane);
    const worktrees: string[] = [];
    for (const worktree of input.worktrees ?? []) {
      const canonicalWorktree = await realpath(path.resolve(worktree));
      if (isContained(canonicalRoot, canonicalWorktree)) worktrees.push(canonicalWorktree);
    }
    return new ControlScope(
      canonicalRoot,
      panes,
      new Set(input.sessionIds ?? []),
      worktrees,
    );
  }

  async requireContainedPath(candidate: string): Promise<string> {
    let resolved: string;
    try {
      resolved = await realpath(path.resolve(candidate));
    } catch {
      resolved = path.resolve(candidate);
    }
    if (isContained(this.canonicalRoot, resolved)) return resolved;
    for (const worktree of this.worktrees) {
      if (isContained(worktree, resolved)) return resolved;
    }
    throw new Error(`path is outside the canonical project: ${candidate}`);
  }

  requireOwnedPane(paneId: string): RegisteredPane {
    const pane = this.panes.get(paneId);
    if (!pane) throw new Error(`pane is not owned by this project: ${paneId}`);
    return pane;
  }

  requireRegisteredSession(sessionId: string): string {
    if (!this.sessionIds.has(sessionId)) {
      throw new Error(`session is not owned by this project: ${sessionId}`);
    }
    return sessionId;
  }
}
```

- [ ] **Step 6: Run the lease and scope tests**

Run: `pnpm exec vitest --run __tests__/controlLeases.test.ts __tests__/controlScope.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/control/leases.ts src/control/scope.ts \
  __tests__/controlLeases.test.ts __tests__/controlScope.test.ts
git commit -m "feat: add terminal controller leases and scope" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 5: Add No-Replay Prompt Dispatch (pure module)

> **Scope note:** The parent plan's Task 5 also modifies `src/daemon/tmuxControl.ts` to perform acknowledged control-mode submission. That live-code change is **deferred to the wiring PR** to keep this slice behavior-neutral. This task ships only the pure `promptDispatch.ts` module and its unit test.

**Files:**
- Create: `src/control/promptDispatch.ts`
- Test: `__tests__/controlPromptDispatch.test.ts`

- [ ] **Step 1: Write the failing prompt-dispatch test**

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

  it('fails a dispatch whose content hash does not match', async () => {
    const send = vi.fn(async () => {});
    const dispatcher = new PromptDispatcher(send);
    const tampered = { ...envelope(), contentHash: 'deadbeef' };
    expect(await dispatcher.dispatch(tampered)).toMatchObject({
      status: 'failed',
      code: 'prompt_hash_mismatch',
    });
    expect(send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm exec vitest --run __tests__/controlPromptDispatch.test.ts`
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

- [ ] **Step 4: Run the prompt-dispatch test**

Run: `pnpm exec vitest --run __tests__/controlPromptDispatch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/control/promptDispatch.ts __tests__/controlPromptDispatch.test.ts
git commit -m "feat: add no-replay prompt dispatch module" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 6: Full-Slice Validation and PR

**Files:** none created; validation only.

- [ ] **Step 1: Type-check the whole project**

Run: `pnpm typecheck`
Expected: PASS with no new errors. If an unused import is flagged (e.g. `stat` in `journal.ts`), remove it and amend the Task 3 commit.

- [ ] **Step 2: Run the focused control suite**

Run:

```bash
pnpm exec vitest --run \
  __tests__/controlProtocol.test.ts \
  __tests__/controlProjectIdentity.test.ts \
  __tests__/controlOwnerLock.test.ts \
  __tests__/controlJournal.test.ts \
  __tests__/controlLeases.test.ts \
  __tests__/controlScope.test.ts \
  __tests__/controlPromptDispatch.test.ts
```

Expected: all PASS.

- [ ] **Step 3: Run the full test suite**

Run: `pnpm test`
Expected: PASS, no regressions (this slice adds only new files).

- [ ] **Step 4: Run the smoke test**

Run: `pnpm smoke`
Expected: PASS (unchanged cockpit behavior).

- [ ] **Step 5: Build**

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 6: Push and open the PR**

```bash
git push -u origin feat/control-foundation
```

Open a PR to `main` titled `feat: Psyche control-plane foundation (Tasks 1-5)`. In the body, link the spec and parent plan, list the seven new modules and tests, and state the acceptance results (single-owner fencing, epoch monotonicity, journal idempotency, no-replay dispatch, zero behavior change; typecheck/tests/smoke/build green).

---

## Acceptance Criteria (Foundation Slice)

- Single-owner fencing: a second live owner fails closed (`already owned`).
- Epoch monotonicity: replacing a dead owner increments the epoch; exactly one contender wins a stale-lock race; a provisional lock is recovered.
- Journal idempotency: duplicate idempotency keys resolve to the latest terminal event; corruption before the final line aborts `open()`; only a trailing partial line is truncated.
- No-replay dispatch: a valid prompt dispatches once; a hash mismatch fails without sending; ambiguous acceptance maps to `unknown`.
- Zero behavior change: no file under `src/daemon/`, `src/mcp/`, `src/services/bridge/`, `src/hooks/`, or the cockpit is modified; `pnpm smoke` and the full suite behave as on `main`.
- `pnpm typecheck`, `pnpm test`, `pnpm smoke`, and `pnpm build` are green.
