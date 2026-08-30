# Psyche Build post-release execution contract

**Status:** Active delivery plan  
**Last reconciled:** 2026-08-30  
**Control snapshot:** `main` at `f12b753424f2444466aadbd70f8213768a657031`

**Portfolio owner:** [@BunsDev](https://github.com/BunsDev)  
**Roadmap control:** [#195](https://github.com/OpenCoven/psyche-build/issues/195)  
**Canonical roadmap:** [ROADMAP.md](./ROADMAP.md)  
**Support contract:** [SUPPORT-MATRIX.md](./SUPPORT-MATRIX.md)

This document converts the roadmap into an ordered delivery contract. It names
the current critical path, independently safe work, blocked work, pull-request
disposition, and the evidence required to close each gate. Live GitHub outcomes
and PRs own current implementation state. Beads owns internal dependency order,
not public completion, support status, runtime identity, or protocol authority.

## Operating premise

Psyche Build `v0.0.1` for macOS is released and supported. The immutable release
source is `57c6c71bd5264fde960b062e95de278c8438c94f`; the public
[GitHub Release](https://github.com/OpenCoven/psyche-build/releases/tag/v0.0.1),
architecture-specific DMGs, checksums, protected
[release run](https://github.com/OpenCoven/psyche-build/actions/runs/32629730508),
and OpenCoven Homebrew Cask are the accepted distribution evidence.

Repository metadata now says `0.0.2`, but the latest public release is still
`v0.0.1`. `0.0.2` is a prepared **unreleased candidate** until an immutable tag,
release assets, publication run, installation/upgrade evidence, and owning issue
record the support transition. Do not infer release from `package.json`, the
changelog, a merge, or green CI.

The iOS companion remains planned under
[#200](https://github.com/OpenCoven/psyche-build/issues/200). Source, simulator,
fixture, and UI-test success do not establish live TestFlight availability.

## Authority and evidence

| System | Owns | Does not prove |
|---|---|---|
| GitHub outcomes | Public ownership, priority, dependencies, acceptance gates, and status | That an implementation/user path works |
| Beads | Internal tasks and dependency ordering | Support truth, runtime identity, or completion of a public outcome |
| Pull requests | Reviewable implementation slices and focused verification | End-to-end acceptance merely because tests pass |
| Retained evidence | Runtime, policy, artifact, clean-install, recovery, and physical-device observations tied to immutable source | Anything not actually observed |
| Specs and plans | Design intent and historical decisions | Current backlog or shipped behavior |

A claim moves to complete only when its owning outcome links durable evidence.
Documentation and test counts are not substitutes for repository policy,
production composition, immutable artifacts, operator-observed recovery, or
physical-device evidence.

Generated GitHub issue bodies are one-way mirrors. Never repair generated
mirrors directly. Change the canonical Beads record, review the local Dolt diff,
publish the exact reviewed commit, and run the protected synchronizer.

## Delivered foundation

The following work is delivered and remains historical evidence rather than an
active blocker:

- [#238](https://github.com/OpenCoven/psyche-build/issues/238) through
  [PR #245](https://github.com/OpenCoven/psyche-build/pull/245) / `5f4b7b05`;
- [#237](https://github.com/OpenCoven/psyche-build/issues/237) first apply and
  canonical mirror reconciliation;
- [#240](https://github.com/OpenCoven/psyche-build/issues/240) bounded drift
  validation and zero-operation evidence;
- [#244](https://github.com/OpenCoven/psyche-build/issues/244) minimum community,
  security, ownership, support, and intake floor;
- [PR #272](https://github.com/OpenCoven/psyche-build/pull/272) clean-checkout
  contributor full-gate repair;
- [PR #273](https://github.com/OpenCoven/psyche-build/pull/273) contributor
  scope/design/evidence and dated-record policy;
- [PR #262](https://github.com/OpenCoven/psyche-build/pull/262) current-state
  Psyche compatibility mapping, as slice 1 of #253 only;
- [PR #274](https://github.com/OpenCoven/psyche-build/pull/274), merged as
  `f12b7534`, sharing one guarded native iOS action store/request client;
- [PR #247](https://github.com/OpenCoven/psyche-build/pull/247) isolated Git
  inspection;
- [PR #248](https://github.com/OpenCoven/psyche-build/pull/248) and
  [PR #249](https://github.com/OpenCoven/psyche-build/pull/249) bounded managed
  Project synchronization and sanitizer hardening, including a retained dry-run
  with zero mutations and two GraphQL queries.

[#31](https://github.com/OpenCoven/psyche-build/issues/31) is not part of the
completed list. The live branch API still reports required-check
`enforcement_level: non_admins`. Administrator enforcement, removal of standing
broad bypass authority, ordinary/admin direct-push rejection, and a protected
proof PR remain open governance evidence.

## Critical path

| Order | Outcome | Priority | Current state / exit gate |
|---:|---|---:|---|
| 1 | [#196 — stabilization](https://github.com/OpenCoven/psyche-build/issues/196) + [#239 — operator manifest](https://github.com/OpenCoven/psyche-build/issues/239) | P0 | One immutable-source manifest proves ordinary lifecycle and representative failure/recovery paths |
| 1a | [#31 — branch governance](https://github.com/OpenCoven/psyche-build/issues/31) | P0 | Parallel live-policy correction: administrator-enforced checks/review and direct-push rejection |
| 2 | [#199 — operations/recovery](https://github.com/OpenCoven/psyche-build/issues/199) + [#243 — support bundle v1](https://github.com/OpenCoven/psyche-build/issues/243) | P1 | Bounded fail-closed diagnostics plus reusable operator-observed recovery harnesses |
| 2a | [#198 — open-source readiness](https://github.com/OpenCoven/psyche-build/issues/198) | P1 | Clean external checkout completes canonical bootstrap/full gate; live policy/community evidence retained |
| 3 | [#241 — atomic iOS readiness](https://github.com/OpenCoven/psyche-build/issues/241) under [#200 — iOS internal beta](https://github.com/OpenCoven/psyche-build/issues/200) | P1 | No failed new host can expose a workspace as authoritative |
| 4 | [#280 — secure invite authentication](https://github.com/OpenCoven/psyche-build/issues/280) | P1 | Focused protocol, desktop, iOS, UX, and physical slices after #241 |
| 5 | #200 discovery/reconnect and physical same-LAN acceptance | P1 | Physical iPhone preserves host/workspace authority through interruption, restart, revocation, and reconnect |
| 6 | [#242 — production ritual path](https://github.com/OpenCoven/psyche-build/issues/242) | P1 | Live publication, registered execution authority, canonical state/receipts, capability-gated controls |
| 7 | #200 immutable TestFlight | P1 | One distributed build repeats pairing/action/reconnect/restart/revocation evidence |
| 8 | [#197 — desktop decomposition](https://github.com/OpenCoven/psyche-build/issues/197) | P1 | Stable #196/#199 seams extracted without public/persisted contract drift |
| 9 | [#201 — OpenCoven convergence](https://github.com/OpenCoven/psyche-build/issues/201) + [#253 — Psyche canary](https://github.com/OpenCoven/psyche-build/issues/253) | P2 | Released profile, ownership decision, bounded adapters, cross-device reference evidence |
| 9a | [#279 — Coven launch adapter](https://github.com/OpenCoven/psyche-build/issues/279) | P2 | Capability/version negotiation, private prompt transport, canonical Coven session/receipt, rollback |
| 10 | [#246 — input parity](https://github.com/OpenCoven/psyche-build/issues/246) | P2 | Opt-in semantics preserve passthrough and earn platform-specific evidence |

## Stage 1 — governance and `v0.0.1` stabilization

**Owners:** #31, #196, and #239.  
**Current product gate:** #196/#239 are the current P0 stabilization critical
path; #31 proceeds as the parallel P0 governance gate.

The acceptance manifest must cover:

- exact-source tmux smoke and first launch/onboarding;
- plain-terminal and supported agent-backed lanes;
- project, pane, split, focus, resize, hide/restore, close, and handoff;
- restart, force-quit, corrupt state, stale identity, and unwritable storage;
- merge, pull-request, and cleanup success plus representative failure/unknown;
- optional-provider absence, interruption, incompatibility, and revocation;
- work preservation, authority, receipt, idempotency, and safe recovery.

Every consequential failure terminates deterministically or enters explicit
`recovery_required`. Reusable infrastructure gaps transfer to #199 without
reopening the accepted #194 publication.

#31 closes only when live settings—not docs—prove required checks/review apply
to administrators, no standing broad bypass can silently update `main`, force
push/deletion are disabled, release-tag authority remains constrained, and
ordinary/admin direct pushes are rejected. Any emergency path is separate,
time-bounded, named, incident-linked, and audited.

## Stage 2 — operations and contributor evidence

#199/#243 retains its P1 dependency gate: support-bundle schema/redaction may
proceed during #239; reusable recovery cases follow observed #239 failures.

[PR #278](https://github.com/OpenCoven/psyche-build/pull/278) has terminal green
CI but unresolved requested changes. Before it may merge, v1 must:

- omit unrestricted terminal free text by default or admit only a proven-safe,
  typed, conservatively allowlisted source;
- detect duplicate/conflicting collector ownership instead of silently keeping
  the first result and reporting complete;
- advertise only action states derivable from authoritative receipt data, or
  introduce a validated mapping for every state;
- bound collector input/traversal truthfully rather than applying the elapsed
  claim only to asynchronous collection while synchronous normalization remains
  unbounded.

#198/#244 retains its P1 dependency gate: #244, #272, and #273 deliver the
repository-addressable policy floor, but #198 remains open for terminal
clean-checkout evidence and live GitHub community/policy verification.

## Stage 3 — trustworthy iOS internal beta

**Owner:** #200.  
**Required order:** #241 atomic readiness → #280 focused invite-auth slices →
discovery/reconnect → physical same-LAN proof → #242 publication → #242
execution → capability-gated controls → immutable TestFlight.

#200/#241 retains its P1 dependency gate: atomic readiness precedes every later
iOS authority/capability slice, and physical evidence precedes support-state
change.

[PR #274](https://github.com/OpenCoven/psyche-build/pull/274) is a merged
product-local composition seam. It does not establish physical pairing,
authentication, production action publication, or TestFlight support.

[Draft PR #264](https://github.com/OpenCoven/psyche-build/pull/264) is source
material for [#280](https://github.com/OpenCoven/psyche-build/issues/280), not a
merge-ready 32-commit delivery. Extract in order:

1. typed invite/redemption protocol and generated replay/expiry/denial fixtures;
2. desktop single-writer issuance and atomic redemption;
3. iOS exchange/store composed only after #241 commits host authority;
4. QR/deep-link presentation and recovery UX;
5. physical Mac/iPhone interruption, replay, expiry, supersession, restart,
   revocation, and reconnect proof;
6. immutable TestFlight repetition under #200.

Bonjour, QR codes, deep links, addresses, and successful transport are not
durable identity or authority. Invite material must not enter logs, process
arguments, accessibility output, screenshots, fixtures, diagnostics, support
bundles, or persistent app state.

#242 publication precedes execution; execution precedes mobile controls. The
registered launcher revalidates subject, project/pane scope, generation,
revision, and capability immediately before execution. Controls remain absent
when the production capability is absent.

Only an immutable TestFlight build installed by an authorized tester may move
iOS from **Planned** to **Internal beta**.

## Stage 4 — decomposition

#197 retains its P1 dependency gate: implementation waits for stable #196/#199
contracts. Extraction order is lifecycle/registration, persistence/recovery,
pane/PTY/process lifecycle, browser/Git control, then desktop-web state/events.
Every focused PR preserves commands, schemas, persisted formats, errors,
security boundaries, generated outputs, user-visible behavior, and rollback.

## Stage 5 — OpenCoven convergence

#201/#253 retains its P2 dependency gate: mapping/design may proceed, while the
immutable pin waits for a consumable released Psyche profile and
ownership-sensitive adapters wait for the cross-repository ownership decision.
PR #262 is the focused replacement for #254's mapping scope and completes only
#253 delivery slice 1. It does not prove conformance.

[PR #277](https://github.com/OpenCoven/psyche-build/pull/277) points in the
correct runtime-ownership direction but is not merge-ready. Under
[#279](https://github.com/OpenCoven/psyche-build/issues/279), its replacement
must:

- negotiate an exact Coven version/profile and installed adapter capability;
- show only supported providers;
- keep raw composer prompts out of process argv and persistent launch metadata;
- preserve only a prompt reference/digest and canonical Coven session/receipt
  identity needed for recovery;
- distinguish spawned, accepted, running, terminal failure, and
  `recovery_required` rather than treating PTY creation as acceptance;
- define missing, incompatible, unavailable, and revoked Coven behavior;
- split unrelated Git-inspection test hardening into a separate PR;
- preserve migration and rollback from direct provider launches.

#279 is P2 and cannot become an undeclared prerequisite for #196, #199, or #200.

#246 retains its P2 dependency gate: broad cross-platform input rollout follows
stable input, persistence, action, P0 stabilization, and first iOS readiness
contracts unless a bounded slice is explicitly promoted.

## Pull-request disposition and replacement rules

| Pull request | Disposition | Replacement / closure contract |
|---|---|---|
| [#274](https://github.com/OpenCoven/psyche-build/pull/274) | **Merged** as `f12b7534` | Preserve as product-local iOS action-state composition; no support claim |
| [#278](https://github.com/OpenCoven/psyche-build/pull/278) | **Changes requested** | Resolve #243 privacy, collector truth, vocabulary, and bounded-input findings on a new exact head |
| [#277](https://github.com/OpenCoven/psyche-build/pull/277) | **Design correction required; not merge-ready** | Replace through #279 with negotiated capability and private prompt transport; split unrelated Git tests |
| [#264](https://github.com/OpenCoven/psyche-build/pull/264) | **Draft source material only** | Extract focused #280 slices after #241; do not merge the full branch |
| [#262](https://github.com/OpenCoven/psyche-build/pull/262) | **Merged focused mapping slice** | Completes only #253 slice 1; keep #253 open |
| [#236](https://github.com/OpenCoven/psyche-build/pull/236) | **Closed as superseded** | Preserve history after #245 |
| [#190](https://github.com/OpenCoven/psyche-build/pull/190) | **Source material only** | Integrate bounded safe pieces through #199/#243 |
| [#193](https://github.com/OpenCoven/psyche-build/pull/193) | **Source material only** | Extract #241, then discovery/reconnect, then physical acceptance |
| [#192](https://github.com/OpenCoven/psyche-build/pull/192) | **Source material only** | Extract #242 publication, execution, and UI in order after readiness |
| [#254](https://github.com/OpenCoven/psyche-build/pull/254) | **Source material only** | PR #262 is the focused replacement for #254's mapping scope |

The listed source-material PRs are not merge-ready because they can be rebased
or had historical green tests. No listed open implementation PR is merge-ready
at this snapshot. Every replacement starts from current `main`, has one owning
outcome and acceptance gate, resolves current review findings, and passes
required checks on its exact final head.

## Concurrency rules

- #31 and #196/#239 proceed in parallel; neither reopens accepted `v0.0.1`
  publication.
- #243 correction may proceed during #239; recovery scenarios wait for observed
  #239 cases.
- #198 evidence work may proceed independently without weakening #31.
- #241 precedes #280, later iOS authority/capability slices, and support changes.
- #242 publication precedes execution; execution precedes mobile controls.
- #197 implementation waits for stable #196/#199 contracts.
- #201/#253/#279 design may proceed; implementation cannot block #196, #199, or
  #200.
- #246 remains P2 until prerequisite contracts stabilize or a bounded slice is
  explicitly promoted.

## Merge and closure rules

A PR may merge only when:

1. its head is current enough to prove the intended contract against `main`;
2. required checks are terminal and successful on the exact final head;
3. no unresolved current review finding remains;
4. generated outputs are produced only through canonical generators;
5. support or roadmap changes update the owning issue and active docs;
6. consequential claims link operator, physical-device, policy, or artifact
   evidence as appropriate;
7. rollback or safe recovery is explicit for contract-changing work.

Closing an implementation issue requires the merged commit and retained
evidence, not merely a merged source diff. Closing a public outcome requires
every child gate or an explicit truthful deferral.