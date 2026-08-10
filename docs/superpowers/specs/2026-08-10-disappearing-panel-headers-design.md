# Disappearing panel headers

## Goal

Make native macOS terminal and tool-panel headers ultra-minimal, semi-transparent,
and self-hiding during content scrolling while keeping every control quickly
recoverable and keyboard accessible.

## Scope

The treatment applies to:

- Every physical terminal pane header.
- The Files panel header.
- The combined Git and Changes panel headers.
- The Web panel navigation header.

The dock tab strip, file tab strip, sidebar, composer, and window chrome remain
unchanged.

## Visual treatment

Headers use the approved **Glass hairline** direction:

- Height between 26px and 28px.
- Low-opacity dark surface with subtle backdrop blur.
- Faint bottom border rather than a heavy container.
- Compact typography and spacing.
- No decorative chrome that does not communicate state or expose an action.

Terminal headers retain:

- Live/status indicator.
- Session title.
- Abbreviated worktree context.
- Stop-and-close action.

Tool headers retain their existing title, contextual crumb, and current action
buttons. The Web header retains navigation and URL controls because those are
functional browser inputs rather than decoration.

## Scroll behavior

Each header responds only to its own content surface.

1. Downward scrolling accumulates movement.
2. After a small threshold, the header fades, translates upward, and collapses
   so the content surface receives the reclaimed space.
3. Trackpad jitter below the threshold does not change visibility.
4. Horizontal scrolling does not hide a header.
5. Scrolling one pane or tool panel does not change another header.
6. Programmatic layout, resize, restoration, and rendering do not count as user
   scroll intent.

The threshold is reset after a header hides or is explicitly revealed.

## Reveal behavior

A visually invisible top-edge reveal zone remains available when a header is
hidden. Moving the pointer into that zone restores the header.

Keyboard focus entering a header or one of its controls restores the header
before interaction and keeps it visible until focus leaves. Headers remain in
the accessibility tree while visually hidden.

The header is also pinned visible while the user:

- Drags or repositions a terminal pane.
- Uses a terminal header context menu.
- Presses or focuses a header action.
- Edits or navigates the Web URL control.

Pointer exit alone does not hide a revealed header. A later qualifying content
scroll hides it again.

## Component boundary

A reusable header-visibility controller owns interaction state independently of
rendering and styling. One controller instance binds:

- A header element.
- Its reveal zone.
- Its scroll event source.
- Optional interaction-pin targets.

The controller owns:

- Accumulated vertical scroll distance.
- Hidden versus revealed state.
- Focus pinning.
- Pointer reveal.
- Gesture/context-menu pinning.
- Event cleanup.

CSS owns the visual treatment through one hidden-state class. JavaScript does
not set presentation styles directly.

## Surface bindings

- Each terminal pane binds to its xterm scroll viewport.
- Files binds to the file-tree panel body.
- Git binds to the outer Git panel body so repository and Changes content share
  one primary header state.
- The Changes subheader may hide with the same Git controller rather than
  maintaining a competing nested state.
- Web binds to the browser panel's local scroll/event surface where the host
  receives user wheel events. Navigation controls remain pinned while focused.

If an embedded Web page consumes scrolling without exposing a host event, the
Web header remains visible rather than using polling or invasive page scripts.

## Motion and accessibility

- Normal motion uses a short opacity, transform, and grid/size transition.
- `prefers-reduced-motion: reduce` removes translation and animated timing; the
  state change remains immediate.
- Hidden headers do not use `display: none` or `visibility: hidden`, so focus
  recovery and assistive technology remain available.
- Reveal zones have no semantic role and are excluded from the accessibility
  tree.
- Focus indicators remain visible against the translucent surface.

## Persistence interaction

Header visibility is transient UI state and is not written to workspace v3.
Restored panes and panels start with headers visible. Session persistence,
terminal attachment, pane topology, and project/worktree restore behavior are
otherwise unchanged.

## Error handling

If a scroll surface cannot be found, the header remains visible and the
controller reports the missing binding through the existing diagnostic path.
It does not silently install document-wide listeners or hide unrelated
headers.

Destroying or rebuilding a pane removes all controller listeners and pending
animation work. A stale controller cannot mutate a replacement pane.

## Verification

Automated tests cover:

- Threshold accumulation and reset.
- Ignoring horizontal movement and sub-threshold jitter.
- Independent state for multiple terminal panes and tool panels.
- Top-edge pointer reveal.
- Focus reveal and pinning until focus leaves.
- Drag, context-menu, and action pinning.
- Git primary/subheader coordination.
- Safe Web fallback when host scroll events are unavailable.
- Reduced-motion styling.
- Controller cleanup when panes close or panels rerender.
- Preservation of pane drag, close, browser navigation, refresh, Git, and file
  controls.

Packaged acceptance opens multiple terminal panes and every tool panel, scrolls
each independently, confirms only the active header disappears, reveals it from
the top edge, operates each control by pointer and keyboard, and confirms
restored persistent sessions reopen with visible headers.
