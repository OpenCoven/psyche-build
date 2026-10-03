# Agent prompt transport

Status: current as of #523. The registry (`AGENT_REGISTRY` in `src/utils/agentLaunch.ts`) is the source of truth. This note records why each agent uses its transport.

AGENTS.md treats raw prompts as protected data. Every launch path keeps the prompt off the typed line and out of the argv of every process Psyche spawns: `launchAgentInPane`, the bridge spawn, the conflict-resolution pane, and MergePane. Before #523, two gaps remained:

1. The `positional` and `option` transports read the prompt file into `$PSYCHE_PROMPT_CONTENT`, then expand it into the agent's argv (`claude "<prompt>"`). The prompt is visible in `ps` to any same-user process for as long as the agent runs.
2. The `send-keys` transport (cline, crush) loaded its tmux buffer with `tmux set-buffer -- '<prompt>'` through `/bin/sh -c`. The prompt was briefly in the argv of `sh` and `tmux`. It was also written to the debug log whenever that command failed.

## Transports

| Transport | Prompt path | In agent argv? |
|---|---|---|
| `send-keys` | The agent is launched bare. Once it holds the foreground, the prompt goes to tmux on stdin (`load-buffer -b <name> -`), then `paste-buffer -d -p -b <name> -t <pane>` pastes it and deletes the buffer in one command. The configured submit keys follow. | No. It is in no argv: not tmux's, not a shell's, not the agent's. |
| `stdin` | The pane's shell reads the 0600 prompt file and deletes it, then runs `printf '%s\n' "$PSYCHE_PROMPT_CONTENT" \| agent`. | No. `printf` is a builtin in sh, bash, zsh, dash, ksh93, ash, yash and fish. The exception is an mksh build without the builtin, where `/usr/bin/printf` holds the prompt in its argv for the instant it runs. |
| `launch-only` | No initial prompt is delivered. | n/a |
| `positional` / `option` | The pane's shell reads and deletes the prompt file, then expands the prompt into the agent's argv. | **Yes, for the agent's lifetime.** Each such entry must carry `promptArgvExposure`; module load fails without it. |

## The paste path (`send-keys`)

`sendPromptViaTmux` in `src/utils/agentPromptDispatch.ts` works as follows.

- **No argv exposure.** `TmuxService.loadBufferFromStdin` runs `execFile('tmux', ['load-buffer', '-b', name, '-'])` and writes the prompt to the child's stdin. No shell runs. stdin has an `error` listener, so if tmux exits before reading everything (EPIPE) the call rejects with `tmux load-buffer failed` instead of crashing the process with an uncaught exception. Errors are reduced to `tmux <subcommand> failed`, so a failure cannot echo the content. `setBuffer` has been removed.
- **Buffer lifetime.** The buffer name is random (`psyche-prompt-<ms>-<12 hex>`). `paste-buffer -d` deletes it as part of the paste. If the load or the paste fails, `delete-buffer` runs, its own failure is ignored, and the prompt is reported as skipped (`prompt_paste_failed`). Submit keys are not sent.
- **Bracketed paste.** `-p` wraps the paste in bracketed-paste markers only when the program in the pane has enabled that mode. Without the markers, tmux turns each LF into CR, which most TUIs treat as Enter, so every line would be submitted on its own. For a prompt that contains a newline, Psyche therefore reads `#{bracket_paste_flag}` first. If the flag is not `1` (this includes a read failure, or an older tmux without the format), nothing is pasted and the result is `prompt_paste_unsafe_multiline`. A single-line prompt does not need the flag.
- **Readiness, bounded and never blind.** The pane's shell is read **before** the launch line is sent and is used as the baseline. This holds for every caller, including the bridge, which used to read it afterwards, when it could already be the agent. The paste waits up to 5 s, polling `#{pane_current_command}`, for the agent's process name or for a non-shell command that differs from the baseline. A known shell name (any POSIX shell, fish, nu, tcsh, and others, including `-zsh` and full paths) or `tmux` never counts as the agent unless it equals the expected command. This means an agent that crashed back to its shell is not mistaken for a changed foreground, and the exit recorder's brief `tmux set-option` does not count as ready either. If readiness is never seen, nothing is typed and the result is `agent_not_ready`. The old code fell through after the timeout and pasted anyway, so the shell would run the prompt as commands.
- **Earlier commands must finish first (conflict pane).** The conflict pane types `cd`, `git merge --abort` and `git merge … || true` before the agent's launch line. A merge or post-merge hook that is still running (`git`, `node`, `npm`) is a non-shell foreground that differs from the baseline, so it would pass readiness. The paste would then queue behind the launch line, and if the agent were missing the shell would run it. For paste agents, the pane therefore waits up to 15 s for its foreground to be the baseline shell again before the launch line is typed. Any foreground change after that point belongs to the launch line. If the shell does not come back in time, the agent is still launched, without the prompt, and `agent_not_ready` is reported. The other launch paths type into a fresh pane whose shell is confirmed just before launch, so they need no extra wait.
- **Re-checked through the whole sequence.** The foreground is read again after `sendKeysReadyDelayMs`, immediately before `paste-buffer`, and immediately before each submit key. If the agent has gone at any of these points, no submit key is sent and the buffer is deleted. Whatever already reached the line is then discarded: `C-c` when the foreground is confirmed to be a shell, because it drops the whole edit buffer, including a bracketed multi-line paste that zsh holds as one buffer; `C-u` otherwise, where `C-c` could interrupt an unknown program. The result is `agent_not_ready`.
- **The multi-line check comes first.** It runs before any pre-prompt keys (crush's `Escape`, `Tab`), so a withheld prompt sends the agent nothing.
- **Reporting.** `agent_not_ready`, `prompt_paste_failed` and `prompt_paste_unsafe_multiline` join the closed `PromptBootstrapSkipReason` set. They surface through the existing channels: `initial_prompt_skipped` on the bridge (a durable-effect warning), and a log line plus toast in the TUI paths. Messages are built from the agent id and the reason only, never from the prompt.

Readiness is process-level, not screen-level. Psyche knows the agent process holds the foreground, but not that its input box has focus. That gap is why no other agent was moved to this transport (see below).

## Remaining risks

- **Check-to-key gap.** A gap of one tmux round-trip, a few milliseconds, remains between the final foreground read and `paste-buffer`, and between that read and each submit key. An agent that exits inside that gap gets the paste or the key in front of its shell. The re-checks make this window small, but they cannot close it, because tmux has no "paste only if the foreground is still X" operation.
- **sh and dash after a mid-paste exit.** If the agent exits inside that gap during a multi-line paste and the pane's shell is `sh` or `dash`, which have no bracketed-paste-aware line editor, the shell reads each pasted line as it arrives. Lines that end before the exit is noticed may already have run, and `C-c` discards only what is still pending. zsh, bash and fish hold a bracketed paste as one edit buffer until Enter.
- **Process-level readiness.** See the next section.

## Per-agent record

Sources were checked for #523 without running any agent binary: published docs and READMEs, upstream source on each project's default branch as of 2026-10-02, and package files on disk. Bracketed-paste observations come from searching installed binaries for the `ESC[?2004h` enable sequence, not from running them.

| Agent | Transport now | (a) File flag for the initial interactive prompt | (b) Stdin while staying interactive | (c) Paste into the TUI after launch | Decision |
|---|---|---|---|---|---|
| claude | positional (argv) | None. `--system-prompt-file` and `--append-system-prompt-file` set the system prompt, not the first message. `@path` in a prompt attaches the file content as context, and the file must exist when the prompt is submitted. [CLI reference](https://code.claude.com/docs/en/cli-reference), [common workflows](https://code.claude.com/docs/en/common-workflows) | Documented only with `-p`, which is non-interactive ([headless](https://code.claude.com/docs/en/headless)) | Pastes over 800 chars or 3 lines collapse to `[Pasted text #N]`, and Enter submits ([terminal config](https://code.claude.com/docs/en/terminal-config)). The installed 2.1.288 binary enables bracketed paste once its input attaches. | **Argv kept.** A paste would race the workspace-trust dialog that Psyche auto-answers (`autoApproveTrustPrompt`). |
| opencode | option `--prompt` (argv) | None (`run --file` attaches) | In source, piped stdin becomes the TUI's initial prompt ([`packages/opencode/src/cli/cmd/tui.ts:59-63`](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/tui.ts)). This is undocumented, and how keyboard input works after stdin EOF is unverified. | `[Pasted ~N lines]` placeholder in source (`packages/tui/.../prompt/index.tsx`). The installed binary contains the bracketed-paste enable sequence. | **Argv kept.** The stdin path is the best candidate but needs verification against a real TUI. |
| codex | positional (argv) | None. `codex exec -` reads stdin but is non-interactive ([CLI docs](https://learn.chatgpt.com/docs/developer-commands?surface=cli)). | No. The TUI refuses a non-terminal stdin ([`codex-rs/tui/src/tui.rs:462`](https://github.com/openai/codex/blob/main/codex-rs/tui/src/tui.rs)). | Handles bracketed and unbracketed paste (`chat_composer.rs`, placeholder above 1000 chars). The installed binary emits `ESC[?2004h`. | **Argv kept.** Paste is untested against its startup screens. |
| cline | **send-keys (paste)** | None documented ([CLI reference](https://docs.cline.bot/cline-cli/cli-reference)) | `echo prompt \| cline` is documented, but not whether it stays interactive | Already the registry transport | **Argv-free.** Now pasted through a stdin-loaded buffer. |
| gemini | option `--prompt-interactive` (argv) | None. `@path` injects file content at submit time ([commands](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/commands.md)), so the file would have to outlive submission. | No. `-i` with piped stdin exits with an error ([`packages/cli/src/gemini.tsx`](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/gemini.tsx)). | `[Pasted Text: N lines]` above 5 lines or 500 chars (`text-buffer.ts`) | **Argv kept.** Paste is unverified. |
| qwen | option `-i` (argv) | Same as gemini (fork) | No. Same error ([`packages/cli/src/llm.tsx`](https://github.com/QwenLM/qwen-code/blob/main/packages/cli/src/llm.tsx), `integration-tests/interactive/mixed-input-crash.test.ts`). | Placeholder above 1000 chars or 10 lines (`InputPrompt.tsx`) | **Argv kept.** Paste is unverified. |
| amp | stdin | None (`--attach` uploads a file) | **Yes.** "If you pipe input to the CLI, it uses the input as the first user message in interactive mode", as long as stdout stays a terminal ([Amp CLI docs](https://ampcode.com/docs/cli), [execute mode](https://ampcode.com/docs/cli/execute-mode)) | Image paste only documented | **Argv-free already.** The prompt is piped from a shell builtin. |
| pi | positional (argv) | **Yes.** `pi @file` includes the file "in the first prompt" ([`docs/cli.md`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/cli.md)). But `file-processor.ts` wraps it as `<file name="ABS">…</file>` and reads it at startup. | No. Redirecting stdin or stdout switches to print mode (`docs/cli.md`). | Not documented | **Argv kept, candidate.** `@file` changes the prompt the model sees (wrapper plus absolute path), and the file must outlive startup, which breaks read-and-delete. |
| cursor | positional (argv) | None. `@` adds files to context ([Cursor CLI](https://cursor.com/docs/cli/using)). | Not documented | Not documented | **Argv kept.** No documented alternative. |
| copilot | option `-i` (argv) | None. `@FILE` adds file content to context, and `--attachment` works only with `-p` ([command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)). | No. A piped prompt is handled like `-p` ([changelog](https://github.com/github/copilot-cli/blob/main/changelog.md) v1.0.78). | `[Paste #N - X lines]`, with large pastes saved to files (changelog) | **Argv kept.** Paste is unverified. |
| crush | **send-keys (paste)** | Interactive `crush` takes no prompt argument ([`internal/cmd/root.go`](https://github.com/charmbracelet/crush/blob/main/internal/cmd/root.go)) | Only `crush run` reads stdin, and it is non-interactive | Already the registry transport | **Argv-free.** Now pasted through a stdin-loaded buffer. |
| coven-code | launch-only | Unknown (no public docs) | Unknown | Unknown | **No prompt delivered.** |

## Why the argv agents were not switched to paste

The paste path is argv-free and bounded, but its readiness signal only proves that the agent process holds the foreground. Several of these agents can show a startup screen first, such as a workspace or folder trust question, sign-in, or an update notice. A paste followed by Enter would land on that screen instead of the prompt box. The prompt would be silently lost, and the Enter could confirm a choice on the operator's behalf. AGENTS.md forbids weakening confirmation, and no real agent may be run to rule this out. Each such agent therefore keeps its argv transport, recorded in `promptArgvExposure`. A test pins the exact set of argv-exposing agents (`__tests__/agentPromptArgv.test.ts`).

Possible next steps, each needing verification against the real CLI:

- **opencode:** pipe the prompt file on stdin (`opencode < file`), and confirm the TUI keeps reading keys from the terminal.
- **pi:** use `@/dev/fd/N` on an already-opened, already-unlinked file, so read-and-delete survives. Also decide whether the `<file>` wrapper is acceptable.
- **Every argv agent:** add screen-level readiness, meaning a positive check that the input box is focused, before moving it to `send-keys`.

## MergePane

`launchMergeConflictAgent` (`src/utils/mergeConflictAgentLaunch.ts`) runs claude and then opencode directly in Psyche's own terminal through `/bin/sh -c`. There is no tmux pane, so the paste transport cannot apply. Both agents keep their argv transport for the reasons above.

## Tests

- `__tests__/agentPromptArgv.test.ts` runs every registry agent through `launchAgentInPane` with a fake tmux. It executes the typed line under a confined PATH where every agent name resolves to a fake script that records its argv and stdin. It asserts:
  - the prompt is in the agent's argv exactly for the recorded set;
  - stdin and paste agents receive the exact prompt;
  - no tmux argument carries the prompt;
  - no buffer or prompt file is left behind.
- `__tests__/agentPromptDispatch.test.ts` covers:
  - the paste sequence and bounded, never-blind readiness;
  - shell and `tmux` foregrounds never counting as the agent, including a baseline sampled after launch;
  - an agent exiting during the delay, before the paste, or between submit keys (no Enter, buffer deleted, `C-c` in a confirmed shell, `C-u` otherwise);
  - a withheld multi-line prompt sending no pre-prompt keys;
  - `waitForShellForeground`, bounded;
  - the multi-line bracketed-paste guard;
  - buffer deletion when the load or paste fails.
- `__tests__/tmuxServiceStdin.test.ts` uses a PATH shim for `tmux` that exits immediately against a 4 MB prompt. It checks for a bounded rejection and no uncaught EPIPE.
- `__tests__/daemon/spawnPromptTransport.test.ts` checks that the bridge reads the paste baseline before it sends the launch line.
- `__tests__/conflictResolutionPane.test.ts` holds a merge-phase foreground of `git` or `node` and checks that no paste happens and the agent launches bare with `agent_not_ready`. It also checks that the paste does happen once the shell is back.
- `__tests__/tmuxServiceSecurity.test.ts` checks that `load-buffer` gets the content only on stdin, that `paste-buffer -d -p` is used, and that no shell is involved.
- `__tests__/agentPromptPaste.tmux.test.ts` drives a real tmux server on a private `-S` socket through a PATH shim, with a fake `cline`, a node script so the pane shows a non-shell foreground. It checks that the prompt reaches the agent's terminal, is in neither argv, and leaves no buffer. The test is skipped when tmux is unavailable.
