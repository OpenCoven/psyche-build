import type { TmuxService } from '../services/TmuxService.js';
import {
  sameTmuxServerIdentity,
  type TmuxServerIdentity,
} from '../services/TmuxServerIdentity.js';
import {
  tearDownPaneWithVerification,
  type VerifiedPaneTeardownResult,
} from './paneTeardown.js';

export function captureTmuxGeneration(
  tmuxService: Pick<TmuxService, 'getServerIdentity'>,
  operation: string,
): TmuxServerIdentity {
  const generation = tmuxService.getServerIdentity?.();
  if (!generation) {
    throw new Error(`Could not capture tmux generation before ${operation}`);
  }
  return generation;
}

export function assertTmuxGenerationUnchanged(
  tmuxService: Pick<TmuxService, 'getServerIdentity'>,
  expected: TmuxServerIdentity,
  operation: string,
): void {
  const current = tmuxService.getServerIdentity?.();
  if (!current || !sameTmuxServerIdentity(current, expected)) {
    throw new Error(`Tmux generation changed during ${operation}`);
  }
}

export async function tearDownGenerationBoundPane(
  tmuxService: Pick<
    TmuxService,
    'getServerIdentity' | 'probePanePresence' | 'killPane'
  >,
  paneId: string,
  expected: TmuxServerIdentity,
): Promise<VerifiedPaneTeardownResult> {
  const current = tmuxService.getServerIdentity?.();
  if (!current) {
    return {
      presence: 'unknown',
      error: 'current tmux server generation could not be verified',
    };
  }
  if (!sameTmuxServerIdentity(current, expected)) {
    return { presence: 'absent' };
  }
  return tearDownPaneWithVerification({
    probe: async () => {
      const generation = tmuxService.getServerIdentity?.();
      if (!generation) return 'unknown';
      if (!sameTmuxServerIdentity(generation, expected)) return 'absent';
      return tmuxService.probePanePresence(paneId);
    },
    kill: async () => {
      assertTmuxGenerationUnchanged(
        tmuxService,
        expected,
        `teardown of pane ${paneId}`,
      );
      await tmuxService.killPane(paneId);
    },
  });
}
