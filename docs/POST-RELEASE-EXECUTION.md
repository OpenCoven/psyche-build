# Psyche Build post-release execution contract

**Status:** Active delivery plan  
**Last reconciled:** 2026-09-02

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

The remaining P0 product work is stabilization. It does not make the public
macOS artifact unreleased. The iOS companion remains planned pending
[#200](https://github.com/OpenCoven/psyche-build/issues/200); source,
simulator, fixture, and UI-test success do not establish live TestFlight availability.
Repository metadata identifying `0.0.2` describes an unreleased candidate, not
a support claim.

[Issue #238](https://github.com/OpenCoven/psyche-build/issues/238) remains
delivered through [PR #245](https://github.com/OpenCoven/psyche-build/pull/245)
and merge commit `5f4b7b05`; it is completed Stage 0 foundation.

[PR #248](https://github.com/OpenCoven/psyche-build/pull/248) and
[PR #249](https://github.com/OpenCoven/psyche-build/pull/249) landed the
managed Beads-to-GitHub Project synchronization, bounded GraphQL request model,
drift checks, mutation fencing, and sanitizer hardening. The production
automation and manual environments are restricted to `main`; the manual path
requires Maintainer approval. The first live dry-run planned zero mutations with
two GraphQL queries. [PR #236](https://github.com/OpenCoven/psyche-build/pull/236)
is closed as superseded.

The Stage 0 closure wave is complete. [#240](https://github.com/OpenCoven/psyche-build/issues/240)
closed on 2026-08-28 through [PR #263](https://github.com/OpenCoven/psyche-build/pull/263)
(`d3735ec4`), later hardened by [PR #330](https://github.com/OpenCoven/psyche-build/pull/330)
(`c2a8da8d`). [#237](https://github.com/OpenCoven/psyche-build/issues/237)
closed on 2026-08-29 after source-first Beads reconciliation.
[#31](https://github.com/OpenCoven/psyche-build/issues/31) closed on
2026-08-30 with sanitized policy evidence, a `GH013` direct-push rejection
probe, and proof [PR #283](https://github.com/OpenCoven/psyche-build/pull/283)
merged through the protected path as `63667f30`. Each owning issue links that
evidence; documentation and tests were not treated as proof of remote policy,
apply, or issue-closure state.

For #31, the retained policy evidence proves administrator enforcement plus a
single named PR-only owner bypass, `BunsDev`. Direct pushes remain
platform-blocked for `BunsDev`, all other actors require one approval, and the
retained evidence includes direct-push rejection proof. GitHub cannot create an
author self-approval review. When independent review is unavailable, `BunsDev`
uses the explicit PR-only bypass for an admin merge only after exact-head
checks succeed and conversations are resolved; this is not self-approval.

[PR #247](https://github.com/OpenCoven/psyche-build/pull/247) also closed the
desktop Git-log command-execution path by routing log inspection through the
isolated repository snapshot while preserving bare-repository support.

Since 2026-08-28 the following outcomes closed with linked evidence:
[#244](https://github.com/OpenCoven/psyche-build/issues/244) via
[PR #261](https://github.com/OpenCoven/psyche-build/pull/261),
[#252](https://github.com/OpenCoven/psyche-build/issues/252) via
[PR #260](https://github.com/OpenCoven/psyche-build/pull/260),
[#198](https://github.com/OpenCoven/psyche-build/issues/198) via
[PR #321](https://github.com/OpenCoven/psyche-build/pull/321), and
[#243](https://github.com/OpenCoven/psyche-build/issues/243) via
[PR #278](https://github.com/OpenCoven/psyche-build/pull/278). The
[roadmap](./ROADMAP.md#delivered-since-2026-08-28) lists every merged slice and
its owning outcome.

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
| 1 | [#196 — stabilization](https://github.com/OpenCoven/psyche-build/issues/196) and [#239 — operator manifest](https://github.com/OpenCoven/psyche-build/issues/239) | P0 | One sanitized manifest proves ordinary lifecycle and representative recovery, Git, cleanup, and optional-provider paths; the manifest verifies 15 digests and is still `incomplete` |
| 2 | [#241 — atomic iOS host readiness](https://github.com/OpenCoven/psyche-build/issues/241) under [#200 — iOS internal beta](https://github.com/OpenCoven/psyche-build/issues/200) | P1 | Readiness core, production composition, and ready-selection hardening are merged; physical-device, real-Keychain, and lifecycle acceptance remain |
| 3 | [#280 — single-use invite authentication](https://github.com/OpenCoven/psyche-build/issues/280) | P1 | Protocol/fixture slice merged in PR #323; desktop issuer, iOS exchange, QR/deep-link UX, and physical acceptance remain |
| 4 | #200 discovery, reconnect, and physical same-LAN acceptance | P1 | A physical iPhone preserves authoritative host/workspace state through restart, suspension, network interruption, revocation, and reconnect |
| 5 | [#242 — production ritual publication and execution](https://github.com/OpenCoven/psyche-build/issues/242) | P1 | PR #322 merged publication only; the registered execution path must return canonical state/receipts before capability-gated controls appear |
| 6 | #200 internal TestFlight | P1 | One immutable distributed build repeats the physical connection, action, reconnect, host-restart, and revocation matrix |
| 7 | [#199 — operational hardening](https://github.com/OpenCoven/psyche-build/issues/199) ([#243 — support bundle v1](https://github.com/OpenCoven/psyche-build/issues/243) delivered) | P1 | Reusable recovery harnesses built from observed #239 cases replace maintainer-only inference; the v1 schema is delivered without production collector wiring |
| 8 | [#197 — desktop decomposition](https://github.com/OpenCoven/psyche-build/issues/197) | P1 | Stable lifecycle, persistence, pane/process, browser/Git, and UI-state seams are extracted without public-contract drift |
| 9 | [#201 — OpenCoven identity and Threads convergence](https://github.com/OpenCoven/psyche-build/issues/201) with [#253 — Psyche compatibility canary](https://github.com/OpenCoven/psyche-build/issues/253) and [#279 — Coven launch adapter](https://github.com/OpenCoven/psyche-build/issues/279) | P2 | A pinned profile and incremental adapters preserve protocol-owned identity without blocking supported-product work |
| 10 | [#246 — cross-platform Vim and keyboard-mode parity](https://github.com/OpenCoven/psyche-build/issues/246) | P2 | Opt-in shared semantics preserve terminal passthrough and earn evidence independently on each claimed platform; the shared v1 fixture contract is merged |

Delivered and no longer sequenced: [#198 — open-source readiness](https://github.com/OpenCoven/psyche-build/issues/198)
and [#244 — minimum community floor](https://github.com/OpenCoven/psyche-build/issues/244).

## Stage 0 — delivered control-state closure wave

**Owners:** #238, #31, #237, and #240.

#238 remains delivered through PR #245 / `5f4b7b05`. #31, #237, and #240 are
closed with the evidence linked in their owning issues: the proof PR, sanitized
policy evidence, the first apply, and the zero-operation run. Preserve the
deployed single-writer lease, protected `main`-only environments, canonical
target mapping, deterministic drift validation, and bounded GraphQL behavior.
Direct pushes remain platform-blocked for `BunsDev`; all other actors require
approval, and the owner path is an explicit PR-only bypass/admin merge after
exact-head checks and resolved conversations, never a self-approval claim.

**Exit state:** reached. Roadmap, support claims, branch policy, Beads, GitHub
mirrors, and live PR disposition agree on what is delivered, active, blocked,
and deferred as of this reconciliation.

**Control-state regression under repair:** the scheduled Beads Project sync
failed on every scheduled run from 2026-08-30 until 2026-09-02 because a
checkout running the accidental Beads v1.2.1 release migrated the shared Dolt
schema to v65 and pushed it; the pinned 1.2.2 CLI could not open it. The
schema cursor was rolled back to v53 and pushed on 2026-09-02 following the
upstream recovery guide, with all 111 Beads preserved. The public mirror stays
stale until the first unattended apply succeeds, and the read-only validator
still reports the `psyche-z7c.4.4`/#230 `state_mismatch` (the Bead is open
while PR #281 closed its mirror) plus the resulting source-status drift. Repair
remains source-first: close the Bead through the reviewed Beads workflow, let
the restored scheduled apply publish it, and retain the zero-operation report.
Generated mirror bodies are never edited to repair this.
[#342](https://github.com/OpenCoven/psyche-build/issues/342) owns the repair
under #195, including the Beads CLI fleet rule in
[`.beads/README.md`](../.beads/README.md).

## Stage 1 — close the `v0.0.1` stabilization baseline

**Owners:** #196 and #239.  
**Current gate:** #196/#239 remain the active P0 critical path.

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

Merged remediation so far: PR #283 (visible stale-identity and corrupt-config
recovery) and PR #336 (linearized desktop project lifecycle and native-authority
transactions). Both are current-source fixes; they do not replace the released
`v0.0.1` partial/failed classifications until released and re-observed, and
interactive packaged Tauri/tmux acceptance remains required.

**Exit:** no consequential effect remains silently unknown. Every representative
failure terminates deterministically or enters an explicit `recovery_required`
state, and reusable gaps are transferred to #199.

## Stage 2 — trustworthy iOS internal beta

**Owner:** #200.  
**Merge order:** #241 atomic readiness → #280 invite authentication →
discovery/reconnect UI → physical same-LAN acceptance → #242 publication →
#242 execution → capability-gated UI → internal TestFlight.

#200/#241 retains its P1 dependency gate: atomic readiness precedes every later
iOS capability slice, and physical evidence precedes a support-state change.

### Atomic readiness

Persist authoritative host identity before exposing a new host snapshot. A
transport, authentication, secure-store, decode/revision, or workspace-apply
failure must leave either clearly stale state from the previous authoritative
host or no state for the failed new host.

Merged: the isolated readiness core (PR #326), production `ConnectionManager`
composition (PR #329), fenced ready-host selection (PR #335), durable read-back
classification (PR #337), quarantine of indeterminate authority (PR #338), and
behavior-preserving cleanups (PRs #339 and #341). Local iOS evidence used a
newer Xcode/simulator than the repository pin; exact-head CI is the pinned-host
evidence. Physical-device, real-Keychain partial-write, discovery/reconnect UX,
and lifecycle acceptance remain open.

### Invite authentication

#280 composes single-use invite redemption and durable credential storage into
the readiness machine. PR #323 merged the protocol/fixture slice: bounded
payloads, replay/expiry/denial vectors, atomic consume, and fail-closed
credential-store behavior. The desktop issuer/consumer, iOS credential exchange,
QR/deep-link UX, physical acceptance, and distribution evidence follow in that
order. `OpenCoven/psyche#12` still owns canonical host-identity ownership.

### Discovery and physical proof

Bonjour is a discovery adapter, not identity or authority. Preserve manual
endpoint fallback and exact stored-host reconnect. Exercise app/host restart,
foreground/background, phone suspension, Wi-Fi interruption, address change,
expired credentials, explicit revocation, and manual reconnect on a physical
device.

### Production actions

The live TUI/bridge provider must publish bounded ritual metadata. PR #322
merged that publication with explicit empty, unavailable, stale, incompatible,
permission-denied, and limit-exceeded states, scoped to workspace-owned
projects. The actual registered launcher must still revalidate subject,
project/pane scope, generation, revision, and advertised capability immediately
before execution. Retries share canonical idempotency and receipts. Mobile
controls remain absent when the production capability is absent.

### Distribution

Only an immutable TestFlight build installed by an authorized tester may move
the support status from **Planned** to **Internal beta**. Remote/off-LAN
continuity follows the same identity and authority contracts after the first
same-LAN beta; it does not block that beta.

## Stage 3 — operations and contributor readiness

#199/#243 retains its P1 dependency gate for the remaining #199 work:
support-bundle schema and redaction landed through PR #278 and closed #243,
while reusable recovery harnesses follow observed #239 cases.

The merged bundle contract is versioned, deterministic, bounded by
time/count/record/total size, cancellable, and automatically redacts
credentials, raw prompts, unrestricted terminal output, repository contents,
environment variables, infrastructure details, and full user paths. It has no
production collector wiring, persistence, CLI, or UI. PR #281 delivered the
debug-authorized rendering stress harness and PR #283 delivered visible pane
recovery reporting under #199.

#198/#244 is delivered. PR #261 landed the minimum security, ownership,
support, issue, PR, conduct, and protected-data floor, and PR #321 closed the
clean-checkout contributor loop with a credential-free acceptance run and live
community-profile evidence. Enforcement claims link #31's policy evidence.

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

#279 is the bounded Coven launch adapter under #201. PRs #324, #328, and #336
merged capability negotiation against the pinned daemon profile, prompt
transport outside argv and persisted metadata, and serialized revocation and
recovery. Live restart/reconnect recovery, migration/rollback observation, and
a reference launch remain open; canonical runtime receipts wait on the #253
protocol pin. A live verification against a real daemon also found that the
CLI adapter catalog can advertise harnesses the daemon rejects, so the picker
must gate on the daemon's configured set before it is driven from the catalog.

#246 retains its P2 dependency gate: broad cross-platform input rollout follows
stable input, persistence, action, P0 stabilization, and first iOS readiness
contracts. PR #327 merged the shared v1 fixture contract as the bounded first
slice. It remains opt-in and cannot become a prerequisite for #196, #199, or
#200 unless a bounded slice is explicitly reprioritized.

## Pull-request disposition and replacement rules

| Pull request | Disposition | Replacement contract |
|---|---|---|
| [#236](https://github.com/OpenCoven/psyche-build/pull/236) | **Closed as superseded** by PR #245 and #238 | Preserve useful review/history; do not force-update, reopen, or merge the stale branch |
| [#190](https://github.com/OpenCoven/psyche-build/pull/190) | **Source material only** (closed 2026-08-28) | Integrate bounded pieces through #199 after callback safety, readiness retry, redaction, and diagnostic limits are proven; PR #281 extracted the stress harness |
| [#193](https://github.com/OpenCoven/psyche-build/pull/193) | **Source material only** (closed 2026-08-28) | #241 extracted the readiness core and composition; discovery/reconnect and physical acceptance remain |
| [#192](https://github.com/OpenCoven/psyche-build/pull/192) | **Source material only** (closed 2026-08-28) | PR #322 extracted publication; #242 execution and UI follow in order |
| [#264](https://github.com/OpenCoven/psyche-build/pull/264) | **Source material only** (closed 2026-08-31) | Extract focused #280 slices; PR #323 landed the protocol/fixture slice |
| [#254](https://github.com/OpenCoven/psyche-build/pull/254) | **Source material only** (closed 2026-08-28) | PR #254 remains outside Stage 0; its useful mapping material re-entered through the focused replacement slice |
| [#262](https://github.com/OpenCoven/psyche-build/pull/262) | **Merged focused mapping slice** (`73dc6f5d`) | Completes only #253 delivery slice 1; keep #253 open for the immutable pin, canary, adapters, and reference-flow evidence |
| [#277](https://github.com/OpenCoven/psyche-build/pull/277) | **Merged direction slice** corrected by PRs #324, #328, and #336 | #279 remains open for live recovery, canonical receipt, and rollback evidence |
| [#322](https://github.com/OpenCoven/psyche-build/pull/322) | **Merged** (`efa8cc0a`) | Publication only; #242 execution and mobile controls follow |
| [#323](https://github.com/OpenCoven/psyche-build/pull/323) | **Merged** (`052ed006`) | Protocol/fixture slice only; no pairing, revocation, or support-state claim |

The listed source-material PRs are not merge-ready and are closed. Every
replacement starts from current `main`, has one owning outcome and one
acceptance gate, resolves current review findings, and passes required checks
on its exact final head. PR #262 is the focused replacement for #254's mapping
scope and does not complete #253.

At reconciliation there is no open pull request. A replacement must start from
current `main`, have one owning outcome and acceptance gate, and pass required
checks on its exact final head.

## Concurrency rules

- #196/#239 is the active P0 gate.
- #199 recovery scenarios wait for observed #239 acceptance cases; the #243
  schema slice is delivered.
- #241 precedes all later iOS capability work; #280 composes into it.
- #242 publication precedes execution, and execution precedes mobile controls.
- #197 implementation waits for stable #196/#199 contracts.
- #201/#253/#279 design and bounded adapters may proceed; implementation cannot
  block #196, #199, or #200.
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
