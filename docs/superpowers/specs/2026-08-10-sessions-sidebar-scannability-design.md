# Sessions sidebar scannability redesign

## Objective

Redesign the native macOS Psyche sessions sidebar so a user can identify the
current project, active branch, expanded groups, session type, selection, and
operational state within seconds. The implementation replaces the existing
Tauri sidebar directly and preserves its dark surface, purple identity,
project/worktree model, pane actions, Files tab, new-pane menu, resize behavior,
and Appearance controls.

The sidebar remains optimized for widths from 320 to 420 pixels.

## Current scannability problems

The current rail preserves the correct hierarchy, but several levels compete
for the same visual weight:

- Project headings are small, dim uppercase rows that are difficult to retain
  as location context while scrolling.
- The selected worktree receives a broad purple-tinted container while the
  selected session uses a similar raised treatment, weakening the distinction
  between branch context and the actual keyboard target.
- Session rows repeat the branch in their metadata even though the branch is
  already the immediate parent, causing secondary text to compete with names.
- Category labels do not include counts, and daemon-backed Coven sessions form
  a separate category even though users understand them as agents.
- Status relies heavily on small glowing colored dots. Running, selected,
  attention, and focus signals are not sufficiently distinct without color.
- Project, branch, category, icon, text, and status columns do not share one
  stable alignment grid.
- Search is visually quiet, has no type or status filters, does not highlight
  matches, and does not communicate temporary expansion of collapsed groups.
- Branch collapse depends on double-click or Left/Right while project headings
  do not expose equivalent hierarchy semantics.
- The list is marked as navigation rather than an accessible tree, and
  keyboard movement does not cover all visible tree items.

## Approved direction

Use a compact hierarchical tree with sticky project headers.

Projects are the strongest group label, branches are lightweight secondary
containers, Agents and Shells are compact category labels, and sessions are
fixed-grid rows. Projects are separated by spacing and a quiet divider rather
than cards. The active project has a purple leading edge and a textual
`CURRENT` badge; purple remains a navigation and focus signal, not an
operational status.

The visual hierarchy is:

1. Project
2. Branch
3. Category
4. Session

## Sidebar structure

### Pinned controls

The non-scrolling header contains:

1. A compact Sessions/Files segmented switch.
2. A high-contrast search field.
3. A new-session button and sidebar-collapse button.
4. One horizontal row of lightweight filters: All, Agents, Shells, Active,
   and Attention.

The search field includes a clearly rendered `/` shortcut badge. The two
icon-only controls retain visible tooltips and explicit accessible names:
`Create a new session` and `Collapse sidebar`.

The session tree scrolls independently below these controls. Appearance remains
anchored below the tree in a single subdued row.

### Project groups

Project headers:

- are sticky within the scrolling tree;
- use the strongest label weight and uppercase treatment;
- expose a large disclosure target;
- show the visible session count;
- show an attention count only when nonzero;
- show `CURRENT` and a purple leading edge for the active project; and
- expose the full project root in a tooltip.

Projects use a restrained bottom divider and vertical spacing. They do not use
heavy cards.

### Branch groups

Branch headers:

- use monospaced branch text;
- expose a large disclosure target;
- show the visible session count;
- show dirty or missing-worktree state through a symbol, label or tooltip;
- use a quiet neutral fill for the selected branch; and
- expose the full path in a tooltip when the branch is truncated.

The branch name appears once at the group level. Session metadata must not
repeat it.

### Categories

`Agents` and `Shells` are compact category labels with distinct icons and
counts, for example `Agents 2` and `Shells 5`.

Daemon-backed Coven sessions are grouped under Agents. `Coven` remains visible
as secondary session metadata so provenance and harness information are not
lost.

Empty categories remain hidden.

### Session rows

Every session row uses the same three-column grid:

1. Type icon.
2. Name and concise metadata.
3. Aligned status indicator.

The session name is the dominant text. Metadata is limited to useful
non-repetitive details such as harness, current command, relative recency,
canvas presence, or source. Truncated names and metadata expose their full
values through tooltips.

Rows use a 38-40 pixel rhythm. Existing rename, focus, preview, hide,
focus-set, duplicate, interrupt, and stop-and-close behavior remains available.

The duplicate PSYCHE-BUILD shell labels are differentiated as:

- `shell 8 · api`
- `shell 8 · tests`

This differentiation is derived from the most useful available command or pane
purpose. If no meaningful purpose is available, use a stable ordinal suffix
rather than displaying identical labels.

## Selection and interaction states

The following states must remain visually independent:

| State | Treatment |
| --- | --- |
| Selected session | Strong neutral raised fill, purple leading edge, stronger name, `aria-current="true"` |
| Hovered row | Quiet neutral surface change only |
| Keyboard-focused row | High-contrast two-pixel focus outline, independent of selection |
| Pressed row | Brief darker inset surface |
| Active branch | Quiet neutral branch fill with stronger text |
| Active project | Purple leading edge plus `CURRENT` text badge |
| Operational state | Right-aligned icon, word, color, and tooltip |

Selection is always more prominent than operational state. A selected idle
session still reads as selected first and idle second.

Transitions are subtle and use the existing fast timing token. Animation,
pulsing, and transitional movement are disabled under
`prefers-reduced-motion: reduce`.

## Status model

Color is never the only status carrier. Each state combines a sharp icon,
short label, semantic color, accessible name, and tooltip:

| State | Indicator | Meaning |
| --- | --- | --- |
| Active | `● ACTIVE`, green | Process is alive and recently produced ordinary output |
| Busy | `↻ BUSY`, blue | Process is starting or an agent is visibly working |
| Idle | `– IDLE`, gray | Process is alive but has been quiet beyond the activity window |
| Attention | `! REPLY`, yellow | Session is waiting for user input or an answer |
| Exited | `× EXITED`, red | Process has ended |

Precedence is `Exited` → `Attention` → `Busy` → `Active` → `Idle`.

For local panes:

- `exited` maps to Exited;
- `needsAttention` maps to Attention;
- `starting` or `spawning` maps to Busy;
- recognized working output maps to Busy;
- recent PTY output maps to Active; and
- a live process with no recent output maps to Idle.

The existing terminal-tail attention tracker remains authoritative for local
agent attention. PTY output updates a `lastOutputAt` timestamp used only for
the Active-to-Idle transition. Shell prompts remain Idle, not Attention.

For daemon-backed Coven sessions:

- `waiting` maps to Attention;
- `starting` maps to Busy;
- `running` maps to Busy unless an attached local pane provides more specific
  activity evidence; and
- non-live states retain the existing muted or failure presentation if they
  appear during stale discovery.

A compact legend is available through the status-filter tooltip or an adjacent
help affordance. Every individual indicator also has its own tooltip.

Across the sidebar, purple means current navigation context: active project,
selected session, keyboard focus, or on-canvas presence. Green means recent
ordinary activity, blue means busy/working, yellow means user attention, gray
means idle, and red means exited or failed.

## Sorting

Sorting is deterministic within each category:

1. Selected session.
2. Attention-required sessions.
3. Busy sessions.
4. Active sessions.
5. Idle sessions.
6. Exited sessions.
7. Most recently active within the same state.
8. Stable session identifier as the final tie-breaker.

Project and branch order remains the user/workspace order. Search filters the
existing order rather than reordering matches while the user types.

## Search and filters

Search matches normalized text from:

- project name and root;
- branch name and worktree path;
- category/type;
- session name and identifier;
- agent harness and Coven source;
- command and concise metadata; and
- status label.

Matches are highlighted with `<mark>` in every visible field. A matching
session temporarily reveals its project, branch, and category even when those
groups were manually collapsed. Search expansion never overwrites the user's
saved expansion state; clearing the query restores the exact pre-search state.

Filters are:

- All
- Agents
- Shells
- Active
- Attention

`Active` includes Busy and Active, because both represent sessions currently
doing work. `Attention` includes only sessions requiring user action. Type and
status filters are single-select in the initial production pass to keep the
control compact and predictable.

Filter selection persists between visits. Search text does not persist, which
prevents the application from reopening with sessions unexpectedly hidden.

The empty result state distinguishes:

- no sessions exist;
- no sessions match the current search; and
- no sessions match the current filter.

It includes a clear-search or reset-filter action where relevant.

## Keyboard and accessibility contract

The session list uses semantic tree markup:

- the scrolling container is `role="tree"`;
- projects, branches, categories, and sessions are represented as tree items or
  labelled groups as appropriate;
- project and branch controls expose `aria-expanded`;
- the selected session exposes `aria-current="true"`; and
- counts and attention summaries have explicit accessible labels.

The tree uses roving focus: one visible actionable tree item has `tabindex="0"`
and all others use `tabindex="-1"`.

Keyboard behavior:

| Key | Behavior |
| --- | --- |
| Up / Down | Move through visible actionable tree items |
| Left | Collapse the current project/branch, or move to its parent |
| Right | Expand the current project/branch, or move to its first child |
| Home / End | Move to the first or last visible item |
| Enter | Activate the focused project, branch, or session |
| Space | Toggle disclosure on project/branch items |
| `/` | Focus search |
| Escape | Clear search, then return focus to the previous tree item |

Focus is restored by stable project, branch, or session key after rerendering.
No keyboard action depends on pointer-only hover or double-click.

Tooltips cover icon-only controls, truncated text, status indicators, dirty or
missing worktrees, and any unfamiliar icon. Native `title` attributes may
remain as a baseline, but reusable accessible tooltip markup supplies visible
content on hover and keyboard focus.

Text, icons, shortcut labels, dividers, and interactive states must meet WCAG
AA contrast against their actual surfaces.

## Reusable component boundaries

The implementation remains dependency-free plain JavaScript and builds DOM
through focused helpers:

- `createSidebarToolbar`
- `createSessionFilters`
- `createProjectGroup`
- `createBranchGroup`
- `createCategoryLabel`
- `createSessionRow`
- `createStatusIndicator`
- `attachTooltip`

These helpers receive normalized view models and callbacks. They do not read or
mutate global application state directly.

The session model gains pure helpers for:

- normalizing local and Coven sessions;
- deriving presentation status;
- grouping Coven under Agents;
- calculating counts and attention summaries;
- deterministic sorting;
- filtering and searchable text;
- duplicate-label differentiation; and
- temporary expansion during search.

The existing action functions remain authoritative for project activation,
worktree activation, focusing, renaming, hiding, reopening, attaching Coven,
and closing.

## State and persistence

Persist through the existing settings/workspace storage:

- active sidebar tab;
- selected session key;
- project expansion;
- branch expansion;
- active filter; and
- existing sidebar width and appearance settings.

Search text, hover state, tooltip state, temporary search expansion, and
keyboard focus are ephemeral.

Saved state is validated against known enum values and current project,
worktree, and session identifiers. Missing or stale identifiers fall back to
the first valid visible item without suppressing an error from the underlying
session or discovery model.

The selected-session key is `coven:<session-id>` for daemon sessions and a
composite of project root, worktree path, kind, displayed name, and command
discriminator for local panes. A local pane without a command discriminator
uses its live thread identifier, which remains stable for the lifetime of that
runtime only. Selection is restored only when a matching session still exists.
The native application does not currently recreate local PTYs after relaunch,
so a missing local session key falls back to the selected branch or first
visible session rather than implying that the stopped process was restored.

## Error handling

The redesign preserves explicit discovery and lifecycle errors:

- Coven loading, stale, unavailable, incompatible, and error messages remain
  visible in the relevant branch context.
- A missing worktree remains visibly marked and cannot be activated.
- Search and filter logic never converts a discovery error into a normal empty
  result.
- Invalid persisted filter or expansion data is ignored narrowly and replaced
  with a valid default.
- Existing pane action failures continue through the current status and toast
  surfaces rather than being swallowed.

## Realistic reference content

The implementation and visual fixtures retain:

- PSYCHE-BUILD
  - `feat/web-pane-attention`
  - Shells: `shell 7`, `shell 8 · api`, `shell 8 · tests`, `shell 9`,
    `shell 10`
- COVEN-CAVE
  - `main`
  - Agents: `Agent Coven`
  - Shells: `shell 5`
- CHAT
  - `main`
  - Agents: `Agent Coven`

The fixture/state examples cover expanded and collapsed branches, selected,
hovered, focused, active, busy, idle, attention-required, and exited
presentations.

## Verification

Pure model tests cover:

- local and Coven normalization;
- Coven grouping under Agents;
- project, branch, and category counts;
- status precedence and labels;
- deterministic sort priority;
- duplicate-label differentiation;
- search across every supported metadata field;
- match highlighting ranges;
- filter semantics;
- temporary search expansion; and
- persisted-state validation.

Sidebar rendering tests cover:

- semantic tree roles and `aria-expanded`;
- roving `tabindex`;
- selected and focused state independence;
- project/branch disclosure;
- Arrow, Home, End, Enter, Space, `/`, and Escape behavior;
- focus restoration after rerender;
- accessible tooltips and icon labels;
- compact tabs, pinned controls, independent tree scrolling, and anchored
  Appearance control; and
- preservation of existing focus, attach, rename, hide, reopen, interrupt, and
  close actions.

CSS assertions or browser-level checks cover:

- distinct selected, hover, focus, pressed, branch-active, and status styles;
- 320, 390, and 420 pixel sidebar widths;
- truncation and tooltip behavior;
- WCAG AA contrast for required text and controls; and
- reduced-motion behavior.

Existing native siderail, attention, session-model, Files-tab, focus-set, and
workspace persistence suites remain green.
