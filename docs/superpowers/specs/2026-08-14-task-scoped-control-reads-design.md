# Task-Scoped Control Reads Design

## Goal

Restore agent lease, resource, and action-status workflows after PR #130 without
re-exposing operator snapshots, raw journal history, or another task's authority.

## Scope

Deliver two sequential follow-up pull requests from the latest `origin/main`.
Commit `2b958123` is reference material only. Its unrelated runtime timeout,
queue quarantine, and ambiguity changes are excluded.

## Security Model

The control plane recognizes three effective trust levels:

1. Operators retain full snapshot and event access.
2. Task-bound agents may read and mutate only records owned by their
   authenticated task.
3. Unbound shared-agent and compatibility identities remain authenticated but
   cannot perform task-sensitive reads or mutations.

The authenticated task binding is authoritative. Caller-provided task IDs are
validated for equality but never establish scope. Missing and cross-task
records return indistinguishable not-found results.

## PR A: Task Identity and Scoped Workflow Reads

### Credential and Handshake Flow

The existing protected credential store gains random task-bound credentials
associated with the canonical project root and task ID. It preserves the
current atomic publication, permissions, and symlink protections.

The host passes the expected task binding to `ControlClient`. The client sends
the credential during `hello`; `welcome` echoes the authenticated binding. The
client rejects missing, malformed, cross-project, or mismatched bindings before
issuing application requests.

Operator credentials remain unchanged. Legacy shared-agent and compatibility
credentials do not receive an implicit task binding.

### Dedicated Read APIs

MCP tools stop deriving workflow state from broad snapshots:

- `psyche_control_list` and `psyche_list_panes` use a task-resource query.
- `psyche_control_lease status` uses a task/request-scoped lease-status query.
- Task-sensitive mutations derive their scope from authenticated identity.

The task-resource query returns only resources referenced by the authenticated
task's lease requests or granted capabilities. The lease-status query returns
only the matching request and leases for the authenticated task.

### Errors

- Unbound agent and compatibility identities receive
  `task_binding_required`.
- A caller-provided task ID that differs from the authenticated binding
  receives `task_binding_mismatch`.
- Missing and cross-task records use the same empty or not-found response.
- Existing malformed, oversized, unauthenticated, and project-mismatched frame
  handling remains fail-closed.

## PR B: Canonical Receipts and Closed Read Surfaces

### Canonical Action Status

The runtime records task ownership with retained action receipts and provides
an exact task/action lookup. `ControlClient.actionStatus()` calls that lookup
directly.

The implementation must not scan a bounded journal window, reconstruct a
receipt from redacted journal data, or return a receipt owned by another task.
Receipt retention remains bounded using the existing runtime policy.

### Event Authorization

Raw `events.read` is operator-only. Non-operator callers receive
`operator_required`.

Task-bound clients use dedicated resource, lease-status, and action-status
queries instead of filtered journal access. This avoids leaking event cursor
metadata, command history, approval identifiers, or resource digests.

### Snapshot Redaction

Non-operator snapshots are constructed from an explicit field allowlist. They
contain only the non-sensitive synchronization metadata required by the
protocol and explicit empty authority collections.

The construction and tests use exact types and exact equality so a future
required `ControlSnapshot` field causes a compile or test failure instead of
being disclosed through object spread.

## Data Flow

1. The host obtains a credential bound to the canonical project and task.
2. MCP constructs `ControlClient` with the expected task binding.
3. The socket handshake authenticates the credential and echoes the binding.
4. The client verifies the binding before sending requests.
5. MCP tools issue dedicated scoped queries or task-sensitive mutations.
6. The server derives scope from the authenticated identity.
7. The runtime returns only task-owned resources, request/lease status, or
   canonical receipts.

No task-sensitive decision trusts a task ID supplied only in tool arguments or
request payloads.

## Testing

### PR A

- Protocol encode/decode coverage for task-bound handshake and scoped queries.
- Credential persistence, atomic publication, permissions, and symlink tests.
- Real socket tests for valid, absent, malformed, cross-project, and mismatched
  bindings.
- MCP end-to-end tests proving two task tokens cannot list, inspect, or mutate
  each other's resources, requests, or leases.
- Fail-closed coverage for shared-agent and compatibility identities.

### PR B

- Runtime tests for receipt ownership, retention, and exact lookup.
- Action-status coverage beyond the former 1,000-event scan window.
- Cross-task and missing action IDs returning indistinguishable not-found
  results.
- Non-operator `events.read` denial tests.
- Exact-equality non-operator snapshot tests.
- Real MCP request, grant, action, and canonical status coverage.

Each PR runs its focused Vitest suites, `pnpm run typecheck`, and all required
GitHub checks before squash merge.

## Delivery and Cleanup

PR A merges before PR B. Each PR includes its implementation and directly
related tests.

After both merge, compare the experimental `pr-130` branch with final `main`.
Remove its worktree and branch only after every retained behavior is represented
or every excluded behavior is documented as unrelated. Then resume the
Aardvark train at PR #132.
