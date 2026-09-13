# GPU verification matrix

**Status:** Operational evidence procedure; physical results not collected

**Owner:** [#232](https://github.com/OpenCoven/psyche-build/issues/232) under
[#199](https://github.com/OpenCoven/psyche-build/issues/199); both remain open

**Contract:** [Release acceptance](./RELEASE-ACCEPTANCE.md),
[support matrix](./SUPPORT-MATRIX.md), and
[bridge security](./BRIDGE-SECURITY.md)

This is the focused graphics procedure within the existing
[operator acceptance slice](./OPERATOR-ACCEPTANCE-SLICE.md), not another
acceptance framework or a support-policy expansion. PRs #438 and #444 merged
source-level diagnostics repairs; neither supplies physical GPU evidence.
Dated design plans are history, not the operational contract.

## What the current source can prove

The canonical sources are
[`stress-harness.ts`](../native/desktop/psyche-build-tauri/web/runtime/stress-harness.ts),
[`main.js`](../native/desktop/psyche-build-tauri/web/main.js), and
[`dev-tauri-diagnostics.mjs`](../scripts/dev-tauri-diagnostics.mjs).
The fixed plan runs **1, 6, 12, 24 terminal panes**, in that order, with rotating
`steady`, `burst`, and `rewrite` fixtures plus a large editor document and an
`about:blank` browser fixture in each scenario. Each scenario has **10,000 ms
warmup, 30,000 ms measurement, and 5,000 ms restore**, plus setup and cleanup.
It exercises focus, resize, pane visibility, window cycling, and context loss.

| Evidence | Current collector / interpretation |
|---|---|
| CPU and RSS | `snapshotMetrics()` copies only optional `cpuPercent` and `rssBytes`, from asynchronous process sampling. Before/after snapshots are not averages, peaks, fresh-sample guarantees, or per-terminal resource attribution. Missing values are `not_measured`, never zero. |
| Frame timing / p95 | `not_measured`; no frame-time samples in this export |
| Queue depth | `not_measured`; no queue samples in this export |
| IPC batching / frequency | `not_measured`; no IPC samples in this export |
| Terminal throughput | `not_measured`; fixture activity is not a throughput measurement |
| Focus/resize input-to-next-paint | `not_measured`; scheduling a focus or resize is not a measured paint |
| Context loss | `contextLossSupported: true` reflects the adapter's loss acknowledgement, not actual recovery. The validator reports only requested/unsupported; false can include unavailable or unconfirmed loss. |
| Restored rendering, foreground return, cleanup | External operator observations, not proved by the result object or “Stress scenarios complete.” |

The **six-pane** responsiveness targets are **p95 frame time ≤33.4 ms** and
**focus/resize input-to-next-paint <100 ms** on supported non-virtualized
hardware. The current export cannot evaluate either target. Do not infer them
from CPU/RSS, elapsed time, a completion message, or a CI pass. No targets are
assigned here to 1/12/24 panes, CPU, memory, queues, IPC, or throughput.

## Physical matrix and safe preparation

| Physical environment | Record separately | Current evidence / claim |
|---|---|---|
| macOS, Apple Silicon or Intel | OS version/build, architecture, generic machine class, GPU model, OS-delivered graphics driver version or `unknown`, WKWebView engine version if exposed | `not_observed`; source debug execution does not establish signed-artifact acceptance |
| Windows, named physical GPU | OS version/build, architecture, generic machine class, GPU model, driver version, WebView2 version if exposed | `not_observed`; Windows remains **compile-only** |
| Linux, named physical GPU | Distribution/version, kernel version, architecture, generic machine class, GPU model, driver/Mesa version, WebKitGTK version if exposed, X11/Wayland | `not_observed`; Linux remains **compile-only** |

Use selected fields in local system UIs, transcribed into the existing bounded
operator record, rather than attaching command output:

- **macOS:** About This Mac for OS and chip/model class; System Information →
  Graphics/Displays for GPU and display fields. An OS build is not a separate
  driver version; record driver `unknown` if none is exposed.
- **Windows:** Settings → System → About for OS/build and architecture; Device
  Manager → Display adapters → the selected adapter → Properties → Driver for
  driver version; Settings → System → Display → Advanced display for refresh
  rate. Do not copy device instance IDs or the device name from About.
- **Linux:** desktop Settings/About and Displays for distribution, session and
  display fields; the installed graphics driver's information panel for GPU,
  driver/Mesa version. If not exposed, use `unknown`; do not attach `glxinfo`,
  `vulkaninfo`, `lspci`, system journals, or full hardware inventories.

Retain only these selected labels (at most 128 characters each), reviewed for
identifiers. No serials, UUIDs, hostnames, usernames, personal paths, network
addresses, full system reports, screenshots of system inventory, environment
dumps, or raw terminal/DevTools logs. Treat dual-GPU identity as `unknown` if
the active adapter cannot be established; listing installed adapters does not
prove which rendered the run.

Before launching:

1. Establish a **disposable OS account or dedicated disposable host**, with no
   active real projects, sessions, credentials, or provider connections. Use
   only a disposable Git project/worktree and synthetic fixture content.
   A fresh checkout, directory name, or preflight success is not profile
   isolation. The launcher inherits the environment and ordinary application
   storage; it **does not create a disposable profile**.
2. Verify the exact candidate source and deterministic gates below. Use the
   prerequisites in [Contributing](../CONTRIBUTING.md). Record whether this is
   physical or virtualized and whether DevTools is attached; do not represent
   a VM or debug build as physical packaged-release proof.
3. Record UTC start/end, logical window width/height, display scaling, refresh
   rate, power mode, and initial foreground/minimized state. Keep machine/
   driver metadata separate from the stress JSON; it is not collected by it.
4. Only on that prepared disposable context, run `pnpm dev:tauri:diagnostics`.
   It sets `PSYCHE_RENDER_DIAGNOSTICS=1` and invokes `pnpm dev:tauri`. Select the
   disposable project/worktree, open the graphics diagnostics panel, and
   confirm stress controls are authorized and cleanup is clear.

Do not change capabilities, permissions, CSP, native authorization, or debug
flags inside a release artifact. Do not manufacture `authorized: true`, call
native commands directly, or bypass an unavailable/denied stress control.
An unavailable debug inspector or unsupported host is a blocker, not a reason
to weaken those boundaries. **This PR did not launch diagnostics on the
working host: disposable-account isolation was not established.**

## Capture startup graphics separately

Before starting stress, use the diagnostics panel's **Copy JSON** action.
Review the clipboard locally; do not retain the console's `[psyche:graphics]`
log stream. Save a reviewed `startup-graphics.json` of at most 8 KiB. Retain
only `os`, `arch`, `engine`, `engineVersion`, `debugBuild`, `stressAuthorized`,
`acceleration`, `backend`, `supportingProbe`, `unsupportedFields`,
`cpuPercent`, and `rssBytes` when present and valid. Limit strings to 128
characters and unsupported-field labels to the known `strictWebgl`/`renderer`
values. Omit `adapter` and `fallbackReason` (raw driver-supplied strings);
transcribe a reviewed generic GPU model into the separate metadata record.
Record these omissions explicitly. Reject unknown fields or unsafe values
rather than attaching the original clipboard. Clear the clipboard afterward.

The panel report is initialized at startup; CPU/RSS can refresh subsequently.
Record the copy time separately. Missing startup JSON is `not_observed`.
An `accelerated` classifier result is supporting evidence, not proof of
physical acceleration; unknown/unavailable/software classifications do not
satisfy hardware acceptance. The stress validator below does not validate
startup graphics or the separate metadata.

## Export the existing result without bypassing the UI

The stress button currently awaits and discards `StressRunResult`. The panel's
copy action copies **startup graphics diagnostics**, not the stress result.
Use the following one-shot observer only in the trusted **main WebView's debug
DevTools console**, before clicking the normal stress button. Do not run it in
the browser fixture or a release build. It does not start a run.

The bundled export uses read-only getters: assigning `api.runStressPlan`
directly does not work. This observer temporarily replaces the writable
`window.PsycheRuntimeDebug` global with a forwarding proxy; it does not mutate
the export. It restores the original global as soon as the function is called,
forwards the original API receiver and arguments, and returns the **same promise**. The
normal UI retains its authorization, abort signal, error handling and cleanup.
Synchronous exceptions and promise rejections still reach that UI. Capture
failure only changes a fixed observer status; it never changes the run result.
The observer accepts only bounded numeric/boolean data and known field names,
not arbitrary strings or logs. This is a retention guard, not acceptance.

```js
(() => {
  const api = window.PsycheRuntimeDebug;
  if (!api || typeof api.runStressPlan !== "function" ||
      Object.hasOwn(window, "__psycheStressExport")) return;
  const original = api.runStressPlan;
  const capture = { state: "armed", text: null, restore: null };
  const keys = new Set([
    "startedAt", "finishedAt", "scenarios", "paneCount",
    "contextLossSupported", "metrics", "beforeMeasurement",
    "afterMeasurement", "cpuPercent", "rssBytes"
  ]);
  function encode(result) {
    let nodes = 0;
    function safe(value, depth = 0) {
      if (++nodes > 256 || depth > 6) return false;
      if (typeof value === "number")
        return Number.isFinite(value) && value >= 0 &&
          value <= Number.MAX_SAFE_INTEGER;
      if (typeof value === "boolean") return true;
      if (Array.isArray(value))
        return value.length <= 4 && value.every(v => safe(v, depth + 1));
      if (!value || Object.getPrototypeOf(value) !== Object.prototype)
        return false;
      const fields = Object.keys(value);
      return fields.length <= 11 && fields.every(key =>
        keys.has(key) && safe(value[key], depth + 1));
    }
    if (!safe(result)) return null;
    const text = JSON.stringify(result);
    return new TextEncoder().encode(text).length <= 65536 ? text : null;
  }
  function restore() {
    if (window.PsycheRuntimeDebug === observer) window.PsycheRuntimeDebug = api;
  }
  function wrapped(...args) {
    restore();
    capture.state = "running";
    let promise;
    try {
      promise = Reflect.apply(original, this === observer ? api : this, args);
    } catch (error) {
      capture.state = "run_failed";
      throw error;
    }
    void promise.then(result => {
      try {
        capture.text = encode(result);
        capture.state = capture.text === null ? "capture_rejected" : "captured";
      } catch {
        capture.text = null;
        capture.state = "capture_rejected";
      }
    }, () => { capture.state = "run_failed"; });
    return promise;
  }
  const observer = new Proxy(api, {
    get(target, key, receiver) {
      return key === "runStressPlan" ? wrapped : Reflect.get(target, key, receiver);
    }
  });
  capture.restore = restore;
  window.__psycheStressExport = capture;
  window.PsycheRuntimeDebug = observer;
})();
```

1. Click the normal **Run stress** control once. Observe the four scenarios
   and their cleanup. Do not manually invoke `runStressPlan` or change its
   dependencies. Keep DevTools placement fixed so it does not resize the
   measured window mid-run.
2. Inspect only `window.__psycheStressExport.state`. For `captured`, use
   `copy(window.__psycheStressExport.text)` in a DevTools console that provides
   the `copy` helper, then paste as plain UTF-8 into the operator-controlled
   `stress-result.json`. If that helper is unavailable, use the inspector's
   copy-string-value action on `.text`, not “save console log.” Do not include
   console quotes, prefixes, startup graphics data, or an enclosing manifest.
   Review locally before retention. Do not preserve clipboard history.
3. `run_failed`, `capture_rejected`, no capture, cancellation, or incomplete
   cleanup is **not** a complete export. Record only the bounded outcome;
   never copy the raw error. Preserve failed/retried classifications separately
   in the existing acceptance record. Do not fabricate missing scenarios.
4. Disarm even if the button was never clicked, and clear retained memory:
   `window.__psycheStressExport.restore(); delete window.__psycheStressExport;`
   Clear the clipboard after saving. Re-arm only after cleanup is verified.

The JSON timestamps are **monotonic milliseconds**, not UTC. Record the
operator's UTC window separately; never convert `startedAt` into a calendar
date. Do not put provenance fields into the JSON schema.

## Validate intake, not acceptance

From the exact source checkout, using the reviewed export:

```sh
node scripts/validate-gpu-stress-evidence.mjs stress-result.json
```

Replace `stress-result.json` with the local file argument, not shell input
redirection. The validator consumes the existing `StressRunResult` directly;
there is no new intake manifest. It requires exact keys, finite bounded safe
numbers, four scenarios in fixed order, at most **64 KiB**, and an elapsed run
of at most **10 minutes**. These are **intake limits, not performance targets**.
Its output uses fixed enums without echoing input values.

- **Exit 2:** invalid file/schema; reject the export.
- **Exit 1:** structurally valid export but **incomplete** evidence. CPU/RSS
  are reported as measured or `not_measured` for each pane-count scenario;
  context loss is requested/unsupported, never recovered.
- **No acceptance exit 0:** frame, queue, IPC, throughput and input-to-next-paint
  remain `not_measured`; physical recovery remains externally unverified.

A valid export is not proof of origin, truthful measurement, physical hardware,
recovery or acceptance. Synthetic JSON can satisfy the schema. Retain the
reviewed JSON (one ≤64 KiB file per run) and its SHA-256 digest alongside the
existing operator record. Keep the selected metadata/observations bounded to
one ≤8 KiB record per run, with explicit omissions. Do not retain raw logs.

## Observe recovery and cleanup separately

For each pane-count scenario, distinguish loss **requested**, loss **observed**,
and rendering **restored**. The current acknowledgement is not a restored-frame
measurement. If restoration cannot be witnessed before fixtures disappear,
record `unknown`/`not_observed`; do not extend deadlines or modify fixtures to
force a positive result. Browser canvas context loss is not proof of terminal
GPU reset recovery or a physical driver reset.

Observe minimize/background and foreground restoration: visible redraw,
working synthetic terminal output, editor and browser responsiveness, restored
focus/layout/window state, and absence of stale hidden surfaces. Record the
actual observed outcome, not merely successful return from the native window
command. Observe the normal run and, in a separate disposable run, cancellation
and cleanup: fixture PTYs and browser/editor resources gone, prior disposable
workspace restored, controls no longer active, and no orphan fixture activity.
Do not kill unrelated processes or delete ambiguous resources. If cleanup is
uncertain, stop further runs and preserve a bounded failure summary for #232.
Shutdown the diagnostic app and launcher; remove only verified disposable
resources. Never clean an ordinary user's profile as rollback.

## Exact-source gates and handoff

Run from the repository root at the candidate's **full commit SHA**, retaining
command, terminal outcome and CI URL/digest in the existing acceptance record:

```sh
pnpm --dir native/desktop/psyche-build-tauri build:web
pnpm test
pnpm typecheck
pnpm build
pnpm smoke
pnpm smoke:pack
cargo fmt --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --all -- --check
cargo test --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --locked
cargo check --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --locked
git diff --check
```

`bash ./scripts/agent-check full` aggregates these source gates (`pnpm build`
is invoked through `pnpm smoke`), plus documentation and cleanliness checks.
Do not count a gate as run simply because this document lists it. Generated
bundles must reproduce from canonical sources; source proof is not GPU proof.

Audit the candidate against its reviewed base (substitute full immutable SHAs):

```sh
git diff BASE_SHA...HEAD_SHA -- native/desktop/psyche-build-tauri/src-tauri
```

Inspect any CSP, capability, permission, configuration or command-registration
delta, not just the stress implementation. This documentation/tool slice has
no native subtree changes. An empty diff for this slice is not a retrospective
approval of earlier changes. Retain the base/head and bounded audit outcome,
not raw configuration or logs.

Inspect [CI](../.github/workflows/ci.yml) and its
[classifier](../scripts/classify-ci-changes.sh) at the candidate SHA. Retain
terminal results for **Desktop web**, **Rust tests**, and each **Desktop check
(macos-15 / windows-2025 / ubuntu-24.04)** job, including actual check/test
steps. The aggregate can be green while desktop jobs are skipped: docs-only
and ordinary `scripts/*` changes select TypeScript, not desktop. A skipped job
is not compile/test evidence. Record that gap rather than changing unrelated
paths to trigger jobs. A successful cross-platform job remains compilation/
runtime-test evidence, not physical graphics acceptance.

This slice's `__tests__/tauriGpuStressEvidence.test.ts` is an owning-desktop
regression and selects desktop validation through the existing classifier.

For this deliverable, source inspection began at
`8650344ce560ffcfe190ea99acc2010921409753`; that is the **base**, not a claim
about the eventual PR head or a tested artifact. The PR handoff must identify
its final full SHA, diff/dirty state, exact commands actually completed,
terminal CI results, reviewed export digests (if any), UTC observation window,
and proof gaps in the existing acceptance record. No physical run, driver
matrix, six-pane latency result or packaged acceptance is asserted here.
Rollback for this source-only slice is to revert its documentation/intake
validator changes through normal review; it requires no native permissions,
profile migration, or capability change. Keep #232/#199 open until their
remaining independently evidenced gates are met.
The parent/maintainer must still perform the final cumulative spec/code review
of the diagnostics implementation and require protected exact-head checks
before merge. A focused review of this runbook/intake tool is not that approval.
