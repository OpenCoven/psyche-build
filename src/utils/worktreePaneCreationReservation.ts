import {
  WorktreeCleanupService,
  type WorktreeReuseReservation,
} from '../services/WorktreeCleanupService.js';

export async function withWorktreePaneCreationReservation<T>(options: {
  worktreePath: string;
  projectRoot: string;
  beginReservation?: (
    worktreePath: string,
    projectRoot: string,
  ) => Promise<WorktreeReuseReservation>;
  operation: (
    canonicalWorktreePath: string,
    reservation: WorktreeReuseReservation,
  ) => Promise<T>;
}): Promise<T> {
  const beginReservation = options.beginReservation
    ?? ((worktreePath, projectRoot) => (
      WorktreeCleanupService.getInstance().beginWorktreeReuseReservation(
        worktreePath,
        projectRoot,
      )
    ));
  const reservation = await beginReservation(
    options.worktreePath,
    options.projectRoot,
  );
  let completed = false;
  try {
    const result = await options.operation(
      reservation.canonicalWorktreePath,
      reservation,
    );
    await reservation.complete();
    completed = true;
    return result;
  } finally {
    if (!completed) {
      await reservation.cancel();
    }
  }
}
