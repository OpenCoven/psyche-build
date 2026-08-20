import type { PsychePane } from '../types.js';
import {
  isTmuxServerIdentity,
  sameTmuxServerIdentity,
  type TmuxServerIdentity,
} from '../services/TmuxServerIdentity.js';
import {
  readProjectPaneConfig,
  transactProjectPaneConfig,
} from '../services/ProjectPaneConfig.js';
import {
  assertTmuxResourcesAvailable,
  type TmuxResource,
} from '../services/TmuxResourceOwnership.js';
import { writeWorktreeRecoveryMarker } from '../services/WorktreeRecoveryMarker.js';
import type {
  VerifiedPaneTeardownResult,
} from './paneTeardown.js';

export type BackgroundWindowType = 'test' | 'dev';

export interface BackgroundWindowResource {
  windowId: string;
  paneId: string;
  /** The tmux generation that allocated this detached pane/window pair. */
  tmuxServerIdentity: TmuxServerIdentity;
}

export interface BackgroundWindowTransactionOptions {
  type: BackgroundWindowType;
  projectRoot: string;
  /**
   * The identity the UI actually selected. Claiming is an exact CAS: a
   * rebind cannot receive a command intended for this stale pane.
   */
  pane: Pick<PsychePane, 'id' | 'paneId' | 'worktreePath'>;
  /** Allocates the detached window and returns its tmux window ID. */
  allocateWindow: () => Promise<string>;
  /** Resolves the first pane in an already allocated detached window. */
  getWindowPaneId: (windowId: string) => Promise<string>;
  sendCommand: (resource: BackgroundWindowResource) => Promise<void>;
  tearDownResource: (
    resource: BackgroundWindowResource,
    allocationIdentity: TmuxServerIdentity,
  ) => Promise<VerifiedPaneTeardownResult>;
  /** Teardown for a window whose pane lookup or resource construction failed. */
  tearDownAllocatedWindow: (
    windowId: string,
    allocationIdentity: TmuxServerIdentity,
  ) => Promise<VerifiedPaneTeardownResult>;
  /** Read immediately before teardown; absent means destructive work is unsafe. */
  getTmuxServerIdentity: () => TmuxServerIdentity | undefined;
  /**
   * Used only when config persistence cannot retain an uncertain resource.
   * Callers write a worktree recovery marker from this callback.
   */
  retainUncertainRecovery?: (
    pane: PsychePane,
    reason: string,
  ) => Promise<string | undefined>;
}

export interface BackgroundWindowTransactionResult {
  windowId: string;
  paneId: string;
  pane: PsychePane;
}

export interface ExpectedBackgroundWindow {
  windowId: string;
  paneId?: string;
  tmuxServerIdentity: TmuxServerIdentity;
}

export interface JoinBackgroundWindowTransactionOptions {
  type: BackgroundWindowType;
  projectRoot: string;
  pane: Pick<PsychePane, 'id' | 'paneId' | 'worktreePath'>;
  expectedWindow: ExpectedBackgroundWindow;
  getWindowPaneId: (windowId: string) => Promise<string>;
  joinPane: (windowId: string) => Promise<void>;
  tearDownJoinedPane: (
    paneId: string,
    allocationIdentity: TmuxServerIdentity,
  ) => Promise<VerifiedPaneTeardownResult>;
  getTmuxServerIdentity: () => TmuxServerIdentity | undefined;
  retainUncertainRecovery?: (
    pane: PsychePane,
    reason: string,
  ) => Promise<string | undefined>;
}

class BackgroundClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackgroundClaimError';
  }
}

/**
 * Creates a detached background resource, then claims it in the fresh,
 * locked pane registry before any command can run. The persisted claim is
 * reread and verified while the same config lock remains held.
 */
export async function startBackgroundWindowTransaction(
  options: BackgroundWindowTransactionOptions,
): Promise<BackgroundWindowTransactionResult> {
  const resource = await allocateBackgroundWindow(options);
  let claimedPane: PsychePane | undefined;

  try {
    const transaction = await transactProjectPaneConfig(
      options.projectRoot,
      async ({ config, persist }) => {
        const panes = Array.isArray(config.panes)
          ? [...config.panes] as PsychePane[]
          : [];
        const index = panes.findIndex((candidate) => candidate.id === options.pane.id);
        const current = index >= 0 ? panes[index] : undefined;
        if (!current || current.paneId !== options.pane.paneId) {
          throw new BackgroundClaimError(
            `Pane "${options.pane.id}" is missing or rebound before ${options.type} ownership could be claimed`,
          );
        }
        if (hasBackgroundClaim(current, options.type)) {
          throw new BackgroundClaimError(
            `Pane "${options.pane.id}" already owns a ${options.type} background resource`,
          );
        }
        assertTmuxResourcesAvailable(
          panes as Array<PsychePane & Record<string, unknown>>,
          current.id,
          backgroundResourceClaims(options.type, resource),
        );

        const claimed = withBackgroundWindow(current, options.type, resource);
        panes[index] = claimed;
        config.panes = panes;
        config.lastUpdated = new Date().toISOString();
        await persist();

        const persisted = await readProjectPaneConfig(options.projectRoot);
        const persistedPane = Array.isArray(persisted.panes)
          ? persisted.panes.find((candidate) => (
            asPane(candidate).id === options.pane.id
          ))
          : undefined;
        if (
          !persistedPane
          || !hasExactPaneIdentity(asPane(persistedPane), options.pane)
          || !hasExactBackgroundResource(
            asPane(persistedPane),
            options.type,
            resource,
          )
        ) {
          throw new BackgroundClaimError(
            `Could not verify persisted ${options.type} ownership for pane "${options.pane.id}"`,
          );
        }
        return claimed;
      },
    );
    claimedPane = transaction.result;
  } catch (error) {
    const teardown = await tearDownResourceForGeneration(options, resource);
    let cleanup: string | undefined;
    if (teardown.presence === 'absent') {
      try {
        await clearExactBackgroundClaim(
          options.projectRoot,
          options.pane,
          options.type,
          resource,
        );
      } catch (cleanupError) {
        cleanup = `could not clear a persisted claim: ${errorMessage(cleanupError)}`;
      }
    } else {
      cleanup = await retainBackgroundRecovery(
        options,
        resource,
        `Could not claim ${options.type} background resource ${resource.windowId}; teardown is ${teardown.presence}`,
      );
    }
    throw transactionError(
      error instanceof BackgroundClaimError
        ? error.message
        : `Could not persist ${options.type} background resource ${resource.windowId}: ${
          errorMessage(error)
        }`,
      teardown,
      cleanup,
    );
  }

  try {
    await options.sendCommand(resource);
  } catch (error) {
    const teardown = await tearDownResourceForGeneration(options, resource);
    if (teardown.presence === 'absent') {
      try {
        await clearExactBackgroundClaim(
          options.projectRoot,
          options.pane,
          options.type,
          resource,
        );
      } catch (cleanupError) {
        throw transactionError(
          `Failed to launch ${options.type} command: ${errorMessage(error)}`,
          teardown,
          `could not remove its exact resource fields: ${errorMessage(cleanupError)}`,
        );
      }
      throw transactionError(
        `Failed to launch ${options.type} command: ${errorMessage(error)}`,
        teardown,
      );
    }

    const recovery = await retainBackgroundRecovery(
      options,
      resource,
      `Failed to launch ${options.type} command; teardown is ${teardown.presence}`,
    );
    throw transactionError(
      `Failed to launch ${options.type} command: ${errorMessage(error)}`,
      teardown,
      recovery,
    );
  }

  return {
    windowId: resource.windowId,
    paneId: resource.paneId,
    pane: claimedPane!,
  };
}

/**
 * Establishes a compensation boundary at the exact moment tmux reports a
 * window ID. A failed generation recapture or getWindowPaneId call therefore
 * cannot strand an untracked detached window.
 */
async function allocateBackgroundWindow(
  options: BackgroundWindowTransactionOptions,
): Promise<BackgroundWindowResource> {
  const allocationIdentity = readTmuxServerIdentity(options);
  if (!allocationIdentity) {
    throw new Error(
      `Could not capture tmux server generation before ${options.type} window allocation`,
    );
  }

  let allocatedWindowId: string | undefined;
  try {
    allocatedWindowId = await options.allocateWindow();
    if (!allocatedWindowId) {
      throw new Error(
        `${options.type} window allocation did not return a tmux window ID`,
      );
    }
    const identityAfterWindowAllocation = readTmuxServerIdentity(options);
    if (!identityAfterWindowAllocation) {
      throw new Error(
        `Could not recapture tmux server generation after ${options.type} window allocation`,
      );
    }
    if (!sameTmuxServerIdentity(allocationIdentity, identityAfterWindowAllocation)) {
      throw new Error(
        `tmux server generation changed during ${options.type} window allocation`,
      );
    }
    const paneId = await options.getWindowPaneId(allocatedWindowId);
    const resource: BackgroundWindowResource = {
      windowId: allocatedWindowId,
      paneId,
      tmuxServerIdentity: allocationIdentity,
    };
    assertBackgroundResource(resource);
    const currentIdentity = readTmuxServerIdentity(options);
    if (!currentIdentity) {
      throw new Error(
        `Could not recapture tmux server generation after ${options.type} window allocation`,
      );
    }
    if (!sameTmuxServerIdentity(allocationIdentity, currentIdentity)) {
      throw new Error(
        `tmux server generation changed during ${options.type} window allocation`,
      );
    }
    return resource;
  } catch (error) {
    if (!allocatedWindowId) {
      throw error;
    }

    const teardown = await tearDownAllocatedWindowForGeneration(
      options,
      allocatedWindowId,
      allocationIdentity,
    );
    const reason = `Could not construct ${options.type} background resource ${
      allocatedWindowId
    }: ${errorMessage(error)}; teardown is ${teardown.presence}`;
    const recovery = teardown.presence === 'absent'
      ? undefined
      : await retainUncertainBackgroundRecovery(
        options,
        { ...options.pane, slug: '', prompt: '' },
        reason,
      );
    throw transactionError(
      `Could not create ${options.type} background resource ${allocatedWindowId}: ${
        errorMessage(error)
      }`,
      teardown,
      recovery,
    );
  }
}

/**
 * Persists the pane ID after join-pane. tmux preserves pane IDs on join, but
 * this exact CAS makes a legacy/missing field durable without allowing a
 * concurrently rebound pane to be updated.
 */
export async function joinBackgroundWindowTransaction(
  options: JoinBackgroundWindowTransactionOptions,
): Promise<PsychePane> {
  let joinedPaneId: string | undefined;
  let joinAttempted = false;
  try {
    const transaction = await transactProjectPaneConfig(
      options.projectRoot,
      async ({ config, persist }) => {
        const panes = Array.isArray(config.panes)
          ? [...config.panes] as PsychePane[]
          : [];
        const index = panes.findIndex((candidate) => candidate.id === options.pane.id);
        const current = index >= 0 ? panes[index] : undefined;
        if (
          !current
          || !hasExactPaneIdentity(current, options.pane)
          || !hasExpectedBackgroundWindow(
            current,
            options.type,
            options.expectedWindow,
          )
        ) {
          throw new BackgroundClaimError(
            `Pane "${options.pane.id}" is missing, rebound, or replaced before its ${options.type} window could be joined`,
          );
        }
        assertCurrentTmuxGeneration(
          options.getTmuxServerIdentity,
          options.expectedWindow.tmuxServerIdentity,
          `before joining ${options.type} window ${options.expectedWindow.windowId}`,
        );

        joinedPaneId = await options.getWindowPaneId(options.expectedWindow.windowId);
        if (!joinedPaneId) {
          throw new Error(`Cannot join an empty ${options.type} background pane ID`);
        }
        joinAttempted = true;
        await options.joinPane(options.expectedWindow.windowId);
        assertCurrentTmuxGeneration(
          options.getTmuxServerIdentity,
          options.expectedWindow.tmuxServerIdentity,
          `after joining ${options.type} window ${options.expectedWindow.windowId}`,
        );

        const next = withBackgroundWindowPaneId(current, options.type, joinedPaneId);
        panes[index] = next;
        config.panes = panes;
        config.lastUpdated = new Date().toISOString();
        await persist();
        return next;
      },
    );
    return transaction.result;
  } catch (error) {
    if (!joinAttempted || !joinedPaneId) {
      throw error;
    }

    const teardown = await tearDownJoinedPaneForGeneration(
      options,
      joinedPaneId,
    );
    let recovery: string | undefined;
    if (teardown.presence === 'absent') {
      try {
        await clearExpectedBackgroundClaim(options);
      } catch (cleanupError) {
        recovery = `could not clear the exact failed background claim: ${
          errorMessage(cleanupError)
        }`;
      }
    } else {
      recovery = await retainJoinedBackgroundRecovery(
        options,
        joinedPaneId,
        `Could not persist joined ${options.type} pane ${joinedPaneId}; teardown is ${teardown.presence}`,
      );
    }
    throw transactionError(
      `Could not persist joined ${options.type} pane ${joinedPaneId}: ${
        errorMessage(error)
      }`,
      teardown,
      recovery,
    );
  }
}

export function withBackgroundWindow(
  pane: PsychePane,
  type: BackgroundWindowType,
  resource: BackgroundWindowResource,
): PsychePane {
  const recoveries = (pane.backgroundWindowRecoveries || []).filter(
    (recovery) => recovery.type !== type,
  );
  const next: PsychePane = {
    ...pane,
    [type === 'test' ? 'testWindowId' : 'devWindowId']: resource.windowId,
    [type === 'test' ? 'testPaneId' : 'devPaneId']: resource.paneId,
    ...(
      resource.tmuxServerIdentity
        ? {
          [type === 'test' ? 'testTmuxServerIdentity' : 'devTmuxServerIdentity']:
            resource.tmuxServerIdentity,
        }
        : {}
    ),
    [type === 'test' ? 'testStatus' : 'devStatus']: 'running',
  };
  if (recoveries.length > 0) {
    next.backgroundWindowRecoveries = recoveries;
  } else {
    delete next.backgroundWindowRecoveries;
  }
  return next;
}

export function withoutBackgroundWindow(
  pane: PsychePane,
  type: BackgroundWindowType,
): PsychePane {
  const next: PsychePane = { ...pane };
  if (type === 'test') {
    delete next.testWindowId;
    delete next.testPaneId;
    delete next.testTmuxServerIdentity;
    delete next.testStatus;
    delete next.testOutput;
  } else {
    delete next.devWindowId;
    delete next.devPaneId;
    delete next.devTmuxServerIdentity;
    delete next.devStatus;
    delete next.devUrl;
  }
  const recoveries = (next.backgroundWindowRecoveries || []).filter(
    (recovery) => recovery.type !== type,
  );
  if (recoveries.length > 0) {
    next.backgroundWindowRecoveries = recoveries;
  } else {
    delete next.backgroundWindowRecoveries;
  }
  return next;
}

function withBackgroundWindowPaneId(
  pane: PsychePane,
  type: BackgroundWindowType,
  paneId: string,
): PsychePane {
  return {
    ...pane,
    [type === 'test' ? 'testPaneId' : 'devPaneId']: paneId,
  };
}

async function clearExactBackgroundClaim(
  projectRoot: string,
  expectedPane: Pick<PsychePane, 'id' | 'paneId'>,
  type: BackgroundWindowType,
  resource: BackgroundWindowResource,
): Promise<void> {
  await transactProjectPaneConfig(projectRoot, async ({ config, persist }) => {
    const panes = Array.isArray(config.panes)
      ? [...config.panes] as PsychePane[]
      : [];
    const index = panes.findIndex((pane) => pane.id === expectedPane.id);
    const current = index >= 0 ? panes[index] : undefined;
    if (
      !current
      || !hasExactPaneIdentity(current, expectedPane)
      || !hasExactBackgroundResource(current, type, resource)
    ) {
      return;
    }
    panes[index] = withoutBackgroundWindow(current, type);
    config.panes = panes;
    config.lastUpdated = new Date().toISOString();
    await persist();
  });
}

async function retainBackgroundRecovery(
  options: BackgroundWindowTransactionOptions,
  resource: BackgroundWindowResource,
  reason: string,
): Promise<string | undefined> {
  try {
    await transactProjectPaneConfig(options.projectRoot, async ({ config, persist }) => {
      const panes = Array.isArray(config.panes)
        ? [...config.panes] as PsychePane[]
        : [];
      const index = panes.findIndex((pane) => pane.id === options.pane.id);
      const current = index >= 0 ? panes[index] : undefined;
      if (
        !current
        || !hasExactPaneIdentity(current, options.pane)
        || !hasExactBackgroundResource(current, options.type, resource)
      ) {
        throw new BackgroundClaimError(
          `Could not retain recovery fields for ${options.type} resource ${resource.windowId}`,
        );
      }
      const recoveries = (current.backgroundWindowRecoveries || []).filter(
        (recovery) => recovery.type !== options.type,
      );
      panes[index] = {
        ...current,
        backgroundWindowRecoveries: [
          ...recoveries,
          {
            type: options.type,
            windowId: resource.windowId,
            paneId: resource.paneId,
            ...(resource.tmuxServerIdentity
              ? { tmuxServerIdentity: resource.tmuxServerIdentity }
              : {}),
            reason,
          },
        ],
      };
      config.panes = panes;
      config.lastUpdated = new Date().toISOString();
      await persist();
    });
    return `retained durable recovery fields for ${options.type} resource ${resource.windowId}`;
  } catch (error) {
    const fallbackPane = withBackgroundWindowRecovery(
      withBackgroundWindow(
        { ...options.pane, slug: '', prompt: '' },
        options.type,
        resource,
      ),
      options.type,
      resource,
      reason,
    );
    const marker = await retainUncertainBackgroundRecovery(
      options,
      fallbackPane,
      `${reason}: ${errorMessage(error)}`,
    );
    return marker;
  }
}

async function retainUncertainBackgroundRecovery(
  options: BackgroundWindowTransactionOptions,
  pane: PsychePane,
  reason: string,
): Promise<string> {
  const customRecovery = await options.retainUncertainRecovery?.(pane, reason);
  if (customRecovery) {
    return customRecovery;
  }
  try {
    const marker = await writeWorktreeRecoveryMarker({
      projectRoot: options.projectRoot,
      worktreePath: pane.worktreePath || options.projectRoot,
      pane: { id: pane.id, paneId: pane.paneId },
      operation: `background-${options.type}-allocation`,
      reason,
    });
    return `wrote recovery marker ${marker.path}. ${
      marker.warning ? `${marker.warning}. ` : ''
    }${marker.marker.operatorInstructions}`;
  } catch (error) {
    return `could not write recovery marker: ${errorMessage(error)}`;
  }
}

function withBackgroundWindowRecovery(
  pane: PsychePane,
  type: BackgroundWindowType,
  resource: BackgroundWindowResource,
  reason: string,
): PsychePane {
  const recoveries = (pane.backgroundWindowRecoveries || []).filter(
    (recovery) => recovery.type !== type,
  );
  return {
    ...pane,
    backgroundWindowRecoveries: [
      ...recoveries,
      {
        type,
        windowId: resource.windowId,
        paneId: resource.paneId,
        ...(resource.tmuxServerIdentity
          ? { tmuxServerIdentity: resource.tmuxServerIdentity }
          : {}),
        reason,
      },
    ],
  };
}

function hasBackgroundClaim(pane: PsychePane, type: BackgroundWindowType): boolean {
  return Boolean(backgroundWindowId(pane, type) || backgroundPaneId(pane, type));
}

function hasExactBackgroundResource(
  pane: PsychePane,
  type: BackgroundWindowType,
  resource: BackgroundWindowResource,
): boolean {
  return (
    backgroundWindowId(pane, type) === resource.windowId
    && backgroundPaneId(pane, type) === resource.paneId
  );
}

function hasExpectedBackgroundWindow(
  pane: PsychePane,
  type: BackgroundWindowType,
  expected: ExpectedBackgroundWindow,
): boolean {
  const generation = type === 'test'
    ? pane.testTmuxServerIdentity
    : pane.devTmuxServerIdentity;
  return (
    backgroundWindowId(pane, type) === expected.windowId
    && (
      expected.paneId === undefined
      || backgroundPaneId(pane, type) === expected.paneId
    )
    && isTmuxServerIdentity(generation)
    && sameTmuxServerIdentity(generation, expected.tmuxServerIdentity)
  );
}

function backgroundWindowId(
  pane: PsychePane,
  type: BackgroundWindowType,
): string | undefined {
  return type === 'test' ? pane.testWindowId : pane.devWindowId;
}

function backgroundPaneId(
  pane: PsychePane,
  type: BackgroundWindowType,
): string | undefined {
  return type === 'test' ? pane.testPaneId : pane.devPaneId;
}

function hasExactPaneIdentity(
  pane: Pick<PsychePane, 'id' | 'paneId'>,
  expected: Pick<PsychePane, 'id' | 'paneId'>,
): boolean {
  return pane.id === expected.id && pane.paneId === expected.paneId;
}

function asPane(value: unknown): PsychePane {
  return value as PsychePane;
}

function assertBackgroundResource(
  resource: BackgroundWindowResource,
): asserts resource is BackgroundWindowResource {
  if (
    !resource
    || !resource.windowId
    || !resource.paneId
    || !isTmuxServerIdentity(resource.tmuxServerIdentity)
  ) {
    throw new Error(
      'Background window creation did not return stable window, pane, and tmux generation IDs',
    );
  }
}

function backgroundResourceClaims(
  type: BackgroundWindowType,
  resource: BackgroundWindowResource,
): TmuxResource[] {
  return [
    {
      kind: 'window',
      id: resource.windowId,
      ...(resource.tmuxServerIdentity
        ? { generation: resource.tmuxServerIdentity }
        : {}),
      field: type === 'test' ? 'testWindowId' : 'devWindowId',
    },
    {
      kind: 'pane',
      id: resource.paneId,
      ...(resource.tmuxServerIdentity
        ? { generation: resource.tmuxServerIdentity }
        : {}),
      field: type === 'test' ? 'testPaneId' : 'devPaneId',
    },
  ];
}

async function tearDownResourceForGeneration(
  options: BackgroundWindowTransactionOptions,
  resource: BackgroundWindowResource,
): Promise<VerifiedPaneTeardownResult> {
  if (resource.tmuxServerIdentity) {
    const current = readTmuxServerIdentity(options);
    if (!current) {
      return {
        presence: 'unknown',
        error: 'current tmux server generation could not be verified',
      };
    }
    if (!sameTmuxServerIdentity(resource.tmuxServerIdentity, current)) {
      // The caller's exact config CAS will remove this old-generation claim;
      // a reused pane/window ID in the new server is intentionally untouched.
      return { presence: 'absent' };
    }
  }
  return options.tearDownResource(resource, resource.tmuxServerIdentity);
}

async function tearDownAllocatedWindowForGeneration(
  options: BackgroundWindowTransactionOptions,
  windowId: string,
  allocationIdentity: TmuxServerIdentity,
): Promise<VerifiedPaneTeardownResult> {
  const current = readTmuxServerIdentity(options);
  if (!current) {
    return {
      presence: 'unknown',
      error: 'current tmux server generation could not be verified',
    };
  }
  if (!sameTmuxServerIdentity(allocationIdentity, current)) {
    return { presence: 'absent' };
  }
  return options.tearDownAllocatedWindow(windowId, allocationIdentity);
}

async function tearDownJoinedPaneForGeneration(
  options: JoinBackgroundWindowTransactionOptions,
  paneId: string,
): Promise<VerifiedPaneTeardownResult> {
  const current = readTmuxIdentity(options.getTmuxServerIdentity);
  if (!current) {
    return {
      presence: 'unknown',
      error: 'current tmux server generation could not be verified',
    };
  }
  if (!sameTmuxServerIdentity(
    options.expectedWindow.tmuxServerIdentity,
    current,
  )) {
    return { presence: 'absent' };
  }
  return options.tearDownJoinedPane(
    paneId,
    options.expectedWindow.tmuxServerIdentity,
  );
}

async function clearExpectedBackgroundClaim(
  options: JoinBackgroundWindowTransactionOptions,
): Promise<void> {
  await transactProjectPaneConfig(options.projectRoot, async ({ config, persist }) => {
    const panes = Array.isArray(config.panes)
      ? [...config.panes] as PsychePane[]
      : [];
    const index = panes.findIndex((pane) => pane.id === options.pane.id);
    const current = index >= 0 ? panes[index] : undefined;
    if (
      !current
      || !hasExactPaneIdentity(current, options.pane)
      || !hasExpectedBackgroundWindow(
        current,
        options.type,
        options.expectedWindow,
      )
    ) {
      return;
    }
    panes[index] = withoutBackgroundWindow(current, options.type);
    config.panes = panes;
    config.lastUpdated = new Date().toISOString();
    await persist();
  });
}

async function retainJoinedBackgroundRecovery(
  options: JoinBackgroundWindowTransactionOptions,
  paneId: string,
  reason: string,
): Promise<string> {
  const resource: BackgroundWindowResource = {
    windowId: options.expectedWindow.windowId,
    paneId,
    tmuxServerIdentity: options.expectedWindow.tmuxServerIdentity,
  };
  try {
    await transactProjectPaneConfig(options.projectRoot, async ({ config, persist }) => {
      const panes = Array.isArray(config.panes)
        ? [...config.panes] as PsychePane[]
        : [];
      const index = panes.findIndex((pane) => pane.id === options.pane.id);
      const current = index >= 0 ? panes[index] : undefined;
      if (
        !current
        || !hasExactPaneIdentity(current, options.pane)
        || !hasExpectedBackgroundWindow(
          current,
          options.type,
          options.expectedWindow,
        )
      ) {
        throw new BackgroundClaimError(
          `Could not retain recovery fields for joined ${options.type} pane ${paneId}`,
        );
      }
      panes[index] = withBackgroundWindowRecovery(
        withBackgroundWindow(current, options.type, resource),
        options.type,
        resource,
        reason,
      );
      config.panes = panes;
      config.lastUpdated = new Date().toISOString();
      await persist();
    });
    return `retained durable recovery fields for joined ${options.type} pane ${paneId}`;
  } catch (error) {
    const fallbackPane = withBackgroundWindowRecovery(
      withBackgroundWindow(
        { ...options.pane, slug: '', prompt: '' },
        options.type,
        resource,
      ),
      options.type,
      resource,
      reason,
    );
    const customRecovery = await options.retainUncertainRecovery?.(
      fallbackPane,
      `${reason}: ${errorMessage(error)}`,
    );
    if (customRecovery) {
      return customRecovery;
    }
    try {
      const marker = await writeWorktreeRecoveryMarker({
        projectRoot: options.projectRoot,
        worktreePath: options.pane.worktreePath || options.projectRoot,
        pane: { id: options.pane.id, paneId: options.pane.paneId },
        operation: `background-${options.type}-join`,
        reason: `${reason}: ${errorMessage(error)}`,
      });
      return `wrote recovery marker ${marker.path}. ${
        marker.warning ? `${marker.warning}. ` : ''
      }${marker.marker.operatorInstructions}`;
    } catch (markerError) {
      return `could not write recovery marker: ${errorMessage(markerError)}`;
    }
  }
}

function assertCurrentTmuxGeneration(
  readIdentity: () => TmuxServerIdentity | undefined,
  expected: TmuxServerIdentity,
  phase: string,
): void {
  const current = readTmuxIdentity(readIdentity);
  if (!current) {
    throw new Error(`Current tmux server generation could not be verified ${phase}`);
  }
  if (!sameTmuxServerIdentity(current, expected)) {
    throw new Error(`Tmux server generation changed ${phase}`);
  }
}

function readTmuxIdentity(
  readIdentity: () => TmuxServerIdentity | undefined,
): TmuxServerIdentity | undefined {
  try {
    return readIdentity();
  } catch {
    return undefined;
  }
}

function readTmuxServerIdentity(
  options: BackgroundWindowTransactionOptions,
): TmuxServerIdentity | undefined {
  return readTmuxIdentity(options.getTmuxServerIdentity);
}

function transactionError(
  prefix: string,
  teardown: VerifiedPaneTeardownResult,
  recovery?: string,
): Error {
  return new Error(
    `${prefix}; resource teardown is ${teardown.presence}${
      teardown.error ? ` (${teardown.error})` : ''
    }${recovery ? `; ${recovery}` : ''}`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
