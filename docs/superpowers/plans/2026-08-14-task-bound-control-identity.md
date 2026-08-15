# Task-Bound Control Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore agent resource and lease workflows with credentials bound to one canonical project and task, without restoring broad agent snapshots.

**Architecture:** Add task-bound credentials to the protected control credential store, verify the binding during the socket handshake, and derive task scope from authenticated identity. Add dedicated task-resource and lease-status protocol methods, then migrate MCP tools away from `state.get`.

**Idempotency boundary:** Hash every non-operator caller key at the authenticated server boundary with a versioned, length-prefixed identity scope. Task credentials use the canonical project root and authenticated task ID; operator keys retain project-wide semantics.

**Tech Stack:** TypeScript, Node.js Unix sockets, JSON line protocol, Vitest, MCP tools.

**Coordination:** Local experimental branches `pr-130` and `codex/complete-task-bound-control-snapshot-auth-after-130` are reference material only. This clean two-PR design intentionally supersedes them: do not rebase onto or merge them, and exclude their unrelated runtime timeout/quarantine changes. Leave them untouched until final equivalence review and cleanup.

---

## File Map

- `src/control/credentials.ts`: issue, persist, and authenticate task-bound credentials.
- `src/control/protocol.ts`: task binding plus dedicated resource and lease-status request/response types.
- `src/control/client.ts`: verify the welcome binding and expose scoped read methods.
- `src/control/server.ts`: enforce binding on mutations and serve scoped reads.
- `__tests__/controlServer.test.ts`: real-runtime task-scoped idempotency and replay coverage.
- `src/control/hostProcess.ts`: carry expected task binding into `ControlClient`.
- `src/mcp/server.ts`: parse task credentials and migrate MCP tools to dedicated reads.
- `__tests__/controlCredentials.test.ts`: credential and authenticated socket coverage.
- `__tests__/controlProtocol.test.ts`: protocol validation.
- `__tests__/controlClient.test.ts`: handshake and client method coverage.
- `__tests__/controlHostProcess.test.ts`: bootstrap propagation.
- `__tests__/mcpAgentControl.test.ts`: real task-isolation MCP coverage.
- `__tests__/helpers/taskScopedControlHarness.ts`: reusable real control-plane test harness.
- `README.md`: task-bound MCP launch variables.
- `docs/AGENT-SURFACE-CONTROL.md`: security and lifecycle documentation.

### Task 1: Create the PR A Worktree

**Files:**
- Preserve: `docs/superpowers/specs/2026-08-14-task-scoped-control-reads-design.md`
- Preserve: `docs/superpowers/plans/2026-08-14-task-bound-control-identity.md`

- [ ] **Step 1: Fetch and verify the base**

```bash
git fetch origin --prune
git rev-parse origin/main
git status --short --branch
```

Expected: `origin/main` contains merged PR #130 and the current worktree has no uncommitted implementation changes.

- [ ] **Step 2: Create an ignored isolated worktree**

```bash
git check-ignore -q .worktrees
git worktree add .worktrees/task-bound-control -b fix/task-bound-control-identity origin/main
```

Expected: `.worktrees/task-bound-control` is created on a new branch.

- [ ] **Step 3: Bring the approved design and plans into the branch**

```bash
git -C .worktrees/task-bound-control cherry-pick 4a24bd84 d6ff8bf0
git -C .worktrees/task-bound-control status --short --branch
```

Bootstrap note: This two-commit cherry-pick is used once to create `fix/task-bound-control-identity`. After the branch exists, its tip is authoritative; recreate the worktree by fetching and checking out that branch rather than replaying these commits, so later plan refinements are preserved.

Expected: the design and both plans are committed on the implementation branch.

- [ ] **Step 4: Install dependencies and run the focused baseline**

```bash
cd .worktrees/task-bound-control
pnpm install --frozen-lockfile
pnpm exec vitest --run \
  __tests__/controlCredentials.test.ts \
  __tests__/controlProtocol.test.ts \
  __tests__/controlClient.test.ts \
  __tests__/controlHostProcess.test.ts \
  __tests__/mcpAgentControl.test.ts
```

Expected: the existing focused suite passes before implementation.

### Task 2: Add Protected Task-Bound Credentials

**Files:**
- Modify: `src/control/credentials.ts`
- Test: `__tests__/controlCredentials.test.ts`

- [ ] **Step 1: Write failing credential tests**

Add tests that issue two task tokens and verify exact isolation:

```ts
const alpha = await issueControlTaskToken({ projectRoot: root, taskId: 'task-alpha', filePath });
const beta = await issueControlTaskToken({ projectRoot: root, taskId: 'task-beta', filePath });

await expect(store.authenticate(alpha)).resolves.toMatchObject({
  principal: { kind: 'agent' },
  taskBinding: { taskId: 'task-alpha' },
});
await expect(store.authenticate(beta)).resolves.toMatchObject({
  principal: { kind: 'agent' },
  taskBinding: { taskId: 'task-beta' },
});
expect(alpha).not.toBe(beta);
```

Also add tests that task-binding directories and files reject symlink parents, use mode `0600`, survive concurrent issuance, and reject blank task IDs.

- [ ] **Step 2: Run the credential tests and verify failure**

```bash
pnpm exec vitest --run __tests__/controlCredentials.test.ts
```

Expected: FAIL because task-token issuance and task-aware authentication do not exist.

- [ ] **Step 3: Define authenticated identity types**

Add:

```ts
export interface ControlTaskBinding {
  taskId: string;
}

export interface AuthenticatedControlIdentity {
  principal: ControlPrincipal;
  taskBinding?: ControlTaskBinding;
}

export interface ControlCredentialStore {
  authenticate(token: string): Promise<AuthenticatedControlIdentity | null>;
  operatorToken(): Promise<string>;
  agentToken(): Promise<string>;
}
```

Keep operator and shared-agent token behavior unchanged.

- [ ] **Step 4: Implement task-token issuance**

Add public and canonical-root seams:

```ts
export async function issueControlTaskToken(options: {
  projectRoot: string;
  taskId: string;
  filePath?: string;
}): Promise<string>;

export async function issueControlTaskTokenForCanonicalRoot(options: {
  canonicalProjectRoot: string;
  taskId: string;
  filePath?: string;
}): Promise<string>;
```

Generate 32 random bytes, store `{ "taskId": "..." }` in a `0600` file below the credential runtime directory, and name the file with `sha256(token)` rather than the raw token. Reuse the existing safe-parent, exclusive-create, sync, and close patterns. Authenticate by hashing the presented token and loading that exact binding file.

- [ ] **Step 5: Run credential tests**

```bash
pnpm exec vitest --run __tests__/controlCredentials.test.ts
```

Expected: PASS, including concurrency and symlink cases.

- [ ] **Step 6: Commit**

```bash
git add src/control/credentials.ts __tests__/controlCredentials.test.ts
git commit -m "feat: add task-bound control credentials"
```

### Task 3: Bind and Verify the Socket Handshake

**Files:**
- Modify: `src/control/protocol.ts`
- Modify: `src/control/client.ts`
- Modify: `src/control/server.ts`
- Test: `__tests__/controlProtocol.test.ts`
- Test: `__tests__/controlClient.test.ts`
- Test: `__tests__/controlCredentials.test.ts`

Sequencing note: PR A also pulls operator-only socket `events.read` enforcement
forward from PR B as handshake-boundary hardening, so authenticated task
credentials never gain raw event access.

- [ ] **Step 1: Write failing protocol and handshake tests**

Add a welcome decoding assertion:

```ts
expect(welcome).toMatchObject({
  type: 'welcome',
  taskBinding: { taskId: 'task-alpha' },
});
```

Add client tests proving:

```ts
await expect(connectWith({
  token: alphaToken,
  taskBinding: { taskId: 'task-beta' },
})).rejects.toThrow('welcome task binding does not match the requested task');
```

Add a real socket test proving a shared-agent token receives no task binding.

- [ ] **Step 2: Run the tests and verify failure**

```bash
pnpm exec vitest --run \
  __tests__/controlProtocol.test.ts \
  __tests__/controlClient.test.ts \
  __tests__/controlCredentials.test.ts
```

Expected: FAIL because welcome responses and client options have no task binding.

- [ ] **Step 3: Extend protocol and client types**

Add to the welcome response:

```ts
taskBinding?: {
  taskId: string;
};
```

Add to `ControlClientOptions`:

```ts
taskBinding?: {
  taskId: string;
};
```

Store the authenticated binding on `ControlClient`.

- [ ] **Step 4: Verify the welcome binding before resolving connect**

After project-root verification, add:

```ts
if (
  options.taskBinding?.taskId !== undefined
  && message.taskBinding?.taskId !== options.taskBinding.taskId
) {
  rejectAndClose(new Error('welcome task binding does not match the requested task'));
  return;
}
```

Do not accept a caller-supplied binding that the server did not authenticate.

- [ ] **Step 5: Carry authenticated identity through the server**

Change session authentication to retain `AuthenticatedControlIdentity`, pass it to `welcomeFor`, `submitAs`, and scoped read handlers, and echo only its authenticated `taskBinding`.

- [ ] **Step 6: Run tests**

```bash
pnpm exec vitest --run \
  __tests__/controlProtocol.test.ts \
  __tests__/controlClient.test.ts \
  __tests__/controlCredentials.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/control/protocol.ts src/control/client.ts src/control/server.ts \
  __tests__/controlProtocol.test.ts __tests__/controlClient.test.ts \
  __tests__/controlCredentials.test.ts
git commit -m "feat: bind control clients to authenticated tasks"
```

### Task 4: Enforce Task Scope on Mutations

**Files:**
- Modify: `src/control/server.ts`
- Test: `__tests__/controlCredentials.test.ts`

This mutation guard ships with Task 3's operator-only event boundary rather
than leaving an insecure intermediate state between PR A and PR B.

- [ ] **Step 1: Write failing mutation authorization tests**

For every agent command carrying `payload.taskId`, assert:

```ts
await expect(submitAs(alphaIdentity, commandFor('task-beta'))).resolves.toMatchObject({
  status: 'rejected',
  code: 'task_binding_mismatch',
});
```

Assert the shared-agent and compatibility identities receive:

```ts
{ status: 'rejected', code: 'task_binding_required' }
```

Cover lease request/release and one pane or browser action.

- [ ] **Step 2: Run the focused tests and verify failure**

```bash
pnpm exec vitest --run __tests__/controlCredentials.test.ts
```

Expected: FAIL because agent commands trust payload task IDs.

- [ ] **Step 3: Add one task-binding guard**

Implement a helper with these exact semantics:

```ts
function requireTaskBinding(
  identity: AuthenticatedControlIdentity,
  requestedTaskId: string | undefined,
): CommandOutcome | undefined {
  if (identity.principal.kind === 'operator') return undefined;
  const taskId = identity.taskBinding?.taskId;
  if (!taskId) return rejected('task_binding_required', 'task-bound control credential required');
  if (requestedTaskId !== taskId) {
    return rejected('task_binding_mismatch', 'command task does not match authenticated task');
  }
  return undefined;
}
```

Use the repository's existing rejected-outcome constructor rather than creating a second response shape.

- [ ] **Step 4: Apply the guard before runtime submission**

In `submitAs`, derive `requestedTaskId` from task-sensitive command payloads and return the guard rejection before constructing or submitting the command. Operator behavior remains unchanged.

For `orchestration.execute`, also validate the nested `payload.request.taskId`
against the authenticated task (or the operator-requested outer task) and the
nested `payload.request.projectRoot` against the server's canonical project
root. Reject mismatches before runtime dispatch, then reconstruct the nested
request with the trusted task ID and canonical project root so client-supplied
identity fields never cross the server boundary unchanged.

- [ ] **Step 5: Run tests**

```bash
pnpm exec vitest --run __tests__/controlCredentials.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/control/server.ts __tests__/controlCredentials.test.ts
git commit -m "fix: enforce authenticated task scope on control commands"
```

### Task 5: Add Dedicated Resource and Lease-Status Reads

**Files:**
- Modify: `src/control/protocol.ts`
- Modify: `src/control/client.ts`
- Modify: `src/control/server.ts`
- Test: `__tests__/controlProtocol.test.ts`
- Test: `__tests__/controlClient.test.ts`
- Test: `__tests__/controlCredentials.test.ts`

- [ ] **Step 1: Write failing protocol tests**

Add request/response coverage for:

```ts
{ version: 1, type: 'task.resources.get', requestId: '1' }
{ version: 1, type: 'lease.status.get', requestId: '2', leaseRequestId: 'request-1', leaseId: 'lease-1' }
```

Reject blank or oversized `leaseRequestId` and `leaseId`.

- [ ] **Step 2: Define dedicated response types**

Add:

```ts
type TaskResourcesResult = {
  version: 1;
  type: 'task.resources.result';
  requestId: string;
  ownerEpoch: number;
  sequence: number;
  resources: readonly SurfaceResource[];
};

type LeaseStatusResult = {
  version: 1;
  type: 'lease.status.result';
  requestId: string;
  requests: ReadonlyArray<ControlSnapshot['leaseRequests'][number]>;
  leases: readonly CapabilityLease[];
};

export type TaskResourcesResultData = Omit<
  TaskResourcesResult,
  'version' | 'type' | 'requestId'
>;

export type LeaseStatusResultData = Omit<
  LeaseStatusResult,
  'version' | 'type' | 'requestId'
>;
```

Import the existing public resource, request, and lease types rather than duplicating their fields.

- [ ] **Step 3: Write failing authorization tests**

Create alpha and beta resources, requests, and leases. Assert alpha sees only alpha records, beta sees only beta records, and unbound agent/compatibility requests receive `task_binding_required`.

```ts
await expect(alphaClient.taskResources()).resolves.toEqual({
  ownerEpoch,
  sequence,
  resources: [alphaResource],
});
await expect(alphaClient.leaseStatus(betaRequest.id)).resolves.toEqual({
  requests: [],
  leases: [],
});
await expect(unboundClient.taskResources()).rejects.toMatchObject({
  code: 'task_binding_required',
});
```

- [ ] **Step 4: Implement server-side scoped queries**

Add authority methods:

```ts
taskResources(identity: AuthenticatedControlIdentity): TaskResourcesResultData;
leaseStatus(
  identity: AuthenticatedControlIdentity,
  leaseRequestId: string,
  leaseId?: string,
): LeaseStatusResultData;
```

Use the authenticated task ID. Return empty arrays when the named request belongs to another task. Resolve resources only through that task's active, non-expired capability leases; pending requests remain inspectable through `leaseStatus()` but never authorize resource metadata. Never return all runtime resources.

- [ ] **Step 5: Add client methods**

Add:

```ts
taskResources(): Promise<TaskResourcesResultData>;
leaseStatus(leaseRequestId: string, leaseId?: string): Promise<LeaseStatusResultData>;
```

These methods send no task ID.

- [ ] **Step 6: Run focused tests**

```bash
pnpm exec vitest --run \
  __tests__/controlProtocol.test.ts \
  __tests__/controlClient.test.ts \
  __tests__/controlCredentials.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/control/protocol.ts src/control/client.ts src/control/server.ts \
  __tests__/controlProtocol.test.ts __tests__/controlClient.test.ts \
  __tests__/controlCredentials.test.ts
git commit -m "feat: add task-scoped control read APIs"
```

### Task 6: Wire Task Identity Through Host and MCP

**Files:**
- Modify: `src/control/hostProcess.ts`
- Modify: `src/mcp/server.ts`
- Create: `__tests__/helpers/taskScopedControlHarness.ts`
- Test: `__tests__/controlHostProcess.test.ts`
- Test: `__tests__/mcpAgentControl.test.ts`

- [ ] **Step 1: Write failing argument and bootstrap tests**

Cover:

```ts
parseMcpArgs(['--task-id', 'task-alpha'], {
  PSYCHE_CONTROL_TASK_TOKEN: alphaToken,
});
```

Assert task ID without token and token without task ID throw explicit errors. Assert host bootstrap passes both token and expected binding to `ControlClient.connectCanonical`.

- [ ] **Step 2: Add MCP run options**

Define:

```ts
export interface McpTaskBinding {
  taskId: string;
  token: string;
}

export interface McpRunOptions {
  taskBinding?: McpTaskBinding;
}
```

Read task ID from `--task-id` or `PSYCHE_CONTROL_TASK_ID`; read the token only from `PSYCHE_CONTROL_TASK_TOKEN`.

- [ ] **Step 3: Partition shared clients by task**

Include canonical root, endpoint, authenticated task ID, and a SHA-256 fingerprint of the presented token in the shared-client and startup-flight keys. Never store the raw token in a key. Pass `taskBinding: { taskId }` with the task token to host bootstrap. Only the exact same token/task/root may share; never reuse an unbound shared-agent client or a differently credentialed task client for a task-bound MCP process.

- [ ] **Step 4: Migrate MCP read tools**

Extend `McpControlClient` and its borrowed-client adapter with:

```ts
taskResources(): Promise<TaskResourcesResultData>;
leaseStatus(leaseRequestId: string, leaseId?: string): Promise<LeaseStatusResultData>;
```

Change:

```ts
await client.getState()
```

to:

```ts
await client.taskResources()
```

for `psyche_control_list` and `psyche_list_panes`.

Preserve the existing MCP JSON keys without repopulating redacted authority:

```ts
const scoped = await client.taskResources();
return {
  project_root: projectRoot,
  owner_epoch: scoped.ownerEpoch,
  sequence: scoped.sequence,
  resources: scoped.resources,
  approvals: [],
  receipts: [],
};
```

Change lease status to:

```ts
await client.leaseStatus(requestId, leaseId)
```

For task-sensitive mutations, derive the task ID from `client.taskBinding`. If the tool also receives `task_id`, reject a mismatch with MCP invalid-params instead of overriding the authenticated binding.

- [ ] **Step 5: Build a real task-scoped harness**

Create a helper that starts a real credential store, runtime, control server, and task-bound clients for two task IDs. Expose methods to seed task-owned requests/leases/resources and close all sockets and temporary directories.

- [ ] **Step 6: Add MCP end-to-end isolation tests**

Prove:

- Alpha lists only alpha resources.
- Alpha lease status cannot reveal beta's request or lease.
- An unbound shared-agent MCP client receives `task_binding_required`.
- A supplied beta `task_id` on alpha's client receives `task_binding_mismatch`.
- Alpha may request and release its own lease.

```ts
await expect(callTool(alphaMcp, 'psyche_control_list', {})).resolves.toMatchObject({
  resources: [alphaResource],
});
await expect(callTool(alphaMcp, 'psyche_control_lease', {
  operation: 'status',
  request_id: betaRequest.id,
})).resolves.toEqual({ requests: [], leases: [] });
await expect(callTool(alphaMcp, 'psyche_control_lease', {
  operation: 'status',
  task_id: 'task-beta',
  request_id: alphaRequest.id,
})).rejects.toMatchObject({ code: ERR_INVALID_PARAMS });
```

- [ ] **Step 7: Run tests**

```bash
pnpm exec vitest --run \
  __tests__/controlHostProcess.test.ts \
  __tests__/mcpAgentControl.test.ts \
  __tests__/controlCredentials.test.ts \
  __tests__/controlClient.test.ts \
  __tests__/controlProtocol.test.ts
pnpm run typecheck
```

Expected: all tests and typecheck pass.

- [ ] **Step 8: Commit**

```bash
git add src/control/hostProcess.ts src/mcp/server.ts \
  __tests__/helpers/taskScopedControlHarness.ts \
  __tests__/controlHostProcess.test.ts __tests__/mcpAgentControl.test.ts
git commit -m "feat: wire task-bound identity into MCP control"
```

### Task 7: Document, Review, and Merge PR A

**Files:**
- Modify: `README.md`
- Modify: `docs/AGENT-SURFACE-CONTROL.md`
- Verify: all Task 2-6 files.

- [ ] **Step 1: Document launch and trust behavior**

Document:

```text
PSYCHE_CONTROL_TASK_ID=task-alpha
PSYCHE_CONTROL_TASK_TOKEN=8f5d2a5f6b7c8d9e00112233445566778899aabbccddeeff0011223344556677
```

State that the shared agent token has no task scope, caller `task_id` values do not establish authority, and raw operator snapshots remain unavailable to agents.

- [ ] **Step 2: Run the complete PR A verification**

```bash
git diff --check origin/main...HEAD
pnpm exec vitest --run \
  __tests__/controlCredentials.test.ts \
  __tests__/controlProtocol.test.ts \
  __tests__/controlClient.test.ts \
  __tests__/controlHostProcess.test.ts \
  __tests__/mcpAgentControl.test.ts
pnpm run typecheck
```

Expected: all commands pass.

- [ ] **Step 3: Commit documentation**

```bash
git add README.md docs/AGENT-SURFACE-CONTROL.md
git commit -m "docs: explain task-bound control identity"
```

- [ ] **Step 4: Review the complete diff**

```bash
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- \
  src/control/credentials.ts src/control/protocol.ts src/control/client.ts \
  src/control/server.ts src/control/hostProcess.ts src/mcp/server.ts
```

Expected: no canonical action-status/receipt ownership, task-filtered raw-event
API, queue timeout, or runtime quarantine changes are present in PR A. The
operator-only raw-event gate is intentionally included.

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin fix/task-bound-control-identity
gh pr create \
  --base main \
  --head fix/task-bound-control-identity \
  --title "Bind agent control reads to authenticated tasks" \
  --label aardvark \
  --body "$(cat <<'EOF'
## Summary
- authenticate MCP control clients with project-local task-bound credentials
- derive mutation and read scope from the authenticated task
- replace broad agent snapshots with dedicated resource and lease-status reads

## Security boundary
- shared-agent and compatibility identities cannot establish task scope
- caller-provided task IDs must match the authenticated binding
- task A cannot list or inspect task B resources, requests, or leases

## Verification
- focused control credential, protocol, client, host, and MCP tests
- pnpm run typecheck

## Follow-up
PR A enforces operator-only raw events. PR B verifies that boundary while adding canonical task-owned action receipts and explicit fail-closed snapshot redaction.
EOF
)"
```

The PR body must state the security boundary, focused commands run, and that PR A enforces operator-only raw events while PR B verifies that boundary and adds canonical task-owned action receipts plus explicit fail-closed redaction.

- [ ] **Step 6: Wait for checks and merge**

```bash
gh pr checks --watch
gh pr merge --squash --admin --delete-branch
git fetch origin main
```

Expected: required checks pass before merge; the remote feature branch is deleted.
