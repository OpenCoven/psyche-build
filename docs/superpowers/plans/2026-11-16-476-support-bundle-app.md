# Support bundle application delivery implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline; retain a fresh-context whole-branch independent review before delivery.

**Goal:** Complete #476 with an application Help action, bounded v1 category accounting, packaged macOS observation and protected delivery.

**Architecture:** An embedded, generated Node worker reuses the existing TypeScript v1 collectors, sanitizer and store. A trusted-main native adapter selects an already-open canonical project, runs one bounded worker without a shell or inherited Node injection settings, supports cooperative cancellation, and reveals only its own verified output. The accessible browser controller presents native job states and truthful omissions; it holds no control-plane authority.

**Tech Stack:** Existing TypeScript/Node pipeline, esbuild, Tauri/Rust/Tokio and DOM UI. No new dependencies or signing credentials.

**Spec:** Current #476 acceptance and the user-approved objective; `docs/SUPPORT-BUNDLE-V1.md`, `docs/CONTROL-PLANE.md`, `docs/RELEASE-ACCEPTANCE.md` and `AGENTS.md`.

## Global constraints

- Existing `psyche.diagnostics/v1`, 30-second collection, 64 KiB payload, 256 records, 64 receipts and ten retained files remain unchanged.
- Omit raw terminal content, prompts, private paths, credentials and unrestricted logs. No uploads or provider execution.
- Do not invent receipt authority or complete/proof status. The unavailable native receipt integration is an explicit omission.
- Node is resolved by the application's existing executable lookup; unavailable Node is an actionable failure. The worker is embedded in the package, independent of a source checkout or installed CLI.
- Preserve exact project scope, restrictive file permissions, cancellation, prior work and active app sessions. Native worker hard timeout is a recovery-required outcome, not proof no file was written.
- User authorizes scoped protected delivery, local non-distributing packaging and Project/evidence updates. No security publication, settings changes, signing credentials, releases or destructive cleanup.

## Review focus

- A project closes or switches while collection runs: the job retains its original scope, and reveal revalidates that scope.
- Cancellation during persistence: show the saved result if committed; never claim cancellation proves no effect.
- Symlinked runtime destinations or forged worker output: refuse escape and do not reveal arbitrary paths.
- Worker crash, missing Node, oversized output and unresponsive filesystem: bounded failure with safe messages and recovery guidance.
- Keyboard focus, Escape, repeat invocation and late polling: one active job and accessible terminal state.

## Task 1: Shared pipeline application adapter

**Files:** Add `src/diagnostics/supportBundleApp.ts`, `src/diagnostics/supportBundleWorker.ts`, `__tests__/supportBundleApp.test.ts`; update the store for cooperative cancellation and scoped directory validation, the closed diagnostic vocabulary, and desktop `scripts/build-web.mjs` for the embedded worker artifact.

**Interfaces:** `createAppSupportBundle(request, signal)` returns a bounded summary plus native-only saved path; request has canonical root, safe native graphics/updater/lifecycle projections and immutable build source identity. Worker stdin is bounded line-delimited control data; stdout contains one bounded terminal result. No raw errors cross the boundary.

- [x] Write and run focused tests that fail before the adapter exists: real filesystem bundle creation/0600, schema/category accounting, sensitive synthetic inputs, explicit receipt/terminal omissions, corrupt configuration, cancellation before commit and scoped symlink refusal.
- [x] Implement the adapter through real `createSupportCollectors`, `collectSupportBundle`, `serializeSupportBundle` and `writeSupportBundleFile`; preserve CLI behavior and public signatures.
- [x] Build and execute the actual standalone worker without a checkout/CLI or optional providers; test malformed/oversized input and cooperative cancellation.
- [x] Run new and existing support-bundle suites plus test typecheck; commit the independently testable adapter.

## Task 2: Native job boundary and Help action

**Files:** Add native `src/support_bundle.rs`, scoped permissions/capability and browser `web/support/` controller; update native composition/build registration, `web/index.html`, `web/main.js`, styles and generated bundles. Add native behavior tests and `__tests__/supportBundleUi.test.ts`.

**Interfaces:** Native start/status/cancel/reveal commands accept only the trusted main WebView. Native state owns one job, canonical project and output; the UI receives safe state, accounting and basename only, never caller-selected reveal paths.

- [x] Establish RED for unauthorized caller/root, repeated starts, cancellation/commit races, worker failure/output bounds and reveal validation using real worker/filesystem where feasible.
- [x] Implement fixed worker launch, scrubbed environment, pinned project lease, cooperative cancellation, timeout and bounded result validation; wire only safe native runtime facts and explicit unavailable-owner omissions.
- [x] Establish UI RED using actual DOM/controller behavior for Help discovery, progress, cancellation, failure/retry, summary/reveal, focus restoration and stale responses.
- [x] Wire the real app, regenerate outputs and run owning JS/Rust gates; commit the production composition.

## Task 3: Packaged acceptance and protected closeout

**Files:** Update affected support/status/acceptance documents and retain a sanitized acceptance record with immutable source/artifact identity.

- [ ] Build an isolated, non-distributing macOS package without signing credentials; use the existing disposable acceptance profile and preserve active app sessions.
- [ ] Observe Help creation, progress/cancel/failure, summary/reveal and resulting file privacy/permissions; test sensitive markers and record every category. Missing native observation remains unmet.
- [ ] Run bootstrap, fast/full, canonical generation and clean-tree gates; obtain independent whole-branch R3/R4 review, resolve findings, then refresh exact-head gates as necessary.
- [ ] Push scoped PR with `Refs #476`, verify terminal required checks and ordinary protection, merge, verify landed/tested identity, manually close #476 with evidence and Project Evidence link; link relevant evidence from #474 without closing it.

## Rollback

Focused revert removes the new native/UI surface and worker while retaining existing CLI behavior and user-created bundles. No state migration or support-status expansion is authorized.
