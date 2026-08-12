# Warp-Like Pane Layout Design

## Goal

Make every Psyche shell a first-class tmux workspace pane. Shells must no
longer be duplicated as large cards in the sidebar. New shells join the
focused workspace pane through a persistent, Warp-like split layout.

## Chosen Approach

Replace the automatic optimal-grid reflow with a persisted split tree. The
tree is the source of truth for workspace topology; tmux renders that tree.
This prevents creation, closing, hiding, restoration, and terminal resizing
from rearranging unrelated panes.

The alternatives considered were:

1. Apply directional splitting only to shells while keeping the grid
   calculator for other events. This would allow later events to undo the
   intended arrangement.
2. Remove shell cards only. This would simplify the sidebar but retain the
   automatic grid behavior the change is intended to replace.

## Data Model

Persist a `PaneLayoutTree` alongside the session's panes:

- A leaf holds a Psyche pane ID.
- A split holds an orientation (`side-by-side` or `stacked`), a 50/50 sibling
  ratio, and two child nodes. Future user resizing can update that ratio.

All pane kinds can occupy leaves: agent, terminal, shell, file browser, and
desktop-use. The existing pane list remains the source of pane metadata; the
tree describes only placement. Hidden leaves remain in the tree but are omitted
from its tmux projection, allowing unhide to restore their original location.

Existing sessions that have no stored tree are migrated without closing or
recreating panes. Psyche deterministically seeds a tree from the visible pane
order, persists it, and subsequently treats that tree as authoritative.

## Layout Operations

Introduce one layout controller that owns all mutations:

- **Insert:** split the focused content leaf and insert the new pane as its
  sibling.
- **Close:** remove the leaf, collapse its parent, and preserve unaffected
  sibling sizing.
- **Hide or unhide:** mark a leaf inactive or active without changing its
  position in the tree.
- **Reopen:** insert a previously closed pane through the same controller.
- **External shell detection:** attach an untracked tmux shell by splitting
  the last focused content leaf; fall back to the selected pane and then the
  tree root.
- **Resize:** retain the split topology and recompute only terminal dimensions.

When a new pane is inserted, choose the direction adaptively: split beside a
tall focused pane and below a wide focused pane. This produces usable sibling
dimensions without requiring a direction prompt.

## Rendering and Interaction

The tmux workspace is the only shell workspace. `PanesGrid` retains
project/navigation chrome and pane actions, but does not render shell rows.
Focus, selection, attention state, and pane menus continue to use the
underlying `PsychePane`; shell panes receive the same lifecycle and interaction
rules as other workspace panes.

## Error Handling

Generate and apply the tmux layout before persisting the changed tree. If the
target pane is stale or tmux rejects the layout:

1. Keep the last known-good in-memory and persisted tree.
2. Refresh live tmux pane IDs.
3. Use the existing status/error path to report the failure.
4. Do not close, recreate, or otherwise disturb active panes.

## Validation

Add focused tests for:

- legacy tree seeding and persistence;
- adaptive insertion orientation;
- parent collapse after close, hide, and restore;
- external shell insertion;
- stale-pane rejection and tmux-application rollback;
- omission of shell cards from the sidebar;
- end-to-end terminal (`t`) creation in the persistent layout.

Run the focused Vitest suites for layout, pane creation, pane visibility, and
sidebar rendering, followed by the repository typecheck.
