# Session-list close controls

## Objective

Make every visible session in the native macOS Sessions sidebar directly
closeable without relying on hover discovery or a context menu. Closing must
stop the underlying live process, remove the session from the list after the
operation succeeds, and retain the existing guard against accidental process
termination.

## Current behavior and root cause

Local Psyche pane rows already create a `.session-close` button, but CSS sets
it to `opacity: 0` until the row is hovered or focused. Despite its `×`
appearance, that button calls `hideThread`, which only removes the row from the
sidebar or canvas while leaving the process alive. Actual local termination is
available separately through the row context menu's `Stop and close` action
and the guarded `armSessionClose` flow.

Daemon-backed Coven rows create no close control. Psyche's Rust discovery
adapter currently performs only scoped session reads, although the Coven
daemon API already exposes `POST /api/v1/sessions/:id/kill`.

The resulting UI does not provide the direct close-out action suggested by the
visible session list.

## Approved interaction

Every rendered local or daemon-backed session row has an always-visible `×`
in a reserved trailing action slot. The control uses the accessible label and
tooltip `Stop and close <session name>`.

A first click does not terminate anything. It replaces the `×` with the
existing three-second `Close · N` confirmation pill. A second click within the
countdown performs the stop-and-close operation. Expiration, a click on a
different close control, or a rerender disarms the confirmation.

The close control remains outside the accessible tree's roving-tabindex
sequence, matching the existing keyboard model. A focused session row retains
the `Delete` shortcut, but `Delete` must invoke the same guarded stop-and-close
flow rather than silently hiding the row. The context menu keeps both actions:

- `Hide` remains non-destructive and only changes presentation.
- `Stop and close` invokes the same guarded close flow as the visible `×`.

The trailing slot stays allocated on every row so names and status indicators
do not shift between row types or interaction states. The button is visible at
rest and gains the existing hover and focus treatments. Reduced-motion
behavior remains unchanged.

## Lifecycle behavior

### Local Psyche panes

Confirming close calls the existing `closeThread(thread.id)` lifecycle path.
That path remains responsible for stop coordination, duplicate-close
suppression, canvas cleanup, active-pane selection, and persistence. The row
disappears through the normal sidebar refresh driven by local state removal.

### Daemon-backed Coven sessions

Confirming close calls a new Tauri command that sends
`POST /api/v1/sessions/:id/kill` to the configured Coven daemon endpoint. The
command validates the session ID with the existing `is_safe_session_id`
boundary before constructing the request and uses the same endpoint,
compatibility, timeout, response-size, and error-mapping rules as scoped Coven
session discovery.

Only a successful daemon response triggers an immediate session refresh. The
row disappears once refreshed discovery no longer returns it as an eligible
active Psyche-owned session. Psyche does not optimistically remove a Coven row
before the daemon confirms the kill.

## Error handling

- A local close failure follows the existing `closeThread` status behavior.
- A Coven kill failure leaves the row visible and reports a concise failure
  through the existing native status/toast surface.
- An unsafe or empty Coven session ID is rejected before any request is sent.
- An unavailable or incompatible daemon uses the same user-facing distinction
  as discovery; it never causes silent row removal.
- Repeated clicks while a close is in flight do not send duplicate kill
  requests.
- A refresh race is safe: if the session has already exited, the subsequent
  successful discovery removes it under the existing active-session filter.

## Accessibility and keyboard behavior

- Each `×` is a semantic `button` with an explicit session-specific accessible
  name.
- Clicking the action stops propagation so it never activates or attaches the
  row.
- The confirmation pill receives focus when armed and communicates the target
  session in its accessible name.
- The sidebar remains one accessible tree with session rows, not nested action
  buttons, in the roving-tabindex set.
- `Delete` on a focused local or Coven row arms the same confirmation instead
  of immediately performing a destructive action.

## Scope

This change is limited to the native macOS Tauri Sessions sidebar and its
native Coven adapter. It does not change session eligibility, ownership,
sorting, search, filters, canvas layout, focus sets, the Files tab, daemon
retention, or historical session records.

## Verification

Focused automated coverage must prove:

- local and Coven rows both render one always-visible `.session-close` button;
- the CSS no longer hides `.session-close` at rest and still reserves its slot;
- clicking `×`, choosing `Stop and close`, and pressing `Delete` all arm the
  confirmation without immediately terminating a session;
- confirming a local row calls `closeThread` exactly once;
- confirming a Coven row invokes the new native kill command exactly once,
  stops row activation, and refreshes sessions only after success;
- Coven kill failures retain the row and surface an error;
- unsafe session IDs are rejected at the Rust boundary;
- Unix-socket and loopback-HTTP transports issue the expected encoded kill
  request and preserve existing compatibility checks; and
- the accessible tree and roving-tabindex contracts remain intact.

Verification then runs the focused Vitest files, Rust unit tests for the Coven
adapter and command registration, root typecheck, and the native web build. A
packaged smoke check should confirm that a visible local pane and a visible
Psyche-owned Coven session can each be closed from the list and disappear only
after successful termination.
