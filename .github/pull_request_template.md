## Outcome

<!-- Name one outcome with its owner, train, and acceptance gate. Link an owning issue when one exists; a bounded maintenance fix need not create a duplicate issue. Keep GitHub closing keywords away from generated Beads mirror references. -->

Related outcome:

Accountable owner:

Delivery train:

Acceptance gate:

## Scope and boundaries

<!-- What changed? What deliberately did not change? Name any authority, persistence, security, compatibility, generated-source, or platform boundary touched. -->

## Risk class

- [ ] R1 — documentation or isolated tests
- [ ] R2 — product behavior
- [ ] R3 — authority, security, protocol, persistence, recovery, or consequential action
- [ ] R4 — release, governance, credentials, generated-source ownership, or cross-repository identity

Review [`docs/ROADMAP.md`](../docs/ROADMAP.md), [`docs/SUPPORT-MATRIX.md`](../docs/SUPPORT-MATRIX.md), [`docs/RELEASE-ACCEPTANCE.md`](../docs/RELEASE-ACCEPTANCE.md), and [`docs/CONTRIBUTOR-SAFETY.md`](../docs/CONTRIBUTOR-SAFETY.md) before making availability or production-readiness claims.

## Validation and evidence

<!-- Record exact commands and observed outcomes. Separate focused tests, repository gates, simulator/platform checks, and production-path evidence. State proof gaps explicitly. -->

```text
Command:
Result:
```

- [ ] I added or identified focused coverage for the changed behavior.
- [ ] I ran the owning-surface checks and recorded their exact results.
- [ ] Required checks are terminal on the exact head SHA, or this PR remains draft.
- [ ] I did not treat test counts, source presence, hosted compilation, or simulator success as proof of an unobserved production path.
- [ ] I documented rollback, migration, and recovery implications where applicable.

## Generated outputs

- [ ] No generated output changed.
- [ ] Generated output changed from its canonical source/generator and is reproducible without residual drift.

<!-- Name each generator and generated path. Do not hand-edit checked-in bundles, generated iOS projects, generated docs, or managed Beads mirror bodies. -->

## Security and privacy

- [ ] The change preserves project scope, authority, confirmation, receipt, revocation, idempotency, work preservation, and recovery contracts.
- [ ] Public text and artifacts contain no credentials, tokens, passwords, private keys, certificates, signing material, raw prompts, unrestricted terminal output, private repository contents, complete environment dumps, private service URLs, or unredacted personal paths.
- [ ] Suspected vulnerability details are in a private GitHub Security Advisory, not this PR.

## Review focus

<!-- Direct reviewers to the highest-risk contracts and the smallest useful diff. -->

1.
2.

## Release and support impact

- [ ] No support or release claim changes.
- [ ] The support matrix, roadmap, release acceptance, changelog, and user-facing docs are updated consistently.

## Roadmap control

- [ ] No scope, priority, dependency, or closure decision changes.
- [ ] A decision changes: roadmap/execution docs agree, remaining safety/acceptance gates stay open, and authorized tracker reconciliation follows merge.

<!-- Follow CONTRIBUTING.md#roadmap-control. Retirements are not implementation completion. Generated Beads mirrors use only the source-first synchronizer. -->

<!-- A checked box records the author's assessment; CODEOWNERS review and protected exact-head checks remain authoritative. -->
