# Pane Status Glow Design

**Date:** 2026-08-11
**Status:** Approved design

## Goal

Move pane runtime status out of the top-right header controls and into the pane
frame. Exception states use a restrained glow, while normally running panes
remain visually quiet.

## Product decisions

1. Remove the status chip or dot from terminal, Web, and tool pane headers.
2. Keep only span, maximize, and close controls at the top right.
3. Store runtime status on the pane element rather than retaining a hidden
   status node.
4. Do not glow normally running panes.
5. Use exception-only glow treatments:
   - starting: amber;
   - failed: red;
   - exited: muted neutral.
6. Preserve the existing worded needs-attention chip and its stronger amber
   frame treatment.
7. Keep the violet focused-pane border. Exception status appears as an outer
   glow so focus and status remain distinguishable.

## Pane header and frame

The terminal pane header changes from seven tracks to six:

```text
glyph | label | attention | span | maximize | close
```

Web and tool pane headers change from six tracks to five:

```text
glyph | label | span | maximize | close
```

Removing the status track gives the title more room and prevents status from
reading as another top-right action.

The pane frame remains neutral for empty and running states. Starting, failed,
and exited states add a restrained outer glow without changing pane geometry.
The glow must not animate. It must not alter layout, intercept input, or obscure
adjacent pane content.

## State hierarchy

Pane chrome follows this priority:

1. needs attention;
2. failed, starting, or exited status;
3. focused;
4. running or unknown.

Needs attention keeps the existing amber border, shadow, header tint, and
worded chip. It overrides the ordinary runtime-status glow because user action
is more important than process phase.

For a focused pane in an exception state, the violet focus border remains
visible and the exception color appears outside it as the glow. Running panes
use only the existing focus treatment.

## Implementation

Replace the element-oriented status updater with a pane-oriented helper. The
helper accepts the pane and runtime status, normalizes the status, and:

- writes a supported value to `data-status`;
- clears `data-status` for empty or unknown values;
- exposes `Status: <value>` through the pane's accessible description; and
- clears that description when no valid status exists.

Supported pane-frame status values are `running`, `starting`, `failed`, and
`exited`. CSS renders only the three exception values.

Remove:

- creation of `.terminal-pane-status` elements;
- insertion of those elements into terminal, Web, and tool headers;
- `thread.paneStatus` storage;
- status-chip and running-dot CSS; and
- responsive rules that hide the old status element.

Terminal, Web, and tool mounting continue to use the same pane-level updater so
initial state and later lifecycle transitions follow one path.

## Accessibility

The pane's accessible description states its normalized runtime status even
though the visual header no longer contains status text. The existing pane
title remains its accessible label.

Needs-attention continues to include a visible worded chip and must not rely on
color alone. Status glow is supplemental pane chrome and does not replace
errors already surfaced through terminal output or existing application status
paths.

## Failure semantics

- Empty or unknown status removes the status attribute and glow.
- A failed process receives the failed glow; it must not fall back to running.
- Exited remains visually distinct from failed through a muted neutral glow.
- Status updates must not remove focus, attention, span, or maximize state.
- Tool panes without a runtime status remain neutral.

## Testing

Update focused native pane tests to cover:

- six terminal-header tracks and five Web/tool-header tracks;
- absence of `.terminal-pane-status` creation, insertion, storage, and CSS;
- pane-level `data-status` and accessible-description updates;
- no status glow for running or unknown states;
- amber, red, and muted glows for starting, failed, and exited;
- needs-attention precedence over runtime glow;
- focused exception panes retaining the violet border plus outer status glow;
- runtime status transitions updating the existing pane element; and
- unchanged span, maximize, close, drag, and double-click behavior.

Run the existing physical-pane and session-attention tests that cover the
changed header and lifecycle contracts.

## Scope

This change is limited to native macOS physical pane chrome and its focused
tests. It does not redesign the session rail, global footer status bar, pane
footer controls, runtime status model, or attention detection.
