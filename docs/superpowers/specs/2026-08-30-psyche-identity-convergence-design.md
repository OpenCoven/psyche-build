# Psyche identity convergence design

Date: 2026-08-30
Status: Design record for [#201](https://github.com/OpenCoven/psyche-build/issues/201) — recommendation only. This is **not** an approved architecture, **not** a protocol-conformance claim, and **not** an executable backlog. Dated records under `docs/superpowers/` are design history by default; see `docs/superpowers/README.md`.
Companion current-state mapping: [`docs/PSYCHE-COMPATIBILITY-MAP.md`](../../PSYCHE-COMPATIBILITY-MAP.md) (merged via PR #262)
Delivery plan: [#253](https://github.com/OpenCoven/psyche-build/issues/253)

## Purpose

Issue #201 asks for the post-stabilization path from a multi-lane coding cockpit to an identity-preserving OpenCoven cockpit without coupling durable identity, orchestration truth, or runtime authority to Beads, tmux panes, a provider session, UI state, or any single persistence implementation.

This record turns that outcome into a concrete design: the three required objects, a reference catalog with exactly one canonical owner per durable identity, the binding envelope that links them without collapsing them, state machines, schema sketches (JSON Schema drafts plus the compile-checked TypeScript module), the bounded durable-state adapter, version negotiation, and an incremental migration with per-step evidence. It cites the current code path behind every claim about existing behavior.

**What this document is not.** It is not the approved ownership/compatibility ADR (blocked on `OpenCoven/psyche#12`), not an immutable Psyche consumer profile (blocked on `OpenCoven/psyche#11`), and not a conformance claim. Per [`AGENTS.md`](../../../AGENTS.md), Psyche Build must not claim Psyche protocol conformance until a released profile is pinned and canaried (#253). Every type name below is a recommendation to be ratified — or renamed — by `OpenCoven/psyche`. The compile-checked design types live in [`src/protocol/identityConvergenceDesign.ts`](../../../src/protocol/identityConvergenceDesign.ts), which is deliberately inert: no product code imports it, and `__tests__/protocolIdentityDesign.test.ts` enforces that boundary.

## Non-goals (unchanged from the issue)

- A framework or whole-product rewrite.
- A shared canonical database.
- A plugin marketplace before contracts stabilize.
- Cloud/team collaboration as a prerequisite.
- Making convergence an undeclared blocker for already-supported macOS operation.
- Rebranding current terminal activity, local `psyche.*` schemas, or `orch-*` identifiers as canonical protocol truth.
- Letting Threads, Psyche, Coven, or Psyche Build absorb another layer's canonical ownership for convenience.

A specific consequence of the last point: the domain strings and id prefixes that already exist in this repository — `psyche.orchestration.operation.v1`, `orch-op-v1-*`, `orch-lane-v1-*` and siblings in `src/orchestration/operationIdentity.ts` — are **product-local** derivation domains and id prefixes. This design proposes protocol-owned references alongside them (Seam A of the compatibility map); it does not rebrand them as canonical truth.

## Working ownership baseline

Restated from the issue, annotated with where each responsibility lives today:

| Domain | Canonical owner | Psyche Build role | Where Build touches it today |
|---|---|---|---|
| Familiar root and governed self | Familiar Contract | consume exact root and authorized revision | none yet — Build has no familiar representation at all (no `familiar` symbols in `src/`); the design introduces the consuming types only |
| Historical/computational continuity | Familiar Continuity Profile/SPAR | surface provenance, embodiment, staleness, and revision status | none yet; staleness surfaces exist for resources, not identity (`src/control/surfaces.ts` generations) |
| Protected-surface authorization | Coven Threads | carry and enforce the approved decision and constraints | Build keeps decision *references* (`oc.authz.*` proposed); current local analog is the approval record (`src/control/approvals.ts`) |
| Task/graph/lane/delegation/attempt/approval/receipt/recovery lifecycle | Psyche | implement a pinned, versioned consumer adapter | current product-local orchestration: `src/orchestration/`, control plane `src/control/runtime.ts` |
| Daemon/session/runtime/persistence and committed mutation | Coven | reference through typed runtime/backend contracts | `src/daemon/`, `src/orchestration/covenSessionBackend.ts`, `src/orchestration/adapters.ts` |
| Pane/tmux/worktree/branch/provider and product UI state | Psyche Build | remain replaceable execution locators and projections | `src/control/surfaces.ts`, `src/orchestration/localPaneBackend.ts`, `src/orchestration/bridgePaneBackend.ts` |

Threads does not become a second orchestration lifecycle owner. Psyche does not create familiar identity or replace Coven runtime authority. Psyche Build does not infer canonical truth from visible product activity. These constraints are already stated by `agent/manifest.yaml` (`excludes:` list) and [AGENTS.md](../../../AGENTS.md); this design keeps them.

## The three required objects

The issue requires that an ambiguous `psyche.execution_binding.v1` (or equivalent) must not collapse three objects that stay distinct even when one record references all three. The design models them as three record kinds plus a linking envelope:

1. **Familiar identity snapshot** — `FamiliarIdentitySnapshot` (`psyche.identity.snapshot.v1`). Stable familiar root, exact authorized identity revision and its content digest, stable principal reference, and Threads authorization decision references. Immutable once captured; a new authorization creates a new revision.
2. **Psyche execution correlation** — `PsycheExecutionCorrelation` — canonical task, graph, lane, delegation, action, approval, receipt, cancellation, and recovery identities. Psyche-owned; Build projects it and never invents its members.
3. **Execution attempt / runtime embodiment** — `ExecutionAttempt`. One concrete attempt with its runtime/session reference, host, device, resource generation, and the exact familiar revision it embodies.

The binding envelope `ExecutionBindingV1` (`psyche.execution.binding.v1`) is the record that references all three at once. It is deliberately **not** a merged lifecycle record: it carries exactly three digest-addressed members (identity facts, the correlation root task id, and the attempt facts) and no lifecycle state of its own, so there is nothing to collapse into. Its digest derivation is a domain-separated, length-prefixed tuple digest — the same pattern the product already uses for idempotency/correlation keys in `src/orchestration/operationIdentity.ts` (`tupleDigest`, domains like `psyche.orchestration.operation.v1`).

The three golden records in `src/protocol/identityConvergenceDesign.ts` (`goldenFamiliarIdentitySnapshot`, `goldenExecutionCorrelation`, `goldenExecutionAttempt`, plus `goldenExecutionBinding`) are compiled proof that the shapes stay distinct; the boundary test asserts the envelope JSON never embeds the correlation record.

## Reference catalog

Exactly one canonical owner per durable reference. "Build representation today" cites the current field or file; "transition rule" is the migration rule from [PSYCHE-COMPATIBILITY-MAP.md](../../PSYCHE-COMPATIBILITY-MAP.md).

| Reference | Canonical owner | Minted by | Current Build representation | Transition rule |
|---|---|---|---|---|
| Familiar root (`oc.famroot.*`) | Familiar Contract | Familiar Contract | none — Build has no familiar concept | consume exact root as immutable snapshot; never synthesize |
| Identity revision (`oc.famrev.*` / revision + digest) | Familiar Contract | Familiar Contract | none | snapshot digest is the only embodiment proof |
| Principal (`oc.principal.*`) | Coven Threads (with Familiar Contract) | Threads | `ControlPrincipal` in `src/control/credentials.ts` (`operator`/`agent`/`compatibility` kinds) is a **local** transport principal, not canonical | map verified Psyche/Threads principal into local `ControlPrincipal`; a configured name or actor string is not authorization |
| Authorization decision (`oc.authz.*`) | Coven Threads | Threads | `Approval` records in `src/control/approvals.ts` (intent-bound, consume-once) | Threads constrains Psyche actions; Build translates a verified decision into the exact local assertion |
| Project (`oc.project.*`) | Psyche | Psyche | canonicalized project root path — `canonicalizeProjectRoot()` in `src/control/projectIdentity.ts` (realpath + NFC); owner lock, journal path, endpoint hash all derive from it | keep the canonical root as a **local lookup key**; a `ProjectRef` is protocol identity; the two are joined, not equated |
| Graph (`oc.graph.*`) | Psyche | Psyche | none (decomposition into lanes is local: `src/orchestration/planner.ts`) | introduced when Psyche profile lands; optional field |
| Task (`oc.task.*`) | Psyche | Psyche | caller-supplied `taskId` strings, normalized in `src/control/taskIdentity.ts` (≤256 chars, opaque) and bound into leases/approvals/credentials | protocol id rides alongside; mismatched caller-supplied correlation is rejected (mapping rule for "Task correlation") |
| Lane (`oc.lane.*`) | Psyche | Psyche | `OrchestrationLaneMode` + lane plans in `src/orchestration/types.ts`; `LaneLease` in `src/control/leases.ts` keyed by `paneId` | panes/worktrees stay projections; lane identity binds *to* them, never derives from them |
| Delegation (`oc.delegation.*`) | Psyche | Psyche | none as a durable object; transient handshakes (`pane.takeover`/`pane.delegate` special flows in `docs/CONTROL-PLANE.md`) | introduce with the Psyche adapter |
| Attempt (`oc.attempt.*`) | Psyche | Psyche | implicit: nonterminal command recovery in `src/control/runtime.ts`/`src/control/journal.ts` | one attempt per concrete execution; restart re-embodies, it does not renumber |
| Action (`oc.action.*`) | Psyche | Psyche | `actionId` + `idempotencyKey` in the control runtime | protocol id alongside local id; retries resolve to one effect or explicit `unknown` |
| Approval (`oc.approval.*`) | Psyche (verdict), Threads (decision authority) | Psyche | `ApprovalStatus` lifecycle in `src/control/approvals.ts` | never reduce to a boolean; preserve consume-once/expiry/denial/revocation |
| Artifact (`oc.artifact.*`) | Psyche (record), Coven (storage behind bounded contract) | producer of the content | none durable (screenshots/captures are transient today) | content-addressed records defined below |
| Receipt (`oc.receipt.*`) | Psyche, projected from Coven's authoritative result | Coven effect path via Build journal | `CommandOutcome` + exact sidecars (`src/control/journal.ts`, digest-verified compaction) | receipt projection only after the local effect is terminal and replayable (Seam C) |
| Runtime session (`oc.rtsession.*`) | Coven | Coven daemon | `ownerEpoch` + nonce from `src/control/ownerLock.ts`; connection ids in `src/daemon/index.ts` | a reference; never the task or familiar identity |
| Host (`oc.host.*`) | Coven | Coven host registration | implicit host/process identity (`src/services/ProcessIdentity.ts` via `src/control/credentials.ts`) | stable host id replaces pid/nonce as *reference*, not as fence |
| Device (`oc.device.*`) | Coven Threads (authorization) / Coven (registration) | Threads enrollment | none (iOS pairing exists at transport level: `src/services/bridge/PairingFlow.ts`, `src/services/bridge/TokenStore.ts`) | device refs authorize transport; they never derive identity |

**Rule for every row:** references are opaque, prefixed, globally unique strings minted once by the owning authority. They never encode, and are never derived from, a pane id, tmux session, filesystem path, worktree path, branch name, provider session id, Bead, GitHub issue, UI selection, process id, or transport handle. Current Build code is already careful to derive its *local* digests from authority tuples rather than display state (`src/orchestration/operationIdentity.ts` digests over `operationId`/`laneId`/connection ids); the convergence generalizes that discipline across repositories.

## Binding envelope: linking without collapsing

`ExecutionBindingV1` is the one record that references all three objects. The issue's warning — an ambiguous `psyche.execution_binding.v1` (or equivalent) must not collapse these objects — is honored structurally, so the envelope cannot collapse them:

1. **Object 1 is immutable and digest-addressed.** The envelope carries only the identity triple (root, revision, digest) of the snapshot — never the mutable authorization set. Changing authorization produces a new snapshot revision, hence a new envelope.
2. **Object 2 is referenced by its root only.** The envelope carries the canonical `task` ref and nothing else of the correlation set. Lanes, delegations, actions, approvals, receipts, cancellation, and recovery hang off the task in Psyche's own records (`PsycheExecutionCorrelation` is a *projection* with `observedAt`, proving staleness instead of implying freshness).
3. **Object 3 carries the embodiment proof.** `attempt.embodiedDigest` must equal `identity.digest`; a mismatch is a fail-closed rejection, not a coercion.
4. **The envelope has no lifecycle state.** Its digest (`deriveExecutionBindingDigest`, domain-separated over every member field — same pattern as `src/orchestration/operationIdentity.ts`) changes if any member is substituted, which is what the negative canary "stale correlation" vector will detect.

Golden envelope (rendered from the compile-checked constants; JSON Schema draft follows):

```json
{
  "object": "psyche.execution.binding.v1",
  "binding": "oc.binding.01JGQP3G9M8B726S5G473Y2N1C",
  "identity": {
    "familiarRoot": "oc.famroot.01JGQP3F7Z4MJVWJ9Q6Y5N8A2C",
    "revision": 17,
    "digest": "sha256:1d2f30c4a5b6978e8f0a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f7"
  },
  "correlation": { "task": "oc.task.01JGQP3G3A211R0FZ6YXXMWBV2" },
  "attempt": {
    "attempt": "oc.attempt.01JGQP3GMH3RJZ16GDZMEVX2C9",
    "runtimeSession": "oc.rtsession.01JGQP3GVJT9S0RQQEP5NWMKKA",
    "host": "oc.host.01JGQP3G2KHT01F8YFDPWXB4TB",
    "resourceGeneration": 3,
    "embodiedDigest": "sha256:1d2f30c4a5b6978e8f0a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f7"
  },
  "profile": "psyche.consumer.desktop-cockpit.v1",
  "schemaMajor": 1
}
```

### JSON Schema drafts (design proposal)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://opencoven.dev/schemas/psyche/execution-binding-v1.schema.json",
  "title": "psyche.execution.binding.v1",
  "type": "object",
  "additionalProperties": false,
  "required": ["object", "binding", "identity", "correlation", "attempt", "profile", "schemaMajor"],
  "properties": {
    "object": { "const": "psyche.execution.binding.v1" },
    "binding": { "type": "string", "pattern": "^oc\\.binding\\.[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$" },
    "identity": {
      "type": "object",
      "additionalProperties": false,
      "required": ["familiarRoot", "revision", "digest"],
      "properties": {
        "familiarRoot": { "type": "string", "pattern": "^oc\\.famroot\\.[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$" },
        "revision": { "type": "integer", "minimum": 1 },
        "digest": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" }
      }
    },
    "correlation": {
      "type": "object",
      "additionalProperties": false,
      "required": ["task"],
      "properties": { "task": { "type": "string", "pattern": "^oc\\.task\\.[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$" } }
    },
    "attempt": {
      "type": "object",
      "additionalProperties": false,
      "required": ["attempt", "runtimeSession", "host", "resourceGeneration", "embodiedDigest"],
      "properties": {
        "attempt": { "type": "string", "pattern": "^oc\\.attempt\\.[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$" },
        "runtimeSession": { "type": "string", "pattern": "^oc\\.rtsession\\.[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$" },
        "host": { "type": "string", "pattern": "^oc\\.host\\.[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$" },
        "resourceGeneration": { "type": "integer", "minimum": 0 },
        "embodiedDigest": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" }
      }
    },
    "profile": { "type": "string", "minLength": 1 },
    "schemaMajor": { "type": "integer", "minimum": 1 }
  }
}
```

The schema is intentionally minimal and total (`additionalProperties: false`): unknown fields are a schema-version decision owned by `OpenCoven/psyche#11`, and the compatibility map already forbids guessing unknown-field behavior locally. The three members are structurally distinct types — a consumer cannot flatten the envelope into one merged record without losing the discriminator and the digest chain.

## How identity enters without being redefined

- **Familiar Contract / SPAR → Psyche.** The familiar root and its authorized revision are produced by the Familiar Contract; SPAR carries continuity/provenance. Psyche stores an *immutable snapshot* of that revision (Object 1) and re-publishes it by digest. Psyche Build never reconstructs identity from product activity — it can only consume the snapshot. There is no familiar code in Build today (`grep -ri familiar src/` is empty), so the snapshot enters through the pinned Psyche profile as data, not as re-modeled local types.
- **Every session pins the snapshot.** Whether a session comes from Psyche orchestration or a direct Coven launch outside it, the binding envelope records the exact root/revision/digest embodied. In current code the analogous pin already exists for *project* identity: `canonicalizeProjectRoot()` (`src/control/projectIdentity.ts`) resolves symlink aliases to one canonical root and `createHostControlPlane` derives every downstream key from it (`docs/CONTROL-PLANE.md`); the convergence generalizes "pin the exact root" into "pin the exact familiar revision".
- **Principal is not a name.** A configured person/name or actor string is not authorization. Build's current `ControlPrincipal { id, kind, capabilities }` (`src/control/credentials.ts`) plus task-bound credentials (`ControlTaskBinding { taskId, subjectId }`) is the local enforcement shape; the canonical principal lives in Threads/Familiar Contract and is carried by reference (`oc.principal.*`).

## Threads authorization without lifecycle duplication

- Threads owns protected-surface authorization decisions. Psyche Build **carries and enforces** the approved decision; it does not create a second orchestration lifecycle.
- The local enforcement path stays exactly what it is today: `CapabilityLease` binds actor/task/owner-epoch/revision/expiry/target/capability (`src/control/capabilityLeases.ts`), and `Approval` binds intent via effect + `executablePayloadDigest` with consume-once semantics (`src/control/approvals.ts`). A Threads decision enters as an `oc.authz.*` reference on the identity snapshot (Object 1) and may be translated — Seam B of the compatibility map — into the current exact local assertion. Translation failure, unknown enum/version, wider target, missing subject binding, stale correlation, digest mismatch, or downgrade request is a denial.
- Threads therefore constrains *what is allowed*; Psyche *correlates* the task/lane/attempt; Coven *executes*; Build *projects*. No layer absorbs another's ownership (the issue's "must not absorb another layer's canonical ownership for convenience").

## Coven runtime authority by reference

Coven remains authoritative for process/PTY execution, project-boundary enforcement, and authoritative runtime events. The design references that authority through typed contracts instead of absorbing it:

- `ExecutionAttempt.runtimeSession` references the daemon/runtime session; the attempt is not defined by it. Restart mints a new `resourceGeneration` (the current `ownerEpoch` analog from `src/control/ownerLock.ts`) and a new `oc.rtsession.*` while identity and correlation persist.
- The single-mutation-authority invariant (`docs/CONTROL-PLANE.md`: every mutation through `ControlRuntime`, journaled in `src/control/journal.ts`, effects only in `src/daemon/controlHandlers.ts`, enforced by `__tests__/daemon/controlAdapter.test.ts`) is never bypassed by an adapter: a Psyche adapter sits behind or alongside that boundary.
- Persistence providers (AgentFS or otherwise) implement `BoundedDurableStateAdapter` and stay replaceable; the control journal's digest-verified sidecar discipline (`src/control/journal.ts`) is the local precedent that adapter durability must meet, not replace.

## Execution locators vs canonical ids

Panes, browser tabs, provider sessions, tmux ids, worktrees, branches, Beads, GitHub issues, and app views **reference — never replace** — canonical ids. Today's code already treats them as fenced, replaceable locators:

- `src/control/surfaces.ts` — `SurfaceRegistry` generations fence stale pane/tab handles.
- `src/control/leases.ts` — `LaneLease { paneId, actorId, actorKind, taskId?, revision, expiresAt }`: pane-keyed lease with optional task correlation; the Psyche target binds the lane to Psyche instead of deriving lane identity from the pane (mapping rule "Lane surface").
- `src/orchestration/types.ts` — lanes are `isolated-worktree | shared-worktree | terminal | coven-session` *modes* with worktree refs; `src/orchestration/operationIdentity.ts` derives `orch-pane-v1-*` / `orch-lane-v1-*` keys from operation+lane tuples.
- Provider sessions and bridge sessions (`src/services/bridge/Session.ts`, `src/services/bridge/wireProtocol.ts`) are transport/embodiment metadata; `protocol-fixtures/` exists precisely because two hand-written implementations drift without a shared contract.
- Beads and GitHub remain planning/public-outcome surfaces (`docs/TRACKER-INTEGRITY.md`, `.beads/README.md`); tracker ids never become runtime identity.

Transition rule: each locator record gains optional, additive correlation fields (Seam A); conflicting caller-supplied correlation after binding is rejected; identity is never minted from a locator.

## Bounded durable-state adapter

Working context, provenance, artifacts, snapshots, serialization, migration, and rollback go through one bounded contract (`BoundedDurableStateAdapter` in the design module): named adapter, load/store with optimistic revision, bounded `migrate`, explicit `rollback`, and hard bounds (`maxRecordBytes`, `maxRecords`, `retentionDays`). Fail-closed reasons are enumerated (`unsupported-major`, `corrupt`, `bounded-capacity-exceeded`). This is the same shape of honesty as the control journal's bounded compaction with digest-verified sidecars (`src/control/journal.ts`): a provider may hold bytes, but identity and authority never migrate into it.

## Content-addressed artifacts and evidence

`ArtifactRecordV1` covers patches, commits, test results, research, plans, screenshots, builds, decisions, releases, and handoffs with a `sha256:` digest, byte length, media type, task/attempt/action provenance, and an explicit `redaction: 'exact' | 'redacted'` marker. The marker is the shape-level enforcement of the repository's protected-data rule (AGENTS.md: prefer bounded enumerated state, digests, and redaction manifests; fail closed when safety cannot be shown). The first canary receipt design in [PSYCHE-COMPATIBILITY-MAP.md](../../PSYCHE-COMPATIBILITY-MAP.md) (`consumerSha`, `artifactDigest`, positive/negative vectors) is the precedent; artifact records generalize it.

## Connection health

Clients expose `fresh`, then the disconnected set — stale, reconciling, degraded, and unavailable — instead of implying freshness. Every Build surface that renders Psyche state must render its observation time (`observedAt`) and health together, and iOS consumes the same enumeration (`native/ios/PsycheCore/Sources/PsycheCore/Protocol/BridgeMessages.swift` mirrors wire types; `protocol-fixtures/` keeps both honest).

## Cross-device continuity

Desktop and iOS preserve the same familiar revision and Psyche lifecycle across reconnect and transport changes:

1. The binding envelope — not the transport — carries identity. A desktop session binds `identity.digest` + `correlation.task` + `attempt`; an iOS client observing or approving the same lifecycle resolves the same task and approval refs from Psyche projections (`src/services/bridge/MobileControlGateway.ts` is today's mobile control path).
2. Device refs (`oc.device.*`) authorize transports (`src/services/bridge/PairingFlow.ts`, `src/services/bridge/TokenStore.ts`) but never derive identity: a reconnect with a new device ref resumes the same familiar revision and lifecycle, and a revoked device loses access without forking identity.
3. On reconnect, the client reconciles: `stale` → `reconciling` → `fresh`, or `degraded`/`unavailable` — never a silent "looks fine".

## Version negotiation, profiles, downgrade, fail-closed

- One **named conformance profile** per consumer class (proposal: `psyche.consumer.desktop-cockpit.v1` for Build). Claims always name the exact profile plus retained evidence — never a generic "compliant" label.
- `ProfileNegotiationV1` carries profile, major/minor, consumer identity and exact consumer revision, and an explicit `downgrade` capability flag.
- Fail closed on: unknown major, unknown profile, digest/pin mismatch, downgrade without explicit capability, unknown enum. These are exactly the negative vectors #253 requires the canary to run; the negotiation type exists so those vectors have a concrete target.
- The immutable pin itself is #253 slice 2 and waits for `OpenCoven/psyche#11`; nothing here floats on Psyche `main`.

## State machines

Attempt (one concrete execution):

```text
pending → embodied → running → terminating → succeeded
                    ↘ failed
                    ↘ unknown   (ambiguous terminal; recovery joins here, never re-executes)
```

`unknown` is terminal and honest — the current journal already models exactly this as `command.unknown` (reason `recovered-nonterminal`) and refuses to re-execute open transactions on restore (`docs/CONTROL-PLANE.md`, durability section).

Approval (mirrors `ApprovalStatus` in `src/control/approvals.ts`):

```text
pending → approved → consumed
        → denied
        → expired
        → revoked   (from approved, before consumption)
```

Receipt/outcome: exactly one terminal `succeeded | failed | denied | unknown` per action, derived from the authoritative effect path; duplicate retries resolve to the same receipt via idempotency (`src/control/runtime.ts` idempotency dedup + durable sidecar).

Connection health: `fresh → stale → reconciling → fresh | degraded | unavailable`; every non-`fresh` state is a statement that data is not current — never an implied freshness claim.

## Incremental migration (wrap first, replace later)

Additive and reversible until compatibility evidence proves equivalence; each step carries positive, denial, restart, downgrade, and rollback evidence:

| Step | Change | Evidence required before the next step |
|---|---|---|
| M0 | Freeze this design as recommendation; approve ownership/compatibility ADR (blocked on `OpenCoven/psyche#12`) | maintainer ADR approval |
| M1 | Additive correlation fields next to local ids in control/orchestration records (Seam A), adapter off | golden-record tests (this PR's boundary test is the seed); behavior unchanged |
| M2 | Immutable profile pin + offline canary (blocked on `OpenCoven/psyche#11`) | digest-verified artifact, positive + all negative vectors green on exact PR head |
| M3 | Correlation binding for one lifecycle (task → lane → attempt) behind existing interfaces | restart/reconnect and denial vectors; old persisted formats still readable |
| M4 | Receipt projection from the authoritative path only (Seam C) | duplicate/retry and ambiguity/fence vectors; unknown-outcome honesty |
| M5 | iOS observes/approves same lifecycle by reference (#200 readiness gates first) | cross-device reconnect evidence; downgrade vector |
| M6 | Retire duplicated local semantics only where canaries proved equivalence | rollback rehearsal; prior formats still readable |

Rollback contract per step: local records stay readable, new fields stay optional, disabling the adapter returns to the previous authority path without replaying effects, emitted receipts keep immutable provenance, and unverifiable protocol state is quarantined — never rewritten into a convenient local identity.

## Reference flow (the one flow every later claim extends)

1. **Authorized familiar revision** — user authorizes the familiar; Build consumes snapshot revision 17 with digest `sha256:1d2f…6f7` and principal `oc.principal.01JGQP3F7Z9KXW2M4N6P8R0T2V` plus a Threads decision `oc.authz.01JGQP3GW9BGTQ9YR57CPK5TM1`.
2. **Psyche task/lane/attempt** — a coding task is created: `oc.task.01JGQP3G3A211R0FZ6YXXMWBV2` with an isolated-worktree lane (mode from `src/orchestration/types.ts`) and attempt `oc.attempt.01JGQP3GMH3RJZ16GDZMEVX2C9` bound to runtime session `oc.rtsession.01JGQP3GVJT9S0RQQEP5NWMKKA` on host `oc.host.01JGQP3G2KHT01F8YFDPWXB4TB`; the pane that backs the lane remains a replaceable locator with its own generation (`src/control/surfaces.ts`).
3. **Guarded action + approval** — a consequential action is bound (action ref, lease revision, redacted effect, `executablePayloadDigest`), approved once, consumed once — today's exact semantics in `src/control/approvals.ts`.
4. **Artifact/receipt** — the effect terminates with a receipt (`outcome: 'succeeded'`, `effectDigest`, evidence artifact `oc.artifact.01JGQP3GGNZWE3XACHVRAZS68D`, redacted screenshot) — content-addressed, provenance-complete.
5. **Restart/reconnect** — the daemon restarts; resource generation increments, a new runtime session ref is minted, and the *same* identity resumes: same familiar digest, same task, same lane, new locators (`goldenRestartResume`). Ambiguity surfaces as `unknown`, never a minted replacement.
6. **iOS extension** — the iOS client observes the same task/approval refs through the bridge (wire fixtures shared with Swift via `protocol-fixtures/` and `native/ios/PsycheCore/Sources/PsycheCore/Protocol/BridgeMessages.swift`); approval state comes from Psyche records, never from transport or device state.

## Recommendations and alternatives (maintainer decisions)

These are genuinely maintainer/psyche-owner decisions; each is a recommendation with alternatives, not a decision.

- **R1 — Reference syntax.** Recommend prefixed opaque unique ids (`oc.<ns>.<26-char Crockford>`, ULID-compatible) minted by the owning authority. Alternatives: bare UUIDv7 (no namespace misuse signaling, no lexicographic sort in string form — ULID sorts); digest-derived ids (content-derived ids blur object identity with content identity and break when a record corrects non-semantic fields). Precedent for prefix discipline exists locally (`orch-op-v1-…` in `src/orchestration/operationIdentity.ts`), but those stay product-local per the non-goals.
- **R2 — Envelope shape.** Recommend the triple-member envelope (`ExecutionBindingV1`) with per-member digest coverage. Alternative considered: three fully separate records joined by a correlation table (more normalize, but Build then needs a join index before Psyche releases one — a local invention of exactly the kind the mapping forbids); and a flat single record (rejected: it is the collapse the issue forbids).
- **R3 — Where Build stores correlation.** Recommend the additive correlation fields of Seam A persisted transactionally beside existing durable recovery keys (journal sidecars), not inside `LaneLease`/`CapabilityLease` (those types stay exact; widening them is a later, canaried slice). Alternative: extend `LaneLease` with `psycheLaneId` now — rejected for this slice because it changes an enforcement surface before any profile exists.
- **R4 — Negotiation transport.** Recommend carrying `ProfileNegotiationV1` at bridge hello (`src/services/bridge/wireProtocol.ts` `hello`) and on the canonical control socket handshake (`src/control/server.ts`), with the bridge protocol remaining transport, not identity. Alternative: control-socket-only negotiation — rejected because the mobile bridge is the cross-device path (#200/#241 readiness).
- **R5 — Rollback trigger policy.** Recommend fail-closed quarantine on unverifiable protocol state with an explicit operator-visible health state, and rollback only at step boundaries (never per-effect). Alternative: automatic silent downgrade — rejected: it converts ambiguity into false success.

## Acceptance criteria mapping

| Issue acceptance criterion | Where addressed | Evidence still required |
|---|---|---|
| Exactly one canonical owner per durable ID/transition | Reference catalog + ownership baseline | the approved cross-repository ADR (`OpenCoven/psyche#12`) |
| Three objects distinct and linked | Required objects + binding envelope; enforced by `__tests__/protocolIdentityDesign.test.ts` | ratification by Psyche release |
| No identity from Bead/issue/pane/process/path/UI/provider | Reference catalog rules; boundary test on this record | canary denial vectors |
| Every session proves exact familiar revision embodied | `embodiedFamiliar`/`embodiedDigest` equality invariants (tested) | runtime proof in reference flow |
| Existing behavior via bounded adapters | Migration table M1–M6; Seams A–D of the compatibility map | adapter PRs + canaries |
| Incremental migration with per-step evidence | Migration table evidence column | per-step canary runs |
| Reference flow ends in same identity resumed | Reference flow + `goldenRestartResume` (tested) | executable receipt chain (#253 slice 5) |
| iOS observes/approves without transport-derived identity | Cross-device continuity section | physical-device acceptance per `docs/RELEASE-ACCEPTANCE.md` |
| Pinned cross-repo dependencies, acyclic release order, rollback | Version negotiation section; pins blocked on `OpenCoven/psyche#11` | released profile artifacts |
| Conformance claims name exact profile + evidence | Named profile `psyche.consumer.desktop-cockpit.v1`; no generic "compliant" | profile release + canary evidence |

## What this document deliberately does not do

- It does not claim Psyche protocol conformance, direct-read Psyche persistence, or define Psyche's canonical schemas — those are `OpenCoven/psyche#11`/`#12` outputs.
- It does not change product behavior, wire contracts, persisted formats, or authority paths; the only code-adjacent additions are the inert design module and its boundary test.
- It does not satisfy #253's pin, canary, adapter, or reference-flow slices; it prepares Build to consume them.

## Related code paths

| Path | Role in this design |
|---|---|
| `src/control/projectIdentity.ts` | current canonical project-root identity (realpath + NFC) — local lookup key, never protocol identity |
| `src/control/ownerLock.ts` | owner epoch fencing — the local analog of `resourceGeneration` |
| `src/control/runtime.ts`, `src/control/journal.ts` | single mutation authority + durable receipts/unknown outcomes |
| `src/control/leases.ts`, `src/control/capabilityLeases.ts` | lane/capability lease shapes the adapter must preserve |
| `src/control/approvals.ts` | intent-bound, consume-once approval lifecycle mirrored by `APPROVAL_STATES` |
| `src/control/credentials.ts` | current local principal model (`ControlPrincipal`) |
| `src/control/surfaces.ts` | pane/tab surface generations — replaceable execution locators |
| `src/orchestration/operationIdentity.ts` | current domain-separated tuple digests (`psyche.orchestration.*`, `orch-*`) — pattern reused, identity not promoted |
| `src/orchestration/types.ts` | current lane modes and task/lane plan/result shapes |
| `src/orchestration/localPaneBackend.ts`, `bridgePaneBackend.ts`, `covenSessionBackend.ts` | current lane backends the adapter will wrap |
| `src/daemon/controlHandlers.ts` | the single effect boundary (must remain the only mutation path) |
| `src/services/bridge/wireProtocol.ts`, `protocol-fixtures/` | transport + two-implementation fixture discipline the golden vectors follow |
| `native/ios/PsycheCore/Sources/PsycheCore/Protocol/BridgeMessages.swift` | iOS protocol mirror for cross-device continuity |
| `docs/CONTROL-PLANE.md`, `docs/PSYCHE-COMPATIBILITY-MAP.md`, `docs/BRIDGE-SECURITY.md`, `docs/AGENT-SURFACE-CONTROL.md` | current authority/compatibility contracts this design builds on |
