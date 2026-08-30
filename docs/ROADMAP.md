# Psyche Build roadmap

**Status:** Active post-release roadmap  
**Accountable owner:** [@BunsDev](https://github.com/BunsDev)  
**Last reconciled:** 2026-08-30  
**Control snapshot:** `main` at `f12b753424f2444466aadbd70f8213768a657031`

**Portfolio control:** [#195](https://github.com/OpenCoven/psyche-build/issues/195)  
**Execution contract:** [POST-RELEASE-EXECUTION.md](./POST-RELEASE-EXECUTION.md)  
**Support contract:** [SUPPORT-MATRIX.md](./SUPPORT-MATRIX.md)

This is the canonical public roadmap for Psyche Build. It records supported
surfaces, active outcomes, delivery order, dependencies, and evidence gates.
Live GitHub issues and pull requests remain authoritative for implementation
state. Beads owns internal dependency ordering and generated public mirrors; it
does not own product identity, support truth, or public outcome completion.

## North star

Psyche Build is OpenCoven's local-first cockpit for visible, scoped, and
recoverable familiar work. It must preserve user work, identity, authority, and
continuity while allowing multiple terminal or agent lanes to proceed in
parallel. Psyche Build is a product client and adapter, not a second protocol or
runtime authority.

## Release and support truth

The public supported release remains **macOS `v0.0.1`**, published on
2026-08-23 from immutable source
`57c6c71bd5264fde960b062e95de278c8438c94f`. The public
[GitHub Release](https://github.com/OpenCoven/psyche-build/releases/tag/v0.0.1),
checksums, architecture-specific DMGs, and OpenCoven Homebrew Cask remain the
accepted distribution evidence.

The repository package metadata and changelog identify `0.0.2`, but no `v0.0.2`
GitHub release, immutable release asset set, accepted publication run, or
corresponding support transition is recorded here. **`0.0.2` is therefore an
unreleased candidate on `main`, not the latest supported public release.** A
version string, changelog section, green CI run, or merge to `main` is not a
publication event.

The current support claims remain:

- macOS native application: **Supported** for released `v0.0.1`;
- TUI / Node CLI from a repository checkout: **Source-supported**;
- iOS application: **Planned internal beta pending #200**;
- Windows and Linux applications: **Compile-only**;
- Android, browser-hosted distribution, external TestFlight, and public App
  Store: **Unavailable**;
- cloud execution, team collaboration, marketplace behavior, remote/off-LAN
  continuity, and complete Psyche/Threads convergence: **Planned**.

Source, simulator, fixture, UI-test, or merged composition work does not
establish TestFlight availability or change the iOS support status.

## Delivered control foundation

The following outcomes are complete and should remain closed:

- [#238 — critical-path documentation](https://github.com/OpenCoven/psyche-build/issues/238),
  delivered by [PR #245](https://github.com/OpenCoven/psyche-build/pull/245)
  and merge commit `5f4b7b05`;
- [#237 — Beads/mirror reconciliation](https://github.com/OpenCoven/psyche-build/issues/237),
  including reviewed canonical mapping and the protected first apply;
- [#240 — tracker drift validation](https://github.com/OpenCoven/psyche-build/issues/240),
  including bounded validation and the retained zero-operation run;
- [#244 — minimum community floor](https://github.com/OpenCoven/psyche-build/issues/244),
  including security, ownership, support, conduct, issue, PR, and protected-data
  surfaces;
- [PR #272](https://github.com/OpenCoven/psyche-build/pull/272), which made the
  public full contributor gate leave a clean checkout by routing Cargo outputs
  outside the repository;
- [PR #273](https://github.com/OpenCoven/psyche-build/pull/273), which completed
  the contributor scope/design/evidence policy and classified dated
  `docs/superpowers/` records as historical reference by default;
- [PR #262](https://github.com/OpenCoven/psyche-build/pull/262), which merged the
  current-state Psyche compatibility map as delivery slice 1 of #253 without
  claiming protocol conformance;
- [PR #274](https://github.com/OpenCoven/psyche-build/pull/274), merged as
  `f12b7534`, which composed one host-scoped native iOS action store/request
  client without changing iOS support status.

[PR #247](https://github.com/OpenCoven/psyche-build/pull/247) also hardened the
supported desktop Git surface so repository-controlled Git configuration cannot
execute commands during bounded history inspection. [PR #248](https://github.com/OpenCoven/psyche-build/pull/248)
and [PR #249](https://github.com/OpenCoven/psyche-build/pull/249) delivered the
managed Beads Project mirror, bounded GraphQL discovery/inventory, deterministic
drift checks, write fencing, and sanitizer hardening. The retained dry-run
planned zero mutations with two GraphQL queries.

### Governance remains open

[#31 — branch governance](https://github.com/OpenCoven/psyche-build/issues/31)
is **not delivered**. The live branch API still reports the required checks with
`enforcement_level: non_admins`, so administrator enforcement and the absence of
a standing broad bypass are not proven. Closing #31 requires sanitized before
and after policy evidence, required checks for administrators, review and
conversation requirements, direct-push rejection proof for ordinary and
administrative actors, immutable release-tag controls, and a protected proof PR.
Any emergency path must be separately scoped, time-bounded, named, and auditable;
it must not be a standing silent bypass.

## Tracker and identity contract

| System | Owns | Must not become |
|---|---|---|
| GitHub issues and milestones | Public outcomes, accountable ownership, acceptance gates, support decisions, and externally legible status | A duplicate internal task graph |
| Beads | Internal implementation tasks and dependency ordering | Product support truth or runtime/protocol identity |
| Pull requests | Reviewable implementation slices and focused verification | End-to-end acceptance merely because tests pass |
| Retained evidence | Runtime, policy, artifact, clean-install, recovery, and physical-device observations tied to immutable source | Unstructured screenshots or undocumented maintainer memory |
| Specs and dated plans | Design intent, decisions, and historical reasoning | Executable backlog or proof that behavior shipped |

Generated GitHub bodies are one-way mirrors. Never edit or repair generated
mirror bodies as the authoritative source; change the reviewed canonical Beads
record, review the Dolt diff, publish the exact reviewed state, and run the
protected synchronizer.

Protocol-owned familiar, thread, run, action, artifact, and receipt identities
must outlive Beads, tmux/process IDs, paths, branches, providers, transports,
and UI selections. [#201](https://github.com/OpenCoven/psyche-build/issues/201)
owns the product convergence outcome; [#253](https://github.com/OpenCoven/psyche-build/issues/253)
owns the immutable Psyche profile/canary work once upstream artifacts exist.

## Priority definitions

- **P0 — supported-surface control or stabilization:** governance,
  data-preservation, recovery, or supported-release correctness.
- **P1 — committed next capability:** independently gated reliability, product,
  architecture, community, or distribution work with an owner and exit gate.
- **P2 — future architecture:** design may proceed, but implementation cannot
  become an implicit prerequisite for P0/P1 delivery.

## Delivery graph

```text
Delivered release and control foundation
  #194/#203 v0.0.1 release independence
  #238 + #237 + #240 tracker/documentation closure
  #244 + PR #272/#273 contributor floor
                    │
                    ├──────────────► #31 live governance correction (parallel P0)
                    │
                    ▼
Current P0 stabilization path
  #196/#239 operator acceptance ─────────────► #199 operational hardening
                    │                              │
                    │                              ├─► #243 support bundle v1
                    │                              │    (PR #278 review-blocked)
                    │                              └─► debug rendering stress harness
                    │                                   (PR #281 review-blocked; Beads #230)
                    │
                    ├─► #198 final clean-room/live-settings evidence
                    │
                    ▼
Independent iOS train
  #241 atomic host readiness
       │
       ├─► #280 focused invite-auth slices from draft PR #264
       ├─► discovery/reconnect + physical same-LAN proof
       ├─► #242 publication → execution → capability-gated controls
       └─► immutable TestFlight acceptance under #200

After stable #196/#199 contracts
  #197 desktop decomposition

Non-blocking P2 convergence
  #201/#253 Psyche profile/canaries
  #279 capability-negotiated Coven adapter (PR #277 design correction)
  #246 cross-platform input parity
```

## Portfolio outcomes and current state

| Outcome | Priority | State | Exit gate |
|---|---:|---|---|
| [#195 — roadmap and post-release control](https://github.com/OpenCoven/psyche-build/issues/195) | P0 | Active | Every active outcome has one owner, dependency chain, support decision, PR disposition, and evidence location |
| [#31 — branch governance](https://github.com/OpenCoven/psyche-build/issues/31) | P0 | Open governance gate | Administrator-enforced checks/review, no standing broad bypass, direct-push rejection proof, protected proof PR |
| [#238 — critical-path documentation](https://github.com/OpenCoven/psyche-build/issues/238) | P0 | **Completed** | Preserve PR #245 / `5f4b7b05` as delivered foundation |
| [#237 — Beads/mirror reconciliation](https://github.com/OpenCoven/psyche-build/issues/237) | P0 | **Completed** | Preserve reviewed mapping, first apply, and issue evidence |
| [#240 — tracker drift validation](https://github.com/OpenCoven/psyche-build/issues/240) | P0 | **Completed** | Preserve bounded validation and zero-operation evidence |
| [#196 — `v0.0.1` stabilization](https://github.com/OpenCoven/psyche-build/issues/196) | P0 | Active critical path | Operator-observed ordinary and representative failure/recovery paths |
| [#239 — operator acceptance manifest](https://github.com/OpenCoven/psyche-build/issues/239) | P0 | Active critical path | One sanitized immutable-source manifest covering lifecycle, persistence, Git/cleanup, provider isolation, authority, and recovery |
| [#199 — operations, diagnostics, recovery](https://github.com/OpenCoven/psyche-build/issues/199) | P1 | Active after/alongside #239; PR #281 changes requested | Bounded diagnostics and reusable observed recovery harnesses |
| [#243 — support bundle v1](https://github.com/OpenCoven/psyche-build/issues/243) | P1 | Active; PR #278 changes requested | Fail-closed redaction, truthful collector ownership/status, bounded traversal, deterministic schema/fixture |
| [#198 — open-source readiness](https://github.com/OpenCoven/psyche-build/issues/198) | P1 | Repository policy delivered; evidence remains | Terminal clean-checkout contributor acceptance and live policy/community evidence |
| [#244 — minimum community floor](https://github.com/OpenCoven/psyche-build/issues/244) | P1 | **Completed** | Preserve validated security, ownership, support, intake, conduct, and protected-data contracts |
| [#200 — iOS internal beta and continuity](https://github.com/OpenCoven/psyche-build/issues/200) | P1 | Planned / active delivery train | Immutable physical build repeats pairing, authority, action/receipt, reconnect, host restart, and revocation matrix |
| [#241 — atomic iOS readiness](https://github.com/OpenCoven/psyche-build/issues/241) | P1 | First iOS implementation gate | Commit host authority before exposing a new workspace; deterministic rollback at every failure boundary |
| [#280 — secure invite authentication](https://github.com/OpenCoven/psyche-build/issues/280) | P1 | Planned after #241; draft #264 is source | Focused protocol, desktop, iOS, UX, physical, and TestFlight slices with independent R3 review |
| [#242 — production ritual path](https://github.com/OpenCoven/psyche-build/issues/242) | P1 | Blocked on readiness and physical proof | Live host publication, registered execution authority, canonical receipts, capability-gated controls |
| [#197 — desktop decomposition](https://github.com/OpenCoven/psyche-build/issues/197) | P1 | Deferred behind stable #196/#199 | Extract lifecycle, persistence, PTY/process, browser/Git, and UI seams without contract drift |
| [#201 — OpenCoven identity and Threads](https://github.com/OpenCoven/psyche-build/issues/201) | P2 | Design/convergence active; non-blocking | Cross-device reference flow preserves protocol-owned identity and authority through disconnect/resume |
| [#253 — Psyche compatibility canary](https://github.com/OpenCoven/psyche-build/issues/253) | P2 | Mapping delivered; profile/canary upstream-blocked | Immutable released Psyche profile, negative canary, bounded adapters, reference-flow evidence |
| [#279 — Coven launch adapter](https://github.com/OpenCoven/psyche-build/issues/279) | P2 | Design correction required | Capability/version negotiation, private prompt transport, canonical Coven session/receipt, rollback |
| [#246 — cross-platform input parity](https://github.com/OpenCoven/psyche-build/issues/246) | P2 | Deferred | Opt-in semantics preserve terminal passthrough and earn platform-specific evidence |

## Pull-request disposition

| Pull request | Disposition | Owning gate |
|---|---|---|
| [#274](https://github.com/OpenCoven/psyche-build/pull/274) | **Merged** as `f12b7534` | Product-local iOS action-state composition; no support claim |
| [#281](https://github.com/OpenCoven/psyche-build/pull/281) | **Changes requested** | #199 / generated Beads #230: compile-time debug boundary, invoking-webview authority, deterministic launcher spawn errors |
| [#278](https://github.com/OpenCoven/psyche-build/pull/278) | **Changes requested** | #243: fail-closed terminal privacy, collector conflict truth, state vocabulary, bounded normalization |
| [#277](https://github.com/OpenCoven/psyche-build/pull/277) | **Design correction required; not merge-ready** | #279: remove prompt from argv/persistence, negotiate Coven capability/version, split unrelated Git tests |
| [#264](https://github.com/OpenCoven/psyche-build/pull/264) | **Draft source material only** | #280 after #241; extract focused R3 slices rather than merging 32 commits / 37 files |
| [#262](https://github.com/OpenCoven/psyche-build/pull/262) | **Merged focused mapping slice** | Completes only #253 slice 1; #253 remains open |
| [#236](https://github.com/OpenCoven/psyche-build/pull/236) | **Closed as superseded** | Preserved as history after #245 |
| [#190](https://github.com/OpenCoven/psyche-build/pull/190) | **Source material only** | Extract safe bounded diagnostics under #199/#243 |
| [#193](https://github.com/OpenCoven/psyche-build/pull/193) | **Source material only** | Extract #241 first, then discovery/reconnect and physical proof |
| [#192](https://github.com/OpenCoven/psyche-build/pull/192) | **Source material only** | Extract #242 publication, execution, then UI after accepted readiness |
| [#254](https://github.com/OpenCoven/psyche-build/pull/254) | **Source material only** | PR #262 is the focused replacement for #254's mapping scope |

The listed source-material PRs are not merge-ready merely because they can be
rebased or their historical checks passed. No listed open implementation PR is
merge-ready at this snapshot: #281 and #278 have unresolved requested changes,
#277 needs the #279 design correction, and #264 remains an oversized
draft/source branch. Every replacement starts from current `main`, has one
owning outcome and one acceptance gate, resolves current findings, and passes
required checks on its exact final head.

## Stage 1 — P0 governance and supported-release stabilization

**Owners:** #31, #196, and #239.  
**Current product gate:** #196/#239 are the current P0 stabilization critical
path; #31 is the parallel P0 governance gate.

The operator manifest must cover exact-source smoke, first launch/onboarding,
plain-terminal and supported agent lanes, project/pane lifecycle, restart and
recovery, Git/PR/cleanup, optional-provider absence/interruption/revocation,
work preservation, authority, receipts, idempotency, and explicit recovery.
Every representative failure must terminate deterministically or enter
`recovery_required`.

#31 closes only after live repository policy—not documentation—proves
administrator enforcement and rejects direct updates outside the protected path.
The supported `v0.0.1` release remains public while this correction is open.

## Stage 2 — operations and contributor evidence

**Owners:** #199, #243, and #198.

#199/#243 retains its P1 dependency gate: schema/redaction work may proceed
during #239, while reusable failure harnesses follow operator-observed #239
cases. PR #278 remains blocked until unrestricted terminal text fails closed,
duplicate collector ownership cannot disappear silently, the advertised action
vocabulary matches authoritative receipt projections, and traversal/elapsed
bounds are truthful.

PR #281 remains blocked under #199 and generated Beads task #230 until the
process-spawning diagnostics commands and permissions honor the stated
compile-time debug boundary (or an explicit reviewed design change replaces
that contract), `diagnostics_cycle_window` validates the invoking webview rather
than only a window label, and the diagnostics launcher handles child-process
spawn errors deterministically without double settlement. The generated #230
body remains a one-way mirror and is not manually repaired.

#198/#244 retains its P1 dependency gate: #244 and repository policy work are
delivered, but #198 remains open until a clean external checkout completes the
canonical bootstrap/full gate and live GitHub settings/community evidence is
retained. Repository files do not prove platform configuration.

## Stage 3 — trustworthy iOS internal beta

**Owner:** #200.  
**Required order:** #241 atomic readiness → #280 focused invite-auth protocol and
exchange slices → discovery/reconnect → physical same-LAN proof → #242
publication → #242 execution → capability-gated controls → immutable TestFlight.

#200/#241 retains its P1 dependency gate: atomic readiness precedes every later
iOS authority/capability slice, and physical evidence precedes a support-state
change. PR #274's merged shared action store is a composition seam only. Draft
PR #264 is source material for #280 and must not merge as one branch.

Bonjour, QR codes, deep links, addresses, and successful transport are discovery
or exchange mechanisms, not durable identity. Host identity and authority must
survive address/transport changes. Only an immutable TestFlight build installed
by an authorized tester may move iOS from **Planned** to **Internal beta**.

#242 publication precedes execution; execution precedes mobile controls. A
control remains absent when its production publisher/executor or capability is
absent.

## Stage 4 — decomposition behind proven contracts

**Owner:** #197.

#197 retains its P1 dependency gate: implementation waits for stable #196/#199
contracts. Extract application lifecycle/registration, persistence/recovery,
pane/PTY/process lifecycle, browser/Git control, then desktop-web state/events.
Each PR preserves public commands, schemas, persisted formats, errors, security
boundaries, generated outputs, behavior, and rollback.

## Stage 5 — OpenCoven-native convergence

**Owners:** #201, #253, and #279.

#201/#253 retains its P2 dependency gate: mapping/design may proceed, but the
immutable pin waits for a consumable Psyche profile and ownership-sensitive
adapters wait for the cross-repository ownership decision. The merged #262 map
must not be promoted into a conformance claim.

#279 is a product-to-Coven adapter slice under #201. It must negotiate an exact
Coven profile/capability set, avoid raw prompt text in process arguments or
persistent launch metadata, preserve canonical Coven session/receipt identity,
and fail closed on missing, incompatible, unavailable, or revoked runtime
authority. It cannot block #196, #199, or #200.

#246 retains its P2 dependency gate: broad cross-platform input rollout follows
stable input, persistence, action, P0 stabilization, and first iOS readiness
contracts unless a bounded slice is explicitly reprioritized.

## Concurrency rules

- #31 and #196/#239 proceed in parallel; neither reopens the accepted `v0.0.1`
  publication.
- #243 schema/redaction correction may proceed during #239; recovery scenarios
  wait for observed #239 cases.
- #281 may proceed as a bounded #199 diagnostics-harness slice once its current
  authority/build/launcher findings are resolved; it does not change support.
- #198 evidence work may proceed independently without weakening #31.
- #241 precedes #280, later iOS capability work, and support-state changes.
- #242 publication precedes execution; execution precedes mobile controls.
- #197 implementation waits for stable #196/#199 contracts.
- #201/#253/#279 design may proceed, but implementation cannot block #196,
  #199, or #200.
- #246 remains P2 until prerequisite contracts stabilize or a bounded slice is
  explicitly promoted.

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

Closing an implementation issue requires the merged commit and retained
evidence, not merely a source diff. Closing a public outcome requires every
child gate or an explicit truthful deferral.

## Roadmap maintenance rules

- Reconcile this file and [POST-RELEASE-EXECUTION.md](./POST-RELEASE-EXECUTION.md)
  whenever support status, priority, dependency, delivery train, or open-PR
  disposition changes.
- Update #195 in the same controlled state transition.
- Never mark a candidate version released without immutable publication and
  accepted distribution evidence.
- Never close an outcome without durable evidence tied to immutable source.
- Never repair generated mirror state by treating generated GitHub bodies as
  the authoritative source.
- Never make iOS, diagnostics expansion, architecture cleanup, community work,
  or OpenCoven convergence an implicit macOS support prerequisite.
- Never let Beads, tmux, a process, path, branch, provider, transport, or UI
  selection become the only durable identity for user work.