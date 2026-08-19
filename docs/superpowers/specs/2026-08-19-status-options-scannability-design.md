# Status Options Scannability Design

## Purpose

The footer's More menu currently renders every metric as a tall bordered card.
Repeated `Show`, `Earlier`, and `Later` labels compete with the live readings,
while compact values such as `1% 131M`, `120`, and `1 ops` require interpretation.
The menu should remain an operator control surface, but read like a compact
telemetry matrix rather than a stack of forms.

## Approved Direction

Use one quiet, ruled matrix with four stable columns:

```text
METRIC      READING                    VISIBLE   ORDER
Conn        ● Connected                   on      ↑ ↓
Agents      0 active                      on      ↑ ↓
Tasks       3 running · 0 waiting · 24 failed    ↑ ↓
Perf        CPU 1% · 131 MB               on      ↑ ↓
FPS         120 FPS                       on      ↑ ↓
Output      1 op/s                        on      ↑ ↓
```

Rows use separators instead of individual cards. Metric labels remain muted;
readings use brighter tabular numerals. Semantic color is scoped to the reading
and connection indicator, so a failed task count does not turn every control
red. The bottom telemetry values receive slightly stronger numeric treatment,
but no decorative chart, gradient, or new color family.

## Interaction

- Clicking a metric name or reading continues to open its existing detail panel.
- Visibility remains a native checkbox for semantics, styled as a compact switch.
- The menu names the visibility and order columns once; it does not repeat
  `Show`, `Earlier`, or `Later` in every row.
- Order controls use compact up/down glyphs with full `aria-label` and `title`
  text. Disabled boundary controls remain visibly and semantically disabled.
- Connection remains mandatory and its visibility switch remains checked and
  disabled.
- Existing focus restoration, keyboard navigation, overflow metadata, warning
  overrides, persistence, and responsive behavior are unchanged.

## Value Copy

The collapsed footer keeps its existing compact strings and widths. The More
menu uses a separate human-readable value:

- Connection: existing state label and indicator.
- Agents: `<count> active`.
- Shells: `<count> running`.
- Tasks: `<count> running · <count> waiting`, adding failed only when nonzero.
- Performance: `CPU <percent> · <memory with unit>`.
- FPS: `<count> FPS`.
- Output: `idle`, `<count> lines/s`, or `<count> op/s`.
- Unavailable metrics: `Unavailable`.

## Visual Tokens

No new global palette or typography is introduced. The redesign derives from
the existing footer tokens:

- surface: `var(--surface-1)` and the existing opaque menu background;
- rules: `var(--border)` and `var(--border-strong)`;
- labels: `var(--muted)`;
- readings: `var(--text)`;
- warnings/errors: `var(--warn)` and `var(--error)`;
- focus: `var(--accent-line)` and `var(--focus-ring)`;
- data type: `var(--font-mono)` with tabular numerals.

The signature element is the compact instrument-panel reading column: explicit
units, aligned numerals, and semantic emphasis confined to the data itself.

## Canonical Coven Palette

The approved Coven Purple appearance uses OpenCoven's canonical violet accent
on the deep grey-violet ink ramp:

- Accent: `#9a71ff` (`154, 113, 255`)
- Strong accent: `#8254eb`
- Deep and terminal surfaces: `18, 13, 24` (`#120d18`)
- Surface 1: `27, 21, 36` (`#1b1524`)
- Surface 2: `42, 34, 56` (`#2a2238`)
- Surface 3: `63, 53, 80` (`#3f3550`)
- Text: `#f3eff7`
- Soft text: `#bdb3cd`
- Muted text: `#9c8fb3`

This replaces the prior highly saturated violet surface ramp without changing
the palette or behavior of any other theme or semantic status color.

## Acceptance Criteria

- Seven metrics fit in materially less vertical space than the current cards.
- Labels, readings, visibility, and order controls align consistently.
- No row repeats `Show`, `Earlier`, or `Later` as visible copy.
- Menu readings are explicit while collapsed footer strings remain unchanged.
- Failure/warning color does not color neutral labels or ordering controls.
- Native checkbox semantics, detail opening, reordering, persistence, focus,
  disabled states, and overflow metadata continue to work.
- Focused controller tests, footer CSS contracts, bundle generation, and bundle
  freshness tests pass.
