import {
  defaultCovenClient,
  defaultLaunchProjectCovenSession,
  type CovenClient,
  type CovenSessionSummary,
} from '../control/resources/coven.js';
import type { LaneBackend, LaneExecutionOutput } from './orchestrator.js';
import { OrchestrationError, type OrchestrationLanePlan } from './types.js';

export interface CovenSessionBackendOptions {
  /** Injectable for tests; defaults to the local Coven daemon. */
  client?: CovenClient;
}

export interface CovenSessionBackend {
  execute: LaneBackend;
  /** Sessions launched by this task, keyed by lane id. */
  sessions: () => Map<string, CovenSessionSummary>;
}

/**
 * Lane backend for Coven-managed sessions.
 *
 * Unlike the other backends this creates no worktree, pane, or process of its
 * own — Coven owns the session and its lifecycle. The lane's job is to ask for
 * one and report its id.
 *
 * A lane therefore completes when the session has been created, not when its
 * work is done. That reads odd until you notice it is what the other backends
 * already do: an isolated-worktree lane completes once the pane exists and the
 * agent has been launched, never waiting for the agent to finish. Keeping Coven
 * lanes symmetric means a mixed task does not have some lanes reporting
 * "started" and others "finished" under the same status.
 */
export function createCovenSessionBackend(
  options: CovenSessionBackendOptions = {},
): CovenSessionBackend {
  const client = options.client ?? defaultCovenClient();
  const sessions = new Map<string, CovenSessionSummary>();

  const execute: LaneBackend = async (lane: OrchestrationLanePlan): Promise<LaneExecutionOutput> => {
    if (lane.mode !== 'coven-session') {
      throw new OrchestrationError(
        'unsupported_lane_mode',
        `Lane "${lane.id}" is ${lane.mode}; this backend only launches Coven sessions`,
      );
    }
    if (!lane.harness) {
      // The planner enforces this, but a hand-built lane would otherwise reach
      // Coven with no harness and fail somewhere far less legible.
      throw new OrchestrationError(
        'invalid_orchestration_request',
        `Lane "${lane.id}" is coven-session but names no harness`,
      );
    }

    let session: CovenSessionSummary;
    try {
      session = await defaultLaunchProjectCovenSession(
        lane.projectRoot,
        {
          harness: lane.harness,
          prompt: lane.prompt,
          ...(lane.title ? { title: lane.title } : {}),
          cwd: lane.cwd,
        },
        client,
      );
    } catch (error) {
      // Coven being absent is the common case on a machine without the daemon.
      // Surface it as a lane failure with its original message rather than an
      // opaque one — the caller's next step is usually "start coven daemon".
      throw new OrchestrationError(
        'lane_execution_failed',
        error instanceof Error ? error.message : String(error),
        error,
      );
    }

    sessions.set(lane.id, session);
    return { sessionId: session.id };
  };

  return { execute, sessions: () => new Map(sessions) };
}

/**
 * Routes each lane to the backend that owns its mode.
 *
 * Lets one task mix local panes and Coven sessions without either backend
 * knowing about the other, and keeps "no backend handles this mode" a single
 * legible error instead of each backend inventing its own.
 */
export function composeLaneBackends(
  routes: Partial<Record<OrchestrationLanePlan['mode'], LaneBackend>>,
): LaneBackend {
  return async (lane) => {
    const backend = routes[lane.mode];
    if (!backend) {
      throw new OrchestrationError(
        'unsupported_lane_mode',
        `No backend is registered for "${lane.mode}" lanes`,
      );
    }
    return backend(lane);
  };
}
