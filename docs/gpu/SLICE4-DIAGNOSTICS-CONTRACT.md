# Slice 4 diagnostics contract — runtime graphics evidence, bounded metrics, and stress-mode boundary

Status: contract for the slice mirrored as OpenCoven/psyche-build#229
(`psyche-z7c.4`, parent epic #228). Machine-checkable counterpart:
`src/gpu/slice4ReportMerge.ts` with tests in `__tests__/gpuSlice4ReportMerge.test.ts`.

This document defines how native platform/process facts and strict browser
graphics evidence are merged into one deterministic runtime graphics report,
how renderer evidence is classified, and which bounds apply to rendering and
transport metrics. It also fixes the boundaries of the two sibling slices it
must not duplicate: the stress harness (#230) and the in-app diagnostics
surface (#231).

## Evidence policy (verbatim)

The bead mirrored as #229 states the evidence policy for this slice. It is
quoted here verbatim and is normative for every producer and consumer of this
report:

> Report accelerated/software/unknown/unavailable only from runtime evidence.
> Omit unsupported version/backend/adapter fields. Hosted compilation never
> proves physical GPU acceleration.

Consequences that this contract and its module enforce:

- `accelerated` is never inferred from the OS, the platform, the WebView
  engine, a vendor string, a user agent, or a successful build.
- Fields the runtime could not observe are omitted from reports — never filled
  with placeholders (`null`, `"unknown"`, `"n/a"`, empty strings, or guessed
  defaults). Omission is the honest signal; `unsupportedFields` names which
  graphics identity fields the driver stack did not expose.
- CI (hosted, on virtualized runners) proves build correctness and correct
  fallback classification only. It never substitutes for physical-GPU
  acceleration evidence, which is the verification matrix's concern (#232).

## Scope and boundaries

Owned by this contract (#229 slice 4 core):

- the deterministic merge of native + browser evidence reports,
- the fail-closed renderer evidence classifier,
- the bounded metrics window with retention and polling-cadence constants,
- the evidence-status vocabulary and omission rules shared by all reporters.

Explicitly NOT owned here (do not implement in this slice):

- **Stress harness (#230, bead `psyche-z7c.4.4`)** — the process-spawning
  harness, native fixture commands, scenario execution, and the launcher
  script. This contract fixes only the authorization boundary such a harness
  must satisfy (see "Stress-mode authorization boundary" below).
- **In-app diagnostics surface (#231, bead `psyche-z7c.4.5`)** — the developer
  panel, titlebar action, copy-JSON affordance, and UI wiring. This contract
  fixes only what the surface may render (see "Diagnostics surface boundary").
- **Verification matrix (#232, bead `psyche-z7c.4.6`)** — the cross-platform
  evidence matrix, physical-collection procedure, and its manifest validator.
  The acceleration vocabulary here (`accelerated`/`software`/`unknown`/
  `unavailable`) is identical to the matrix's so collected evidence maps
  without translation.
- Native Rust diagnostics commands, frame schedulers, PTY transport, and
  terminal rendering — those belong to slices 1–3 and the desktop shell.

## Native report contract (schema v1)

The native shell produces `Slice4NativeReportV1`:

| Field | Type | Notes |
| --- | --- | --- |
| `schemaVersion` | `1` | Exact constant; anything else is rejected. |
| `source` | `"native"` | Discriminator; prevents report swapping. |
| `os` | `macos \| windows \| linux` | Closed vocabulary. |
| `arch` | `x86_64 \| arm64` | Closed vocabulary. |
| `engine` | `WKWebView \| WebView2 \| WebKitGTK` | Closed vocabulary from the Slice 1 platform mapping. |
| `engineVersion?` | string ≤ 128 | Present only when the runtime observed it (for example `tauri::webview_version()`); omitted otherwise. |
| `debugBuild` | boolean | True only for debug builds. |
| `stressAuthorized` | boolean | Debug-build AND startup-environment authorization. |
| `process?` | snapshot | Present only when a sample was taken: `cpuPercent`, `rssMb` (finite, non-negative, ≤ 1e9) and `sampledAt` (ISO-8601 UTC ending in `Z`). |

The native report never claims graphics acceleration. Acceleration claims
require the browser probe below; the native side contributes platform, engine,
and process facts only.

## Browser probe contract (schema v1)

The browser probe produces `Slice4BrowserReportV1`:

| Field | Type | Notes |
| --- | --- | --- |
| `schemaVersion` | `1` | Exact constant. |
| `source` | `"browser"` | Discriminator. |
| `probe` | `webgpu \| webgl2 \| webgl \| none` | Strongest usable probe path; `none` when no graphics API was usable. |
| `strict` | boolean | True when a strict context (`failIfMajorPerformanceCaveat: true`, `powerPreference: 'high-performance'`) or a WebGPU adapter was obtained. |
| `rendererIdentityAvailable` | boolean | True when an unmasked renderer identity was readable through a supported API (`WEBGL_debug_renderer_info` / `UNMASKED_RENDERER_WEBGL`, or WebGPU adapter info). |
| `renderer?` | string ≤ 512 | The unmasked renderer identity string when readable; omitted when masked. |

Probing rules the producer must follow (from the slice 4 plan):

1. Attempt WebGPU first when available; request adapter information only
   through supported APIs.
2. Create WebGL2, then WebGL, with `failIfMajorPerformanceCaveat: true`.
3. If the renderer string is masked, leave `rendererIdentityAvailable` false
   and omit `renderer` — never substitute a guessed or generic string.
4. Never derive backend or adapter from the OS, the platform, or a user agent.
   Vendor strings are not renderer evidence and are deliberately not part of
   this report.

## Merged runtime graphics report (schema v1)

`mergeSlice4Reports({ native, browser })` produces `Slice4RuntimeGraphicsReportV1`,
the single report the diagnostics surface (#231) renders and logs:

| Field | Source | Notes |
| --- | --- | --- |
| `schemaVersion` | constant | `1`. |
| `os`, `arch`, `engine` | native | Closed vocabularies as above. |
| `engineVersion?` | native | Omitted when unobserved. |
| `debugBuild`, `stressAuthorized` | native | Authorization facts for the stress boundary. |
| `acceleration` | classifier | One of `accelerated`, `software`, `unknown`, `unavailable`. |
| `backend?` | renderer identity | `Metal`, `Direct3D`, `Vulkan`, or `OpenGL`, parsed only from the renderer string; omitted when masked or unrecognizable. |
| `adapter?` | renderer identity | Parsed from the ANGLE middle component (with the `ANGLE Metal Renderer:` prefix removed) or the plain renderer string; omitted when masked. |
| `supportingProbe?` | classifier | The probe path backing an `accelerated` verdict; omitted otherwise. |
| `fallbackReason?` | classifier | Deterministic explanation for `unknown`/`unavailable` verdicts; omitted for `accelerated` and `software`. |
| `softwareMarkers` | classifier | Matched versioned markers, marker-list order. Always present (possibly empty). |
| `unsupportedFields` | classifier | Which of `adapter`/`backend` the driver stack did not expose. Always present (possibly empty). |
| `process?` | native | Present only when the native report carried a snapshot. |

Contract properties:

- **Deterministic.** Pure function of its inputs: no clock, no randomness, no
  I/O. Identical inputs produce identical reports with identical key order, so
  copy-JSON output (#231) is stable byte-for-byte.
- **Omission, not placeholder.** Optional fields appear only when observed.
  `backend`/`adapter` are omitted when masked and named in `unsupportedFields`
  instead of being guessed from the OS or vendor.
- **Fail-closed rejection.** Unknown fields at any level (merge input, native
  report, browser report, process snapshot), wrong schema versions, wrong
  `source` discriminators, out-of-vocabulary enums, oversize strings, and
  malformed process snapshots produce a typed rejection
  (`{ ok: false, reason, errors }`) — never a partially merged report.
  Rejection reasons come from the closed vocabulary `schema-version`,
  `unknown-field`, `invalid-field`, `oversize`, `cadence-below-minimum`,
  `cadence-above-maximum`, reported in that priority order, with a bounded
  error list (32 entries, then an explicit suppression marker).
- **Frozen.** Returned reports and classifications are deeply frozen; the
  merge output cannot be mutated into a different claim after the fact.

## Renderer classification table

`classifyRenderer(browser)` applies fail-closed rules in order:

| # | Usable API (`probe`) | Strict evidence | Renderer identity | Software marker | → `acceleration` |
| --- | --- | --- | --- | --- | --- |
| 1 | `none` | — | — | — | `unavailable` |
| 1c | `none` | — | present or claimed available | — | `unknown` (conflicting) |
| 2 | any usable | any | readable | matched | `software` (markers are authoritative, even against strict context) |
| 3 | any usable | any | availability flag and string disagree | — | `unknown` (conflicting) |
| 4 | any usable | strict | readable, marker-free | none | `accelerated` |
| 5a | any usable | strict | masked | — | `unknown` (`maskedStrict` reason) |
| 5b | any usable | non-strict | readable, marker-free | none | `unknown` (ordinary context) |
| 5c | any usable | non-strict | masked | — | `unknown` (`maskedNonStrict` reason) |

Notes:

- Rows 4 and 2 still report `backend`/`adapter` parsed from the renderer
  string when derivable — identity facts are evidence even when the
  acceleration verdict is not `accelerated`. An unrecognizable backend token
  is omitted and recorded in `unsupportedFields`, never guessed.
- The masked-strict row (5a) is the decision that keeps the policy honest: a
  strict context alone is optimism, not renderer evidence.
- Marker matching is case-insensitive against the versioned
  `SLICE4_SOFTWARE_RENDERER_MARKERS` list (`swiftshader`, `llvmpipe`,
  `lavapipe`, `softpipe`, `microsoft basic render driver`, `software
  rasterizer`, `software renderer`; list version 1). The list is extended only
  by contract change with a version bump — never by accepting arbitrary
  markers at runtime.

## Bounded rendering/transport metrics

Metrics collection is bounded by explicit constants exported from the module:

| Constant | Value | Meaning |
| --- | --- | --- |
| `SLICE4_FRAME_SAMPLE_RETENTION` | 20 000 | Fixed rAF-delta ring capacity (slice 4 plan). |
| `SLICE4_METRICS_WINDOW_MAX_SAMPLES` | = retention | Maximum samples one window may carry. |
| `SLICE4_METRICS_POLL_INTERVAL_MS` | 1 000 | Required merge cadence for PTY/native process snapshots. Per-frame polling is forbidden. |
| `SLICE4_METRICS_MIN_POLL_INTERVAL_MS` | 1 000 | Faster cadences are a typed rejection (`cadence-below-minimum`). |
| `SLICE4_METRICS_MAX_POLL_INTERVAL_MS` | 3 600 000 | Values beyond one hour are not a polling cadence (`cadence-above-maximum`). |

`boundedMetricsWindow(samples, options?)`:

- accepts at most `SLICE4_METRICS_WINDOW_MAX_SAMPLES` samples — exactly a full
  ring is acceptable; anything larger is a typed `oversize` rejection. **An
  oversize window is never silently truncated**; the collector owns
  ring-buffering before handing samples over.
- accepts sample keys only from the closed `SLICE4_METRIC_KEYS` list
  (`frame.deltaMs`, `frames.droppedEstimated`, `input.focusToPaintMs`,
  `input.resizeToPaintMs`, `pty.queueHighWater`, `pty.ipcMessagesPerSecond`,
  `pty.throughputBytesPerSecond`, `process.cpuPercent`, `process.rssMb`);
  values must be finite, non-negative, and ≤ 1e9.
- echoes a validated `pollIntervalMs` into the window when supplied, so a
  window records the cadence it was collected at.
- returns deeply frozen windows whose sample arrays are copies; later mutation
  of the caller's array cannot change a validated window.

Metric values are observations, never claims: a full window proves only that
samples were collected, and percentiles/summaries derived from it are computed
by consumers, not invented by this module.

## Stress-mode authorization boundary (harness owned by #230)

This contract fixes the boundary any stress harness must satisfy; #230 owns
the harness implementation itself. The boundary:

- **Debug build required.** `debugBuild` must be true; production builds are
  never authorized to spawn stress load.
- **Startup environment authorization required.** Authorization is granted at
  startup (for example `PSYCHE_RENDER_DIAGNOSTICS=1` on a debug build), not
  from UI toggles, issue state, or runtime introspection. The merged report
  carries the resulting `stressAuthorized` fact so the surface can gate
  scenario controls on it.
- **Deterministic scenario set.** Exactly the four scenarios 1, 6, 12, and 24
  terminals, with fixed phases (10 s warmup, 30 s measured, 5 s
  restore/context-loss) — matching the matrix's `panes-1`, `panes-6`,
  `panes-12`, `panes-24` scenario ids (#232).
- **Fixed fixtures only.** Any native spawn command accepts only the fixed
  fixture enum, never arbitrary command strings.

Nothing in this slice spawns processes, opens terminals, or mutates the
desktop shell; a harness that did so without the authorization boundary above
would violate the contract.

## Diagnostics surface boundary (owned by #231)

The in-app surface consumes the merged report and bounded windows from this
module and must:

- render only fields actually present on the report — omitted fields produce
  hidden rows, not placeholder rows;
- render `softwareMarkers` and `fallbackReason` prominently whenever
  `acceleration` is not `accelerated`;
- gate scenario controls on `debugBuild && stressAuthorized`;
- keep graphics startup logging active even when the panel is unavailable;
- preserve CSP and capability boundaries (no expansion) and use only the
  Slice 3 transition helpers.

The surface must not recompute acceleration from partial evidence; it renders
the verdicts this contract produced.

## Status of this slice's own evidence

Honest gaps, per the evidence policy:

- This contract ships with unit tests (`__tests__/gpuSlice4ReportMerge.test.ts`)
  and typechecks; it has NOT been executed against physical GPUs on macOS,
  Windows, or Linux. No `accelerated` claim is made for any platform here.
- Hosted CI validates types, tests, and fallback classification on virtualized
  runners — per the policy, that never proves physical GPU acceleration.
- Physical acceleration evidence for the three desktop platforms is recorded
  through the verification matrix (#232), which references this vocabulary.

## References

- Plan: `docs/superpowers/plans/2026-08-10-gpu-ade-slice-4-diagnostics-stress.md`
- Module: `src/gpu/slice4ReportMerge.ts`
- Tests: `__tests__/gpuSlice4ReportMerge.test.ts`
- Issues: epic #228, slice #229, harness #230, surface #231, matrix #232,
  canonical outcome gh-199.
