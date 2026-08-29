# Psyche Build roadmap

**Status:** Active post-release roadmap  
**Accountable owner:** [@BunsDev](https://github.com/BunsDev)  
**Last reconciled:** 2026-08-28

**Portfolio control:** [#195](https://github.com/OpenCoven/psyche-build/issues/195)  
**Execution contract:** [POST-RELEASE-EXECUTION.md](./POST-RELEASE-EXECUTION.md)

This is the canonical public roadmap for Psyche Build. It records supported
surfaces, active outcomes, delivery order, dependencies, and evidence gates.
The [post-release execution contract](./POST-RELEASE-EXECUTION.md) expands this
roadmap into focused issue and pull-request slices.

Live GitHub issues and pull requests are authoritative for implementation state.
Beads owns internal dependency ordering. Retained runtime, policy, artifact, or
physical-device evidence determines whether an outcome is complete.

## North star

Psyche Build is OpenCoven's local-first cockpit for visible, scoped, and
recoverable familiar work. It must preserve user work, identity, authority, and
continuity while allowing multiple terminal or agent lanes to proceed in
parallel.

The first credible public macOS release shipped on 2026-08-23. The current
objective is to stabilize and govern that supported surface, make operational
recovery repeatable, deliver an independently gated iOS companion, establish a
credible contributor boundary, and then converge incrementally on
OpenCoven-native familiar and Threads identity.

## Current support state

The detailed claim contract lives in [SUPPORT-MATRIX.md](./SUPPORT-MATRIX.md).
For `v0.0.1`:

- the macOS native application is **Supported** through signed and notarized
  Apple Silicon and Intel DMGs and the OpenCoven Homebrew Cask;
- the TUI/Node CLI is **Source-supported** from a repository checkout and is not
  separately distributed through a package registry;
- the iOS application is **Planned internal beta pending #200**; no live
  TestFlight availability is claimed;
- Windows and Linux remain **Compile-only**;
- Android, browser-hosted distribution, external TestFlight, and the public App
  Store are **Unavailable**;
- cloud execution, team collaboration, marketplace behavior, remote/off-LAN
  continuity, and complete Threads/AgentFS convergence remain **Planned**.

### Delivered release evidence

The immutable `v0.0.1` release source is
`57c6c71bd5264fde960b062e95de278c8438c94f`. The public
[GitHub Release](https://github.com/OpenCoven/psyche-build/releases/tag/v0.0.1)
contains the two architecture-specific DMGs and `SHA256SUMS`. The protected
[desktop-only release run](https://github.com/OpenCoven/psyche-build/actions/runs/32629730508)
published those assets, and the native Homebrew Cask passed independent Apple
Silicon and Intel lifecycle validation.

`#194` and `#203` are closed. In desktop-only mode, iOS-only verification and
distribution were skipped deliberately while shared validation was preserved.
This evidence makes macOS public and supported; it does not make iOS supported.

[Issue #238](https://github.com/OpenCoven/psyche-build/issues/238) remains
delivered through [PR #245](https://github.com/OpenCoven/psyche-build/pull/245)
and merge commit `5f4b7b05`. Its critical-path documentation and retirement of
the superseded release-doc branch are completed foundation.

PRs [#248](https://github.com/OpenCoven/psyche-build/pull/248) and
[#249](https://github.com/OpenCoven/psyche-build/pull/249) have also landed the
managed Beads Project mirror, bounded GraphQL discovery/inventory caching,
deterministic drift checks, write fencing, and public-body sanitizer hardening.
Production synchronization is restricted to `main`, the manual environment is
Maintainer-gated, and the latest live dry-run planned zero mutations with two
GraphQL queries.

When this proof PR merges and its linked remote evidence is completed,
[#31](https://github.com/OpenCoven/psyche-build/issues/31) is delivered by this
wave, [#237](https://github.com/OpenCoven/psyche-build/issues/237) is delivered
by this wave, and [#240](https://github.com/OpenCoven/psyche-build/issues/240)
is delivered by this wave. Their closure is finalized in the owning issues by
linking this proof PR, sanitized policy evidence, the first apply, and the final
zero-operation run. Documentation and tests alone are not proof of those remote
state transitions.

For #31, the policy evidence must prove administrator enforcement plus a
single named PR-only owner bypass, `BunsDev`. Direct pushes remain
platform-blocked for `BunsDev`, all other actors require one approval, and the
retained evidence includes direct-push rejection proof. GitHub cannot create an
author self-approval review. When independent review is unavailable, `BunsDev`
uses the explicit PR-only bypass for an admin merge only after exact-head
checks succeed and conversations are resolved; this is not self-approval.

[PR #247](https://github.com/OpenCoven/psyche-build/pull/247) hardened the
supported desktop Git surface so repository-controlled signature-verification
configuration cannot execute commands during log inspection; bare repositories
remain inspectable through the isolated snapshot.

## Tracker and identity contract

| System | Owns | Must not become |
|---|---|---|
| GitHub issues and milestones | Public outcomes, accountable ownership, acceptance gates, support decisions, and externally legible status | A duplicate internal task graph |
| Beads | Internal implementation tasks and dependency ordering | Product support truth or Psyche Build's runtime identity model |
| Pull requests | Reviewable implementation slices and focused verification | Proof that a complete user path works merely because tests pass |
| Specs and plans | Design intent, decisions, and historical reasoning | Executable backlog or evidence that behavior shipped |
| Acceptance evidence | Runtime, policy, artifact, clean-install, and physical-device observations tied to immutable source | Unstructured screenshots or undocumented maintainer memory |

Protocol-owned familiar, thread, run, action, artifact, and receipt identities
must outlive Beads, tmux/process IDs, paths, branches, providers, transports,
and UI components. [#201](https://github.com/OpenCoven/psyche-build/issues/201)
owns future convergence.

## Priority definitions

- **P0 — supported-surface control or stabilization:** an active governance,
  tracker-integrity, data-preservation, recovery, or supported-release defect.
- **P1 — committed next capability:** independently gated product,
  reliability, architecture, or community work with an owner and exit gate.
- **P2 — future architecture:** discovery and design may proceed, but
  implementation cannot become an implicit prerequisite for P0/P1 delivery.

## Delivery graph

```text
Delivered foundation
  #194 macOS v0.0.1 ── #203 desktop/iOS release independence
             │
             ▼
Delivered Stage 0 control wave
  #238 via PR #245 + #31 governance + #237/#240 evidence closure
             │
             ▼
Next P0 critical path
  #196/#239 operator acceptance ──► #199/#243 operations
             │                              │
             ├──────────────────────────────┤
             ▼                              ▼
Independent iOS train                 Stable extraction seams
  #241 atomic readiness                    #197 desktop decomposition
      │                                      │
      ▼                                      ▼
  discovery + physical proof          #201 OpenCoven identity/Threads
      │
      ▼
  #242 publication → execution → UI
      │
      ▼
  internal TestFlight → later remote continuity

Parallel community floor
  #198/#244 security, ownership, support, and contribution readiness

Deferred P2 trains
  #201/#253 Psyche compatibility ── #246 cross-platform input parity
```

## Portfolio outcomes and closure state

| Outcome | Priority | Train | Close condition |
|---|---:|---|---|
| [#195 — roadmap and post-release control](https://github.com/OpenCoven/psyche-build/issues/195) | P0 | Portfolio | Every active outcome has one owner, priority, dependency chain, support decision, and evidence location |
| [#238 — critical-path documentation](https://github.com/OpenCoven/psyche-build/issues/238) | P0 | Documentation | **Delivered** by PR #245 / `5f4b7b05`; preserve it as completed Stage 0 foundation |
| [#31 — branch governance](https://github.com/OpenCoven/psyche-build/issues/31) | P0 | Governance | **Delivered by this wave** when the proof PR and sanitized protected-path evidence are linked in the issue |
| [#237 — Beads/mirror reconciliation](https://github.com/OpenCoven/psyche-build/issues/237) | P0 | Tracker integrity | **Delivered by this wave** when the reviewed mapping, first apply, and issue evidence links agree |
| [#240 — tracker drift validation](https://github.com/OpenCoven/psyche-build/issues/240) | P0 | Tracker integrity | **Delivered by this wave** when bounded validation and the final zero-operation run are linked in the issue |
| [#196 — `v0.0.1` stabilization](https://github.com/OpenCoven/psyche-build/issues/196) | P0 | Reliability | Supported ordinary and representative failure paths have operator-observed evidence |
| [#239 — operator acceptance manifest](https://github.com/OpenCoven/psyche-build/issues/239) | P0 | Reliability | One sanitized manifest ties exact-source smoke, lifecycle, persistence, Git/cleanup, and provider-isolation evidence to the release |
| [#200 — iOS internal beta and continuity](https://github.com/OpenCoven/psyche-build/issues/200) | P1 | iOS | An immutable physical build restores authoritative state, performs only wired scoped effects, reconnects, and fails closed on revocation |
| [#241 — atomic iOS readiness](https://github.com/OpenCoven/psyche-build/issues/241) | P1 | iOS | A focused state machine commits host authority before exposing a new workspace and deterministically rolls back every failure boundary |
| [#242 — production ritual path](https://github.com/OpenCoven/psyche-build/issues/242) | P1 | iOS | A live host publishes bounded rituals, executes through the registered authority path, and returns canonical state/receipts before controls appear |
| [#199 — operations, diagnostics, and recovery](https://github.com/OpenCoven/psyche-build/issues/199) | P1 | Reliability | Diagnostics are bounded/redacted and reusable failure harnesses recover deterministically |
| [#243 — support bundle v1](https://github.com/OpenCoven/psyche-build/issues/243) | P1 | Reliability | A versioned deterministic schema, strict bounds, automatic redaction, and fixture sample merge independently |
| [#198 — open-source readiness](https://github.com/OpenCoven/psyche-build/issues/198) | P1 | Community | External contributors can report, build, test, review, and submit changes without private maintainer knowledge |
| [#244 — minimum community floor](https://github.com/OpenCoven/psyche-build/issues/244) | P1 | Community | Security, CODEOWNERS, support, issue, PR, conduct, and protected-data guidance merge and remain validated |
| [#197 — desktop decomposition](https://github.com/OpenCoven/psyche-build/issues/197) | P1 | Architecture | Concentrated entry points compose independently testable capabilities without public/persisted contract drift |
| [#201 — OpenCoven identity and Threads](https://github.com/OpenCoven/psyche-build/issues/201) | P2 | OpenCoven | A cross-device reference flow preserves protocol-owned identity through execution, evidence, disconnect, and resume |
| [#253 — Psyche compatibility canary and adapters](https://github.com/OpenCoven/psyche-build/issues/253) | P2 | OpenCoven | Pin a consumable protocol profile and introduce bounded canaries/adapters without blocking supported-product work |
| [#246 — cross-platform Vim and keyboard-mode parity](https://github.com/OpenCoven/psyche-build/issues/246) | P2 | Input | Opt-in shared semantics preserve exact terminal passthrough and earn platform-specific evidence after prerequisite contracts stabilize |

## Pull-request disposition

This is a reconciliation snapshot. The PR and owning outcome remain the live
status sources.

| Pull request | Train | Disposition | Required replacement gate |
|---|---|---|---|
| [#236 — release documentation](https://github.com/OpenCoven/psyche-build/pull/236) | Documentation | **Closed as superseded** by PR #245 | Preserve discussion/history but do not force-update, reopen, or merge the stale branch |
| [#190 — graphics reporting](https://github.com/OpenCoven/psyche-build/pull/190) | #199/#243 diagnostics | **Source material only** | Extract bounded pieces after callback safety, readiness retry, schema bounds, and redaction are proven |
| [#193 — Bonjour/readiness](https://github.com/OpenCoven/psyche-build/pull/193) | #200 iOS | **Source material only** | Extract #241 first, then discovery/reconnect, then physical same-LAN acceptance |
| [#192 — mobile rituals](https://github.com/OpenCoven/psyche-build/pull/192) | #200 iOS | **Source material only** | Extract #242 publication, execution, and capability-gated UI in order after accepted readiness |
| [#262 — Psyche compatibility map](https://github.com/OpenCoven/psyche-build/pull/262) | #201/#253 | **Focused mapping slice** | Completes only #253 delivery slice 1; keep #253 open for the immutable pin, canary, adapters, and reference-flow evidence |

The source-material PRs above are not merge-ready. Rebase success, historical
green tests, source presence, or conflict resolution alone does not satisfy
their current contracts. PR #262 is the focused replacement for #254's mapping
scope and does not complete the broader #201/#253 outcome.

## Stage 0 — delivered control-state closure wave

**Owners:** #238, #31, #237, and #240.  
**Exit state:** when this proof PR merges and linked remote evidence is
completed, public docs, branch policy, Beads, generated mirrors, priorities,
and roadmap agree on delivered, active, blocked, and deferred work.

#238 remains delivered through PR #245 / `5f4b7b05`. #31, #237, and #240 are
Stage 0 closure items delivered by this wave. Finalize their closure by linking
the proof PR, policy evidence, first apply, and zero-operation run in the owning
issues. Keep the source-first sync, protected environments, canonical mapping,
and bounded drift validation intact. The #31 evidence records administrator
enforcement, the single named PR-only owner bypass, `BunsDev`, the absence of
team, app, or additional-user bypass actors, and direct-push rejection proof.
Direct pushes remain platform-blocked for `BunsDev`; all other actors require
approval, and the owner path is an explicit PR-only bypass/admin merge after
exact-head checks and resolved conversations, never a self-approval claim.

## Stage 1 — close the supported release stabilization baseline

**Owners:** #196 and #239.  
**Current gate:** #196/#239 are the next P0 critical path.

Retain exact-source tmux smoke, first-run/onboarding, terminal and agent lanes,
project/pane lifecycle, restart/recovery, Git/PR/cleanup, optional-provider
isolation, idempotency, receipt, revocation, and work-preservation evidence.
Every representative failure must terminate deterministically or enter an
explicit `recovery_required` state. Transfer reusable infrastructure gaps to
#199/#243 without reopening the completed #194 release.

## Stage 2 — deliver the iOS internal beta

**Owner:** #200.  
**Required order:** #241 → discovery/reconnect → physical same-LAN proof → #242
publication → #242 execution → capability-gated UI → immutable TestFlight.

#200/#241 retains its P1 dependency gate: atomic readiness must land before
later iOS capability work, and physical evidence remains required before the
support claim changes.

Bonjour remains a replaceable discovery adapter. Host identity and authority
must survive address and transport changes. No support status changes from
**Planned** to **Internal beta** until a distributed build repeats the physical
pairing, restoration, action/receipt, reconnect, host-restart, and revocation
matrix.

Remote/off-LAN continuity follows the first same-LAN internal beta and preserves
the same host, project, familiar, thread, run, action, artifact, and receipt
identities.

## Stage 3 — operationalize support and recovery

**Owners:** #199 and #243.

#199/#243 retains its P1 dependency gate: schema/redaction design may begin
during #239, while reusable failure harnesses follow observed #239 cases.

Define one versioned, deterministic support bundle with strict time, count,
record-size, and total-size bounds; automatic redaction; cancellation; and
truthful partial-failure semantics. Turn #239 observations into reusable
disposable failure-injection and recovery scenarios. Integrate only focused,
safe portions of #190 that materially improve this bounded contract.

## Stage 4 — establish contributor and security readiness

**Owners:** #198 and #244.

#198/#244 retains its P1 dependency gate: the minimum community floor may land
independently, but broad contributor-readiness claims require clean-checkout
evidence and must preserve delivered branch policy.

Land the minimum security, ownership, support, issue, PR, conduct, generated-file,
protected-data, and contribution floor independently. Then prove the broader
clean-checkout contributor loop and architecture map. Repository documentation
must link #31's actual settings evidence when claiming the policy is enforced.

## Stage 5 — decompose behind proven contracts

**Owner:** #197.  
**Depends on:** stable #196/#199 seams.

#197 retains its P1 dependency gate: implementation waits for stable #196/#199
contracts.

Extraction order:

1. application lifecycle and Tauri command registration;
2. workspace persistence and recovery;
3. pane, PTY, and process lifecycle;
4. browser and Git control;
5. desktop-web state, rendering, and event wiring.

Each PR preserves public commands, protocol schemas, persisted formats, errors,
security boundaries, generated outputs, user-visible behavior, and rollback.
This is not a framework rewrite or a visual redesign program.

## Stage 6 — converge on OpenCoven-native identity and execution

**Owners:** #201 and #253.

#201/#253 retains its P2 dependency gate: design and current-state mapping may
proceed, while the immutable pin waits for a consumable Psyche profile and
ownership-sensitive adapters wait for the cross-repository ownership decision.

Approve cross-repository ownership and compatibility contracts, wrap current
pane/worktree/provider behavior with protocol-owned identities, introduce
migrations and rollback, and connect Threads only after authority, receipt,
recovery, and continuity semantics are executable. Design may proceed early;
implementation cannot become an undeclared prerequisite for #196, #199, or
#200.

## Parallel P2 input train

**Owner:** #246.

#246 retains its P2 dependency gate: bounded semantic-core work may be promoted
explicitly, but broad cross-platform rollout follows stable input, persistence,
action, P0 stabilization, and the first iOS readiness seams. It must not become
an implicit prerequisite for #196, #199, or #200.

## Concurrency rules

- #196/#239 is the active P0 gate after the Stage 0 proof wave closes.
- #243 schema/redaction work may begin during #239; reusable failure scenarios
  wait for observed #239 cases.
- #244 may proceed independently but must not destabilize P0 or iOS contracts.
- #241 precedes every later iOS capability slice.
- #242 publication precedes execution; execution precedes mobile controls.
- #197 implementation waits for stable #196/#199 contracts.
- #201/#253 design may proceed; implementation cannot block #196, #199, or
  #200.
- #246 remains P2 until its prerequisite contracts are stable or a bounded
  slice is explicitly promoted.

## Evidence and merge rules

Every active outcome follows this chain:

```text
public outcome → dependency-ordered task → focused PR → exact-head checks and review
→ runtime/policy/artifact/physical evidence → tracker and support-state closure
```

A PR may merge only when its exact final head has terminal successful required
checks, no unresolved current review finding, canonical generated outputs, and
an explicit rollback or safe-recovery story where relevant. Documentation and
test counts are evidence of intent and coverage; they are not substitutes for
production composition, clean artifacts, physical devices, repository policy,
or operator-observed recovery.

## Roadmap maintenance rules

- Reconcile this file and [POST-RELEASE-EXECUTION.md](./POST-RELEASE-EXECUTION.md)
  whenever support status, priority, dependency, delivery train, or open-PR
  disposition changes.
- Update #195 in the same controlled state transition.
- Never close an outcome without durable evidence tied to immutable source.
- Never repair generated mirror state by treating generated issue bodies as the
  authoritative source.
- Never make iOS, diagnostics expansion, architecture cleanup, community work,
  or OpenCoven convergence an implicit macOS support prerequisite.
- Never let Beads, tmux, a process, path, branch, provider, transport, or UI
  selection become the only durable identity for user work.
