import type { TmuxService } from '../services/TmuxService.js';

export interface LocalPaneCreationRollbackOptions {
  tmuxService: Pick<TmuxService, 'killPane'>;
  paneId: string;
  /** Cleans only resources created by the failed operation. */
  cleanup?: () => void | Promise<void>;
}

/**
 * Best-effort cleanup for a pane that was created but could not be persisted.
 * The layout failure remains the caller's actionable error.
 */
export async function rollbackLocalPaneCreation(
  options: LocalPaneCreationRollbackOptions,
): Promise<void> {
  try {
    await options.tmuxService.killPane(options.paneId);
  } catch {
    // The caller must preserve the persistence error.
  }

  try {
    await options.cleanup?.();
  } catch {
    // Resource cleanup is also best effort.
  }
}
