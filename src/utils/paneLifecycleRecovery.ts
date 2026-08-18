import type { PsychePane } from '../types.js';
import {
  writeWorktreeRecoveryMarker,
  type WorktreeRecoveryMarkerRequest,
} from '../services/WorktreeRecoveryMarker.js';
import type {
  RetainedWorktreeReservation,
} from '../services/WorktreeCleanupService.js';
import type {
  TmuxPanePresence,
  VerifiedPaneTeardownResult,
} from './paneTeardown.js';
import { paneRecoveryInstructions } from './paneTeardown.js';

export interface RetainableWorktreeReservation {
  retain: () => RetainedWorktreeReservation | void;
}

export async function retainReservationWithRecoveryMarker(
  reservation: RetainableWorktreeReservation,
  request: WorktreeRecoveryMarkerRequest,
) {
  const retainedReservation = reservation.retain();
  const written = await writeWorktreeRecoveryMarker(request);
  retainedReservation?.associateRecoveryMarker?.({
    path: written.path,
    generation: written.marker.generation,
  });
  return written;
}

export interface PaneRecoveryPersistenceResult {
  durable: boolean;
  message: string;
}

export interface RetainedPaneRecoveryResult {
  durable: boolean;
  retained: boolean;
  partial?: boolean;
  message: string;
}

export class PaneLifecycleReservationRetainedError extends Error {
  readonly reservationRetained = true;

  constructor(message: string) {
    super(message);
    this.name = 'PaneLifecycleReservationRetainedError';
  }
}

export function isPaneLifecycleReservationRetainedError(
  error: unknown,
): error is PaneLifecycleReservationRetainedError {
  return error instanceof PaneLifecycleReservationRetainedError
    || (
      typeof error === 'object'
      && error !== null
      && (error as { reservationRetained?: unknown }).reservationRetained === true
    );
}

/**
 * A config record is preferred because it lets the normal UI reconcile a live
 * pane. When config is unavailable, a runtime marker carries the same safety
 * intent across process death and prevents later cleanup from deleting work.
 */
export async function retainPaneRecovery(
  options: {
    recoveryId?: string;
    projectRoot: string;
    sessionProjectRoot: string;
    pane: PsychePane;
    operation: string;
    reason: string;
    reservation?: RetainableWorktreeReservation;
    persistConfigRecovery: () => Promise<PaneRecoveryPersistenceResult>;
  },
): Promise<RetainedPaneRecoveryResult> {
  const configRecovery = await options.persistConfigRecovery();
  if (configRecovery.durable) {
    return {
      durable: true,
      retained: false,
      message: configRecovery.message,
    };
  }

  try {
    const marker = await writeWorktreeRecoveryMarker({
      ...(options.recoveryId ? { recoveryId: options.recoveryId } : {}),
      sessionProjectRoot: options.sessionProjectRoot,
      projectRoot: options.projectRoot,
      worktreePath: options.pane.worktreePath || options.projectRoot,
      pane: {
        id: options.pane.id,
        paneId: options.pane.paneId,
        slug: options.pane.slug,
      },
      allowWorktreeReuse: true,
      operation: options.operation,
      reason: `${options.reason}; ${configRecovery.message}`,
    });
    return {
      durable: true,
      retained: false,
      ...(marker.state === 'target-marker-only' ? { partial: true } : {}),
      message: `${configRecovery.message}; wrote recovery marker ${marker.path}. ${
        marker.warning ? `${marker.warning}. ` : ''
      }${marker.marker.operatorInstructions}`,
    };
  } catch (error) {
    options.reservation?.retain();
    return {
      durable: false,
      retained: true,
      message: `${configRecovery.message}; retained cleanup lease but could not write recovery marker: ${
        error instanceof Error ? error.message : String(error)
      }. ${paneRecoveryInstructions(
        options.pane.paneId,
        `${options.sessionProjectRoot}/.psyche/psyche.config.json`,
      )}`,
    };
  }
}

export async function compensatePostSplitPaneFailure(
  options: {
    recoveryId?: string;
    pane: PsychePane;
    projectRoot: string;
    sessionProjectRoot: string;
    operation: string;
    reason: string;
    reservation?: RetainableWorktreeReservation;
    teardown: () => Promise<VerifiedPaneTeardownResult>;
    persistConfigRecovery: () => Promise<PaneRecoveryPersistenceResult>;
  },
): Promise<{
  teardown: VerifiedPaneTeardownResult;
  recovery?: RetainedPaneRecoveryResult;
}> {
  const teardown = await options.teardown();
  if (teardown.presence === 'absent') {
    return { teardown };
  }

  const recovery = await retainPaneRecovery({
    ...(options.recoveryId ? { recoveryId: options.recoveryId } : {}),
    projectRoot: options.projectRoot,
    sessionProjectRoot: options.sessionProjectRoot,
    pane: options.pane,
    operation: options.operation,
    reason: `${options.reason}; pane teardown is ${teardown.presence}`,
    reservation: options.reservation,
    persistConfigRecovery: options.persistConfigRecovery,
  });
  return { teardown, recovery };
}

export function paneTeardownIsUncertain(
  teardown: Pick<VerifiedPaneTeardownResult, 'presence'>,
): boolean {
  return teardown.presence !== ('absent' satisfies TmuxPanePresence);
}
