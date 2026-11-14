# Roadmap and execution history moved out in November 2026

This file holds four sections that were moved here, word for word, from
[`docs/ROADMAP.md`](../ROADMAP.md) and
[`docs/POST-RELEASE-EXECUTION.md`](../POST-RELEASE-EXECUTION.md) on 2026-11-14
under [#564](https://github.com/OpenCoven/psyche-build/issues/564). Each source
document keeps the heading and a pointer to this file.

They record delivered work and earlier reconciliations. They are history: do
not read them for current gates, owners, or priorities, and do not treat
anything in them as open work. The current state is in the two source
documents.

Only links were changed, so that they resolve from this directory.

### Roadmap: October 1 reconciliation

Moved from `docs/ROADMAP.md`, section "October 1 reconciliation".

This snapshot was inspected against `main`
`c32dae7414ad9d5d4ee37bac0c9302c24bf1e6c1`. The previous snapshot was 17 days
old, which the standing register treats as control drift; this entry closes it.

- [#196](https://github.com/OpenCoven/psyche-build/issues/196) and
  [#199](https://github.com/OpenCoven/psyche-build/issues/199) were closed as
  completed on 2026-09-16 without evidence comments. The 2026-10-01 decision
  comments keep them closed as history; the closure is not a claim of operator
  acceptance. Release-candidate acceptance moved to #474, the observed recovery
  gaps to #475, and the remaining support-bundle collectors and UI to #476.
- [#239](https://github.com/OpenCoven/psyche-build/issues/239) is closed as not
  planned and superseded by #474: its evidence was pinned to `v0.0.1` source
  while the Cask now installs `0.0.2`. Its 15 digests and
  `terminal_state: incomplete` manifest remain history.
- #246 closed as not planned on 2026-09-16; its Vim mirrors #222–#227 and the
  broad GPU program #228 closed as not planned on 2026-10-01. #229 and #232
  moved under #476.
- Beads was retired under #473. The archive is recorded in
  [the retirement record](./beads-retirement-2026-10.md). A
  final dry run
  ([36915661182](https://github.com/OpenCoven/psyche-build/actions/runs/36915661182))
  planned 0 operations, and the scheduled sync was then disabled. Project #11 is
  now the hand-maintained [Psyche Build Project](https://github.com/orgs/OpenCoven/projects/11).
- The production target is milestone `v0.1.0 — macOS production`, defined by the
  [production-readiness plan](../superpowers/plans/2026-10-01-production-readiness.md)
  (a `reference` record) and outcomes #474–#480.

### Roadmap: September 14 reconciliation

Moved from `docs/ROADMAP.md`, section "September 14 reconciliation".

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
  verification. #196/#239 remained open at that snapshot.
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

### Roadmap: Stage 0 — delivered control-state closure wave

Moved from `docs/ROADMAP.md`, section "Stage 0 — delivered control-state closure wave".

**Owners:** #238, #31, #237, and #240.  
**Historical record (Beads era, to 2026-10-01).**  
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

### Execution contract: Stage 0 — delivered control-state closure wave

Moved from `docs/POST-RELEASE-EXECUTION.md`, section "Stage 0 — delivered control-state closure wave".

**Owners:** #238, #31, #237, and #240.

#238 remains delivered through PR #245 / `5f4b7b05`. #31, #237, and #240 are
closed with the evidence linked in their owning issues: the proof PR, sanitized
policy evidence (later corrected by PR #351), the first apply, and the zero-operation run. Preserve the
deployed single-writer lease, protected `main`-only environments, canonical
target mapping, deterministic drift validation, and bounded GraphQL behavior.
Direct pushes remain platform-blocked; ordinary PR merges require exact-head
checks and resolved conversations, with no standing bypass.

**Exit state:** reached. Roadmap, support claims, branch policy, Beads, GitHub
mirrors, and live PR disposition agree on what is delivered, active, blocked,
and deferred as of this reconciliation.

**Resolved control-state regression:** the scheduled Beads Project sync failed
on every scheduled run from 2026-08-30 until 2026-09-02 because a checkout
running the accidental Beads v1.2.1 release migrated the shared Dolt schema to
v65 and pushed it; the pinned 1.2.2 CLI could not open it. The recovery retained
the Git sidecar at `9c85d2b79e3da16c283278824866a5ba1217950a` and the published
Dolt transition
`0at1pk83ng4ogm45svvp7ip122acgt4h` →
`go64gshichpnsj3islhl6pmv5lgi2teb`. That state restored schema v53,
re-tracked the versioned `events` table, and preserved all 111 Beads. Its 1,362
event rows comprise the last durable pre-ignore snapshot of 1,361 rows plus the
publication transition. Three known post-ignore writes retain their commits and
final source state, but their clone-local event rows are unavailable; this is a
bounded three-write audit gap, not an uninterrupted journal.

The retained qualifying proof begins with scheduled apply
[33880014833](https://github.com/OpenCoven/psyche-build/actions/runs/33880014833)
executed source head `9e4a9cf383a1993ca2c2099e3d296acb3dd3c5b4` on 2026-09-04. It
performed seven operations; from the authoritative
`psyche-z7c.4.4` source, the synchronizer regenerated mirror #230 and ran the
live read-only validator to exit `0`: 111 sources, 27 managed mirrors, 24 canonical
outcomes, and 0 findings. The following scheduled apply
[33953178586](https://github.com/OpenCoven/psyche-build/actions/runs/33953178586)
executed source head `23cace08fdc5e35e3ee0cd46200b4ed3bbd94131` on 2026-09-05,
planned and applied 0 operations, completed every step, reported no warnings or
visibility drift, and retained schema v53.

Mirror #230 was regenerated after its authoritative source entered closed state.
It was last updated by the first run and was never manually edited afterward;
generated-body repair did not supply the proof.

The audit also records two deviations rather than treating them as proof. PR
#346 reviewed unpublished candidate `l3c2l93j2iogl4h3ai947qls2vr10tbp`, while a
different checkout published `go64gshichpnsj3islhl6pmv5lgi2teb`; the intended
logical state agreed, but the exact-candidate gate did not hold. At that PR's
merge, mirror #230 first entered the closed state through GitHub keyword syntax,
not through the synchronizer. PR #350 then documented the recovery before the
second qualifying scheduled run and omitted this documentation contract
assertion. Neither deviation is counted as closeout evidence.

Two contract improvements came out of it and are enforced now: the synchronizer
reports schema skew as a bounded `Beads schema version skew` diagnostic instead
of an unclassified failure, and the drift validator scopes missing-mirror drift
to active Beads so it stops reporting findings the synchronizer cannot repair.
The Beads CLI fleet rule and the closing-keyword rule in `.beads/README.md`
(removed with Beads under #473; see
[the retirement record](./beads-retirement-2026-10.md))
recorded the two recurrence risks:
any clone running a non-pinned CLI can re-migrate the shared schema, and a
GitHub closing keyword before a mirror reference can change mirror state
outside the synchronizer.
[#342](https://github.com/OpenCoven/psyche-build/issues/342) holds the full
evidence under #195.

The later [#420 recovery](https://github.com/OpenCoven/psyche-build/issues/420#issuecomment-5616402711)
is complete: protected apply and normal no-op at source
`73039d5c3827e2f49cf28c7ad7db74cc3b5a5247`, original survivors preserved,
25 approved operations, no newly created issues, then zero operations and a
zero-finding authenticated drift report. The
[roadmap evidence record](#roadmap-stage-0--delivered-control-state-closure-wave)
also retains September 13 scheduled runs 34747362154 and 34761084154 at
`8650344ce560ffcfe190ea99acc2010921409753`: both successful, zero planned/applied
operations, all 14 active sources mapped, and no warnings or visibility drift.
Recent sync health is not exact-current-head execution proof. No Beads or
generated mirror mutation is part of this closeout.
