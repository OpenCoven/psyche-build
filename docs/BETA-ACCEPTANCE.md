# macOS public beta acceptance pass

**Owner:** [#555](https://github.com/OpenCoven/psyche-build/issues/555), under
[#553](https://github.com/OpenCoven/psyche-build/issues/553) and
[#474](https://github.com/OpenCoven/psyche-build/issues/474)

This runbook records gates G1–G4 on one packaged macOS release candidate in a
manifest that `pnpm acceptance:validate:beta` accepts. It is separate from the
[`v0.0.1` operator slice](./OPERATOR-ACCEPTANCE-SLICE.md), whose manifest and
validator stay pinned to that published release.

A valid manifest is a well-formed record of what an operator reports. The
validator checks shape and consistency; it observes nothing. Source tests,
the recovery harness, and a fake-agent run are not observations of the
candidate.

## What you need before you start

1. **A candidate.** One run of the non-publishing
   [`Release candidate` workflow](./RELEASE.md#release-candidate-builds) on an
   exact commit of `main`, with its two DMGs, `SHA256SUMS`, and
   `release-candidate-provenance.json`. The pass does not create a tag.
2. **A disposable macOS account** on the architecture you will observe, with no
   prior Psyche Build state.
3. **The `v0.0.2` installer** for that architecture, for G4.
4. **A durable place for evidence** outside the repository. Keep digests,
   enumerated state, and short sanitized excerpts. Do not keep raw prompts,
   terminal history, repository contents, environment dumps, or personal paths.

One manifest covers one host. Observe the other architecture in a second
manifest.

## Identify the candidate

Copy [`docs/templates/beta-acceptance-candidate.json`](./templates/beta-acceptance-candidate.json)
to the evidence location and fill in:

| Field | Value |
|---|---|
| `candidate.sha` | The 40-character commit the workflow built |
| `candidate.id` | `rc-` followed by the first 12 characters of that SHA |
| `candidate.version` | The final `MAJOR.MINOR.PATCH` embedded in the build; never a prerelease |
| `candidate.provenanceSha256`, `candidate.sha256sumsSha256` | SHA-256 of the two retained files |
| `artifacts` | Both DMGs: architecture, file name, SHA-256, as listed in `SHA256SUMS` |
| `host` | macOS version, architecture, and machine class of the observing host |
| `upgradeBaseline.filename`, `upgradeBaseline.sha256` | The `v0.0.2` DMG you will install for G4 |

The template fails validation until these are filled. Then check it against the
candidate's own files:

```sh
pnpm acceptance:validate:beta -- /absolute/path/to/manifest.json \
  --provenance /absolute/path/to/release-candidate-provenance.json \
  --sha256sums /absolute/path/to/SHA256SUMS
```

This confirms that the manifest names the same commit, version, and artifact
hashes as the provenance, that the provenance records signing, notarization,
stapling, and Gatekeeper acceptance for both builds, and that it records no
tag, release, TestFlight upload, or Homebrew notification.

## Observe, in order

Run G1, then G2, then G3, then G4, on that one candidate. The rows are the
case ledger on #555; their ids and titles are `BETA_ACCEPTANCE_ROWS` in
`scripts/validate-beta-acceptance.mjs`.

| Gate | Rows | What is observed |
|---|---|---|
| G1 Install | `G1.1`–`G1.6` | Cask and direct-DMG install, bundle identity, `codesign`, Gatekeeper, notarization |
| G2 Ordinary lifecycle | `G2.1`–`G2.9` | Onboarding, project and pane, terminal, agent launch, keyboard, file and diff, merge and cleanup, two projects, restart |
| G3 Failure paths | `G3.1`–`G3.6` | Absent agent, interrupted Git mutation, kill mid-transition, full storage, unwritable storage, repository intact afterwards |
| G4 Upgrade and rollback | `G4.1`–`G4.4` | Candidate over `v0.0.2`, state preserved or quarantined, rollback, state after rollback |

Give every row one outcome:

| Outcome | Meaning | Also required |
|---|---|---|
| `succeeded` | Observed, and the expectation held | At least one evidence digest. For G3 and G4 rows, `workPreserved: true` |
| `failed` | Observed, and the expectation did not hold | Evidence; `messageClass` (`actionable`, `not_actionable`, or `none_shown`); `safeNextAction`; `workPreserved` |
| `recovery_required` | Observed, and the app asked for recovery | Evidence; `safeNextAction`; `workPreserved` |
| `gap` | Not observed | `gapReason` |
| `pending` | Not yet attempted | Nothing |

A gap is never a pass. If a case could not be staged, record `gap` with the
reason.

For `G2.4`, record the agent that was launched: its registry id, its version if
known, and `promptInArgv`. The validator requires `promptInArgv` to agree with
the [published prompt-exposure limitation](./AGENT-PROMPT-TRANSPORT.md#known-limitation-in-the-macos-public-beta),
so the manifest and the limitation cannot disagree.

Free-text fields (`safeNextAction`, `gapReason`, `host.macOS`,
`host.machineClass`, the agent version, and `sanitization.omissions`) are one
line of at most 280 characters, and the validator refuses anything that looks
like a home-directory path.

## Finish

1. List what you deliberately left out of the evidence in
   `sanitization.omissions`.
2. Have the retained evidence reviewed for protected data, by a second person
   where one is available, and record the reviewer's GitHub login in
   `sanitization`. People are named by GitHub login only.
3. Set `terminalState`:
   - `accepted` when every row is `succeeded`;
   - `not_accepted` when every row has an outcome other than `pending` and at
     least one did not succeed.
4. Validate for closure:

```sh
pnpm acceptance:validate:beta -- /absolute/path/to/manifest.json \
  --provenance /absolute/path/to/release-candidate-provenance.json \
  --sha256sums /absolute/path/to/SHA256SUMS --require-complete
```

   Add `--require-accepted` when the manifest is offered as beta acceptance.
5. Link the manifest and its digest from #555, #474, and #553. Do not paste the
   evidence itself into an issue.

## If the candidate changes

A fix after freeze produces a new commit and therefore a new candidate
([release-candidate invariants](./RELEASE-ACCEPTANCE.md#release-candidate-invariants-for-future-releases)).
Start a new manifest for the new `candidate.sha`. Repeat the rows the fix
affects and a smoke pass of the rest; carry nothing over by editing the
identity of an old manifest.

## What this does not cover

G5 (signed update channel, [#477](https://github.com/OpenCoven/psyche-build/issues/477)),
G6 (in-app support bundle, [#476](https://github.com/OpenCoven/psyche-build/issues/476)),
and the numerical responsiveness targets stay with #474 for production.
