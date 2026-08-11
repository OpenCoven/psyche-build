# Physical Pane Footer Buttons Design

**Date:** 2026-08-10
**Status:** Approved design

## Goal

Add a compact, physical button rail to the bottom of every canvas pane so
important pane and agent-session metadata stays visible and actionable without
opening another surface.

Agent panes show branch, worktree, model, session ID, context usage, and
cumulative session spend. Plain terminal and Web panes show only the applicable
branch, worktree, and pane ID controls.

## Product decisions

1. The footer is an always-visible 27px rail, not a hover-only overlay.
2. Footer items are interactive buttons rather than decorative chips.
3. The visual treatment is one continuous rail with adjacent, border-separated
   controls. It does not use individually floating pills.
4. Agent context and spend represent cumulative totals for the current pane
   session.
5. Psyche adds real provider-backed session telemetry. It does not scrape
   terminal text or display invented zero values.
6. Non-agent panes show only relevant core controls rather than disabled agent
   metrics.

## Pane layout

Each physical pane becomes a three-row grid:

```text
header
content
footer (27px)
```

The footer reduces the content area by exactly 27px. The pane minimum height
increases by the same amount so the existing usable terminal floor is
preserved.

Footer controls use the existing pane surface palette. Dividers, a subtle
raised hover state, and a pressed state make each segment read as a physical
button without adding pill-shaped visual noise.

### Agent pane order

Controls appear in this priority order:

1. branch
2. worktree
3. model
4. session ID
5. context used/max
6. cumulative spend

### Terminal and Web pane order

1. branch
2. worktree
3. pane ID

### Narrow panes

Controls collapse by usefulness rather than wrapping. The removal order is:

1. session ID
2. spend
3. context
4. model

Branch and worktree remain visible as long as the pane can fit them. Hidden
controls move into one footer overflow button. The footer never wraps into a
second row.

All visible values may be visually truncated, but their tooltips and accessible
labels contain the full value.

## Interaction contract

| Control | Primary action |
| --- | --- |
| Branch | Copy the full branch name |
| Worktree | Reveal the worktree directory in Finder |
| Model | Open the agent/model selector when the provider supports switching; otherwise open model details |
| Session ID | Copy the full provider session ID |
| Context | Open the session usage popover |
| Spend | Open the session usage popover |
| Pane ID | Copy the full local pane ID |
| Overflow | Open the hidden footer controls |

The session usage popover shows exact context used and limit, cumulative spend,
provider, model, session ID, last refresh time, and any stale or unsupported
state.

Every action is keyboard reachable. Focused, hover, pressed, disabled, loading,
and stale states use the existing theme tokens and do not depend on color alone.

## Components

### PaneFooter

One reusable DOM renderer is mounted by both terminal and Web pane creation.
It receives normalized state and action callbacks instead of reading global
state directly.

```text
PaneFooterState
  branch
  worktreePath
  worktreeLabel
  paneId
  agent?
    provider
    model
    sessionId
    contextUsed
    contextLimit
    spendUsd
    updatedAt
    stale
    error
  capabilities
    canSwitchModel
    canRevealWorktree
```

The footer renderer owns ordering, responsive collapse, accessible labels, and
the usage/overflow popovers. Pane mounting owns only creation, focus behavior,
and passing the current state.

### Session metrics service

A Rust-side service resolves agent metadata for a physical pane. Provider
adapters are selected from the pane's launch kind and command. Each adapter
reads only local provider-owned records or supported local APIs.

Initial adapter targets are:

- Coven: local daemon session records;
- Codex: local transcript and event records;
- Copilot CLI, Claude, and Grok: their supported local session records or local
  APIs when those providers expose the required fields.

Adapters return one normalized response. They must fail closed when a source
format is absent, malformed, ambiguous, or unsupported. They do not parse the
visible terminal buffer to infer model, tokens, context, or spend.

Spend is returned only when either:

1. the provider reports authoritative cost; or
2. the provider reports authoritative token usage and model identity and the
   adapter has an explicit, tested pricing source for that provider/model.

Otherwise the spend field is `unreported`, not zero.

### Pane/session binding

The local pane ID is always available from the thread model. Agent session IDs
are bound only through exact provider identifiers or an unambiguous provider
record. If a newly launched session cannot yet be identified exactly, its
agent metrics stay in a loading or unavailable state until the binding becomes
authoritative.

## Data flow

```text
project/worktree refresh
  -> branch + worktree state
  -> PaneFooterState core fields

pane launch identity
  -> provider adapter selection
  -> local provider session record/API
  -> normalized session metrics
  -> PaneFooterState agent fields
  -> footer + usage popover
```

Visible agent panes request metrics:

1. when mounted;
2. after their output settles; and
3. on a low-frequency refresh interval.

Hidden panes and non-agent panes do not poll provider telemetry.

Each request carries the pane ID, current provider/session binding, and a
generation ID. A response is applied only if all three still match, preventing
an old request from overwriting a restarted or rebound pane.

Session telemetry is ephemeral UI state. It is not written into the persisted
workspace layout.

## Error and unavailable states

- Loading fields display a subtle ellipsis.
- A provider that does not report a metric displays an interactive em dash in
  that metric's agent-pane control; the usage popover explains that it is not
  reported.
- A failed refresh keeps the last known values, marks them stale, and exposes
  the adapter error in the popover.
- A malformed provider record never becomes a zero-valued success state.
- A model-switch action is exposed only when the adapter reports that
  capability.
- Worktree reveal failures use the existing visible status/toast error path.

## Browser pane behavior

The browser pane gets the same core footer as a terminal pane. Its native
webview bounds continue to use the browser pane body element, not the full pane
frame, so the new footer cannot overlap or intercept the embedded browser
surface.

## Scope

This design includes:

- footer rendering and responsive overflow;
- branch, worktree, pane, model, session, context, and spend controls;
- the usage and overflow popovers;
- local provider telemetry adapters;
- visible-pane refresh scheduling;
- exact pane/session binding;
- Finder reveal and copy actions; and
- focused regression tests.

It does not:

- add remote telemetry or upload provider session records;
- estimate usage from terminal text;
- change provider billing;
- persist spend into Psyche workspace state;
- redesign pane headers or the global command composer; or
- guarantee metrics that an agent provider does not expose locally.

## Verification

Add focused tests for:

- the footer's presence and field set by pane kind;
- the fixed third pane row and preserved content-height floor;
- priority collapse and overflow without wrapping;
- button actions and full-value accessible labels;
- usage popover loading, current, unreported, stale, and error states;
- provider adapter normalization and malformed-record rejection;
- authoritative spend rules;
- stale response and pane/session generation rejection;
- polling only visible agent panes;
- model-switch capability gating; and
- native browser bounds using the browser body above the footer.

Run the existing physical-pane, workspace-panel, Coven session, Rust adapter,
typecheck, and native web build checks that cover the changed surfaces.
