# Psyche-owned active Coven sessions

## Problem

The native Psyche session rail currently renders every non-archived Coven
daemon record whose project root or worktree is in scope. The daemon can retain
months of completed sessions, so the `Coven` subsection becomes a historical
ledger rather than a concise view of sessions launched by Psyche.

Project path, harness name, external-session status, and creation time cannot
prove that Psyche initiated a session. Strict provenance therefore requires a
durable marker written when Coven Code registers the session with the daemon.

## Required behavior

The native `Coven` subsection shows a daemon session only when both conditions
are true:

1. Its labels contain the exact provenance label `source:psyche-build`.
2. Its normalized status is `starting`, `running`, or `waiting`.

All unlabeled, differently labeled, `idle`, `completed`, `failed`, `killed`,
`orphaned`, and `archived` records remain hidden. Search operates only over the
same eligible set and cannot reveal hidden history. A session that stops being
active disappears on the next successful discovery refresh. Its local Psyche
pane remains governed by the existing local pane lifecycle.

This rule applies to daemon-backed rows in the `Coven` subsection. Local panes
in the `Agents` and `Shells` subsections continue to reflect processes that
Psyche owns directly.

## Provenance contract

### Psyche Build

Every native `coven chat` launch descriptor includes:

```text
COVEN_SESSION_SOURCE=psyche-build
```

Psyche does not infer ownership from cwd, timestamps, process ancestry, titles,
or harness names. Native `coven attach <id>` launches do not relabel the target
session.

### Coven Code

Coven Code reads `COVEN_SESSION_SOURCE` only when registering its own external
interactive session. When its value is exactly `psyche-build`, registration
includes the label `source:psyche-build`.

Unknown or empty values do not create a provenance label. Coven Code must not
copy arbitrary environment text into daemon labels.

### Coven daemon and CLI

The external-session registration request accepts an optional `labels` array.
It rejects non-array or non-string values, more than 16 labels, duplicate
labels, empty labels, labels longer than 64 ASCII bytes, and characters outside
`[A-Za-z0-9._:-]` with `400 invalid_request`. A missing array is equivalent to
an empty array. Valid labels are persisted on the session record. Idempotent
registration retains the labels already stored for an existing external
session and must not overwrite a daemon-managed session.

The existing scoped sessions response returns the persisted labels in both
snake-case daemon JSON and the camel-case native response consumed by Psyche.

## Data flow

```text
Psyche launch descriptor
  -> COVEN_SESSION_SOURCE=psyche-build
  -> coven chat delegates to Coven Code with the environment intact
  -> Coven Code registers its external session with source:psyche-build
  -> Coven daemon validates and persists labels
  -> Psyche scoped discovery receives labels
  -> session model filters by exact label and active status
  -> rail renders the remaining Coven rows
```

## Compatibility and rollout

This is intentionally fail-closed. Older Coven or Coven Code versions that do
not persist the provenance label produce no Coven rows in Psyche, even when the
session is active. Psyche's native chat panes still work because discovery is
optional and does not control PTY launch.

Rollout order:

1. Release Coven support for labeled external registration and session reads.
2. Release Coven Code support for the trusted source environment marker.
3. Ship the Psyche launch marker and strict rail filter.

Existing historical sessions are not migrated or guessed. Only sessions
created after the compatible components are installed qualify.

## Error handling and security

- The source marker is an ownership-routing hint, not an authorization token.
- Only the exact trusted value `psyche-build` maps to the exact label.
- Invalid label payloads fail external registration without weakening daemon
  validation; Coven Code continues operating because ledger registration is
  best effort.
- Discovery failures retain only the last confirmed eligible active rows and
  preserve the existing global stale/unavailable message.
- A later successful refresh removes rows that completed while discovery was
  stale.

## Verification

### Coven

- External registration persists valid labels and returns them on list/read.
- Invalid, oversized, or malformed labels are rejected.
- Idempotent registration cannot rewrite an existing record's provenance.

### Coven Code

- Exact `COVEN_SESSION_SOURCE=psyche-build` emits
  `source:psyche-build` during registration.
- Missing, empty, or unknown values emit no source label.
- Completion behavior remains unchanged.

### Psyche Build

- Native chat launch includes the source environment marker.
- Discovery normalization preserves labels.
- Only exact-label sessions with `starting`, `running`, or `waiting` render.
- Search cannot reveal completed or foreign sessions.
- Completed rows disappear after refresh; stale eligible rows remain visible
  with the existing global stale status.
- Native chat/attach remains outside tmux and daemon mutation paths.

Packaged acceptance opens a project in Psyche, creates a Coven Code session,
confirms the active labeled row appears, then completes it and confirms the row
disappears. A concurrently active session launched outside Psyche for the same
project must never appear.
