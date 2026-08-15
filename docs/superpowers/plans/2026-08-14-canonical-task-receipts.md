# Canonical Task Receipts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give task-bound agents exact canonical action status while preserving
PR A's operator-only raw event boundary and making non-operator snapshot
redaction fail closed.

**Architecture:** Store receipt ownership separately from the public receipt,
add a dedicated action-status request scoped by authenticated task identity,
and remove the client's bounded journal fallback. Verify no non-operator raw
event path remains and construct redacted snapshots with an explicit typed
allowlist.

**Tech Stack:** TypeScript, Node.js Unix sockets, JSON line protocol, Vitest, MCP tools.

---

## File Map

- `src/control/types.ts`: internal task-owned receipt type if needed.
- `src/control/runtime.ts`: retain receipt ownership and exact scoped lookup.
- `src/control/protocol.ts`: dedicated action-status request/response.
- `src/control/client.ts`: canonical lookup without journal scanning.
- `src/control/server.ts`: principal-aware lookup, event denial, and explicit redaction.
- `src/mcp/server.ts`: use canonical action status.
- `__tests__/controlRuntime.test.ts`: ownership and retention.
- `__tests__/controlProtocol.test.ts`: action-status protocol validation.
- `__tests__/controlClient.test.ts`: no journal fallback.
- `__tests__/controlCredentials.test.ts`: socket authorization and redaction.
- `__tests__/mcpAgentControl.test.ts`: request-to-status end-to-end coverage.
- `README.md`: canonical status behavior.
- `docs/AGENT-SURFACE-CONTROL.md`: operator events and task receipt boundary.

### Task 1: Create the PR B Worktree

**Files:**
- Verify: merged PR A files and design documents.

- [ ] **Step 1: Fetch the PR A result**

```bash
git fetch origin --prune
git log -1 --oneline origin/main
gh pr list --state merged --search '"Bind agent control reads to authenticated tasks"'
```

Expected: PR A is merged into `origin/main`.

- [ ] **Step 2: Create an isolated worktree**

```bash
git check-ignore -q .worktrees
git worktree add .worktrees/canonical-task-receipts \
  -b fix/canonical-task-receipts origin/main
cd .worktrees/canonical-task-receipts
```

Expected: clean branch based on the PR A result.

- [ ] **Step 3: Install and run the focused baseline**

```bash
pnpm install --frozen-lockfile
pnpm exec vitest --run \
  __tests__/controlRuntime.test.ts \
  __tests__/controlProtocol.test.ts \
  __tests__/controlClient.test.ts \
  __tests__/controlCredentials.test.ts \
  __tests__/mcpAgentControl.test.ts
```

Expected: PASS before PR B changes.

### Task 2: Retain Canonical Receipt Ownership

**Files:**
- Modify: `src/control/runtime.ts`
- Modify: `src/control/types.ts`
- Test: `__tests__/controlRuntime.test.ts`

- [ ] **Step 1: Write failing ownership tests**

Create alpha and beta action receipts and assert:

```ts
expect(runtime.receiptForTask('action-alpha', 'task-alpha')).toEqual(alphaReceipt);
expect(runtime.receiptForTask('action-alpha', 'task-beta')).toBeUndefined();
expect(runtime.receiptForTask('missing', 'task-alpha')).toBeUndefined();
```

Insert more than the journal scan limit worth of unrelated events and verify alpha's retained receipt is still returned while present in receipt retention.

- [ ] **Step 2: Run the runtime test and verify failure**

```bash
pnpm exec vitest --run __tests__/controlRuntime.test.ts
```

Expected: FAIL because receipts have no retained task ownership or exact lookup.

- [ ] **Step 3: Add an internal owned-receipt record**

Use an internal type that never changes the public `ActionReceipt`:

```ts
interface TaskOwnedReceipt {
  taskId: string;
  receipt: ActionReceipt;
}
```

Change the runtime map to:

```ts
private readonly receipts = new Map<string, TaskOwnedReceipt>();
```

- [ ] **Step 4: Record ownership at the trusted action boundary**

Change receipt retention to:

```ts
private rememberReceipt(receipt: ActionReceipt, taskId: string): void {
  const redacted = redactReceipt(receipt);
  this.receipts.delete(receipt.actionId);
  this.receipts.set(receipt.actionId, { taskId, receipt: redacted });
  while (this.receipts.size > MAX_COMMAND_RECORDS) {
    const oldest = this.receipts.keys().next().value;
    if (oldest === undefined) break;
    this.receipts.delete(oldest);
  }
}
```

Pass the task ID already validated by capability-lease authorization at every `rememberReceipt` call. Do not derive ownership from client-supplied status queries.

- [ ] **Step 5: Add exact lookup and preserve operator snapshots**

Add:

```ts
receiptForTask(actionId: string, taskId: string): ActionReceipt | undefined {
  const owned = this.receipts.get(actionId);
  return owned?.taskId === taskId ? owned.receipt : undefined;
}

receipt(actionId: string): ActionReceipt | undefined {
  return this.receipts.get(actionId)?.receipt;
}
```

In `snapshot()`, expose only `owned.receipt` values so operator output is unchanged.

- [ ] **Step 6: Run tests**

```bash
pnpm exec vitest --run __tests__/controlRuntime.test.ts
```

Expected: PASS, including retention and cross-task cases.

- [ ] **Step 7: Commit**

```bash
git add src/control/runtime.ts src/control/types.ts __tests__/controlRuntime.test.ts
git commit -m "feat: retain task ownership for action receipts"
```

### Task 3: Add Canonical Action-Status Protocol

**Files:**
- Modify: `src/control/protocol.ts`
- Modify: `src/control/client.ts`
- Modify: `src/control/server.ts`
- Test: `__tests__/controlProtocol.test.ts`
- Test: `__tests__/controlClient.test.ts`
- Test: `__tests__/controlCredentials.test.ts`

- [ ] **Step 1: Write failing protocol tests**

Add valid request coverage:

```ts
{
  version: 1,
  type: 'action.status.get',
  requestId: 'status-1',
  actionId: 'action-alpha',
}
```

Reject blank and oversized action IDs.

- [ ] **Step 2: Define response shape**

Add:

```ts
type ActionStatusResult = {
  version: 1;
  type: 'action.status.result';
  requestId: string;
  receipt?: ActionReceipt;
};
```

Omission means missing or owned by another task.

- [ ] **Step 3: Write failing socket authorization tests**

Assert:

- Alpha receives alpha's canonical receipt.
- Beta receives no receipt for alpha's action ID.
- Unbound agent and compatibility identities receive `task_binding_required`.
- Operators receive the exact retained receipt through a global lookup.

```ts
await expect(alphaClient.actionStatus(alphaReceipt.actionId)).resolves.toEqual(alphaReceipt);
await expect(betaClient.actionStatus(alphaReceipt.actionId)).resolves.toBeUndefined();
await expect(unboundClient.actionStatus(alphaReceipt.actionId)).rejects.toMatchObject({
  code: 'task_binding_required',
});
await expect(operatorClient.actionStatus(alphaReceipt.actionId)).resolves.toEqual(alphaReceipt);
```

- [ ] **Step 4: Implement authority lookup**

Add:

```ts
actionStatus(
  identity: AuthenticatedControlIdentity,
  actionId: string,
): ActionReceipt | undefined
```

Operators may read the exact retained receipt. Non-operators require a task binding and call `runtime.receiptForTask(actionId, taskId)`.

- [ ] **Step 5: Replace the client journal fallback**

Replace the entire snapshot-plus-event scan with:

```ts
actionStatus(actionId: string): Promise<ActionReceipt | undefined> {
  return this.request({
    version: 1,
    type: 'action.status.get',
    requestId: this.allocateRequestId(),
    actionId,
  }).then((response) => {
    if (response.type === 'action.status.result') return response.receipt;
    throw responseError(response, 'action.status.get');
  });
}
```

Delete receipt parsing from journal events if it has no remaining caller.

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
git commit -m "feat: add canonical task action status"
```

### Task 4: Verify Raw Events Remain Operator-Only

**Files:**
- Modify: `src/control/server.ts`
- Test: `__tests__/controlCredentials.test.ts`
- Test: `__tests__/controlClient.test.ts`

- [ ] **Step 1: Verify complete denial coverage**

Retain real authenticated socket coverage asserting:

```ts
await expect(agentClient.readEvents(0)).rejects.toMatchObject({
  code: 'operator_required',
});
await expect(compatibilityClient.readEvents(0)).rejects.toMatchObject({
  code: 'operator_required',
});
await expect(operatorClient.readEvents(0)).resolves.toMatchObject({
  events: expect.any(Array),
});
```

Also assert denied responses expose no events or cursor metadata and the
runtime event reader is not called.

- [ ] **Step 2: Run the inherited PR A tests**

```bash
pnpm exec vitest --run \
  __tests__/controlCredentials.test.ts \
  __tests__/controlClient.test.ts
```

Expected: PASS because PR A pulled this handshake-boundary enforcement
forward.

- [ ] **Step 3: Remove any remaining non-operator path**

Verify the `events.read` handler still rejects before reading:

```ts
if (identity.principal.kind !== 'operator') {
  write({
    version: 1,
    type: 'error',
    requestId: request.requestId,
    code: 'operator_required',
    message: 'raw control events require operator authority',
  });
  return;
}
```

Remove or guard any alternate raw-event route discovered during PR B. Do not
return empty pages or cursor metadata to non-operators.

- [ ] **Step 4: Run tests**

```bash
pnpm exec vitest --run \
  __tests__/controlCredentials.test.ts \
  __tests__/controlClient.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit only if a remaining path required cleanup**

```bash
git add src/control/server.ts __tests__/controlCredentials.test.ts __tests__/controlClient.test.ts
git commit -m "fix: close remaining raw event path"
```

### Task 5: Make Snapshot Redaction Fail Closed

**Files:**
- Modify: `src/control/server.ts`
- Test: `__tests__/controlCredentials.test.ts`

- [ ] **Step 1: Replace partial assertions with exact expected snapshots**

For agent and compatibility principals, assert:

```ts
const sensitiveWithFutureField = {
  ...sensitive,
  futureSecret: 'must-not-leak',
} as ControlSnapshot & { futureSecret: string };

const snapshot = authority.snapshot(agentPrincipal, sensitiveWithFutureField);
expect(snapshot).not.toHaveProperty('futureSecret');
expect(snapshot).toEqual({
  ownerEpoch: sensitive.ownerEpoch,
  sequence: sensitive.sequence,
  commands: {},
  leases: {},
  resources: [],
  capabilityLeases: [],
  leaseRequests: [],
  approvals: [],
  receipts: [],
} satisfies ControlSnapshot);
```

- [ ] **Step 2: Run the test before implementation**

```bash
pnpm exec vitest --run __tests__/controlCredentials.test.ts
```

Expected: FAIL if the current redaction uses object spread or retains additional fields.

- [ ] **Step 3: Construct the redacted snapshot explicitly**

Implement:

```ts
function redactedControlSnapshot(snapshot: ControlSnapshot): ControlSnapshot {
  return {
    ownerEpoch: snapshot.ownerEpoch,
    sequence: snapshot.sequence,
    commands: {},
    leases: {},
    resources: [],
    capabilityLeases: [],
    leaseRequests: [],
    approvals: [],
    receipts: [],
  };
}
```

Do not use `...snapshot`.

- [ ] **Step 4: Run tests and typecheck**

```bash
pnpm exec vitest --run __tests__/controlCredentials.test.ts
pnpm run typecheck
```

Expected: PASS. Adding a required snapshot field in the future must make this helper fail typecheck until explicitly classified.

- [ ] **Step 5: Commit**

```bash
git add src/control/server.ts __tests__/controlCredentials.test.ts
git commit -m "fix: make non-operator snapshot redaction explicit"
```

### Task 6: Wire MCP to Canonical Status

**Files:**
- Modify: `src/mcp/server.ts`
- Modify: `__tests__/helpers/taskScopedControlHarness.ts`
- Test: `__tests__/mcpAgentControl.test.ts`

- [ ] **Step 1: Write failing end-to-end status tests**

Use the real harness to:

1. Request and grant an alpha lease.
2. Submit an alpha action.
3. Create more than 1,000 unrelated journal events.
4. Call `psyche_control_action_status`.

Assert the exact canonical receipt is returned. Assert beta receives:

```ts
await expect(callTool(alphaMcp, 'psyche_control_action_status', {
  action_id: alphaReceipt.actionId,
})).resolves.toEqual(alphaReceipt);

await expect(callTool(betaMcp, 'psyche_control_action_status', {
  action_id: alphaReceipt.actionId,
})).resolves.toEqual({
  status: 'unknown',
  action_id: alphaReceipt.actionId,
});
```

Generate the unrelated journal traffic with rejected or non-receipt events so the retained alpha receipt is not evicted from the bounded receipt map.

- [ ] **Step 2: Run the MCP test and verify failure**

```bash
pnpm exec vitest --run __tests__/mcpAgentControl.test.ts
```

Expected: FAIL until MCP uses the new exact protocol lookup.

- [ ] **Step 3: Simplify the MCP client contract**

Keep:

```ts
actionStatus(actionId: string): Promise<ActionReceipt | undefined>;
```

Remove any task-scope argument from MCP's call. The authenticated client binding supplies scope.

- [ ] **Step 4: Run the end-to-end suite**

```bash
pnpm exec vitest --run \
  __tests__/mcpAgentControl.test.ts \
  __tests__/controlRuntime.test.ts \
  __tests__/controlProtocol.test.ts \
  __tests__/controlClient.test.ts \
  __tests__/controlCredentials.test.ts
pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts __tests__/helpers/taskScopedControlHarness.ts \
  __tests__/mcpAgentControl.test.ts
git commit -m "fix: return canonical task action status"
```

### Task 7: Document, Review, and Merge PR B

**Files:**
- Modify: `README.md`
- Modify: `docs/AGENT-SURFACE-CONTROL.md`
- Verify: all Task 2-6 files.

- [ ] **Step 1: Document read boundaries**

Document that:

- Raw journal events are operator-only.
- Agents use dedicated task resource, lease-status, and action-status APIs.
- Cross-task and missing action IDs are intentionally indistinguishable.
- Action status is exact while the receipt remains in bounded runtime retention.

```text
Agents do not read the raw control journal. Task-bound clients use dedicated
resource, lease-status, and action-status requests. Missing and cross-task
action IDs intentionally return the same unknown result.
```

- [ ] **Step 2: Run complete PR B verification**

```bash
git diff --check origin/main...HEAD
pnpm exec vitest --run \
  __tests__/controlRuntime.test.ts \
  __tests__/controlProtocol.test.ts \
  __tests__/controlClient.test.ts \
  __tests__/controlCredentials.test.ts \
  __tests__/mcpAgentControl.test.ts
pnpm run typecheck
```

Expected: all commands pass.

- [ ] **Step 3: Commit documentation**

```bash
git add README.md docs/AGENT-SURFACE-CONTROL.md
git commit -m "docs: define canonical task control reads"
```

- [ ] **Step 4: Review the complete diff**

```bash
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- \
  src/control/types.ts src/control/runtime.ts src/control/protocol.ts \
  src/control/client.ts src/control/server.ts src/mcp/server.ts
```

Expected: no timeout, queue quarantine, provider lifecycle, or unrelated runtime behavior changes.

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin fix/canonical-task-receipts
gh pr create \
  --base main \
  --head fix/canonical-task-receipts \
  --title "Return canonical task-scoped control receipts" \
  --label aardvark \
  --body "$(cat <<'EOF'
## Summary
- retain task ownership with canonical action receipts
- replace bounded journal scanning with an exact action-status request
- restrict raw event history to operators
- construct non-operator snapshots from an explicit allowlist

## Security boundary
- missing and cross-task action IDs are indistinguishable
- non-operators receive no raw events or cursor metadata
- future required snapshot fields fail typecheck until explicitly classified

## Verification
- focused runtime, protocol, client, credential, and MCP tests
- pnpm run typecheck
EOF
)"
```

The PR body must identify the three closed gaps: exact canonical status, operator-only events, and explicit fail-closed snapshot redaction.

- [ ] **Step 6: Wait for checks and merge**

```bash
gh pr checks --watch
gh pr merge --squash --admin --delete-branch
git fetch origin main
```

Expected: required checks pass before merge and the remote feature branch is deleted.

- [ ] **Step 7: Remove temporary follow-up worktrees**

```bash
cd ../..
git worktree remove .worktrees/task-bound-control
git worktree remove .worktrees/canonical-task-receipts
git worktree prune
```

Expected: only worktrees containing unmerged or explicitly preserved work remain.
