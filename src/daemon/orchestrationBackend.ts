import type { CovenClient } from '../control/resources/coven.js';
import {
  createBridgePaneBackend,
  type BridgePaneBackendOptions,
} from '../orchestration/bridgePaneBackend.js';
import {
  composeLaneBackends,
  createCovenSessionBackend,
} from '../orchestration/covenSessionBackend.js';
import { Orchestrator } from '../orchestration/orchestrator.js';

export interface DaemonOrchestratorOptions {
  sessionName: string;
  /** Injectable pane effect for tests and embedders. */
  spawnPane?: BridgePaneBackendOptions['spawnPane'];
  /** Injectable Coven effect boundary for tests and embedders. */
  covenClient?: CovenClient;
}

export function createDaemonOrchestrator(
  options: DaemonOrchestratorOptions,
): Orchestrator {
  const paneBackend = createBridgePaneBackend({
    sessionName: options.sessionName,
    ...(options.spawnPane ? { spawnPane: options.spawnPane } : {}),
  });
  const covenBackend = createCovenSessionBackend({
    ...(options.covenClient ? { client: options.covenClient } : {}),
  });

  return new Orchestrator({
    executeLane: composeLaneBackends({
      'isolated-worktree': paneBackend.execute,
      terminal: paneBackend.execute,
      'shared-worktree': paneBackend.execute,
      'coven-session': covenBackend.execute,
    }),
  });
}
