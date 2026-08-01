# Multiagent Orchestration Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify comux task fan-out, worktree/pane execution, optional capability routing, daemon control, MCP tools, and public documentation behind one typed multiagent orchestration contract.

**Architecture:** Add a transport-independent orchestration planner and coordinator with injected lane backends. Refactor the existing tmux/worktree code into the local backend, keep Coven as an optional managed-session backend, and translate TUI, daemon, and MCP requests into the same task request and structured result.

**Tech Stack:** TypeScript 5.9, Node.js 18+, React/Ink hooks, tmux, git worktrees, WebSocket JSON protocol, JSON-RPC/MCP, Vitest.

---

## File Structure

**Create**

- `src/orchestration/types.ts` — authoritative task, lane, result, trace, and error contracts.
- `src/orchestration/planner.ts` — pure request validation and deterministic lane expansion.
- `src/orchestration/orchestrator.ts` — bounded-concurrency execution and result aggregation.
- `src/orchestration/capabilityRouter.ts` — provider-neutral task refinement and instrumentation.
- `src/orchestration/localPaneBackend.ts` — adapter from lane plans to existing pane/worktree primitives.
- `src/orchestration/adapters.ts` — compatibility translators for one-pane and UI requests.
- `__tests__/orchestrationPlanner.test.ts` — planner contract tests.
- `__tests__/orchestrator.test.ts` — concurrency, ordering, and partial-failure tests.
- `__tests__/capabilityRouter.test.ts` — provider and authority-boundary tests.
- `__tests__/localPaneBackend.test.ts` — local mode translation and persistence tests.
- `__tests__/mcpServer.test.ts` — MCP tool registry and execution tests.

**Modify**

- `src/types.ts` — optional orchestration metadata on persisted panes.
- `src/utils/agentLaunch.ts` — one generic launcher for all registry agents.
- `src/utils/paneCreation.ts` — expose reusable local lane creation options and remove embedded launch duplication.
- `src/utils/attachAgent.ts` — delegate shared-worktree creation to the local backend.
- `src/hooks/usePaneCreation.ts` — translate UI selection to a task and persist successful lanes once.
- `src/hooks/useInputHandling.ts` — submit shared-worktree task lanes for attached agents.
- `src/daemon/protocol.ts` — task and capability request/result frames.
- `src/daemon/bridge.ts` — scoped backend dependencies, capability session validation, and task execution.
- `src/daemon/index.ts` — authenticated dispatch and `panes.spawn` compatibility translation.
- `src/mcp/server.ts` — real task creation and pane termination tools.
- `README.md`, `docs/PRODUCT-SPEC.md`, `docs/COVEN-SESSIONS.md`,
  `docs/src/content/core-concepts.js`, `docs/src/content/multi-agent.js`,
  `docs/src/content/workflows.js` — public terminology and implemented behavior.

## Task 1: Define and Validate Orchestration Contracts

**Files:**
- Create: `src/orchestration/types.ts`
- Create: `src/orchestration/planner.ts`
- Create: `__tests__/orchestrationPlanner.test.ts`
- Modify: `src/types.ts`

- [ ] **Step 1: Write failing planner tests**

```ts
import { describe, expect, it } from 'vitest';
import { planOrchestrationTask } from '../src/orchestration/planner.js';

describe('planOrchestrationTask', () => {
  it('expands lanes deterministically and preserves request order', () => {
    const plan = planOrchestrationTask({
      taskId: 'task-1',
      projectRoot: '/repo',
      prompt: 'Fix tests',
      lanes: [
        { id: 'codex', mode: 'isolated-worktree', agent: 'codex' },
        { id: 'claude', mode: 'isolated-worktree', agent: 'claude' },
      ],
    });

    expect(plan.lanes.map((lane) => lane.id)).toEqual(['codex', 'claude']);
    expect(plan.concurrency).toBe(2);
  });

  it('rejects duplicate lane ids before execution', () => {
    expect(() => planOrchestrationTask({
      taskId: 'task-1',
      projectRoot: '/repo',
      prompt: 'Fix tests',
      lanes: [
        { id: 'same', mode: 'isolated-worktree', agent: 'codex' },
        { id: 'same', mode: 'isolated-worktree', agent: 'claude' },
      ],
    })).toThrow(/duplicate lane id/i);
  });

  it('requires an existing worktree for shared-worktree lanes', () => {
    expect(() => planOrchestrationTask({
      taskId: 'task-1',
      projectRoot: '/repo',
      prompt: 'Review tests',
      lanes: [{ id: 'review', mode: 'shared-worktree', agent: 'claude' }],
    })).toThrow(/existing worktree/i);
  });
});
```

- [ ] **Step 2: Run the planner test and verify failure**

Run:

```sh
pnpm vitest --run __tests__/orchestrationPlanner.test.ts
```

Expected: FAIL because `src/orchestration/planner.ts` does not exist.

- [ ] **Step 3: Add the core types**

Create `src/orchestration/types.ts` with these public contracts:

```ts
import type { AgentName, PermissionMode } from '../utils/agentLaunch.js';
import type { ComuxPane, MergeTargetReference } from '../types.js';

export type OrchestrationLaneMode =
  | 'isolated-worktree'
  | 'shared-worktree'
  | 'terminal'
  | 'coven-session';

export interface ExistingWorktreeRef {
  slug: string;
  worktreePath: string;
  branchName: string;
}

export interface OrchestrationLaneRequest {
  id: string;
  mode: OrchestrationLaneMode;
  agent?: AgentName;
  harness?: string;
  existingWorktree?: ExistingWorktreeRef;
  permissionMode?: PermissionMode;
}

export interface OrchestrationTaskRequest {
  taskId: string;
  traceId?: string;
  projectRoot: string;
  cwd?: string;
  prompt: string;
  title?: string;
  startPointBranch?: string;
  mergeTargetChain?: MergeTargetReference[];
  concurrency?: number;
  lanes: OrchestrationLaneRequest[];
}

export interface OrchestrationLanePlan extends OrchestrationLaneRequest {
  taskId: string;
  traceId: string;
  index: number;
  projectRoot: string;
  cwd: string;
  prompt: string;
  title?: string;
  startPointBranch?: string;
  mergeTargetChain?: MergeTargetReference[];
}

export interface OrchestrationTaskPlan {
  taskId: string;
  traceId: string;
  projectRoot: string;
  cwd: string;
  concurrency: number;
  lanes: OrchestrationLanePlan[];
}

export interface OrchestrationLaneSuccess {
  id: string;
  status: 'completed';
  pane?: ComuxPane;
  sessionId?: string;
  startedAt: string;
  completedAt: string;
}

export interface OrchestrationLaneFailure {
  id: string;
  status: 'failed';
  error: { code: OrchestrationErrorCode; message: string };
  startedAt: string;
  completedAt: string;
}

export type OrchestrationLaneResult =
  | OrchestrationLaneSuccess
  | OrchestrationLaneFailure;

export interface OrchestrationTaskResult {
  taskId: string;
  traceId: string;
  status: 'completed' | 'partial' | 'failed';
  lanes: OrchestrationLaneResult[];
  startedAt: string;
  completedAt: string;
}

export type OrchestrationErrorCode =
  | 'invalid_orchestration_request'
  | 'project_scope_violation'
  | 'unsupported_lane_mode'
  | 'unsupported_agent'
  | 'capability_provider_unavailable'
  | 'capability_not_supported'
  | 'capability_contract_violation'
  | 'lane_execution_failed'
  | 'orchestration_persistence_failed';

export class OrchestrationError extends Error {
  constructor(
    public readonly code: OrchestrationErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'OrchestrationError';
  }
}
```

- [ ] **Step 4: Implement pure planner validation**

Create `src/orchestration/planner.ts`:

```ts
import path from 'node:path';
import { isAgentName } from '../utils/agentLaunch.js';
import {
  OrchestrationError,
  type OrchestrationLanePlan,
  type OrchestrationTaskPlan,
  type OrchestrationTaskRequest,
} from './types.js';

const MAX_CONCURRENCY = 4;

export function planOrchestrationTask(
  request: OrchestrationTaskRequest,
): OrchestrationTaskPlan {
  const taskId = request.taskId.trim();
  const projectRoot = path.resolve(request.projectRoot);
  const cwd = path.resolve(projectRoot, request.cwd ?? '.');
  const prompt = request.prompt.trim();

  if (!taskId || !prompt || request.lanes.length === 0) {
    throw new OrchestrationError(
      'invalid_orchestration_request',
      'Task id, prompt, and at least one lane are required',
    );
  }
  const relativeCwd = path.relative(projectRoot, cwd);
  if (relativeCwd.startsWith('..') || path.isAbsolute(relativeCwd)) {
    throw new OrchestrationError(
      'project_scope_violation',
      'Task cwd must be inside the project root',
    );
  }

  const seen = new Set<string>();
  const traceId = request.traceId?.trim() || taskId;
  const lanes: OrchestrationLanePlan[] = request.lanes.map((lane, index) => {
    const id = lane.id.trim();
    if (!id || seen.has(id)) {
      throw new OrchestrationError(
        'invalid_orchestration_request',
        `Duplicate lane id "${id}"`,
      );
    }
    seen.add(id);
    if (lane.agent && !isAgentName(lane.agent)) {
      throw new OrchestrationError('unsupported_agent', `Unknown agent "${lane.agent}"`);
    }
    if (lane.mode === 'shared-worktree' && !lane.existingWorktree) {
      throw new OrchestrationError(
        'invalid_orchestration_request',
        `Lane "${id}" requires an existing worktree`,
      );
    }
    if (lane.mode === 'coven-session' && !lane.harness) {
      throw new OrchestrationError(
        'invalid_orchestration_request',
        `Lane "${id}" requires a Coven harness`,
      );
    }
    return {
      ...lane,
      taskId,
      traceId,
      id,
      index,
      projectRoot,
      cwd,
      prompt,
      title: request.title,
      startPointBranch: request.startPointBranch,
      mergeTargetChain: request.mergeTargetChain,
    };
  });

  const requestedConcurrency = request.concurrency ?? lanes.length;
  if (!Number.isInteger(requestedConcurrency) || requestedConcurrency < 1) {
    throw new OrchestrationError(
      'invalid_orchestration_request',
      'Concurrency must be a positive integer',
    );
  }

  return {
    taskId,
    traceId,
    projectRoot,
    cwd,
    concurrency: Math.min(lanes.length, MAX_CONCURRENCY, requestedConcurrency),
    lanes,
  };
}
```

- [ ] **Step 5: Add optional pane orchestration metadata**

Modify `ComuxPane` in `src/types.ts`:

```ts
  orchestration?: {
    taskId: string;
    laneId: string;
    traceId: string;
    mode: 'isolated-worktree' | 'shared-worktree' | 'terminal' | 'coven-session';
  };
```

- [ ] **Step 6: Run tests and typecheck**

Run:

```sh
pnpm vitest --run __tests__/orchestrationPlanner.test.ts && pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```sh
git add src/orchestration/types.ts src/orchestration/planner.ts src/types.ts __tests__/orchestrationPlanner.test.ts
git commit -m "feat: define orchestration task contracts"
```

## Task 2: Add the Bounded-Concurrency Coordinator

**Files:**
- Create: `src/orchestration/orchestrator.ts`
- Create: `__tests__/orchestrator.test.ts`

- [ ] **Step 1: Write failing coordinator tests**

```ts
import { describe, expect, it } from 'vitest';
import { Orchestrator } from '../src/orchestration/orchestrator.js';

describe('Orchestrator', () => {
  it('preserves lane order while limiting concurrency', async () => {
    let active = 0;
    let maxActive = 0;
    const orchestrator = new Orchestrator({
      executeLane: async (lane) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, lane.id === 'one' ? 20 : 5));
        active -= 1;
        return { pane: undefined };
      },
      clock: () => '2026-08-01T15:00:00.000Z',
    });

    const result = await orchestrator.execute({
      taskId: 'task',
      projectRoot: '/repo',
      prompt: 'Work',
      concurrency: 2,
      lanes: [
        { id: 'one', mode: 'terminal' },
        { id: 'two', mode: 'terminal' },
        { id: 'three', mode: 'terminal' },
      ],
    });

    expect(maxActive).toBe(2);
    expect(result.lanes.map((lane) => lane.id)).toEqual(['one', 'two', 'three']);
    expect(result.status).toBe('completed');
  });

  it('returns partial when one lane fails', async () => {
    const orchestrator = new Orchestrator({
      executeLane: async (lane) => {
        if (lane.id === 'bad') throw new Error('boom');
        return { pane: undefined };
      },
    });

    const result = await orchestrator.execute({
      taskId: 'task',
      projectRoot: '/repo',
      prompt: 'Work',
      lanes: [
        { id: 'good', mode: 'terminal' },
        { id: 'bad', mode: 'terminal' },
      ],
    });

    expect(result.status).toBe('partial');
    expect(result.lanes[1]).toMatchObject({
      id: 'bad',
      status: 'failed',
      error: { code: 'lane_execution_failed' },
    });
  });
});
```

- [ ] **Step 2: Run the test and verify failure**

Run:

```sh
pnpm vitest --run __tests__/orchestrator.test.ts
```

Expected: FAIL because `Orchestrator` does not exist.

- [ ] **Step 3: Implement the coordinator**

Create `src/orchestration/orchestrator.ts` with an injected backend:

```ts
import { planOrchestrationTask } from './planner.js';
import type { ComuxPane } from '../types.js';
import {
  OrchestrationError,
  type OrchestrationLanePlan,
  type OrchestrationLaneResult,
  type OrchestrationTaskRequest,
  type OrchestrationTaskResult,
} from './types.js';

export interface LaneExecutionOutput {
  pane?: ComuxPane;
  sessionId?: string;
}

export interface OrchestratorOptions {
  executeLane: (lane: OrchestrationLanePlan) => Promise<LaneExecutionOutput>;
  clock?: () => string;
}

export class Orchestrator {
  private readonly clock: () => string;

  constructor(private readonly options: OrchestratorOptions) {
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async execute(request: OrchestrationTaskRequest): Promise<OrchestrationTaskResult> {
    const plan = planOrchestrationTask(request);
    const startedAt = this.clock();
    const results: Array<OrchestrationLaneResult | undefined> =
      new Array(plan.lanes.length);
    let cursor = 0;

    const workers = Array.from({ length: plan.concurrency }, async () => {
      while (cursor < plan.lanes.length) {
        const index = cursor++;
        const lane = plan.lanes[index];
        const laneStartedAt = this.clock();
        try {
          const output = await this.options.executeLane(lane);
          results[index] = {
            id: lane.id,
            status: 'completed',
            ...output,
            startedAt: laneStartedAt,
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
          results[index] = {
            id: lane.id,
            status: 'failed',
            error: { code: normalized.code, message: normalized.message },
            startedAt: laneStartedAt,
            completedAt: this.clock(),
          };
        }
      }
    });

    await Promise.all(workers);
    const lanes = results as OrchestrationLaneResult[];
    const completed = lanes.filter((lane) => lane.status === 'completed').length;
    return {
      taskId: plan.taskId,
      traceId: plan.traceId,
      status: completed === lanes.length ? 'completed' : completed === 0 ? 'failed' : 'partial',
      lanes,
      startedAt,
      completedAt: this.clock(),
    };
  }
}
```

- [ ] **Step 4: Run coordinator tests**

Run:

```sh
pnpm vitest --run __tests__/orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add src/orchestration/orchestrator.ts __tests__/orchestrator.test.ts
git commit -m "feat: coordinate multi-lane execution"
```

## Task 3: Land and Harden Capability Routing

**Files:**
- Create: `src/orchestration/capabilityRouter.ts`
- Create: `__tests__/capabilityRouter.test.ts`
- Modify: `src/daemon/bridge.ts`
- Modify: `src/daemon/protocol.ts`
- Modify: `src/daemon/index.ts`
- Modify: `__tests__/daemon/bridge.test.ts`
- Create: `__tests__/daemon/capabilityDispatch.test.ts`

- [ ] **Step 1: Port the tested provider-neutral seam**

Cherry-pick only as a reference, not as the final implementation:

```sh
git show feat/psyche-capability-seam:src/orchestration/capabilityRouter.ts > /tmp/capabilityRouter.reference.ts
git show feat/psyche-capability-seam:__tests__/capabilityRouter.test.ts > /tmp/capabilityRouter.reference.test.ts
```

Port `AGENTIC_CAPABILITIES`, capability input/output and instrumentation
interfaces, `AgenticCapabilityRouter`, `createCovenNativeCapabilityStrategy()`,
`createCovenNativeCapabilityRouter()`, `isAgenticCapability()`, and output
normalization. Replace every `CapabilityRoutingError` construction with
`OrchestrationError` using the same capability-specific error code.

- [ ] **Step 2: Write authority-boundary tests**

Add tests that assert:

```ts
await expect(router.execute({
  ...baseRequest,
  provider: 'psyche',
})).rejects.toMatchObject({
  code: 'capability_provider_unavailable',
});

await expect(replacingRouter.execute(baseRequest)).rejects.toMatchObject({
  code: 'capability_contract_violation',
});

expect(result.output).toEqual({
  prompt: 'Refined prompt',
  harness: 'codex',
});
```

Also assert frozen request context, stable trace identity, copied
instrumentation arrays, and no mutation of project/session identity.

- [ ] **Step 3: Run capability tests and verify failure**

Run:

```sh
pnpm vitest --run __tests__/capabilityRouter.test.ts
```

Expected: FAIL until the router and shared error contracts are implemented.

- [ ] **Step 4: Implement the router using shared errors**

Implement the branch's `AgenticCapabilityRouter`, native strategy, capability
list, output normalization, trace generation, and strategy registration. Throw
`OrchestrationError` with capability-specific codes instead of a second error
class.

- [ ] **Step 5: Add session-scoped daemon routing**

Port the branch's `routeProjectCovenSessionCapability()` behavior into
`src/daemon/bridge.ts`:

```ts
const LIVE_CAPABILITY_SESSION_STATUSES = new Set([
  'starting',
  'running',
  'waiting',
]);
```

Validate capability, provider, task id, prompt, attempt, session id, real
project root, real cwd, and live status before calling the router.

- [ ] **Step 6: Add authenticated protocol frames**

Add:

```ts
| {
    type: 'coven.capabilities.execute';
    requestId: string;
    sessionId: string;
    capability: CovenCapabilityRequest;
  }
```

and:

```ts
| {
    type: 'coven.capabilities.execute.result';
    requestId: string;
    sessionId: string;
    execution: AgenticCapabilityExecution;
  }
```

Construct one router per daemon and register native plus optional injected
strategies.

- [ ] **Step 7: Run targeted daemon tests**

Run:

```sh
pnpm vitest --run __tests__/capabilityRouter.test.ts __tests__/daemon/bridge.test.ts __tests__/daemon/capabilityDispatch.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```sh
git add src/orchestration/capabilityRouter.ts src/daemon/bridge.ts src/daemon/protocol.ts src/daemon/index.ts __tests__/capabilityRouter.test.ts __tests__/daemon/bridge.test.ts __tests__/daemon/capabilityDispatch.test.ts
git commit -m "feat: add scoped capability routing"
```

## Task 4: Centralize Agent Startup and Local Lane Execution

**Files:**
- Modify: `src/utils/agentLaunch.ts`
- Modify: `src/utils/paneCreation.ts`
- Create: `src/orchestration/localPaneBackend.ts`
- Create: `__tests__/localPaneBackend.test.ts`
- Modify: `__tests__/agentLaunch.test.ts`

- [ ] **Step 1: Write generic launcher tests**

Extend `__tests__/agentLaunch.test.ts` with injected tmux/prompt dependencies so
the test can assert:

```ts
expect(buildInitialPromptCommand('gemini', '"fix it"', 'bypassPermissions'))
  .toBe('gemini --approval-mode yolo --prompt-interactive "fix it"');
expect(getPromptTransport('cline')).toBe('send-keys');
expect(getPromptTransport('amp')).toBe('stdin');
```

Add one `launchAgentInPane()` test per transport and assert Codex hook wrapping,
send-keys prompt delivery, and no-prompt commands.

- [ ] **Step 2: Run launcher tests and capture the attach-path failure**

Run:

```sh
pnpm vitest --run __tests__/agentLaunch.test.ts
```

Expected: new tests FAIL because the existing exported launcher has hard-coded
branches for only Claude, Codex, and OpenCode.

- [ ] **Step 3: Move the complete launch algorithm into `agentLaunch.ts`**

Change `launchAgentInPane()` to:

```ts
export async function launchAgentInPane(options: LaunchAgentInPaneOptions): Promise<void> {
  const {
    paneId,
    agent,
    prompt,
    slug,
    projectRoot,
    worktreePath,
    permissionMode,
    comuxPaneId,
    codexHookEventFile,
    tmuxService = TmuxService.getInstance(),
  } = options;

  if (agent === 'gemini') ensureGeminiFolderTrusted(worktreePath || projectRoot);

  const hasPrompt = prompt.trim().length > 0;
  const transport = getPromptTransport(agent);
  const sendViaTmux = hasPrompt && transport === 'send-keys';
  const baselineCommand = sendViaTmux
    ? await tmuxService.getPaneCurrentCommand(paneId).catch(() => undefined)
    : undefined;

  const promptToken = await createPromptToken(projectRoot, slug, prompt);
  let command = hasPrompt && !sendViaTmux
    ? buildInitialPromptCommand(agent, promptToken, permissionMode)
    : buildAgentCommand(agent, permissionMode);

  if (agent === 'codex') {
    command = buildCodexHookedCommand(command, {
      comuxPaneId: comuxPaneId || '',
      tmuxPaneId: paneId,
      eventFile: codexHookEventFile,
    });
  }

  await tmuxService.sendShellCommand(paneId, command);
  await tmuxService.sendTmuxKeys(paneId, 'Enter');

  if (sendViaTmux) {
    await sendPromptViaTmux({
      paneId,
      prompt,
      tmuxService,
      expectedCommand: getAgentProcessName(agent),
      baselineCommand,
      prePromptKeys: getSendKeysPrePrompt(agent),
      submitKeys: getSendKeysSubmit(agent),
      postPasteDelayMs: getSendKeysPostPasteDelayMs(agent),
      readyDelayMs: getSendKeysReadyDelayMs(agent),
    });
  }
}
```

`createPromptToken()` must use `writePromptFile()` plus
`buildPromptReadAndDeleteSnippet()` and return a safe quoted inline fallback.

- [ ] **Step 4: Replace embedded launch logic in `createPane()`**

After worktree hooks and Codex hook installation, call:

```ts
await launchAgentInPane({
  paneId: paneInfo,
  agent,
  prompt,
  slug,
  projectRoot,
  worktreePath,
  comuxPaneId: newPane.id,
  codexHookEventFile,
  permissionMode: settings.permissionMode,
});
```

Keep Claude trust monitoring after the generic launcher. Remove duplicated
command construction imports from `paneCreation.ts`.

- [ ] **Step 5: Add the local backend**

Create `src/orchestration/localPaneBackend.ts`:

```ts
export interface LocalPaneBackendOptions {
  projectName: string;
  sessionProjectRoot: string;
  sessionConfigPath: string;
  existingPanes: () => ComuxPane[];
  availableAgents: AgentName[];
}

export function createLocalPaneBackend(options: LocalPaneBackendOptions) {
  return async (lane: OrchestrationLanePlan): Promise<LaneExecutionOutput> => {
    if (lane.mode === 'coven-session') {
      throw new OrchestrationError(
        'unsupported_lane_mode',
        'Coven lanes require the Coven backend',
      );
    }
    const skipAgentSelection = lane.mode === 'terminal';
    const result = await createPane({
      prompt: lane.prompt,
      agent: lane.agent,
      projectName: options.projectName,
      projectRoot: lane.projectRoot,
      existingPanes: options.existingPanes(),
      existingWorktree: lane.existingWorktree,
      slugSuffix: lane.agent ? getAgentSlugSuffix(lane.agent) : undefined,
      startPointBranch: lane.startPointBranch,
      mergeTargetChain: lane.mergeTargetChain,
      skipAgentSelection,
      sessionProjectRoot: options.sessionProjectRoot,
      sessionConfigPath: options.sessionConfigPath,
    }, options.availableAgents);

    result.pane.orchestration = {
      taskId: lane.taskId,
      laneId: lane.id,
      traceId: lane.traceId,
      mode: lane.mode,
    };
    return { pane: result.pane };
  };
}
```

- [ ] **Step 6: Run targeted tests**

Run:

```sh
pnpm vitest --run __tests__/agentLaunch.test.ts __tests__/localPaneBackend.test.ts __tests__/agentSession.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```sh
git add src/utils/agentLaunch.ts src/utils/paneCreation.ts src/orchestration/localPaneBackend.ts __tests__/agentLaunch.test.ts __tests__/localPaneBackend.test.ts
git commit -m "refactor: unify local agent lane startup"
```

## Task 5: Adapt TUI Multi-Launch and Shared-Worktree Flows

**Files:**
- Create: `src/orchestration/adapters.ts`
- Modify: `src/hooks/usePaneCreation.ts`
- Modify: `src/hooks/useInputHandling.ts`
- Modify: `src/utils/attachAgent.ts`
- Modify: `__tests__/attachAgent.test.ts`
- Create: `__tests__/orchestrationAdapters.test.ts`

- [ ] **Step 1: Write compatibility adapter tests**

```ts
import { expect, it } from 'vitest';
import { buildMultiAgentTaskRequest } from '../src/orchestration/adapters.js';

it('builds one isolated lane per selected agent', () => {
  const request = buildMultiAgentTaskRequest({
    taskId: 'task-1',
    projectRoot: '/repo',
    prompt: 'Fix tests',
    agents: ['codex', 'claude'],
  });

  expect(request.lanes).toEqual([
    { id: 'codex', mode: 'isolated-worktree', agent: 'codex' },
    { id: 'claude', mode: 'isolated-worktree', agent: 'claude' },
  ]);
});
```

Also test deduplication and shared-worktree lane generation.

- [ ] **Step 2: Implement adapters**

Create functions:

```ts
buildMultiAgentTaskRequest(...)
buildSharedWorktreeTaskRequest(...)
buildSinglePaneTaskRequest(...)
```

Use stable lane ids with numeric suffixes only when the same agent appears more
than once.

- [ ] **Step 3: Rewrite `usePaneCreation()` around `Orchestrator`**

Replace the hook-owned worker loop with:

```ts
const result = await orchestrator.execute(buildMultiAgentTaskRequest({
  taskId: `task-${Date.now()}`,
  projectRoot: options.targetProjectRoot || sessionProjectRoot,
  prompt,
  agents: dedupedAgents,
  startPointBranch: options.startPointBranch,
  mergeTargetChain: options.mergeTargetChain,
  concurrency: getParallelPaneCreationLimit(dedupedAgents.length),
}));

const createdPanes = result.lanes.flatMap((lane) =>
  lane.status === 'completed' && lane.pane ? [lane.pane] : []
);
```

Persist all successful panes once, schedule pruning once per project root, and
map `completed`, `partial`, and `failed` to current status messages.

- [ ] **Step 4: Rewrite attach flow as shared-worktree lanes**

In `useInputHandling.ts`, build a shared-worktree request from the selected
pane and selected agents, execute it with the same local backend, save
successful panes once, and report failed agents by lane id.

Reduce `attachAgent.ts` to sibling-slug generation plus a compatibility wrapper
that submits one shared-worktree lane. Remove its duplicate tmux split, layout,
title, hook, launch, and focus logic.

- [ ] **Step 5: Run TUI and attach tests**

Run:

```sh
pnpm vitest --run __tests__/attachAgent.test.ts __tests__/orchestrationAdapters.test.ts __tests__/newPanePopup.test.tsx __tests__/useInputHandling.inlineRename.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add src/orchestration/adapters.ts src/hooks/usePaneCreation.ts src/hooks/useInputHandling.ts src/utils/attachAgent.ts __tests__/attachAgent.test.ts __tests__/orchestrationAdapters.test.ts
git commit -m "refactor: route TUI launches through orchestrator"
```

## Task 6: Add Daemon Task Execution and Compatibility

**Files:**
- Modify: `src/daemon/protocol.ts`
- Modify: `src/daemon/bridge.ts`
- Modify: `src/daemon/index.ts`
- Modify: `__tests__/daemon/bridge.test.ts`
- Create: `__tests__/daemon/orchestrationDispatch.test.ts`

- [ ] **Step 1: Write daemon dispatch tests**

Test:

```ts
const request = {
  type: 'orchestration.execute',
  requestId: 'request-1',
  task: {
    taskId: 'task-1',
    projectRoot: root,
    prompt: 'Fix tests',
    lanes: [{ id: 'codex', mode: 'isolated-worktree', agent: 'codex' }],
  },
} as const;

expect(await dispatchOrchestrationRequest(root, request, orchestrator))
  .toMatchObject({
    type: 'orchestration.execute.result',
    requestId: 'request-1',
    result: { taskId: 'task-1', status: 'completed' },
  });
```

Also test that `panes.spawn` translates to one lane and rejects cwd outside the
daemon project root.

- [ ] **Step 2: Add protocol frames**

Add:

```ts
| { type: 'orchestration.execute'; requestId: string; task: OrchestrationTaskRequest }
```

and:

```ts
| { type: 'orchestration.execute.result'; requestId: string; result: OrchestrationTaskResult }
```

- [ ] **Step 3: Inject a daemon orchestrator**

Extend `DaemonOptions` with optional lane backends and capability strategies.
Construct the default local backend once and pass the orchestrator through
`ConnectionDeps`.

- [ ] **Step 4: Dispatch tasks and preserve `panes.spawn`**

Add `dispatchOrchestrationRequest()`. Change `panes.spawn` to call
`buildSinglePaneTaskRequest()` and return the first successful lane using the
existing result shape.

If the translated result has no successful pane, return the lane's structured
error through `bridgeErrorCode()` and `bridgeErrorMessage()`.

- [ ] **Step 5: Run daemon tests**

Run:

```sh
pnpm vitest --run __tests__/daemon/bridge.test.ts __tests__/daemon/orchestrationDispatch.test.ts __tests__/daemon/capabilityDispatch.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add src/daemon/protocol.ts src/daemon/bridge.ts src/daemon/index.ts __tests__/daemon/bridge.test.ts __tests__/daemon/orchestrationDispatch.test.ts
git commit -m "feat: expose orchestration through daemon"
```

## Task 7: Wire MCP Creation and Termination

**Files:**
- Modify: `src/mcp/server.ts`
- Create: `__tests__/mcpServer.test.ts`
- Modify: `src/daemon/bridge.ts`

- [ ] **Step 1: Extract MCP request handling for tests**

Export:

```ts
export async function handleMcpRequest(request: JsonRpcRequest): Promise<JsonRpcResponse>
```

Keep `runMcpServer()` as newline framing only. Inject an `McpOrchestrationDeps`
object containing task execution, pane listing, capture, and termination.

- [ ] **Step 2: Write tool registry tests**

Assert `tools/list` includes:

```ts
[
  'comux_list_panes',
  'comux_execute_task',
  'comux_create_pane',
  'comux_kill_pane',
  'comux_get_pane_output',
  'comux_list_rituals',
  'comux_list_worktrees',
]
```

Assert no description contains `STUB` or `wiring in progress`.

- [ ] **Step 3: Write execution tests**

Call `tools/call` for `comux_execute_task` with two lanes and assert the
injected executor receives the normalized task. Call `comux_create_pane` and
assert it translates to a one-lane task.

- [ ] **Step 4: Implement real tools**

`comux_execute_task` accepts:

```json
{
  "task_id": "task-1",
  "project_root": "/repo",
  "prompt": "Fix tests",
  "lanes": [
    { "id": "codex", "mode": "isolated-worktree", "agent": "codex" }
  ],
  "concurrency": 2
}
```

`comux_create_pane` keeps `prompt`, `agent`, `worktree`, `branch`, and
`project_root`, translating them to one isolated or shared lane.

`comux_kill_pane` validates the configured pane id, kills the tmux pane, and
removes the pane record from config. It must not delete a worktree or branch;
destructive cleanup remains an explicit TUI/merge action.

- [ ] **Step 5: Run MCP tests**

Run:

```sh
pnpm vitest --run __tests__/mcpServer.test.ts __tests__/daemon/bridge.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add src/mcp/server.ts src/daemon/bridge.ts __tests__/mcpServer.test.ts
git commit -m "feat: wire MCP orchestration tools"
```

## Task 8: Rewrite Multiagent Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/PRODUCT-SPEC.md`
- Modify: `docs/COVEN-SESSIONS.md`
- Modify: `docs/src/content/core-concepts.js`
- Modify: `docs/src/content/multi-agent.js`
- Modify: `docs/src/content/workflows.js`
- Modify: `docs/src/content/features.js`
- Modify: `docs/src/content/introduction.js`

- [ ] **Step 1: Replace the public model**

Use the same definitions everywhere:

```md
- **Task** — one requested outcome.
- **Lane** — one agent or terminal working on that task.
- **Isolation mode** — an isolated worktree, a shared worktree, a plain
  terminal, or a Coven-managed session.
- **Integration** — inspect, compare, merge, create a PR, archive, or clean up.
```

- [ ] **Step 2: Rewrite multi-agent guide**

Structure it as:

1. launch one or many isolated lanes;
2. compare two lanes as an A/B example, not a special product mode;
3. attach agents to one shared worktree;
4. use bounded concurrency and understand partial failure;
5. use daemon/MCP orchestration;
6. use optional Coven and capability providers;
7. integrate results explicitly.

- [ ] **Step 3: Correct capability and MCP claims**

Document:

- Coven-native is the default capability provider.
- Psyche is an optional registration point.
- explicit unavailable providers fail closed.
- MCP task creation and pane termination are implemented.
- pane termination does not implicitly delete worktrees or branches.

- [ ] **Step 4: Remove stale claims**

Run:

```sh
rg -n -i 'STUB|wiring in progress|A/B pair|coming in the next|future Psyche' README.md docs src/mcp/server.ts
```

Expected: no stale implementation claims. `A/B` may appear only as a clearly
labeled two-lane comparison example.

- [ ] **Step 5: Build docs**

Run:

```sh
pnpm --dir docs run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add README.md docs/PRODUCT-SPEC.md docs/COVEN-SESSIONS.md docs/src/content/core-concepts.js docs/src/content/multi-agent.js docs/src/content/workflows.js docs/src/content/features.js docs/src/content/introduction.js
git commit -m "docs: rewrite multiagent orchestration guide"
```

## Task 9: Full Validation and Cleanup

**Files:**
- Modify only files required to fix failures caused by Tasks 1-8.

- [ ] **Step 1: Run orchestration-focused tests**

Run:

```sh
pnpm vitest --run \
  __tests__/orchestrationPlanner.test.ts \
  __tests__/orchestrator.test.ts \
  __tests__/capabilityRouter.test.ts \
  __tests__/localPaneBackend.test.ts \
  __tests__/orchestrationAdapters.test.ts \
  __tests__/daemon/orchestrationDispatch.test.ts \
  __tests__/daemon/capabilityDispatch.test.ts \
  __tests__/mcpServer.test.ts \
  __tests__/agentLaunch.test.ts \
  __tests__/attachAgent.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```sh
pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run the full test suite**

Run:

```sh
pnpm test
```

Expected: PASS with no failed tests.

- [ ] **Step 4: Build package and docs**

Run:

```sh
pnpm run build && pnpm --dir docs run build
```

Expected: PASS.

- [ ] **Step 5: Validate package contents**

Run:

```sh
pnpm run smoke:pack
```

Expected: PASS and package contains built orchestration modules plus public
documentation.

- [ ] **Step 6: Search for duplicated and stale paths**

Run:

```sh
rg -n 'createPanesForAgents|attachAgentToWorktree|launchAgentInPane|panes.spawn|comux_create_pane|wiring in progress|STUB' src __tests__ docs README.md
```

Expected:

- one generic `launchAgentInPane()` implementation;
- TUI creation and attachment call orchestration adapters;
- `panes.spawn` and `comux_create_pane` exist only as compatibility adapters;
- no stub claims.

- [ ] **Step 7: Inspect final diff**

Run:

```sh
git --no-pager diff --check
git status --short
git --no-pager log --oneline --decorate -12
```

Expected: no whitespace errors, only intended files changed, and each task has
an implementation commit.

- [ ] **Step 8: Commit validation corrections**

```sh
git add <only-files-changed-to-fix-validation>
git commit -m "fix: complete orchestration validation"
```

Skip this commit when validation required no changes.
