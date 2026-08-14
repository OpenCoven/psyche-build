# Swift Remote Action Reducer and Sheet Design

**Bead:** `psyche-i7c.8.3`

## Goal

Add a reusable iOS action workflow reducer and adaptive SwiftUI sheet for the
callback-free `actions.start`, `actions.respond`, and `actions.result` protocol
surface. The implementation must preserve action scope and consequences,
support callback chains, and make every failure visible.

This bead includes the reusable `RemoteActionStore`, `ActionSheetView`, and
their tests. It does not add pane-menu entries that launch actions.

## Architecture

### RemoteActionStore

Add a `@MainActor` `ObservableObject` named `RemoteActionStore` to PsycheCore.
It remains separate from `WorkspaceStore` because workspace snapshots and
remote action sessions have different lifecycles.

The store owns:

- The current optional action-sheet presentation.
- The set of pane IDs with an active action workflow.
- The control-request transport used for `actions.start` and
  `actions.respond`.
- The pane and action identity associated with the active presentation.

Its public commands are:

- `start(action:onPane:in:)`, which validates the pane against the supplied
  current `WorkspaceSnapshot`, marks the pane busy, sends `actions.start`, and
  reduces the result.
- `respond(_:)`, which sends a typed response for the current session and
  replaces the current presentation with the continuation result.
- `dismiss()`, which closes non-interactive presentations. Interactive states
  cancel through `actions.respond` rather than disappearing locally.

The store exposes query helpers for whether a pane is busy and whether the
current state can be dismissed. Launch-menu wiring is intentionally outside
this bead.

### Presentation State

Use a typed presentation model rather than switching directly on protocol
strings in SwiftUI. The model retains:

- Pane ID and `PaneAction`.
- Result title and message.
- Optional session ID.
- Scope metadata from `data`.
- Related files.
- A typed content case for confirm, choice, input, PR review, progress,
  success, info, error, or navigation.
- Submission state that disables duplicate responses.

Unknown result types reduce to a visible error presentation. The sheet does
not silently discard future or malformed host responses.

## Reduction Rules

`confirm`, `choice`, `input`, and `pr_review` are interactive. Each requires a
non-empty `sessionId`. If the host omits it, the store replaces the result with
an error presentation and ends the busy workflow.

Submitting an interactive response consumes the currently displayed session
locally before awaiting the host, preventing duplicate taps from replaying a
single-use continuation. The current pane remains busy while the request is in
flight and while any continuation remains interactive.

Each continuation replaces the sheet content in place. The pane remains busy
across any number of confirm, choice, input, or PR-review steps. Busy state
clears only when reduction reaches success, info, error, progress, navigation,
explicit cancellation, or a transport/protocol failure.

Progress results render in the same sheet. They are non-interactive protocol
results and do not invent a continuation session, so they end the remote
session's busy state even though they may describe host work that continues
outside the action protocol. Determinate progress uses the provided percentage;
an absent percentage renders an indeterminate indicator. Progress is always
dismissable even when the wire value is false because the protocol has no
correlated continuation or update channel; honoring false would permanently
lock the single-sheet store and block every later action.

Success, info, and error results remain visible until the user dismisses them.
Errors never auto-dismiss and never reuse success styling.

## ActionSheetView

Add one adaptive SwiftUI sheet in PsycheApp. It observes
`RemoteActionStore` and delegates all state transitions back to the store.
The view does not send protocol requests itself.

The sheet uses a stable hierarchy:

1. Title and action identity.
2. Scope metadata.
3. Consequence or primary message.
4. Type-specific content.
5. Related files.
6. Cancel, dismiss, or submission controls.

Known scope keys are presented with user-facing labels:

- `host`
- `projectId`
- `projectTitle`
- `worktreePath`
- `sourceBranch`
- `targetBranch`
- `consequence`

`consequence` is displayed before destructive controls. Source and target
branches are shown as a direction, not as an unlabeled pair.

### Type-Specific Content

- **Confirm:** Show the consequence and scope before the confirm button. Use a
  destructive role for `.close`; the current protocol has no confirm-level
  danger field, so other confirm actions remain non-destructive.
- **Choice:** Show each option label and description. Respect `danger` and
  `default` metadata without automatically submitting a default.
- **Input:** Seed from `defaultValue`, show `placeholder`, and bound the editor
  using `inputMaxVisibleLines`.
- **PR review:** Show source-to-target branch direction, editable summary,
  `aiFailed` warning, and the review file list before submission.
- **Progress:** Render determinate or indeterminate progress with a dismiss
  control, while keeping response controls disabled.
- **Success, info, and error:** Show distinct accessible status treatment and
  a user-operated dismiss button.
- **Navigation:** Show the host message and target pane metadata. Actual
  navigation remains the responsibility of later integration wiring.

While a response is being submitted, controls are disabled and a progress
indicator is shown. If input or PR-review submission fails, the terminal error
presentation retains the attempted text for copy/recovery; replay is not
offered because the host session is single-use.

## Error Handling

The store surfaces these conditions as terminal error presentations:

- No control-request transport.
- Unknown or unpublished pane.
- Unexpected control response.
- Host protocol error.
- Missing or empty session ID for an interactive result.
- Unsupported result type.
- Response/result mismatch.
- Transport disconnection or send failure.

The error presentation includes the actionable host or transport message when
available. No error path clears the sheet as though the action succeeded.

## Testing

### PsycheCore Tests

Add focused reducer and command tests for:

- Start request encoding and pane/action identity.
- Confirm, choice, input, cancel, and PR-review response encoding.
- Every supported result type.
- Missing interactive session IDs.
- Multi-step continuation replacement.
- Busy-pane lifetime across chained interactions.
- Progress remains dismissable when the host sends `dismissable: false`, clears
  busy state, and permits a later start after dismissal.
- Duplicate response suppression.
- Terminal result and cancellation cleanup.
- Unexpected responses, protocol errors, and transport failures.
- Unknown result types.

### PsycheApp Tests

Add presentation tests for:

- Stable scope and consequence ordering.
- Destructive confirm and choice roles.
- Input defaults, placeholders, and visible-line bounds.
- PR-review branch direction, AI-failure warning, editable summary, and files.
- Determinate and indeterminate progress.
- Distinct success, info, and error treatments.
- Submission-disabled and terminal-dismiss states.

Tests should inspect extracted presentation helpers where possible rather than
depending on fragile pixel snapshots.

## Acceptance Mapping

- Interaction types require session IDs: enforced during reduction before the
  sheet can submit.
- Multi-step sessions keep panes busy: busy IDs clear only at terminal
  reduction or explicit failure.
- Consequences and scoped metadata precede destructive buttons: guaranteed by
  the stable sheet hierarchy.
- Errors never masquerade as success: all malformed, rejected, and transport
  failures reduce to explicit error presentations.
