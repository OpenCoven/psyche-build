# Terminal and Agent Shortcuts Design

**Date:** 2026-08-10
**Status:** Approved

## Goal

Separate terminal creation from coding-agent creation in the macOS Psyche app:

- Command-T always creates a plain terminal pane.
- Command-P opens an agent picker.
- The picker offers Coven Code, Copilot CLI, Codex CLI, Anthropic CLI, and
  Grok Build, with Coven Code selected by default every time.

## Product decisions

1. **Command-T is global.** It creates a plain login-shell pane in the active
   project and selected worktree even when an embedded browser webview has
   focus. It is no longer contextual.
2. **Command-P owns agent creation.** It opens a dedicated, keyboard-first
   in-app picker rather than reusing the general command palette or a native
   macOS dialog.
3. **Coven Code is always the default selection.** The picker does not remember
   the previous choice.
4. **All choices stay visible.** Psyche does not hide agents that are absent
   from the current `PATH`. A failed launch names the missing CLI and remains
   visible as a failed or exited pane.
5. **No silent fallback.** Selecting a missing CLI never launches Coven Code or
   another agent instead.
6. **Automatic project startup remains unchanged.** Opening or activating a
   project that needs its default agent still uses the existing Coven Code
   startup behavior. The new shortcuts only change manual pane creation.

## Scope

This design owns:

- Command-T and Command-P handling in the main Tauri webview;
- the embedded browser shortcut bridge needed to make Command-T global;
- a dedicated agent picker overlay;
- exact agent labels and launch descriptors;
- rail-menu, empty-state, and help-overlay labels that describe the new
  behavior;
- launch error feedback; and
- focused regression tests for the shortcut and picker contract.

It does not:

- change the existing general command palette on Command-K;
- add agent installation or package management;
- persist a preferred or last-used agent;
- change Coven session discovery or attachment;
- change automatic project startup from Coven Code;
- change the CLI/TUI agent picker; or
- add a new cross-platform shortcut abstraction.

## User experience

### Creating a terminal

Pressing Command-T from any Psyche surface creates a new plain login-shell pane
in the active project and selected worktree. The new pane uses the existing
shell-thread creation path, becomes visible on the terminal canvas, and
receives focus.

If an embedded browser webview owns focus, its injected shortcut handler
prevents the browser's default new-tab action and emits an event to the main
webview. The main webview handles that event by creating the same login-shell
pane. Browser tabs remain available through the browser tab controls.

### Choosing an agent

Pressing Command-P opens a centered in-app picker above the workspace. The
picker contains these entries in this order:

| Label | Launch |
| --- | --- |
| Coven Code | resolved Coven executable with `chat` |
| Copilot CLI | `copilot` |
| Codex CLI | `codex` |
| Anthropic CLI | `claude` |
| Grok Build | `grok` |

Coven Code is highlighted whenever the picker opens. Up and Down move the
highlight, Enter launches the highlighted agent, Escape dismisses the picker,
and clicking an entry launches it. Opening the picker while it is already open
restores focus to it and resets the highlight to Coven Code.

Choosing an agent closes the picker and creates a new pane in the active
project and selected worktree. The pane uses an agent-specific title and kind
so the canvas and session rail identify what is running.

### Other launch surfaces

The new-pane menu and terminal empty state expose separate Terminal and Agent
actions:

- Terminal calls the same login-shell creation function as Command-T.
- Agent opens the same picker as Command-P.

The keyboard-shortcuts overlay describes Command-T as a new terminal pane and
Command-P as the agent picker. No click surface keeps the old behavior where
an Agent action immediately launches Coven Code without selection.

## Architecture

### Shortcut routing

Replace the contextual Command-T helper with a global terminal helper:

```text
Command-T
  -> createTerminalPane()
  -> showTerminalView()
  -> spawnShellThread(active project, selected worktree)
```

Command-P routes to the picker:

```text
Command-P
  -> openAgentPicker()
  -> reset selection to Coven Code
  -> focus picker
```

The main document listener continues to accept Command on macOS and Control as
the existing compatibility modifier. It prevents default behavior only after
the matching Psyche action is accepted.

The embedded browser injection changes its Command-T event from
`browser:shortcut-new-tab` to a terminal-specific event. The main webview
listener calls `createTerminalPane()` so browser and main-webview shortcuts
share one implementation.

### Agent registry

Add a small fixed registry in the native web client. Each entry contains:

```text
{
  id,
  label,
  command,
  args,
  threadKind,
  threadName
}
```

Coven Code is the only special resolver. It uses the already discovered
`state.env.coven_path` and `["chat"]`. The other entries use their executable
name and no initial arguments.

The registry is the single source for picker rendering and launch mapping.
Menu labels and help text may reference the picker but must not duplicate
command-building logic.

### Thread creation

Add `spawnAgentThread(agentId, project)` alongside the existing Coven and shell
helpers. It:

1. resolves the registry entry;
2. verifies that a project and selected worktree exist;
3. switches to the terminal view;
4. builds a launch descriptor with the selected worktree as `cwd`;
5. calls the existing `createThread` path; and
6. focuses the new pane through existing pane-tree behavior.

The launch descriptor is retained on the thread, preserving existing retry
behavior. Agent kinds remain non-shell kinds so the session rail continues to
group them under Agents.

The existing automatic `ensureProjectCoven` and Coven attachment flows remain
separate. They continue to create `coven-chat` and `coven-attach` threads.

### Picker component

The picker is plain HTML, CSS, and JavaScript inside the existing unbundled
main webview. It uses:

- a dialog container with `role="dialog"` and an accessible name;
- a listbox with one option per registry entry;
- one selected option reflected through `aria-selected`;
- focus containment for picker navigation keys; and
- the existing overlay visual language where practical.

The picker owns only open state and selected index. It delegates launches to
`spawnAgentThread` and does not know about PTY implementation details.

## Error handling

If there is no active project or selected worktree, terminal creation and agent
selection show the existing project-required feedback and do not create an
orphan thread.

If Coven Code is selected without a resolved Coven executable, Psyche shows the
existing Coven installation message and creates no thread.

For Copilot, Codex, Claude, or Grok, the existing PTY start path remains the
source of truth for executable launch failure. The thread remains represented
in its failed or exited state, and the web client adds a clear status or toast
that names the selected CLI. The failure is not swallowed and does not launch
a different command.

The picker closes after a valid selection request. If launch setup fails before
a thread can be created, focus returns to the prior workspace surface and the
error remains visible in status chrome.

## Testing

Extend the Tauri desktop source-contract tests to cover:

- Command-T calls the shell creation path and no longer calls the contextual
  browser-tab path;
- the embedded browser Command-T bridge emits the terminal shortcut event;
- Command-P opens the agent picker;
- Coven Code is first and selected whenever the picker opens;
- Up, Down, Enter, Escape, and click behavior;
- the exact five labels and launch mappings;
- selected worktree `cwd` propagation;
- the absence of preference persistence or last-agent restoration;
- missing Coven and missing executable feedback;
- new-pane menu, empty-state, and help-overlay labels; and
- automatic project startup still calls `ensureProjectCoven`.

Retain the existing pane lifecycle and Tauri shortcut suites as regression
coverage. Run the smallest Vitest selectors that cover the changed native
desktop contracts, then the native web build to ensure the unbundled source and
generated bundles remain valid.

## Acceptance criteria

1. Command-T creates a plain login-shell pane from the terminal, editor,
   sidebar, dock, or embedded browser.
2. Command-T never creates a browser tab.
3. Command-P opens the agent picker with Coven Code selected.
4. The picker offers exactly Coven Code, Copilot CLI, Codex CLI, Anthropic CLI,
   and Grok Build.
5. Each choice launches the documented command in the active selected
   worktree.
6. Missing CLIs produce explicit feedback without fallback.
7. The new-pane menu, empty state, and help overlay match the shortcut
   behavior.
8. Automatic project startup continues to use Coven Code.
