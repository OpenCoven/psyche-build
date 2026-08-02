import type { BridgeSpawnRequest, BridgeSpawnResult } from '../daemon/bridge.js';
import { spawnBridgePane } from '../daemon/bridge.js';
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
    ?? ((projectRoot, sessionName, request) => spawnBridgePane(projectRoot, sessionName, request));
  const spawned = new Map<string, BridgeSpawnResult>();

  const execute: LaneBackend = async (lane: OrchestrationLanePlan): Promise<LaneExecutionOutput> => {
    if (lane.mode === 'coven-session') {
      throw new OrchestrationError(
        'unsupported_lane_mode',
        'Coven-managed lanes require the Coven backend',
      );
    }
    if (lane.mode === 'shared-worktree') {
      // spawnBridgePane always creates a fresh worktree. Attaching to an
      // existing one needs the sibling-slug handling that currently only the
      // TUI has, so this fails loudly rather than silently creating a second
      // worktree the caller did not ask for.
      throw new OrchestrationError(
        'unsupported_lane_mode',
        'Shared-worktree lanes are not available on the daemon path yet; use the psyche TUI',
      );
    }

    const result = await spawnPane(lane.projectRoot, options.sessionName, {
      requestId: `${lane.taskId}:${lane.id}`,
      cwd: lane.cwd,
      ...(lane.agent ? { agent: lane.agent } : {}),
      prompt: lane.prompt,
      ...(lane.startPointBranch ? { startPointBranch: lane.startPointBranch } : {}),
      ...(lane.title ? { title: lane.title } : {}),
    });

    spawned.set(lane.id, result);
    return {};
  };

  return { execute, spawned: () => new Map(spawned) };
}
