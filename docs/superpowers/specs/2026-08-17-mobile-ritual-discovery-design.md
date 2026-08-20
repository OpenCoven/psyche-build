# Mobile ritual discovery over protocol v3

## Decision

Add a bounded `rituals` array to each canonical workspace project snapshot.
Each entry exposes only `id`, `displayName`, and optional `description`. The
existing `rituals.launch` request remains the sole mutation path.

## Data flow

1. The host reads rituals available to each published project root.
2. `buildWorkspaceSnapshot` includes sanitized ritual metadata with that project.
3. The v3 workspace snapshot and workspace-changed event carry the same shape.
4. Swift resolves the focused pane's project and presents a nested Rituals menu
   in the pane actions only when that project has at least one ritual.
5. Selecting an item calls scoped `WorkspaceStore.launchRitual`.
6. After a successful launch, Swift requests a full workspace snapshot and
   preserves the current pane selection. New panes appear through canonical
   refreshed state rather than optimistic local insertion.

## Constraints

- No executable command, template, or privileged ritual payload crosses the mobile protocol.
- A client cannot launch a ritual for an unpublished project.
- Omitted `rituals` decodes as an empty array for old hosts during rollout.
- Protocol v2 `ritualList` remains unchanged for legacy clients.
- The host bounds the list before serialization.
- Ritual launch is disabled while workspace state is stale or another pane
  action is running.
- Launch or refresh failures remain visible through the existing pane-action
  error alert.

## Verification

- TypeScript snapshot tests prove project-scoped bounded metadata and no executable fields.
- V3 fixtures round-trip snapshots containing rituals and old snapshots without the field.
- Gateway tests reject unpublished project launches.
- Swift unit tests prove the menu is hidden for an empty list and scoped to the
  focused pane's project.
- Swift UI tests launch a selected ritual, observe the refreshed pane, and
  verify that current pane selection is preserved.
- Targeted TypeScript, PsycheCore, iPhone, and iPad suites pass before
  `psyche-i7c.13` and `psyche-i7c.6` close.

## Alternatives considered

- **Add `rituals.list` to protocol v3.** This is explicit, but it adds a second
  cache and request lifecycle for data already tied to canonical workspace
  freshness.
- **Adapt legacy protocol-v2 `listRituals`.** This minimizes host work, but it
  mixes protocol generations and creates a second source of mobile workspace
  state.
- **Expose the affordance in both pane and project menus.** This duplicates the
  same action. The focused pane already establishes the project context, so the
  pane actions menu is the single launch surface.
