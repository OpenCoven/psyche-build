# Psyche Build roadmap

**Status:** Active  
**Accountable owner:** [@BunsDev](https://github.com/BunsDev)  
**Last reconciled:** 2026-08-22  
**Execution control:** [#195](https://github.com/OpenCoven/psyche-build/issues/195)

This is the canonical public roadmap for Psyche Build. It translates the
approved [release-first improvement program](https://github.com/OpenCoven/psyche-build/blob/main/docs/superpowers/specs/2026-08-21-psyche-build-release-first-improvement-program-design.md)
into current outcomes, dependencies, gates, and delivery trains.

The dated design record explains why the sequence exists. This document says
what is active now. GitHub issues and pull requests carry live status, Beads
carry internal task dependencies, pull requests carry implementation and
focused proof, and retained acceptance evidence determines whether a phase is
complete.

## North star

Psyche Build is OpenCoven's local-first cockpit for visible, scoped, and
recoverable familiar work. The current product proves that foundation through
projects, terminal panes, isolated worktrees, explicit integrations, bounded
control, and companion surfaces.

The immediate objective is narrower: publish the first credible macOS release
without making iOS completion, broad architecture cleanup, cloud
infrastructure, or future Threads/AgentFS convergence product prerequisites.
Accidental workflow coupling is treated as a release-infrastructure defect,
not as a reason to expand the supported surface.

## Tracker and identity contract

| System | Owns | Must not become |
|---|---|---|
| GitHub issues and milestones | Public outcomes, accountable ownership, acceptance gates, and externally legible status | A duplicate implementation task graph |
| Beads | Internal implementation tasks, dependency ordering, and execution detail | Psyche Build's canonical runtime task or identity model |
| Pull requests | Reviewable implementation slices and focused verification | Evidence that the complete user path works merely because unit tests pass |
| Specs and plans | Design intent, decisions, and historical reasoning | Executable backlog or proof that behavior shipped |
| Acceptance evidence | Runtime observations tied to an immutable commit and artifact | Unstructured screenshots or undocumented maintainer memory |

Protocol-owned identities must outlive trackers, tmux pane IDs, process IDs,
filesystem paths, provider sessions, transports, and UI components. Future
identity and Threads convergence is tracked in
[#201](https://github.com/OpenCoven/psyche-build/issues/201).

## Priority definitions

- **P0 — release critical:** required before the public macOS installation path
  is verified.
- **P1 — next operational capability:** begins independently when it does not
  overlap a P0 seam; it does not move the release candidate.
- **P2 — future architecture:** design and dependency discovery may proceed,
  but implementation cannot become an implicit release prerequisite.

## Supported-surface contract

The detailed contract lives in [SUPPORT-MATRIX.md](./SUPPORT-MATRIX.md).
For `v0.0.1`:

- the signed macOS application is the only planned public binary
  distribution;
- the TUI/Node CLI remains a supported source-development interface and is not
  a separate npm release;
- iOS is a planned internal companion beta with no live TestFlight availability
  claim until #200's distributed-build and physical-device gates pass;
- Windows and Linux are compilation-compatibility targets, not published
  applications;
- Coven and other typed providers are optional and must fail in isolation;
- remote/off-LAN mobile continuity, cloud execution, team collaboration,
  marketplace behavior, and complete Threads/AgentFS integration are not
  release claims.

## Delivery graph

```text
#195 Authoritative roadmap
    ├─ reconcile Beads, plans, and pull requests
    ├─ freeze the supported-surface contract
    └─ keep active ownership and evidence links current
                    │
                    ▼
#196 Release reliability baseline ─────────────┐
                                              │
#31 Credentials and protections ──────────────┤
                                              │
#203 Desktop-only workflow independence ──────┤
                                              ▼
                                  freeze exact main SHA
                                              │
                                              ▼
                                  #194 Publish v0.0.1
                                     │              │
                                     ▼              ▼
                         #199 Operations       #197 Architecture
                           and recovery          decomposition
                                     │              │
                                     └──────┬───────┘
                                            ▼
                                 #201 OpenCoven identity
                                 and Threads convergence

Planned independent companion train:
#200 iOS connection correctness
    ├─ #193 host discovery/readiness
    ├─ #192 live ritual publication/execution
    ├─ internal TestFlight acceptance
    └─ later durable remote continuity

Community train:
#198 security and contributor readiness
    ├─ minimum security/ownership floor may proceed now
    └─ complete community-health gate follows release stabilization
```

## Active outcomes

| Outcome | Priority | Train | Dependency and close condition |
|---|---:|---|---|
| [#195 — authoritative roadmap](https://github.com/OpenCoven/psyche-build/issues/195) | P0 | Roadmap | All active work has one owner, one delivery target, explicit dependencies, and an evidence location |
| [#196 — release reliability baseline](https://github.com/OpenCoven/psyche-build/issues/196) | P0 | Reliability | Every supported release-path capability is executable and proven, absent, or explicitly deferred |
| [#31 — protected release credentials](https://github.com/OpenCoven/psyche-build/issues/31) | P0 | Release | Required desktop secrets and protections are verified without exposing values |
| [#203 — desktop-only workflow independence](https://github.com/OpenCoven/psyche-build/issues/203) | P0 | Release infrastructure | Offline contract tests pass and a live protected desktop-only dry run proves both macOS builds and publication without iOS gates |
| [#194 — ship macOS `v0.0.1`](https://github.com/OpenCoven/psyche-build/issues/194) | P0 | Release | Signed/notarized dual-architecture artifacts and Homebrew installation are independently verified |
| [#200 — iOS companion delivery](https://github.com/OpenCoven/psyche-build/issues/200) | P1 | iOS | Physical distributed build connects, restores authoritative state, and executes only wired scoped actions |
| [#199 — operations and recovery](https://github.com/OpenCoven/psyche-build/issues/199) | P1 | Reliability | Diagnostics are bounded/redacted and representative failures recover deterministically with retained evidence |
| [#197 — desktop decomposition](https://github.com/OpenCoven/psyche-build/issues/197) | P1 | Architecture | Entry points compose capability modules while public commands, schemas, persistence, and behavior remain compatible |
| [#198 — open-source readiness](https://github.com/OpenCoven/psyche-build/issues/198) | P1 | Community | Security, ownership, support, contribution, conduct, issue, and PR surfaces are complete and usable from a clean checkout |
| [#201 — identity and Threads convergence](https://github.com/OpenCoven/psyche-build/issues/201) | P2 | OpenCoven | Protocol ownership, compatibility, migration, and an end-to-end cross-device reference flow are approved and executable |

## Active pull-request disposition

This table is a reconciliation snapshot as of 2026-08-22. The pull request and
its owning outcome remain the live status sources.

| Pull request | Train | Disposition | Required next gate |
|---|---|---|---|
| [#202 — canonical release-first roadmap](https://github.com/OpenCoven/psyche-build/pull/202) | Roadmap/control | Current implementation | Resolve every current review finding, pass required CI on the final head, and merge; afterward this row remains the delivery record for the canonical roadmap |
| [#191 — siderail project closing](https://github.com/OpenCoven/psyche-build/pull/191) | macOS release | Candidate | Rebase on the selected release base, rerun required checks, verify no unresolved current review findings, then merge before candidate freeze |
| [#190 — graphics acceleration reporting](https://github.com/OpenCoven/psyche-build/pull/190) | Post-release diagnostics | Defer from `v0.0.1` unless acceptance proves it is required | Resolve startup callback-safety and unavailable-invoke retry findings; integrate through #199's bounded diagnostic contract |
| [#192 — mobile ritual controls](https://github.com/OpenCoven/psyche-build/pull/192) | iOS | Blocked | Wire the real mobile executor and publish rituals through the production workspace provider; prove the live host path before merge |
| [#193 — Bonjour connection flow](https://github.com/OpenCoven/psyche-build/pull/193) | iOS | Blocked | Make workspace readiness atomic, complete required CI, and pass physical same-LAN acceptance before merge |

After #191 and any proven P0 fix land, freeze the release candidate. A later
change may enter the candidate only when it names the failed acceptance case it
repairs and the full candidate gate is rerun.

## Stage 0 — reconcile control state

**Owner:** #195  
**Exit gate:** no unowned P0 work, ambiguous release blocker, overlapping
unreconciled pull request, or blocked write in the authoritative task tracker.

- designate exactly one Beads schema migrator;
- map each active Bead to one public outcome or an explicit internal
  maintenance bucket;
- mark every historical spec or plan as active, implemented, superseded, or
  reference without rewriting its history;
- keep owners, priorities, dependencies, and evidence links current;
- keep the support matrix aligned with actual distribution and runtime proof;
- remove legacy ecosystem product metadata and obsolete keywords before
  candidate freeze.

## Stage 1 — establish the macOS release baseline

**Owner:** #196  
**Exit gate:** one clean candidate commit passes repository validation and the
clean-machine matrix in [RELEASE-ACCEPTANCE.md](./RELEASE-ACCEPTANCE.md).

- implement the smallest correct behavior for visible incomplete controls or
  remove them from the supported release surface;
- restore executable interaction coverage for supported user paths;
- verify project, pane, worktree, persistence, recovery, Git integration,
  updater, optional-provider, and current error/reporting behavior;
- retain evidence against the exact candidate SHA;
- classify every documented capability as proven, unsupported, or deferred.

## Stage 2 — publish macOS `v0.0.1`

**Owners:** #31, #203, and #194  
**Exit gate:** the documented Homebrew command installs and launches the exact
signed application represented by the public GitHub Release.

- close #203 only after the implemented desktop-only contract has live
  protected-release evidence;
- provision protected signing, notarization, GitHub, and Homebrew credentials;
- enforce release branch, environment, reviewer, and immutable-tag rules;
- create a verified signed annotated tag from the accepted `main` SHA;
- build notarized Apple Silicon and Intel DMGs plus `SHA256SUMS`;
- verify versions, signatures, Gatekeeper, provenance, asset names, checksums,
  release notes, and downloadability;
- publish the native Homebrew Cask from those exact immutable assets;
- independently test clean install, launch, upgrade when applicable, uninstall,
  and reinstall.

## Stage 3 — complete the iOS companion train

**Owner:** #200  
**Intended release relationship:** independent of Stage 2 unless a shared
macOS contract is proven defective.

The offline workflow contract is implemented: explicitly selected desktop-only
releases skip iOS-only verification and distribution while shared validation
remains mandatory, and coordinated releases retain every iOS gate. #203 remains
open pending live desktop-only dry-run evidence: both `build-macos` matrix jobs
must succeed, `upload-ios` is `skipped`, `publish` succeeds after `release`
environment approval, and the Homebrew notification succeeds. Until that
evidence is retained, the macOS-only path is not live-ready—not because iOS is
part of the macOS supported surface, but because protected release behavior has
not yet been observed.

- finish atomic host readiness and physical same-LAN acceptance in #193;
- finish production ritual publication/execution and full live-path proof in
  #192;
- ship and verify an internal TestFlight build;
- then design remote/off-LAN continuity behind the same identity,
  authentication, scope, receipt, retry, revocation, and snapshot contracts.

Bonjour is a local discovery adapter, not the complete remote-connectivity
architecture.

## Stage 4 — harden operations

**Owner:** #199  
**Exit gate:** common failures produce actionable bounded diagnostics and
recover without silent identity, state, or effect corruption.

- define one versioned, bounded, automatically redacted support bundle;
- surface authoritative action/receipt lifecycle states;
- turn release acceptance into a reusable disposable recovery harness;
- exercise process, persistence, provider, cleanup, identity, retry, storage,
  and upgrade failures;
- preserve evidence without collecting unrestricted user or project content.

## Stage 5 — decompose and open the repository

**Owners:** #197 and #198

Architecture extraction order:

1. application lifecycle and Tauri command registration;
2. workspace persistence and recovery;
3. pane, PTY, and process lifecycle;
4. browser and Git control;
5. desktop-web state, rendering, and event wiring.

Each slice must preserve public commands, protocol schemas, persisted formats,
error behavior, and user-visible behavior unless a separate approved design
changes them. It must be independently testable, regenerate canonical bundles,
and retain a rollback path.

The minimum security and ownership floor in #198 may proceed before release.
Broader contributor-surface work follows stabilization and must document a
clean-checkout contributor loop without maintainer-only knowledge.

## Stage 6 — converge on OpenCoven-native identity and execution

**Owner:** #201  
**Exit gate:** an approved cross-repository design and executable reference
contracts preserve one familiar/thread/run identity across desktop execution,
artifact/receipt creation, iOS observation or approval, disconnect, and resume.

This stage wraps current behavior incrementally. It does not replace working
pane, worktree, authority, or persistence contracts in one rewrite.

## Evidence contract

Every outcome follows the same chain:

```text
GitHub outcome and milestone
        │
        ▼
Dependency-ordered Beads
        │
        ▼
Focused pull requests with acceptance criteria
        │
        ▼
Local and CI verification
        │
        ▼
Runtime or release evidence against an immutable SHA
        │
        ▼
Tracker closure and public status update
```

Documentation and test counts are evidence of intent and coverage, not proof
that a distributed user path works. Production composition paths, clean
artifacts, physical devices where applicable, and explicit failure behavior
must be observed before their gates close.

## Roadmap maintenance rules

- Reconcile this document whenever an outcome, dependency, support claim, or
  delivery train changes.
- Update #195 in the same pull request or issue mutation that changes roadmap
  control state.
- Never close an outcome without linking its immutable evidence.
- Never make iOS, architecture cleanup, or future OpenCoven convergence an
  undeclared macOS release blocker; represent accidental coupling explicitly
  and remove it through an owned P0 infrastructure outcome.
- Never make Beads, tmux, a provider session, a transport, or a UI component
  the only durable identity for user work.
