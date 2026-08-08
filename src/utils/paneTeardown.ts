/**
 * Tmux has two materially different negative answers: a confirmed absent pane
 * and a failed/timeout probe. Lifecycle code must not collapse them into a
 * boolean, because an unknown pane may still be running against a worktree
 * that rollback or cleanup is about to delete.
 */
export type TmuxPanePresence = 'present' | 'absent' | 'unknown';

export interface VerifiedPaneTeardownResult {
  presence: TmuxPanePresence;
  error?: string;
}

export interface VerifiedPaneTeardownOptions {
  probe: () => Promise<TmuxPanePresence> | TmuxPanePresence;
  kill: () => Promise<void> | void;
  verifyDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

export interface FullPaneTeardownTarget {
  paneId: string;
  testWindowId?: string;
  testPaneId?: string;
  devWindowId?: string;
  devPaneId?: string;
}

export interface FullPaneTeardownOptions {
  target: FullPaneTeardownTarget;
  probePane: (paneId: string) => Promise<TmuxPanePresence> | TmuxPanePresence;
  killPane: (paneId: string) => Promise<void> | void;
  probeWindow: (windowId: string) => Promise<TmuxPanePresence> | TmuxPanePresence;
  killWindow: (windowId: string) => Promise<void> | void;
  verifyDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

export interface FullPaneTeardownResult {
  presence: TmuxPanePresence;
  error?: string;
  pane: VerifiedPaneTeardownResult;
  backgroundPanes: ReadonlyMap<string, VerifiedPaneTeardownResult>;
  windows: ReadonlyMap<string, VerifiedPaneTeardownResult>;
}

const DEFAULT_VERIFY_DELAYS_MS = [50, 150, 300];

export async function tearDownPaneWithVerification(
  options: VerifiedPaneTeardownOptions,
): Promise<VerifiedPaneTeardownResult> {
  const initialPresence = await probePanePresence(options.probe);
  if (initialPresence !== 'present') {
    return { presence: initialPresence };
  }

  let killError: string | undefined;
  try {
    await options.kill();
  } catch (error) {
    killError = errorMessage(error);
  }

  const sleep = options.sleep ?? defaultSleep;
  for (const delay of options.verifyDelaysMs ?? DEFAULT_VERIFY_DELAYS_MS) {
    await sleep(delay);
    const presence = await probePanePresence(options.probe);
    if (presence === 'absent' || presence === 'unknown') {
      return {
        presence,
        ...(killError ? { error: killError } : {}),
      };
    }
  }

  return {
    presence: 'present',
    ...(killError ? { error: killError } : {}),
  };
}

/**
 * A pane record owns its main pane plus detached test/dev windows. Record
 * removal and worktree cleanup are safe only after every owned tmux resource
 * is confirmed absent.
 */
export async function tearDownFullPaneWithVerification(
  options: FullPaneTeardownOptions,
): Promise<FullPaneTeardownResult> {
  const backgroundPanes = new Map<string, VerifiedPaneTeardownResult>();
  const backgroundPaneIds = Array.from(new Set(
    [options.target.testPaneId, options.target.devPaneId].filter(
      (paneId): paneId is string => Boolean(paneId) && paneId !== options.target.paneId,
    ),
  ));
  for (const paneId of backgroundPaneIds) {
    backgroundPanes.set(paneId, await tearDownPaneWithVerification({
      probe: () => options.probePane(paneId),
      kill: () => options.killPane(paneId),
      verifyDelaysMs: options.verifyDelaysMs,
      sleep: options.sleep,
    }));
  }
  const failedBackgroundPane = [...backgroundPanes.values()].find(
    (result) => result.presence !== 'absent',
  );
  if (failedBackgroundPane) {
    return {
      presence: failedBackgroundPane.presence,
      ...(failedBackgroundPane.error ? { error: failedBackgroundPane.error } : {}),
      // The main pane was deliberately not touched after an uncertain owned
      // background process. Its actual state is irrelevant to safe record
      // removal, so use absent only as a non-result placeholder.
      pane: { presence: 'absent' },
      backgroundPanes,
      windows: new Map(),
    };
  }

  const windows = new Map<string, VerifiedPaneTeardownResult>();
  const windowIds = Array.from(new Set(
    [options.target.testWindowId, options.target.devWindowId].filter(
      (windowId): windowId is string => Boolean(windowId),
    ),
  ));

  for (const windowId of windowIds) {
    windows.set(windowId, await tearDownPaneWithVerification({
      probe: () => options.probeWindow(windowId),
      kill: () => options.killWindow(windowId),
      verifyDelaysMs: options.verifyDelaysMs,
      sleep: options.sleep,
    }));
  }
  const failedWindow = [...windows.values()].find(
    (result) => result.presence !== 'absent',
  );
  if (failedWindow) {
    return {
      presence: failedWindow.presence,
      ...(failedWindow.error ? { error: failedWindow.error } : {}),
      pane: { presence: 'absent' },
      backgroundPanes,
      windows,
    };
  }

  const pane = await tearDownPaneWithVerification({
    probe: () => options.probePane(options.target.paneId),
    kill: () => options.killPane(options.target.paneId),
    verifyDelaysMs: options.verifyDelaysMs,
    sleep: options.sleep,
  });
  const outcomes = [...backgroundPanes.values(), ...windows.values(), pane];
  const presence = outcomes.some((outcome) => outcome.presence === 'unknown')
    ? 'unknown'
    : outcomes.some((outcome) => outcome.presence === 'present')
      ? 'present'
      : 'absent';
  const error = outcomes.find((outcome) => outcome.error)?.error;

  return {
    presence,
    ...(error ? { error } : {}),
    pane,
    backgroundPanes,
    windows,
  };
}

export async function probePanePresence(
  probe: () => Promise<TmuxPanePresence> | TmuxPanePresence,
): Promise<TmuxPanePresence> {
  try {
    const presence = await probe();
    return presence === 'present' || presence === 'absent' || presence === 'unknown'
      ? presence
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function paneRecoveryInstructions(
  paneId: string,
  configPath: string,
): string {
  return `Recovery required: inspect pane ${paneId} with \`tmux list-panes -a -F "#{pane_id}"\`; if it is still present, run \`tmux kill-pane -t '${paneId}'\`, then reconcile ${configPath}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
