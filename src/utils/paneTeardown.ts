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
