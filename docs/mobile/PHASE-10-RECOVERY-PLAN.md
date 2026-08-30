# Phase 10 — Recovery, Persistence, Accessibility, and Acceptance: Execution Plan

- Bead: `psyche-i7c.10` (mirror: [OpenCoven/psyche-build#209](https://github.com/OpenCoven/psyche-build/issues/209))
- Parent: `psyche-i7c` — Mobile multiproject and multipane cockpit (mirror: #208)
- Gate contract module: `src/mobile/phase10Gate.ts` (schema v1, tests in `__tests__/phase10Gate.test.ts`)
- Plan authored: 2026-08-30 (mirror bodies of #210–#215 read at authoring time; Beads remains authoritative)
- Status: planning/contract slice. This document and the gate module do **not** implement any child deliverable; children #210–#215 own their implementations.

## Objective

Finish production resilience and prove the complete mobile cockpit through protected caching, stale-state UX, accessibility/performance gates, documentation, and a full acceptance matrix. Phase 10 delivers, in the Beads source's own terms: bounded protected cache, host-scoped restoration, stale/offline controls, Dynamic Type/VoiceOver/Reduce Motion support, performance validation, docs, and final integration review.

Canonical outcome tracking stays with gh-200; this phase is the separately gated iOS/mobile delivery track (gh-209) and does not block the macOS v0.0.1 outcome.

## Deliverable breakdown and dependency order

| Order | Child | Bead | Mirror | Owns |
|---|---|---|---|---|
| 1 | Bounded protected workspace cache | `psyche-i7c.10.1` | [#210](https://github.com/OpenCoven/psyche-build/issues/210) | `WorkspaceCache`/`CachedWorkspaceState` with atomic Application Support storage, complete-until-first-auth protection, host identity keying, size limit, draft count/length bounds, no credentials/full source/transcripts |
| 2 | Stale/live reconciliation | `psyche-i7c.10.2` | [#211](https://github.com/OpenCoven/psyche-build/issues/211) | Restore cached state as stale, authoritative snapshot, selection/draft reconciliation, last-confirmed banners/timestamps, input/mutation disabled until live recovery |
| 3 | Accessibility and motion semantics | `psyche-i7c.10.3` | [#212](https://github.com/OpenCoven/psyche-build/issues/212) | Textual status semantics, combined pane/project/host summaries, selected split traits, consequence-first confirmations, Dynamic Type layouts, Reduce Motion, stable identifiers |
| 4 | Performance + acceptance matrix | `psyche-i7c.10.4` | [#213](https://github.com/OpenCoven/psyche-build/issues/213) | Serialization/stream/memory/navigation measurements; full TypeScript, Xcode project, PsycheCore, iPhone, iPad suites; one paired-host scenario when feasible |
| 5 | Product/architecture documentation | `psyche-i7c.10.5` | [#214](https://github.com/OpenCoven/psyche-build/issues/214) | `docs/PRODUCT-SPEC.md` + related protocol/mobile architecture docs: Now-first IA, v2/v3 bridge contract, security model, recovery, lifecycle |
| 5 | (parallel with #213) | — | — | #214 can proceed once #211 lands; it must not document behavior #212/#213 have not yet proven |
| 6 | Final review + branch handoff | `psyche-i7c.10.6` | [#215](https://github.com/OpenCoven/psyche-build/issues/215) | Whole-branch spec review, code-quality review, dependency-cycle/lint checks, clean-worktree validation, PR/merge handoff readiness |

Dependency order (topological; matches `gateOrder()` in `src/mobile/phase10Gate.ts`):

1. #210 → 2. #211 → 3. #212 → 4. #213 and #214 (both unblocked by #211; #213 additionally by #212) → 5. #215 (gated by #212, #213, #214).

## Integration gating (which child gates which)

Explicit edges (`PHASE10_DEPENDENCY_EDGES` in `src/mobile/phase10Gate.ts`; "A → B" means A gates B):

- `#210 → #211` — no cache format exists until #210 lands; #211 defines restoration semantics on top of it.
- `#211 → #212` — accessibility semantics must describe stale/live state as reconciled by #211; announcing a selection that #211 may discard would be rework.
- `#210 → #213`, `#211 → #213`, `#212 → #213` — the acceptance matrix measures the assembled surface; it runs after all three land.
- `#211 → #214` — docs must match the implemented stale/live reconciliation behavior before describing it.
- `#212 → #215`, `#213 → #215`, `#215 ← #214` — final review closes only over the complete phase.

Concretely: **#210 gates #211; #211 gates #212 and #214; #210+#211+#212 gate #213; #212+#213+#214 gate #215; #215 closes the phase.** #213 and #214 may execute in parallel once #211 (and for #213, #212) have passed. Blocking is transitive for closure: a child cannot gate through when any transitive prerequisite has not passed (`phaseClosureReadiness`).

## Per-child plans, acceptance criteria, risk class, and evidence expectations

Acceptance criteria below are verbatim-faithful to the Bead mirror bodies (the generated GitHub mirror of the Beads source, read 2026-08-30). Where Beads and this plan ever disagree, Beads wins.

### #210 — Implement bounded protected workspace cache (`psyche-i7c.10.1`)

- **Work:** Create `WorkspaceCache`/`CachedWorkspaceState` with atomic Application Support storage, complete-until-first-auth protection, host identity keying, size limit, draft count/length bounds, and no credentials/full source/transcripts.
- **Acceptance criteria (verbatim-faithful):**
  - Same-host workspace, sequence, selection, and drafts restore.
  - Other-host state never restores.
  - Oversized cache fails explicitly.
  - File protection and atomic writes are tested where possible.
- **Risk class: R3.** Persistence and recovery semantics: cache keying, protection, and write atomicity are authority-adjacent (host boundary + what is persisted). Requires threat/failure-boundary review (partial-write, hostile-filesystem, cross-host restore) and negative tests, per AGENTS.md R3.
- **Evidence expectations:** Automated — focused unit tests for host keying (other-host state never restores), size/draft bounds (explicit failure path), atomic write and file-protection behavior where the platform test target allows. Operator-observed — none strictly required, but the child's working record must name the exact simulator/OS the tests ran on via CI, and record any gap where file protection is untestable in the harness. Retain exact commands, exact head SHA, and a bounded failure-mode list. No credential-shaped fixtures anywhere (fail closed).

### #211 — Reconcile restored and live state with stale UX (`psyche-i7c.10.2`)

- **Work:** Restore cached state as stale, request an authoritative snapshot, reconcile selection/drafts, show last-confirmed banners/timestamps, and disable input/mutations until live recovery.
- **Acceptance criteria (verbatim-faithful):**
  - Cached state is never presented as live.
  - Successful snapshot clears stale state and persists fresh state.
  - Disconnect preserves viewable bounded cache and disables live actions.
  - Deleted/renamed panes reconcile safely.
- **Risk class: R3.** Recovery and mutation-gating behavior: the child must never present restored state as authoritative and must disable live mutations until live recovery. Weakening stale-marking or mutation disabling to make a test pass is prohibited. Focused behavior tests plus owning-surface checks (R2 practices) are the floor; the stale-vs-live boundary gets failure-boundary review.
- **Evidence expectations:** Automated — unit/behavior tests for stale presentation, snapshot reconciliation, disconnected input disabling, deleted/renamed pane reconciliation. Operator-observed — a manual stale-restore → snapshot → reconcile pass on simulator, recorded as bounded observations (what was seen, on which simulator/OS). UI automation may substitute where it drives the real path; note which.

### #212 — Complete accessibility and motion semantics (`psyche-i7c.10.3`)

- **Work:** Add textual status semantics, combined pane/project/host summaries, selected split traits, consequence-first confirmations, Dynamic Type layouts, Reduce Motion behavior, and stable identifiers.
- **Acceptance criteria (verbatim-faithful):**
  - Status is never color-only.
  - Essential project/branch/host identity survives accessibility text sizes.
  - Focused pane announces selected state.
  - Reduce Motion removes matched geometry/nonessential transitions.
  - Accessibility UI test completes Now→pane→action sheet.
- **Risk class: R2.** Product behavior on the owning surface: focused behavior tests plus accessibility evidence. The accessibility UI test (Now→pane→action sheet) is the user-path proof.
- **Evidence expectations:** Automated — accessibility audit/UI test completing the Now→pane→action sheet path; Dynamic Type layout assertions. Operator-observed — VoiceOver/typical Dynamic Type walkthrough on simulator (or device when a maintainer has one) recorded in the child's working record; screenshot evidence only with provenance (target + settings recorded, bounded count). `docs/a11y/` conventions, where they exist by then, apply.

### #213 — Run performance and full acceptance matrix (`psyche-i7c.10.4`)

- **Work:** Measure workspace serialization, stream bounds, memory/session caps, and navigation responsiveness; run full TypeScript, Xcode project, PsycheCore, iPhone, and iPad suites plus one paired-host scenario when feasible.
- **Acceptance criteria (verbatim-faithful):**
  - Snapshot serialization and event application meet defined thresholds.
  - Terminal output/cache stay within byte/session limits.
  - Full automated matrix passes except documented environment-only baselines.
  - Live scenario proves pair→Now→split→input→file/diff→action→reconnect, or documents the concrete unavailable dependency.
- **Risk class: R1/R2/R3 (mixed).** Measurements and matrix bookkeeping are R1; user-path performance evidence is R2; the paired-host live scenario exercises recovery and live actions and so carries R3 expectations for anything it claims about authority/recovery.
- **Evidence expectations:** Automated — CI-run suites with exact commands and exact head SHA; threshold numbers stated as constants in the plan of record, with observed values beside them. Operator-observed — the paired-host live scenario is inherently operator-observed; if an environment dependency is unavailable, the child documents the concrete missing dependency (per its acceptance criteria) rather than simulating proof. "Full automated matrix passes except documented environment-only baselines" is the closure bar; test counts alone do not substitute for the live-path evidence.

### #214 — Update product and architecture documentation (`psyche-i7c.10.5`)

- **Work:** Update `docs/PRODUCT-SPEC.md` and directly related protocol/mobile architecture documentation with the final Now-first information architecture, v2/v3 bridge contract, security model, recovery, and lifecycle behavior.
- **Acceptance criteria (verbatim-faithful):**
  - Documentation matches implemented behavior and names exact limits/security guarantees.
  - Demo-only behavior is not described as production.
  - No obsolete three-column mobile flow remains.
- **Risk class: R1.** Documentation; ordinary focused review. Constraint: docs may only describe behavior that landed (hence the #211 gate), and may not claim availability or release support owned elsewhere (gh-200, Support matrix).
- **Evidence expectations:** Automated — docs render/link checks the repo already runs. Operator-observed — reviewer confirms documented limits/security guarantees match the implemented code paths, with file/line pointers in the working record. No new claims beyond implemented behavior; "demo-only" framing preserved where applicable.

### #215 — Complete final implementation review and branch handoff (`psyche-i7c.10.6`)

- **Work:** Perform whole-branch spec review, code-quality review, dependency-cycle/lint checks, clean-worktree validation, and prepare the branch for PR/merge handoff.
- **Acceptance criteria (verbatim-faithful):**
  - All phase gates are closed.
  - `bd lint` and `bd dep cycles` report clean.
  - Final reviewer reports no Critical or Important defects.
  - Branch is clean, documented, tested, and ready for integration.
- **Risk class: R3.** This is the phase's recovery/persistence review gate: threat/failure-boundary review of #210/#211 behavior, compatibility evidence, and negative tests are reviewed here before handoff, plus independent review per AGENTS.md R3.
- **Evidence expectations:** Operator-observed — the independent reviewer's findings record (no Critical/Important defects, or their resolution), run against the exact integration head SHA. Automated — `bd lint`, `bd dep cycles`, clean-worktree validation, and the phase gate record validated by `validatePhaseGateRecord` with all children `pass`.

## Gate contract (this slice)

`src/mobile/phase10Gate.ts` (v1) is the machine-checkable form of this plan:

- `PHASE10_CHILDREN` / `PHASE10_DEPENDENCY_EDGES` — the registry and edges above (child ids are Bead ids; mirror numbers #210–#215 are tracking references only).
- `gateOrder()` — deterministic topological integration order, ties broken by Bead sequence.
- `validatePhaseGateRecord(record)` — strict validator over the v1 record: exactly the six children, each `pass`/`fail`/`not-run` with a non-empty evidence pointer; unknown, duplicated, or missing children and invalid statuses fail closed; `phaseClosed: true` is rejected while any child is not `pass` (blocked children prevent parent closure).
- `phaseClosureReadiness(record)` — closure summary; a child is blocked when it or any transitive prerequisite has not passed.

Evidence pointers in gate records point at retained working/acceptance records, never inline bulk logs.

## Evidence expectations (phase-wide)

- Every child retains a working record under `docs/working-records/` with outcome, scope, risk class, exact commands and observed results, exact head SHA, and explicit proof gaps. Test counts never substitute for user-path evidence (AGENTS.md).
- Automated proof: focused tests and gates runnable in CI (Quality and change-classified runners). Skipped CI jobs are documented, not claimed.
- Operator-observed proof: simulator/device walkthroughs and the paired-host live scenario, recorded with target, OS, settings, and bounded outputs. Unprovenanced screenshots are not evidence.
- Exact commands and results, or an explicit "not run here / gap" statement, for every claim — including in this plan's children.

## Non-goals

- **No iOS TestFlight or distribution claims.** Physical-device, TestFlight, and distribution claims require separate acceptance evidence this phase does not produce.
- **gh-200 owns availability** and the remaining post-release track; earlier broad prose references for the iOS family are historical/superseded. This phase does not claim availability outcomes.
- **No Psyche protocol conformance claims** (gh-253 profile pin has not landed).
- **No upstream GitHub write-backs** from this pipeline: upstream PR/issue writes are token-denied; execution runs on the fork with real CI, ready for maintainer handoff.
- **No implementation of the children here.** This slice ships the plan and the gate contract only; #210–#215 own their code, tests, and evidence.
- **No changes to** `docs/ROADMAP.md`, `docs/SUPPORT-MATRIX.md`, generated outputs, or recovery/persistence semantics — those belong to their owning surfaces.
- **Desktop/macOS track** is out of scope; this plan governs the mobile/iOS track only.

## Plan change log

- 2026-08-30: Initial plan and v1 gate contract (`src/mobile/phase10Gate.ts`, `__tests__/phase10Gate.test.ts`) authored for OpenCoven/psyche-build#209.
