# OpenCoven Logo and Titlebar Design

## Goal

Replace Psyche Build's current in-app and macOS application marks with the
supplied OpenCoven logo, while correcting the broken titlebar hierarchy shown
in the current dev app.

## Current Visual Problems

The screenshot exposes three related issues:

1. The native `Psyche Build Dev` title remains visible above the app-owned
   `Psyche` brand, creating two competing identity rows.
2. `.titlebar-workspace` is not a flex container, so its flexible spacer does
   not move `Agent control` to the right. The sidebar toggle is absolutely
   positioned across the column seam and consequently overlaps that label.
3. The existing 18 px purple mark is visually muddy at titlebar size and does
   not match the supplied OpenCoven identity or the application icon.

## Approved Direction

Use one unified, app-owned 44 px titlebar.

- Suppress the visible native macOS window title while preserving native
  traffic lights and drag behavior.
- Show the OpenCoven mark in a 24 px black tile with restrained corner radius,
  followed by the `Psyche` product name.
- Make the workspace titlebar a flex row.
- Position the sidebar toggle fully inside the workspace, rather than centered
  over the sidebar/workspace divider.
- Keep `Agent control` right-aligned, with its count badge adjacent to the
  label.

This preserves the existing sidebar/workspace structure while giving the
window one clear identity and one stable control row.

## Logo Assets

The supplied source is `assets/opencoven/opencoven-1024.png` in the sibling
OpenCoven Coven checkout. Copy a repository-owned source asset into the desktop
app rather than loading it from that checkout at runtime.

### In-app mark

- Use the OpenCoven mark in the titlebar.
- Render it inside a black 24 px tile, with the mark inset enough to remain
  legible at native scale.
- Preserve an `O` text fallback if the image cannot load.

### macOS application icon

- Generate the Tauri PNG and ICNS icon set from the OpenCoven mark.
- Use a black rounded-square/squircle field with transparent outer corners.
- Keep the white mark optically centered and inset so it is not clipped by
  macOS masking or reduced-size Dock rendering.
- Apply the icon update to both stable and dev bundles; their names and bundle
  identifiers remain distinct.

## Implementation Boundaries

The expected implementation surfaces are:

- `native/desktop/psyche-build-tauri/web/index.html`
- `native/desktop/psyche-build-tauri/web/styles.css`
- `native/desktop/psyche-build-tauri/web/assets/`
- `native/desktop/psyche-build-tauri/src-tauri/icons/`
- macOS/Tauri configuration or build-channel configuration if required to
  reliably hide the native title
- directly related tests for titlebar structure, channel configuration, and
  icon presence

No sidebar content, empty-state content, command composer, or application
behavior changes are in scope.

## Behavior and Failure Handling

- The titlebar remains draggable except for interactive controls.
- Open and collapsed sidebar states keep the toggle within the workspace and
  prevent overlap with brand or workspace actions.
- If the in-app image fails, the fallback `O` remains visible instead of
  leaving an empty tile.
- Build failures during icon generation or bundling must fail explicitly; the
  build must not silently retain stale icon assets.

## Verification

1. Run the smallest relevant desktop/web tests for titlebar structure and
   build-channel configuration.
2. Build the web bundle and desktop application.
3. Rebuild `Psyche Build Dev.app`.
4. Launch the rebuilt app and verify:
   - only one product identity row is visible;
   - the OpenCoven titlebar mark is crisp;
   - the sidebar toggle does not overlap `Agent control`;
   - `Agent control` is right-aligned;
   - open and collapsed sidebar states remain aligned;
   - the app and Dock icon use the OpenCoven mark.
