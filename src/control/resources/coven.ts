import {
  createCovenClient,
  launchProjectCovenSession,
  type CovenClient,
} from '../../daemon/bridge.js';
import type { CovenSessionSummary } from '../../daemon/protocol.js';

export type { CovenClient, CovenSessionSummary };

/**
 * Effect boundary for Coven session mutations.
 *
 * Like {@link ./panes}, this is the single module that imports the real Coven
 * mutation functions so the orchestration backends stay pure. Backends default
 * to these capabilities but never import the daemon bridge directly.
 */
export const defaultCovenClient = createCovenClient;
export const defaultLaunchProjectCovenSession = launchProjectCovenSession;
