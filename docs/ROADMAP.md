# Psyche Build roadmap

**Status:** Active post-release roadmap  
**Accountable owner:** [@BunsDev](https://github.com/BunsDev)  
**Last reconciled:** 2026-08-24  
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
Post-release control
  #238 docs ── #31 governance ── #237/#240 tracker integrity
             │
             ▼
Supported-surface stabilization
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
```

## Active portfolio outcomes

| Outcome | Priority | Train | Close condition |
|---|---:|---|---|
| [#195 — roadmap and post-release control](https://github.com/OpenCoven/psyche-build/issues/195) | P0 | Portfolio | Every active outcome has one owner, priority, dependency chain, support decision, and evidence location |
| [#238 — critical-path documentation](https://github.com/OpenCoven/psyche-build/issues/238) | P0 | Documentation | The current-main replacement plan and tests merge, stale #236 is retired, and #195 is reconciled |
| [#31 — branch governance](https://github.com/OpenCoven/psyche-build/issues/31) | P0 | Governance | Required checks/review apply to administrators, standing bypasses are removed, and a protected proof PR is retained |
| [#237 — Beads/mirror reconciliation](https://github.com/OpenCoven/psyche-build/issues/237) | P0 | Tracker integrity | Beads, mirrors, priorities, ownership, and completed release state agree |
| [#240 — tracker drift validation](https://github.com/OpenCoven/psyche-build/issues/240) | P0 | Tracker integrity | Deterministic validation reports status, priority, mapping, and mirror drift before it affects roadmap decisions |
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

## Open pull-request disposition

This is a reconciliation snapshot. The PR and owning outcome remain the live
status sources.

| Pull request | Train | Disposition | Required replacement gate |
|---|---|---|---|
| [#236 — release documentation](https://github.com/OpenCoven/psyche-build/pull/236) | Documentation | **Superseded** | Close after #238's current-main replacement merges; preserve discussion/history but do not force-update or merge the stale branch |
| [#190 — graphics reporting](https://github.com/OpenCoven/psyche-build/pull/190) | #199/#243 diagnostics | **Source material only** | Extract bounded pieces after callback safety, readiness retry, schema bounds, and redaction are proven |
| [#193 — Bonjour/readiness](https://github.com/OpenCoven/psyche-build/pull/193) | #200 iOS | **Source material only** | Extract #241 first, then discovery/reconnect, then physical same-LAN acceptance |
| [#192 — mobile rituals](https://github.com/OpenCoven/psyche-build/pull/192) | #200 iOS | **Source material only** | Extract #242 publication, execution, and capability-gated UI in order after accepted readiness |

No open PR above is merge-ready. Rebase success, historical green tests, source
presence, or conflict resolution alone does not satisfy its current contract.

## Stage 0 — restore trustworthy control state

**Owners:** #238, #31, #237, and #240.  
**Exit:** public docs, branch policy, Beads, generated mirrors, priorities, and
roadmap agree on delivered, active, blocked, and deferred work.

1. Merge the #238 current-main documentation replacement and retire #236.
2. Enforce required checks/review for administrators and prove the policy with
   sanitized before/after state plus a protected PR.
3. Repair completed release state and current priorities in Beads first.
4. Synchronize mirrors and add repeatable drift validation.
5. Require routine tracker and documentation changes to use the reviewed PR
   path.

## Stage 1 — close the supported release stabilization baseline

**Owners:** #196 and #239.  
**May proceed during Stage 0:** yes.

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

Define one versioned, deterministic support bundle with strict time, count,
record-size, and total-size bounds; automatic redaction; cancellation; and
truthful partial-failure semantics. Turn #239 observations into reusable
disposable failure-injection and recovery scenarios. Integrate only focused,
safe portions of #190 that materially improve this bounded contract.

## Stage 4 — establish contributor and security readiness

**Owners:** #198 and #244.

Land the minimum security, ownership, support, issue, PR, conduct, generated-file,
protected-data, and contribution floor independently. Then prove the broader
clean-checkout contributor loop and architecture map. Repository documentation
must not claim #31 policy is enforced until #31 links actual settings evidence.

## Stage 5 — decompose behind proven contracts

**Owner:** #197.  
**Depends on:** stable #196/#199 seams.

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

**Owner:** #201.

Approve cross-repository ownership and compatibility contracts, wrap current
pane/worktree/provider behavior with protocol-owned identities, introduce
migrations and rollback, and connect Threads only after authority, receipt,
recovery, and continuity semantics are executable. Design may proceed early;
implementation cannot become an undeclared prerequisite for #196, #199, or
#200.

## Concurrency rules

- #238, #31, #237/#240, and #239 may proceed in parallel on non-overlapping
  seams.
- #243 schema/redaction work may begin during #239; reusable failure scenarios
  wait for observed #239 cases.
- #244 may proceed independently but must not destabilize P0 or iOS contracts.
- #241 precedes every later iOS capability slice.
- #242 publication precedes execution; execution precedes mobile controls.
- #197 implementation waits for stable #196/#199 contracts.
- #201 design may proceed; implementation cannot block #196, #199, or #200.

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
