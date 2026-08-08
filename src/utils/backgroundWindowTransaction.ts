import type { PsychePane, SavePanes } from '../types.js';
import type { VerifiedPaneTeardownResult } from './paneTeardown.js';

export type BackgroundWindowType = 'test' | 'dev';

export interface BackgroundWindowTransactionOptions {
  type: BackgroundWindowType;
  pane: PsychePane;
  panes: readonly PsychePane[];
  createWindow: () => Promise<string>;
  sendCommand: (windowId: string) => Promise<void>;
  savePanes: SavePanes;
  tearDownWindow: (windowId: string) => Promise<VerifiedPaneTeardownResult>;
  /**
   * Used only when config persistence cannot retain an uncertain window.
   * Callers write a worktree recovery marker from this callback.
   */
  retainUncertainRecovery?: (
    pane: PsychePane,
    reason: string,
  ) => Promise<string | undefined>;
}

export interface BackgroundWindowTransactionResult {
  windowId: string;
  pane: PsychePane;
}

export async function startBackgroundWindowTransaction(
  options: BackgroundWindowTransactionOptions,
): Promise<BackgroundWindowTransactionResult> {
  const windowId = await options.createWindow();
  const claimedPane = withBackgroundWindow(
    options.pane,
    options.type,
    windowId,
  );
  const claimedPanes = replacePane(options.panes, options.pane.id, claimedPane);

  try {
    // This write claims the new tmux resource before any configured command
    // can run inside it. A crash after send-keys is therefore recoverable.
    await options.savePanes(claimedPanes, options.panes);
  } catch (error) {
    const teardown = await options.tearDownWindow(windowId);
    const recovery = teardown.presence === 'absent'
      ? undefined
      : await options.retainUncertainRecovery?.(
        withBackgroundWindowRecovery(
          claimedPane,
          options.type,
          windowId,
          `background ${options.type} window persistence failed`,
        ),
        `Could not persist ${options.type} window ${windowId}; teardown is ${teardown.presence}`,
      );
    throw transactionError(
      `Could not persist ${options.type} window ${windowId}`,
      error,
      teardown,
      recovery,
    );
  }

  try {
    await options.sendCommand(windowId);
  } catch (error) {
    const teardown = await options.tearDownWindow(windowId);
    if (teardown.presence === 'absent') {
      const clearedPane = withoutBackgroundWindow(claimedPane, options.type);
      try {
        await options.savePanes(
          replacePane(claimedPanes, claimedPane.id, clearedPane),
          claimedPanes,
        );
      } catch (cleanupError) {
        throw transactionError(
          `Failed to launch ${options.type} command and could not remove its window fields`,
          error,
          teardown,
          errorMessage(cleanupError),
        );
      }
      throw transactionError(
        `Failed to launch ${options.type} command`,
        error,
        teardown,
      );
    }

    const recoveryPane = withBackgroundWindowRecovery(
      claimedPane,
      options.type,
      windowId,
      `background ${options.type} command launch failed; teardown is ${teardown.presence}`,
    );
    let recovery: string | undefined;
    try {
      await options.savePanes(
        replacePane(claimedPanes, claimedPane.id, recoveryPane),
        claimedPanes,
      );
      recovery = `retained durable recovery fields for ${options.type} window ${windowId}`;
    } catch (recoveryError) {
      recovery = await options.retainUncertainRecovery?.(
        recoveryPane,
        `Failed to launch ${options.type} command and persist recovery fields: ${
          errorMessage(recoveryError)
        }`,
      );
      recovery ||= `could not persist recovery fields: ${errorMessage(recoveryError)}`;
    }
    throw transactionError(
      `Failed to launch ${options.type} command`,
      error,
      teardown,
      recovery,
    );
  }

  return { windowId, pane: claimedPane };
}

export function withBackgroundWindow(
  pane: PsychePane,
  type: BackgroundWindowType,
  windowId: string,
): PsychePane {
  const recoveries = (pane.backgroundWindowRecoveries || []).filter(
    (recovery) => recovery.type !== type,
  );
  const next: PsychePane = {
    ...pane,
    [type === 'test' ? 'testWindowId' : 'devWindowId']: windowId,
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
    delete next.testStatus;
    delete next.testOutput;
  } else {
    delete next.devWindowId;
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

function withBackgroundWindowRecovery(
  pane: PsychePane,
  type: BackgroundWindowType,
  windowId: string,
  reason: string,
): PsychePane {
  const recoveries = (pane.backgroundWindowRecoveries || []).filter(
    (recovery) => recovery.type !== type,
  );
  return {
    ...pane,
    backgroundWindowRecoveries: [
      ...recoveries,
      { type, windowId, reason },
    ],
  };
}

function replacePane(
  panes: readonly PsychePane[],
  paneId: string,
  replacement: PsychePane,
): PsychePane[] {
  return panes.map((pane) => pane.id === paneId ? replacement : pane);
}

function transactionError(
  prefix: string,
  cause: unknown,
  teardown: VerifiedPaneTeardownResult,
  recovery?: string,
): Error {
  return new Error(
    `${prefix}: ${errorMessage(cause)}; window teardown is ${teardown.presence}${
      teardown.error ? ` (${teardown.error})` : ''
    }${recovery ? `; ${recovery}` : ''}`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
