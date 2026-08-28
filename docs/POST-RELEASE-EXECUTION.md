# Psyche Build post-release execution contract

**Status:** Active delivery plan  
**Last reconciled:** 2026-08-28

**Portfolio owner:** [@BunsDev](https://github.com/BunsDev)  
**Roadmap control:** [#195](https://github.com/OpenCoven/psyche-build/issues/195)  
**Delivered documentation foundation:** [#238](https://github.com/OpenCoven/psyche-build/issues/238)

This document turns the canonical [roadmap](./ROADMAP.md) into an ordered,
executable delivery plan. It identifies the current critical path, work that may
proceed in parallel, the proof required to close each gate, and the pull-request
slices that must replace oversized or stale branches.

Live GitHub issues and pull requests remain authoritative for implementation
state. This file is the maintained sequencing contract. Beads owns internal task
dependencies, not product identity or public support status.

## Operating premise

Psyche Build `v0.0.1` for macOS is released and supported. The immutable
release source is `57c6c71bd5264fde960b062e95de278c8438c94f`; the public
[GitHub Release](https://github.com/OpenCoven/psyche-build/releases/tag/v0.0.1)
and OpenCoven Homebrew Cask are live. The desktop-only
[release run](https://github.com/OpenCoven/psyche-build/actions/runs/32629730508)
preserved shared validation while iOS verification and distribution were
skipped deliberately.

The remaining P0 work after this control-state proof wave is stabilization. It
does not make the public macOS artifact unreleased. The iOS companion remains
planned pending [#200](https://github.com/OpenCoven/psyche-build/issues/200);
source, simulator, fixture, and UI-test success do not establish live TestFlight availability.

[Issue #238](https://github.com/OpenCoven/psyche-build/issues/238) remains
delivered through [PR #245](https://github.com/OpenCoven/psyche-build/pull/245)
and merge commit `5f4b7b05`; it is completed Stage 0 foundation.

Since this plan was drafted, [PR #248](https://github.com/OpenCoven/psyche-build/pull/248)
and [PR #249](https://github.com/OpenCoven/psyche-build/pull/249) landed the
managed Beads-to-GitHub Project synchronization, bounded GraphQL request model,
drift checks, mutation fencing, and sanitizer hardening. The production
automation and manual environments are restricted to `main`; the manual path
requires Maintainer approval. A current live dry-run plans zero mutations with
two GraphQL queries. [PR #236](https://github.com/OpenCoven/psyche-build/pull/236)
is closed as superseded.

When this proof PR merges and its linked remote evidence is completed,
[#31](https://github.com/OpenCoven/psyche-build/issues/31) is delivered by this
wave, [#237](https://github.com/OpenCoven/psyche-build/issues/237) is delivered
by this wave, and [#240](https://github.com/OpenCoven/psyche-build/issues/240)
is delivered by this wave. Their closure is finalized by linking this proof PR,
sanitized policy evidence, the first apply, and the final zero-operation run in
the owning issues. Documentation and tests alone do not prove remote policy,
apply, or issue-closure state.

For #31, the policy evidence must prove administrator enforcement plus a
single named PR-only owner bypass, `BunsDev`. Direct pushes remain
platform-blocked for `BunsDev`, all other actors require one approval, and the
retained evidence includes direct-push rejection proof. GitHub cannot create an
author self-approval review. When independent review is unavailable, `BunsDev`
uses the explicit PR-only bypass for an admin merge only after exact-head
checks succeed and conversations are resolved; this is not self-approval.

[PR #247](https://github.com/OpenCoven/psyche-build/pull/247) also closed the
desktop Git-log command-execution path by routing log inspection through the
isolated repository snapshot while preserving bare-repository support.

## Authority and evidence

| System | Owns | Does not prove |
|---|---|---|
| GitHub outcomes | Public ownership, priority, dependencies, acceptance gates, and status | That an implementation or user path works |
| Beads | Internal implementation tasks and dependency ordering | Runtime identity, support status, or completion of a public outcome |
| Pull requests | Reviewable implementation slices and focused verification | End-to-end acceptance merely because unit tests pass |
| Retained evidence | Runtime, physical-device, clean-artifact, policy, and recovery observations tied to immutable source | Anything not actually observed |
| Specs and plans | Design intent and historical decisions | Current backlog or shipped behavior |

A claim moves to complete only when its owning outcome links durable evidence.
Screenshots without build identity, undocumented maintainer memory, generated
mirror text, or raw test counts are insufficient. Documentation and test counts
are not substitutes for retained evidence.

## Critical path

The numbered order below is the default delivery order. A later item may start
only where the concurrency rules explicitly permit it.

| Order | Outcome | Priority | Current state and exit gate |
|---:|---|---:|---|
| 1 | [#196 — stabilization](https://github.com/OpenCoven/psyche-build/issues/196) and [#239 — operator manifest](https://github.com/OpenCoven/psyche-build/issues/239) | P0 | One sanitized manifest proves ordinary lifecycle and representative recovery, Git, cleanup, and optional-provider paths |
| 2 | [#241 — atomic iOS host readiness](https://github.com/OpenCoven/psyche-build/issues/241) under [#200 — iOS internal beta](https://github.com/OpenCoven/psyche-build/issues/200) | P1 | A focused current-main PR cannot expose a new workspace when host authority or readiness commit fails |
| 3 | #200 discovery, reconnect, and physical same-LAN acceptance | P1 | A physical iPhone preserves authoritative host/workspace state through restart, suspension, network interruption, revocation, and reconnect |
| 4 | [#242 — production ritual publication and execution](https://github.com/OpenCoven/psyche-build/issues/242) | P1 | A live host publishes bounded ritual metadata, executes through the registered authority path, and returns canonical state/receipts |
| 5 | #200 internal TestFlight | P1 | One immutable distributed build repeats the physical connection, action, reconnect, host-restart, and revocation matrix |
| 6 | [#199 — operational hardening](https://github.com/OpenCoven/psyche-build/issues/199) and [#243 — support bundle v1](https://github.com/OpenCoven/psyche-build/issues/243) | P1 | Bounded/redacted diagnostics and reusable recovery harnesses replace maintainer-only inference |
| 7 | [#198 — open-source readiness](https://github.com/OpenCoven/psyche-build/issues/198) and [#244 — minimum community floor](https://github.com/OpenCoven/psyche-build/issues/244) | P1 | Security, ownership, support, issue, PR, and contribution surfaces are usable without protected maintainer knowledge |
| 8 | [#197 — desktop decomposition](https://github.com/OpenCoven/psyche-build/issues/197) | P1 | Stable lifecycle, persistence, pane/process, browser/Git, and UI-state seams are extracted without public-contract drift |
| 9 | [#201 — OpenCoven identity and Threads convergence](https://github.com/OpenCoven/psyche-build/issues/201) with [#253 — Psyche compatibility canary](https://github.com/OpenCoven/psyche-build/issues/253) | P2 | A pinned profile and incremental adapters preserve protocol-owned identity without blocking supported-product work |
| 10 | [#246 — cross-platform Vim and keyboard-mode parity](https://github.com/OpenCoven/psyche-build/issues/246) | P2 | Opt-in shared semantics preserve terminal passthrough and earn evidence independently on each claimed platform |

## Stage 0 — delivered control-state closure wave

**Owners:** #238, #31, #237, and #240.

When this proof PR merges and linked remote evidence is completed, #238 remains
delivered through PR #245 / `5f4b7b05`, while #31, #237, and #240 are Stage 0
closure items delivered by this wave. Finalize closure by linking the proof PR,
policy evidence, first apply, and zero-operation run in the owning issues.
Preserve the deployed single-writer lease, protected `main`-only environments,
canonical target mapping, deterministic drift validation, and bounded GraphQL
behavior. The #31 evidence records administrator enforcement, the single named
PR-only owner bypass, `BunsDev`, the absence of team, app, or additional-user
bypass actors, and direct-push rejection proof. Direct pushes remain
platform-blocked for `BunsDev`; all other actors require approval, and the
owner path is an explicit PR-only bypass/admin merge after exact-head checks
and resolved conversations, never a self-approval claim.

**Exit state:** roadmap, support claims, branch policy, Beads, GitHub mirrors,
and live PR disposition agree on what is delivered, active, blocked, and
deferred. The linked remote evidence, not these docs or tests alone, proves the
exit.

## Stage 1 — close the `v0.0.1` stabilization baseline

**Owners:** #196 and #239.  
**Current gate:** #196/#239 are the next P0 critical path.

The acceptance manifest must cover:

- exact-source tmux smoke;
- first launch and onboarding;
- plain-terminal and supported agent-backed lanes;
- project, pane, split, focus, resize, hide/restore, close, and handoff;
- normal restart, force-quit, corrupt state, stale identity, and unwritable
  storage;
- merge, pull request, and cleanup success plus representative failure/unknown
  paths;
- optional-provider absence, interruption, and revocation;
- work preservation, authority, receipt, idempotency, and safe recovery.

**Exit:** no consequential effect remains silently unknown. Every representative
failure terminates deterministically or enters an explicit `recovery_required`
state, and reusable gaps are transferred to #199.

## Stage 2 — trustworthy iOS internal beta

**Owner:** #200.  
**Merge order:** #241 atomic readiness → discovery/reconnect UI → physical
same-LAN acceptance → #242 publication → #242 execution → capability-gated UI →
internal TestFlight.

#200/#241 retains its P1 dependency gate: atomic readiness precedes every later
iOS capability slice, and physical evidence precedes a support-state change.

### Atomic readiness

Persist authoritative host identity before exposing a new host snapshot. A
transport, authentication, secure-store, decode/revision, or workspace-apply
failure must leave either clearly stale state from the previous authoritative
host or no state for the failed new host.

### Discovery and physical proof

Bonjour is a discovery adapter, not identity or authority. Preserve manual
endpoint fallback and exact stored-host reconnect. Exercise app/host restart,
foreground/background, phone suspension, Wi-Fi interruption, address change,
expired credentials, explicit revocation, and manual reconnect on a physical
device.

### Production actions

The live TUI/bridge provider must publish bounded ritual metadata. The actual
registered launcher must revalidate subject, project/pane scope, generation,
revision, and advertised capability immediately before execution. Retries share
canonical idempotency and receipts. Mobile controls remain absent when the
production capability is absent.

### Distribution

Only an immutable TestFlight build installed by an authorized tester may move
the support status from **Planned** to **Internal beta**. Remote/off-LAN
continuity follows the same identity and authority contracts after the first
same-LAN beta; it does not block that beta.

## Stage 3 — operations and contributor readiness

#199/#243 retains its P1 dependency gate: support-bundle schema and redaction
may begin during #239, while reusable recovery harnesses follow observed #239
cases.

Support-bundle schema/redaction work in #243 may begin during #239, but reusable
failure-harness extraction follows observed #239 cases. The bundle must be
versioned, deterministic, bounded by time/count/record/total size, cancellable,
and automatically redact credentials, raw prompts, unrestricted terminal
output, repository contents, environment variables, infrastructure details,
and full user paths.

The minimum security and ownership floor in #244 may also proceed independently.
#198/#244 retains its P1 dependency gate: it may land independently, but broader
clean-checkout contributor acceptance remains under #198 and enforcement claims
must link #31's policy evidence.

## Stage 4 — decomposition and OpenCoven convergence

#197 retains its P1 dependency gate: implementation waits for stable #196/#199
contracts.

Desktop decomposition begins only after the #196/#199 contracts it will extract
are stable. The required order is lifecycle/registration, persistence/recovery,
pane/PTY/process lifecycle, browser/Git control, then desktop-web state and
events. Each PR preserves public commands, schemas, persisted formats, errors,
security boundaries, generated outputs, and rollback.

#201/#253 retains its P2 dependency gate: mapping and design may proceed in
parallel, while the immutable pin waits for a consumable Psyche profile and
ownership-sensitive adapters wait for the cross-repository ownership decision.
Implementation must not become an undeclared prerequisite for stabilization,
diagnostics, or iOS. Protocol identity must outlive Beads, tmux/process IDs,
paths, branches, providers, transports, and UI selections.

#246 retains its P2 dependency gate: broad cross-platform input rollout follows
stable input, persistence, action, P0 stabilization, and first iOS readiness
contracts. It remains opt-in and cannot become a prerequisite for #196, #199,
or #200 unless a bounded slice is explicitly reprioritized.

## Pull-request disposition and replacement rules

| Pull request | Disposition | Replacement contract |
|---|---|---|
| [#236](https://github.com/OpenCoven/psyche-build/pull/236) | **Closed as superseded** by PR #245 and #238 | Preserve useful review/history; do not force-update, reopen, or merge the stale branch |
| [#190](https://github.com/OpenCoven/psyche-build/pull/190) | **Source material only** | Integrate bounded pieces through #199/#243 after callback safety, readiness retry, redaction, and diagnostic limits are proven |
| [#193](https://github.com/OpenCoven/psyche-build/pull/193) | **Source material only** | Extract #241 first, then discovery/reconnect, then physical acceptance; do not merge the large branch as one unit |
| [#192](https://github.com/OpenCoven/psyche-build/pull/192) | **Source material only** | Extract production publication, execution, and UI in #242 order after accepted host readiness |
| [#254](https://github.com/OpenCoven/psyche-build/pull/254) | **Outside Stage 0** | PR #254 remains outside Stage 0; evaluate it only against #201/#253's P2 compatibility gate and exact-head evidence |

No listed active implementation PR is merge-ready merely because it can be
rebased or its tests once passed. Every replacement starts from current `main`, has one owning
outcome and one acceptance gate, resolves current review findings, and passes
required checks on its exact final head.

## Concurrency rules

- #196/#239 is the active P0 gate after the Stage 0 proof wave closes.
- #243 schema and redaction work may begin during #239; recovery scenarios wait
  for observed acceptance cases.
- #244 may proceed independently but must not destabilize release, tracker, or
  iOS contracts.
- #241 precedes all later iOS capability work.
- #242 publication precedes execution, and execution precedes mobile controls.
- #197 implementation waits for stable #196/#199 contracts.
- #201/#253 design may proceed; implementation cannot block #196, #199, or
  #200.
- #246 stays P2 until prerequisite contracts stabilize or a bounded slice is
  explicitly promoted.

## Merge and closure rules

A PR may merge only when:

1. its head is current enough to prove the intended contract against `main`;
2. required checks are terminal and successful on the exact head;
3. no unresolved current review finding remains;
4. generated outputs are produced only through canonical generators;
5. support or roadmap status changes update the owning issue and active docs;
6. consequential runtime claims link operator, physical-device, policy, or
   artifact evidence as appropriate;
7. rollback or safe recovery is explicit for contract-changing work.

Closing an implementation issue requires the merged commit and retained evidence,
not merely a merged source diff. Closing a public outcome requires every child gate or an explicit, truthful deferral.