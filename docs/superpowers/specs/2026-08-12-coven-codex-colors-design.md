# Coven Purple and Codex Blackish Color Design

**Date:** 2026-08-12

## Goal

Restore Coven Purple to its prior saturated violet appearance and refine Codex
Blackish so it remains dark without reading as stark black and white.

## Scope

Change only the native desktop theme tokens in
`native/desktop/psyche-build-tauri/web/styles.css` and their regression tests in
`__tests__/tauriThemeTokens.test.ts`.

Do not add component-specific theme overrides, change runtime theme selection,
or alter the Claude Orange, Gemini Blue, Emerald, or Rose palettes.

## Coven Purple

Restore the exact palette introduced by commit `617d3fd`:

- Accent: `#b89dff`
- Strong accent: `#9d80f0`
- Deep surface: `15, 6, 39`
- Surface 1: `22, 9, 58`
- Surface 2: `30, 12, 79`
- Surface 3: `40, 16, 103`
- Terminal surface: `16, 6, 40`
- Text: `#f5f2fb`
- Soft text: `#c8c2d8`
- Muted text: `#8a8499`

This is an exact restoration, not a reinterpretation. The explicit
`:root[data-theme="coven-purple"]` block remains necessary so the default theme
cannot fall through to the neutral `:root` ramp.

## Codex Blackish

Use a cool-charcoal surface ramp anchored by the user-selected colors:

- Accent RGB: `196, 202, 214`
- Accent: `#c4cad6`
- Strong accent: `#9da6b8`
- Deep surface: `15, 15, 17` (`#0f0f11`)
- Surface 1: `22, 23, 26`
- Surface 2: `30, 30, 31` (`#1e1e1f`)
- Surface 3: `43, 44, 48`
- Terminal surface: `15, 15, 17` (`#0f0f11`)
- Text: `#f0f1f4`
- Soft text: `#c2c6ce`
- Muted text: `#858b96`

The surface ramp stays recognizably blackish. The subtle blue bias belongs in
the cool-silver accent and secondary neutrals, preventing the theme from
becoming either stark grayscale or a competing blue theme.

## Architecture and Behavior

The existing CSS custom-property system remains the single source of truth.
Tabs, sidebars, panes, terminal surfaces, focus rings, controls, and text
inherit the revised values without new selectors or runtime branches.

Unknown theme names continue to use the neutral `:root` fallback. Theme
selection, persistence, and the declared theme list remain unchanged.

## Regression Coverage

Extend `__tests__/tauriThemeTokens.test.ts` to:

1. Pin the Coven Purple surface ramp to the historical values above.
2. Pin Codex Blackish deep/terminal surfaces to `15, 15, 17`.
3. Pin Codex Blackish surface 2 to `30, 30, 31`.
4. Retain the existing checks that every declared theme has a complete block
   and that the default theme remains saturated.

The targeted theme-token test and native web build must pass.
