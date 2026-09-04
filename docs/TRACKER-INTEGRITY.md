# Tracker integrity

Psyche Build uses Beads as the authoritative implementation-planning store and GitHub Issues/Project as a sanitized public mirror. Tracker integrity means those two surfaces agree on the bounded facts that influence delivery decisions without making either tracker part of runtime identity.

## Local validation

From a configured checkout with a local Beads database:

```bash
node scripts/validate-beads-tracker.mjs
```

The command performs a read-only Beads export and fetches only the repository's **public GitHub issue inventory** using unauthenticated HTTPS. It does not read `GH_TOKEN`, `GITHUB_TOKEN`, or `BEADS_PROJECT_TOKEN`, and it makes no GitHub mutation.

The public inventory follows GitHub REST `Link` pagination and, when a response
omits `Link`, continues through full pages until it receives a short or empty
page. The default safety bound is 1,000 pages rather than 1,000 issues. Override
it explicitly when necessary:

```bash
node scripts/validate-beads-tracker.mjs --max-issue-pages 2000
```

For a clean checkout whose Beads database has not been initialized, bootstrap Beads explicitly, then rerun:

```bash
bd bootstrap --yes
node scripts/validate-beads-tracker.mjs
```

Dry-run source loading intentionally never bootstraps or migrates Beads on the caller's behalf. The sole-migrator rule in [`.beads/README.md`](../.beads/README.md) still applies during schema/version migrations.

For deterministic offline/CI validation, the repository includes a synthetic source/mirror pair:

```bash
node scripts/validate-beads-tracker.mjs \
  --inventory-file __tests__/fixtures/beads-project-sync/tracker-beads.jsonl \
  --issues-file __tests__/fixtures/beads-project-sync/tracker-issues.json
```

That exact command is exercised by `__tests__/trackerDriftValidation.test.ts` with fake token environment variables present, proving the offline path does not need or consume them. `--issues-file` accepts the ordinary GitHub REST issue-array shape. Keep retained fixtures synthetic or public and bounded; do not store credentials, private issue bodies, raw prompts, terminal output, or private paths.

## What the check proves

The validator composes two contracts rather than replacing the synchronizer:

1. Existing canonical-outcome validation requires every **active** Bead to carry one configured `external_ref` (`gh-<issue>`) and requires its Beads priority to match that canonical outcome's configured priority.
2. The drift validator compares every public Bead with its managed GitHub mirror and detects:
   - missing, malformed, or unknown canonical mappings;
   - canonical target priority disagreement;
   - missing mirrors for active Beads;
   - orphan mirrors;
   - duplicate managed Bead IDs;
   - missing, duplicate, empty, or malformed managed Bead markers;
   - duplicate, empty, or malformed render-hash markers;
   - open/closed state disagreement;
   - missing, extra, or noncanonical labels in the managed `priority:`
     namespace;
   - obsolete `release-blocker` metadata;
   - generated `Source status` disagreement;
   - generated `Source priority` disagreement;
   - missing render-hash evidence;
   - valid-looking render hashes that do not match the canonical managed body.

The synchronizer publishes a managed issue only for a Bead that is active or
already mirrored; a closed Bead that was never published stays in the public
Project README's closed history instead. The drift validator applies the same
rule, so an absent mirror is drift only for an active Bead. Requiring an issue
for every closed Bead would report permanent findings that the supported
synchronizer can never repair, which is why the check counts fewer managed
mirrors than source Beads.

Generated issue and render-hash comments use the exact lowercase marker and
field spelling emitted by the synchronizer. Case variants and other
marker-like HTML comments are malformed; ordinary prose is not interpreted as
managed metadata. A render-hash comment without a valid Bead marker remains a
managed malformed issue rather than disappearing from validation.

Malformed active `external_ref` values are retained only long enough for the
canonical-outcome validator to classify them as bounded
`canonical_mapping_malformed` drift. They are never treated as valid mappings.

The command exits:

- `0` when no drift is found;
- `1` when the bounded report contains drift or invariant findings, including
  canonical source mapping failures and malformed managed issue markers;
- `2` when evidence cannot be established, including network, authentication or
  rate-limit failures, unreadable or invalid inventory input, invalid
  configuration, Beads bootstrap/tool execution failures, and invalid command
  options.

Option errors and evidence-loading failures are handled inside the command.
They produce one bounded stderr line without a stack trace. Filesystem failures
identify only the input role (for example, inventory input), never the supplied
path or raw exception. Environment tokens and credential values are never
included.

Managed issue authors are compared case-insensitively against
`trustedIssueAuthors`, matching GitHub login semantics. A malformed managed
issue contributes bounded findings and does not prevent validation of the
remaining public inventory.

## Bounded retained evidence

Output is JSON and intentionally contains only bounded control-plane fields:

```json
{
  "schemaVersion": 1,
  "result": "pass",
  "sourceCount": 111,
  "managedMirrorCount": 27,
  "canonicalOutcomeCount": 26,
  "findingCount": 0,
  "findings": [],
  "findingsOmitted": 0
}
```

A failing report includes at most 100 findings. Findings contain only the
finding kind, Bead ID when safely available, public issue number, expected
Beads status/priority, public issue state, and observed generated
`mirrorSourceStatus`/`mirrorSourcePriority` metadata where applicable.
Descriptions, prompts, terminal output, credentials, local paths, and full
issue bodies are never copied into the report.

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
