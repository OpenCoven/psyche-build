import type { PsychePane } from '../types.js';
import type { AgentName } from '../utils/agentLaunch.js';
import {
  defaultCreatePane,
  type CreatePaneOptions,
  type CreatePaneResult,
} from '../control/resources/panes.js';
import { laneSlugSuffix } from './adapters.js';
import type { LaneBackend, LaneExecutionOutput } from './orchestrator.js';
import { OrchestrationError, type OrchestrationLanePlan } from './types.js';
import { persistProjectPaneConfigPaneDelta } from '../services/ProjectPaneConfig.js';
import { generateSiblingSlugForTargetPane } from '../utils/attachAgent.js';

export interface LocalPaneBackendOptions {
  projectName: string;
  sessionProjectRoot: string;
  sessionConfigPath?: string;
  /** Panes that already exist before this task runs. */
  basePanes: readonly PsychePane[];
  availableAgents: AgentName[];
  /**
   * Persists a reused worktree pane while its cleanup reservation remains active.
   */
  persistReusedPane?: (
    pane: PsychePane,
    previousPanes: PsychePane[],
    nextPanes: PsychePane[],
  ) => Promise<void>;
  /**
   * Persists a newly-created pane while its creation lease remains active.
   */
  persistCreatedPane?: (
    pane: PsychePane,
    previousPanes: PsychePane[],
    nextPanes: PsychePane[],
  ) => Promise<void>;
  /** Injectable shared-worktree slug allocator. */
  resolveExistingWorktreeSlug?: (
    targetPane: Pick<PsychePane, 'slug' | 'worktreePath'>,
    freshPanes: readonly PsychePane[],
  ) => string;
  /**
   * Shared slug stem for multi-lane tasks, so sibling lanes read as variants
   * of one task (fix-auth-codex, fix-auth-claude) rather than unrelated names.
   */
  slugBase?: string;
  focusedTmuxPaneId?: string | null;
  selectedPaneId?: string;
  /** Injectable for tests. */
  createPaneFn?: (
    options: CreatePaneOptions,
    availableAgents: AgentName[],
  ) => Promise<CreatePaneResult>;
  /**
   * Injectable for tests and alternate persistence surfaces. The originating
   * pane is the exact record createPane made durable before launching its
   * agent, never the task's stale pre-lane pane array.
   */
  persistOrchestrationMetadata?: (
    originatingPane: PsychePane,
    nextPane: PsychePane,
  ) => Promise<PsychePane>;
}

export interface LocalPaneBackend {
  execute: LaneBackend;
  /** Panes created by this task so far, in completion order. */
  createdPanes: () => PsychePane[];
}

/**
 * Maps lane plans onto the existing tmux/worktree pane primitives.
 *
 * `createPane` needs to know which panes already exist to pick a split target,
 * so the backend accumulates the panes it creates and hands each lane the base
 * set plus everything created before it. That state lives here rather than in
 * each caller, which is what previously forced the TUI to hand-roll a worker
 * pool over a shared cursor.
 */
export function createLocalPaneBackend(options: LocalPaneBackendOptions): LocalPaneBackend {
  const createPaneFn = options.createPaneFn ?? defaultCreatePane;
  const persistOrchestrationMetadata = options.persistOrchestrationMetadata
    ?? (async (originatingPane: PsychePane, nextPane: PsychePane): Promise<PsychePane> => {
      const mutation = await persistProjectPaneConfigPaneDelta(
        options.sessionProjectRoot,
        originatingPane,
        nextPane,
      );
      return mutation.result as PsychePane;
    });
  const resolveExistingWorktreeSlug = options.resolveExistingWorktreeSlug
    ?? generateSiblingSlugForTargetPane;
  const created: PsychePane[] = [];

  // The first createPane call in a session may build the sidebar layout and
  // destroy the welcome pane. Two of those running at once race over the same
  // tmux window, so later lanes wait for the first to settle. This is a
  // createPane constraint, which is why it lives here rather than in the
  // coordinator's scheduling.
  let firstLane: Promise<LaneExecutionOutput> | null = null;

  const runLane = async (lane: OrchestrationLanePlan): Promise<LaneExecutionOutput> => {
    if (lane.mode === 'coven-session') {
      throw new OrchestrationError(
        'unsupported_lane_mode',
        'Coven-managed lanes require the Coven backend; the local backend only creates tmux panes',
      );
    }

    const isTerminal = lane.mode === 'terminal';
    const panesBeforeCurrent = [...options.basePanes, ...created];
    const result = await createPaneFn(
      {
        prompt: lane.prompt,
        ...(lane.agent ? { agent: lane.agent } : {}),
        ...(isTerminal ? { skipAgentSelection: true } : {}),
        ...(options.slugBase ? { slugBase: options.slugBase } : {}),
        ...(laneSlugSuffix(lane.agent) ? { slugSuffix: laneSlugSuffix(lane.agent) } : {}),
        ...(lane.existingWorktree ? { existingWorktree: lane.existingWorktree } : {}),
        ...(lane.existingWorktree
          ? {
            resolveExistingWorktreeSlug: (freshPanes: readonly PsychePane[]) => (
              resolveExistingWorktreeSlug(lane.existingWorktree!, freshPanes)
            ),
          }
          : {}),
        ...(lane.startPointBranch ? { startPointBranch: lane.startPointBranch } : {}),
        ...(lane.mergeTargetChain ? { mergeTargetChain: lane.mergeTargetChain } : {}),
        projectName: options.projectName,
        projectRoot: lane.projectRoot,
        existingPanes: panesBeforeCurrent,
        sessionProjectRoot: options.sessionProjectRoot,
        focusedTmuxPaneId: options.focusedTmuxPaneId,
        selectedPaneId: options.selectedPaneId,
        ...(options.sessionConfigPath ? { sessionConfigPath: options.sessionConfigPath } : {}),
        ...(lane.existingWorktree && options.persistReusedPane
          ? {
            persistReusedPane: async (pane) => options.persistReusedPane!(
              pane,
              panesBeforeCurrent,
              [...panesBeforeCurrent, pane],
            ),
          }
          : {}),
        ...(!lane.existingWorktree && options.persistCreatedPane
          ? {
            persistCreatedPane: async (pane) => options.persistCreatedPane!(
              pane,
              panesBeforeCurrent,
              [...panesBeforeCurrent, pane],
            ),
          }
          : {}),
      },
      options.availableAgents,
    );

    // createPane returns this sentinel instead of throwing when it cannot
    // decide which agent to use. A lane always names its agent, so reaching
    // here means the request was built wrong.
    if (result.needsAgentChoice || !result.pane) {
      throw new OrchestrationError(
        'unsupported_agent',
        `Lane "${lane.id}" could not resolve an agent`,
      );
    }

    // createPane persisted this pane before it launched the agent. Capture
    // that exact fresh record as the delta origin; using panesBeforeCurrent
    // would make a concurrent StatusDetector agentSession write look like a
    // local deletion when this metadata is saved.
    const persistedPane = {
      ...result.pane,
    };
    const paneWithOrchestration: PsychePane = {
      ...persistedPane,
      orchestration: {
        taskId: lane.taskId,
        laneId: lane.id,
        traceId: lane.traceId,
        mode: lane.mode,
      },
    };
    result.pane = await persistOrchestrationMetadata(
      persistedPane,
      paneWithOrchestration,
    );
    created.push(result.pane);

    return { pane: result.pane };
  };

  const execute: LaneBackend = (lane) => {
    // The claim and the assignment below are both synchronous, so exactly one
    // lane can win the gate no matter how many workers call in.
    const gate = firstLane;
    const work = (async () => {
      // A failed first lane must not wedge its siblings, so the gate is
      // awaited for sequencing only — its outcome is the orchestrator's to
      // report, not ours to propagate.
      if (gate) await gate.catch(() => undefined);
      return runLane(lane);
    })();
    if (!firstLane) firstLane = work;
    return work;
  };

  return { execute, createdPanes: () => [...created] };
}
