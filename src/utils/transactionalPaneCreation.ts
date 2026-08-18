import type { PsychePane } from '../types.js';
import {
  ensureProjectPaneConfigPane,
  projectPaneConfigPath,
  readProjectPaneConfigUnderLock,
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
  isPaneLifecycleReservationRetainedError,
  PaneLifecycleReservationRetainedError,
  retainPaneRecovery,
  type PaneRecoveryPersistenceResult,
  type RetainableWorktreeReservation,
} from './paneLifecycleRecovery.js';
import { createPsychePaneId } from './paneIdentity.js';
import {
  allocateUniquePaneSlug,
  type PaneSlugReservation,
} from '../services/PaneSlugRegistry.js';
import {
  reserveCrashSafePaneSlug,
  settlePaneSlugReservationAfterFailure,
} from '../services/PaneSlugReservation.js';

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
  /** Stable slug stem resolved under the shared session namespace lock. */
  slugBase?: string;
  /** Target path protected by recovery if pane persistence is ambiguous. */
  worktreePath?: string;
  /** Optional stable pane identity; generated before reservation by default. */
  paneRecordId?: string;
  allocate: () => Promise<string> | string;
  /**
   * Builds the record before persistence using the generation captured before
   * allocation and revalidated immediately after the split.
   */
  createPane: (
    allocation: {
      paneId: string;
      tmuxServerIdentity?: TmuxServerIdentity;
      paneRecordId: string;
      slug: string;
    },
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
  const slugReservation = await reserveCrashSafePaneSlug({
    sessionProjectRoot: options.sessionProjectRoot,
    projectRoot: options.projectRoot,
    paneId: options.paneRecordId || createPsychePaneId(),
    operation: options.operation,
    allocate: async ({ occupiedSlugs }) => {
      const slug = await allocateUniquePaneSlug(
        options.slugBase || options.operation,
        occupiedSlugs,
      );
      return {
        slug,
        worktreePath: options.worktreePath || options.projectRoot,
      };
    },
  });
  let paneId: string | undefined;
  let pane: T | undefined;
  let allocationIdentity: TmuxServerIdentity | undefined;
  try {
    allocationIdentity = getTmuxServerIdentity(
      options,
      tmuxService,
    );
    if (!allocationIdentity) {
      throw new Error(
        `${options.operation} could not capture the tmux server generation before allocation`,
      );
    }
    paneId = await options.allocate();
    if (!paneId) {
      throw new Error(`${options.operation} did not return a tmux pane ID`);
    }
    await slugReservation.recordPaneEffect(paneId, allocationIdentity);

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
      paneRecordId: slugReservation.paneId,
      slug: slugReservation.slug,
    });
    pane.id = slugReservation.paneId;
    pane.slug = slugReservation.slug;
    await options.persist(pane);
    await slugReservation.completeAfterPanePersisted(pane);
  } catch (error) {
    if (pane && await hasExactDurablePane(options.sessionProjectRoot, pane)) {
      try {
        await slugReservation.completeAfterPanePersisted(pane);
      } catch {
        await settlePaneSlugReservationAfterFailure(slugReservation, {
          operation: `${options.operation}-durable-pane-reconciliation`,
          reason: errorMessage(error),
        });
      }
      throw new Error(
        `${errorMessage(error)}; exact pane ${pane.id} remains durably persisted`,
      );
    }
    let failure = error;
    if (paneId && allocationIdentity) {
      try {
        await compensateAllocatedPaneFailure(
          options,
          tmuxService,
          pane,
          paneId,
          allocationIdentity,
          slugReservation,
          errorMessage(error),
        );
      } catch (compensatedError) {
        failure = compensatedError;
      }
    }
    if (isPaneLifecycleReservationRetainedError(failure)) {
      throw failure;
    }
    const settlement = await settlePaneSlugReservationAfterFailure(
      slugReservation,
      {
        operation: `${options.operation}-failure`,
        reason: errorMessage(failure),
        teardown: async (effect) => teardownAllocation(
          options,
          tmuxService,
          effect.paneId,
          effect.tmuxServerIdentity || allocationIdentity!,
          pane === undefined,
        ),
      },
    );
    if (settlement.quarantined) {
      throw new Error(
        `${errorMessage(failure)}; ${
          settlement.message || `pane slug ${slugReservation.slug} remains quarantined`
        }`,
      );
    }
    throw failure;
  }

  // The durable record owns this pane from here forward. Activation failures
  // intentionally retain it for normal reconciliation rather than making the
  // pane untracked again.
  await options.activate?.(pane!);
  return pane!;
}

async function hasExactDurablePane(
  sessionProjectRoot: string,
  pane: PsychePane,
): Promise<boolean> {
  try {
    const config = await readProjectPaneConfigUnderLock(sessionProjectRoot);
    return (config.panes || []).some((candidate) => (
      candidate.id === pane.id
      && candidate.paneId === pane.paneId
      && candidate.slug === pane.slug
    ));
  } catch {
    return false;
  }
}

async function compensateAllocatedPaneFailure<T extends PsychePane>(
  options: TransactionalPaneCreationOptions<T>,
  tmuxService: Pick<TmuxService, 'getServerIdentity' | 'paneExists' | 'killPane'>,
  pane: T | undefined,
  paneId: string,
  allocationIdentity: TmuxServerIdentity,
  slugReservation: PaneSlugReservation,
  reason: string,
): Promise<never> {
  const recoveryPane = pane ?? provisionalRecoveryPane(
    options.operation,
    slugReservation.paneId,
    slugReservation.slug,
    paneId,
    allocationIdentity,
  );
  const teardown = await teardownAllocation(
    options,
    tmuxService,
    paneId,
    allocationIdentity,
    pane === undefined,
  );
  if (teardown.presence === 'absent') {
    await slugReservation.clearAfterConfirmedTeardown('absent');
    throw new Error(
      `${options.operation} ${reason}; pane ${paneId} was removed`,
    );
  }

  const recovery = await retainPaneRecovery({
    recoveryId: slugReservation.recoveryId,
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
  const message = `${options.operation} ${reason}; pane teardown is ${
    teardown.presence
  }; ${recovery.message}`;
  if (recovery.retained) {
    throw new PaneLifecycleReservationRetainedError(message);
  }
  throw new Error(message);
}

async function teardownAllocation<T extends PsychePane>(
  options: TransactionalPaneCreationOptions<T>,
  tmuxService: Pick<TmuxService, 'getServerIdentity' | 'paneExists' | 'killPane'>,
  paneId: string,
  allocationIdentity: TmuxServerIdentity,
  generationMismatchIsUncertain: boolean,
): Promise<VerifiedPaneTeardownResult> {
  const currentIdentity = getTmuxServerIdentity(options, tmuxService, paneId);
  if (!currentIdentity) {
    return {
      presence: 'unknown',
      error: 'current tmux server generation could not be verified',
    };
  }
  if (!sameTmuxServerIdentity(allocationIdentity, currentIdentity)) {
    return generationMismatchIsUncertain
      ? {
        presence: 'unknown',
        error: 'tmux generation changed before allocation ownership was bound',
      }
      : { presence: 'absent' };
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
  paneRecordId: string,
  paneSlug: string,
  paneId: string,
  tmuxServerIdentity: TmuxServerIdentity,
): PsychePane {
  const suffix = paneId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 96) || 'pane';
  return {
    id: paneRecordId || `untracked-${suffix}`,
    slug: paneSlug || `${operation}-untracked`,
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
