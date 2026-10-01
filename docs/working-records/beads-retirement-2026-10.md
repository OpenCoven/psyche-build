# Beads retirement — working record

**Outcome:** [#473](https://github.com/OpenCoven/psyche-build/issues/473)  
**Plan:** [2026-10-01-retire-beads-github-projects.md](../superpowers/plans/2026-10-01-retire-beads-github-projects.md)  
**Observed:** 2026-10-01 against `main` `c32dae7414ad9d5d4ee37bac0c9302c24bf1e6c1`

This record holds the public, sanitized evidence for the Beads retirement. The
raw archive holds unpublished Bead descriptions, so it is stored privately by
the accountable owner and is never attached to an issue, PR or release.

## M0 — freeze

The Beads write freeze began at **2026-10-01 19:30 UTC**, as recorded on #473.
The freeze covers the authoritative source: no mutation and no publication.
After it, only isolated, non-publishing commands ran: the disposable bootstrap,
the read-only export, the scratch re-import, and the workflow's ephemeral
dry-run database. The newest Dolt commit is dated 2026-09-11, so no write was
lost to the freeze.

## M1 — archive

The archive was produced from a disposable clone, never the shared checkout,
with Beads CLI **1.2.2** (`6c124203e771`). The `darwin_arm64` release archive was
verified against the release's own `checksums.txt`
(`2aa1245c666419900d2d6993a05049e92c40e0e601d19579cca5b07a7bb8021d`). The clone
was bootstrapped from the repository's Dolt remote.

| Item | Value |
|---|---|
| Dolt head | `ogijj1qeoj4tbmht3lc2jkcs48fsuhlv` (2026-09-11) |
| Beads | 111 (97 closed, 11 open, 3 in progress) |
| By type | 89 task, 18 feature, 4 epic |
| By priority | 54 P0, 48 P1, 9 P2 |
| With a `gh-` `external_ref` | 28 |
| Dependency edges | 219 |
| Audit `events` rows | 1,409 |
| `.beads/interactions.jsonl` rows | 114 |

| Archive file | SHA-256 |
|---|---|
| `beads-issues.jsonl` (`bd --readonly export`) | `3a45c6642f271ff8cd27332279d592432df03504fb8028cec547fb83e7933730` |
| `beads-all.jsonl` (`bd --readonly export --all`) | `3a45c6642f271ff8cd27332279d592432df03504fb8028cec547fb83e7933730` |
| `beads-events.json` (the Dolt `events` table) | `e3505958b5c2e04b43588b7e686e802658632a81fb0cb7e4aededb80bee0dc5b` |
| `beads-embeddeddolt.tar.gz` (full Dolt database and history) | `23de2e7016da01c1d6624709d5d65438e9279e4485269ef562c4d012c03d89f0` |
| `interactions.jsonl` | `2ff0cf1f61630aa45482d0870302a80dacdfb10885d75c799d10872079e16a21` |

`--all` added no records beyond the default export, so the two exports are
byte-identical. `bd sql` is unsupported in embedded mode. The `events` table was
therefore read with `dolt sql` from a copy of the database, never from the
original.

**Verification:**

- The JSONL re-imported into a fresh 1.2.2 database with 111 Beads, and the 111 IDs matched.
- The tarball restored to the same Dolt head, with 111 issues.

**Location:** an owner-held private directory with `0700` permissions, outside
every checkout. It is named here by role only, as the protected-data rules
require.

## M2 — writer stopped

- **Final dry run.** Run [36915661182](https://github.com/OpenCoven/psyche-build/actions/runs/36915661182) was a `workflow_dispatch` with `dry_run: true` on 2026-10-01 at `c32dae74`, approved through the `beads-project-sync` environment. It succeeded, every step passing, and logged `Beads Project sync dry run planned 0 operations.` The source and the managed mirrors agreed at retirement.
- **Local drift validator.** Not run to completion. Its public inventory fetch is deliberately unauthenticated, and it hit the anonymous GitHub rate limit (HTTP 403). The offline `--issues-file` mode still requires a live inventory for #420 recovery verification. The zero-operation dry run is the retained evidence.
- **Sync disabled.** At 2026-10-01 19:43 UTC, `gh workflow disable beads-project-sync.yml` was run, and the workflow then reported `disabled_manually`. No mirror was edited before this point.

## M3 — mirrors adopted or closed

All 14 open mirrors were triaged. Their bodies before the change are saved in the private archive.

| Disposition | Issues |
|---|---|
| Adopted: generated sections, markers and Beads labels removed, `[psyche-…]` title prefix dropped, issue type set, and a `Legacy Bead ID` line added | #208, #209, #213, #215, #216 (iOS, under #200); #229, #232 (graphics, under #476) |
| Closed as not planned, following #246 | #222, #223, #224, #225, #226, #227 |
| Closed as not planned; bounded remainder moved to #476 | #228 |

The existing native parent and `blocked by` links that the synchronizer created were kept. #208 was attached under #200, and #229 was re-parented from #228 to #476. The 37 previously closed mirrors were left untouched.

## M4 — Project reshaped

Project #11 is now titled **Psyche Build** and has a hand-written README.

- **Fields.** Status (Triage, Backlog, Ready, In Progress, In Review, Blocked, Done) and Priority (P0–P2) were updated. Train, Risk and Evidence were added. `Bead ID`, `Bead Type`, `Parent Goal` and `Source Updated` were deleted.
- **Views.** Portfolio, Board, Triage, Current milestone, Blocked and Needs evidence. The stray default view was deleted.
- **Items.** All 23 open issues were added with Status, Priority, Train and Risk set, and closed former mirrors were moved to Done. The hand-written iOS and OpenCoven outcomes were linked as sub-issues (#241, #242, #280 and #435 under #200; #253 and #279 under #201).
- **Labels.** `bead`, `bead:epic`, `bead:feature`, `bead:task`, `priority:P0`–`P4` and `status:blocked` were deleted. `outcome`, `needs-triage` and eight `area:*` labels were created.
- **Not reachable through the API.** The built-in Project workflows (auto-add, item added to Triage, item closed to Done, PR merged to Done, auto-archive) and view grouping must be configured in the Project settings UI.

## Retained until M7

These stay until at least 14 days after the code-removal PR merges, so that
rollback stays cheap:

- the remote refs `refs/dolt/data`, `refs/heads/__dolt_remote_info__`, `refs/heads/psyche-beads-project-sync-lock` and `refs/heads/feature/beads-duplicate-reconciliation-420`;
- the `BEADS_PROJECT_TOKEN` secret;
- the `beads-project-sync-automation` and `beads-project-sync` environments.
