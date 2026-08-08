import type { PsychePane } from '../types.js';
import {
  ensureProjectPaneConfigPane,
  projectPaneConfigPath,
} from '../services/ProjectPaneConfig.js';
import { TmuxService } from '../services/TmuxService.js';
import {
  sameTmuxServerIdentity,
  type TmuxServerIdentity,
} from '../services/TmuxServerIdentity.js';
import {
  paneRecoveryInstructions,
  tearDownPaneWithVerification,
  type TmuxPanePresence,
  type VerifiedPaneTeardownResult,
} from './paneTeardown.js';
import {
  retainPaneRecovery,
  type PaneRecoveryPersistenceResult,
  type RetainableWorktreeReservation,
} from './paneLifecycleRecovery.js';

export interface TmuxPaneAllocation {
  paneId: string;
  tmuxServerIdentity: TmuxServerIdentity;
}

export interface TransactionalPaneCreationOptions<T extends PsychePane> {
  /** Project containing the target worktree or shell cwd. */
  projectRoot: string;
  /** Project whose pane registry owns the new record. */
  sessionProjectRoot: string;
  operation: string;
  allocate: () => Promise<string> | string;
  /**
   * Builds the record before persistence using the generation captured before
   * allocation and revalidated immediately after the split.
   */
  createPane: (
    allocation: { paneId: string; tmuxServerIdentity?: TmuxServerIdentity },
  ) => Promise<T> | T;
  /** Must durably add the exact record before activation. */
  persist: (pane: T) => Promise<void>;
  /** Commands, navigation, and title updates run only after persist succeeds. */
  activate?: (pane: T) => Promise<void>;
  tmuxService?: Pick<
    TmuxService,
    'getServerIdentity' | 'paneExists' | 'killPane'
  >;
  getTmuxServerIdentity?: (paneId?: string) => TmuxServerIdentity | undefined;
  tearDown?: (
    paneId: string,
    allocationIdentity: TmuxServerIdentity,
  ) => Promise<VerifiedPaneTeardownResult>;
  reservation?: RetainableWorktreeReservation;
  persistRecovery?: (pane: T) => Promise<PaneRecoveryPersistenceResult>;
}

/**
 * Allocates a tmux pane, captures its server generation immediately, and
 * persists the exact record before the pane receives any command. Every
 * direct UI allocation uses this same compensation path so a config failure
 * either proves the split was removed or leaves durable recovery protection.
 */
export async function createTransactionalPane<T extends PsychePane>(
  options: TransactionalPaneCreationOptions<T>,
): Promise<T> {
  const tmuxService = options.tmuxService ?? TmuxService.getInstance();
  const allocationIdentity = getTmuxServerIdentity(
    options,
    tmuxService,
  );
  if (!allocationIdentity) {
    throw new Error(
      `${options.operation} could not capture the tmux server generation before allocation`,
    );
  }

  let paneId: string | undefined;
  let pane: T | undefined;
  try {
    paneId = await options.allocate();
    if (!paneId) {
      throw new Error(`${options.operation} did not return a tmux pane ID`);
    }

    // From this assignment onward every failure must compensate the split.
    // A post-allocation identity capture is a verification of the generation
    // captured before allocation, not a new ownership claim.
    const currentIdentity = getTmuxServerIdentity(
      options,
      tmuxService,
      paneId,
    );
    if (!currentIdentity) {
      throw new Error(
        'could not capture the tmux server generation after allocation',
      );
    }
    if (!sameTmuxServerIdentity(allocationIdentity, currentIdentity)) {
      throw new Error('tmux server generation changed during allocation');
    }

    pane = await options.createPane({
      paneId,
      tmuxServerIdentity: allocationIdentity,
    });
    await options.persist(pane);
  } catch (error) {
    if (!paneId) {
      throw error;
    }
    await compensateAllocatedPaneFailure(
      options,
      tmuxService,
      pane,
      paneId,
      allocationIdentity,
      errorMessage(error),
    );
  }

  // The durable record owns this pane from here forward. Activation failures
  // intentionally retain it for normal reconciliation rather than making the
  // pane untracked again.
  await options.activate?.(pane!);
  return pane!;
}

async function compensateAllocatedPaneFailure<T extends PsychePane>(
  options: TransactionalPaneCreationOptions<T>,
  tmuxService: Pick<TmuxService, 'getServerIdentity' | 'paneExists' | 'killPane'>,
  pane: T | undefined,
  paneId: string,
  allocationIdentity: TmuxServerIdentity,
  reason: string,
): Promise<never> {
  const recoveryPane = pane ?? provisionalRecoveryPane(
    options.operation,
    paneId,
    allocationIdentity,
  );
  const teardown = await teardownAllocation(
    options,
    tmuxService,
    paneId,
    allocationIdentity,
  );
  if (teardown.presence === 'absent') {
    throw new Error(
      `${options.operation} ${reason}; pane ${paneId} was removed`,
    );
  }

  const recovery = await retainPaneRecovery({
    projectRoot: options.projectRoot,
    sessionProjectRoot: options.sessionProjectRoot,
    pane: recoveryPane,
    operation: pane ? options.operation : `${options.operation}-allocation`,
    reason: `${reason}; pane teardown is ${teardown.presence}`,
    reservation: options.reservation,
    persistConfigRecovery: pane
      ? options.persistRecovery
        ? () => options.persistRecovery!(pane)
        : () => persistPaneRecovery(options.sessionProjectRoot, pane)
      : async () => ({
        durable: false,
        message: 'could not construct a pane record for recovery',
      }),
  });
  throw new Error(
    `${options.operation} ${reason}; pane teardown is ${teardown.presence}; ${recovery.message}`,
  );
}

async function teardownAllocation<T extends PsychePane>(
  options: TransactionalPaneCreationOptions<T>,
  tmuxService: Pick<TmuxService, 'getServerIdentity' | 'paneExists' | 'killPane'>,
  paneId: string,
  allocationIdentity: TmuxServerIdentity,
): Promise<VerifiedPaneTeardownResult> {
  const currentIdentity = getTmuxServerIdentity(options, tmuxService, paneId);
  if (!currentIdentity) {
    return {
      presence: 'unknown',
      error: 'current tmux server generation could not be verified',
    };
  }
  if (!sameTmuxServerIdentity(allocationIdentity, currentIdentity)) {
    return { presence: 'absent' };
  }
  if (options.tearDown) {
    return options.tearDown(paneId, allocationIdentity);
  }
  return tearDownPaneWithVerification({
    probe: async () => {
      const identity = getTmuxServerIdentity(options, tmuxService, paneId);
      if (!identity) {
        return 'unknown';
      }
      if (!sameTmuxServerIdentity(allocationIdentity, identity)) {
        return 'absent';
      }
      return probePanePresence(tmuxService, paneId);
    },
    kill: async () => {
      const identity = getTmuxServerIdentity(options, tmuxService, paneId);
      if (!identity) {
        throw new Error('current tmux server generation could not be verified');
      }
      if (!sameTmuxServerIdentity(allocationIdentity, identity)) {
        throw new Error('tmux server generation changed before pane teardown');
      }
      await tmuxService.killPane(paneId);
    },
  });
}

function getTmuxServerIdentity<T extends PsychePane>(
  options: TransactionalPaneCreationOptions<T>,
  tmuxService: Pick<TmuxService, 'getServerIdentity'>,
  paneId?: string,
): TmuxServerIdentity | undefined {
  try {
    return options.getTmuxServerIdentity
      ? options.getTmuxServerIdentity(paneId)
      : tmuxService.getServerIdentity?.();
  } catch {
    return undefined;
  }
}

function provisionalRecoveryPane(
  operation: string,
  paneId: string,
  tmuxServerIdentity: TmuxServerIdentity,
): PsychePane {
  const suffix = paneId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 96) || 'pane';
  return {
    id: `untracked-${suffix}`,
    slug: `${operation}-untracked`,
    prompt: '',
    paneId,
    tmuxServerIdentity,
  };
}

async function probePanePresence(
  tmuxService: Pick<TmuxService, 'paneExists'>,
  paneId: string,
): Promise<TmuxPanePresence> {
  try {
    return await tmuxService.paneExists(paneId) ? 'present' : 'absent';
  } catch {
    return 'unknown';
  }
}

async function persistPaneRecovery(
  sessionProjectRoot: string,
  pane: PsychePane,
): Promise<PaneRecoveryPersistenceResult> {
  const configPath = projectPaneConfigPath(sessionProjectRoot);
  try {
    await ensureProjectPaneConfigPane(sessionProjectRoot, pane);
    return {
      durable: true,
      message: `retained recovery record ${pane.id} in ${configPath}. ${
        paneRecoveryInstructions(pane.paneId, configPath)
      }`,
    };
  } catch (error) {
    return {
      durable: false,
      message: `could not persist recovery record ${pane.id}: ${
        errorMessage(error)
      }. ${paneRecoveryInstructions(pane.paneId, configPath)}`,
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
