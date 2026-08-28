# Psyche consumer mapping and conformance plan

**Status:** active current-state mapping; no conformance claim  
**Last reconciled:** 2026-08-28  
**Psyche Build owner:** [#253](https://github.com/OpenCoven/psyche-build/issues/253)  
**Parent architecture outcome:** [#201](https://github.com/OpenCoven/psyche-build/issues/201)  
**Repository readiness:** [#252](https://github.com/OpenCoven/psyche-build/issues/252)  
**Psyche roadmap:** [OpenCoven/psyche#9](https://github.com/OpenCoven/psyche/issues/9)  
**Protocol publication:** [OpenCoven/psyche#11](https://github.com/OpenCoven/psyche/issues/11)  
**Ownership decision:** [OpenCoven/psyche#12](https://github.com/OpenCoven/psyche/issues/12)  
**Reference-client mirror:** [OpenCoven/psyche#13](https://github.com/OpenCoven/psyche/issues/13)

Psyche Build is the coding cockpit and product UI. Psyche is the target canonical orchestration protocol. Familiar Contract, the Familiar Continuity Profile (SPAR), Coven Threads, and Coven remain the canonical identity, continuity, authorization, mutation, runtime, and persistence layers around that protocol.

This document maps current Psyche Build behavior into that stack without a big-bang rewrite, identity fork, support regression, or false conformance claim.

## Evidence boundary

The repository already contains mature product-local orchestration and control contracts. Names beginning with `psyche.*`, identifiers beginning with `orch-*`, and records that resemble future protocol objects do not make those records part of the public `OpenCoven/psyche` protocol.

Psyche Build may claim a bounded Psyche consumer profile only after it:

1. pins an immutable released Psyche artifact and consumer-profile version;
2. verifies source, artifact, schema, and fixture digests;
3. passes the profile's positive, denial, restart, ambiguity, and downgrade vectors on the exact head;
4. maps product-local state through a reviewed adapter without widening authority;
5. retains migration, rollback, reconnect, and restart evidence; and
6. names the exact conformance profile rather than using an unqualified “compliant” claim.

Until then, this is a current-state mapping and migration contract, not shipped protocol support.

## Canonical architecture boundary

The intended ownership chain is:

```text
Familiar Contract
  governed familiar self and stable familiar root
        │
        ▼
Familiar Continuity Profile (SPAR)
  authorized revisions, historical continuity, embodiment lineage
        │
        ▼
Coven Threads
  protected-surface authorization decision
        │
        ▼
Psyche
  task, graph, lane, delegation, attempt, approval, receipt, recovery
        │
        ▼
Coven
  daemon, session, runtime execution, persistence, committed mutation
        │
        ▼
Psyche Build
  coding cockpit, worktree/tmux resources, adapter, product UI, evidence
```

Psyche snapshots authorized familiar identity into orchestration. It does not create, redefine, or authenticate the familiar root. Psyche Build projects that snapshot and Psyche lifecycle into product behavior; it does not infer either from a pane, process, branch, worktree, provider session, tracker, prompt, or UI selection.

### Three objects that must remain distinct

| Object | Canonical purpose | Minimum binding | Must not collapse into |
|---|---|---|---|
| Familiar identity snapshot | Prove which governed familiar revision entered work | stable `familiar_root_id`, exact identity revision/digest, principal/authorization reference, continuity profile/version | task text, tracker ID, local agent name, provider session |
| Psyche execution correlation | Own orchestration lifecycle and causality | task/graph/lane/delegation/action/approval/receipt/recovery IDs and versions | runtime process/session identity |
| Execution attempt / runtime embodiment | Record one concrete execution of the snapshot | attempt ID, runtime/session reference, host/resource generation, familiar root/revision pin | familiar identity or durable task identity |

A future schema named `psyche.execution_binding.v1` must not ship until the ownership decision resolves which of these objects it represents. One record may reference all three, but it must not make them semantically interchangeable.

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

The current inventory does not prove that every direct or orchestrated session pins a canonical familiar root and exact identity revision. That remains an explicit migration and conformance gap.

## Target ownership

| Concern | Canonical owner | Psyche Build role |
|---|---|---|
| Familiar root and governed self | Familiar Contract | consume stable root and exact authorized revision; never issue or redefine it |
| Historical/computational continuity | Familiar Continuity Profile (SPAR) | surface revision, provenance, staleness, and embodiment status |
| Principal authentication and protected change | Familiar Contract profile + Threads/Coven enforcement | carry verifiable references; never treat a configured person/name as authorization |
| Protected-surface authorization | Coven Threads | carry and enforce the approved decision and constraints |
| Task/graph/lane/delegation/attempt/delivery identity | Psyche | implement a versioned consumer adapter |
| Lease/approval/receipt/cancellation/recovery semantics | Psyche | project canonical state into product control and UI |
| Daemon/session/runtime/persistence authority | Coven | reference through a typed backend; preserve exact identity embodiment binding |
| Pane/tmux/worktree/branch/provider state | Psyche Build | remain replaceable product-local execution locators |
| Human UI and interaction state | Psyche Build | display/request canonical state; never invent authority |
| Beads/GitHub planning | Beads/GitHub | planning references only, never runtime identity or delivery proof |

The cross-repository decision in `OpenCoven/psyche#12` remains the normative gate when approved. This table is a constrained working baseline, not an attempt to preempt that ADR.

## Mapping matrix

| Current Psyche Build concept | Current role | Target concept | Migration disposition |
|---|---|---|---|
| `taskId` | caller/product task correlation | Psyche task ID | validate/map; do not trust arbitrary strings as canonical issuance or authority |
| `traceId` | observability correlation | trace/causality metadata | retain as non-authoritative metadata |
| `operationId` / `orch-op-v1-*` | idempotent operation identity | request/action correlation | retain as alias or derive from canonical request; never substitute silently |
| lane request `id` | product lane key | Psyche lane ID | dual-ID migration with one-to-one binding |
| missing familiar root/revision pin | no universal canonical identity snapshot | familiar identity snapshot | add exact root/revision/digest and authorization references before claiming embodiment |
| actor/configured person text | product-local actor metadata | authenticated principal reference | replace or map to stable opaque principal ID and operation-specific authorization evidence |
| pane/session ID | execution resource locator | runtime/session reference | reference only; not task, lane, attempt, or familiar identity |
| tmux pane/session | process transport | runtime handle | local, replaceable, and fenced by generation |
| worktree path/branch/commit | isolated code resource/evidence | artifact/snapshot/source reference | bind by immutable digest/reference, not path alone |
| capability lease/revision | product control authority | Psyche lease | adapt exact subject, project, resource, capabilities, revision, expiry, and revocation |
| approval | guarded action decision | Psyche approval | bind request payload digest, decision, actor/principal reference, expiry, and invalidation |
| `ActionReceipt` | product action status/evidence | Psyche action/receipt | map states and evidence; preserve unknown/recovery semantics |
| journal entry | local durability/idempotency | canonical transition evidence | retain local store behind versioned adapter; do not erase committed history |
| `completed/partial/failed` | task summary | derived aggregate | compute from canonical lane/attempt/approval/receipt/recovery state |
| `effect_unknown` | fail-closed result | unknown/recovery-required | preserve and fence until reconciliation |
| owner epoch/generation | stale-owner/resource fencing | lease/resource revision | map explicitly; retain stronger local fencing where needed |
| direct Coven launch | runtime path outside Psyche | embodiment binding plus optional Psyche correlation | still pin exact familiar root/revision; do not require Psyche merely to prove identity |
| Bead/GitHub issue | planning and acceptance | external planning reference | metadata only; never runtime identity or completion proof |

## Known semantic gaps

The adapter design must resolve, not paper over:

1. **Caller-supplied task identity.** Current normalization proves shape, not canonical issuance, ownership, or authorization.
2. **Missing universal familiar embodiment binding.** Every session claiming a familiar must pin the exact familiar root and identity revision, including direct Coven launches.
3. **Principal authentication.** A configured person/name or actor string is not authorization; protected changes require a stable principal reference and verifiable operation-specific authorization.
4. **Execution-binding collision.** Familiar identity binding, Psyche execution correlation, and execution-attempt lifecycle are separate objects and must not share an ambiguous schema.
5. **Operation versus attempt/action identity.** Current `operationId` combines idempotency and correlation; the Psyche profile may separate request, attempt, action, and receipt.
6. **Aggregate terminal states.** `completed/partial/failed` cannot represent pending approval, cancellation acknowledgement, unresolved termination, unknown effect, or recovery required without underlying records.
7. **Receipt authority.** `psyche.control.receipt/v1` is a product-local schema today; successful serialization does not establish canonical receipt authority or protocol conformance.
8. **Lease ownership.** Product leases must map subject, project, resource, capabilities, revision, expiry, revocation, and renewal without widening.
9. **Persistence and atomic commit.** Journal durability must preserve canonical transitions and prove that final authorization verification and committed mutation refer to the same immutable snapshot/transaction.
10. **Cross-device continuity and staleness.** Host, endpoint, Bonjour, secure-store, and UI state may change while identity remains stable; clients must distinguish fresh, stale, reconciling, degraded, and unavailable state.
11. **Identity and continuity ownership.** Familiar Contract and the Continuity Profile must be referenced, not recreated inside Psyche or Psyche Build.
12. **Artifact binding.** Worktree/path/branch references require immutable source/artifact correlation for portable evidence.
13. **Version negotiation and conformance profile.** Local schema strings need a released profile, explicit downgrade behavior, and a scoped conformance claim.

## Target adapter boundary

The eventual implementation should isolate the external protocol behind one bounded package, tentatively:

```text
src/protocol/psyche/
  profile.ts              # immutable profile pin and digest verification
  generated/              # generated types/schemas; never hand-edited
  codec.ts                # canonical encode/decode and structured denial
  identitySnapshot.ts     # exact familiar root/revision and authority references
  mapping.ts              # product-local ↔ protocol mapping
  conformance.ts          # bounded canary runner integration
  migration.ts            # reversible persistence compatibility
```

Existing `src/orchestration/**` and `src/control/**` should depend on the adapter interface, not copied Psyche, Familiar Contract, SPAR, or Threads schema fragments. The final path is subject to the decomposition plan in #197 and ownership decision in `OpenCoven/psyche#12`.

## Delivery sequence

### Stage 0 — freeze, inventory, and approve the map

- catalogue every current identity, record, transition, error, and persisted field;
- identify all producers, consumers, fixtures, migrations, and direct Coven launch paths;
- classify product-local state, canonical references, adapters, gaps, and intentional non-protocol state;
- identify authority currently inferred from caller text, UI/process state, trackers, or provider-local IDs;
- record current exact behavior and support dependencies;
- approve this mapping before code adoption.

**Exit:** no field or transition is migrated by naming similarity or assumption.

### Stage 1 — ownership and publication gates

Before implementation that claims canonical meaning:

- approve `OpenCoven/psyche#12` or a successor ownership ADR;
- publish the immutable Psyche schemas, vectors, compatibility policy, and standalone runner in `OpenCoven/psyche#11`;
- resolve the execution-binding semantic collision;
- identify the Familiar Contract and Continuity Profile artifacts that Psyche may reference;
- define which conformance profile Psyche Build intends to claim.

**Exit:** every durable ID and consequential transition has one canonical owner and an acyclic release order.

### Stage 2 — immutable profile pin

After Psyche publishes a consumer artifact:

- add an explicit lock file containing profile version, source SHA, artifact identifier, digest, and supported features;
- verify the artifact before generation or tests;
- prohibit floating branch references;
- fail closed on digest mismatch, unknown major, unsupported profile, or authority-widening change.

**Exit:** local development and CI consume the same immutable profile.

### Stage 3 — compatibility canary

Run at minimum:

| Class | Required proof |
|---|---|
| Negotiation | supported profile accepted; unsupported/widened profile denied |
| Identity snapshot | exact familiar root/revision retained; mismatch, stale revision, or unauthorized binding denied |
| Correlation | task/lane/delegation/attempt/action/receipt correlations round-trip without collision or rebinding |
| Authority | missing, expired, revoked, wrong-principal/subject/project/resource/revision lease denied |
| Approval | payload mismatch, expiry, stale decision, and replay denied |
| Idempotency | exact replay is stable; changed replay conflicts |
| Ambiguity | unknown effect remains fenced until reconciliation |
| Cancellation | acknowledgement and unresolved termination retain evidence |
| Restart | committed state survives; uncommitted or ambiguous state is not invented |
| Continuity | reconnect preserves root/revision while staleness is explicit |
| Versioning | unknown major/enum/kind fails closed; supported minor behavior is explicit |
| Artifacts | digest, size, media type, and lifetime mismatch denied |
| Downgrade | unsupported state is rejected or safely degraded without authority widening |

The runner must emit bounded machine-readable evidence and use no production credentials.

### Stage 4 — identity snapshot and dual-ID compatibility

- introduce canonical Psyche IDs alongside local IDs;
- persist explicit one-to-one bindings and prevent rebinding/forking;
- snapshot exact familiar root/revision and verifiable authorization references into each orchestrated execution;
- preserve old reads and current UI behavior;
- make migrations idempotent and reversible;
- do not remove product-local aliases yet.

**Exit:** restart and rollback preserve one identity graph, and a runtime embodiment cannot silently switch familiar revision.

### Stage 5 — lifecycle adapters

Migrate one bounded lifecycle per PR, in this order unless the owning issues approve otherwise:

1. task/lane/delegation/attempt identity;
2. lease and capability scope;
3. approval request/resolution;
4. action and receipt;
5. cancellation/unknown/recovery;
6. artifact and delivery;
7. cross-device observation/resume.

Each slice preserves current product behavior and carries positive, denial, restart, rollback, and authority evidence.

### Stage 6 — reference flow and graduation

Prove:

```text
authorized principal selects an exact familiar root/revision
  → Psyche snapshots that identity into a canonical task
  → Psyche Build opens an isolated lane/worktree
  → one runtime attempt embodies the same root/revision
  → agent execution produces bounded evidence
  → consequential action is authorized/approved
  → canonical receipt commits
  → host/app restarts or disconnects
  → same familiar revision and Psyche identity resume
  → artifact/delivery remains correlated
```

Extend the same identity to iOS observation/approval only after #200's atomic readiness, physical same-LAN, reconnect, revocation, and distributed-build gates are satisfied. A direct Coven launch must also prove the exact familiar embodiment even when it has no Psyche task.

**Exit:** #253, #201, and `OpenCoven/psyche#13` link the immutable profile, identity snapshot, exact-head canary, migration/rollback, and reference-flow evidence.

## Sequencing with the active roadmap

- This work does not replace `docs/POST-RELEASE-EXECUTION.md`.
- Mapping and review may proceed during stabilization.
- Protocol pinning waits for `OpenCoven/psyche#11`.
- Ownership-sensitive implementation waits for `OpenCoven/psyche#12`.
- Adapter implementation must not become an undeclared blocker for #196, #199, or #200.
- #197 decomposition should expose stable seams consumed by this adapter, not create another composition root.
- Existing PRs #190, #192, and #193 remain source material under their current disposition.
- #258 owns the root agent/repository contract; this document must not duplicate its files or verification entrypoints.

## Completion rules

No conformance claim from:

- matching names;
- copied TypeScript or Rust structures;
- schema decode alone;
- unit-test counts;
- a floating main-branch dependency;
- screenshots;
- a successful UI path without retained identity, authority, and receipt evidence;
- a session that cannot prove its exact familiar root/revision;
- a generic “compliant” label without a named conformance profile.

A bounded conformance claim requires the immutable profile, digest verification, exact-head positive and negative canary, identity snapshot proof, migration/rollback evidence, and linked reference-flow receipt chain.
