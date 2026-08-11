# TUI Image Drop and Coven Interrupt State Design

**Date:** 2026-08-10
**Status:** Approved design

## Goal

Improve native macOS terminal-pane input in two ways:

- dragging one or more images from Finder onto a live terminal pane inserts
  shell-safe absolute file paths into that pane's current TUI input; and
- pressing Ctrl+C while Coven is working allows Psyche's attention state to
  return to **Waiting for you** after Coven redraws and settles at its prompt.

## Product decisions

1. Image drops work in every live terminal pane, including Coven, other agent
   panes, and plain shells.
2. A drop inserts paths only. It does not submit the input, read image bytes,
   upload files, copy files into the project, or use an agent-specific
   attachment protocol.
3. Multi-file drops insert every supported image in the original drop order.
   Unsupported files are skipped and reported.
4. Inserted paths are absolute and POSIX single-quote escaped.
5. Native Tauri window drag/drop events are the source of truth. Browser
   HTML5 drag/drop is not used for filesystem paths.
6. Ctrl+C is an interrupt, not an ordinary answer. It clears stale attention
   but immediately re-arms settled-tail observation.
7. Interrupting Coven does not change the PTY lifecycle status. The process
   remains `running`; **Waiting for you** is an attention state shown after the
   interrupted prompt settles.

## Scope

This design owns:

- native file drag/drop handling in the main Tauri webview;
- mapping drop coordinates to a terminal pane;
- image extension filtering and path quoting;
- drop-target feedback and invalid-drop warnings;
- writing dropped paths through the existing PTY input path;
- interrupt-aware local-pane attention tracking; and
- focused regression tests for both behaviors.

It does not:

- render images inside xterm;
- upload images or transmit their bytes through Psyche;
- copy dropped images into a worktree;
- add a file picker or clipboard-image flow;
- change browser-pane drag/drop;
- change Coven's process lifecycle or daemon session status; or
- add drag/drop to the Ink CLI interface, which has no native pointer drop
  surface.

## Image drop interaction

### Targeting

The main webview registers one listener through
`currentWindow.onDragDropEvent`. Tauri reports physical window coordinates, so
the handler converts them to CSS coordinates using the current window scale
factor before querying the document.

The element under the pointer is resolved to its nearest
`.terminal-pane[data-thread-id]`. A valid target must identify a thread that:

- exists in `state.threads`;
- is not a Web pane;
- is not closing or close-started; and
- has `status === "running"` with a started PTY.

Drag enter and over events update a single current target. Drag leave, drop,
window blur, and invalid coordinates clear it.

### Feedback

The current valid pane receives an image-drop target class and a compact
overlay reading **Drop images to insert paths**. Moving over the editor,
sidebar, Web pane, empty canvas, or a dead terminal clears the highlight.

The feedback is informational only and does not intercept normal pane
repositioning, pointer focus, or terminal keyboard input.

### Filtering

Tauri supplies absolute filesystem paths. Psyche filters them by
case-insensitive extension because the native event does not provide a
portable MIME type.

Supported extensions are:

- `.png`
- `.jpg` and `.jpeg`
- `.gif`
- `.webp`
- `.avif`
- `.heic` and `.heif`
- `.tif` and `.tiff`
- `.bmp`
- `.svg`

The original order is preserved. A mixed drop inserts all supported images and
shows a warning with the number of skipped paths. A drop with no supported
images writes nothing and shows a warning.

### Path formatting and insertion

Each accepted absolute path is POSIX single-quote escaped. An apostrophe inside
a path is represented with the standard shell-safe `'\''` sequence. Multiple
quoted paths are joined with one space.

The resulting text is sent without a trailing newline through the existing
`pty_write` command for the target thread. Psyche focuses the target pane
before writing, so subsequent keyboard input continues in the same TUI.

The drop path does not call the composer, does not alter the clipboard, and
does not synthesize Enter.

## Coven interrupt attention state

### Existing distinction

Psyche tracks two independent concepts:

- PTY lifecycle status, such as `starting`, `running`, `failed`, or `exited`;
  and
- local attention state, such as **Needs your answer** or
  **Waiting for you**.

Ctrl+C does not end a healthy Coven PTY, so lifecycle status remains
`running`.

### Interrupt transition

Terminal input routing distinguishes an interrupt byte (`\x03`) from ordinary
user input.

Ordinary user input keeps the existing behavior: it clears attention and
disarms detection until the agent changes the rendered terminal tail. This
prevents an answered question from immediately re-badging itself.

An interrupt instead:

1. clears any stale attention reason;
2. marks the session as having relevant activity;
3. leaves settled-tail detection armed; and
4. sends `\x03` to the PTY unchanged.

When Coven redraws from its working screen to its prompt, the changed tail
resets the settle timer. Once that prompt remains stable for the existing
settle interval and no working indicator remains, the normal classifier marks
the pane **Waiting for you**.

Both physical Ctrl+C received through xterm `onData` and the existing
context-menu **Interrupt** action use the same transition. Shell panes remain
excluded from attention tracking, so Ctrl+C at a shell prompt never creates a
waiting badge.

### Exit behavior

If Ctrl+C actually causes the process to exit, the existing `pty:exit` path
wins. It clears attention and marks the pane `exited`; an exited pane must
never display **Waiting for you**.

## Components

### Native drop controller

The drop controller owns subscription, coordinate conversion, target
resolution, target styling, cleanup, and dispatching a completed drop. It
depends on `currentWindow`, the existing thread registry, and the existing
focus and status helpers.

### Pure image-path helpers

Small pure helpers own:

- supported-extension detection;
- stable filtering;
- POSIX single-quote escaping; and
- construction of the final insertion string.

They do not access the DOM, Tauri, xterm, or global application state.

### PTY input routing

The existing PTY writer remains the only transport. A small shared input
helper applies the correct attention transition before encoding and invoking
`pty_write`, allowing xterm typing, context-menu interruption, and dropped
paths to use consistent error handling.

Dropped paths count as ordinary user input for attention purposes. They clear
an existing badge and wait for agent output before another badge can appear.

### Attention tracker

`createAttentionTracker` adds an explicit interrupt operation alongside
`userInput`, `bell`, `clear`, and `forget`. The operation is generic for agent
panes, while the shell's existing eligibility filter prevents false shell
attention.

## Error handling

- Failure to register the native drag/drop listener is shown through the
  existing status UI and logged for diagnostics.
- Failure to obtain the scale factor clears the current target and reports the
  error instead of guessing coordinates.
- A drop outside a valid live terminal pane sends nothing.
- A drop with no supported image sends nothing and shows a warning.
- A mixed drop inserts valid images and reports the skipped count.
- A `pty_write` failure is surfaced in the target terminal using the existing
  input error style. It is not treated as a successful insertion.
- Drag-target classes are removed in success and failure paths.
- Interrupt handling never swallows or rewrites the `\x03` byte.

## Testing

Focused Vitest coverage will verify:

- native drag/drop subscription;
- physical-to-CSS coordinate conversion;
- terminal-pane targeting from `data-thread-id`;
- rejection of Web, missing, closing, starting, failed, and exited threads;
- case-insensitive supported-extension filtering;
- stable ordering for multiple images;
- POSIX quoting for spaces and apostrophes;
- insertion without a newline;
- focus transfer before PTY writing;
- mixed and invalid drop warnings;
- target cleanup on leave, drop, blur, and errors;
- ordinary input retaining its current disarmed attention behavior;
- interrupt input clearing stale attention while remaining re-armed;
- a settled post-interrupt Coven prompt becoming **Waiting for you**;
- xterm Ctrl+C routing through the interrupt transition;
- context-menu **Interrupt** using the same path; and
- process exit clearing attention instead of producing a waiting state.

The existing pane lifecycle, Coven launch, and session attention suites remain
regression coverage.

## Acceptance criteria

1. Dropping a supported image from Finder onto any live terminal pane inserts
   its quoted absolute path at the current TUI cursor.
2. Dropping multiple images inserts every supported path in original order,
   separated by spaces.
3. No drop automatically presses Enter.
4. Unsupported files are not inserted and produce clear feedback.
5. Web panes and non-running terminal panes never receive dropped paths.
6. Drag feedback follows the pane under the pointer and always clears after
   the drag ends.
7. Ctrl+C reaches Coven unchanged.
8. After Coven returns to a stable prompt following Ctrl+C, its attention
   state becomes **Waiting for you** while its PTY status remains `running`.
9. If Coven exits, the pane shows `exited` and no waiting attention state.
