import {
  defaultSpawnPane,
  type BridgeSpawnRequest,
  type BridgeSpawnResult,
} from '../control/resources/panes.js';
import type { LaneBackend, LaneExecutionOutput } from './orchestrator.js';
import { OrchestrationError, type OrchestrationLanePlan } from './types.js';

export interface BridgePaneBackendOptions {
  sessionName: string;
  /** Injectable for tests. */
  spawnPane?: (
    projectRoot: string,
    sessionName: string,
    request: BridgeSpawnRequest,
  ) => Promise<BridgeSpawnResult>;
  /** Defaults to true for callers that inspect spawned(). */
  retainResults?: boolean;
}

export interface BridgePaneBackend {
  execute: LaneBackend;
  /** Spawn results keyed by lane id, for callers that need worktree/branch. */
  spawned: () => Map<string, BridgeSpawnResult>;
}

/**
 * Lane backend for the headless surfaces — the daemon and MCP.
 *
 * The TUI's backend drives createPane, which owns sidebar layout, hooks, and
 * welcome-pane teardown. Nothing outside a running TUI should do any of that,
 * so the headless path uses spawnBridgePane instead: it creates the worktree
 * directly, confines it under .psyche/worktrees, and persists the pane itself.
 */
export function createBridgePaneBackend(options: BridgePaneBackendOptions): BridgePaneBackend {
  const spawnPane = options.spawnPane
    ?? ((projectRoot, sessionName, request) => defaultSpawnPane(projectRoot, sessionName, request));
  const spawned = new Map<string, BridgeSpawnResult>();

  const execute: LaneBackend = async (lane: OrchestrationLanePlan): Promise<LaneExecutionOutput> => {
    if (lane.mode === 'coven-session') {
      // Routed to createCovenSessionBackend by composeLaneBackends. Reaching
      // here means a caller wired this backend directly for every mode.
      throw new OrchestrationError(
        'unsupported_lane_mode',
        'Coven-managed lanes belong to the Coven backend, not the pane backend',
      );
    }
    if (lane.mode === 'shared-worktree' && !lane.existingWorktree) {
      // The planner normally enforces this; belt-and-braces so a hand-built
      // lane cannot reach spawnBridgePane and silently get a NEW worktree.
      throw new OrchestrationError(
        'invalid_orchestration_request',
        `Lane "${lane.id}" is shared-worktree but names no existing worktree`,
      );
    }

    const result = await spawnPane(lane.projectRoot, options.sessionName, {
      requestId: `${lane.taskId}:${lane.id}`,
      cwd: lane.cwd,
      ...(lane.agent ? { agent: lane.agent } : {}),
      prompt: lane.prompt,
      ...(lane.permissionMode !== undefined ? { permissionMode: lane.permissionMode } : {}),
      ...(lane.startPointBranch ? { startPointBranch: lane.startPointBranch } : {}),
      ...(lane.title ? { title: lane.title } : {}),
      ...(lane.existingWorktree ? { existingWorktree: lane.existingWorktree } : {}),
    });

    if (!result.persistedPane) {
      throw new OrchestrationError(
        'lane_execution_failed',
        'Bridge spawn did not return its persisted pane identity',
      );
    }

    if (options.retainResults !== false) {
      spawned.set(lane.id, result);
    }
    return {
      pane: {
        ...result.persistedPane,
        ...(result.pane.title ? { displayName: result.pane.title } : {}),
        prompt: lane.prompt,
        projectRoot: lane.projectRoot,
        type: 'worktree',
        ...(lane.agent ? { agent: lane.agent } : {}),
        ...(lane.permissionMode !== undefined ? { permissionMode: lane.permissionMode } : {}),
        orchestration: {
          taskId: lane.taskId,
          laneId: lane.id,
          traceId: lane.traceId,
          mode: lane.mode,
        },
      },
      ...(result.warnings ? { warnings: result.warnings } : {}),
    };
  };

  return { execute, spawned: () => new Map(spawned) };
}
