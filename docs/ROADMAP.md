# Psyche Build roadmap

**Status:** Active post-release roadmap  
**Accountable owner:** [@BunsDev](https://github.com/BunsDev)  
**Last reconciled:** 2026-09-06

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

The [v0.0.2 release](https://github.com/OpenCoven/psyche-build/releases/tag/v0.0.2)
was published on 2026-08-31 from signed tag source
`a4546f45bb0ee05cfbb388a0fc5f9e951596be51`, with both macOS DMGs and
`SHA256SUMS`. [Release run 33311851717](https://github.com/OpenCoven/psyche-build/actions/runs/33311851717)
completed desktop publication and skipped TestFlight. The Homebrew Cask still
selects `v0.0.1`; a successful tap notification is not proof of a Cask update.
Publication does not complete #239's operator acceptance, prove an upgrade
path, or change iOS availability. Keep the two releases' evidence separate.

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

### Delivered control-state foundation

[Issue #238](https://github.com/OpenCoven/psyche-build/issues/238) remains
delivered through [PR #245](https://github.com/OpenCoven/psyche-build/pull/245)
and merge commit `5f4b7b05`. Its critical-path documentation and retirement of
the superseded release-doc branch are completed foundation.

PRs [#248](https://github.com/OpenCoven/psyche-build/pull/248) and
[#249](https://github.com/OpenCoven/psyche-build/pull/249) landed the managed
Beads Project mirror, bounded GraphQL discovery/inventory caching, deterministic
drift checks, write fencing, and public-body sanitizer hardening. Production
synchronization is restricted to `main`, the manual environment is
Maintainer-gated, and the first live dry-run planned zero mutations with two
GraphQL queries.

The Stage 0 control-state wave is closed:

- [#240](https://github.com/OpenCoven/psyche-build/issues/240) closed on
  2026-08-28 after [PR #263](https://github.com/OpenCoven/psyche-build/pull/263)
  (`d3735ec4`) landed the repeatable source↔mirror drift validator;
  [PR #330](https://github.com/OpenCoven/psyche-build/pull/330) (`c2a8da8d`)
  later made it fail closed on render-hash, marker, and metadata drift.
- [#237](https://github.com/OpenCoven/psyche-build/issues/237) closed on
  2026-08-29 after `psyche-310`/#206 and `psyche-3i9`/#207 were reconciled
  source-first and no open generated issue carried `priority:P0`.
- [#31](https://github.com/OpenCoven/psyche-build/issues/31) closed on
  2026-08-30 with retained policy evidence: administrator-enforced required
  checks, a subsequently corrected bypass description, a `GH013` direct-push
  rejection probe, and proof
  [PR #283](https://github.com/OpenCoven/psyche-build/pull/283) merged through
  the protected path as `63667f30`.

The owning issues link that evidence. Documentation and tests alone were not
treated as proof of those remote state transitions.

The #31 correction and [PR #351](https://github.com/OpenCoven/psyche-build/pull/351)
(`23cace08`) supersede the original named-owner bypass claim. As of 2026-09-05,
the active `main` ruleset has no bypass actors and zero required approving
reviews. GitHub cannot create an author self-approval review. Administrator
enforcement, strict exact-head checks, linear history, and conversation/review
thread resolution remain required; direct pushes remain platform-blocked.
The historical direct-push rejection proof remains valid. Ordinary merges use
no admin override. Independent R3/R4 review remains a contributor requirement,
and an approval requirement should return when an independent reviewer is
available. [RELEASE.md](./RELEASE.md) owns the current policy procedure.

[PR #247](https://github.com/OpenCoven/psyche-build/pull/247) hardened the
supported desktop Git surface so repository-controlled signature-verification
configuration cannot execute commands during log inspection; bare repositories
remain inspectable through the isolated snapshot.

### Delivered since 2026-08-28

These merges advanced their owning outcomes without changing any support claim.
Each owning issue records the exact reviewed head, merge commit, and remaining
gates.

| Owning outcome | Merged slice | What it proves |
|---|---|---|
| [#244](https://github.com/OpenCoven/psyche-build/issues/244) — closed 2026-08-28 | [PR #261](https://github.com/OpenCoven/psyche-build/pull/261) (`267b8809`) | Security, CODEOWNERS, support, conduct, issue/PR intake, and protected-data floor |
| [#252](https://github.com/OpenCoven/psyche-build/issues/252) — closed 2026-08-28 | [PR #260](https://github.com/OpenCoven/psyche-build/pull/260) (`4d9f3184`) | Root agent entrypoint and deterministic bootstrap/check contract |
| [#198](https://github.com/OpenCoven/psyche-build/issues/198) — closed 2026-08-31 | [PR #321](https://github.com/OpenCoven/psyche-build/pull/321) (`3c188481`) plus #270–#273 | Clean-checkout contributor loop, repository map, and live community-profile evidence |
| [#243](https://github.com/OpenCoven/psyche-build/issues/243) — closed 2026-09-01 | [PR #278](https://github.com/OpenCoven/psyche-build/pull/278) (`69769cc5`) | Versioned, bounded, fail-closed support-bundle v1 schema and safe fixture; no production collector wiring, CLI, or UI |
| [#199](https://github.com/OpenCoven/psyche-build/issues/199) | [PR #283](https://github.com/OpenCoven/psyche-build/pull/283) (`63667f30`), [PR #281](https://github.com/OpenCoven/psyche-build/pull/281) (`91ed042c`) | Visible stale-identity and corrupt-config recovery; debug-authorized rendering stress harness (generated #230 was closed with it) |
| [#196](https://github.com/OpenCoven/psyche-build/issues/196) | [PR #336](https://github.com/OpenCoven/psyche-build/pull/336) (`7018ce53`) | Linearized desktop project lifecycle, persistence, and native-authority transactions; interactive packaged acceptance still required |
| [#279](https://github.com/OpenCoven/psyche-build/issues/279) | [PR #324](https://github.com/OpenCoven/psyche-build/pull/324) (`1642ab52`), [PR #328](https://github.com/OpenCoven/psyche-build/pull/328) (`0917ecbd`) | Capability-negotiated Coven launches with no prompt in argv or persisted launch metadata; serialized revocation and recovery |
| [#241](https://github.com/OpenCoven/psyche-build/issues/241) | [PR #326](https://github.com/OpenCoven/psyche-build/pull/326), [PR #329](https://github.com/OpenCoven/psyche-build/pull/329), [PR #335](https://github.com/OpenCoven/psyche-build/pull/335), [PR #337](https://github.com/OpenCoven/psyche-build/pull/337), [PR #338](https://github.com/OpenCoven/psyche-build/pull/338); behavior-preserving [PR #339](https://github.com/OpenCoven/psyche-build/pull/339) and [PR #341](https://github.com/OpenCoven/psyche-build/pull/341) | Readiness core, production `ConnectionManager` composition, fenced ready-host selection, and quarantine of indeterminate authority; simulator evidence only |
| [#280](https://github.com/OpenCoven/psyche-build/issues/280) | [PR #323](https://github.com/OpenCoven/psyche-build/pull/323) (`052ed006`) | Fail-closed single-use invite protocol, bounds, replay/expiry vectors, and generated fixtures; no pairing or revocation evidence |
| [#242](https://github.com/OpenCoven/psyche-build/issues/242) | [PR #322](https://github.com/OpenCoven/psyche-build/pull/322) (`efa8cc0a`) | Bounded, sanitized ritual publication through the live workspace provider with explicit degraded states; execution and controls not included |
| [#246](https://github.com/OpenCoven/psyche-build/issues/246) | [PR #327](https://github.com/OpenCoven/psyche-build/pull/327) (`2111db7e`) | Shared Vim v1 fixture contract and fail-closed loader under `protocol-fixtures/vim/v1/`; no platform adapter or parity claim |
| [#195](https://github.com/OpenCoven/psyche-build/issues/195) | [PR #330](https://github.com/OpenCoven/psyche-build/pull/330) (`c2a8da8d`) | Fail-closed tracker drift validation with bounded, sanitized findings |
| [#197](https://github.com/OpenCoven/psyche-build/issues/197) | [PR #362](https://github.com/OpenCoven/psyche-build/pull/362) (`10eed172`), [PR #366](https://github.com/OpenCoven/psyche-build/pull/366) (`081d1f95`), [PR #369](https://github.com/OpenCoven/psyche-build/pull/369) (`4cee937f`), [PR #370](https://github.com/OpenCoven/psyche-build/pull/370) (`a7927dae`), [PR #371](https://github.com/OpenCoven/psyche-build/pull/371) (`5464c931`), [PR #372](https://github.com/OpenCoven/psyche-build/pull/372) (`60eeb6cc`) | Composition root, secure filesystem, path vocabulary, restore helpers, module cfg guards, and initial-workspace transaction finishing; source decomposition, not packaged acceptance |
| [#197](https://github.com/OpenCoven/psyche-build/issues/197) | [PR #373](https://github.com/OpenCoven/psyche-build/pull/373) (`81a9c754`) | Stage/verify/publish function boundary and named `PublishedWorkspace` result; commit/rollback context remains explicit, atomic publication is not yet a separate module |

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
  #238 via PR #245 + #31 governance + #237/#240 tracker closure
             │
             ▼
Active P0 critical path
  #196/#239 operator acceptance ──► #199 operations (#243 schema delivered)
             │                              │
             ├──────────────────────────────┤
             ▼                              ▼
Independent iOS train                 Stable extraction seams
  #241 atomic readiness                    #197 desktop decomposition
  (core/composition merged;                  │
   physical proof open)                      ▼
      │                               #201 OpenCoven identity/Threads
      ▼                                 (#253 canary, #279 Coven adapter)
  #280 invite auth (slice 1 merged)
      │
      ▼
  discovery/reconnect + physical proof
      │
      ▼
  #242 publication (merged) → execution → UI
      │
      ▼
  internal TestFlight → later remote continuity

Delivered community floor
  #198/#244 security, ownership, support, and contribution readiness (closed)

Deferred P2 trains
  #201/#253 Psyche compatibility ── #279 Coven adapter ── #246 input parity
```

## Portfolio outcomes and closure state

| Outcome | Priority | Train | Close condition |
|---|---:|---|---|
| [#195 — roadmap and post-release control](https://github.com/OpenCoven/psyche-build/issues/195) | P0 | Portfolio | Every active outcome has one owner, priority, dependency chain, support decision, and evidence location; the scheduled Beads mirror sync is healthy again (#342) |
| [#238 — critical-path documentation](https://github.com/OpenCoven/psyche-build/issues/238) | P0 | Documentation | **Delivered** by PR #245 / `5f4b7b05`; preserve it as completed Stage 0 foundation |
| [#31 — branch governance](https://github.com/OpenCoven/psyche-build/issues/31) | P0 | Governance | **Delivered** — closed 2026-08-30 with sanitized ruleset/protection evidence, direct-push rejection proof, and protected proof PR #283 |
| [#237 — Beads/mirror reconciliation](https://github.com/OpenCoven/psyche-build/issues/237) | P0 | Tracker integrity | **Delivered** — closed 2026-08-29 after source-first Beads reconciliation left no open generated `priority:P0` mirror |
| [#240 — tracker drift validation](https://github.com/OpenCoven/psyche-build/issues/240) | P0 | Tracker integrity | **Delivered** — closed 2026-08-28 by PR #263; hardened by PR #330 |
| [#196 — `v0.0.1` stabilization](https://github.com/OpenCoven/psyche-build/issues/196) | P0 | Reliability | Supported ordinary and representative failure paths have operator-observed evidence; PRs #283 and #336 are merged remediation, not released re-observation |
| [#239 — operator acceptance manifest](https://github.com/OpenCoven/psyche-build/issues/239) | P0 | Reliability | One sanitized manifest ties exact-source smoke, lifecycle, persistence, Git/cleanup, and provider-isolation evidence to the release; it currently verifies 15 digests and reports `terminal_state: incomplete` |
| [#200 — iOS internal beta and continuity](https://github.com/OpenCoven/psyche-build/issues/200) | P1 | iOS | An immutable physical build restores authoritative state, performs only wired scoped effects, reconnects, and fails closed on revocation |
| [#241 — atomic iOS readiness](https://github.com/OpenCoven/psyche-build/issues/241) | P1 | iOS | Readiness core (#326), production composition (#329), and ready-selection hardening (#335/#337/#338) are merged; discovery/reconnect UX, lifecycle acceptance, physical-device, and real-Keychain partial-write evidence remain open |
| [#280 — single-use iOS invite authentication](https://github.com/OpenCoven/psyche-build/issues/280) | P1 | iOS | The protocol/fixture slice merged in PR #323; desktop issuer, iOS credential exchange, QR/deep-link UX, physical acceptance, and distribution evidence remain open |
| [#242 — production ritual path](https://github.com/OpenCoven/psyche-build/issues/242) | P1 | iOS | Publication merged in PR #322; the registered execution path, canonical receipts, and capability-gated controls remain open |
| [#199 — operations, diagnostics, and recovery](https://github.com/OpenCoven/psyche-build/issues/199) | P1 | Reliability | Diagnostics are bounded/redacted and reusable failure harnesses recover deterministically; the harness is delivered through PRs #354-#359 with CI-retained evidence, and the support-bundle production surface plus provider/upgrade scenarios remain open |
| [#243 — support bundle v1](https://github.com/OpenCoven/psyche-build/issues/243) | P1 | Reliability | **Delivered** — closed 2026-09-01 by PR #278 (`69769cc5`); schema, bounds, redaction, and fixture only |
| [#198 — open-source readiness](https://github.com/OpenCoven/psyche-build/issues/198) | P1 | Community | **Delivered** — closed 2026-08-31 by PR #321 (`3c188481`) with a credential-free clean-checkout run and live community-profile evidence |
| [#244 — minimum community floor](https://github.com/OpenCoven/psyche-build/issues/244) | P1 | Community | **Delivered** — closed 2026-08-28 by PR #261 (`267b8809`) |
| [#197 — desktop decomposition](https://github.com/OpenCoven/psyche-build/issues/197) | P1 | Architecture | Early lifecycle and persistence extractions are merged; publication/recovery decomposition and packaged acceptance remain, with stable #196/#199 contracts still required |
| [#201 — OpenCoven identity and Threads](https://github.com/OpenCoven/psyche-build/issues/201) | P2 | OpenCoven | A cross-device reference flow preserves protocol-owned identity through execution, evidence, disconnect, and resume |
| [#253 — Psyche compatibility canary and adapters](https://github.com/OpenCoven/psyche-build/issues/253) | P2 | OpenCoven | Pin a consumable protocol profile and introduce bounded canaries/adapters without blocking supported-product work; the pin waits on `OpenCoven/psyche#11` and `#12` |
| [#279 — Coven launch adapter](https://github.com/OpenCoven/psyche-build/issues/279) | P2 | OpenCoven | Capability-negotiated launches keep prompts out of argv and persisted metadata (PRs #324/#328/#336 merged); live restart/reconnect recovery, canonical runtime receipts, and migration/rollback evidence remain open, and receipt semantics wait on #253 |
| [#246 — cross-platform Vim and keyboard-mode parity](https://github.com/OpenCoven/psyche-build/issues/246) | P2 | Input | Opt-in shared semantics preserve exact terminal passthrough and earn platform-specific evidence after prerequisite contracts stabilize; the shared v1 fixture contract merged in PR #327 |

## Pull-request disposition

This is a reconciliation snapshot. The PR and owning outcome remain the live
status sources; use the [live PR list](https://github.com/OpenCoven/psyche-build/pulls)
for current work rather than treating this historical disposition table as a queue.

| Pull request | Train | Disposition | Required replacement gate |
|---|---|---|---|
| [#236 — release documentation](https://github.com/OpenCoven/psyche-build/pull/236) | Documentation | **Closed as superseded** by PR #245 | Preserve discussion/history but do not force-update, reopen, or merge the stale branch |
| [#190 — graphics reporting](https://github.com/OpenCoven/psyche-build/pull/190) | #199 diagnostics | **Source material only** (closed 2026-08-28) | Extract bounded pieces after callback safety, readiness retry, schema bounds, and redaction are proven; PR #281 already extracted the stress harness |
| [#193 — Bonjour/readiness](https://github.com/OpenCoven/psyche-build/pull/193) | #200 iOS | **Source material only** (closed 2026-08-28) | #241 extracted the readiness core and composition; discovery/reconnect and physical same-LAN acceptance remain |
| [#192 — mobile rituals](https://github.com/OpenCoven/psyche-build/pull/192) | #200 iOS | **Source material only** (closed 2026-08-28) | PR #322 extracted publication; #242 execution and capability-gated UI follow in order |
| [#264 — iOS invite authentication](https://github.com/OpenCoven/psyche-build/pull/264) | #200/#280 | **Source material only** (closed 2026-08-31) | Extract focused R3 slices in #280 order; slice 1 landed in PR #323 |
| [#254 — Psyche compatibility map](https://github.com/OpenCoven/psyche-build/pull/254) | #201/#253 | **Source material only** (closed 2026-08-28) | PR #254 remains outside Stage 0; its useful mapping material re-entered through the focused replacement slice |
| [#262 — Psyche compatibility map](https://github.com/OpenCoven/psyche-build/pull/262) | #201/#253 | **Merged** (`73dc6f5d`) focused mapping slice | Completes only #253 delivery slice 1; keep #253 open for the immutable pin, canary, adapters, and reference-flow evidence |
| [#277 — Coven launch routing](https://github.com/OpenCoven/psyche-build/pull/277) | #201/#279 | **Merged direction slice**, corrected by PRs #324, #328, and #336 | Remaining #279 gates are live recovery, canonical receipt, and rollback evidence |
| [#322 — ritual publication](https://github.com/OpenCoven/psyche-build/pull/322) | #200/#242 | **Merged** (`efa8cc0a`) | Publication only; execution and mobile controls follow in #242 order |
| [#323 — invite-auth protocol](https://github.com/OpenCoven/psyche-build/pull/323) | #200/#280 | **Merged** (`052ed006`) | Protocol/fixture slice only; no pairing, revocation, or support-state claim |

The source-material PRs above are not merge-ready and are closed. Rebase
success, historical green tests, source presence, or conflict resolution alone
does not satisfy their contracts; their useful content re-enters only through
focused current-main slices. PR #262 is the focused replacement for #254's mapping scope
and does not complete the broader #201/#253 outcome.

A replacement must start from current `main`, have one owning outcome and
acceptance gate, and pass required checks on its exact final head.

## Stage 0 — delivered control-state closure wave

**Owners:** #238, #31, #237, and #240.  
**Exit state:** reached. Public docs, branch policy, Beads, generated mirrors,
priorities, and roadmap agree on delivered, active, blocked, and deferred work
as of this reconciliation.

#238 remains delivered through PR #245 / `5f4b7b05`. #240 closed through PR
#263, #237 closed after source-first reconciliation, and #31 closed with the
policy evidence recorded above and corrected by PR #351. Keep the source-first
sync, protected environments, canonical mapping, and bounded drift validation
intact. Direct pushes remain platform-blocked; ordinary PR merges require
exact-head checks and resolved conversations, with no standing bypass.

One control-state regression was opened and resolved in this window: the
scheduled Beads Project sync failed on every scheduled run from 2026-08-30
until 2026-09-02 after an accidental Beads v1.2.1 binary on one checkout
migrated the shared Dolt schema and published it. The recovery retained Git
sidecar `9c85d2b79e3da16c283278824866a5ba1217950a` and published Dolt transition
`0at1pk83ng4ogm45svvp7ip122acgt4h` →
`go64gshichpnsj3islhl6pmv5lgi2teb`, restoring schema v53, re-tracking the
versioned `events` table, and preserving 111 Beads. The 1,362 event rows are the
last durable 1,361-row pre-ignore snapshot plus the publication transition.
Three known post-ignore writes retain their commits and final source state but
not their clone-local event rows, leaving a bounded three-write audit gap.

Scheduled apply
[33880014833](https://github.com/OpenCoven/psyche-build/actions/runs/33880014833)
executed source head `9e4a9cf383a1993ca2c2099e3d296acb3dd3c5b4` on 2026-09-04 and
performed seven operations; from the authoritative
`psyche-z7c.4.4` source, the synchronizer regenerated mirror #230 and made the
live read-only validator exit `0` with 111 sources, 27 managed mirrors, 24 canonical
outcomes, and 0 findings. The following scheduled apply
[33953178586](https://github.com/OpenCoven/psyche-build/actions/runs/33953178586)
executed source head `23cace08fdc5e35e3ee0cd46200b4ed3bbd94131` on 2026-09-05,
planned and applied 0 operations, completed every step without warnings or
visibility drift, and retained schema v53.

Mirror #230 was regenerated after its authoritative source entered closed state.
It has never been manually edited since the first run; generated-body repair did
not supply this proof.

The provenance and mirror deviations remain explicit: PR #346 reviewed
unpublished candidate `l3c2l93j2iogl4h3ai947qls2vr10tbp`, but another checkout
published `go64gshichpnsj3islhl6pmv5lgi2teb`, so the exact-candidate gate did
not hold despite matching intended logical state. Mirror #230 first entered the
closed state through GitHub keyword syntax at that PR's merge rather than the
synchronizer. PR #350 documented recovery before the second qualifying run and
omitted this documentation contract assertion; it is not closeout proof.
[#342](https://github.com/OpenCoven/psyche-build/issues/342) holds the
evidence under #195.

## Stage 1 — close the supported release stabilization baseline

**Owners:** #196 and #239.  
**Current gate:** #196/#239 remain the active P0 critical path.

Retain exact-source tmux smoke, first-run/onboarding, terminal and agent lanes,
project/pane lifecycle, restart/recovery, Git/PR/cleanup, optional-provider
isolation, idempotency, receipt, revocation, and work-preservation evidence.
Every representative failure must terminate deterministically or enter an
explicit `recovery_required` state. Transfer reusable infrastructure gaps to
#199 without reopening the completed #194 release.

The latest #239 evidence update records 15 retained evidence digests and
`terminal_state: incomplete`. #196 was reopened on 2026-09-06 after PR #350's
quoted closing phrase changed its tracker state without acceptance evidence.
That closure was not completion of the outcome.

PRs #283 and #336 merged current-source
remediation for the observed recovery defects; that does not replace the
released `v0.0.1` partial/failed classifications until it is released and
re-observed.

## Stage 2 — deliver the iOS internal beta

**Owner:** #200.  
**Required order:** #241 → #280 invite authentication → discovery/reconnect →
physical same-LAN proof → #242 publication → #242 execution → capability-gated
UI → immutable TestFlight.

#200/#241 retains its P1 dependency gate: atomic readiness must land before
later iOS capability work, and physical evidence remains required before the
support claim changes.

Merged so far: the #241 readiness core, production composition, and
ready-selection hardening; the #280 protocol/fixture slice; and the #242
publication slice. All of it is simulator, fixture, and CI evidence. Still
open: discovery/reconnect UX, lifecycle acceptance, physical same-LAN proof,
real-Keychain partial-write evidence, the #280 desktop issuer and iOS exchange,
#242 execution and controls, and the TestFlight matrix.

Bonjour remains a replaceable discovery adapter. Host identity and authority
must survive address and transport changes. No support status changes from
**Planned** to **Internal beta** until a distributed build repeats the physical
pairing, restoration, action/receipt, reconnect, host-restart, and revocation
matrix.

Remote/off-LAN continuity follows the first same-LAN internal beta and preserves
the same host, project, familiar, thread, run, action, artifact, and receipt
identities.

## Stage 3 — operationalize support and recovery

**Owner:** #199 (#243 delivered).

#199/#243 retains its P1 dependency gate for the scenarios that remain:
unavailable providers and upgrade recovery still follow observed #239 operator
cases rather than being inferred.

The #243 schema slice is delivered through PR #278, and the reusable
disposable failure-injection and recovery harness is delivered through
PRs #354-#359. It covers six scenarios against the real production paths —
corrupt pane config, stale config lease, unwritable state storage, duplicate
command retry, stale owner epoch, and interrupted-cleanup recovery evidence —
runs from a clean checkout as `pnpm recovery:harness`, and runs in the Quality
CI job with its report retained as a build artifact.

An additional source scenario now interrupts the real cleanup worker before
Git mutation, recovers its project lease, and proves a fresh retry respects an
explicit harness/operator recovery marker. It includes a successful clean
cleanup control and does not claim mid-Git interruption, automatic crash
reconciliation, or packaged acceptance.

The merged support-bundle v1 contract is versioned, deterministic, bounded by
time, count, record, and total size, cancellable, and redacts by default. It
has no production collector wiring, CLI, or UI yet.

#199 remains open. The harness covers the failure classes reachable without a
running application; unavailable providers, upgrade recovery, and full
mid-flight cleanup interruption are deliberately uncovered, and the
support-bundle production surface is unbuilt. Those follow observed #239
operator cases rather than being inferred, and only focused, safe portions of
former PR #190 should be integrated where they materially improve the bounded
contract.

## Stage 4 — contributor and security readiness (delivered)

**Owners:** #198 and #244.

#198/#244 is delivered: PR #261 landed the minimum security, ownership,
support, issue, PR, conduct, generated-file, protected-data, and contribution
floor, and PR #321 closed the broader clean-checkout contributor loop with a
credential-free acceptance run and live community-profile evidence. The former
dependency gate no longer sequences work. Repository documentation links #31's
retained settings evidence when claiming the policy is enforced.

## Stage 5 — decompose behind proven contracts

**Owner:** #197.  
**Depends on:** stable #196/#199 seams.

#197 retains its P1 dependency gate: implementation waits for stable #196/#199
contracts at each extracted boundary, not for a blanket claim that all
acceptance is complete. Early lifecycle and persistence extractions have
landed as recorded above; #197 is not merely an inventory exercise anymore.
The [slice 2 design record](./superpowers/specs/2026-09-06-workspace-persistence-decomposition-design.md)
explains the measured boundaries, not a separate executable backlog.

Extraction order:

1. application lifecycle and Tauri command registration;
2. workspace persistence and recovery;
3. pane, PTY, and process lifecycle;
4. browser and Git control;
5. desktop-web state, rendering, and event wiring.

Each PR preserves public commands, protocol schemas, persisted formats, errors,
security boundaries, generated outputs, user-visible behavior, and rollback.
This is not a framework rewrite or a visual redesign program.

PR #372 splits initial-workspace transaction finishing; PR #373 subsequently
extracts stage/verify/publish with a named `PublishedWorkspace` result. Moving
atomic publication into a separate module remains a distinct slice that must
preserve the open file and rollback context crossing that boundary. Neither
source decomposition nor the recovery harness substitutes for #239's packaged
operator observations.

## Stage 6 — converge on OpenCoven-native identity and execution

**Owners:** #201, #253, and #279.

#201/#253 retains its P2 dependency gate: design and current-state mapping may
proceed, while the immutable pin waits for a consumable Psyche profile and
ownership-sensitive adapters wait for the cross-repository ownership decision.

#279 is the bounded product-to-Coven launch adapter under #201. Its merged
slices negotiate the pinned Coven daemon profile and installed harness
capabilities, transport prompts only in the bounded daemon request body, and
serialize revocation and recovery. Live restart/reconnect recovery,
migration/rollback observation, and a reference launch remain open; canonical
runtime receipts wait on the #253 protocol pin rather than being invented
locally.

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
an implicit prerequisite for #196, #199, or #200. PR #327 merged the shared v1
fixture contract as the explicitly bounded first slice; no platform parity is
claimed from it.

## Concurrency rules

- #196/#239 is the active P0 gate.
- #199 reusable failure scenarios wait for observed #239 cases; the #243 schema
  slice is already delivered.
- #241 precedes every later iOS capability slice; #280 composes into it.
- #242 publication precedes execution; execution precedes mobile controls.
- #197 implementation waits for stable #196/#199 contracts.
- #201/#253/#279 design and bounded adapters may proceed; implementation cannot
  block #196, #199, or #200.
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
