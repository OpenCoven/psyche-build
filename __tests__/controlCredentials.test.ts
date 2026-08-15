import { spawn } from 'node:child_process';
import {
  access,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createControlCredentialStore as createControlCredentialStoreInternal,
  createControlCredentialStoreForCanonicalRoot as createControlCredentialStoreForCanonicalRootInternal,
  fingerprintControlToken,
  issueControlTaskCredential as issueControlTaskCredentialInternal,
  issueControlTaskToken as issueControlTaskTokenInternal,
  revokeControlTaskCredential as revokeControlTaskCredentialInternal,
  type CredentialCreationOps,
} from '../src/control/credentials.js';
import { ControlClient } from '../src/control/client.js';
import { ControlServer, createControlServerForTest } from '../src/control/server.js';
import type { ControlServerRuntime } from '../src/control/server.js';
import type { ControlCommand, ControlCommandInput, ControlSnapshot } from '../src/control/types.js';
import type { ControlPrincipal } from '../src/control/credentials.js';
import { createRedactedApprovalEffect } from '../src/control/approvals.js';
import {
  resolveControlCredentialPaths,
  taskCredentialRecordPath as credentialRecordPathForDirectory,
} from '../src/control/credentialPaths.js';
import {
  cleanupTestControlStatePaths,
  createIsolatedTestControlStatePaths,
  testControlStateRoot,
  testResolvedControlCredentialPaths,
  type TestControlStatePaths,
  testTaskCredentialDirectory,
  testTaskCredentialLockDirectory,
} from './helpers/controlCredentialPaths.js';
import { createTaskScopedControlHarness } from './helpers/taskScopedControlHarness.js';

let tempRoots: TestControlStatePaths[] = [];
const taskCredentialWorkerPath = fileURLToPath(new URL('./helpers/taskCredentialWorker.ts', import.meta.url));
const SHORT_TASK_CREDENTIAL_LOCK_TIMEOUT_MS = 250;
const SHORT_TASK_CREDENTIAL_LOCK_POLL_INTERVAL_MS = 10;
const TASK_CREDENTIAL_LOCK_COMPLETION_BOUND_MS = 5_000;

async function tempProject(): Promise<string> {
  const fixture = await createIsolatedTestControlStatePaths('p');
  tempRoots.push(fixture);
  return fixture.projectRoot;
}

function credentialOptions(projectRoot: string, filePath?: string) {
  return {
    projectRoot,
    ...(filePath === undefined ? {} : { filePath }),
    stateRoot: testControlStateRoot(projectRoot),
  };
}

function canonicalCredentialOptions(canonicalProjectRoot: string, filePath?: string) {
  return {
    canonicalProjectRoot,
    ...(filePath === undefined ? {} : { filePath }),
    stateRoot: testControlStateRoot(canonicalProjectRoot),
  };
}

function taskCredentialDirectory(projectRoot: string, filePath?: string): string {
  return testTaskCredentialDirectory(projectRoot, filePath);
}

function taskCredentialLockDirectory(projectRoot: string, taskId: string, filePath?: string): string {
  return testTaskCredentialLockDirectory(projectRoot, taskId, filePath);
}

async function createControlCredentialStore(options: {
  projectRoot: string;
  filePath?: string;
}) {
  return createControlCredentialStoreInternal(credentialOptions(options.projectRoot, options.filePath));
}

async function createControlCredentialStoreForCanonicalRoot(options: {
  canonicalProjectRoot: string;
  filePath?: string;
  creationOps?: CredentialCreationOps;
}) {
  return createControlCredentialStoreForCanonicalRootInternal({
    ...canonicalCredentialOptions(options.canonicalProjectRoot, options.filePath),
    ...(options.creationOps === undefined ? {} : { creationOps: options.creationOps }),
  });
}

async function issueControlTaskToken(options: {
  projectRoot: string;
  taskId: string;
  filePath?: string;
}) {
  return issueControlTaskTokenInternal({
    ...credentialOptions(options.projectRoot, options.filePath),
    taskId: options.taskId,
  });
}

async function issueControlTaskCredential(options: {
  projectRoot: string;
  taskId: string;
  filePath?: string;
  previousSubjectId?: string;
}) {
  return issueControlTaskCredentialInternal({
    ...credentialOptions(options.projectRoot, options.filePath),
    taskId: options.taskId,
    ...(options.previousSubjectId === undefined ? {} : { previousSubjectId: options.previousSubjectId }),
  });
}

async function revokeControlTaskCredential(options: {
  projectRoot: string;
  taskId: string;
  filePath?: string;
  subjectId?: string;
}) {
  return revokeControlTaskCredentialInternal({
    ...credentialOptions(options.projectRoot, options.filePath),
    taskId: options.taskId,
    ...(options.subjectId === undefined ? {} : { subjectId: options.subjectId }),
  });
}

function taskCredentialRecordPath(directory: string, taskId: string): string {
  return credentialRecordPathForDirectory(directory, taskId);
}

async function seedTaskCredentialRecord(options: {
  directory: string;
  taskId: string;
  subjectId: string;
  token: string;
  issuedAt?: string;
}) {
  const principalId = `task-subject:${options.subjectId}`;
  const recordPath = taskCredentialRecordPath(options.directory, options.taskId);
  const record = {
    schema: 'psyche.control.task-credential/v1',
    taskId: options.taskId,
    subjectId: options.subjectId,
    principalId,
    tokenFingerprint: fingerprintControlToken(options.token),
    issuedAt: options.issuedAt ?? '2026-08-14T00:00:00.000Z',
  };
  const content = `${JSON.stringify(record)}\n`;
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  await writeFile(recordPath, content, { mode: 0o600 });
  return {
    recordPath,
    content,
    principalId,
    taskBinding: {
      taskId: options.taskId,
      subjectId: options.subjectId,
    },
  };
}

interface TaskCredentialWorkerResult {
  ok: boolean;
  result?: unknown;
  error?: { message: string; code?: string };
}

function taskCredentialReadyPath(directory: string, label: string): string {
  return path.join(directory, `${label}.ready.json`);
}

function taskCredentialGoPath(directory: string, label: string): string {
  return path.join(directory, `${label}.go`);
}

function spawnTaskCredentialWorker(options: {
  mode: 'issue' | 'revoke';
  projectRoot: string;
  filePath: string;
  taskId: string;
  subjectId?: string;
  hookPoint?:
    | 'before-issue-write'
    | 'before-revoke-delete'
    | 'after-lock-dir-snapshot'
    | 'after-recovery-claim'
    | 'recovery-claim-observed';
  hookLabel?: string;
  hookDirectory?: string;
  lockTimeoutMs?: number;
  lockPollIntervalMs?: number;
}) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', taskCredentialWorkerPath, options.mode, options.projectRoot, options.filePath, options.taskId, options.subjectId ?? ''],
    {
      env: {
        ...process.env,
        PSYCHE_CONTROL_TASK_CREDENTIAL_TEST_STATE_ROOT: testControlStateRoot(options.projectRoot),
        ...(options.hookDirectory ? { PSYCHE_CONTROL_TASK_CREDENTIAL_TEST_HOOK_DIR: options.hookDirectory } : {}),
        ...(options.hookLabel ? { PSYCHE_CONTROL_TASK_CREDENTIAL_TEST_HOOK_LABEL: options.hookLabel } : {}),
        ...(options.hookPoint ? { PSYCHE_CONTROL_TASK_CREDENTIAL_TEST_HOOK_POINT: options.hookPoint } : {}),
        ...(options.lockTimeoutMs
          ? { PSYCHE_CONTROL_TASK_CREDENTIAL_TEST_LOCK_TIMEOUT_MS: String(options.lockTimeoutMs) }
          : {}),
        ...(options.lockPollIntervalMs
          ? { PSYCHE_CONTROL_TASK_CREDENTIAL_TEST_LOCK_POLL_INTERVAL_MS: String(options.lockPollIntervalMs) }
          : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  const completed = new Promise<TaskCredentialWorkerResult>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      const line = stdout.trim().split('\n').filter(Boolean).at(-1);
      if (!line) {
        reject(new Error(`credential worker exited ${code ?? 'unknown'} without JSON output${stderr ? `: ${stderr.trim()}` : ''}`));
        return;
      }
      try {
        resolve(JSON.parse(line) as TaskCredentialWorkerResult);
      } catch (error) {
        reject(new Error(`credential worker emitted invalid JSON: ${line}\n${String(error)}\n${stderr.trim()}`));
      }
    });
  });
  return { child, completed };
}

async function waitForTaskCredentialReady(
  directory: string,
  label: string,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(taskCredentialReadyPath(directory, label));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

async function waitForTaskCredentialReadyPayload(
  directory: string,
  label: string,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(taskCredentialReadyPath(directory, label), 'utf8')) as Record<string, unknown>;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT'
        && !(error instanceof SyntaxError)
      ) throw error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for task credential ready payload: ${label}`);
}

async function waitForAnyTaskCredentialReady(
  directory: string,
  labels: readonly string[],
  timeoutMs = 5_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const label of labels) {
      if (await waitForTaskCredentialReady(directory, label, 1)) return label;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return null;
}

async function releaseTaskCredentialWorker(directory: string, label: string): Promise<void> {
  await writeFile(taskCredentialGoPath(directory, label), 'go\n', { mode: 0o600 });
}

async function seedStaleTaskCredentialMutationLock(options: {
  projectRoot?: string;
  filePath: string;
  taskId: string;
  lockNonce: string;
  claimNonce?: string;
}): Promise<{ lockDir: string; claimPath: string }> {
  const projectRoot = options.projectRoot ?? path.dirname(options.filePath);
  const lockDir = taskCredentialLockDirectory(projectRoot, options.taskId, options.filePath);
  await mkdir(lockDir, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(lockDir, 'lock.json'),
    `${JSON.stringify({
      pid: 9_999_991,
      nonce: options.lockNonce,
      taskId: options.taskId,
      operation: 'issue',
      acquiredAt: '2026-08-14T00:00:00.000Z',
    })}\n`,
    { mode: 0o600 },
  );
  const claimPath = path.join(lockDir, 'recovery.claim.json');
  if (options.claimNonce) {
    await writeFile(
      claimPath,
      `${JSON.stringify({
        pid: 9_999_992,
        claimerNonce: options.claimNonce,
        targetNonce: options.lockNonce,
        targetPid: 9_999_991,
        targetTaskId: options.taskId,
        targetOperation: 'issue',
        targetAcquiredAt: '2026-08-14T00:00:00.000Z',
        claimedAt: '2026-08-14T00:00:01.000Z',
      })}\n`,
      { mode: 0o600 },
    );
  }
  return { lockDir, claimPath };
}

async function withTaskCredentialLockTestTiming<T>(work: () => Promise<T>): Promise<T> {
  const previousTimeout = process.env.PSYCHE_CONTROL_TASK_CREDENTIAL_TEST_LOCK_TIMEOUT_MS;
  const previousPoll = process.env.PSYCHE_CONTROL_TASK_CREDENTIAL_TEST_LOCK_POLL_INTERVAL_MS;
  process.env.PSYCHE_CONTROL_TASK_CREDENTIAL_TEST_LOCK_TIMEOUT_MS = String(SHORT_TASK_CREDENTIAL_LOCK_TIMEOUT_MS);
  process.env.PSYCHE_CONTROL_TASK_CREDENTIAL_TEST_LOCK_POLL_INTERVAL_MS = String(SHORT_TASK_CREDENTIAL_LOCK_POLL_INTERVAL_MS);
  try {
    return await work();
  } finally {
    if (previousTimeout === undefined) delete process.env.PSYCHE_CONTROL_TASK_CREDENTIAL_TEST_LOCK_TIMEOUT_MS;
    else process.env.PSYCHE_CONTROL_TASK_CREDENTIAL_TEST_LOCK_TIMEOUT_MS = previousTimeout;
    if (previousPoll === undefined) delete process.env.PSYCHE_CONTROL_TASK_CREDENTIAL_TEST_LOCK_POLL_INTERVAL_MS;
    else process.env.PSYCHE_CONTROL_TASK_CREDENTIAL_TEST_LOCK_POLL_INTERVAL_MS = previousPoll;
  }
}

async function expectTaskCredentialMutationTimeout(work: () => Promise<unknown>): Promise<void> {
  const startedAt = Date.now();
  await expect(withTaskCredentialLockTestTiming(work)).rejects.toThrow(
    /Timed out waiting for task credential mutation lock/,
  );
  expect(Date.now() - startedAt).toBeLessThan(TASK_CREDENTIAL_LOCK_COMPLETION_BOUND_MS);
}

async function expectStaleCleanerFreshOwnerHandoff(): Promise<void> {
  const root = await tempProject();
  const filePath = path.join(root, 'control-credentials.json');
  const issued = await issueControlTaskCredential({
    projectRoot: root,
    filePath,
    taskId: 'task-own',
  });
  const barriers = path.join(root, 'credential-barriers-stale-cleaners');
  await mkdir(barriers, { recursive: true, mode: 0o700 });
  const { lockDir, claimPath } = await seedStaleTaskCredentialMutationLock({
    filePath,
    taskId: 'task-own',
    lockNonce: 'stale-lock-race',
  });

  const cleanerA = spawnTaskCredentialWorker({
    mode: 'issue',
    projectRoot: root,
    filePath,
    taskId: 'task-own',
    subjectId: issued.taskBinding.subjectId,
    hookPoint: 'after-recovery-claim',
    hookLabel: 'cleaner-a',
    hookDirectory: barriers,
  });
  const cleanerAReady = await waitForTaskCredentialReadyPayload(barriers, 'cleaner-a');
  expect(cleanerAReady).toMatchObject({
    point: 'after-recovery-claim',
    taskId: 'task-own',
    targetNonce: 'stale-lock-race',
  });

  const cleanerB = spawnTaskCredentialWorker({
    mode: 'issue',
    projectRoot: root,
    filePath,
    taskId: 'task-own',
    subjectId: issued.taskBinding.subjectId,
    hookPoint: 'recovery-claim-observed',
    hookLabel: 'cleaner-b',
    hookDirectory: barriers,
  });
  const cleanerBReady = await waitForTaskCredentialReadyPayload(barriers, 'cleaner-b');
  expect(cleanerBReady).toMatchObject({
    point: 'recovery-claim-observed',
    taskId: 'task-own',
    targetNonce: 'stale-lock-race',
    claimPid: cleanerAReady.pid,
  });
  await releaseTaskCredentialWorker(barriers, 'cleaner-a');
  const cleanerAResult = await cleanerA.completed;
  expect(cleanerAResult.ok).toBe(true);
  const rotated = cleanerAResult.result as {
    token: string;
    principalId: string;
    taskBinding: { taskId: string; subjectId: string };
  };

  const fresh = spawnTaskCredentialWorker({
    mode: 'revoke',
    projectRoot: root,
    filePath,
    taskId: 'task-own',
    hookPoint: 'before-revoke-delete',
    hookLabel: 'fresh',
    hookDirectory: barriers,
  });
  const freshReady = await waitForTaskCredentialReadyPayload(barriers, 'fresh');
  expect(freshReady).toMatchObject({ point: 'before-revoke-delete', taskId: 'task-own' });

  const liveLock = JSON.parse(await readFile(path.join(lockDir, 'lock.json'), 'utf8')) as {
    pid: number;
    nonce: string;
  };
  expect(liveLock.pid).toBe(freshReady.pid);
  expect(liveLock.nonce).not.toBe('stale-lock-race');
  await expect(access(claimPath)).rejects.toMatchObject({ code: 'ENOENT' });

  await Promise.all([
    releaseTaskCredentialWorker(barriers, 'cleaner-b'),
    releaseTaskCredentialWorker(barriers, 'fresh'),
  ]);
  const [cleanerBResult, freshResult] = await Promise.all([cleanerB.completed, fresh.completed]);

  expect(freshResult).toEqual({
    ok: true,
    result: {
      principalId: rotated.principalId,
      taskBinding: rotated.taskBinding,
    },
  });
  expect(cleanerBResult.ok).toBe(false);
  expect(cleanerBResult.error).toMatchObject({ code: 'task_subject_conflict' });

  const current = await (await createControlCredentialStore({ projectRoot: root, filePath }))
    .currentTaskCredential?.('task-own');
  expect(current).toBeNull();
}

async function createFifo(filePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('mkfifo', [filePath], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`mkfifo exited with code ${code ?? 'unknown'}`));
    });
  });
}

afterEach(async () => {
  await cleanupTestControlStatePaths(tempRoots);
  tempRoots = [];
});

function delegationInput(): ControlCommandInput {
  return {
    id: 'cmd-delegate',
    idempotencyKey: 'idem-delegate',
    kind: 'pane.delegate',
    projectRoot: '/canonical/project',
    createdAt: new Date().toISOString(),
    payload: { paneId: '%3', automationActorId: 'psyche-1', taskId: 'task-1', ttlMs: 60_000 },
  };
}

function takeoverInput(): ControlCommandInput {
  return {
    id: 'cmd-takeover',
    idempotencyKey: 'idem-takeover',
    kind: 'pane.takeover',
    projectRoot: '/canonical/project',
    createdAt: new Date().toISOString(),
    payload: { paneId: '%3' },
  };
}

function stubRuntime(
  submit: ControlServerRuntime['submit'],
  snapshot?: ControlSnapshot,
): ControlServerRuntime {
  return {
    submit,
    snapshot: () => snapshot ?? ({
      ownerEpoch: 1, sequence: 0, commands: {}, leases: {}, resources: [],
      capabilityLeases: [], leaseRequests: [], approvals: [], receipts: [],
    }),
    readEvents: () => ({ events: [], nextSequence: 0, gap: false }),
  };
}

function sensitiveSnapshot(): ControlSnapshot {
  return {
    ownerEpoch: 1,
    sequence: 2,
    commands: {
      'command-1': {
        command: { payload: { secret: 'command-secret' } },
        outcome: { status: 'succeeded', value: { secret: 'outcome-secret' } },
        sequence: 2,
      },
    },
    leases: {
      'pane-secret': {
        paneId: 'pane-secret',
        actorId: 'agent-secret',
        taskId: 'task-secret',
      },
    },
    resources: [{ id: 'tab-secret' }],
    capabilityLeases: [{ id: 'lease-secret' }],
    leaseRequests: [{ id: 'request-secret' }],
    approvals: [{ id: 'approval-secret' }],
    receipts: [{ id: 'receipt-secret' }],
  } as unknown as ControlSnapshot;
}

describe('control credential store', () => {
  it('mints operator and agent tokens that authenticate to their principals', async () => {
    const root = await tempProject();
    const filePath = path.join(root, 'control-credentials.json');
    const store = await createControlCredentialStore({ projectRoot: root, filePath });

    const operatorToken = await store.operatorToken();
    const agentToken = await store.agentToken();

    expect(operatorToken).not.toEqual(agentToken);
    await expect(store.authenticate(operatorToken)).resolves.toMatchObject({ principal: { kind: 'operator' } });
    await expect(store.authenticate(agentToken)).resolves.toMatchObject({ principal: { kind: 'agent' } });
    await expect(store.authenticate('not-a-token')).resolves.toBeNull();
    await expect(store.authenticate('')).resolves.toBeNull();
  });

  it('issues task-bound tokens that authenticate to one trusted task binding', async () => {
    const root = await tempProject();
    const filePath = path.join(root, 'control-credentials.json');
    const store = await createControlCredentialStore({ projectRoot: root, filePath });

    const taskToken = await issueControlTaskToken({
      projectRoot: root,
      filePath,
      taskId: 'task-own',
    });

    await expect(store.authenticate(taskToken)).resolves.toMatchObject({
      principal: { kind: 'agent' },
      taskBinding: { taskId: 'task-own' },
    });
  });

  it('rotates one active task subject per task and stores only hashed token material', async () => {
    const root = await tempProject();
    const filePath = path.join(root, 'control-credentials.json');
    const store = await createControlCredentialStore({ projectRoot: root, filePath });

    const first = await issueControlTaskCredential({
      projectRoot: root,
      filePath,
      taskId: 'task-own',
    });

    const taskDir = taskCredentialDirectory(root, filePath);
    const records = (await readdir(taskDir)).filter((entry) => entry.endsWith('.json'));
    expect(records).toHaveLength(1);
    const recordPath = path.join(taskDir, records[0]!);
    const firstRecord = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>;
    expect(firstRecord).toMatchObject({
      schema: 'psyche.control.task-credential/v1',
      taskId: 'task-own',
      subjectId: first.taskBinding.subjectId,
      principalId: first.principalId,
      tokenFingerprint: fingerprintControlToken(first.token),
    });
    expect(JSON.stringify(firstRecord)).not.toContain(first.token);
    expect((await stat(recordPath)).mode & 0o777).toBe(0o600);
    await expect(store.authenticate(first.token)).resolves.toMatchObject({
      principal: { id: first.principalId, kind: 'agent' },
      taskBinding: first.taskBinding,
    });

    const second = await issueControlTaskCredential({
      projectRoot: root,
      filePath,
      taskId: 'task-own',
      previousSubjectId: first.taskBinding.subjectId,
    });

    expect(second.taskBinding.subjectId).not.toBe(first.taskBinding.subjectId);
    expect(second.principalId).not.toBe(first.principalId);
    expect(second.replaced).toEqual({
      taskBinding: first.taskBinding,
      principalId: first.principalId,
    });

    const secondRecord = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>;
    expect(secondRecord).toMatchObject({
      schema: 'psyche.control.task-credential/v1',
      taskId: 'task-own',
      subjectId: second.taskBinding.subjectId,
      principalId: second.principalId,
      tokenFingerprint: fingerprintControlToken(second.token),
    });
    await expect(store.authenticate(first.token)).resolves.toBeNull();
    await expect(store.authenticate(second.token)).resolves.toMatchObject({
      principal: { id: second.principalId, kind: 'agent' },
      taskBinding: second.taskBinding,
    });
  });

  it('revokes a specific active task subject and leaves mismatched revocations as no-ops', async () => {
    const root = await tempProject();
    const filePath = path.join(root, 'control-credentials.json');
    const store = await createControlCredentialStore({ projectRoot: root, filePath });
    const issued = await issueControlTaskCredential({
      projectRoot: root,
      filePath,
      taskId: 'task-own',
    });

    await expect(revokeControlTaskCredential({
      projectRoot: root,
      filePath,
      taskId: 'task-own',
      subjectId: 'wrong-subject',
    })).resolves.toBeNull();
    await expect(store.authenticate(issued.token)).resolves.toMatchObject({
      principal: { id: issued.principalId, kind: 'agent' },
      taskBinding: issued.taskBinding,
    });

    await expect(revokeControlTaskCredential({
      projectRoot: root,
      filePath,
      taskId: 'task-own',
      subjectId: issued.taskBinding.subjectId,
    })).resolves.toEqual({
      taskBinding: issued.taskBinding,
      principalId: issued.principalId,
    });
    await expect(store.authenticate(issued.token)).resolves.toBeNull();
    const taskDir = taskCredentialDirectory(root, filePath);
    await expect(readdir(taskDir)).resolves.toEqual([]);
  });

  it('serializes concurrent cross-process rotations so exactly one stale subject replacement wins', async () => {
    const root = await tempProject();
    const filePath = path.join(root, 'control-credentials.json');
    const issued = await issueControlTaskCredential({
      projectRoot: root,
      filePath,
      taskId: 'task-own',
    });
    const barriers = path.join(root, 'credential-barriers-rotate');
    await mkdir(barriers, { recursive: true, mode: 0o700 });

    const first = spawnTaskCredentialWorker({
      mode: 'issue',
      projectRoot: root,
      filePath,
      taskId: 'task-own',
      subjectId: issued.taskBinding.subjectId,
      hookPoint: 'before-issue-write',
      hookLabel: 'rotate-a',
      hookDirectory: barriers,
    });
    const second = spawnTaskCredentialWorker({
      mode: 'issue',
      projectRoot: root,
      filePath,
      taskId: 'task-own',
      subjectId: issued.taskBinding.subjectId,
      hookPoint: 'before-issue-write',
      hookLabel: 'rotate-b',
      hookDirectory: barriers,
    });

    const firstReady = await waitForAnyTaskCredentialReady(barriers, ['rotate-a', 'rotate-b']);
    expect(firstReady).not.toBeNull();
    const secondLabel = firstReady === 'rotate-a' ? 'rotate-b' : 'rotate-a';
    await waitForTaskCredentialReady(barriers, secondLabel, 500);
    await Promise.all([
      releaseTaskCredentialWorker(barriers, 'rotate-a'),
      releaseTaskCredentialWorker(barriers, 'rotate-b'),
    ]);

    const [firstResult, secondResult] = await Promise.all([first.completed, second.completed]);
    const successes = [firstResult, secondResult].filter((result) => result.ok);
    const failures = [firstResult, secondResult].filter((result) => !result.ok);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.error).toMatchObject({ code: 'task_subject_conflict' });

    const winner = successes[0]!.result as {
      token: string;
      principalId: string;
      taskBinding: { taskId: string; subjectId: string };
    };
    const current = await (await createControlCredentialStore({ projectRoot: root, filePath }))
      .currentTaskCredential?.('task-own');
    expect(current).toEqual({
      principalId: winner.principalId,
      taskBinding: winner.taskBinding,
    });
  });

  it('does not let a stale cross-process revoke delete a newly rotated task credential', async () => {
    const root = await tempProject();
    const filePath = path.join(root, 'control-credentials.json');
    const issued = await issueControlTaskCredential({
      projectRoot: root,
      filePath,
      taskId: 'task-own',
    });
    const barriers = path.join(root, 'credential-barriers-revoke');
    await mkdir(barriers, { recursive: true, mode: 0o700 });

    const rotate = spawnTaskCredentialWorker({
      mode: 'issue',
      projectRoot: root,
      filePath,
      taskId: 'task-own',
      subjectId: issued.taskBinding.subjectId,
      hookPoint: 'before-issue-write',
      hookLabel: 'rotate',
      hookDirectory: barriers,
    });
    expect(await waitForTaskCredentialReady(barriers, 'rotate')).toBe(true);

    const revoke = spawnTaskCredentialWorker({
      mode: 'revoke',
      projectRoot: root,
      filePath,
      taskId: 'task-own',
      subjectId: issued.taskBinding.subjectId,
      hookPoint: 'before-revoke-delete',
      hookLabel: 'revoke',
      hookDirectory: barriers,
    });
    await waitForTaskCredentialReady(barriers, 'revoke', 500);

    await releaseTaskCredentialWorker(barriers, 'rotate');
    const rotateResult = await rotate.completed;
    expect(rotateResult.ok).toBe(true);

    await releaseTaskCredentialWorker(barriers, 'revoke');
    const revokeResult = await revoke.completed;

    expect(revokeResult).toEqual({ ok: true, result: null });
    const winner = rotateResult.result as {
      principalId: string;
      taskBinding: { taskId: string; subjectId: string };
      token: string;
    };
    const current = await (await createControlCredentialStore({ projectRoot: root, filePath }))
      .currentTaskCredential?.('task-own');
    expect(current).toEqual({
      principalId: winner.principalId,
      taskBinding: winner.taskBinding,
    });
  });

  it('recovers a stale recovery claim before rotating the active task credential', async () => {
    const root = await tempProject();
    const filePath = path.join(root, 'control-credentials.json');
    const issued = await issueControlTaskCredential({
      projectRoot: root,
      filePath,
      taskId: 'task-own',
    });
    const barriers = path.join(root, 'credential-barriers-recovery-claim');
    await mkdir(barriers, { recursive: true, mode: 0o700 });
    const { claimPath } = await seedStaleTaskCredentialMutationLock({
      filePath,
      taskId: 'task-own',
      lockNonce: 'stale-lock-claim',
      claimNonce: 'stale-recovery-claim',
    });

    const rotate = spawnTaskCredentialWorker({
      mode: 'issue',
      projectRoot: root,
      filePath,
      taskId: 'task-own',
      subjectId: issued.taskBinding.subjectId,
      hookPoint: 'after-recovery-claim',
      hookLabel: 'claim-recovered',
      hookDirectory: barriers,
    });

    const ready = await waitForTaskCredentialReadyPayload(barriers, 'claim-recovered');
    expect(ready).toMatchObject({
      point: 'after-recovery-claim',
      taskId: 'task-own',
      targetNonce: 'stale-lock-claim',
    });
    expect(JSON.parse(await readFile(claimPath, 'utf8'))).toMatchObject({
      pid: ready.pid,
      claimerNonce: ready.claimNonce,
      targetNonce: 'stale-lock-claim',
      targetPid: 9_999_991,
    });

    await releaseTaskCredentialWorker(barriers, 'claim-recovered');
    const result = await rotate.completed;

    expect(result.ok).toBe(true);
    await expect(access(claimPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const winner = result.result as {
      token: string;
      principalId: string;
      taskBinding: { taskId: string; subjectId: string };
    };
    const current = await (await createControlCredentialStore({ projectRoot: root, filePath }))
      .currentTaskCredential?.('task-own');
    expect(current).toEqual({
      principalId: winner.principalId,
      taskBinding: winner.taskBinding,
    });
  });

  it('retries lock acquisition when a stale lock directory is handed off during validation', async () => {
    const root = await tempProject();
    const filePath = path.join(root, 'control-credentials.json');
    const taskId = 'task-lock-dir-handoff';
    const barriers = path.join(root, 'credential-barriers-lock-dir-handoff');
    await mkdir(barriers, { recursive: true, mode: 0o700 });
    const { lockDir } = await seedStaleTaskCredentialMutationLock({
      projectRoot: root,
      filePath,
      taskId,
      lockNonce: 'stale-lock-before-handoff',
    });

    const rotate = spawnTaskCredentialWorker({
      mode: 'issue',
      projectRoot: root,
      filePath,
      taskId,
      hookPoint: 'after-lock-dir-snapshot',
      hookLabel: 'lock-dir-handoff',
      hookDirectory: barriers,
      lockTimeoutMs: SHORT_TASK_CREDENTIAL_LOCK_TIMEOUT_MS,
      lockPollIntervalMs: SHORT_TASK_CREDENTIAL_LOCK_POLL_INTERVAL_MS,
    });
    const ready = await waitForTaskCredentialReadyPayload(barriers, 'lock-dir-handoff');
    expect(ready).toMatchObject({
      point: 'after-lock-dir-snapshot',
      taskId,
      lockDir,
    });

    const displacedLockDir = `${lockDir}.handoff`;
    await rename(lockDir, displacedLockDir);
    await seedStaleTaskCredentialMutationLock({
      projectRoot: root,
      filePath,
      taskId,
      lockNonce: 'stale-lock-after-handoff',
    });
    await releaseTaskCredentialWorker(barriers, 'lock-dir-handoff');
    const result = await rotate.completed;

    expect(result.ok).toBe(true);
    const issued = result.result as {
      principalId: string;
      taskBinding: { taskId: string; subjectId: string };
      token: string;
    };
    const current = await (await createControlCredentialStore({ projectRoot: root, filePath }))
      .currentTaskCredential?.(taskId);
    expect(current).toEqual({
      principalId: issued.principalId,
      taskBinding: issued.taskBinding,
    });
    expect(JSON.parse(await readFile(path.join(displacedLockDir, 'lock.json'), 'utf8'))).toMatchObject({
      nonce: 'stale-lock-before-handoff',
    });
  });

  it('prevents concurrent stale cleaners from stealing a fresh live task-credential lock', async () => {
    await expectStaleCleanerFreshOwnerHandoff();
  });

  it('repeatedly classifies stale-cleaner and fresh-owner handoffs semantically', async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await expectStaleCleanerFreshOwnerHandoff();
    }
  });

  it('does not follow a symlinked lock.json and leaves the external target unchanged', async () => {
    if (process.platform === 'win32') return;
    const root = await tempProject();
    const filePath = path.join(root, 'control-credentials.json');
    const { lockDir } = await seedStaleTaskCredentialMutationLock({
      filePath,
      taskId: 'task-symlink-lock',
      lockNonce: 'symlink-lock',
    });
    const externalPath = path.join(root, 'external-lock.json');
    const externalContent = `${JSON.stringify({ sentinel: 'external-lock-target' })}\n`;
    const lockPath = path.join(lockDir, 'lock.json');
    await writeFile(externalPath, externalContent, { mode: 0o600 });
    await unlink(lockPath);
    await symlink(externalPath, lockPath);

    await expectTaskCredentialMutationTimeout(() => issueControlTaskCredential({
      projectRoot: root,
      filePath,
      taskId: 'task-symlink-lock',
    }));

    expect(await readFile(externalPath, 'utf8')).toBe(externalContent);
    expect((await lstat(lockPath)).isSymbolicLink()).toBe(true);
    await expect(access(path.join(lockDir, 'recovery.claim.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not follow a hard-linked lock.json and leaves both links untouched', async () => {
    if (process.platform === 'win32') return;
    const root = await tempProject();
    const filePath = path.join(root, 'control-credentials.json');
    const { lockDir } = await seedStaleTaskCredentialMutationLock({
      filePath,
      taskId: 'task-hardlink-lock',
      lockNonce: 'hardlink-lock',
    });
    const lockPath = path.join(lockDir, 'lock.json');
    const linkedPath = path.join(root, 'linked-lock.json');
    const original = await readFile(lockPath, 'utf8');
    await link(lockPath, linkedPath);

    await expectTaskCredentialMutationTimeout(() => issueControlTaskCredential({
      projectRoot: root,
      filePath,
      taskId: 'task-hardlink-lock',
    }));

    expect(await readFile(lockPath, 'utf8')).toBe(original);
    expect(await readFile(linkedPath, 'utf8')).toBe(original);
    expect((await lstat(lockPath)).nlink).toBe(2);
    expect((await lstat(linkedPath)).nlink).toBe(2);
    await expect(access(path.join(lockDir, 'recovery.claim.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    {
      name: 'lock.json FIFO',
      taskId: 'task-fifo-lock',
      prepare: async (filePath: string) => {
        const { lockDir } = await seedStaleTaskCredentialMutationLock({
          filePath,
          taskId: 'task-fifo-lock',
          lockNonce: 'fifo-lock',
        });
        const lockPath = path.join(lockDir, 'lock.json');
        await unlink(lockPath);
        await createFifo(lockPath);
      },
    },
    {
      name: 'recovery.claim.json FIFO',
      taskId: 'task-fifo-claim',
      prepare: async (filePath: string) => {
        const { claimPath } = await seedStaleTaskCredentialMutationLock({
          filePath,
          taskId: 'task-fifo-claim',
          lockNonce: 'fifo-claim',
        });
        await createFifo(claimPath);
      },
    },
  ])('$name is treated as invalid without blocking', async ({ prepare, taskId }) => {
    if (process.platform === 'win32') return;
    const root = await tempProject();
    const filePath = path.join(root, 'control-credentials.json');
    await prepare(filePath);

    await expectTaskCredentialMutationTimeout(() => issueControlTaskCredential({
      projectRoot: root,
      filePath,
      taskId,
    }));
  });

  it.each([
    {
      name: 'oversized lock.json',
      taskId: 'task-oversized-lock',
      prepare: async (filePath: string) => {
        const { lockDir } = await seedStaleTaskCredentialMutationLock({
          filePath,
          taskId: 'task-oversized-lock',
          lockNonce: 'oversized-lock',
        });
        await writeFile(path.join(lockDir, 'lock.json'), `${'x'.repeat(9 * 1024)}\n`, { mode: 0o600 });
      },
    },
    {
      name: 'malformed lock.json',
      taskId: 'task-malformed-lock',
      prepare: async (filePath: string) => {
        const { lockDir } = await seedStaleTaskCredentialMutationLock({
          filePath,
          taskId: 'task-malformed-lock',
          lockNonce: 'malformed-lock',
        });
        await writeFile(path.join(lockDir, 'lock.json'), '{not-json}\n', { mode: 0o600 });
      },
    },
    {
      name: 'truncated recovery.claim.json',
      taskId: 'task-truncated-claim',
      prepare: async (filePath: string) => {
        const { claimPath } = await seedStaleTaskCredentialMutationLock({
          filePath,
          taskId: 'task-truncated-claim',
          lockNonce: 'truncated-claim-lock',
        });
        await writeFile(claimPath, '{"pid": 1', { mode: 0o600 });
      },
    },
  ])('$name is treated as invalid and times out quickly', async ({ prepare, taskId }) => {
    const root = await tempProject();
    const filePath = path.join(root, 'control-credentials.json');
    await prepare(filePath);

    await expectTaskCredentialMutationTimeout(() => issueControlTaskCredential({
      projectRoot: root,
      filePath,
      taskId,
    }));
  });

  it('does not unlink a changed recovery claim path during stale-lock recovery', async () => {
    if (process.platform === 'win32') return;
    const root = await tempProject();
    const filePath = path.join(root, 'control-credentials.json');
    const barriers = path.join(root, 'credential-barriers-claim-path-race');
    await mkdir(barriers, { recursive: true, mode: 0o700 });
    const { lockDir, claimPath } = await seedStaleTaskCredentialMutationLock({
      filePath,
      taskId: 'task-claim-path-race',
      lockNonce: 'claim-path-race',
    });
    const externalPath = path.join(root, 'external-claim.json');
    const externalContent = `${JSON.stringify({ sentinel: 'external-claim-target' })}\n`;
    await writeFile(externalPath, externalContent, { mode: 0o600 });

    const rotate = spawnTaskCredentialWorker({
      mode: 'issue',
      projectRoot: root,
      filePath,
      taskId: 'task-claim-path-race',
      hookPoint: 'after-recovery-claim',
      hookLabel: 'claim-path-race',
      hookDirectory: barriers,
      lockTimeoutMs: SHORT_TASK_CREDENTIAL_LOCK_TIMEOUT_MS,
      lockPollIntervalMs: SHORT_TASK_CREDENTIAL_LOCK_POLL_INTERVAL_MS,
    });
    const ready = await waitForTaskCredentialReadyPayload(barriers, 'claim-path-race');
    expect(ready).toMatchObject({
      point: 'after-recovery-claim',
      taskId: 'task-claim-path-race',
      targetNonce: 'claim-path-race',
    });

    await unlink(claimPath);
    await symlink(externalPath, claimPath);

    const startedAt = Date.now();
    await releaseTaskCredentialWorker(barriers, 'claim-path-race');
    const result = await rotate.completed;

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('Timed out waiting for task credential mutation lock');
    expect(Date.now() - startedAt).toBeLessThan(TASK_CREDENTIAL_LOCK_COMPLETION_BOUND_MS);
    expect(await readFile(externalPath, 'utf8')).toBe(externalContent);
    expect((await lstat(claimPath)).isSymbolicLink()).toBe(true);
    await expect(access(lockDir)).resolves.toBeUndefined();
  });

  it('keeps legacy per-token binding files parseable but fails them closed', async () => {
    const root = await tempProject();
    const filePath = path.join(root, 'control-credentials.json');
    const store = await createControlCredentialStore({ projectRoot: root, filePath });
    const legacyToken = 'legacy-task-token';
    const legacyDir = path.join(path.dirname(filePath), 'control-task-bindings');
    await mkdir(legacyDir, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(legacyDir, `${fingerprintControlToken(legacyToken)}.json`),
      `${JSON.stringify({ taskId: 'legacy-task' })}\n`,
      { mode: 0o600 },
    );

    await expect(store.authenticate(legacyToken)).resolves.toBeNull();
    await expect(store.authenticate(await store.agentToken())).resolves.toMatchObject({
      principal: { id: 'agent', kind: 'agent' },
    });
  });

  it('persists the credential file with 0600 mode and reuses it', async () => {
    const root = await tempProject();
    const filePath = path.join(root, 'control-credentials.json');
    const first = await createControlCredentialStore({ projectRoot: root, filePath });
    const operatorToken = await first.operatorToken();

    const stats = await stat(filePath);
    expect(stats.mode & 0o777).toBe(0o600);

    const second = await createControlCredentialStore({ projectRoot: root, filePath });
    expect(await second.operatorToken()).toBe(operatorToken);
  });

  it('rereads rotated credentials instead of serving a stale cached token', async () => {
    const root = await tempProject();
    const filePath = path.join(root, 'control-credentials.json');
    const store = await createControlCredentialStore({ projectRoot: root, filePath });
    const originalAgentToken = await store.agentToken();
    const rotated = { operatorToken: 'rotated-operator', agentToken: 'rotated-agent' };

    await writeFile(filePath, `${JSON.stringify(rotated)}\n`, { mode: 0o600 });

    await expect(store.operatorToken()).resolves.toBe(rotated.operatorToken);
    await expect(store.agentToken()).resolves.toBe(rotated.agentToken);
    await expect(store.authenticate(originalAgentToken)).resolves.toBeNull();
    await expect(store.authenticate(rotated.agentToken)).resolves.toMatchObject({
      principal: { kind: 'agent' },
    });
  });

  it('atomically converges concurrent stores on the on-disk credentials', async () => {
    const root = await tempProject();
    const filePath = testResolvedControlCredentialPaths(root).credentialFilePath;
    const stores = await Promise.all(Array.from(
      { length: 64 },
      () => createControlCredentialStore({ projectRoot: root }),
    ));
    const tokens = await Promise.all(stores.map(async (store) => ({
      operator: await store.operatorToken(),
      agent: await store.agentToken(),
    })));
    const onDisk = JSON.parse(await readFile(filePath, 'utf8'));

    expect(new Set(tokens.map((token) => token.operator))).toEqual(new Set([onDisk.operatorToken]));
    expect(new Set(tokens.map((token) => token.agent))).toEqual(new Set([onDisk.agentToken]));
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it('rejects a symlink credential target', async () => {
    const root = await tempProject();
    const victim = path.join(root, 'victim.json');
    const filePath = path.join(root, 'control-credentials.json');
    await symlink(victim, filePath);

    const store = await createControlCredentialStore({ projectRoot: root, filePath });
    await expect(store.agentToken()).rejects.toMatchObject({ code: 'credential_path_unsafe' });
  });

  it('rejects a symlink in the credential parent path', async () => {
    const root = await tempProject();
    const outside = await tempProject();
    const linkedParent = path.join(root, '.psyche');
    await symlink(outside, linkedParent);

    const store = await createControlCredentialStore({
      projectRoot: root,
      filePath: path.join(linkedParent, 'runtime', 'control-credentials.json'),
    });
    await expect(store.agentToken()).rejects.toMatchObject({ code: 'credential_path_unsafe' });
  });

  it('rejects a symlinked task credential directory across authenticate/current/revoke/rotate', async () => {
    if (process.platform === 'win32') return;
    const root = await tempProject();
    const outside = await tempProject();
    const filePath = path.join(root, 'control-credentials.json');
    const taskId = 'task-symlinked-directory';
    const subjectId = 'subject-symlinked-directory';
    const token = 'task-token-symlinked-directory';
    const externalTaskDir = path.join(outside, 'control-task-credentials');
    const external = await seedTaskCredentialRecord({
      directory: externalTaskDir,
      taskId,
      subjectId,
      token,
    });
    await mkdir(path.dirname(taskCredentialDirectory(root, filePath)), { recursive: true, mode: 0o700 });
    await symlink(externalTaskDir, taskCredentialDirectory(root, filePath));

    const store = await createControlCredentialStore({ projectRoot: root, filePath });

    await expect(store.authenticate(token)).rejects.toMatchObject({ code: 'credential_path_unsafe' });
    expect(await readFile(external.recordPath, 'utf8')).toBe(external.content);

    await expect(store.currentTaskCredential?.(taskId)).rejects.toMatchObject({ code: 'credential_path_unsafe' });
    expect(await readFile(external.recordPath, 'utf8')).toBe(external.content);

    await expect(revokeControlTaskCredential({
      projectRoot: root,
      filePath,
      taskId,
      subjectId,
    })).rejects.toMatchObject({ code: 'credential_path_unsafe' });
    expect(await readFile(external.recordPath, 'utf8')).toBe(external.content);

    await expect(issueControlTaskCredential({
      projectRoot: root,
      filePath,
      taskId,
    })).rejects.toMatchObject({ code: 'credential_path_unsafe' });
    expect(await readFile(external.recordPath, 'utf8')).toBe(external.content);
  });

  it('rejects a symlinked credential parent across authenticate/current/revoke/rotate', async () => {
    const root = await tempProject();
    const outside = await tempProject();
    const linkedParent = path.join(root, '.psyche');
    const filePath = path.join(linkedParent, 'runtime', 'control-credentials.json');
    const taskId = 'task-symlinked-parent';
    const subjectId = 'subject-symlinked-parent';
    const token = 'task-token-symlinked-parent';
    const externalRuntime = path.join(outside, 'runtime');
    const externalCredentialPath = path.join(externalRuntime, 'control-credentials.json');
    const externalCredentialContent = `${JSON.stringify({
      operatorToken: 'external-operator-token',
      agentToken: 'external-agent-token',
    })}\n`;
    await mkdir(externalRuntime, { recursive: true, mode: 0o700 });
    await writeFile(externalCredentialPath, externalCredentialContent, { mode: 0o600 });
    const external = await seedTaskCredentialRecord({
      directory: path.join(externalRuntime, 'control-task-credentials'),
      taskId,
      subjectId,
      token,
    });
    await symlink(outside, linkedParent);

    const store = await createControlCredentialStore({ projectRoot: root, filePath });

    await expect(store.authenticate(token)).rejects.toMatchObject({ code: 'credential_path_unsafe' });
    expect(await readFile(externalCredentialPath, 'utf8')).toBe(externalCredentialContent);
    expect(await readFile(external.recordPath, 'utf8')).toBe(external.content);

    await expect(store.currentTaskCredential?.(taskId)).resolves.toBeNull();
    expect(await readFile(externalCredentialPath, 'utf8')).toBe(externalCredentialContent);
    expect(await readFile(external.recordPath, 'utf8')).toBe(external.content);

    await expect(revokeControlTaskCredential({
      projectRoot: root,
      filePath,
      taskId,
      subjectId,
    })).rejects.toMatchObject({ code: 'credential_path_unsafe' });
    expect(await readFile(externalCredentialPath, 'utf8')).toBe(externalCredentialContent);
    expect(await readFile(external.recordPath, 'utf8')).toBe(external.content);

    await expect(issueControlTaskCredential({
      projectRoot: root,
      filePath,
      taskId,
    })).rejects.toMatchObject({ code: 'credential_path_unsafe' });
    expect(await readFile(externalCredentialPath, 'utf8')).toBe(externalCredentialContent);
    expect(await readFile(external.recordPath, 'utf8')).toBe(external.content);
  });

  it('stores default credentials outside the repository and ignores legacy in-project paths', async () => {
    if (process.platform === 'win32') return;
    const root = await tempProject();
    const outside = await tempProject();
    const legacyRuntime = path.join(outside, 'legacy-runtime');
    await mkdir(legacyRuntime, { recursive: true, mode: 0o700 });
    await symlink(legacyRuntime, path.join(root, '.psyche'));

    const legacyCredentialTarget = path.join(outside, 'legacy-control-credentials.json');
    const legacyCredentialContent = `${JSON.stringify({ sentinel: 'legacy-control' })}\n`;
    await writeFile(legacyCredentialTarget, legacyCredentialContent, { mode: 0o600 });
    const legacyCredentialPath = path.join(root, 'control-credentials.json');
    await link(legacyCredentialTarget, legacyCredentialPath);

    const legacyTaskDir = path.join(root, 'control-task-credentials');
    await createFifo(legacyTaskDir);
    const legacyLockTarget = path.join(outside, 'legacy-lock-dir');
    await mkdir(legacyLockTarget, { recursive: true, mode: 0o700 });
    const legacyLockDir = path.join(root, 'control-task-credential-locks');
    await symlink(legacyLockTarget, legacyLockDir);
    const legacyBindingsDir = path.join(root, 'control-task-bindings');
    await createFifo(legacyBindingsDir);

    const store = await createControlCredentialStore({ projectRoot: root });
    const issued = await issueControlTaskCredential({
      projectRoot: root,
      taskId: 'task-legacy-ignore',
    });
    const paths = testResolvedControlCredentialPaths(root);
    const credentialRelativeToProject = path.relative(root, paths.credentialFilePath);

    expect(paths.credentialFilePath.startsWith(testControlStateRoot(root))).toBe(true);
    expect(
      credentialRelativeToProject === '..'
      || credentialRelativeToProject.startsWith(`..${path.sep}`)
      || path.isAbsolute(credentialRelativeToProject),
    ).toBe(true);
    await expect(store.authenticate(issued.token)).resolves.toMatchObject({
      principal: { id: issued.principalId, kind: 'agent' },
      taskBinding: issued.taskBinding,
    });
    await expect(store.currentTaskCredential?.(issued.taskBinding.taskId)).resolves.toEqual({
      principalId: issued.principalId,
      taskBinding: issued.taskBinding,
    });
    await expect(revokeControlTaskCredential({
      projectRoot: root,
      taskId: issued.taskBinding.taskId,
      subjectId: issued.taskBinding.subjectId,
    })).resolves.toEqual({
      principalId: issued.principalId,
      taskBinding: issued.taskBinding,
    });

    expect(await readFile(legacyCredentialTarget, 'utf8')).toBe(legacyCredentialContent);
    expect((await lstat(legacyCredentialPath)).nlink).toBe(2);
    expect((await lstat(path.join(root, '.psyche'))).isSymbolicLink()).toBe(true);
    expect((await lstat(legacyTaskDir)).isFIFO()).toBe(true);
    expect((await lstat(legacyLockDir)).isSymbolicLink()).toBe(true);
    expect((await lstat(legacyBindingsDir)).isFIFO()).toBe(true);
    expect((await stat(paths.credentialFilePath)).mode & 0o777).toBe(0o600);
  });

  it('isolates external task credential state across projects that share a task id', async () => {
    const sharedStateRoot = await tempProject();
    const firstRoot = await tempProject();
    const secondRoot = await tempProject();
    const taskId = 'shared-task-id';
    const firstStore = await createControlCredentialStoreInternal({
      projectRoot: firstRoot,
      stateRoot: sharedStateRoot,
    });
    const secondStore = await createControlCredentialStoreInternal({
      projectRoot: secondRoot,
      stateRoot: sharedStateRoot,
    });
    const firstIssued = await issueControlTaskCredentialInternal({
      projectRoot: firstRoot,
      taskId,
      stateRoot: sharedStateRoot,
    });
    const secondIssued = await issueControlTaskCredentialInternal({
      projectRoot: secondRoot,
      taskId,
      stateRoot: sharedStateRoot,
    });
    const firstPaths = resolveControlCredentialPaths({
      canonicalProjectRoot: firstRoot,
      stateRoot: sharedStateRoot,
    });
    const secondPaths = resolveControlCredentialPaths({
      canonicalProjectRoot: secondRoot,
      stateRoot: sharedStateRoot,
    });

    expect(firstPaths.projectDirectory).not.toBe(secondPaths.projectDirectory);
    expect(firstPaths.credentialFilePath).not.toBe(secondPaths.credentialFilePath);
    await expect(firstStore.authenticate(firstIssued.token)).resolves.toMatchObject({
      principal: { id: firstIssued.principalId },
      taskBinding: firstIssued.taskBinding,
    });
    await expect(firstStore.authenticate(secondIssued.token)).resolves.toBeNull();
    await expect(secondStore.authenticate(firstIssued.token)).resolves.toBeNull();
    await expect(firstStore.currentTaskCredential?.(taskId)).resolves.toEqual({
      principalId: firstIssued.principalId,
      taskBinding: firstIssued.taskBinding,
    });
    await expect(secondStore.currentTaskCredential?.(taskId)).resolves.toEqual({
      principalId: secondIssued.principalId,
      taskBinding: secondIssued.taskBinding,
    });

    await expect(revokeControlTaskCredentialInternal({
      projectRoot: firstRoot,
      taskId,
      subjectId: firstIssued.taskBinding.subjectId,
      stateRoot: sharedStateRoot,
    })).resolves.toEqual({
      principalId: firstIssued.principalId,
      taskBinding: firstIssued.taskBinding,
    });
    await expect(firstStore.authenticate(firstIssued.token)).resolves.toBeNull();
    await expect(secondStore.authenticate(secondIssued.token)).resolves.toMatchObject({
      principal: { id: secondIssued.principalId },
      taskBinding: secondIssued.taskBinding,
    });
  });

  it('rejects a symlinked control state root', async () => {
    if (process.platform === 'win32') return;
    const root = await tempProject();
    const outside = await tempProject();
    const stateRoot = path.join(root, 'symlinked-control-state');
    await symlink(outside, stateRoot);

    const store = await createControlCredentialStoreInternal({
      projectRoot: root,
      stateRoot,
    });
    await expect(store.agentToken()).rejects.toMatchObject({ code: 'credential_path_unsafe' });
    await expect(issueControlTaskCredentialInternal({
      projectRoot: root,
      stateRoot,
      taskId: 'task-symlinked-state-root',
    })).rejects.toMatchObject({ code: 'credential_path_unsafe' });
    expect((await lstat(stateRoot)).isSymbolicLink()).toBe(true);
  });

  it('rejects a hard-linked control credential file without mutating either link', async () => {
    if (process.platform === 'win32') return;
    const root = await tempProject();
    const filePath = path.join(root, 'control-credentials.json');
    const store = await createControlCredentialStore({ projectRoot: root, filePath });
    const original = await store.operatorToken();
    const fileContents = await readFile(filePath, 'utf8');
    const linkedPath = path.join(root, 'control-credentials.link.json');
    await link(filePath, linkedPath);

    await expect(store.operatorToken()).rejects.toMatchObject({ code: 'credential_path_unsafe' });
    expect(await readFile(filePath, 'utf8')).toBe(fileContents);
    expect(await readFile(linkedPath, 'utf8')).toBe(fileContents);
    expect((await lstat(filePath)).nlink).toBe(2);
    expect((await lstat(linkedPath)).nlink).toBe(2);
    expect(original.length).toBeGreaterThan(0);
  });

  it('rejects a hard-linked task credential record across authenticate/current/revoke/rotate', async () => {
    if (process.platform === 'win32') return;
    const root = await tempProject();
    const filePath = path.join(root, 'control-credentials.json');
    const taskId = 'task-hardlinked-record';
    const store = await createControlCredentialStore({ projectRoot: root, filePath });
    const issued = await issueControlTaskCredential({
      projectRoot: root,
      filePath,
      taskId,
    });
    const recordPath = taskCredentialRecordPath(taskCredentialDirectory(root, filePath), taskId);
    const linkedPath = path.join(root, 'task-hardlinked-record.link.json');
    const fileContents = await readFile(recordPath, 'utf8');
    await link(recordPath, linkedPath);

    await expect(store.authenticate(issued.token)).rejects.toMatchObject({ code: 'credential_path_unsafe' });
    await expect(store.currentTaskCredential?.(taskId)).rejects.toMatchObject({ code: 'credential_path_unsafe' });
    await expect(revokeControlTaskCredential({
      projectRoot: root,
      filePath,
      taskId,
      subjectId: issued.taskBinding.subjectId,
    })).rejects.toMatchObject({ code: 'credential_path_unsafe' });
    await expect(issueControlTaskCredential({
      projectRoot: root,
      filePath,
      taskId,
      previousSubjectId: issued.taskBinding.subjectId,
    })).rejects.toMatchObject({ code: 'credential_path_unsafe' });

    expect(await readFile(recordPath, 'utf8')).toBe(fileContents);
    expect(await readFile(linkedPath, 'utf8')).toBe(fileContents);
    expect((await lstat(recordPath)).nlink).toBe(2);
    expect((await lstat(linkedPath)).nlink).toBe(2);
  });

  it('fails closed when revoke sees the task credential directory replaced with a symlink', async () => {
    if (process.platform === 'win32') return;
    const root = await tempProject();
    const outside = await tempProject();
    const filePath = path.join(root, 'control-credentials.json');
    const taskId = 'task-directory-race';
    const issued = await issueControlTaskCredential({
      projectRoot: root,
      filePath,
      taskId,
    });
    const barriers = path.join(root, 'credential-barriers-directory-race');
    await mkdir(barriers, { recursive: true, mode: 0o700 });

    const external = await seedTaskCredentialRecord({
      directory: path.join(outside, 'control-task-credentials'),
      taskId,
      subjectId: 'external-directory-race',
      token: 'external-directory-race-token',
    });

    const revoke = spawnTaskCredentialWorker({
      mode: 'revoke',
      projectRoot: root,
      filePath,
      taskId,
      subjectId: issued.taskBinding.subjectId,
      hookPoint: 'before-revoke-delete',
      hookLabel: 'directory-race',
      hookDirectory: barriers,
    });
    const ready = await waitForTaskCredentialReadyPayload(barriers, 'directory-race');
    expect(ready).toMatchObject({ point: 'before-revoke-delete', taskId });

    const liveTaskDir = taskCredentialDirectory(root, filePath);
    const quarantinedTaskDir = `${liveTaskDir}.safe`;
    await rename(liveTaskDir, quarantinedTaskDir);
    await symlink(path.join(outside, 'control-task-credentials'), liveTaskDir);

    await releaseTaskCredentialWorker(barriers, 'directory-race');
    const revokeResult = await revoke.completed;

    expect(revokeResult.ok).toBe(false);
    expect(revokeResult.error).toMatchObject({ code: 'credential_path_unsafe' });
    expect(await readFile(external.recordPath, 'utf8')).toBe(external.content);
    const originalRecord = JSON.parse(
      await readFile(taskCredentialRecordPath(quarantinedTaskDir, taskId), 'utf8'),
    ) as { subjectId: string };
    expect(originalRecord.subjectId).toBe(issued.taskBinding.subjectId);
    expect((await lstat(liveTaskDir)).isSymbolicLink()).toBe(true);
  });

  it.each(['write', 'sync', 'close', 'publish'] as const)(
    'removes temporary credential material after an injected %s failure',
    async (failureStep) => {
      const root = await realpath(await tempProject());
      const filePath = path.join(root, 'control-credentials.json');
      const failure = new Error(`injected ${failureStep} failure`);
      let closeCalls = 0;
      const creationOps: CredentialCreationOps = {
        async openTemporary(temporary) {
          const handle = await open(temporary, 'wx', 0o600);
          return {
            async writeFile(data, encoding) {
              if (failureStep === 'write') throw failure;
              return handle.writeFile(data, encoding);
            },
            async sync() {
              if (failureStep === 'sync') throw failure;
              return handle.sync();
            },
            async close() {
              closeCalls += 1;
              if (failureStep === 'close' && closeCalls === 1) {
                throw failure;
              }
              await handle.close().catch(() => undefined);
            },
          };
        },
        async publish(temporary, target) {
          if (failureStep === 'publish') throw failure;
          await link(temporary, target);
        },
        removeTemporary: unlink,
      };
      const store = await createControlCredentialStoreForCanonicalRoot({
        canonicalProjectRoot: root,
        filePath,
        creationOps,
      });

      await expect(store.agentToken()).rejects.toBe(failure);
      await expect(access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
      const leftovers = (await readdir(root)).filter((name) => name.endsWith('.tmp'));
      expect(leftovers).toEqual([]);
      expect(closeCalls).toBe(failureStep === 'close' ? 2 : 1);
    },
  );

  it('rereads an atomic publication winner and removes only the losing temporary file', async () => {
    const root = await realpath(await tempProject());
    const filePath = path.join(root, 'control-credentials.json');
    const winner = { operatorToken: 'winner-operator', agentToken: 'winner-agent' };
    const creationOps: CredentialCreationOps = {
      openTemporary: (temporary) => open(temporary, 'wx', 0o600),
      async publish(_temporary, target) {
        await writeFile(target, `${JSON.stringify(winner)}\n`, { mode: 0o600 });
        throw Object.assign(new Error('winner exists'), { code: 'EEXIST' });
      },
      removeTemporary: unlink,
    };
    const store = await createControlCredentialStoreForCanonicalRoot({
      canonicalProjectRoot: root,
      filePath,
      creationOps,
    });

    await expect(store.agentToken()).resolves.toBe(winner.agentToken);
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(winner);
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('surfaces losing temporary cleanup failure after validating a publication winner', async () => {
    const root = await realpath(await tempProject());
    const filePath = path.join(root, 'control-credentials.json');
    const winner = { operatorToken: 'winner-operator', agentToken: 'winner-agent' };
    const cleanupFailure = new Error('injected cleanup failure');
    const creationOps: CredentialCreationOps = {
      openTemporary: (temporary) => open(temporary, 'wx', 0o600),
      async publish(_temporary, target) {
        await writeFile(target, `${JSON.stringify(winner)}\n`, { mode: 0o600 });
        throw Object.assign(new Error('winner exists'), { code: 'EEXIST' });
      },
      async removeTemporary() {
        throw cleanupFailure;
      },
    };
    const store = await createControlCredentialStoreForCanonicalRoot({
      canonicalProjectRoot: root,
      filePath,
      creationOps,
    });

    await expect(store.agentToken()).rejects.toBe(cleanupFailure);
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(winner);
  });
});

describe('task credential rotation integration', () => {
  it('invalidates rotated subjects, isolates leases, and preserves revocation across reconnects and restart', async () => {
    const root = await tempProject();
    const endpoint = path.join(root, 'control.sock');
    const filePath = path.join(root, 'control-credentials.json');
    const harness = await createTaskScopedControlHarness({ projectRoot: root, endpoint });
    await harness.server.close();
    const server = await ControlServer.start({
      endpoint,
      projectRoot: root,
      ownerEpoch: 7,
      runtime: harness.runtime,
      credentials: harness.credentials,
      operatorCommandPolicy: 'trusted-test-only',
    });
    const cleanups: Array<() => Promise<void>> = [() => server.close()];

    try {
      const operator = await ControlClient.connect({
        projectRoot: root,
        endpoint,
        token: await harness.credentials.operatorToken(),
        clientName: 'operator',
      });
      cleanups.unshift(() => operator.close());
      const agentA = await ControlClient.connect({
        projectRoot: root,
        endpoint,
        token: harness.ownTaskToken,
        clientName: 'agent-a',
        taskBinding: { taskId: harness.ownTaskId, subjectId: harness.ownSubjectId },
      });
      cleanups.unshift(() => agentA.close());

      await expect(agentA.getState()).resolves.toMatchObject({
        capabilityLeases: [expect.objectContaining({
          id: harness.ownTabLease.id,
          actorId: harness.ownPrincipalId,
        })],
      });

      const rotated = await issueControlTaskCredential({
        projectRoot: root,
        filePath,
        taskId: harness.ownTaskId,
        previousSubjectId: harness.ownSubjectId,
      });

      await expect(agentA.getState()).rejects.toThrow(/unauthorized|closed|token/i);
      await expect(ControlClient.connect({
        projectRoot: root,
        endpoint,
        token: harness.ownTaskToken,
        clientName: 'agent-a-reconnect',
        taskBinding: { taskId: harness.ownTaskId, subjectId: harness.ownSubjectId },
      })).rejects.toThrow(/invalid control token|unauthorized/i);

      const pendingApproval = harness.runtime.snapshot().approvals
        .find((approval) => approval.actionId === harness.ownApprovalActionId)!;
      await expect(operator.resolveApproval({
        id: 'resolve-rotated-approval',
        idempotencyKey: 'resolve-rotated-approval',
        kind: 'approval.resolve',
        projectRoot: root,
        createdAt: new Date().toISOString(),
        payload: {
          approvalId: pendingApproval.id,
          payloadDigest: pendingApproval.payloadDigest,
          decision: 'approve',
        },
      })).resolves.toMatchObject({ status: 'failed', code: 'task_subject_inactive' });
      expect(harness.runtime.snapshot().approvals.find((approval) => approval.id === pendingApproval.id))
        .toMatchObject({ status: 'revoked' });
      expect(harness.runtime.snapshot().capabilityLeases.map((lease) => lease.id))
        .not.toContain(harness.ownTabLease.id);
      expect(harness.runtime.snapshot().receipts).toContainEqual(expect.objectContaining({
        actionId: harness.ownApprovalActionId,
        state: 'failed',
        code: 'action_invalidated',
      }));

      const agentB = await ControlClient.connect({
        projectRoot: root,
        endpoint,
        token: rotated.token,
        clientName: 'agent-b',
        taskBinding: rotated.taskBinding,
      });
      cleanups.unshift(() => agentB.close());

      const postRotate = await agentB.getState();
      expect(postRotate.resources).toEqual([]);
      expect(postRotate.capabilityLeases).toEqual([]);
      expect(postRotate.leaseRequests).toEqual([]);
      expect(postRotate.approvals).toEqual([]);
      expect(postRotate.receipts).toEqual([]);

      await expect(agentB.submit({
        id: 'release-old-lease',
        idempotencyKey: 'release-old-lease',
        kind: 'lease.release',
        projectRoot: root,
        createdAt: new Date().toISOString(),
        payload: {
          taskId: harness.ownTaskId,
          leaseId: harness.ownTabLease.id,
          leaseRevision: harness.ownTabLease.revision,
        },
      })).resolves.toMatchObject({ status: 'failed', code: 'capability_denied' });

      const requestId = 'rotated-request';
      await expect(agentB.submit({
        id: requestId,
        idempotencyKey: requestId,
        kind: 'lease.request',
        projectRoot: root,
        createdAt: new Date().toISOString(),
        payload: {
          taskId: harness.ownTaskId,
          ttlMs: 60_000,
          grants: [{
            target: {
              kind: 'browser_tab',
              id: harness.ownTab.id,
              generation: harness.ownTab.generation,
            },
            capabilities: ['browser.inspect'],
          }],
        },
      })).resolves.toMatchObject({ status: 'succeeded', value: { requestId } });

      const grantId = 'grant-rotated-request';
      const grantOutcome = await harness.runtime.submit({
        id: grantId,
        idempotencyKey: grantId,
        kind: 'lease.grant',
        projectRoot: root,
        actor: { id: 'operator-rotation', kind: 'human' },
        ownerEpoch: 7,
        createdAt: new Date().toISOString(),
        payload: { requestId },
      } as ControlCommand);
      expect(grantOutcome).toMatchObject({ status: 'succeeded' });
      const freshLease = (grantOutcome as { value: { lease: { id: string; revision: number } } }).value.lease;

      await expect(agentB.getState()).resolves.toMatchObject({
        capabilityLeases: [expect.objectContaining({
          requestId,
          actorId: rotated.principalId,
          taskId: harness.ownTaskId,
        })],
      });
      expect((await agentB.getState()).capabilityLeases.map((lease) => lease.id))
        .not.toContain(harness.ownTabLease.id);
      await expect(agentB.submit({
        id: 'use-fresh-lease',
        idempotencyKey: 'use-fresh-lease',
        kind: 'browser.inspect',
        projectRoot: root,
        createdAt: new Date().toISOString(),
        payload: {
          taskId: harness.ownTaskId,
          leaseId: freshLease.id,
          leaseRevision: freshLease.revision,
          tabId: harness.ownTab.id,
          generation: harness.ownTab.generation,
        },
      })).resolves.toMatchObject({ status: 'succeeded' });

      await server.close();
      const restartedServer = await ControlServer.start({
        endpoint,
        projectRoot: root,
        ownerEpoch: 7,
        runtime: harness.runtime,
        credentials: harness.credentials,
        operatorCommandPolicy: 'trusted-test-only',
      });
      cleanups.unshift(() => restartedServer.close());

      await expect(ControlClient.connect({
        projectRoot: root,
        endpoint,
        token: harness.ownTaskToken,
        clientName: 'agent-a-after-restart',
        taskBinding: { taskId: harness.ownTaskId, subjectId: harness.ownSubjectId },
      })).rejects.toThrow(/invalid control token|unauthorized/i);

      const restartedAgentB = await ControlClient.connect({
        projectRoot: root,
        endpoint,
        token: rotated.token,
        clientName: 'agent-b-after-restart',
        taskBinding: rotated.taskBinding,
      });
      cleanups.unshift(() => restartedAgentB.close());
      await expect(restartedAgentB.getState()).resolves.toMatchObject({
        capabilityLeases: [expect.objectContaining({
          requestId,
          actorId: rotated.principalId,
        })],
      });

      await expect(revokeControlTaskCredential({
        projectRoot: root,
        filePath,
        taskId: harness.ownTaskId,
        subjectId: rotated.taskBinding.subjectId,
      })).resolves.toEqual({
        principalId: rotated.principalId,
        taskBinding: rotated.taskBinding,
      });
      await expect(restartedAgentB.getState()).rejects.toThrow(/credential_unavailable|unauthorized|closed|token/i);
      await expect(ControlClient.connect({
        projectRoot: root,
        endpoint,
        token: rotated.token,
        clientName: 'agent-b-after-revoke',
        taskBinding: rotated.taskBinding,
      })).rejects.toThrow(/invalid control token|unauthorized/i);
    } finally {
      await Promise.allSettled(cleanups.map(async (close) => close()));
    }
  });
});

describe('control server authorization', () => {
  it('only exposes surface authority snapshot fields to operators', () => {
    const sensitive = sensitiveSnapshot();
    const server = createControlServerForTest({
      runtime: stubRuntime(vi.fn(), sensitive),
    });
    const operator: ControlPrincipal = {
      id: 'operator', kind: 'operator', capabilities: ['read', 'mutate', 'delegate'],
    };

    expect(server.snapshot(operator)).toEqual(sensitive);
    for (const kind of ['agent', 'compatibility'] as const) {
      const snapshot = server.snapshot({ id: kind, kind, capabilities: ['read'] });
      expect(snapshot).toMatchObject({
        ownerEpoch: 1,
        sequence: 2,
        commands: {},
        leases: {},
        resources: [],
        capabilityLeases: [],
        leaseRequests: [],
        approvals: [],
        receipts: [],
      });
      expect(JSON.stringify(snapshot)).not.toContain('secret');
    }
  });

  it('exposes only proven own-task receipts through a task-bound non-operator snapshot', () => {
    const scopedSnapshot = {
      ownerEpoch: 7,
      sequence: 5,
      commands: {},
      leases: {},
      resources: [
        {
          kind: 'pane',
          id: 'pane-own',
          generation: 1,
          projectRoot: '/repo',
          worktreeRoot: '/repo',
          tmuxPaneId: '%1',
          writable: true,
          outputSequence: 1,
        },
        {
          kind: 'browser_tab',
          id: 'tab-own',
          generation: 1,
          projectRoot: '/repo',
          worktreeRoot: '/repo',
          providerId: 'provider-own',
          webviewLabel: 'own',
          url: 'https://own.example',
          title: 'Own',
          loading: false,
          viewport: { width: 1280, height: 720 },
        },
        {
          kind: 'pane',
          id: 'pane-other',
          generation: 1,
          projectRoot: '/repo',
          worktreeRoot: '/repo',
          tmuxPaneId: '%2',
          writable: true,
          outputSequence: 1,
        },
        {
          kind: 'browser_tab',
          id: 'tab-other',
          generation: 1,
          projectRoot: '/repo',
          worktreeRoot: '/repo',
          providerId: 'provider-other',
          webviewLabel: 'other',
          url: 'https://other.example',
          title: 'Other',
          loading: false,
          viewport: { width: 1280, height: 720 },
        },
      ],
      capabilityLeases: [
        {
          id: 'lease-own',
          requestId: 'request-own-tab',
          actorId: 'agent-own',
          taskId: 'task-own',
          grantedBy: 'operator',
          revision: 2,
          ownerEpoch: 7,
          createdAt: '2026-08-12T12:00:00.000Z',
          expiresAt: '2026-08-12T12:01:00.000Z',
          grants: [{ target: { kind: 'browser_tab', id: 'tab-own', generation: 1 }, capabilities: ['browser.interact'] }],
        },
        {
          id: 'lease-other',
          requestId: 'request-other-tab',
          actorId: 'agent-other',
          taskId: 'task-other',
          grantedBy: 'operator',
          revision: 1,
          ownerEpoch: 7,
          createdAt: '2026-08-12T12:00:00.000Z',
          expiresAt: '2026-08-12T12:01:00.000Z',
          grants: [{ target: { kind: 'browser_tab', id: 'tab-other', generation: 1 }, capabilities: ['browser.interact'] }],
        },
      ],
      leaseRequests: [
        {
          id: 'request-own-pane',
          ownerEpoch: 7,
          actorId: 'agent-own',
          taskId: 'task-own',
          status: 'pending' as const,
          createdAt: '2026-08-12T12:00:00.000Z',
          ttlMs: 60_000,
          grants: [{ target: { kind: 'pane', id: 'pane-own', generation: 1 }, capabilities: ['pane.observe'] }],
        },
        {
          id: 'request-other-pane',
          ownerEpoch: 7,
          actorId: 'agent-other',
          taskId: 'task-other',
          status: 'pending' as const,
          createdAt: '2026-08-12T12:00:00.000Z',
          ttlMs: 60_000,
          grants: [{ target: { kind: 'pane', id: 'pane-other', generation: 1 }, capabilities: ['pane.observe'] }],
        },
      ],
      approvals: [
        {
          id: 'approval-own',
          actionId: 'action-own',
          ownerEpoch: 7,
          taskId: 'task-own',
          actorId: 'agent-own',
          leaseId: 'lease-own',
          leaseRevision: 2,
          status: 'pending' as const,
          createdAt: '2026-08-12T12:00:00.000Z',
          expiresAt: '2026-08-12T12:05:00.000Z',
          resource: { kind: 'browser_tab', id: 'tab-own', generation: 1 },
          capability: 'browser.interact',
          effect: createRedactedApprovalEffect({ kind: 'submit', target: 'submit-own' }),
          payloadDigest: 'a'.repeat(64),
          executablePayloadDigest: 'b'.repeat(64),
        },
        {
          id: 'approval-other',
          actionId: 'action-other',
          ownerEpoch: 7,
          taskId: 'task-other',
          actorId: 'agent-other',
          leaseId: 'lease-other',
          leaseRevision: 1,
          status: 'pending' as const,
          createdAt: '2026-08-12T12:00:00.000Z',
          expiresAt: '2026-08-12T12:05:00.000Z',
          resource: { kind: 'browser_tab', id: 'tab-other', generation: 1 },
          capability: 'browser.interact',
          effect: createRedactedApprovalEffect({ kind: 'submit', target: 'submit-other' }),
          payloadDigest: 'c'.repeat(64),
          executablePayloadDigest: 'd'.repeat(64),
        },
      ],
      receipts: [
        {
          schema: 'psyche.control.receipt/v1',
          actionId: 'action-own',
          state: 'approval_required' as const,
          resource: { kind: 'browser_tab', id: 'tab-own', generation: 1 },
          createdAt: '2026-08-12T12:00:00.000Z',
          taskId: 'task-own',
          actorId: 'agent-own',
          leaseId: 'lease-own',
          leaseRevision: 2,
        },
        {
          schema: 'psyche.control.receipt/v1',
          actionId: 'action-other',
          state: 'approval_required' as const,
          resource: { kind: 'browser_tab', id: 'tab-other', generation: 1 },
          createdAt: '2026-08-12T12:00:00.000Z',
          taskId: 'task-other',
          actorId: 'agent-other',
          leaseId: 'lease-other',
          leaseRevision: 1,
        },
        {
          schema: 'psyche.control.receipt/v1',
          actionId: 'legacy-action',
          state: 'failed' as const,
          resource: { kind: 'browser_tab', id: 'tab-legacy', generation: 1 },
          createdAt: '2026-08-12T12:00:00.000Z',
          code: 'effect_failed',
        },
      ],
    } satisfies ControlSnapshot;
    const server = createControlServerForTest({ runtime: stubRuntime(vi.fn(), scopedSnapshot) });
    const operator: ControlPrincipal = {
      id: 'operator', kind: 'operator', capabilities: ['read', 'mutate', 'delegate'],
    };

    expect(server.snapshot(operator, { taskId: 'task-own' }).receipts.map((receipt) => receipt.actionId))
      .toEqual(expect.arrayContaining(['action-own', 'action-other', 'legacy-action']));

    const scoped = server.snapshot({
      principal: { id: 'agent-own', kind: 'agent', capabilities: ['read'] },
      taskBinding: { taskId: 'task-own', subjectId: 'subject-own' },
    }, { taskId: 'task-other' });
    expect(scoped.resources.map((resource) => resource.id).sort()).toEqual(['pane-own', 'tab-own']);
    expect(scoped.capabilityLeases.map((lease) => lease.id)).toEqual(['lease-own']);
    expect(scoped.leaseRequests.map((request) => request.id)).toEqual(['request-own-pane']);
    expect(scoped.approvals.map((approval) => approval.actionId)).toEqual(['action-own']);
    expect(scoped.receipts).toEqual([expect.objectContaining({
      actionId: 'action-own',
      state: 'approval_required',
    })]);
    expect(scoped.receipts[0]).not.toHaveProperty('taskId');
    expect(scoped.receipts[0]).not.toHaveProperty('leaseId');
    expect(scoped.receipts[0]).not.toHaveProperty('leaseRevision');
  });

  it('passes the authenticated principal into state.get snapshot redaction', async () => {
    const root = await tempProject();
    const endpoint = path.join(root, 'control.sock');
    const credentials = await createControlCredentialStore({
      projectRoot: root,
      filePath: path.join(root, 'control-credentials.json'),
    });
    const sensitive = sensitiveSnapshot();
    const server = await ControlServer.start({
      endpoint,
      projectRoot: root,
      ownerEpoch: 1,
      runtime: stubRuntime(vi.fn(), sensitive),
      credentials,
    });
    const cleanups: Array<() => Promise<void>> = [() => server.close()];

    try {
      const operator = await ControlClient.connect({
        projectRoot: root,
        endpoint,
        token: await credentials.operatorToken(),
        clientName: 'operator',
      });
      cleanups.unshift(() => operator.close());
      const agent = await ControlClient.connect({
        projectRoot: root,
        endpoint,
        token: await credentials.agentToken(),
        clientName: 'agent',
      });
      cleanups.unshift(() => agent.close());

      await expect(operator.getState()).resolves.toEqual(sensitive);
      const snapshot = await agent.getState();
      expect(snapshot).toMatchObject({
        ownerEpoch: 1,
        sequence: 2,
        commands: {},
        leases: {},
        resources: [],
        capabilityLeases: [],
        leaseRequests: [],
        approvals: [],
        receipts: [],
      });
      expect(JSON.stringify(snapshot)).not.toContain('secret');
    } finally {
      await Promise.allSettled(cleanups.map(async (close) => close()));
    }
  });

  it('returns only persisted own-task authority and receipts for a task-bound agent token', async () => {
    const root = await tempProject();
    const endpoint = path.join(root, 'control.sock');
    const harness = await createTaskScopedControlHarness({ projectRoot: root, endpoint });
    const cleanups: Array<() => Promise<void>> = [() => harness.server.close()];

    try {
      const operator = await ControlClient.connect({
        projectRoot: root,
        endpoint,
        token: await harness.credentials.operatorToken(),
        clientName: 'operator-task-scope',
      });
      cleanups.unshift(() => operator.close());
      const agent = await ControlClient.connect({
        projectRoot: root,
        endpoint,
        token: harness.ownTaskToken,
        clientName: 'agent-task-scope',
        taskBinding: { taskId: harness.ownTaskId },
      });
      cleanups.unshift(() => agent.close());

      const operatorSnapshot = await operator.getState();
      expect(Object.values(operatorSnapshot.leases).map((lease) => lease.paneId))
        .toContain(harness.laneOnlyPane.id);
      expect(operatorSnapshot.approvals.map((approval) => approval.actionId))
        .toEqual(expect.arrayContaining([harness.ownApprovalActionId, harness.otherApprovalActionId]));
      expect(operatorSnapshot.receipts.map((receipt) => receipt.actionId))
        .toEqual(expect.arrayContaining([harness.ownApprovalActionId, harness.otherApprovalActionId]));

      const ownSnapshot = await agent.getState();
      expect(ownSnapshot.commands).toEqual({});
      expect(ownSnapshot.leases).toEqual({});
      expect(ownSnapshot.resources.map((resource) => resource.id).sort())
        .toEqual([harness.ownPane.id, harness.ownTab.id].sort());
      expect(ownSnapshot.resources.map((resource) => resource.id)).not.toContain(harness.laneOnlyPane.id);
      expect(ownSnapshot.resources.map((resource) => resource.id)).not.toContain(harness.otherPane.id);
      expect(ownSnapshot.resources.map((resource) => resource.id)).not.toContain(harness.otherTab.id);
      expect(ownSnapshot.capabilityLeases).toEqual([expect.objectContaining({
        id: harness.ownTabLease.id,
        requestId: harness.ownTabRequestId,
        taskId: harness.ownTaskId,
      })]);
      expect(ownSnapshot.leaseRequests).toEqual([expect.objectContaining({
        id: harness.ownPaneRequestId,
        taskId: harness.ownTaskId,
      })]);
      expect(ownSnapshot.approvals).toEqual([expect.objectContaining({
        actionId: harness.ownApprovalActionId,
        leaseId: harness.ownTabLease.id,
        leaseRevision: harness.ownTabLease.revision,
      })]);
      expect(ownSnapshot.receipts).toEqual([expect.objectContaining({
        actionId: harness.ownApprovalActionId,
        state: 'approval_required',
      })]);
      expect(ownSnapshot.receipts[0]).not.toHaveProperty('taskId');
      expect(ownSnapshot.receipts[0]).not.toHaveProperty('leaseId');
      expect(ownSnapshot.receipts[0]).not.toHaveProperty('leaseRevision');

      const scoped = await agent.getState({ taskId: harness.otherTaskId });
      expect(scoped.commands).toEqual({});
      expect(scoped.leases).toEqual({});
      expect(scoped.resources.map((resource) => resource.id).sort())
        .toEqual([harness.ownPane.id, harness.ownTab.id].sort());
      expect(scoped.resources.map((resource) => resource.id)).not.toContain(harness.laneOnlyPane.id);
      expect(scoped.resources.map((resource) => resource.id)).not.toContain(harness.otherPane.id);
      expect(scoped.resources.map((resource) => resource.id)).not.toContain(harness.otherTab.id);
      expect(scoped.capabilityLeases).toHaveLength(1);
      expect(scoped.capabilityLeases[0]).toMatchObject({
        id: harness.ownTabLease.id,
        requestId: harness.ownTabRequestId,
        taskId: harness.ownTaskId,
      });
      expect(scoped.leaseRequests).toHaveLength(1);
      expect(scoped.leaseRequests[0]).toMatchObject({
        id: harness.ownPaneRequestId,
        taskId: harness.ownTaskId,
      });
      expect(scoped.approvals).toHaveLength(1);
      expect(scoped.approvals[0]).toMatchObject({
        actionId: harness.ownApprovalActionId,
        leaseId: harness.ownTabLease.id,
        leaseRevision: harness.ownTabLease.revision,
      });
      expect(scoped.receipts).toEqual([expect.objectContaining({
        actionId: harness.ownApprovalActionId,
        state: 'approval_required',
      })]);
      expect(scoped.receipts[0]).not.toHaveProperty('taskId');
      expect(scoped.receipts[0]).not.toHaveProperty('leaseId');
      expect(scoped.receipts[0]).not.toHaveProperty('leaseRevision');
    } finally {
      await Promise.allSettled(cleanups.map(async (close) => close()));
    }
  });

  it('rejects agent self-delegation and stamps operator identity', async () => {
    const submit = vi.fn(async (command) => ({ status: 'succeeded' as const, value: command.actor }));
    const server = createControlServerForTest({ runtime: stubRuntime(submit) });

    await expect(server.submitAs(
      { id: 'agent-1', kind: 'agent', capabilities: ['read', 'mutate', 'delegate'] },
      delegationInput(),
    )).resolves.toMatchObject({ status: 'rejected', code: 'delegation_not_authorized' });

    await expect(server.submitAs(
      { id: 'operator-1', kind: 'operator', capabilities: ['read', 'mutate', 'delegate'] },
      delegationInput(),
    )).resolves.toMatchObject({
      status: 'succeeded',
      value: { id: 'operator-1', kind: 'human' },
    });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it.each<ControlPrincipal>([
    { id: 'agent-1', kind: 'agent', capabilities: ['read', 'mutate', 'delegate'] },
    { id: 'compat-1', kind: 'compatibility', capabilities: ['read', 'mutate', 'delegate'] },
  ])('rejects delegation and takeover for $kind principals', async (principal) => {
    const submit = vi.fn(async () => ({ status: 'succeeded' as const }));
    const server = createControlServerForTest({ runtime: stubRuntime(submit) });

    await expect(server.submitAs(principal, delegationInput()))
      .resolves.toMatchObject({ status: 'rejected', code: 'delegation_not_authorized' });
    await expect(server.submitAs(principal, takeoverInput()))
      .resolves.toMatchObject({ status: 'rejected', code: 'takeover_not_authorized' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('permits operator takeover', async () => {
    const submit = vi.fn(async (command) => ({ status: 'succeeded' as const, value: command.actor }));
    const server = createControlServerForTest({ runtime: stubRuntime(submit) });

    await expect(server.submitAs(
      { id: 'operator-1', kind: 'operator', capabilities: ['read', 'mutate', 'delegate'] },
      takeoverInput(),
    )).resolves.toMatchObject({ status: 'succeeded', value: { kind: 'human' } });
  });

  it('restricts new authority commands and compatibility access', async () => {
    const submit = vi.fn(async () => ({ status: 'succeeded' as const }));
    const server = createControlServerForTest({ runtime: stubRuntime(submit) });
    const agent: ControlPrincipal = { id: 'agent-1', kind: 'agent', capabilities: ['read', 'mutate', 'delegate'] };
    const compatibility: ControlPrincipal = { id: 'compat-1', kind: 'compatibility', capabilities: ['read', 'mutate'] };
    const base = delegationInput();
    const grant = { ...base, kind: 'lease.grant' as const, payload: { requestId: 'r' } };
    const request = { ...base, kind: 'lease.request' as const, payload: { taskId: 't', ttlMs: 1, grants: [] } };
    await expect(server.submitAs(agent, grant)).resolves.toMatchObject({ status: 'rejected', code: 'operator_required' });
    await expect(server.submitAs(compatibility, request)).resolves.toMatchObject({ status: 'rejected', code: 'compatibility_not_authorized' });
    await expect(server.submitAs(agent, request)).resolves.toMatchObject({ status: 'rejected', code: 'task_binding_required' });
    await expect(server.submitAs({
      principal: agent,
      taskBinding: { taskId: 't', subjectId: 'subject-t' },
    }, request)).resolves.toMatchObject({ status: 'succeeded' });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it.each(['pane.spawn', 'pane.kill', 'pane.resize', 'coven.desktop.action'] as const)(
    'blocks agent principals from legacy %s bypass',
    async (kind) => {
      const submit = vi.fn(async () => ({ status: 'succeeded' as const }));
      const server = createControlServerForTest({ runtime: stubRuntime(submit) });
      const legacy = { ...takeoverInput(), kind, payload: {} } as ControlCommandInput;
      await expect(server.submitAs(
        { id: 'agent-1', kind: 'agent', capabilities: ['read', 'mutate', 'delegate'] },
        legacy,
      )).resolves.toMatchObject({ status: 'rejected', code: 'agent_not_authorized' });
      expect(submit).not.toHaveBeenCalled();
    },
  );
});
