# Psyche Build roadmap

**Status:** Active post-release roadmap  
**Accountable owner:** [@BunsDev](https://github.com/BunsDev)  
**Last reconciled:** 2026-09-14

**Portfolio control:** [Standing control register](#standing-roadmap-control)

**Establishment and closeout evidence:** [#195](https://github.com/OpenCoven/psyche-build/issues/195)

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
objective is to earn repeatable operator acceptance and recovery for that
supported surface before expanding the product. The contributor floor is
delivered. iOS and OpenCoven convergence remain separate, deferred trains.

## macOS-first rollout focus

The active delivery order is #196/#239 operator acceptance, then the observed
recovery gaps owned by #199. Work that fixes a demonstrated supported-surface
defect may proceed alongside acceptance; feature breadth and file-size
reduction are not release gates.

| Disposition | Outcomes | Decision |
|---|---|---|
| Active macOS rollout | #196, #239, #199 | Preserve the packaged lifecycle, persistence, Git/cleanup, provider isolation, and recovery evidence gates. |
| Separate iOS train, paused for rollout focus | #200, #241, #280, #242, [#435](https://github.com/OpenCoven/psyche-build/issues/435) | iOS is not a macOS rollout prerequisite. #435 remains open: a lost consequential-action reply requires authoritative reconciliation, not a fresh retry. |
| Deferred product expansion | #201, #253, #279, #246 | Preserve ownership and dependency contracts; no implied rollout commitment or protocol/input-parity claim. |
| Retired broad refactor program | #197 | Retired as not planned. Keep delivered extractions; future extraction must enable a named defect fix rather than a perpetual decomposition target. |

Retiring #197 is not a claim that desktop decomposition or its acceptance is
complete. Do not remove compatibility, work-preservation, or recovery coverage.
The iOS and Vim Beads families remain source-owned and retain their current
mappings; deferring a train does not authorize editing generated mirror state.

[#195](https://github.com/OpenCoven/psyche-build/issues/195) delivered the
portfolio-control setup through [PR #453](https://github.com/OpenCoven/psyche-build/pull/453)
at `cea1529a1c58898b5f8ccf08148626577c82188c`. The standing register below
retains weekly and event-driven reconciliation; the protected PR procedure in
[Contributing](../CONTRIBUTING.md#roadmap-control) implements it, not a competing
successor. @BunsDev remains accountable. The owning issues retain acceptance
evidence and honest incomplete states.

Control evidence observed on 2026-09-14 from source
`3ec865dc8eef7dedcb45e2b72cde265ae30cc9e5`: the read-only tracker validator
reported 111 sources, 27 managed mirrors, 14 canonical outcomes, and 0 findings.
[Scheduled sync 34761084154](https://github.com/OpenCoven/psyche-build/actions/runs/34761084154)
succeeded at `8650344ce560ffcfe190ea99acc2010921409753`. Live branch protection
still enforced administrators, strict `TypeScript and Rust`/`iOS` checks,
linear history, and conversation resolution; ruleset `21729943` had no bypass
actors and zero required approving reviews. No repository settings changed.
This proves control state, not packaged operator acceptance.

All existing and future dated records default to reference material under the
[classification policy](./superpowers/README.md). The live PR list supersedes
the dated inventory below.

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
| [#197](https://github.com/OpenCoven/psyche-build/issues/197) | [PR #373](https://github.com/OpenCoven/psyche-build/pull/373) (`81a9c754`) | Initial stage/verify/publish function boundary and named `PublishedWorkspace` result; subsequent persistence extraction is recorded below |

### September 14 reconciliation

This snapshot was inspected against `main`
`3ec865dc8eef7dedcb45e2b72cde265ae30cc9e5`. Later issue/PR state is live state,
not a reason to reinterpret the evidence at this source.

- #197's [bounded persistence completion](https://github.com/OpenCoven/psyche-build/issues/197#issuecomment-5594299874)
  supersedes the earlier unstarted atomic-publication slice. Extraction did not
  add missing save scheduling, quarantine, or recovery guarantees.
- [#388](https://github.com/OpenCoven/psyche-build/issues/388),
  [#424](https://github.com/OpenCoven/psyche-build/issues/424), and
  [#426](https://github.com/OpenCoven/psyche-build/issues/426) are delivered
  through PRs #423, #421, and #437 respectively. #367 was retired as not
  planned, not fixed; its root cause remains unestablished.
- [PR #393](https://github.com/OpenCoven/psyche-build/pull/393) delivered
  acceptance-validator remediation. The later #239 exact-release CLI smoke
  does not reverify the earlier 15 records or supply packaged GUI/human
  verification. #196/#239 remain open.
- [PR #434](https://github.com/OpenCoven/psyche-build/pull/434) restored
  disabled ritual controls when production execution is unavailable.
  [#435](https://github.com/OpenCoven/psyche-build/issues/435) owns lost-reply
  ambiguity; fixture and gateway characterization do not complete it.
- PRs #422, #444, #445, and #448 delivered bounded recovery, acceptance
  preflight, and GPU-verification tooling under #199. Preflight is read-only
  inventory, not a product observation; GPU export validation is not physical
  performance acceptance.
- [PR #451](https://github.com/OpenCoven/psyche-build/pull/451) merged as
  `3ec865dc8eef7dedcb45e2b72cde265ae30cc9e5`: shortened-CRLF reload now clamps
  selection to CodeMirror's normalized document. Its source-level recovery
  evidence does not complete #196 or #199.

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
  #196/#239 operator acceptance ──► #199 observed recovery gaps

Paused independent iOS train (not a macOS rollout prerequisite)
  #241 atomic readiness
  (core/composition merged;
   physical proof open)
      │
      ▼
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

Retired program
  #197 broad desktop decomposition (not completed; merged modules retained)
```

## Portfolio outcomes and closure state

The accountable owner of every outcome in this table is **@BunsDev**. The linked
owning issue is its durable evidence index; dependencies and exit gates are in
the close-condition column and the corresponding execution stage. Train is
explicit below, not inferred from milestone membership. In particular #279's
legacy `v0.0.1 macOS` milestone does not promote P2 work to a release prerequisite.
Support decisions remain those in [Current support state](#current-support-state):
no row grants iOS availability, platform parity, protocol conformance, or
completion of operator acceptance from source delivery.

| Outcome | Priority | Train | Close condition |
|---|---:|---|---|
| [#195 — roadmap and post-release control](https://github.com/OpenCoven/psyche-build/issues/195) | Delivered | Portfolio | Setup delivered through PR #453; recurring control belongs to the standing register below, with policy and source/mirror evidence retained; product outcomes remain independently open |
| [#238 — critical-path documentation](https://github.com/OpenCoven/psyche-build/issues/238) | P0 | Documentation | **Delivered** by PR #245 / `5f4b7b05`; preserve it as completed Stage 0 foundation |
| [#31 — branch governance](https://github.com/OpenCoven/psyche-build/issues/31) | P0 | Governance | **Delivered** — closed 2026-08-30 with sanitized ruleset/protection evidence, direct-push rejection proof, and protected proof PR #283 |
| [#237 — Beads/mirror reconciliation](https://github.com/OpenCoven/psyche-build/issues/237) | P0 | Tracker integrity | **Delivered** — closed 2026-08-29 after source-first Beads reconciliation left no open generated `priority:P0` mirror |
| [#240 — tracker drift validation](https://github.com/OpenCoven/psyche-build/issues/240) | P0 | Tracker integrity | **Delivered** — closed 2026-08-28 by PR #263; hardened by PR #330 |
| [#196 — `v0.0.1` stabilization](https://github.com/OpenCoven/psyche-build/issues/196) | P0 | Reliability | Supported ordinary and representative failure paths have operator-observed evidence; PRs #283 and #336 are merged remediation, not released re-observation |
| [#239 — operator acceptance manifest](https://github.com/OpenCoven/psyche-build/issues/239) | P0 | Reliability | One sanitized manifest ties exact-source smoke, lifecycle, persistence, Git/cleanup, and provider-isolation evidence to the release; the earlier 15-digest manifest reports `terminal_state: incomplete` and is not reverified by later CLI smoke |
| [#200 — iOS internal beta and continuity](https://github.com/OpenCoven/psyche-build/issues/200) | P1 | iOS | An immutable physical build restores authoritative state, performs only wired scoped effects, reconnects, and fails closed on revocation |
| [#241 — atomic iOS readiness](https://github.com/OpenCoven/psyche-build/issues/241) | P1 | iOS | Readiness core (#326), production composition (#329), and ready-selection hardening (#335/#337/#338) are merged; discovery/reconnect UX, lifecycle acceptance, physical-device, and real-Keychain partial-write evidence remain open |
| [#280 — single-use iOS invite authentication](https://github.com/OpenCoven/psyche-build/issues/280) | P1 | iOS | The protocol/fixture slice merged in PR #323; desktop issuer, iOS credential exchange, QR/deep-link UX, physical acceptance, and distribution evidence remain open |
| [#242 — production ritual path](https://github.com/OpenCoven/psyche-build/issues/242) | P1 | iOS | Publication merged in PR #322; the registered execution path, canonical receipts, and capability-gated controls remain open |
| [#435 — unknown mobile action outcomes](https://github.com/OpenCoven/psyche-build/issues/435) | P1 | iOS | Child of #200; an approved host-owned reconciliation adapter or authorized operator recovery procedure must guard unknown effects through retry, reconnect, restart, and host switches, with production lost-reply evidence and independent R3 review |
| [#199 — operations, diagnostics, and recovery](https://github.com/OpenCoven/psyche-build/issues/199) | P1 | Reliability | Diagnostics are bounded/redacted and reusable failure harnesses recover deterministically; the harness is delivered through PRs #354-#359 with CI-retained evidence, and the support-bundle production surface plus provider/upgrade scenarios remain open |
| [#243 — support bundle v1](https://github.com/OpenCoven/psyche-build/issues/243) | P1 | Reliability | **Delivered** — closed 2026-09-01 by PR #278 (`69769cc5`); schema, bounds, redaction, and fixture only |
| [#198 — open-source readiness](https://github.com/OpenCoven/psyche-build/issues/198) | P1 | Community | **Delivered** — closed 2026-08-31 by PR #321 (`3c188481`) with a credential-free clean-checkout run and live community-profile evidence |
| [#244 — minimum community floor](https://github.com/OpenCoven/psyche-build/issues/244) | P1 | Community | **Delivered** — closed 2026-08-28 by PR #261 (`267b8809`) |
| [#197 — desktop decomposition](https://github.com/OpenCoven/psyche-build/issues/197) | Retired | Architecture | Not planned as a broad program; retain merged modules and require any further extraction to serve a bounded, owned defect fix |
| [#201 — OpenCoven identity and Threads](https://github.com/OpenCoven/psyche-build/issues/201) | P2 | OpenCoven | A cross-device reference flow preserves protocol-owned identity through execution, evidence, disconnect, and resume |
| [#253 — Psyche compatibility canary and adapters](https://github.com/OpenCoven/psyche-build/issues/253) | P2 | OpenCoven | Pin a consumable protocol profile and introduce bounded canaries/adapters without blocking supported-product work; the pin waits on `OpenCoven/psyche#11` and `#12` |
| [#279 — Coven launch adapter](https://github.com/OpenCoven/psyche-build/issues/279) | P2 | OpenCoven | Capability-negotiated launches keep prompts out of argv and persisted metadata (PRs #324/#328/#336 merged); live restart/reconnect recovery, canonical runtime receipts, and migration/rollback evidence remain open, and receipt semantics wait on #253 |
| [#246 — cross-platform Vim and keyboard-mode parity](https://github.com/OpenCoven/psyche-build/issues/246) | P2 | Input | Opt-in shared semantics preserve exact terminal passthrough and earn platform-specific evidence after prerequisite contracts stabilize; the shared v1 fixture contract merged in PR #327 |

### Intake disposition

The initial September 14 inventory included proposal #450, with an approved
disposition of deferred P2 Optional integrations intake owned by @BunsDev, not
an accepted implementation commitment. At the pre-publication refresh GitHub
no longer resolved #450. It is therefore absent from the active register; no
replacement is created, no remote assignment is claimed, and no integration
support or P0/P1 dependency follows. Any future proposal requires its own
owner-approved consent, scope, provenance, retention/deletion, protected-data,
and canonical-identity design before activation.

## Pull-request disposition

At the September 14 snapshot, [#452](https://github.com/OpenCoven/psyche-build/pull/452)
was the only open PR, at `92942f439bf04f8808556e396a4b477192b9c8ce`.
Its single portfolio mapping is **Tracker maintenance**, accountable owner
**@BunsDev**, under the standing control register (historical closeout #195).
Its gate is the isolated renderer measurement contract with unchanged limits,
independent review, and terminal required exact-head checks. The PR explicitly
requires a separate owner merge decision; this reconciliation does not authorize
its merge. Its evidence index is the PR body, and it makes no product-support
claim. PR #453 delivered the #195 closeout handoff. The subsequent rollout-focus
PR #454 maps to #197 / Portfolio scope retirement / @BunsDev: its gate is
truthful retirement, preserved acceptance/control contracts, independent review,
and terminal exact-head required checks.

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

The later [#420 recovery record](https://github.com/OpenCoven/psyche-build/issues/420#issuecomment-5616402711)
retains protected apply
[34459609608](https://github.com/OpenCoven/psyche-build/actions/runs/34459609608)
and normal no-op
[34460856341](https://github.com/OpenCoven/psyche-build/actions/runs/34460856341)
at source `73039d5c3827e2f49cf28c7ad7db74cc3b5a5247`: 25 approved operations,
no newly created issues, original survivors preserved, then zero operations and
a zero-finding authenticated drift report. #420 is complete.

Recent scheduled runs
[34747362154](https://github.com/OpenCoven/psyche-build/actions/runs/34747362154)
and [34761084154](https://github.com/OpenCoven/psyche-build/actions/runs/34761084154)
on September 13 both succeeded at source
`8650344ce560ffcfe190ea99acc2010921409753`, with 0 planned and 0 applied
operations: 111 sources, 14 active, 97 closed, all 14 active mapped, no
unmapped/unknown/malformed targets, priority mismatches, warnings, or visibility
drift. The latter retained summary SHA-256 is
`907c2fadb5c1a57d661911af7a5643002bb93758c7868eb9cc01133f99e22720`.
These bounded observations establish recent sync health, not execution against
the September 14 snapshot or this closeout's exact head. Counts, source, and
run links are retained here so expiring workflow artifacts are not the only
record. No Beads or generated mirror mutation is part of this closeout.

## Stage 1 — close the supported release stabilization baseline

**Owners:** #196 and #239.  
**Current gate:** #196/#239 remain the active P0 critical path.

Retain exact-source tmux smoke, first-run/onboarding, terminal and agent lanes,
project/pane lifecycle, restart/recovery, Git/PR/cleanup, optional-provider
isolation, idempotency, receipt, revocation, and work-preservation evidence.
Every representative failure must terminate deterministically or enter an
explicit `recovery_required` state. Transfer reusable infrastructure gaps to
#199 without reopening the completed #194 release.

The earlier #239 manifest records 15 retained evidence digests and
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

The accepted #241 readiness implementation, not closure of all #241 physical
acceptance, is the prerequisite for #280 composition. Pairing/discovery work
then supplies the shared physical acceptance needed by #241 and #200. This is
not a circular issue-closure dependency. #435 is a P1 child of #200 and gates
consequential mobile actions: lost replies require authoritative reconciliation
or an explicitly authorized operator recovery path, not an ordinary fresh retry.

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
application restart and upgrade recovery still follow observed #239 operator
cases rather than being inferred. Stale-identity coverage now spans both paths
production recovery distinguishes — the stale config lease and the replaced
tmux pane identity — at source, not as packaged observation.

The #243 schema slice is delivered through PR #278, and the reusable
disposable failure-injection and recovery harness is delivered through
PRs #354-#359. It covers ten scenarios against the real production paths —
corrupt pane config, stale config lease, unwritable state storage, duplicate
command retry, stale owner epoch, interrupted-cleanup recovery evidence, an
interrupted real cleanup owner, unavailable optional providers, and a replaced
tmux server that reuses a recorded pane identity, and a cleanup owner killed
during its supervised Git mutation — runs from a clean checkout
as `pnpm recovery:harness`, and runs in the Quality CI job with its report
retained as a build artifact.

That seventh scenario interrupts the real cleanup worker before Git mutation,
recovers its project lease, and proves a fresh retry respects an
explicit harness/operator recovery marker. It includes a successful clean
cleanup control and does not claim mid-Git interruption, automatic crash
reconciliation, or packaged acceptance.

The merged support-bundle v1 contract is versioned, deterministic, bounded by
time, count, record, and total size, cancellable, and redacts by default. It
has no production collector wiring, CLI, or UI yet.

#199 remains open. The harness covers the failure classes reachable without a
running application, including the unavailable-provider routing and detection
boundary and the replaced-tmux-identity rebinding boundary; application
upgrade recovery is deliberately uncovered and the support-bundle production
surface is incomplete. Application restart is covered by the opt-in
`pnpm recovery:restart` scenario rather than by the default harness, so it is
observed on request and does not gate a required check. Those follow observed #239
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

## Retired program — broad desktop decomposition

**Historical owner:** #197.

#197 is retired as not planned for the macOS-first rollout. Delivered
lifecycle, persistence, pane/process, and Git extractions remain in the source.
The remaining broad composition-root target is not a user-facing release gate.
The [slice 2 design record](./superpowers/specs/2026-09-06-workspace-persistence-decomposition-design.md)
explains historical boundaries, not a separate executable backlog.

A future extraction needs a named defect or operational requirement, one
owning outcome, and preserved public commands, schemas, persisted formats,
errors, security boundaries, generated outputs, and rollback. Neither source
decomposition nor the recovery harness substitutes for #239's packaged
operator observations. No merged code is reverted by this retirement.

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
- iOS work is paused for rollout focus. On resumption:
- The accepted #241 readiness implementation precedes later iOS capability
  composition; #280 does not wait for closure of shared physical acceptance.
- #242 publication precedes execution; execution precedes mobile controls.
- #435 reconciliation guards precede consequential mobile-action acceptance.
- #197 is retired; defect-driven extraction must belong to a bounded outcome.
- #201/#253/#279 remain deferred; resumption requires explicit owner
  prioritization and cannot block #196, #199, or #200.
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

## Standing roadmap control

This register is the explicit successor to #195, effective when its closeout
PR merges. **@BunsDev** remains accountable; no perpetual replacement issue,
duplicate task graph, runtime identity, new automation, or credentials are
introduced. #195 becomes an immutable establishment/closeout evidence index,
not the destination for every subsequent roadmap update.

**Cadence and triggers:** the owner reconciles the register **weekly**, and in
the same controlled transition whenever support, priority, dependency, owner,
delivery train, outcome closure, or open-PR disposition changes. This is a
human-owned obligation, not a claim that a new scheduled job exists.

For each active outcome record one owner, priority, train, explicit dependencies,
support decision, exit gate, and durable evidence index. Record each open PR
under exactly one owner/train/outcome or explicit maintenance bucket, with its
review and exact-head gate. Separate deferred/untriaged intake from accepted
delivery work; intake must have an owner and a decision gate before activation.
Milestones are release grouping, not a substitute for these fields.

**Reconciliation procedure:**

1. Read the live open issue and PR inventories, terminal changes since the
   previous snapshot, release/support evidence, current branch policy, and
   recent scheduled sync reports. Exclude managed mirrors by their configured
   marker, not by title. Preserve evidence source SHA and observation time.
2. Repair source-owned drift through the supported Beads workflow, never by
   editing generated bodies. A new governance/tracker regression gets a
   bounded owning issue and an explicit priority; do not silently reopen
   completed product acceptance or change support.
3. Reconcile this register, the execution contract, and affected non-generated
   owning issues in one protected change. Retain bounded observations and
   exact-head PR evidence; record failed, unavailable, stale, or unobserved
   proof as a gap, not as a pass. An overdue weekly review is control drift
   and must be recorded with an owner and next reconciliation date.
4. Before any closeout, refresh live inventory and required checks, resolve
   current review findings, and retain merge/source identity and rollback.
   New work discovered during review receives its own mapping; this snapshot
   never claims to freeze concurrent delivery.

All existing and future dated plans/specs are classified by the
[historical-record register](./superpowers/README.md); the default is
`reference`, with explicit evidence required for any per-file override.
Unchecked historical task lists are not an implementation backlog.

### Roadmap maintenance rules

- Reconcile this file and [POST-RELEASE-EXECUTION.md](./POST-RELEASE-EXECUTION.md)
  whenever support status, priority, dependency, delivery train, or open-PR
  disposition changes.
- Update the affected owning issue and retain the protected PR evidence in the
  same controlled state transition; #195 need not remain open for maintenance.
- Never close an outcome without durable evidence tied to immutable source.
- Never repair generated mirror state by treating generated issue bodies as the
  authoritative source.
- Never make iOS, diagnostics expansion, architecture cleanup, community work,
  or OpenCoven convergence an implicit macOS support prerequisite.
- Never let Beads, tmux, a process, path, branch, provider, transport, or UI
  selection become the only durable identity for user work.
