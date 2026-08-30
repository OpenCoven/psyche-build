# GPU diagnostics surface contract

**Status:** Contract defined; Tauri UI panel integration open (see working record)  
**Issue:** [OpenCoven/psyche-build#231](https://github.com/OpenCoven/psyche-build/issues/231) (Bead `psyche-z7c.4.5`, P1)  
**Blocked by:** [#230](https://github.com/OpenCoven/psyche-build/issues/230) — debug-authorized rendering stress harness (family context; this slice does not implement the harness)  
**Parent slice:** [#229](https://github.com/OpenCoven/psyche-build/issues/229) — runtime graphics diagnostics and stress mode  
**Design plan:** [GPU ADE slice 4](../superpowers/plans/2026-08-10-gpu-ade-slice-4-diagnostics-stress.md) (Task 5)  
**Machine-checkable contract:** [`src/gpu/diagnosticsSurface.ts`](../../src/gpu/diagnosticsSurface.ts) (schema v1)

This document defines the development-only titlebar action and diagnostics
panel for desktop GPU/runtime diagnostics, and the pure display contract every
future implementation of that surface must satisfy. It is deliberately a
**view** contract: the panel renders evidence the runtime already collected. It
collects nothing, grants nothing, and expands nothing.

## Non-negotiable rules

1. **Development-only, fail closed.** The titlebar action and panel exist only
   when `isDiagnosticsAuthorized()` passes: a debug build (`debugBuild: true`)
   AND an explicit authorization token equal to
   `GPU_DIAGNOSTICS_AUTHORIZATION_TOKEN` (`'1'`, carried by
   `PSYCHE_RENDER_DIAGNOSTICS` at startup). Production builds compile the
   surface out and are denied even if a token is present. Tokens are compared
   exactly — no trimming, no case-folding, no default. Anything else means no
   titlebar action, no panel, and no controls.
2. **Only present fields are shown.** The panel renders rows from present
   object keys via `visibleRowsFor()`. Absent, unsupported, or unpresentable
   fields (empty or oversize strings, non-finite numbers, empty or oversize
   marker lists, out-of-vocabulary states) are **omitted — never filled with
   placeholders** such as `N/A`, `TBD`, or stub text. Every visible row carries
   its evidence class: `reported` (identity/stack facts from the graphics probe
   or native runtime), `measured` (direct counters: PTY transport, process
   resources), or `derived` (statistics computed from bounded samples: frame
   percentiles, dropped-frame estimates).
3. **Software fallback is prominent.** When the snapshot classifies
   acceleration as `software`, the accessible status text (`copyForA11y()`)
   must lead with that fact as the first sentence, before any other content.
   Fallback reasons are stated when reported. Acceleration is never promoted
   beyond what the evidence supports.
4. **Copy JSON is deterministic.** The copy action serializes via
   `diagnosticsJson()`: schema-versioned envelope, only catalogued presentable
   values (raw, not display strings), object keys sorted recursively, and
   name-only omission manifests (`omittedKeys`, `invalidKeys`) for anything
   unknown or unpresentable. The same snapshot always produces byte-identical
   output regardless of property insertion order; observed evidence order
   (e.g. software markers) is preserved.
5. **Scenario controls only when authorized.** Scenario start, progress, and
   cancellation affordances render and operate only when
   `canControlScenarios()` passes — the same fail-closed gate as the surface
   itself. Unauthorized sessions show no controls at all, not disabled
   placeholders. Stress execution remains owned by the #230 harness, which
   re-checks authorization on its own side.
6. **Accessible status text.** The panel exposes a single coherent status
   string (`copyForA11y()`): leading acceleration sentence, present fields as
   `label: value` pairs in catalog order, scenario-control availability, and
   an explicit omission count when anything was omitted — so screen-reader
   users know nothing was silently dropped.
7. **Startup graphics logging is independent of the panel.** The always-on
   `[psyche:graphics]` startup summary belongs to the runtime entry path. The
   startup graphics logging path stays active whether or not the panel exists:
   it must keep logging even when this panel is absent, unauthorized, or fails
   to render. Panel availability never gates observability.
8. **No capability or CSP expansion.** The surface adds no Tauri capability,
   permission, command, protocol handler, or CSP directive. It renders text in
   the existing webview from data the runtime already collected, and its
   styling may only use the Slice 3 transition helper with
   `GPU_DIAGNOSTICS_TRANSITION_PROPERTIES` — exactly `transform` and
   `opacity`, the same closed set the compositor CSS audit
   (`__tests__/tauriCompositorCss.test.ts`) enforces on the desktop
   stylesheet. Everything else (`all`, `color`, `width`, `box-shadow`, any
   paint-triggering property class) is rejected by
   `filterDiagnosticTransitionProperties()`.
9. **Bounded enumerated state only.** Values are bounded
   (`GPU_DIAGNOSTICS_LIMITS`: strings ≤ 512 chars, list entries ≤ 128 chars,
   lists ≤ 8 entries) and omission manifests are name-only and capped. Raw
   values that fail the bounds are omitted rather than truncated; unknown
   values are never serialized, so arbitrary content cannot leak through the
   copy action.

## Surface anatomy (dev builds only)

- **Titlebar action:** a single development-only action that toggles the
  diagnostics panel. It is present exactly when `isDiagnosticsAuthorized()` is
  true and never ships in production builds.
- **Diagnostics panel (right side):** rows rendered from `visibleRowsFor()`,
  grouped in display order `graphics → runtime → renderer → transport → frame
  → process`. Each row shows the field label, the value, and its evidence
  class. There is no "empty state" row content per missing field — absent
  fields simply have no row.
- **Software-fallback banner:** when acceleration is `software`, the panel
  presents the software fallback prominently (first sentence of status text;
  visually emphasized in any future markup implementation) with the reported
  fallback reason.
- **Copy JSON action:** copies `diagnosticsJson(snapshot)` — the deterministic
  serialization, suitable for pasting into evidence records (which the #232
  verification matrix then validates for shape).
- **Scenario controls (authorized only):** start/progress/cancel affordances
  for the #230 stress scenarios, rendered only when `canControlScenarios()` is
  true, with progress and cancellation exposed through the accessible status
  text while a scenario runs.

## Field catalog (schema v1)

The closed field catalog is `GPU_DIAGNOSTICS_FIELDS` in
[`src/gpu/diagnosticsSurface.ts`](../../src/gpu/diagnosticsSurface.ts). Twenty
fields across six groups:

| Group | Fields | Evidence class |
|---|---|---|
| `graphics` | `acceleration` (`accelerated`/`software`/`unknown`/`unavailable`), `backend`, `adapter`, `softwareMarkers[]`, `fallbackReason`, `supportingProbe` | `reported` |
| `runtime` | `engine`, `engineVersion`, `os`, `arch` | `reported` |
| `renderer` | `mode` | `reported` |
| `transport` | `queueHighWater`, `ipcMessagesPerSecond`, `throughputBytesPerSecond` | `measured` |
| `frame` | `averageMs`, `p95Ms`, `maxMs`, `droppedEstimated` | `derived` |
| `process` | `cpuPercent`, `rssMb` | `measured` |

The acceleration vocabulary mirrors the strict probe classification used across
the GPU family (`src/gpu/verificationMatrix.ts`): `accelerated` requires strict
WebGL/WebGPU evidence plus non-software renderer markers; `software`, `unknown`,
and `unavailable` are recorded as what they are, never promoted.

## Module API

| Export | Purpose |
|---|---|
| `GPU_DIAGNOSTICS_SURFACE_SCHEMA_VERSION` / `GPU_DIAGNOSTICS_SURFACE_ID` | Versioned envelope identity (`1`, `gpu-diagnostics`) |
| `GPU_DIAGNOSTICS_AUTHORIZATION_ENV` / `GPU_DIAGNOSTICS_AUTHORIZATION_TOKEN` | The startup authorization channel (`PSYCHE_RENDER_DIAGNOSTICS`) and its only accepted value (`'1'`); the module never reads the environment itself |
| `GPU_DIAGNOSTICS_GROUPS`, `GPU_DIAGNOSTICS_EVIDENCE_CLASSES`, `GPU_DIAGNOSTICS_ACCELERATION_STATES`, `GPU_DIAGNOSTICS_FIELDS`, `GPU_DIAGNOSTICS_LIMITS` | Closed vocabularies, catalog, and bounds |
| `isDiagnosticsAuthorized(input)` | Fail-closed dev-only gate: debug build + exact token |
| `canControlScenarios(input)` | Scenario-control gate (same authorization seam) |
| `visibleRowsFor(snapshot)` | The only rows the panel may render, with evidence classes; omits the absent/unsupported |
| `omissionManifestsFor(snapshot)` | Name-only, sorted, capped omission manifests |
| `diagnosticsJson(snapshot)` | Deterministic, key-sorted, stable copy JSON |
| `copyForA11y(snapshot, options?)` | Accessible status text with prominent software fallback |
| `GPU_DIAGNOSTICS_TRANSITION_PROPERTIES`, `filterDiagnosticTransitionProperties()`, `isAllowedDiagnosticTransitionProperty()` | The transform/opacity-only transition allowlist |

The module is pure TypeScript: no imports, no I/O, no DOM, no environment
reads. The host application observes the debug-build flag and the
authorization token once at startup and passes them in, keeping every rule
unit-testable and the gate impossible to bypass by re-reading the environment
from inside the surface.

## Scope and family boundaries

- **#228** owns the GPU family charter; this document defers to it.
- **#229** owns the runtime diagnostics merge (probe + native report + metrics)
  that produces the snapshots this surface renders.
- **#230** owns the debug-authorized stress harness and the stress execution
  path; this slice owns only the display/authorization contract for the panel
  controls.
- **#232** owns the verification matrix that consumes copied diagnostics JSON
  as part of platform evidence.
- The **Tauri UI panel integration** (titlebar action markup, panel layout,
  styles wiring in `web/index.html`, `web/main.js`, `web/styles.css`) is not
  implemented in this slice and is a documented open gap — see
  `docs/working-records/issue-231-gpu-diagnostics-surface.md`.
