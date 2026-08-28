# Coven Code Picker Launch

**Date:** 2026-08-20
**Status:** Approved

## Goal

Selecting **Coven Code** from the terminal/TUI new-pane picker must launch the
current Coven CLI in code mode. It must not launch the retired `coven-code`
binary or enter the Codex-specific launch path.

## Required Behavior

The stable agent registry ID remains `coven-code`, but a new TUI pane launches:

```text
coven code --session-id <generated UUID>
```

Existing permission flags and prompt delivery follow that command. For example:

```text
coven code --session-id <generated UUID> --permission-mode plan
coven code --session-id <generated UUID> "$PSYCHE_PROMPT_CONTENT"
```

The generated session ID is unique per new Coven Code pane. Codex remains a
separate registry entry and continues launching `codex`.

## Architecture

Update the `coven-code` registry entry so installation detection resolves the
`coven` executable and its static command base is `coven code`. Keep the
registry ID, display name, slug suffix, permission modes, prompt transport, and
default-enabled status unchanged.

Extend the shared command builders with an optional launch context containing a
validated Coven session ID. The builders append
`--session-id <generated UUID>` only when the selected agent is `coven-code`.
Callers that do not provide a launch context retain the static `coven code`
command.

`launchAgentInPane` generates one UUID for each new Coven Code pane and passes
that same value through the no-prompt, prompt-file, and escaped-inline command
paths. It does not generate a Coven session ID for any other agent.

The existing Codex hook wrapper remains guarded by `agent === "codex"`.
Changing the Coven executable must not make Coven Code consume Codex hooks,
resume commands, or command metadata.

## Data Flow

```text
select Coven Code in terminal new-pane picker
  -> stable agent ID coven-code
  -> create pane/worktree
  -> launchAgentInPane
  -> generate one UUID
  -> shared command builder receives Coven launch context
  -> execute coven code --session-id <UUID> [permission flags] [prompt]
```

Selecting Codex remains:

```text
select Codex
  -> stable agent ID codex
  -> existing Codex hook setup
  -> execute wrapped codex command
```

## Error Handling

Agent discovery must report Coven Code as installed only when the `coven`
executable is available through the existing shell or common-path checks.

UUID generation uses Node's `randomUUID`. If command construction receives an
invalid or missing session ID, it must not emit a partial `--session-id` flag.
The new-pane launch path always supplies a generated UUID.

Existing pane-creation and command-dispatch errors remain visible through the
current status and logging paths. The Coven Code selection must not recover by
launching `coven-code`, Codex, another agent, or a bare shell.

## Verification

Focused automated coverage must prove:

- the `coven-code` registry entry detects `coven`, not `coven-code`;
- its static base and resume commands use `coven code`;
- command builders place one supplied session ID after `coven code`;
- prompted and no-prompt TUI launches use the same generated session ID;
- permission flags and prompt-file safety remain intact;
- UUID generation occurs once per Coven pane and never for other agents;
- Coven Code does not receive Codex hook environment wrapping; and
- Codex launch behavior remains unchanged.

Run the focused agent registry and pane-launch Vitest suites, followed by the
repository test typecheck for the touched TypeScript signatures.

## Scope

This patch changes only terminal/TUI agent discovery and new-pane command
construction. It does not change the native macOS desktop picker, Coven daemon
attachment, pane persistence, worktree creation, other agent launchers, or the
stable `coven-code` configuration ID.
