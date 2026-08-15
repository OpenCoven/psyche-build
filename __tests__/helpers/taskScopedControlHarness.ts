import path from 'node:path';
import { ApprovalStore } from '../../src/control/approvals.js';
import {
  CapabilityLeaseStore,
  type CapabilityLease,
} from '../../src/control/capabilityLeases.js';
import {
  createControlCredentialStore,
  issueControlTaskCredential,
  type ControlCredentialStore,
} from '../../src/control/credentials.js';
import {
  agentControlJournalPayload,
  createAgentControlJournalResource,
} from '../../src/control/journal.js';
import { createCanonicalElementSemantics } from '../../src/control/policy.js';
import { ControlRuntime, type ControlHandlers, type RuntimeJournal } from '../../src/control/runtime.js';
import { ControlServer } from '../../src/control/server.js';
import { SurfaceRegistry, type BrowserTabSurface, type PaneSurface } from '../../src/control/surfaces.js';
import type { ControlCommand } from '../../src/control/types.js';
import { testControlStateRoot } from './controlCredentialPaths.js';

const OWNER_EPOCH = 7;
const NOW = '2026-08-12T12:00:00.000Z';

export interface TaskScopedControlHarness {
  projectRoot: string;
  stateRoot: string;
  endpoint: string;
  server: ControlServer;
  runtime: ControlRuntime;
  credentials: ControlCredentialStore;
  ownTaskId: string;
  otherTaskId: string;
  ownTaskToken: string;
  otherTaskToken: string;
  ownSubjectId: string;
  otherSubjectId: string;
  ownPrincipalId: string;
  otherPrincipalId: string;
  ownPane: PaneSurface;
  laneOnlyPane: PaneSurface;
  otherPane: PaneSurface;
  ownTab: BrowserTabSurface;
  otherTab: BrowserTabSurface;
  ownPaneRequestId: string;
  ownTabRequestId: string;
  ownTabLease: CapabilityLease;
  ownApprovalActionId: string;
  otherApprovalActionId: string;
  legacyActionId: string;
}

export async function createTaskScopedControlHarness(options: {
  projectRoot: string;
  endpoint: string;
}): Promise<TaskScopedControlHarness> {
  const ownTaskId = 'task-own';
  const otherTaskId = 'task-other';
  const ownPaneRequestId = 'request-own-pane';
  const ownTabRequestId = 'request-own-tab';
  const otherPaneRequestId = 'request-other-pane';
  const otherTabRequestId = 'request-other-tab';
  const ownApprovalActionId = 'approval-own-action';
  const otherApprovalActionId = 'approval-other-action';
  const legacyActionId = 'legacy-unowned-action';
  const credentialsPath = path.join(options.projectRoot, 'control-credentials.json');
  const stateRoot = testControlStateRoot(options.projectRoot);
  const credentials = await createControlCredentialStore({
    projectRoot: options.projectRoot,
    filePath: credentialsPath,
    stateRoot,
  });
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
  const ownSubjectId = ownCredential.taskBinding.subjectId;
  const otherSubjectId = otherCredential.taskBinding.subjectId;
  const ownPrincipalId = ownCredential.principalId;
  const otherPrincipalId = otherCredential.principalId;
  const journal = createMemoryJournal();
  const surfaces = new SurfaceRegistry();
  const ownPane = surfaces.upsertPane({
    id: 'pane-own',
    projectRoot: options.projectRoot,
    worktreeRoot: options.projectRoot,
    tmuxPaneId: '%1',
    writable: true,
    outputSequence: 1,
  });
  const laneOnlyPane = surfaces.upsertPane({
    id: 'pane-lane-only',
    projectRoot: options.projectRoot,
    worktreeRoot: options.projectRoot,
    tmuxPaneId: '%2',
    writable: true,
    outputSequence: 2,
  });
  const otherPane = surfaces.upsertPane({
    id: 'pane-other',
    projectRoot: options.projectRoot,
    worktreeRoot: options.projectRoot,
    tmuxPaneId: '%3',
    writable: true,
    outputSequence: 3,
  });
  let approvalId = 0;
  const clock = () => new Date(NOW);
  const runtime = await ControlRuntime.create({
    ownerEpoch: OWNER_EPOCH,
    handlers: createHandlers(),
    journal,
    surfaces,
    capabilityLeases: new CapabilityLeaseStore(clock, OWNER_EPOCH),
    approvals: new ApprovalStore(clock, () => `approval-${++approvalId}`),
    readActiveTaskCredential: credentials.currentTaskCredential,
    resolveBrowserElementSemantics: () => createCanonicalElementSemantics({ role: 'button', submit: true }),
  });

  const ownTabUpsert = await runtime.submit(command(options.projectRoot, {
    id: 'provider-own-upsert',
    idempotencyKey: 'provider-own-upsert',
    kind: 'provider.resource.upsert',
    actor: { id: 'operator-1', kind: 'human' },
    payload: {
      resource: {
        id: 'tab-own',
        projectRoot: options.projectRoot,
        worktreeRoot: options.projectRoot,
        providerId: 'provider-own',
        webviewLabel: 'own',
        url: 'https://own.example',
        title: 'Own',
        loading: false,
        viewport: { width: 1280, height: 720 },
      },
    },
  }));
  const otherTabUpsert = await runtime.submit(command(options.projectRoot, {
    id: 'provider-other-upsert',
    idempotencyKey: 'provider-other-upsert',
    kind: 'provider.resource.upsert',
    actor: { id: 'operator-1', kind: 'human' },
    payload: {
      resource: {
        id: 'tab-other',
        projectRoot: options.projectRoot,
        worktreeRoot: options.projectRoot,
        providerId: 'provider-other',
        webviewLabel: 'other',
        url: 'https://other.example',
        title: 'Other',
        loading: false,
        viewport: { width: 1280, height: 720 },
      },
    },
  }));
  const ownTab = (ownTabUpsert as { value: { resource: BrowserTabSurface } }).value.resource;
  const otherTab = (otherTabUpsert as { value: { resource: BrowserTabSurface } }).value.resource;

  await runtime.submit(command(options.projectRoot, {
    id: 'delegate-lane-only',
    idempotencyKey: 'delegate-lane-only',
    kind: 'pane.delegate',
    actor: { id: 'operator-1', kind: 'human' },
    payload: {
      paneId: laneOnlyPane.id,
      automationActorId: 'agent-own',
      taskId: ownTaskId,
      ttlMs: 60_000,
    },
  }));

  await runtime.submit(command(options.projectRoot, {
    id: ownPaneRequestId,
    idempotencyKey: ownPaneRequestId,
    kind: 'lease.request',
    actor: { id: ownPrincipalId, kind: 'psyche' },
    payload: {
      taskId: ownTaskId,
      ttlMs: 60_000,
      grants: [{ target: { kind: 'pane', id: ownPane.id, generation: ownPane.generation }, capabilities: ['pane.observe'] }],
    },
  }));
  await runtime.submit(command(options.projectRoot, {
    id: otherPaneRequestId,
    idempotencyKey: otherPaneRequestId,
    kind: 'lease.request',
    actor: { id: otherPrincipalId, kind: 'psyche' },
    payload: {
      taskId: otherTaskId,
      ttlMs: 60_000,
      grants: [{ target: { kind: 'pane', id: otherPane.id, generation: otherPane.generation }, capabilities: ['pane.observe'] }],
    },
  }));
  await runtime.submit(command(options.projectRoot, {
    id: ownTabRequestId,
    idempotencyKey: ownTabRequestId,
    kind: 'lease.request',
    actor: { id: ownPrincipalId, kind: 'psyche' },
    payload: {
      taskId: ownTaskId,
      ttlMs: 60_000,
      grants: [{
        target: { kind: 'browser_tab', id: ownTab.id, generation: ownTab.generation },
        capabilities: ['browser.interact'],
      }],
    },
  }));
  await runtime.submit(command(options.projectRoot, {
    id: otherTabRequestId,
    idempotencyKey: otherTabRequestId,
    kind: 'lease.request',
    actor: { id: otherPrincipalId, kind: 'psyche' },
    payload: {
      taskId: otherTaskId,
      ttlMs: 60_000,
      grants: [{
        target: { kind: 'browser_tab', id: otherTab.id, generation: otherTab.generation },
        capabilities: ['browser.interact'],
      }],
    },
  }));

  const ownTabGrant = await runtime.submit(command(options.projectRoot, {
    id: 'grant-own-tab',
    idempotencyKey: 'grant-own-tab',
    kind: 'lease.grant',
    actor: { id: 'operator-1', kind: 'human' },
    payload: { requestId: ownTabRequestId },
  }));
  await runtime.submit(command(options.projectRoot, {
    id: 'grant-other-tab',
    idempotencyKey: 'grant-other-tab',
    kind: 'lease.grant',
    actor: { id: 'operator-1', kind: 'human' },
    payload: { requestId: otherTabRequestId },
  }));

  const ownTabLease = (ownTabGrant as { value: { lease: CapabilityLease } }).value.lease;
  const otherTabLease = runtime.snapshot().capabilityLeases
    .find((lease) => lease.requestId === otherTabRequestId)!;

  await runtime.submit(command(options.projectRoot, {
    id: ownApprovalActionId,
    idempotencyKey: ownApprovalActionId,
    kind: 'browser.action',
    actor: { id: ownPrincipalId, kind: 'psyche' },
    payload: {
      taskId: ownTaskId,
      leaseId: ownTabLease.id,
      leaseRevision: ownTabLease.revision,
      tabId: ownTab.id,
      generation: ownTab.generation,
      snapshotId: 'snapshot-own',
      action: { kind: 'submit', elementRef: 'submit-own' },
    },
  }));
  await runtime.submit(command(options.projectRoot, {
    id: otherApprovalActionId,
    idempotencyKey: otherApprovalActionId,
    kind: 'browser.action',
    actor: { id: otherPrincipalId, kind: 'psyche' },
    payload: {
      taskId: otherTaskId,
      leaseId: otherTabLease.id,
      leaseRevision: otherTabLease.revision,
      tabId: otherTab.id,
      generation: otherTab.generation,
      snapshotId: 'snapshot-other',
      action: { kind: 'submit', elementRef: 'submit-other' },
    },
  }));

  const legacyEvent = agentControlJournalPayload({
    kind: 'command.failed',
    commandId: legacyActionId,
    idempotencyKey: legacyActionId,
    status: 'failed',
    receipt: {
      schema: 'psyche.control.receipt/v1',
      actionId: legacyActionId,
      state: 'failed',
      resource: createAgentControlJournalResource({
        kind: 'browser_tab',
        id: 'legacy-tab',
        generation: 1,
      }),
      createdAt: NOW,
      completedAt: NOW,
      code: 'effect_failed',
    },
  });
  await journal.append(legacyEvent.kind, legacyEvent.payload);

  const server = await ControlServer.start({
    endpoint: options.endpoint,
    projectRoot: options.projectRoot,
    ownerEpoch: OWNER_EPOCH,
    runtime,
    credentials,
  });

  return {
    projectRoot: options.projectRoot,
    stateRoot,
    endpoint: options.endpoint,
    server,
    runtime,
    credentials,
    ownTaskId,
    otherTaskId,
    ownTaskToken,
    otherTaskToken,
    ownSubjectId,
    otherSubjectId,
    ownPrincipalId,
    otherPrincipalId,
    ownPane,
    laneOnlyPane,
    otherPane,
    ownTab,
    otherTab,
    ownPaneRequestId,
    ownTabRequestId,
    ownTabLease,
    ownApprovalActionId,
    otherApprovalActionId,
    legacyActionId,
  };
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

function createMemoryJournal(): RuntimeJournal {
  const events: Array<{ sequence: number; kind: string; payload: Record<string, unknown> }> = [];
  return {
    append: async (kind, payload) => {
      const event = { sequence: events.length + 1, kind, payload };
      events.push(event);
      return event;
    },
    read: (afterSequence, limit) => {
      const filtered = events.filter((event) => event.sequence > afterSequence);
      return limit === undefined ? filtered : filtered.slice(0, limit);
    },
    findByIdempotencyKey: (key) => [...events].reverse().find((event) => event.payload.idempotencyKey === key),
    recoverNonterminalCommands: async () => [],
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
    ownerEpoch: OWNER_EPOCH,
    createdAt: NOW,
    payload: { paneId: 'pane-own' },
    ...overrides,
  } as ControlCommand;
}
