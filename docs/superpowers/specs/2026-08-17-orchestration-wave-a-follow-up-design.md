# Orchestration Wave A Follow-up Design

## Goal

Repair the production orchestration path introduced by Wave A so authenticated
MCP and daemon requests execute real local lane effects, preserve canonical
project authority, and report partial effects without encouraging unsafe
retries.

## Scope

This follow-up is limited to five correctness defects:

1. Route `orchestration.execute` through the production daemon control handler.
2. Require an effectful local lane backend for the CLI-started daemon.
3. Keep the daemon's canonical project root authoritative.
4. Report metadata persistence failure after pane launch as a partial or
   effect-unknown result.
5. Allocate attached-pane slugs from fresh serialized pane state.

The orchestration protocol, lane model, and existing Wave A feature boundaries
remain unchanged.

## Architecture and Data Flow

The daemon control handler remains the single production dispatch boundary.
It will recognize `orchestration.execute`, validate the authenticated request,
and invoke the existing bridge/orchestrator path.

The CLI daemon startup path will construct and inject the real local lane
backend. The no-op backend may remain only as an explicit test fixture; no
production startup path may select it implicitly or report successful lane
completion without performing an effect.

The daemon's scoped project root remains the canonical project identity.
Caller-provided paths may select a working directory only after containment
validation. They cannot replace the root used for project state, worktrees,
pane configuration, or authorization.

## Effects and Error Semantics

Pane creation is the authoritative external effect. If pane launch succeeds
but orchestration metadata persistence fails, the result must identify the
created pane and report a partial or effect-unknown outcome. It must not return
an ordinary retry-safe failure, because retrying may create a duplicate agent.

Errors that occur before any external effect retain the existing failed-lane
contract. Successful results require proof that the configured backend
performed the requested lane effect.

## Concurrency

Attached-pane slug allocation moves inside the existing serialized
worktree-reuse reservation. Allocation reads fresh persisted pane state while
holding that reservation, chooses the next available sibling slug, and then
creates the pane before releasing the reservation.

This preserves unique pane identities when multiple processes attach
concurrently and keeps title-based rebinding and lifecycle targeting
unambiguous.

## Testing

Focused coverage will prove:

- MCP submission reaches the real production `orchestration.execute` handler.
- CLI daemon startup cannot use a success-shaped no-op backend.
- A caller-selected subdirectory cannot replace the canonical project root.
- Metadata persistence failure after launch reports a partial or unknown
  effect with the created pane identity.
- Concurrent attaches allocate distinct sibling slugs from fresh state.

Validation will run the focused orchestration, MCP, attach, local backend, and
daemon suites, followed by non-generating TypeScript checks plus the current
main docs/public-package gates: `pnpm docs:focus:check`,
`pnpm --dir docs build`, and `pnpm smoke:pack`.

## Completion

The follow-up is complete when all five defects have regression coverage, the
production paths use the repaired contracts, the focused, type-checking, and
package-validation commands pass, and the reconciled follow-up PR is ready to
merge with no unresolved review threads.
