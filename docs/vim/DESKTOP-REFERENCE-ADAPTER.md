# Desktop reference Vim adapter — contract

**Status:** Contract definition (adapter wiring not yet implemented on `main`)
**Owner:** OpenCoven/psyche-build#223 — Vim Slice 1: shared contract and desktop reference (Bead `psyche-no8.1`)
**Canonical outcome:** [#246 — Deliver post-release cross-platform Vim and keyboard-mode parity](https://github.com/OpenCoven/psyche-build/issues/246)
**Parent:** [#222 — Comprehensive opt-in Vim support across Psyche](https://github.com/OpenCoven/psyche-build/issues/222) (Bead `psyche-no8`)
**Design:** [Comprehensive Vim Support Design](../superpowers/specs/2026-08-12-comprehensive-vim-support-design.md)
**Acceptance contract:** `docs/vim/ACCEPTANCE-MATRIX.md` and `src/vim/acceptanceManifest.ts` (Vim Slice 5, #227 — these files land on `main` with that slice; the item ids below are aligned with them)

## Purpose and current state

This document is the terminal-safe adapter contract that the desktop Tauri
app implements when the desktop Vim slice lands. It is the reference every
other platform slice (#224 web, #225 Ink, #226 iOS) reads before diverging:
where the desktop adapter is forced to make a platform choice, that choice is
written down here first.

What this shared-contract slice establishes:

- The shared, platform-pure semantic core
  [`packages/vim-core`](../../packages/vim-core/src/index.ts)
  (`@opencoven/psyche-vim-core`): key normalization, the chrome navigation
  machine, and the editor state machine with bounded registers, marks,
  search, macros, and Ex handling.
- The versioned shared fixture set
  [`protocol-fixtures/vim/v1/`](../../protocol-fixtures/vim/v1/README.md)
  with its fail-closed loader (`parseVimFixtureDocument`), replayed against the
  real machines by `__tests__/vimFixturesV1Conformance.test.ts`.

What this slice does **not** implement, and therefore claims nowhere:

- The desktop adapter wiring itself (chrome executor, settings keys, mode
  indicator, CodeMirror document port, Playwright coverage). Until that slice
  executes its checklist, every desktop acceptance item is `not-run`.

## Architecture: pure core, thin adapter

The desktop app owns input capture, focus, rendering, and consequences. The
core owns none of them. The split is fixed:

| Concern | Owner | Seam |
| --- | --- | --- |
| Key normalization, sequence state, semantic decisions | `@opencoven/psyche-vim-core` | `createChromeMachine`, `createEditorMachine` |
| Reading real keyboard events (DOM `KeyboardEvent`s) | Desktop adapter | `normalizeKeyboardEvent` |
| Moving DOM focus, panes, dialogs, help | Desktop adapter | Capability executors mapped from `VimAction`s |
| Terminal byte delivery | Desktop adapter | existing `term.onData -> sendToThread -> pty_write` route in `native/desktop/psyche-build-tauri/web/main.js` |
| Editor document mutation, undo, save | Desktop adapter port | `EditorDocumentPort` over CodeMirror state and the existing `saveFile`/`guardDirtyFiles`/`closeFileTab` seams |
| Consequential actions (save, close, merge, lifecycle) | Existing typed authority | never routed through Vim state |

The adapter must drive the shared editor machine; it must not embed a divergent
Vim implementation (no CodeMirror Vim plugin with its own keymap). Any behavior
the shared machine cannot express is a core contract change, not an adapter
hack.

## Byte-exact terminal passthrough outside chrome mode

Terminal bytes are opaque to Psyche. The xterm.js `onData` handler forwards to
`sendToThread` and the PTY unchanged; the adapter observes that route, it does
not wrap or rewrite it. With Vim mode disabled — and with Vim mode enabled but
outside chrome mode — terminal delivery must be byte-for-byte identical to the
product before this feature existed.

Acceptance must prove byte-exactness for at least these byte classes, using the
fixture harness and (later) the real-editor smoke protocol from the acceptance
matrix: printable input, `Esc`, control chords (`Ctrl-a`…`Ctrl-z`, `Enter`,
`Tab`), Alt/meta escape sequences, function keys including the configured
trigger, bracketed paste, IME committed text, mouse-mode reporting, and
randomized byte sequences.

Exactly two bounded exceptions exist, and only while Vim mode is enabled:

1. The configured trigger (default `F6`) is observed **before** terminal
   delivery, solely to enter chrome mode. When Vim mode is disabled, `F6` is
   delivered to the PTY like any other key (fixture: `chrome-disabled-passthrough`).
2. While chrome mode is active, keys the chrome machine classifies as consumed
   (`pending`/`action`/`unsupported`) are not sent to the PTY. Leaving chrome
   mode with `Esc` restores terminal delivery **without synthesizing an extra
   escape byte**; the `Esc` that exits chrome mode is consumed
   (fixture: `chrome-escape-exit`).

A pending or unsupported chrome sequence never falls through into the PTY or a
text input, and adapter-level exceptions (focus loss, modal opening, workspace
replacement, mode disable, disposal) reset pending state without replaying
consumed keys into the terminal (fixtures: `chrome-unsupported-consumed`,
`chrome-passthrough-unrelated-key`).

## F6 chrome navigation seam

`createChromeMachine({ enabled, trigger, timeoutMs, now })` is the single
entry seam:

- `enabled` is the persisted opt-in (`vimModeEnabled`, default `false`).
  Disabling must immediately reset pending state, exit chrome/editor command
  state, clear the visible `CHROME` indicator, and send nothing anywhere.
- `trigger` is configurable (`vimChromeTrigger`, default `F6`) because
  function-key availability varies by platform and layout; semantic commands
  are fixed in v1 and are not user-mappable.
- `timeoutMs` is the pending-sequence timeout (`vimSequenceTimeoutMs`, default
  `1000`, clamped to `250..3000`), evaluated against an injected clock so
  behavior is deterministic and testable.
- The machine's result discriminates `passthrough` (the adapter must deliver
  the returned original event to the focused surface), `pending`,
  `action` (execute the returned `VimAction`s), and `unsupported`. Only
  `passthrough` results carry an event; consumed keys are never replayable —
  this invariant is enforced by the result types themselves and exercised by
  the conformance suite.

Semantic actions map onto existing desktop seams — no parallel command path:

| `VimAction` | Desktop executor seam |
| --- | --- |
| `focus.move` / `focus.first` / `focus.last` / `focus.activate` | existing pane/rail focus functions in `web/main.js` |
| `pane.focus` / `pane.cycle` / `pane.split-horizontal` / `pane.split-vertical` / `pane.equalize` / `pane.resize` | existing pane layout functions |
| `search.open` / `search.next` / `search.previous` | existing browser-chrome search state |
| `target.close` / `target.refresh` | existing guarded close (`guardDirtyFiles`, receipts) and retry/refresh paths — capability-checked first |
| `help.open` | mode- and target-aware Vim help matching what the focused target actually supports |
| `chrome.enter` / `chrome.exit` | the persistent, accessible `CHROME` indicator and focus restoration record |

Every executor is capability-checked before it acts: a stale or absent target
produces a safe no-op with visible status, never a fallback write into a PTY.

## Embedded editor (CodeMirror) — practical parity matrix reference

The workspace file editor (`web/editor/editor-entry.js`, CodeMirror 6) is
driven through `createEditorMachine` and an `EditorDocumentPort` implemented
over CodeMirror transactions: `apply()` dispatches one atomic transaction per
machine turn, `command()` routes save/close/buffer/undo actions through the
existing guarded callbacks (`saveFile`, `guardDirtyFile(s)`, `closeFileTab`,
`activateFileTab`) without bypassing read-only, truncated, or binary checks.

"Practical parity" is deliberately bounded: v1 aims at the editing surface a
cockpit user actually needs in an embedded editor, proven by executable
fixtures — not at emulating all of Vim. The v1 parity matrix, with the fixture
sets that pin each row:

| Capability | v1 status | Fixture evidence |
| --- | --- | --- |
| Character/word/line motions with counts, `f`/`F`/`t`/`T`, `%`, paragraphs | Covered | `protocol-fixtures/vim/v1/motions.json` |
| Operator edits `d`/`c`/`y` with motions and text objects (`dw`, `ciw`, `dl`) | Covered | `protocol-fixtures/vim/v1/edits.json` |
| Registers (named, numbered, read-only `.`/`"`), linewise yank/paste | Covered | `edits.json` (`edit-delete-word-dw`, `edit-yank-line-yy`, `edit-yank-word-then-put`) |
| Insert/replace/open sessions with counts; committed IME text boundaries | Covered | `edits.json` (`edit-counted-insert-3i`, `edit-unicode-committed-text`) |
| Visual character/line/block selection and delete | Covered | `edits.json` (`edit-visual-character-delete`, `edit-visual-line-delete`, `edit-visual-block-delete`) |
| `J`, `>>`/`<<`, case operators (`g~w`) | Covered | `edits.json` |
| Undo through the host history port; `.` repeat | Covered | `edits.json` (`edit-undo-restores-via-port`, `edit-repeat-last-change-dot`) |
| Search `/`, `?`, `n`, `N`, `*` with bounded patterns and error consumption | Covered | `protocol-fixtures/vim/v1/search.json` |
| Bounded Ex: `:w`, `:wq`, `:q`, `:%s` (incl. confirm through the port), `:set`, `:b`, line goto, `:noh` | Covered | `protocol-fixtures/vim/v1/ex-commands.json` |
| Ex rejection (shell, pipes, `:g`, `:source`, filesystem args, unknown) — never executes shell code | Covered | `ex-commands.json` rejection traces |
| Macros (`q`/`@`), global (`A`–`Z`) marks, jump list, counts > 10 000 | Core-supported, fixture coverage to be extended with the adapter slice | `__tests__/vimEditorMachine.test.ts` on `main` |
| Folds, tags, window management, `.vimrc`/plugins/arbitrary mappings, `:g` | **Out of scope for v1** — rejected or unsupported, never approximated | `ex-commands.json` |

The matrix is a reference, not a substitute for the acceptance gate: the
desktop `embedded-editor-parity` item in the acceptance matrix requires the
golden editor scenarios to pass against **real CodeMirror state**, with the
dirty-state effects of `:w`/`:q`/`:q!` proven through the existing guards.
Extending fixture coverage for the rows marked "to be extended" belongs to the
slice that implements the adapter, in this same directory and version.

## How desktop acceptance will be recorded

Desktop acceptance follows the contract defined by #227; this section fixes
the desktop-specific mechanics:

- **Statuses** are the bounded vocabulary `pass` / `fail` / `not-run` /
  `unavailable`. Every `fail`, `not-run`, and `unavailable` carries a `gap`
  note naming the concrete reason and tracking location; a `pass` never
  declares a gap.
- **Evidence** for a `pass` names the exact command, the observed result, and
  the source head SHA or bounded artifact it is tied to — never maintainer
  memory. Test counts alone do not substitute for production-path evidence.
- **Items**: the shared floor (fixture conformance, opt-in behavior,
  byte-exact passthrough, trigger enter/exit, pending boundaries, unsupported
  safety, guarded authority, focus restoration, accessibility, mode-aware
  help, real-editor smokes, tmux nesting, performance budget) plus the
  desktop-specific items `existing-shortcuts-preserved`,
  `embedded-editor-parity`, and `desktop-browser-automation`.
- **Browser automation** (Playwright) runs against the real served desktop web
  app: enable/disable persistence, trigger rebinding, modal precedence, native
  text inputs, chrome search, pane focus/layout, guarded dirty-file close,
  help, status reporting, focus restoration, and accessibility (aria
  snapshots, keyboard-only traversal, reduced motion).
- **Real-editor smokes** (real `vim`, real `nvim`, nested tmux) follow the
  smoke protocol in the acceptance matrix, against the desktop xterm/PTY
  surface, with versions and head SHA recorded. This authoring host has no
  tmux, Rust toolchain, or product build, so those smokes are recorded
  `unavailable`/`not-run` with explicit gaps until a capable host or CI
  executes them.
- **Where recorded**: the acceptance manifest for the desktop platform (the
  machine-readable half owned by #227) plus the slice's working record under
  `docs/working-records/`, cross-linked from the PR thread.

## Risk and boundaries

- Vim mode is opt-in and ships disabled; the pre-existing keyboard surface is
  unchanged when it is off.
- Chrome mode cannot bypass authorization, confirmation, receipts, dirty-file
  guards, or lifecycle gates; executors reuse existing typed authority.
- Diagnostics and any acceptance artifacts record only bounded
  action/context/timing metadata — never raw terminal bytes, pasted text,
  editor contents, register contents, search terms, macros, or Ex command
  text.
- Unknown or malformed Ex commands produce inline error actions; no shell is
  ever invoked from the editor surface.
