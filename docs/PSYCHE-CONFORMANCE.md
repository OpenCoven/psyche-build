# Psyche protocol conformance plan

**Status:** active mapping and migration plan; no conformance claim  
**Last reconciled:** 2026-08-26  
**Psyche Build owner:** [#253](https://github.com/OpenCoven/psyche-build/issues/253)  
**Parent architecture outcome:** [#201](https://github.com/OpenCoven/psyche-build/issues/201)  
**Psyche roadmap:** [OpenCoven/psyche#9](https://github.com/OpenCoven/psyche/issues/9)  
**Protocol publication:** [OpenCoven/psyche#11](https://github.com/OpenCoven/psyche/issues/11)  
**Ownership decision:** [OpenCoven/psyche#12](https://github.com/OpenCoven/psyche/issues/12)  
**Reference-client mirror:** [OpenCoven/psyche#13](https://github.com/OpenCoven/psyche/issues/13)

Psyche Build is the product and coding cockpit. Psyche is the target canonical orchestration protocol. This document defines how the existing product contracts can migrate without a big-bang rewrite, identity fork, support regression, or false claim of conformance.

## Evidence boundary

The repository already contains mature product-local orchestration and control contracts. Names beginning with `psyche.*` or `orch-*` do not by themselves make those records part of the public `OpenCoven/psyche` protocol.

Conformance begins only when Psyche Build:

1. pins an immutable released Psyche consumer profile;
2. verifies its source/artifact digest;
3. passes the profile's positive and negative canaries on the exact head;
4. maps product-local state through an approved adapter;
5. retains migration, rollback, and restart evidence.

Until then, this is a design/mapping contract, not shipped protocol support.

## Current implementation inventory

### Product-local orchestration

`src/orchestration/types.ts` currently defines:

- task identity: `taskId`;
- tracing/correlation: `traceId`;
- idempotent operation identity: `operationId`;
- lane identity: lane request `id`;
- lane modes: isolated worktree, shared worktree, terminal, and Coven session;
- project root, working directory, prompt, branch/start-point, and merge-target context;
- task results: `completed`, `partial`, or `failed`;
- lane results and structured orchestration errors, including lease and unknown-effect states.

`src/orchestration/operationIdentity.ts` creates domain-separated product-local identifiers such as:

- `orch-op-v1-*`;
- `orch-daemon-v1-*`;
- `orch-daemon-step-v1-*`;
- `orch-pane-v1-*`;
- `orch-lane-v1-*`.

These are useful idempotency and correlation mechanisms. They remain product-local aliases until a released Psyche profile explicitly accepts their mapping.

### Product-local control plane

`src/control/types.ts` and adjacent modules define:

- command IDs and idempotency keys;
- actor, owner epoch, project root, expiry, and scoped payloads;
- task-bound capability leases and revisions;
- pane/browser generation checks;
- approvals and approval resolution;
- action receipts using `psyche.control.receipt/v1`;
- receipt states: queued, running, approval required, succeeded, failed, denied, expired, and unknown;
- journal-backed durability and resource digests;
- guarded orchestration, pane, browser, provider, and Git-related commands.

Important implementation seams include:

- `src/control/taskIdentity.ts`;
- `src/control/capabilityLeases.ts`;
- `src/control/approvals.ts`;
- `src/control/journal.ts`;
- `src/control/protocol.ts`;
- `src/control/runtime.ts`;
- `src/orchestration/adapters.ts`;
- `src/orchestration/capabilityRouter.ts`;
- `src/orchestration/covenSessionBackend.ts`;
- `src/orchestration/operationIdentity.ts`;
- `src/orchestration/orchestrator.ts`.

## Target ownership

| Concern | Canonical owner | Psyche Build role |
|---|---|---|
| Familiar/person binding | Familiar Contract | reference stable subject/familiar identity |
| Protected-surface authorization | Coven Threads | carry/enforce approved decision and constraints |
| Task/graph/lane/attempt/delegation/delivery identity | Psyche | implement a versioned adapter |
| Lease/approval/receipt/cancellation/recovery semantics | Psyche | project into product control/UI state |
| Daemon/session/persistence authority | Coven | reference through typed backend |
| Pane/tmux/worktree/branch/provider state | Psyche Build | remain product-local execution locators |
| Human UI and interaction state | Psyche Build | display/request protocol state; never invent authority |
| Beads/GitHub planning | Beads/GitHub | planning references only, never runtime identity |

The cross-repository ownership decision in `OpenCoven/psyche#12` remains authoritative when approved.

## Mapping matrix

| Current Psyche Build concept | Current role | Target Psyche concept | Migration disposition |
|---|---|---|---|
| `taskId` | caller/product task correlation | canonical task ID | validate/map; do not trust arbitrary strings as protocol identity |
| `traceId` | observability correlation | trace/causality metadata | retain as non-authoritative metadata |
| `operationId` / `orch-op-v1-*` | idempotent operation identity | attempt/action request correlation | retain as alias or derive from canonical request; never substitute silently |
| lane request `id` | product lane key | lane ID | dual-ID migration with one-to-one binding |
| pane/session ID | execution resource locator | runtime/session reference | reference only; not task/lane/attempt identity |
| tmux pane/session | process transport | runtime handle | local and replaceable |
| worktree path/branch/commit | isolated code resource/evidence | artifact/snapshot/source reference | bind by canonical digest/reference, not path alone |
| capability lease/revision | product control authority | Psyche lease | adapt exact scope, subject, resource, revision, expiry, revocation |
| approval | guarded action decision | Psyche approval | bind request payload digest, decision, actor, expiry, invalidation |
| `ActionReceipt` | product action status/evidence | Psyche action/receipt | map states and evidence; preserve unknown/recovery semantics |
| journal entry | local durability/idempotency | protocol record/transition evidence | retain local store behind canonical record adapter |
| `completed/partial/failed` | task summary | derived aggregate | compute from canonical lane/attempt/receipt states |
| `effect_unknown` | fail-closed result | unknown/recovery-required | preserve; never collapse to failed or succeeded without reconciliation |
| owner epoch/generation | stale-owner/resource fencing | lease/resource revision | map explicitly; retain stronger local fencing where needed |
| Bead/GitHub issue | planning and acceptance | external planning reference | metadata only |

## Known semantic gaps

The adapter design must resolve, not paper over:

1. **Caller-supplied task identity.** Current normalization proves shape, not canonical issuance or ownership.
2. **Operation versus attempt/action identity.** Current `operationId` combines idempotency and correlation; the Psyche profile may separate request, attempt, action, and receipt.
3. **Aggregate terminal states.** `completed/partial/failed` is insufficient to represent pending approval, cancellation acknowledgement, unresolved termination, unknown effect, or recovery required without the underlying records.
4. **Receipt authority.** `psyche.control.receipt/v1` is a product-local schema today; successful serialization does not establish protocol conformance.
5. **Lease ownership.** Product leases must map subject, project, resource, capabilities, revision, expiry, revocation, and renewal without widening.
6. **Persistence.** Journal durability must preserve append-only canonical transitions and restart behavior; local overwrite/compaction cannot erase protocol evidence.
7. **Cross-device continuity.** Host, endpoint, Bonjour, secure-store, and UI state may change while protocol identity remains stable.
8. **Threads and familiar identity.** These must be referenced from their canonical owners rather than recreated inside either repository.
9. **Artifact binding.** Worktree/path/branch references require immutable source/artifact correlation for portable evidence.
10. **Version negotiation.** Current local schema/version strings need an explicit released-profile negotiation and downgrade policy.

## Target adapter boundary

The eventual implementation should isolate the external protocol behind one bounded package, tentatively:

```text
src/protocol/psyche/
  profile.ts              # immutable profile pin and digest verification
  generated/              # generated types/schemas; never hand-edited
  codec.ts                # canonical encode/decode and structured denial
  mapping.ts              # product-local ↔ protocol mapping
  conformance.ts          # bounded canary runner integration
  migration.ts            # reversible persistence compatibility
```

Existing `src/orchestration/**` and `src/control/**` should depend on the adapter interface, not copied Psyche schema fragments. The final path is subject to the decomposition plan in #197 and ownership decision in `OpenCoven/psyche#12`.

## Delivery sequence

### Stage 0 — freeze and inventory

- catalogue every current identity, record, transition, error, and persisted field;
- identify all producers, consumers, fixtures, and migrations;
- classify product-local state versus candidate protocol state;
- record current exact behavior and support dependencies;
- approve this mapping before code adoption.

**Exit:** no current field or transition is being migrated by assumption.

### Stage 1 — immutable profile pin

After `OpenCoven/psyche#11` publishes a consumer artifact:

- add an explicit lock file containing profile version, source SHA, artifact URL/identifier, digest, and supported features;
- verify the artifact before generation or tests;
- prohibit floating branch references;
- fail closed on digest mismatch, unknown major, or unsupported profile.

**Exit:** the same immutable profile is used locally and in CI.

### Stage 2 — compatibility canary

Run at minimum:

| Class | Required proof |
|---|---|
| Negotiation | supported profile/capabilities accepted; unsupported/widened profile denied |
| Identity | task/lane/attempt/action/receipt correlations round-trip without collision or rebinding |
| Authority | missing, expired, revoked, wrong-subject/project/resource/revision lease denied |
| Approval | payload mismatch, expiry, stale decision, and replay denied |
| Idempotency | exact replay is stable; changed replay conflicts |
| Ambiguity | unknown effect remains fenced until reconciliation |
| Cancellation | acknowledgement and unresolved termination retain evidence |
| Restart | committed state survives; uncommitted/ambiguous state is not invented |
| Versioning | unknown major/enum/kind fails closed; supported minor behavior is explicit |
| Artifacts | digest, size, media type, and lifetime mismatch denied |
| Downgrade | unsupported state is rejected or safely degraded without authority widening |

The runner must emit bounded machine-readable evidence and use no production credentials.

### Stage 3 — dual identity and compatibility reads

- introduce canonical Psyche IDs alongside local IDs;
- persist explicit one-to-one bindings;
- preserve old reads and current UI behavior;
- prevent rebinding/forking;
- make migrations idempotent and reversible;
- do not remove product-local aliases yet.

**Exit:** restart and rollback preserve one identity graph.

### Stage 4 — lifecycle adapters

Migrate one bounded lifecycle per PR, in this order unless the owning issues approve otherwise:

1. task/lane/attempt identity;
2. lease and capability scope;
3. approval request/resolution;
4. action and receipt;
5. cancellation/unknown/recovery;
6. artifact and delivery;
7. cross-device observation/resume.

Each slice preserves current product behavior and carries positive, denial, restart, and rollback evidence.

### Stage 5 — reference flow and graduation

Prove:

```text
desktop task
  → isolated lane/worktree
  → agent execution and evidence
  → guarded consequential action
  → approval and canonical receipt
  → host/app restart or disconnect
  → same protocol identity resumes
  → artifact/delivery remains correlated
```

Extend the same identity to iOS observation/approval only after #200's atomic readiness, physical same-LAN, reconnect, revocation, and distributed-build gates are satisfied.

**Exit:** #253, #201, and `OpenCoven/psyche#13` link the immutable profile, exact-head canary, migration/rollback, and reference-flow evidence.

## Sequencing with the active roadmap

- This work does not replace `docs/POST-RELEASE-EXECUTION.md`.
- Mapping/design may proceed during stabilization.
- Protocol pinning waits for `OpenCoven/psyche#11`.
- Ownership-sensitive implementation waits for `OpenCoven/psyche#12`.
- Adapter implementation must not become an undeclared blocker for #196, #199, or #200.
- #197 decomposition should expose stable seams consumed by this adapter, not create another composition root.
- Existing PRs #190, #192, and #193 remain source material under their current disposition.

## Completion rules

No conformance claim from:

- matching names;
- copied TypeScript/Rust structures;
- schema decode alone;
- unit-test counts;
- a floating main-branch dependency;
- screenshots;
- a successful UI path without retained authority/receipt evidence.

A conformance claim requires the immutable profile, digest verification, exact-head positive/negative canary, migration/rollback proof, and linked reference-flow evidence.
