# Orchestration Wave A Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the merged Wave A orchestration path so production MCP and daemon requests perform real, correctly scoped effects and concurrent local launches retain unambiguous identities.

**Architecture:** Keep the existing orchestrator and lane contracts, but make the daemon boundary authoritative and inject one real composed backend into both WebSocket and control/MCP dispatch. Move shared-worktree slug allocation under the existing reservation and preserve completed pane effects when only metadata enrichment fails.

**Tech Stack:** TypeScript, Node.js, Vitest, daemon control runtime, orchestration backends, tmux pane creation.

---

### Task 1: Preserve canonical daemon project authority

**Files:**
- Modify: `src/daemon/bridge.ts`
- Test: `__tests__/daemon/orchestrationDispatch.test.ts`

- [ ] **Step 1: Add failing canonical-root tests**

Add cases that assert the delegated task always retains the daemon root while
using a validated claimed path as its default working directory:

```ts
test('keeps the daemon root authoritative when task projectRoot names a subdirectory', async () => {
  const projectRoot = await createProjectRoot();
  const claimedRoot = join(projectRoot, 'packages', 'app');
  await mkdir(claimedRoot, { recursive: true });

  const execute = vi.fn(async () => completedResult());
  await dispatchRequest({
    projectRoot,
    execute,
    request: orchestrationRequest({
      task: { projectRoot: claimedRoot },
    }),
  });

  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({
      task: expect.objectContaining({
        projectRoot,
        cwd: claimedRoot,
      }),
    }),
  );
});

test('resolves explicit task cwd relative to the claimed in-scope path', async () => {
  const projectRoot = await createProjectRoot();
  const claimedRoot = join(projectRoot, 'packages', 'app');
  await mkdir(join(claimedRoot, 'src'), { recursive: true });

  const execute = vi.fn(async () => completedResult());
  await dispatchRequest({
    projectRoot,
    execute,
    request: orchestrationRequest({
      task: { projectRoot: claimedRoot, cwd: 'src' },
    }),
  });

  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({
      task: expect.objectContaining({
        projectRoot,
        cwd: join(claimedRoot, 'src'),
      }),
    }),
  );
});
```

- [ ] **Step 2: Run the tests and verify the current code promotes the claimed path**

Run:

```bash
pnpm vitest --run __tests__/daemon/orchestrationDispatch.test.ts --exclude '**/.claude/**'
```

Expected: the new canonical-root assertion fails because `task.projectRoot`
equals the caller-selected subdirectory.

- [ ] **Step 3: Keep project identity and working directory separate**

In `dispatchOrchestrationRequest`, validate the claimed path with the existing
scope helpers, but construct the delegated task with separate authoritative
fields:

```ts
const claimedRoot = await resolveScopedCwd(
  scoped.projectRoot,
  request.task.projectRoot ?? scoped.requestedCwd,
);
const cwd = await resolveScopedCwd(
  claimedRoot,
  request.task.cwd ?? claimedRoot,
);

const delegatedRequest: OrchestrationRequest = {
  ...request,
  task: {
    ...request.task,
    projectRoot: scoped.projectRoot,
    cwd,
  },
};
```

Preserve the existing rejection behavior for lexical and symlink escapes.

- [ ] **Step 4: Run the focused tests**

Run:

```bash
pnpm vitest --run __tests__/daemon/orchestrationDispatch.test.ts --exclude '**/.claude/**'
```

Expected: all orchestration dispatch tests pass.

- [ ] **Step 5: Commit the authority fix**

```bash
git add src/daemon/bridge.ts __tests__/daemon/orchestrationDispatch.test.ts
git commit -m "fix: preserve daemon project authority"
```

### Task 2: Construct one effectful production daemon orchestrator

**Files:**
- Create: `src/daemon/orchestrationBackend.ts`
- Modify: `src/daemon/index.ts`
- Test: `__tests__/daemon/orchestrationBackend.test.ts`

- [ ] **Step 1: Add failing backend-routing tests**

Create a test factory with injected pane and Coven seams:

```ts
test.each([
  'isolated-worktree',
  'terminal',
  'shared-worktree',
] as const)('routes %s lanes through the bridge pane backend', async (mode) => {
  const spawnPane = vi.fn(async () => ({ pane: paneFixture(mode) }));
  const createSession = vi.fn();
  const orchestrator = createDaemonOrchestrator({
    projectRoot: '/repo',
    sessionName: 'psyche-repo',
    spawnPane,
    createCovenSession: createSession,
  });

  const result = await orchestrator.execute(requestWithLaneMode(mode));

  expect(result.failed).toHaveLength(0);
  expect(spawnPane).toHaveBeenCalledTimes(1);
  expect(createSession).not.toHaveBeenCalled();
});

test('routes coven-session lanes through the Coven backend', async () => {
  const spawnPane = vi.fn();
  const createCovenSession = vi.fn(async () => ({ sessionId: 'session-1' }));
  const orchestrator = createDaemonOrchestrator({
    projectRoot: '/repo',
    sessionName: 'psyche-repo',
    spawnPane,
    createCovenSession,
  });

  const result = await orchestrator.execute(requestWithLaneMode('coven-session'));

  expect(result.failed).toHaveLength(0);
  expect(createCovenSession).toHaveBeenCalledTimes(1);
  expect(spawnPane).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the new test and verify the factory is missing**

Run:

```bash
pnpm vitest --run __tests__/daemon/orchestrationBackend.test.ts --exclude '**/.claude/**'
```

Expected: compilation fails because `createDaemonOrchestrator` does not exist.

- [ ] **Step 3: Add the composed backend factory**

Implement a focused factory using the existing backend constructors:

```ts
export interface DaemonOrchestratorOptions {
  projectRoot: string;
  sessionName: string;
  spawnPane?: BridgePaneSpawner;
  createCovenSession?: CovenSessionCreator;
}

export function createDaemonOrchestrator(
  options: DaemonOrchestratorOptions,
): Orchestrator {
  const paneBackend = createBridgePaneBackend({
    projectRoot: options.projectRoot,
    sessionName: options.sessionName,
    spawnPane: options.spawnPane,
  });
  const covenBackend = createCovenSessionBackend({
    projectRoot: options.projectRoot,
    createSession: options.createCovenSession,
  });

  return new Orchestrator({
    backend: composeLaneBackends({
      'isolated-worktree': paneBackend,
      terminal: paneBackend,
      'shared-worktree': paneBackend,
      'coven-session': covenBackend,
    }),
  });
}
```

Use the repository's exact existing backend option and result types rather
than duplicating them.

- [ ] **Step 4: Replace the production no-op default**

In `runDaemon`, construct the factory only after the daemon session name is
known:

```ts
const orchestrator =
  options.orchestrator ??
  (options.laneBackend
    ? new Orchestrator({ backend: options.laneBackend })
    : createDaemonOrchestrator({
        projectRoot,
        sessionName,
      }));
```

Delete the success-shaped `defaultLaneBackend`. Retain explicit
`DaemonOptions.orchestrator` and `DaemonOptions.laneBackend` overrides for
tests and embedders.

- [ ] **Step 5: Run backend and daemon tests**

Run:

```bash
pnpm vitest --run \
  __tests__/daemon/orchestrationBackend.test.ts \
  __tests__/daemon/orchestrationDispatch.test.ts \
  --exclude '**/.claude/**'
```

Expected: all selected tests pass and every successful lane invokes an
effectful backend seam.

- [ ] **Step 6: Commit the production backend**

```bash
git add src/daemon/orchestrationBackend.ts src/daemon/index.ts __tests__/daemon/orchestrationBackend.test.ts
git commit -m "fix: use an effectful daemon orchestrator"
```

### Task 3: Route leased MCP execution through the production orchestrator

**Files:**
- Modify: `src/daemon/controlHandlers.ts`
- Modify: `src/daemon/index.ts`
- Test: `__tests__/daemon/controlHandlers.test.ts`
- Test: `__tests__/mcpAgentControl.test.ts`

- [ ] **Step 1: Add a failing daemon-handler test**

```ts
test('executes orchestration through the configured daemon orchestrator', async () => {
  const execute = vi.fn(async () => completedResult());
  const handlers = createDaemonControlHandlers({
    projectRoot: '/repo',
    orchestrator: { execute },
    ...controlHandlerDeps(),
  });

  const result = await handlers.executeOrchestration({
    taskId: 'authorized-task',
    request: orchestrationRequest({
      taskId: 'caller-task',
      task: { projectRoot: '/tmp/caller-root' },
    }),
  });

  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({
      taskId: 'authorized-task',
      task: expect.objectContaining({ projectRoot: '/repo' }),
    }),
  );
  expect(result).toEqual(completedResult());
});
```

- [ ] **Step 2: Add an end-to-end leased MCP test**

Exercise `psyche_execute_task` through the control runtime rather than mocking
`client.submit`:

```ts
test('executes a leased psyche_execute_task through the daemon handler', async () => {
  const execute = vi.fn(async () => completedResult());
  const harness = await createMcpControlHarness({
    handlers: createDaemonControlHandlers({
      projectRoot: harnessProjectRoot,
      orchestrator: { execute },
      ...controlHandlerDeps(),
    }),
  });
  const lease = await harness.grantOrchestrationLease('authorized-task');

  const response = await harness.callTool('psyche_execute_task', {
    lease_id: lease.id,
    task_id: 'authorized-task',
    request: orchestrationRequest(),
  });

  expect(response.isError).toBe(false);
  expect(execute).toHaveBeenCalledTimes(1);
});
```

Retain a stale-lease case proving `ControlRuntime` rejects before handler
execution.

- [ ] **Step 3: Run tests and verify production returns command_not_supported**

Run:

```bash
pnpm vitest --run \
  __tests__/daemon/controlHandlers.test.ts \
  __tests__/mcpAgentControl.test.ts \
  --exclude '**/.claude/**'
```

Expected: the execution tests fail because `orchestration.execute` is not
connected to a handler.

- [ ] **Step 4: Inject and call the orchestrator**

Extend the handler dependencies:

```ts
export interface DaemonControlHandlerDeps {
  projectRoot: string;
  orchestrator: Pick<Orchestrator, 'execute'>;
  // existing dependencies remain unchanged
}
```

Replace the unsupported handler with an authoritative request rewrite:

```ts
async function executeOrchestration(
  payload: ExecuteOrchestrationPayload,
): Promise<OrchestrationResult> {
  return deps.orchestrator.execute({
    ...payload.request,
    taskId: payload.taskId,
    task: {
      ...payload.request.task,
      projectRoot: deps.projectRoot,
    },
  });
}
```

Pass the same `orchestrator` instance from `runDaemon` to both the WebSocket
connection path and `createDaemonControlHandlers`.

- [ ] **Step 5: Run the focused authority and MCP tests**

Run:

```bash
pnpm vitest --run \
  __tests__/daemon/controlHandlers.test.ts \
  __tests__/daemon/orchestrationDispatch.test.ts \
  __tests__/controlRuntime.test.ts \
  __tests__/mcpAgentControl.test.ts \
  --exclude '**/.claude/**'
```

Expected: all selected tests pass; stale authority fails before execution and
authorized execution reaches the daemon orchestrator.

- [ ] **Step 6: Commit MCP production dispatch**

```bash
git add src/daemon/controlHandlers.ts src/daemon/index.ts __tests__/daemon/controlHandlers.test.ts __tests__/mcpAgentControl.test.ts
git commit -m "fix: execute orchestration through daemon control"
```

### Task 4: Allocate shared-worktree slugs under fresh reservation state

**Files:**
- Modify: `src/utils/paneCreation.ts`
- Modify: `src/utils/attachAgent.ts`
- Modify: `src/orchestration/localPaneBackend.ts`
- Modify: `src/hooks/useInputHandling.ts`
- Test: `__tests__/attachAgent.test.ts`
- Test: `__tests__/localPaneBackend.test.ts`
- Test: `__tests__/worktreePaneCreationReservation.test.ts`

- [ ] **Step 1: Add concurrent allocation regressions**

```ts
test('allocates concurrent sibling slugs from fresh reserved state', async () => {
  const harness = createPaneReservationHarness({
    panes: [pane({ slug: 'agent-main' })],
  });

  const [first, second] = await Promise.all([
    harness.attach('agent-main'),
    harness.attach('agent-main'),
  ]);

  expect(new Set([first.slug, second.slug]).size).toBe(2);
  expect([first.slug, second.slug].sort()).toEqual([
    'agent-main-2',
    'agent-main-3',
  ]);
});

test('does not reuse a slug supplied from a stale pane snapshot', async () => {
  const harness = createPaneReservationHarness({
    panes: [pane({ slug: 'agent-main' }), pane({ slug: 'agent-main-2' })],
  });

  const result = await harness.attach('agent-main', {
    stalePanes: [pane({ slug: 'agent-main' })],
  });

  expect(result.slug).toBe('agent-main-3');
});
```

- [ ] **Step 2: Run the focused tests and observe duplicate allocation**

Run:

```bash
pnpm vitest --run \
  __tests__/attachAgent.test.ts \
  __tests__/localPaneBackend.test.ts \
  __tests__/worktreePaneCreationReservation.test.ts \
  --exclude '**/.claude/**'
```

Expected: the new concurrent cases fail because callers precompute the same
slug before reservation.

- [ ] **Step 3: Add a reserved-state allocator callback**

Extend pane creation options with an internal callback:

```ts
export interface CreatePaneOptions {
  // existing fields
  resolveExistingWorktreeSlug?: (
    freshPanes: readonly PsychePane[],
  ) => string;
}
```

Inside `createPaneWithReuseReservation`, invoke it only after reservation and
fresh persisted-state loading:

```ts
const freshPanes = await loadPanes();
const slug = options.resolveExistingWorktreeSlug
  ? options.resolveExistingWorktreeSlug(freshPanes)
  : options.slug;

const pane = await createAndPersistPane({
  ...options,
  slug,
  panes: freshPanes,
});
```

Hold the reservation until the pane record is durable.

- [ ] **Step 4: Route all shared-worktree callers through the callback**

Add the corresponding option to `LocalPaneBackendOptions` and supply:

```ts
resolveExistingWorktreeSlug: (freshPanes) =>
  generateSiblingSlugForTargetPane(targetPane, freshPanes),
```

Remove caller-authoritative `allPanes` and synthetic preallocation from
`useInputHandling`. Make `attachAgentToWorktree` use the same callback instead
of treating `existingPanes` as authoritative.

- [ ] **Step 5: Run shared-worktree and reservation tests**

Run:

```bash
pnpm vitest --run \
  __tests__/attachAgent.test.ts \
  __tests__/localPaneBackend.test.ts \
  __tests__/worktreePaneCreationReservation.test.ts \
  --exclude '**/.claude/**'
```

Expected: all selected tests pass, including distinct slugs for parallel
attaches.

- [ ] **Step 6: Commit serialized slug allocation**

```bash
git add src/utils/paneCreation.ts src/utils/attachAgent.ts src/orchestration/localPaneBackend.ts src/hooks/useInputHandling.ts __tests__/attachAgent.test.ts __tests__/localPaneBackend.test.ts __tests__/worktreePaneCreationReservation.test.ts
git commit -m "fix: allocate attached pane slugs under reservation"
```

### Task 5: Preserve launched pane effects when metadata enrichment fails

**Files:**
- Modify: `src/orchestration/types.ts`
- Modify: `src/orchestration/orchestrator.ts`
- Modify: `src/orchestration/localPaneBackend.ts`
- Test: `__tests__/localPaneBackend.test.ts`
- Test: `__tests__/orchestrator.test.ts`

- [ ] **Step 1: Add successful-warning contract tests**

```ts
test('returns the launched pane when orchestration metadata persistence fails', async () => {
  const launchedPane = pane({ id: 'pane-1' });
  const backend = createLocalPaneBackend({
    createPane: vi.fn(async () => launchedPane),
    persistOrchestrationMetadata: vi.fn(async () => {
      throw new Error('disk full');
    }),
  });

  const output = await backend(sharedWorktreeLane());

  expect(output.pane).toEqual(launchedPane);
  expect(output.warnings).toEqual([
    expect.objectContaining({
      code: 'orchestration_persistence_failed',
    }),
  ]);
});

test('includes a metadata-warning lane in completed task counts', async () => {
  const orchestrator = new Orchestrator({
    backend: async () => ({
      pane: pane({ id: 'pane-1' }),
      warnings: [{
        code: 'orchestration_persistence_failed',
        message: 'disk full',
      }],
    }),
  });

  const result = await orchestrator.execute(requestWithLaneMode('shared-worktree'));

  expect(result.completed).toHaveLength(1);
  expect(result.failed).toHaveLength(0);
  expect(result.completed[0].warnings?.[0].code)
    .toBe('orchestration_persistence_failed');
});
```

- [ ] **Step 2: Run tests and verify the launched pane is currently classified failed**

Run:

```bash
pnpm vitest --run \
  __tests__/localPaneBackend.test.ts \
  __tests__/orchestrator.test.ts \
  --exclude '**/.claude/**'
```

Expected: the new cases fail because metadata persistence rejects the lane.

- [ ] **Step 3: Add optional successful-lane warnings**

Define the optional contract:

```ts
export interface OrchestrationWarning {
  code: 'orchestration_persistence_failed';
  message: string;
}

export interface LaneExecutionOutput {
  pane?: PsychePane;
  sessionId?: string;
  warnings?: readonly OrchestrationWarning[];
}

export interface OrchestrationLaneSuccess {
  // existing fields
  warnings?: readonly OrchestrationWarning[];
}
```

No protocol version bump is required because the response fields are optional.

- [ ] **Step 4: Catch only post-launch metadata failure**

Once pane creation returns, record the authoritative effect before enrichment:

```ts
const pane = await createPaneFn(createOptions);
created.push(pane);

try {
  const enrichedPane = await persistOrchestrationMetadata(pane, lane);
  return { pane: enrichedPane };
} catch (error) {
  return {
    pane,
    warnings: [{
      code: 'orchestration_persistence_failed',
      message: error instanceof Error ? error.message : String(error),
    }],
  };
}
```

Do not catch creation, launch, or durable pane-record failures. Copy backend
warnings into `OrchestrationLaneSuccess` in `Orchestrator.runLane`.

- [ ] **Step 5: Run backend, orchestrator, and TUI integration tests**

Run:

```bash
pnpm vitest --run \
  __tests__/localPaneBackend.test.ts \
  __tests__/orchestrator.test.ts \
  __tests__/agentLaunch.test.ts \
  __tests__/attachAgent.test.ts \
  --exclude '**/.claude/**'
```

Expected: warning lanes count as completed, the pane remains in
`createdPanes`, and ordinary launch failures remain failed.

- [ ] **Step 6: Commit partial-effect reporting**

```bash
git add src/orchestration/types.ts src/orchestration/orchestrator.ts src/orchestration/localPaneBackend.ts __tests__/localPaneBackend.test.ts __tests__/orchestrator.test.ts
git commit -m "fix: preserve launched orchestration effects"
```

### Task 6: Run full focused validation and update the existing PR

**Files:**
- Verify: all files changed in Tasks 1-5

- [ ] **Step 1: Run all focused suites together**

```bash
pnpm vitest --run \
  __tests__/daemon/orchestrationDispatch.test.ts \
  __tests__/daemon/orchestrationBackend.test.ts \
  __tests__/daemon/controlHandlers.test.ts \
  __tests__/mcpAgentControl.test.ts \
  __tests__/attachAgent.test.ts \
  __tests__/localPaneBackend.test.ts \
  __tests__/orchestrator.test.ts \
  __tests__/worktreePaneCreationReservation.test.ts \
  --exclude '**/.claude/**'
```

Expected: all selected test files pass with zero failed tests.

- [ ] **Step 2: Run non-generating TypeScript, docs, and package validation**

```bash
pnpm --filter @opencoven/psyche-vim-core typecheck
pnpm exec tsc --noEmit
pnpm run typecheck:tests
pnpm docs:focus:check
pnpm --dir docs build
pnpm smoke:pack
```

Expected: all commands exit successfully without modifying tracked generated
files.

- [ ] **Step 3: Verify repository cleanliness and exact change scope**

```bash
git diff --check origin/main...HEAD
git status --short
git log --oneline origin/main..HEAD
```

Expected: no whitespace errors; status contains only intended changes; commit
history contains the design, five repair commits, and no unrelated work.

- [ ] **Step 4: Push the reconciled branch to the existing PR**

```bash
git push -u origin fix/orchestration-wave-a-follow-up
```

PR #177 remains the delivery vehicle. Refresh its tracked plan/spec references
if reconciliation changed the documented validation scope.

- [ ] **Step 5: Verify green CI and leave PR #177 unmerged**

Verify:

```bash
gh pr checks --repo OpenCoven/psyche-build --watch
```

Do not merge from this task; stop after the reconciled branch is pushed,
validation is recorded, and review threads are addressed.

Expected: every required check passes. Resolve all actionable review threads,
then rebase-merge to preserve linear history.
