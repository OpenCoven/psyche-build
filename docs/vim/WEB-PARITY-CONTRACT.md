# Web parity contract — Vue browser terminal and dashboard (Vim v1)

**Status:** Contract definition — the Vue integration itself is not implemented in this slice
**Owner:** OpenCoven/psyche-build#224 — Vim Slice 2: browser and web parity (Bead `psyche-no8.2`)
**Canonical outcome:** [#246 — Deliver post-release cross-platform Vim and keyboard-mode parity](https://github.com/OpenCoven/psyche-build/issues/246)
**Parent:** [#222 — Comprehensive opt-in Vim support across Psyche](https://github.com/OpenCoven/psyche-build/issues/222) (Bead `psyche-no8`)
**Design:** [Comprehensive Vim Support Design](../superpowers/specs/2026-08-12-comprehensive-vim-support-design.md)
**Integration plan (design history):** [Vim Slice 2: web](../superpowers/plans/2026-08-12-vim-slice-2-web.md)

## Purpose and current state

This document defines how the shared, versioned Vim contract applies to the Vue
browser terminal and dashboard. The machine-readable half is the pure,
dependency-free classification module
[`frontend/src/vim/webAdapterContract.ts`](../../frontend/src/vim/webAdapterContract.ts)
and its adversarial gate
[`__tests__/vimWebAdapterContract.test.ts`](../../__tests__/vimWebAdapterContract.test.ts).

What exists on `main` today: the shared semantic core (`packages/vim-core`, owned
by #222/#223), the v1 chrome conformance fixture
(`protocol-fixtures/vim/v1/chrome.json`), and this contract module. What does
**not** exist yet: the Vue composable, mode indicator, settings surface, or any
chrome-mode routing in `frontend/src/components/Terminal.vue` or
`Dashboard.vue`. That integration work (composable wrapping the shared machine,
semantic actions mapped onto the existing terminal/dashboard functions,
Playwright keyboard/IME/accessibility coverage) belongs to the remaining web
slice execution; this module is the classification and validation boundary it
must implement.

Sibling ownership: #223 owns the shared core, fixtures, and desktop reference
adapter; #225 the Ink TUI; #226 iOS; #227 the cross-platform acceptance
manifest and matrix (all web acceptance items are `not-run` there today).

## One fixture-version rule

- The web contract is pinned to the single shared fixture version
  `WEB_ADAPTER_FIXTURE_VERSION` (`'vim/v1'`), identical to the `version` field
  of `protocol-fixtures/vim/v1/chrome.json` and to
  `VIM_ACCEPTANCE_FIXTURE_VERSION`. The test suite asserts the pin, so the
  three cannot drift silently.
- A fixture version unknown to the web adapter fails its conformance gate; it
  is never silently accepted. Bumping the version is one reviewed change that
  moves the fixtures, the core, this constant, and the acceptance manifests
  together.

## How the shared v1 fixture set applies to the web surfaces

- Fixture traces whose starting context is `chrome-normal` or `chrome-search`
  must replay through `classifyWebKeyEvent()` with the gate ON (search state
  set by `/`), producing the same `disposition` and `pending` as the fixture
  and a web op that maps 1:1 onto the fixture's v1 action (`kind` equals the
  shared action `type`; `direction` is carried unchanged). The test suite
  replays every trace in `chrome.json` this way.
- The `chrome-enter-f6` trace starts in the `passthrough` context: the
  configured trigger is resolved at the design's trigger precedence level,
  **before** "active Psyche chrome mode", by the integration seam (the browser
  equivalent of the desktop adapter handling `F6` before xterm). Entering
  chrome mode is an explicit user action that turns the gate ON; it is never a
  classification outcome of this module. `chrome.enter` is deliberately absent
  from the web op vocabulary, and the validator rejects it — the test proves
  the seam by showing the shared core emit `chrome.enter` for the same event
  that the web classifier passes through with the gate off.

## The chrome-mode gate (normative)

**Gate OFF (default; also after disable, disposal, or `Esc`):** every key
event — printable input, `Esc`, `Enter`, `Tab`, arrows, every function key
including `F6`, control chords, Alt/meta chords, IME and `Process`/`Unidentified`
keys, and modifier keys themselves — classifies as `passthrough` carrying the
**exact original event reference**. No key ever produces a semantic op while
the gate is off. The adapter delivers the original event object to the
existing handlers unmodified; it must not re-encode, clone-and-edit, drop,
reorder, or batch it.

**Gate ON:** only the following chrome navigation op set may be produced.
Anything else is `unsupported`: consumed, pending state cleared, reported
without side effects, and — critically — **never delivered to `/api/keys` or a
text input**. Consumed results type-reject any `event` payload.

| Keys | Web op | Web surface meaning |
| --- | --- | --- |
| `h` `j` `k` `l` | `focus.move` | Move focus spatially within the active collection (pane cards on the dashboard, toolbar/pane regions on the terminal page) |
| `g` `g` | `focus.first` | Move to the first item (`g` is a pending prefix step) |
| `G` | `focus.last` | Move to the last item |
| `Enter` | `focus.activate` | Activate or open the focused target through its existing handler |
| `Ctrl-w h/j/k/l` | `pane.focus` | Focus the pane in that direction in the pane grid |
| `Ctrl-w w` | `pane.cycle` | Cycle panes |
| `Ctrl-w +` `-` `<` `>` | `pane.resize` | Resize the pane in bounded steps |
| `Ctrl-w =` | `pane.equalize` | Equalize the pane layout |
| `Ctrl-w s` / `Ctrl-w v` | `pane.split-horizontal` / `pane.split-vertical` | Create a horizontal or vertical terminal pane |
| `/` | `search.open` | Enter scoped chrome search over the current navigation surface (sessions in the rail, panes in the workspace) — never terminal contents |
| `n` / `N` | `search.next` / `search.previous` | Next or previous scoped match (search context only) |
| `x` | `target.close` | Request guarded close through the existing confirmation/dirty-file gates |
| `r` | `target.refresh` | Retry or refresh when the target advertises that action |
| `?` | `help.open` | Open mode- and target-aware Vim help |
| `Esc` | `chrome.exit` | Exit chrome mode, turn the gate off, restore prior focus |

Design-intent actions that the shared v1 action vocabulary does not yet carry —
for example `Ctrl-u`/`Ctrl-d` page moves — are consumed as `unsupported` by the
web gate until the shared vocabulary grows. The web adapter must not invent
ops outside the versioned set.

## `/api/keys` byte-exactness outside chrome mode

The existing transport is not replaced, duplicated, re-encoded, or proxied.
Concretely, the unchanged paths are:

- `handleGlobalKeydown` in `Terminal.vue`: document-level keydown → POST
  `/api/keys/{paneId}` with `{ key, ctrlKey, altKey, shiftKey, metaKey }`,
  skipping focused `INPUT`/`TEXTAREA` targets and bare modifier keys;
- the mobile toolbar's `sendKey()` and the hidden mobile input's per-character
  sends, including `Backspace`;
- the mobile input's bulk `{ text }` paste payload, which stays atomic and is
  never parsed as a Vim sequence;
- the dashboard's per-pane `/api/keys` posts.

The future integration normalizes hardware keyboard events **before** the
existing global key handler (acceptance item `keys-transport-unchanged`) and
may introduce exactly two bounded exceptions, both requiring the feature to be
enabled:

1. the configured trigger (`F6` by default) is intercepted before the terminal
   path, solely to enter chrome mode; when disabled, `F6` passes through like
   any other key; and
2. while chrome mode is explicitly active, classified semantic keys are
   consumed and not sent to `/api/keys`.

Leaving chrome mode with `Esc` restores terminal delivery **without
synthesizing an extra escape byte**, and a pending or unsupported sequence
never falls through into the transport or a text input. Terminal output,
streaming, and rendering are untouched by this contract.

## Chrome navigation and accessible settings/help requirements

These are binding requirements for the integration slice, mapped from the
acceptance floor in `docs/vim/ACCEPTANCE-MATRIX.md` (`#227` records their
statuses, all `not-run` today):

- A persistent `CHROME` indicator (`role="status"`) shows chrome mode, the
  pending sequence, and the focused semantic target, with a concise accessible
  label. Ordinary navigation keys are not announced one by one.
- Native `Tab`/`Shift-Tab` traversal, screen-reader roles/labels/selection,
  and touch controls keep working; Vim mode only adds keyboard behavior.
- Settings are reachable without the mouse: via native traversal and, once
  chrome mode is entered, via `focus.move`/`focus.activate` to the existing
  settings affordances. Enabling the feature always requires an explicit user
  action; the trigger is configurable; invalid persisted values fall back to
  disabled/default behavior.
- `?` opens mode- and target-aware help whose content matches the actions the
  focused target actually supports.
- Focus restoration records a stable semantic target (not a DOM pointer):
  `Esc` restores it when it still exists, otherwise focuses the nearest
  surviving pane or navigation container and announces the fallback.
- Reduced-motion preferences disable animated focus travel without changing
  focus semantics. IME composition and native text inputs, textareas,
  contenteditable controls, and dialogs keep native behavior unless chrome
  mode was explicitly entered (`native-text-inputs-unchanged`).

## State, validation, and reset obligations

- The integration owns `WebAdapterState` between events and persists nothing
  that the module does not validate: `validateWebAdapterState()` rejects
  unknown fields, unknown pending prefixes, and inconsistent states
  (gate-off with pending/search, search with pending);
  `safeWebAdapterState()` degrades invalid restored state to the canonical
  disabled state instead of throwing.
- `validateWebAdapterResult()` is the strict envelope validator: unknown
  fields, unknown dispositions, unknown op kinds (including the forbidden
  `chrome.enter`), unknown directions, stale pending sequences, and events
  attached to consumed results are all rejected. The passthrough event payload
  stays opaque beyond requiring a readable key: the contract guarantees
  identity preservation, not payload minimization.
- Pending sequences reset on: `Esc`, timeout (`vimSequenceTimeoutMs`, default
  `1000`, clamped to `250..3000` — the integration owns the clock; this module
  is time-free), focus loss, modal opening, workspace/window replacement, mode
  disable, and adapter disposal (`clearWebAdapterPending()` for the boundaries
  that keep chrome mode, `resetWebAdapter()` for those that end it).
- Adapter exceptions reset pending state and surface a nonfatal status; they
  never replay consumed keys. Diagnostics may record only bounded
  contract/state metadata — never raw terminal bytes, pasted text, register
  contents, search terms, or keystroke payloads.

## Explicit boundaries of this slice

- No changes to `frontend/src/components/Terminal.vue`, `Dashboard.vue`,
  `frontend/src/terminal.ts`, `dashboard.ts`, or `styles.css`; the module is
  additive and unreferenced by product code.
- No changes to `/api/keys` handling (client or server) or native input
  behavior of any kind.
- No settings persistence, no mode indicator, no Playwright coverage yet:
  browser runtime verification is a documented gap of this slice, and the
  `keys-transport-unchanged`, `native-text-inputs-unchanged`, and
  `web-browser-automation` acceptance items remain owned by the remaining web
  slice work plus #227's acceptance tracking.

## Contract-level verification

`npx pnpm exec vitest --run __tests__/vimWebAdapterContract.test.ts` proves,
at the contract level: the gate-off passthrough invariant for every key class
(with event-identity preservation), the gate-on restricted op set and pending
prefix behavior, consumption (never passthrough) of everything outside the op
set, type-rejection of malformed events/states/results, replay of every shared
v1 fixture trace with the documented enter-seam boundary, normalization parity
with `@opencoven/psyche-vim-core`, the exact op-vocabulary lock (shared v1
chrome vocabulary minus `chrome.enter`), and the module's purity (no runtime
imports, no DOM references). Exact commands and observed results are recorded
in the working record
[`docs/working-records/issue-224-vim-slice2-web-parity.md`](../working-records/issue-224-vim-slice2-web-parity.md).
