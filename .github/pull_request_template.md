## Objective

<!-- State the observable outcome, acceptance criteria, and explicit non-goals. -->

## Tracking

<!-- Link the owning Bead/GitHub issue. Managed planning state changes in Beads. -->

## Changes

<!-- List the intentional files/surfaces changed and why. -->

## Canonical contracts consulted

<!-- Link the relevant product, control, security, release, or protocol documents. -->

## Verification evidence

<!-- Exact commands, exact head/SHA where relevant, and results. Test counts alone are insufficient. -->

- [ ] Focused contract tests
- [ ] `./scripts/agent-check fast` or an explained equivalent
- [ ] Required CI is terminal and successful on the exact PR head
- [ ] Unsupported platform checks are named explicitly

## Authority, security, and privacy

<!-- Describe authority changes, external side effects, data exposure, failure behavior, and recovery. -->

- [ ] No secrets, task tokens, signing material, raw prompts, private repository content, full environment dumps, user home paths, or unredacted terminal/browser transcripts are included
- [ ] R3/R4 changes identify approval and rollback/recovery gates
- [ ] Caller-supplied text or UI/process/worktree/Bead identifiers do not become authority

## Migration and rollback

<!-- State the migration/rollback plan or explain why neither applies. -->

## Generated artifacts

<!-- Name generators and provenance. Do not hand-edit generated outputs. -->

## Remaining uncertainty

<!-- Record unresolved review findings, follow-ups, and evidence not run. -->
