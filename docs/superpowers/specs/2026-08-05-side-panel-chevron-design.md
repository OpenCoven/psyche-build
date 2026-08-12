# Side Panel Chevron Design

## Goal

Make the left side panel's existing collapsed rail discoverable with an
explicit chevron control.

## Behavior

The side panel continues to use its existing `sidePanelCollapsed` state:

- The expanded panel renders a `‹` control on its workspace-facing edge.
- The collapsed rail renders a `›` control.
- Activating either control invokes the existing `toggleSidePanel` callback.
- The `z` shortcut and existing collapsed-rail click behavior remain
  available.
- Collapse state remains session-local and follows the existing responsive
  default; it is not persisted across launches.

## Interaction Boundaries

Mouse handling recognizes only the rendered chevron row and column as the
explicit toggle target. Other sidebar clicks preserve their current behavior,
including pane selection and card interaction.

## Validation

Add Ink rendering coverage for both glyphs and input coverage that verifies:

1. a chevron click toggles the panel;
2. a normal expanded-panel click does not toggle it;
3. the existing `z` shortcut and collapsed-rail click behavior remain intact.
