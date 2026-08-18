import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ApprovalStore } from '../../src/control/approvals.js';
import {
  CapabilityLeaseStore,
  type CapabilityLease,
  type LeaseTarget,
  type SurfaceCapability,
} from '../../src/control/capabilityLeases.js';
import {
  createControlCredentialStore,
  issueControlTaskCredential,
  type ControlCredentialStore,
} from '../../src/control/credentials.js';
import { controlEndpointForProject } from '../../src/control/endpoint.js';
import {
  agentControlJournalPayload,
  ControlJournal,
  createAgentControlJournalResource,
} from '../../src/control/journal.js';
import { createCanonicalElementSemantics } from '../../src/control/policy.js';
import { ControlRuntime, type ControlHandlers } from '../../src/control/runtime.js';
import { ControlServer } from '../../src/control/server.js';
import { SurfaceRegistry, type BrowserTabSurface } from '../../src/control/surfaces.js';
import type { ControlCommand } from '../../src/control/types.js';
import { testControlStateRoot } from './controlCredentialPaths.js';

const FIRST_OWNER_EPOCH = 7;
const RESTARTED_OWNER_EPOCH = 8;
const NOW = '2026-08-12T12:00:00.000Z';

export interface RestartActionStatusHarness {
  projectRoot: string;
  stateRoot: string;
  endpoint: string;
  server: ControlServer;
  runtime: ControlRuntime;
  credentials: ControlCredentialStore;
  operatorToken: string;
  ownTaskId: string;
  otherTaskId: string;
  ownTaskToken: string;
  otherTaskToken: string;
  ownActionId: string;
  otherActionId: string;
  legacyActionId: string;
}

export async function createRestartActionStatusHarness(
  options: { projectRoot: string },
): Promise<RestartActionStatusHarness> {
  await mkdir(options.projectRoot, { recursive: true });

  const ownTaskId = 'task-own';
  const otherTaskId = 'task-other';
  const ownActionId = 'approval-own-action';
  const otherActionId = 'approval-other-action';
  const legacyActionId = 'legacy-pending-action';
  const credentialsPath = path.join(options.projectRoot, 'control-credentials.json');
  const stateRoot = testControlStateRoot(options.projectRoot);
  const credentials = await createControlCredentialStore({
    projectRoot: options.projectRoot,
    filePath: credentialsPath,
    stateRoot,
  });
  const operatorToken = await credentials.operatorToken();
  const ownCredential = await issueControlTaskCredential({
    projectRoot: options.projectRoot,
    filePath: credentialsPath,
    taskId: ownTaskId,
    stateRoot,
  });
  const otherCredential = await issueControlTaskCredential({
    projectRoot: options.projectRoot,
    filePath: credentialsPath,
    taskId: otherTaskId,
    stateRoot,
  });
  const ownTaskToken = ownCredential.token;
  const otherTaskToken = otherCredential.token;

  const firstJournal = await ControlJournal.open(options.projectRoot, FIRST_OWNER_EPOCH);
  const surfaces = new SurfaceRegistry();
  let approvalId = 0;
  const first = await ControlRuntime.create({
    ownerEpoch: FIRST_OWNER_EPOCH,
    handlers: createHandlers(),
    journal: firstJournal,
    surfaces,
    capabilityLeases: new CapabilityLeaseStore(() => new Date(NOW), FIRST_OWNER_EPOCH),
    approvals: new ApprovalStore(() => new Date(NOW), () => `approval-restart-${++approvalId}`),
    readActiveTaskCredential: credentials.currentTaskCredential,
    resolveBrowserElementSemantics: () => createCanonicalElementSemantics({ role: 'button', submit: true }),
  });

  const ownTab = surfaces.upsertBrowserTab({
    id: 'tab-own',
    projectRoot: options.projectRoot,
    worktreeRoot: options.projectRoot,
    providerId: 'provider-own',
    webviewLabel: 'own',
    url: 'https://own.example.test',
    title: 'Own',
    loading: false,
    viewport: { width: 1280, height: 720 },
  });
  const otherTab = surfaces.upsertBrowserTab({
    id: 'tab-other',
    projectRoot: options.projectRoot,
    worktreeRoot: options.projectRoot,
    providerId: 'provider-other',
    webviewLabel: 'other',
    url: 'https://other.example.test',
    title: 'Other',
    loading: false,
    viewport: { width: 1280, height: 720 },
  });

  const ownLease = await grantLease(first, options.projectRoot, {
    requestId: 'request-own',
    actorId: ownCredential.principalId,
    taskId: ownTaskId,
    target: { kind: 'browser_tab', id: ownTab.id, generation: ownTab.generation },
    capabilities: ['browser.interact'],
  });
  const otherLease = await grantLease(first, options.projectRoot, {
    requestId: 'request-other',
    actorId: otherCredential.principalId,
    taskId: otherTaskId,
    target: { kind: 'browser_tab', id: otherTab.id, generation: otherTab.generation },
    capabilities: ['browser.interact'],
  });

  await first.submit(actionCommand(options.projectRoot, ownActionId, {
    actorId: ownCredential.principalId,
    taskId: ownTaskId,
    lease: ownLease,
    tab: ownTab,
  }));
  await first.submit(actionCommand(options.projectRoot, otherActionId, {
    actorId: otherCredential.principalId,
    taskId: otherTaskId,
    lease: otherLease,
    tab: otherTab,
  }));

  const legacyPending = agentControlJournalPayload({
    kind: 'command.succeeded',
    commandId: legacyActionId,
    idempotencyKey: legacyActionId,
    status: 'succeeded',
    outcomeDigest: 'd'.repeat(64),
    receipt: {
      schema: 'psyche.control.receipt/v1',
      actionId: legacyActionId,
      state: 'approval_required',
      resource: createAgentControlJournalResource({
        kind: 'browser_tab',
        id: 'legacy-tab',
        generation: 1,
      }),
      createdAt: NOW,
    },
  });
  await firstJournal.append(legacyPending.kind, legacyPending.payload);

  const reopened = await ControlJournal.open(options.projectRoot, RESTARTED_OWNER_EPOCH);
  const runtime = await ControlRuntime.create({
    ownerEpoch: RESTARTED_OWNER_EPOCH,
    handlers: createHandlers(),
    journal: reopened,
    readActiveTaskCredential: credentials.currentTaskCredential,
  });
  const endpoint = controlEndpointForProject(options.projectRoot);
  const server = await ControlServer.start({
    endpoint,
    projectRoot: options.projectRoot,
    ownerEpoch: RESTARTED_OWNER_EPOCH,
    runtime,
    credentials,
  });

  return {
    projectRoot: options.projectRoot,
    stateRoot,
    endpoint,
    server,
    runtime,
    credentials,
    operatorToken,
    ownTaskId,
    otherTaskId,
    ownTaskToken,
    otherTaskToken,
    ownActionId,
    otherActionId,
    legacyActionId,
  };
}

async function grantLease(
  runtime: ControlRuntime,
  projectRoot: string,
  input: {
    requestId: string;
    actorId: string;
    taskId: string;
    target: LeaseTarget;
    capabilities: readonly SurfaceCapability[];
  },
): Promise<CapabilityLease> {
  await runtime.submit(command(projectRoot, {
    id: input.requestId,
    idempotencyKey: input.requestId,
    kind: 'lease.request',
    actor: { id: input.actorId, kind: 'psyche' },
    payload: {
      taskId: input.taskId,
      ttlMs: 60_000,
      grants: [{ target: input.target, capabilities: input.capabilities }],
    },
  }));
  const outcome = await runtime.submit(command(projectRoot, {
    id: `grant-${input.requestId}`,
    idempotencyKey: `grant-${input.requestId}`,
    kind: 'lease.grant',
    payload: { requestId: input.requestId },
  }));
  return (outcome as { value: { lease: CapabilityLease } }).value.lease;
}

function actionCommand(
  projectRoot: string,
  id: string,
  input: {
    actorId: string;
    taskId: string;
    lease: CapabilityLease;
    tab: BrowserTabSurface;
  },
): Extract<ControlCommand, { kind: 'browser.action' }> {
  return command(projectRoot, {
    id,
    idempotencyKey: id,
    kind: 'browser.action',
    actor: { id: input.actorId, kind: 'psyche' },
    payload: {
      taskId: input.taskId,
      leaseId: input.lease.id,
      leaseRevision: input.lease.revision,
      tabId: input.tab.id,
      generation: input.tab.generation,
      snapshotId: `snapshot-${id}`,
      action: { kind: 'submit', elementRef: `submit-${id}` },
    },
  }) as Extract<ControlCommand, { kind: 'browser.action' }>;
}

function createHandlers(): ControlHandlers {
  const noEffect = async () => undefined;
  return {
    executeOrchestration: noEffect,
    spawnPane: noEffect,
    sendPrompt: noEffect,
    interruptPane: noEffect,
    sendInput: noEffect,
    openTerminal: noEffect,
    resizePane: noEffect,
    focusPane: noEffect,
    killPane: noEffect,
    respawnPane: noEffect,
    openConflictPane: noEffect,
    updatePaneOption: noEffect,
    updatePaneMeta: noEffect,
    launchRitual: noEffect,
    launchCovenSession: noEffect,
    openCovenSession: noEffect,
    runCovenDesktopAction: noEffect,
    executeCovenCapability: noEffect,
    observePane: noEffect,
    actOnPane: noEffect,
    inspectBrowser: noEffect,
    actOnBrowser: noEffect,
    runBrowserScript: noEffect,
  };
}

function command(
  projectRoot: string,
  overrides: Record<string, unknown>,
): ControlCommand {
  return {
    id: 'command-1',
    idempotencyKey: 'command-1',
    kind: 'pane.takeover',
    projectRoot,
    actor: { id: 'operator-1', kind: 'human' },
    ownerEpoch: FIRST_OWNER_EPOCH,
    createdAt: NOW,
    payload: { paneId: 'pane-own' },
    ...overrides,
  } as ControlCommand;
}
