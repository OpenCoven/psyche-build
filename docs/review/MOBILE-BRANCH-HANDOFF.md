# Mobile multiproject/multipane cockpit — final implementation review and branch handoff

- **Contract owner:** `psyche-i7c.10.6` — Complete final implementation review and branch handoff ([OpenCoven/psyche-build#215](https://github.com/OpenCoven/psyche-build/issues/215))
- **Epic:** `psyche-i7c` — Mobile multiproject and multipane cockpit ([#208](https://github.com/OpenCoven/psyche-build/issues/208))
- **Canonical outcome:** #200 (iOS internal beta and continuity loop). Earlier broad prose references to the gh-195 outcome for this iOS family are historical/superseded (2026-08-28 reconciliation note); #200 stays the source of truth.
- **Phase 10 parent:** `psyche-i7c.10` ([#209](https://github.com/OpenCoven/psyche-build/issues/209)) — recovery, persistence, accessibility, and acceptance
- **Integration branch under review:** `feat/mobile-multiproject-cockpit`
- **Machine-checkable companion:** [`src/review/handoffChecklist.ts`](../../src/review/handoffChecklist.ts) (record schema **v1**)
- **Contract version:** v1, 2026-08-30

This document defines the review and handoff **contract** for the mobile multiproject/multipane track. It is not itself evidence: every gate below is closed only by a handoff record entry with a verifiable evidence pointer. The implementation slices themselves belong to the #208–#214 phase family; this contract defines how their handoff is validated.

## 1. Purpose, scope, and authority

### Purpose

Close the mobile delivery track by (a) reviewing the whole `feat/mobile-multiproject-cockpit` branch against its specification, (b) reviewing code quality with severity-classified findings, (c) validating tracker and worktree hygiene, and (d) producing one handoff record that lets a maintainer accept or reject the branch for PR/merge without tribal knowledge.

### Scope

- Whole-branch spec review checklist (§2) and code-quality review checklist (§3) for the mobile track.
- Beads hygiene criteria for `bd lint` and `bd dep` cycle-clean (§4), recorded as a **gate for the branch owner** because the `bd` CLI and Beads database are not reachable from the final-review agent environment.
- Clean-worktree validation steps (§5).
- Phase-gate closure map for `psyche-i7c.9.x` and `psyche-i7c.10.1–10.6` (§6).
- Independent-review acceptance criteria and the branch-ready definition (§7).
- The versioned handoff record contract (§8) and the PR/merge handoff record template (§9).

### Out of scope

- Implementing or re-implementing any phase slice (#208–#214 own their deliverables).
- Merging, closing issues, editing Beads records, or pushing to `main`. Handoff terminates in a ready (or explicitly blocked) PR and record; merge is a maintainer action.
- Earlier phases `psyche-i7c.1–8.x`: they are epic prerequisites verified through the epic (#208) status and the §2 spec trace, not re-reviewed here.

### Authority boundaries that review must preserve

Per `AGENTS.md` and the control-plane docs, the branch must not: direct-read Psyche's database, duplicate canonical protocol state, infer authority or completion from a UI selection, tmux pane, process, path, worktree, branch, provider session, Bead, or GitHub issue, or weaken confirmation/receipt/revocation/idempotency/persistence/recovery behavior. The paired host remains the single source of truth for workspace, action, merge/PR, and cleanup validation; the mobile client consumes versioned protocol envelopes over the pinned TLS/Bonjour bridge.

## 2. Whole-branch spec review checklist

Execute against the full `feat/mobile-multiproject-cockpit` diff (base `origin/main` → handoff head). Every row must be traced to implementation, tests, and phase evidence. Checklist item id `handoff.spec-review` closes this section; the per-gate ids close the phase rows.

| # | Spec requirement (source) | Review question | Trace to |
|---|---|---|---|
| S1 | Now inbox ranks Needs You, Running, and Recent across projects (#208) | Does ranking match the published snapshot semantics, with no client-invented priority? | §6 rows 10.1–10.2; snapshot/adapter code + tests |
| S2 | iPhone supports one focused pane; landscape/iPad can show two explicit panes (#208) | Is the pane-count rule enforced in behavior, not only in copy? | Pane composition code + UI fixtures |
| S3 | No more than two terminal sessions are attached/rendered (#208) | Is the attach bound enforced at the stream layer with a deterministic test? | Stream lifecycle code + tests |
| S4 | Pairing, certificate pinning, terminal streams, files/diffs, actions, pane creation, merge/PR/cleanup work end-to-end (#208) | Does each capability have end-to-end (not unit-only) coverage through the paired host? | §6 rows 9.2–9.5; host regression suites |
| S5 | Existing protocol-v2 behavior remains compatible (#208) | Are v2 clients unaffected: no schema/error/persistence changes without an approved design? | Compatibility tests; CHANGELOG/BREAKING-CHANGES diff scan |
| S6 | Cache is bounded and protected (#210) | Atomic writes, complete-until-first-auth protection, host keying, size/draft bounds, no credentials/full source/transcripts? | §6 row 10.1 |
| S7 | Restored state is never live (#211) | Stale presentation, disabled mutations until recovery, safe reconcile of deleted/renamed panes? | §6 row 10.2 |
| S8 | Accessibility and motion semantics complete (#212) | Do mobile surfaces meet the phase-gate semantics (labels, focus, reduced motion)? | §6 row 10.3 |
| S9 | Performance and full acceptance matrix pass (#213) | Are all matrix cells green on the handoff head, including pane/stream bounds and offline gates? | §6 row 10.4 |
| S10 | Documentation reflects the live architecture (#214) | Do product/architecture docs describe what shipped, not what was planned? | §6 row 10.5 |
| S11 | Lifecycle actions reuse existing host workflows (#217–#221) | No bypass of merge/PR/cleanup safeguards; confirmations, choices, merge-target logic preserved? | §6 rows 9.2–9.5 |
| S12 | Authority and scope preserved (AGENTS.md) | Host authoritative for all validation; no direct DB reads; no duplicated protocol identity; scoped to published workspace resources? | Code review of adapters/control seams; security review notes |

**Exit rule:** S1–S12 all traced with pointers, and every phase row in §6 pass or explicitly closed. Unresolved spec gaps are findings (§3 severity rules) and must block `handoff.spec-review`.

## 3. Code-quality review checklist

Checklist item id `handoff.code-quality-review` closes this section. Review the whole branch diff, not slice-by-slice only; seams between phases are where quality defects hide.

### Structure and layering

- C1: One canonical multiproject workspace snapshot flows to the Swift `WorkspaceStore`; no parallel snapshot models that can diverge.
- C2: Versioned adapters mediate all protocol contracts; no direct database reads; no client-side reimplementation of host authority.
- C3: The one/two-pane and ≤2-attached-streams constraints are structural (enforced by store/attachment logic), not conventions.
- C4: Lifecycle actions call existing host action workflows; duplicate merge/cleanup logic on the client is a finding.

### Correctness and state authority

- C5: Snapshot apply ordering is safe: paired-host identity and selected-host state persist **before** a new workspace snapshot applies; a failed readiness never presents fresh state as live (rollback paths defined for transport, auth, secure-store, decode/revision, and apply failures).
- C6: Cached/restored state is visibly stale and mutations stay disabled until live recovery; disconnect keeps a viewable bounded cache only.
- C7: No silent fallbacks that hide missing production paths (e.g. serializing empty lists to mask an unimplemented executor). Fixture-only success never substitutes for the live path.
- C8: Explicit failures for oversized caches and decode/revision failures; no swallowed errors on persistence or recovery boundaries.

### Security and privacy

- C9: Certificate pinning and pairing state unchanged; no loosening of project-boundary enforcement.
- C10: No credentials, full source, transcripts, or raw prompts in caches, logs, fixtures, screenshots, or the handoff record itself.
- C11: All operations scoped to published workspace resources; offline state visibly stale.

### Tests and compatibility

- C12: Every state transition and failure boundary in the recovery/persistence design has a deterministic test; destructive flows have tested confirmation/cancel paths.
- C13: Existing host merge/action/PR regressions remain green; protocol-v2 compatibility tests unchanged or extended additively.
- C14: Determinism: no wall-clock/sleep-dependent assertions; fixtures assert scoped metadata and consequences.

### Hygiene

- C15: Generated outputs untouched by hand (`src/utils/generated-agents-doc.ts`, web bundles, Xcode project, `dist/**`); generators verified reproducible where run.
- C16: No dead feature flags, commented-out code, or debug logging left in the handoff head; naming and typing consistent with the repo's strict TypeScript/Swift conventions.

### Severity classification and blocking rule

| Severity | Definition | Examples |
|---|---|---|
| **Critical** | Violates authority, security, persistence, recovery, idempotency, or compatibility contracts; risks data loss or credential exposure | Fresh state shown after failed commit; pinning weakened; credentials cached |
| **Important** | Contract/spec deviation, missing failure-boundary coverage, wrong ordering with user-visible consequence | Untested rollback path; stale state actionable; safeguard bypassed |
| **Minor** | Style, naming, doc polish, test ergonomics | Cosmetic issues, redundant helpers |

**Blocking rule:** the handoff is blocked while any Critical or Important finding is open. Minors may be deferred with an owner-acknowledged list in the handoff record.

## 4. Beads hygiene — `bd lint` and `bd dep` cycle-clean (gate for the branch owner)

Acceptance criteria for this gate (from #215): `bd lint` and `bd dep` cycles report clean.

- **`bd lint` clean:** `bd lint` exits successfully with no findings in the repository root of the integration branch.
- **`bd dep` cycle-clean:** the dependency graph across the phase family (`psyche-i7c`, its phases, and children) contains **no dependency cycles**; `bd dep` cycle output is empty or explicitly cycle-free.
- **Mirror consistency:** beads statuses reflect phase closure (a closed phase's Bead must not remain blocked by an open child); any drift is repaired in Beads and re-synced by the supported synchronizer — never by hand-editing mirror issue bodies (`.beads/README.md`, sole-migrator rule).

**Gate-for-owner — environment limitation (recorded, not waived):** the `bd` CLI and the Beads database are **not runnable in the final-review agent environment** (no Beads CLI/database access on this host). This evidence therefore cannot be produced by the reviewer. The **branch owner** must run, from the integration branch checkout:

```bash
bd lint          # expected: no findings
bd dep           # expected: no cycles reported
```

and record in the handoff record: the exact command, the run date, the output digest or a durable output pointer, and the Beads repo/branch it ran against. Checklist items `handoff.beads-lint` and `handoff.beads-dep-cycles` stay `not-run` (handoff blocked) until that owner-run output exists. A reviewer must never mark these items `pass` on speculation, and `not-applicable` is not a legal verdict for them.

## 5. Clean-worktree validation

Run from the integration-branch worktree at the exact head under review; capture the transcript as the evidence pointer for `handoff.clean-worktree`.

```bash
# 1. Worktree is clean: expect empty output.
git status --porcelain

# 2. No whitespace/conflict-marker errors: expect no output, exit 0.
git diff --check
git diff --cached --check

# 3. Record the exact reviewed head (must equal the PR head SHA).
git rev-parse HEAD

# 4. Branch relationship: count commits ahead of the base (expect only the
#    phase-family commits; investigate anything else).
git fetch origin
git rev-list --count origin/main..HEAD

# 5. No stray stash carrying review-relevant changes: expect empty.
git stash list

# 6. No untracked scratch/secret files: expect nothing relevant beyond
#    gitignored build output.
git status --ignored --porcelain | head -50

# 7. Generated outputs are not hand-modified: re-derive and compare where the
#    slice touched a generator input (e.g. pnpm generate:hooks-docs), leaving
#    the tree clean afterward.
```

Pass criteria: steps 1–2 empty, step 3 recorded, step 4 explains every commit, steps 5–6 show no undeclared state, step 7 leaves the tree clean. A dirty tree, an unexplained ahead-count, or generator drift fails this gate.

## 6. Phase-gate closure map

The handoff checklist groups one machine-checkable gate per phase Bead. Parent phases (#217, #209) close as **derived conditions**: all of their child gates below must be pass (or explicitly closed in Beads) — they carry no separate checklist item. `psyche-i7c.9.1` is closed history per the Beads dependency record and needs no new closure evidence.

| Phase gate | Bead | Issue | Closure criterion (from the Bead) | Checklist item id |
|---|---|---|---|---|
| Pane action menu + guarded confirmations | `psyche-i7c.9.2` | #218 | Stop/cleanup distinct; consequence named before its button; stale/running actions disabled; result/error/progress visible | `i7c.9.2.pane-action-menu-confirmations` |
| Merge/PR interactive workflows exercised | `psyche-i7c.9.3` | #219 | Merge confirmation/choice chains reach terminal outcomes; PR review editable; cancel explicit and single-use; host authoritative | `i7c.9.3.merge-pr-workflow-evidence` |
| Lifecycle action UI + host coverage | `psyche-i7c.9.4` | #220 | Every destructive flow has a tested confirmation/cancel path; merge/PR host regressions green; fixtures assert scoped metadata | `i7c.9.4.lifecycle-ui-host-coverage` |
| Full lifecycle validation + review | `psyche-i7c.9.5` | #221 | Lifecycle host/core/UI suites pass; spec/security/code-quality review approves; no safeguard bypass | `i7c.9.5.lifecycle-review-signoff` |
| Bounded protected workspace cache | `psyche-i7c.10.1` | #210 | Same-host restore; other-host never restores; oversized cache fails explicitly; file protection + atomic writes tested | `i7c.10.1.workspace-cache-protection` |
| Restored vs live state, stale UX | `psyche-i7c.10.2` | #211 | Cached state never presented as live; successful snapshot clears stale + persists; disconnect keeps bounded cache, disables live actions; safe reconcile | `i7c.10.2.stale-state-reconciliation` |
| Accessibility + motion semantics | `psyche-i7c.10.3` | #212 | Phase-gate accessibility and motion semantics complete for the mobile surfaces | `i7c.10.3.accessibility-motion-semantics` |
| Performance + full acceptance matrix | `psyche-i7c.10.4` | #213 | Performance gates and the full acceptance matrix pass on the handoff head | `i7c.10.4.performance-acceptance-matrix` |
| Product/architecture documentation | `psyche-i7c.10.5` | #214 | Documentation reflects the live architecture | `i7c.10.5.documentation-currency` |
| Final review + branch handoff | `psyche-i7c.10.6` | #215 | This contract executed; checklists complete; findings triaged; record filled and validated | `i7c.10.6.final-review-handoff` |
| Whole-branch spec review | — | #215 | §2 checklist S1–S12 traced | `handoff.spec-review` |
| Whole-branch code-quality review | — | #215 | §3 checklist executed; no open Critical/Important | `handoff.code-quality-review` |
| Beads lint clean | — | #215 | `bd lint` clean (§4, owner-run) | `handoff.beads-lint` |
| Beads dependency cycles clean | — | #215 | `bd dep` reports no cycles (§4, owner-run) | `handoff.beads-dep-cycles` |
| Clean worktree | — | #215 | §5 steps pass at the reviewed head | `handoff.clean-worktree` |
| Required checks green | — | #215 | CI terminal and green on the reviewed head (skipped counts as green) | `handoff.required-checks-green` |
| Independent review | — | #215 | §7 sign-off, no Critical/Important open | `handoff.independent-review` |
| Branch-ready definition | — | #215 | §7 definition satisfied | `handoff.integration-ready` |

## 7. Independent review and the branch-ready definition

### Independent-review acceptance criteria

1. **Reviewer independence:** the final reviewer must not be an author or maintainer of the reviewed slices; slice-internal self-review does not satisfy this gate.
2. **Inputs:** the §2 and §3 checklist outputs, the phase-gate evidence from §6, and the negative tests for authority/security boundaries (lifecycle actions, persistence, recovery are R3-class under `AGENTS.md`).
3. **Verdict:** *no Critical or Important defects open.* Every finding is severity-classified with a resolution (fixed, or owner-deferred for Minor only). The verdict, findings list, and resolutions are the evidence pointer for `handoff.independent-review`.
4. **Negative testing:** the review confirms the failure boundaries (snapshot-before-commit, secure-store failure, oversized cache, transport/auth failure, stale-state mutation guards) are tested, not just implemented.

### Branch-ready definition

The mobile branch is handoff-ready when **all four** hold:

- **Clean** — §5 worktree validation passes; Beads hygiene (§4) is owner-verified clean; no undeclared stray branches/worktrees/STASH state; PR head equals the reviewed head.
- **Documented** — product and architecture docs reflect the live architecture (`i7c.10.5`); this contract's §6 map is filled; the handoff record explains any deferral.
- **Tested** — the phase suites pass locally where the host supports them (recorded with exact commands); required CI checks are terminal and green on the handoff head (skipped counts as green); the full acceptance matrix (#213) is green.
- **Integration-ready** — the branch rebases/merges cleanly against current `origin/main` (or conflicts are declared with a resolution plan in the handoff PR); no work remains that only exists in someone's head; and the machine-validated record reports `ready`:

```ts
import { handoffReadiness, validateHandoffRecord } from '../src/review/handoffChecklist.js';

const validation = validateHandoffRecord(record); // strict structural check
const readiness = handoffReadiness(record);       // 'ready' | 'blocked' + reasons
```

`ready` requires: valid schema v1 record, every checklist item present, every verdict `pass` or `not-applicable` **with a non-empty evidence pointer**, and no gate `fail` or `not-run`. Any other state blocks the handoff and the reasons list says exactly which gates block it.

## 8. Handoff record contract (schema v1)

The record is plain JSON-shaped data validated by `src/review/handoffChecklist.ts`. Rules:

- `schemaVersion` must be `1`. Unsupported versions are rejected, never reinterpreted.
- `items` must contain an entry for **every** checklist item id; an omitted item is rejected as `missing-item` and blocks as not-run.
- Allowed root fields: `schemaVersion`, `branch`, `reviewedHead`, `reviewer`, `items`. Allowed item fields: `status`, `evidence`. Anything else — at either level, including item ids not in the v1 checklist — is rejected.
- Every decided item (`pass` / `fail` / `not-applicable`) carries a non-empty `evidence` pointer (durable file path, URL, run id, or command-output location). A `not-run` item must not claim evidence.
- Unknown fields are errors, never warnings. Structural validity (`valid: true`) is necessary but not sufficient: `handoffReadiness()` decides ready vs blocked.

Example of a minimal blocked record (owner-run Beads gates still outstanding):

```json
{
  "schemaVersion": 1,
  "branch": "feat/mobile-multiproject-cockpit",
  "reviewedHead": "<full 40-char sha>",
  "reviewer": "<reviewer>",
  "items": {
    "handoff.beads-lint": { "status": "not-run" },
    "handoff.independent-review": { "status": "pass", "evidence": "docs/review/issue-215-independent-review.md" }
  }
}
```

That record is rejected (`missing-item` for the other 16 gates) and blocked; fill all items to reach `ready`.

## 9. PR/merge handoff record template

Paste into the handoff PR description (or a linked review doc the record points at) and fill every field; keep evidence pointers durable:

```markdown
### Mobile branch handoff record — schema v1 (psyche-i7c.10.6)

- Integration branch: `feat/mobile-multiproject-cockpit`
- Reviewed head: `<full sha>`
- Base: `origin/main @ <sha>`
- Reviewer: `<name/agent>` (independent of the slice authors)
- Record validation: `validateHandoffRecord` → valid; `handoffReadiness` → ready|blocked

| Gate | Bead | Verdict | Evidence |
|---|---|---|---|
| Pane action menu + guarded confirmations | psyche-i7c.9.2 | pass | <pointer> |
| Merge/PR interactive workflows | psyche-i7c.9.3 | pass | <pointer> |
| Lifecycle UI + host coverage | psyche-i7c.9.4 | pass | <pointer> |
| Lifecycle review signoff | psyche-i7c.9.5 | pass | <pointer> |
| Bounded protected workspace cache | psyche-i7c.10.1 | pass | <pointer> |
| Restored vs live state, stale UX | psyche-i7c.10.2 | pass | <pointer> |
| Accessibility + motion semantics | psyche-i7c.10.3 | pass | <pointer> |
| Performance + acceptance matrix | psyche-i7c.10.4 | pass | <pointer> |
| Documentation currency | psyche-i7c.10.5 | pass | <pointer> |
| Final review + handoff record | psyche-i7c.10.6 | pass | <pointer to this record> |
| Whole-branch spec review (§2) | — | pass | <pointer> |
| Whole-branch code-quality review (§3) | — | pass | <pointer> |
| `bd lint` clean (§4, owner-run) | — | pass | <owner-run output, date> |
| `bd dep` cycle-free (§4, owner-run) | — | pass | <owner-run output, date> |
| Clean-worktree validation (§5) | — | pass | <transcript pointer> |
| Required checks green on <sha> | — | pass | <checks link> |
| Independent review, no Critical/Important (§7) | — | pass | <sign-off pointer> |
| Branch-ready definition (§7) | — | pass | <confirmation pointer> |

- Spec review summary: <one paragraph; S1–S12 all traced>
- Code-quality review summary: <Critical: n open / Important: n open / Minor deferred: list>
- Independent review verdict: <no Critical/Important defects open — reviewer, date>
- Residual risks / deferred findings: <list or "none">
- Merge readiness: ready | blocked (<reasons from handoffReadiness>)
```

## 10. Revision policy

Schema v1 (`HANDOFF_RECORD_SCHEMA_VERSION = 1`) and this document are a matched pair: any change to the checklist item set, statuses, or blocking rules bumps the schema version and updates both files in the same controlled change. Records from unsupported versions are rejected, never reinterpreted. Historical prose about this phase family that predates the 2026-08-28 reconciliation remains in the Beads/issues as history; #200 stays the canonical outcome.
