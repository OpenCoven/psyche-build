# Pane topbar hide control

## Goal

Replace the leftmost pane-topbar span-cycle control with a Hide pane control for every canvas surface: terminal, agent, browser, Git, and Files.

## Interaction

- The control uses a clear hide glyph, `title`, and `aria-label` of `Hide pane`.
- Activating it removes only the selected surface from the visible canvas. It does not stop its process, close its tab, discard its Files selection, or destroy browser/Git state.
- The existing pane switcher remains the restoration entry point. Restoring a hidden surface places it back into the active workspace and focuses it.
- Maximize and close controls retain their current behavior and ordering after Hide.
- The span-cycle action and its `▦` / full-width / full-height states are removed from pane topbars. No separate span-cycle affordance is added.

## Implementation boundaries

- Replace the common `terminal-pane-span` setup in each native web pane mount path with a shared hide-control setup.
- Reuse the existing thread hide/reopen lifecycle where it already applies.
- Extend the canvas-surface visibility model to give Files panes the same non-destructive hide/restore behavior; do not route Files through thread-only state.
- Update rendering, focus fallback, persistence, and switcher labels only where required to ensure a hidden surface is discoverable and restorable.

## Verification

- Add focused native-web tests for the button’s label/action contract across every pane kind.
- Cover hiding a visible surface, retaining it in the switcher, and restoring it with focus.
- Run the affected test suites, typecheck, web build, and whitespace check before publishing.
