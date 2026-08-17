# Mobile ritual discovery over protocol v3

## Decision

Add a bounded `rituals` array to each canonical workspace project snapshot. Each entry exposes only `id`, `displayName`, and optional `description`. The existing `rituals.launch` request remains the sole mutation path.

## Data flow

1. The host reads rituals available to each published project root.
2. `buildWorkspaceSnapshot` includes sanitized ritual metadata with that project.
3. The v3 workspace snapshot and workspace-changed event carry the same shape.
4. Swift presents a ritual affordance only when its project has at least one ritual.
5. Selecting an item calls scoped `WorkspaceStore.launchRitual`; success refreshes the workspace.

## Constraints

- No executable command, template, or privileged ritual payload crosses the mobile protocol.
- A client cannot launch a ritual for an unpublished project.
- Omitted `rituals` decodes as an empty array for old hosts during rollout.
- Protocol v2 `ritualList` remains unchanged for legacy clients.
- The host bounds the list before serialization.

## Verification

- TypeScript snapshot tests prove project-scoped bounded metadata and no executable fields.
- V3 fixtures round-trip snapshots containing rituals and old snapshots without the field.
- Gateway tests reject unpublished project launches.
- Swift UI tests hide the control for an empty list, launch a selected ritual, and observe refresh.

## Rejected alternative

