import type { PsychePane } from '../types.js';
import {
  ensureProjectPaneConfigPane,
  projectPaneConfigPath,
} from '../services/ProjectPaneConfig.js';
import { TmuxService } from '../services/TmuxService.js';
import type { TmuxServerIdentity } from '../services/TmuxServerIdentity.js';
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
   * Builds the record before persistence. `tmuxServerIdentity` is undefined
   * only on the recovery-only path after generation capture failed.
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
  getTmuxServerIdentity?: (paneId: string) => TmuxServerIdentity | undefined;
  tearDown?: (paneId: string) => Promise<VerifiedPaneTeardownResult>;
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
  const paneId = await options.allocate();
  if (!paneId) {
    throw new Error(`${options.operation} did not return a tmux pane ID`);
  }

  const tmuxServerIdentity = options.getTmuxServerIdentity?.(paneId)
    ?? tmuxService.getServerIdentity?.(paneId);
  const pane = await options.createPane({ paneId, tmuxServerIdentity });

  if (!tmuxServerIdentity) {
    await failUnversionedAllocation(options, pane, tmuxService);
  }

  try {
    await options.persist(pane);
  } catch (error) {
    await failPersistedAllocation(
      options,
      pane,
      tmuxService,
      `could not persist pane record: ${errorMessage(error)}`,
    );
  }

  // The durable record owns this pane from here forward. Activation failures
  // intentionally retain it for normal reconciliation rather than making the
  // pane untracked again.
  await options.activate?.(pane);
  return pane;
}

async function failUnversionedAllocation<T extends PsychePane>(
  options: TransactionalPaneCreationOptions<T>,
  pane: T,
  tmuxService: Pick<TmuxService, 'paneExists' | 'killPane'>,
): Promise<never> {
  const teardown = await teardownAllocation(options, tmuxService, pane.paneId);
  if (teardown.presence === 'absent') {
    throw new Error(
      `${options.operation} could not capture the tmux server generation; pane ${pane.paneId} was removed`,
    );
  }

  const recovery = await retainPaneRecovery({
    projectRoot: options.projectRoot,
    sessionProjectRoot: options.sessionProjectRoot,
    pane,
    operation: `${options.operation}-generation`,
    reason: `could not capture tmux server generation; pane teardown is ${teardown.presence}`,
    reservation: options.reservation,
    persistConfigRecovery: async () => ({
      durable: false,
      message: 'refused to persist an unversioned pane record',
    }),
  });
  throw new Error(
    `${options.operation} could not capture the tmux server generation; ${recovery.message}`,
  );
}

async function failPersistedAllocation<T extends PsychePane>(
  options: TransactionalPaneCreationOptions<T>,
  pane: T,
  tmuxService: Pick<TmuxService, 'paneExists' | 'killPane'>,
  reason: string,
): Promise<never> {
  const teardown = await teardownAllocation(options, tmuxService, pane.paneId);
  if (teardown.presence === 'absent') {
    throw new Error(`${options.operation} ${reason}; pane ${pane.paneId} was removed`);
  }

  const recovery = await retainPaneRecovery({
    projectRoot: options.projectRoot,
    sessionProjectRoot: options.sessionProjectRoot,
    pane,
    operation: options.operation,
    reason: `${reason}; pane teardown is ${teardown.presence}`,
    reservation: options.reservation,
    persistConfigRecovery: options.persistRecovery
      ? () => options.persistRecovery!(pane)
      : () => persistPaneRecovery(options.sessionProjectRoot, pane),
  });
  throw new Error(
    `${options.operation} ${reason}; pane teardown is ${teardown.presence}; ${recovery.message}`,
  );
}

async function teardownAllocation<T extends PsychePane>(
  options: TransactionalPaneCreationOptions<T>,
  tmuxService: Pick<TmuxService, 'paneExists' | 'killPane'>,
  paneId: string,
): Promise<VerifiedPaneTeardownResult> {
  if (options.tearDown) {
    return options.tearDown(paneId);
  }
  return tearDownPaneWithVerification({
    probe: () => probePanePresence(tmuxService, paneId),
    kill: () => tmuxService.killPane(paneId),
  });
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
