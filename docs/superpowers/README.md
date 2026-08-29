# Dated design and implementation records

`docs/superpowers/` preserves design and implementation records created during Psyche Build development. These files are valuable provenance, but they are **not** the executable backlog, current support contract, or proof that a feature shipped.

## Classification

As of 2026-08-28, every existing file under:

- `docs/superpowers/plans/*.md`
- `docs/superpowers/specs/*.md`

is classified **`reference`** unless a future controlled change adds an explicit per-file override here.

`reference` means: retain the document for historical reasoning and implementation context; do not infer current priority, completion, support, authority, or release status from it.

This classification is deliberately conservative. It does **not** silently relabel a historical proposal as `implemented` or `superseded` without current evidence. If old work becomes active again, create or reopen an owning GitHub outcome and route it through the current roadmap rather than making the dated record itself authoritative.

## Allowed classifications

| State | Meaning |
|---|---|
| `active` | Current work explicitly owned by a live GitHub outcome and current roadmap entry. |
| `implemented` | The historical design is retained and durable delivery evidence proves the described bounded outcome shipped. |
| `superseded` | A named newer design/contract replaces this record for current decisions. |
| `reference` | Historical context only; no current delivery or support claim follows from the file. |

The current default is `reference` for all dated records because live implementation status belongs elsewhere.

## Current authority order

When a dated record conflicts with current state, use these sources in order:

1. the owning GitHub issue or pull request for live ownership, blockers, and evidence;
2. `docs/ROADMAP.md` for active delivery policy;
3. `docs/POST-RELEASE-EXECUTION.md` for current sequencing and gates;
4. `docs/SUPPORT-MATRIX.md` for support claims;
5. `docs/RELEASE-ACCEPTANCE.md` and `docs/RELEASE.md` for publication/user-path proof;
6. current architecture/security contracts such as `docs/CONTROL-PLANE.md`, `docs/AGENT-SURFACE-CONTROL.md`, `docs/BRIDGE-SECURITY.md`, and `docs/PSYCHE-COMPATIBILITY-MAP.md`;
7. dated `docs/superpowers/` records for historical context.

## Promotion or reclassification rule

A change from `reference` to another state must name:

- the exact dated record;
- the current owning GitHub outcome;
- the canonical current contract it maps to;
- evidence for `implemented`, or the exact successor for `superseded`;
- any support/compatibility consequence.

Do not rewrite the historical document merely to make it look current. Record the new classification here and update the live authority surface instead.

## Agent rule

Autonomous contributors may read these records to understand intent, but must not:

- treat unchecked task lists as current work;
- infer support from an implementation plan;
- resurrect old schema/authority semantics when current contracts differ;
- use a dated record as the sole justification for a cross-repository or protected-state change.

Route active work through `AGENTS.md`, `docs/REPOSITORY-MAP.md`, and the owning GitHub outcome.