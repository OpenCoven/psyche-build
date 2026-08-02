import type { PsychePane } from '../types.js';
import { planOrchestrationTask } from './planner.js';
import {
  OrchestrationError,
  type OrchestrationLanePlan,
  type OrchestrationLaneResult,
  type OrchestrationTaskRequest,
  type OrchestrationTaskResult,
} from './types.js';

export interface LaneExecutionOutput {
  pane?: PsychePane;
  sessionId?: string;
}

/**
 * Executes one lane. Injected so the coordinator owns policy — validation,
 * concurrency, ordering, aggregation — while resource work (worktrees, tmux
 * panes, Coven sessions) stays in a backend.
 */
export type LaneBackend = (lane: OrchestrationLanePlan) => Promise<LaneExecutionOutput>;

export interface OrchestratorOptions {
  executeLane: LaneBackend;
  /** Injectable for deterministic timestamps in tests. */
  clock?: () => string;
}

/**
 * Runs a task's lanes with bounded concurrency and aggregates the outcome.
 *
 * Multi-lane execution is intentionally NOT transactional. One lane failing
 * must not cancel or roll back its siblings: a partial result where three of
 * four agents produced work is more useful than no work at all, and the
 * surviving lanes stay open for inspection. Callers distinguish the cases via
 * the task status — `completed`, `partial`, or `failed`.
 */
export class Orchestrator {
  private readonly executeLane: LaneBackend;
  private readonly clock: () => string;

  constructor(options: OrchestratorOptions) {
    this.executeLane = options.executeLane;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async execute(request: OrchestrationTaskRequest): Promise<OrchestrationTaskResult> {
    // Plan first, and let a bad request throw before any lane starts —
    // otherwise a task that is invalid halfway through would leave real
    // worktrees and panes behind with no result to clean up from.
    const plan = planOrchestrationTask(request);
    const startedAt = this.clock();

    // Results are written by index rather than appended, so request order
    // survives lanes settling out of order.
    const results = new Array<OrchestrationLaneResult | undefined>(plan.lanes.length);
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < plan.lanes.length) {
        const index = cursor++;
        results[index] = await this.runLane(plan.lanes[index]);
      }
    };

    await Promise.all(
      Array.from({ length: plan.concurrency }, () => worker()),
    );

    const lanes = results as OrchestrationLaneResult[];
    const completed = lanes.filter((lane) => lane.status === 'completed').length;

    return {
      taskId: plan.taskId,
      traceId: plan.traceId,
      status: completed === lanes.length
        ? 'completed'
        : completed === 0 ? 'failed' : 'partial',
      startedAt,
      completedAt: this.clock(),
      lanes,
    };
  }

  private async runLane(lane: OrchestrationLanePlan): Promise<OrchestrationLaneResult> {
    const startedAt = this.clock();
    try {
      const output = await this.executeLane(lane);
      return {
        id: lane.id,
        status: 'completed',
        ...(output.pane ? { pane: output.pane } : {}),
        ...(output.sessionId ? { sessionId: output.sessionId } : {}),
        startedAt,
        completedAt: this.clock(),
      };
    } catch (error) {
      const normalized = error instanceof OrchestrationError
        ? error
        : new OrchestrationError(
          'lane_execution_failed',
          error instanceof Error ? error.message : String(error),
          error,
        );
      return {
        id: lane.id,
        status: 'failed',
        error: { code: normalized.code, message: normalized.message },
        startedAt,
        completedAt: this.clock(),
      };
    }
  }
}
