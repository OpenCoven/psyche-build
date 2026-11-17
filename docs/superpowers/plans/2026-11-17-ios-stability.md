# iOS stability qualification implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task. This is a reference implementation record; live ownership and status remain on #510.

**Goal:** Measure the six #510 cases after #590 on the pinned hosted simulator and repair only a demonstrated cause.

**Architecture:** An opt-in, same-repository pull-request job checks out the exact proposed head, verifies the production toolchain and generated project, and builds the PsycheApp test scheme once. A bounded runner executes fixed repetitions in fresh and reused test-runner processes, retains result bundles, and reports individual outcomes without converting retries or missing executions into passes.

**Tech Stack:** Node.js, Vitest, GitHub Actions, Xcode 26.2 (17C52), iOS 26.2 iPhone 16 Pro, checksum-verified XcodeGen 2.45.4.

**Spec:** The owner's activated overnight objective and #510's current acceptance contract; #590 is the measurement baseline. The local execution ledger records the objective's bounds without publishing the raw instruction attachment.

## Global constraints

- Six wall-clock hours and at most eight hosted macOS runner-hours, including ordinary CI caused by this branch.
- Fifty executions per case are a target; report actual counts and incomplete iterations when the budget expires.
- Preserve required checks, assertions, timeouts, both legitimate readiness orderings, generated-source ownership, and all authority boundaries.
- No repeated taps, sleeps, retry-until-green behavior, release actions, merges, issue closure, settings changes, distribution credentials, or branch/worktree deletion.
- #538/#539 product work and #555/#592 candidate work retain their existing owners.
- Retain sanitized evidence, exact source identity, every first failure, review limits, rollback, and the next action.

## Review focus

- An interrupted or malformed result must never manufacture a successful execution.
- Repetition aggregates and nested result nodes must not double-count executions.
- A failed command with passing test leaves must remain an infrastructure failure.
- A new push or process timeout must not discard the first failing result or silently expand the hosted budget.
- The workflow must run only when explicitly opted in, use no signing environment, and preserve the ordinary CI job contracts.

## Task 1: Bounded qualification runner and opt-in job

**Files:** Create `scripts/ios-stability.mjs`, `__tests__/iosStability.test.ts`, and `.github/workflows/ios-stability.yml`; leave `.github/workflows/ci.yml` unchanged.

**Interfaces:** The runner consumes the exact checkout, output directory, toolchain identity, fixed test list, and a bounded duration. It produces enumerated per-case outcomes, command exit classifications, digests, and result-bundle references. The workflow consumes the runner and publishes only bounded summaries and fixture-only result bundles.

- [ ] Write executable tests for argument bounds, planned build/repetition commands, nested per-execution counting, missing results, unexpected outcomes, and failure preservation; observe the failures before implementation.
- [ ] Implement the minimum runner and result accounting, then run `pnpm exec vitest run __tests__/iosStability.test.ts __tests__/ciWorkflow.test.ts __tests__/dependencyPins.test.ts` and `bash scripts/agent-check fast`; require terminal success.
- [ ] Review the workflow's permissions, exact-head checkout, opt-in condition, timeout, immutable action pins, production setup parity, and artifact bounds before pushing.
- [ ] Commit, open one draft PR with `Refs #510`, and start one bounded qualification run. Record all hosted job time, not only the qualification job.

## Task 2: Inspect results and repair a demonstrated cause

**Files:** The smallest owning test or implementation surface justified by the result bundle; no edits to #539-owned product paths.

**Interfaces:** Consumes Task 1's immutable result bundles and execution counts. Produces either red-to-green focused repair evidence plus a new-head measurement record, or a reproducible failure dossier with a precise blocker.

- [ ] Inspect the first failure's result bundle and reproduce its cause before changing behavior. Keep test, infrastructure, cancellation, and incomplete outcomes distinct.
- [ ] For a repair, identify failing focused coverage, implement the minimal correction, and begin a separate new-head measurement within the remaining budget.
- [ ] Run owning suites, `pnpm ios:project:check` on the pinned host, and `bash scripts/agent-check full`; retain exact results and unrun gates.

## Task 3: Review and morning handoff

**Files:** A sanitized checkpoint in `docs/working-records/` if results warrant a committed record; evidence comments on #510 and the draft PR.

**Interfaces:** Consumes source, command receipts, result bundles, and hosted job durations. Produces the final draft PR and a requirement-by-requirement handoff.

- [ ] Obtain fresh-context branch review and address consequential findings with red-to-green evidence.
- [ ] Capture terminal required checks and commit statuses on the final pushed head; keep qualification heads distinct if a final evidence-only commit follows them.
- [ ] Record exact identities, commands, toolchain, measured denominators, all failure signatures, budget usage, review limits, rollback, unmet gates, and one next action. Leave #510 open and do not merge.
