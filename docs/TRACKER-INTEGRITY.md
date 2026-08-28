# Tracker integrity

Psyche Build uses Beads as the authoritative implementation-planning store and GitHub Issues/Project as a sanitized public mirror. Tracker integrity means those two surfaces agree on the bounded facts that influence delivery decisions without making either tracker part of runtime identity.

## Local validation

From a configured checkout with a local Beads database:

```bash
node scripts/validate-beads-tracker.mjs
```

The command performs a read-only Beads export and fetches only the repository's **public GitHub issue inventory** using unauthenticated HTTPS. It does not read `GH_TOKEN`, `GITHUB_TOKEN`, or `BEADS_PROJECT_TOKEN`, and it makes no GitHub mutation.

For a clean checkout whose Beads database has not been initialized, bootstrap Beads explicitly, then rerun:

```bash
bd bootstrap --yes
node scripts/validate-beads-tracker.mjs
```

Dry-run source loading intentionally never bootstraps or migrates Beads on the caller's behalf. The sole-migrator rule in [`.beads/README.md`](../.beads/README.md) still applies during schema/version migrations.

For deterministic offline/CI fixtures, provide both source inventories explicitly:

```bash
node scripts/validate-beads-tracker.mjs \
  --inventory-file __tests__/fixtures/beads-project-sync/issues.jsonl \
  --issues-file /path/to/sanitized-public-github-issues.json
```

`--issues-file` accepts the ordinary GitHub REST issue-array shape. Keep retained fixtures synthetic or public and bounded; do not store credentials, private issue bodies, raw prompts, terminal output, or private paths.

## What the check proves

The validator composes two contracts rather than replacing the synchronizer:

1. Existing canonical-outcome validation requires every **active** Bead to carry one configured `external_ref` (`gh-<issue>`) and requires its Beads priority to match that canonical outcome's configured priority.
2. The drift validator compares every public Bead with its managed GitHub mirror and detects:
   - missing mirrors;
   - orphan mirrors;
   - duplicate managed Bead IDs;
   - open/closed state disagreement;
   - `priority:Pn` label disagreement;
   - generated `Source status` disagreement;
   - generated `Source priority` disagreement;
   - missing render-hash evidence.

The command exits:

- `0` when no drift is found;
- `1` when the bounded report contains drift findings;
- `2` when the source/config/public-inventory check itself cannot be completed safely.

## Bounded retained evidence

Output is JSON and intentionally contains only bounded control-plane fields:

```json
{
  "schemaVersion": 1,
  "result": "pass",
  "sourceCount": 111,
  "managedMirrorCount": 111,
  "canonicalOutcomeCount": 26,
  "findingCount": 0,
  "findings": [],
  "findingsOmitted": 0
}
```

A failing report includes at most 100 findings. Findings contain only the finding kind, Bead ID, public issue number, source/mirror status, and source priority where applicable. Descriptions, prompts, terminal output, credentials, local paths, and full issue bodies are never copied into the report.

## Source-first repair

A drift report is evidence, not mutation authority.

- If Beads is wrong, repair the Bead through the reviewed Beads workflow first.
- If the generated mirror is stale, run the supported Beads Project synchronizer after the Beads source is correct.
- Never repair a managed GitHub issue body manually as the durable fix.
- Never change `external_ref` merely to silence a validator failure; the target must represent the actual canonical public outcome or an explicitly approved maintenance bucket.

After a repair, retain the before report, reviewed source change, synchronizer evidence, and final zero-finding report in the owning outcome.

## Current reconciliation note

The former `psyche-310` / GitHub #206 mismatch is now reconciled source-first: the generated issue reports Bead/source status `closed` and GitHub issue #206 is closed. The regression test deliberately reconstructs the earlier class of mismatch and proves that the validator reports it, while the reconciled fixture shape passes.

## Non-goals

This check does not:

- make Beads or GitHub canonical runtime identity for tasks, lanes, actions, artifacts, receipts, familiars, or threads;
- infer product completion from a tracker state;
- mutate GitHub or Beads;
- use hidden credentials for ordinary local validation;
- replace the existing Project reconciliation dry-run/apply path;
- prove CODEOWNERS, branch governance, release readiness, or Psyche protocol conformance.
