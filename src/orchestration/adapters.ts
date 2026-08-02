import { getAgentSlugSuffix, type AgentName } from '../utils/agentLaunch.js';
import type { MergeTargetReference } from '../types.js';
import type {
  ExistingWorktreeRef,
  OrchestrationLaneRequest,
  OrchestrationTaskRequest,
} from './types.js';

/**
 * Translators from caller-shaped inputs into task requests.
 *
 * Every surface — the TUI's multi-select, the daemon's single-pane spawn, the
 * MCP tools — funnels through these so lane construction has one definition
 * instead of one per transport.
 */

export interface MultiAgentTaskInput {
  taskId: string;
  traceId?: string;
  projectRoot: string;
  prompt: string;
  agents: readonly AgentName[];
  title?: string;
  startPointBranch?: string;
  mergeTargetChain?: MergeTargetReference[];
  concurrency?: number;
}

/**
 * Lane ids double as UI identity, so they are the agent name where possible.
 * A numeric suffix is added only when the same agent appears more than once,
 * which keeps the common case readable ("codex", "claude") instead of
 * "codex-1", "claude-2".
 */
export function buildLaneIdsForAgents(agents: readonly AgentName[]): string[] {
  const totals = new Map<AgentName, number>();
  for (const agent of agents) {
    totals.set(agent, (totals.get(agent) ?? 0) + 1);
  }

  const seen = new Map<AgentName, number>();
  return agents.map((agent) => {
    if ((totals.get(agent) ?? 0) === 1) return agent;
    const next = (seen.get(agent) ?? 0) + 1;
    seen.set(agent, next);
    return `${agent}-${next}`;
  });
}

export function buildMultiAgentTaskRequest(input: MultiAgentTaskInput): OrchestrationTaskRequest {
  const laneIds = buildLaneIdsForAgents(input.agents);
  const lanes: OrchestrationLaneRequest[] = input.agents.map((agent, index) => ({
    id: laneIds[index],
    mode: 'isolated-worktree',
    agent,
  }));

  return {
    taskId: input.taskId,
    ...(input.traceId ? { traceId: input.traceId } : {}),
    projectRoot: input.projectRoot,
    prompt: input.prompt,
    ...(input.title ? { title: input.title } : {}),
    ...(input.startPointBranch ? { startPointBranch: input.startPointBranch } : {}),
    ...(input.mergeTargetChain ? { mergeTargetChain: input.mergeTargetChain } : {}),
    ...(input.concurrency ? { concurrency: input.concurrency } : {}),
    lanes,
  };
}

export interface SinglePaneTaskInput {
  taskId: string;
  traceId?: string;
  projectRoot: string;
  prompt: string;
  agent?: AgentName;
  title?: string;
  startPointBranch?: string;
}

/**
 * One lane, for callers that only ever wanted a single pane — the daemon's
 * panes.spawn and the MCP create tool. A terminal lane when no agent is given.
 */
export function buildSinglePaneTaskRequest(input: SinglePaneTaskInput): OrchestrationTaskRequest {
  return {
    taskId: input.taskId,
    ...(input.traceId ? { traceId: input.traceId } : {}),
    projectRoot: input.projectRoot,
    prompt: input.prompt,
    ...(input.title ? { title: input.title } : {}),
    ...(input.startPointBranch ? { startPointBranch: input.startPointBranch } : {}),
    lanes: [
      input.agent
        ? { id: input.agent, mode: 'isolated-worktree', agent: input.agent }
        : { id: 'terminal', mode: 'terminal' },
    ],
  };
}

export interface SharedWorktreeTaskInput {
  taskId: string;
  traceId?: string;
  projectRoot: string;
  prompt: string;
  agents: readonly AgentName[];
  existingWorktree: ExistingWorktreeRef;
  concurrency?: number;
}

/**
 * Attach one or more agents to a worktree that already exists, so several
 * agents collaborate on the same branch and files.
 */
export function buildSharedWorktreeTaskRequest(
  input: SharedWorktreeTaskInput,
): OrchestrationTaskRequest {
  const laneIds = buildLaneIdsForAgents(input.agents);
  return {
    taskId: input.taskId,
    ...(input.traceId ? { traceId: input.traceId } : {}),
    projectRoot: input.projectRoot,
    prompt: input.prompt,
    ...(input.concurrency ? { concurrency: input.concurrency } : {}),
    lanes: input.agents.map((agent, index) => ({
      id: laneIds[index],
      mode: 'shared-worktree',
      agent,
      existingWorktree: input.existingWorktree,
    })),
  };
}

/** Agent-specific worktree suffix, so sibling lanes get distinct slugs. */
export function laneSlugSuffix(agent: AgentName | undefined): string | undefined {
  return agent ? getAgentSlugSuffix(agent) : undefined;
}
