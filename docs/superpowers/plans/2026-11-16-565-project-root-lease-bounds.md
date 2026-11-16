# Project-root lease bounds implementation plan

> Execute inline with the executing-plans skill; obtain a fresh independent branch review before protected delivery.

**Goal:** Deliver and close #565 with long-root request, scope and per-effect authorization evidence.

**Architecture:** Exclude only a project target ID identical to the owner-selected command root from the operator display text limit. Preserve all other request bounds and the existing grant authorization checks; no protocol or persisted format changes.

**Spec:** The user-authorized contributor reliability sprint and GitHub #565 are the requirements. This record is reference material, not a planning store.

## Constraints and review focus

Preserve production authority refusals, exact root equality, UTF-8 byte limits on caller text, bounded grant/capability counts, lease expiry/revocation and per-effect checks. Review mismatched long roots, Unicode, mixed grants, unsupported project capabilities and scope stamping at the authority boundary. No private security candidate is part of this change.

## Task 1: Reproduce and correct project-root bounds

- [ ] Add focused request cases at 128 and 129 bytes and with multibyte roots, and negative caller-text and mismatched-root cases in `__tests__/controlRuntime.test.ts`.
- [ ] Run the focused cases against unchanged runtime; expect matching long roots to fail with `lease_request_too_large`.
- [ ] Change `assertLeaseRequestBounds(command)` in `src/control/runtime.ts` to exempt only the exact project identity; retain target-kind and other text validation.
- [ ] Run all control-runtime tests and the authority, capability, scope and daemon adapter suites; expect success.

## Task 2: Exercise real long-root orchestration and deliver

- [ ] Run the existing revocation and expiry orchestration cases using real canonical filesystem roots over 128 bytes, retaining their observed first-lane-only effects and terminal receipts.
- [ ] Run fast/full repository gates with the pinned toolchain, one full gate at a time. Record first failures and terminal results.
- [ ] Commit the focused change, obtain independent R3 review, resolve findings and publish a PR using `Refs #565`.
- [ ] Wait for terminal exact-head required checks, use ordinary protected merge, verify landed state, then manually close #565 with evidence and Project Evidence linkage.

Rollback is a focused revert; no migration is needed. Source tests do not establish installed-app acceptance.
