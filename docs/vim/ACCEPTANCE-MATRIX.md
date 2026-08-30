# Vim cross-platform acceptance matrix

**Status:** Contract definition (no platform acceptance executed yet)
**Owner:** OpenCoven/psyche-build#227 — Vim Slice 5: cross-platform acceptance and documentation (Bead `psyche-no8.5`)
**Canonical outcome:** [#246 — Deliver post-release cross-platform Vim and keyboard-mode parity](https://github.com/OpenCoven/psyche-build/issues/246)
**Parent:** [#222 — Comprehensive opt-in Vim support across Psyche](https://github.com/OpenCoven/psyche-build/issues/222) (Bead `psyche-no8`)
**Design:** [Comprehensive Vim Support Design](../superpowers/specs/2026-08-12-comprehensive-vim-support-design.md)

## Purpose and current state

This document is the human-readable half of the cross-platform Vim acceptance
contract. The machine-readable half is the versioned manifest module
[`src/vim/acceptanceManifest.ts`](../../src/vim/acceptanceManifest.ts) and its
adversarial gate [`__tests__/vimAcceptanceManifest.test.ts`](../../__tests__/vimAcceptanceManifest.test.ts).
The test asserts that every required item id defined in code is named in this
document, so the two cannot drift silently.

What exists on `main` today: the shared, versioned semantic core
(`packages/vim-core`) and the v1 chrome conformance fixture
(`protocol-fixtures/vim/v1/chrome.json`). No product adapter behavior exists
yet in `src/`, the Vue web app, the Ink TUI, or the iOS app; the platform
slices own that work and own the execution of the checklists below:

| Slice | Bead | Scope | Checklist state |
| --- | --- | --- | --- |
| [#223](https://github.com/OpenCoven/psyche-build/issues/223) | `psyche-no8.1` | Shared contract, fixtures, desktop reference adapter (+ embedded editor) | Blocked/in-flight; not started here |
| [#224](https://github.com/OpenCoven/psyche-build/issues/224) | `psyche-no8.2` | Browser/web parity without replacing `/api/keys` transport | Blocked/in-flight; not started here |
| [#225](https://github.com/OpenCoven/psyche-build/issues/225) | `psyche-no8.3` | Ink TUI parity at the top of the input-precedence chain | Blocked/in-flight; not started here |
| [#226](https://github.com/OpenCoven/psyche-build/issues/226) | `psyche-no8.4` | iOS hardware keyboard + accessible software Chrome key | Blocked/in-flight; not started here |
| #227 | `psyche-no8.5` | This acceptance contract, smoke protocol, cumulative review gates | Contract defined; execution pending #223–#226 |

Until a platform's slice executes its checklist, every item for that platform
is **`not-run`**. Nothing in this document claims behavior, evidence, or
support that does not exist.

## One fixture-version rule

Desktop, web, Ink, and iOS must agree on exactly one fixture version.

- The single shared version is the constant `VIM_ACCEPTANCE_FIXTURE_VERSION`
  (`'vim/v1'`) exported from `src/vim/acceptanceManifest.ts`. It must remain
  identical to the `version` field of every fixture document under
  `protocol-fixtures/vim/v1/` and to the version validated by
  `@opencoven/psyche-vim-core`'s `validateVimFixtures`.
- Every platform section of an acceptance manifest declares
  `fixtureVersion: 'vim/v1'`. `validateAcceptanceManifest()` rejects any other
  value per platform, so one platform cannot silently advance or lag the
  contract.
- Fixtures carry inputs, starting context, expected state, emitted actions,
  consumed/passthrough disposition, and reset behavior. TypeScript and Swift
  adapters must produce identical semantic output for the same shared traces.
- A fixture version unknown to an adapter fails its conformance gate rather
  than silently accepting drift.
- Bumping the version is a single reviewed change that moves the fixture
  directory, the core validator, this constant, and every platform manifest
  together. Per-platform version drift is always a defect, never a migration
  state.

## Opt-in behavior contract

These points are part of acceptance on every platform; a checklist item fails
if the platform's implementation diverges:

- Vim support is **opt-in** and ships disabled (`vimModeEnabled: false` by
  default). Enabling requires an explicit user action through the platform's
  existing settings surface.
- Disabling immediately resets pending sequences, exits chrome and editor
  command state back to native input behavior, clears visible mode chrome, and
  does not send pending keys anywhere else.
- The chrome trigger defaults to `F6` and is configurable because function-key
  availability varies by platform and keyboard layout. Semantic commands are
  fixed in v1; mappings are not user-configurable.
- Pending sequences are bounded and reset on `Esc`, timeout
  (`vimSequenceTimeoutMs`, default `1000`, clamped to `250..3000`), focus loss,
  modal opening, workspace/window replacement, mode disable, or adapter
  disposal.
- No `.vimrc`, `init.vim`, `init.lua`, plugins, arbitrary mappings, or
  unrestricted Ex scripting. Unknown or malformed Ex commands never execute
  shell code.
- Host-owned consequential actions (close, save, merge, lifecycle) remain
  routed through existing typed authority, confirmation, receipt, and recovery
  paths. Chrome mode cannot bypass authorization or lifecycle gates.
- Diagnostics, if any, record only bounded action/context/timing metadata —
  never raw terminal bytes, pasted text, editor contents, register contents,
  search terms, macros, or Ex command text.

## Byte-exact terminal passthrough outside explicit chrome mode

Terminal bytes are opaque to Psyche. Outside explicit chrome mode, the terminal
transport is unchanged on every platform, and acceptance must prove it
byte-for-byte for at least: printable input, `Esc`, control chords, Alt/meta
sequences, function keys, bracketed paste, IME committed text, mouse-mode
reporting, and randomized byte sequences.

Two deliberate exceptions exist only while Vim is enabled, and both are
bounded:

1. The configured trigger (`F6` by default) is handled **before** the terminal
   controller, solely to enter chrome mode. When Vim is disabled, `F6` passes
   through like any other key.
2. While chrome mode is active, semantic navigation keys are consumed by the
   adapter and are not sent to the PTY. Leaving chrome mode with `Esc` restores
   terminal delivery **without synthesizing an extra escape byte**.

A pending or unsupported chrome sequence never falls through into a PTY or
text input, and adapter exceptions reset pending state without replaying
consumed keys into a terminal.

## Shared acceptance floor (all platforms)

Every platform checklist below includes this floor, executed against that
platform's real surface. Statuses are recorded in the platform's acceptance
manifest; all are `not-run` today.

| Item id | Requirement |
| --- | --- |
| `fixture-conformance` | The adapter replays every shared v1 fixture applicable to it and produces identical semantic output (disposition, context, pending, actions) with no runtime dependencies outside its declared platform seam. |
| `opt-in-disabled-passthrough` | With Vim mode disabled, keyboard behavior is byte-for-byte and shortcut-for-shortcut identical to the product before this feature existed, including `F6`. |
| `opt-in-persistence-rebind` | Settings persist through the platform's existing versioned storage; enable requires explicit user action; disable resets pending state immediately; trigger rebinding works and invalid persisted values fall back to disabled/default behavior. |
| `terminal-byte-passthrough` | Byte-exact terminal passthrough outside chrome mode for every byte class listed above. |
| `chrome-trigger-enter-exit` | The configured trigger enters chrome mode and shows the persistent `CHROME` indicator; `Esc` exits and restores prior focus without synthesizing terminal input. |
| `pending-reset-boundaries` | Pending sequences reset on every boundary listed in the opt-in contract, and a pending or unsupported sequence never reaches a PTY or text input. |
| `unsupported-action-safety` | Unsupported keys/sequences in chrome mode are consumed, reset safely, visibly reported, and leave product state unchanged; capability-based targets returning `unsupported` cause no side effects. |
| `guarded-actions-authority` | Close, save, merge, and lifecycle actions keep their existing confirmation, dirty-file, and receipt gates; chrome mode cannot bypass them. |
| `focus-restoration` | Leaving chrome mode restores the recorded semantic target when it still exists, otherwise focuses the nearest surviving pane or navigation container and announces the fallback. |
| `accessibility-announcements` | Mode indicators expose concise accessible labels; native Tab/Shift-Tab traversal and screen-reader semantics remain authoritative; ordinary navigation keys are not announced one by one. |
| `mode-aware-help` | `?` opens mode- and target-aware Vim help whose content matches the actions the current target actually supports. |
| `real-vim-smoke` | A real Vim session passes the smoke protocol below on this platform's terminal surface. |
| `real-neovim-smoke` | A real Neovim session passes the smoke protocol below on this platform's terminal surface. |
| `tmux-nested-smoke` | A nested tmux session passes the smoke protocol below on this platform's terminal surface. |
| `dispatch-performance-budget` | p95 single-action dispatch is under 8 ms and bounded macro/replay execution never blocks a frame longer than 33.4 ms, measured per the performance protocol below. |

## Desktop acceptance checklist — owning slice #223

The desktop Tauri adapter is the reference implementation and integrates with
the existing document shortcut router, pane layout, session tree, browser
chrome, xterm controller, and CodeMirror editor.

| Item id | Requirement |
| --- | --- |
| `existing-shortcuts-preserved` | Current `Cmd`/`Ctrl` application shortcuts and existing modal precedence are unchanged while Vim is disabled **and** while it is enabled outside chrome mode. |
| `embedded-editor-parity` | The CodeMirror adapter drives the shared editor machine (no divergent Vim plugin) and passes the golden editor scenarios: counts, composed operators, registers, marks, macros, search, Unicode, block selections, bounded Ex set, rejected Ex commands, undo grouping, and dirty-state effects on real editor state. |
| `desktop-browser-automation` | Browser automation (Playwright) exercises enable/disable persistence, trigger rebinding, modal precedence, native text inputs, chrome search, pane focus/layout, guarded actions, help, status reporting, focus restoration, and accessibility on the real desktop app. |

Desktop executes the shared floor on the xterm/PTY surface, with
`terminal-byte-passthrough` proven against the existing
`term.onData -> sendToThread -> pty_write` route.

## Web (Vue browser terminal) acceptance checklist — owning slice #224

| Item id | Requirement |
| --- | --- |
| `keys-transport-unchanged` | The existing `/api/keys` transport and native input handling are not replaced or duplicated; the adapter normalizes hardware keyboard events before the current global key handler. |
| `native-text-inputs-unchanged` | Native text inputs, textareas, contenteditable controls, dialogs, and IME composition keep their normal behavior unless chrome mode was explicitly entered. |
| `web-browser-automation` | Browser automation exercises the Vue app with keyboard layouts, IME composition, screen-reader semantics (aria snapshots), reduced motion, paste, mouse reporting, stale-target recovery, and focus restoration. |

Web executes the shared floor on the browser terminal surface, including
`terminal-byte-passthrough` across the `/api/keys` path, and
`dispatch-performance-budget` measured against browser input dispatch.

## Ink TUI acceptance checklist — owning slice #225

| Item id | Requirement |
| --- | --- |
| `input-precedence-top` | The adapter sits at the top of the existing `useInputHandling` precedence chain and routes semantic actions through existing pane, project, popup, settings, and lifecycle functions — no parallel command path. |
| `existing-shortcuts-preserved` | When disabled or outside chrome mode, every pre-existing Ink shortcut behaves exactly as before. |

Ink executes the shared floor using its existing input harness;
`terminal-byte-passthrough` is proven against the Ink-owned pane's PTY input,
and `accessibility-announcements` covers the TUI's screen-reader semantics.

## iOS acceptance checklist — owning slice #226

| Item id | Requirement |
| --- | --- |
| `hardware-keyboard-command` | External-hardware keyboard commands normalize into the Swift contract adapter and produce the same semantic actions as the shared fixtures. |
| `software-chrome-key` | The `CodingKeyRow` adds an accessible Chrome key as the software-keyboard equivalent of `F6`; it exposes an accessible label and does **not** manufacture a terminal `F6` sequence when entering app chrome mode. |
| `pty-transport-unchanged` | `PtyTerminal.sendInput`, `XtermWebView`, and the current bridge messages remain the only terminal input path; chrome mode consumes keys without writing to the bridge. |
| `swift-fixture-parity` | The Swift adapter replays the shared fixture traces with byte-identical normalized JSON output compared with the TypeScript reference. |
| `physical-device-evidence` | Physical-device proof is obtained and recorded, or the gap is explicitly recorded as `unavailable`/`not-run` per the proof-gap protocol below. |

iOS executes the shared floor with XCUITest/XCTest suites for
external-keyboard commands and the accessible software Chrome key. Simulator
evidence alone never satisfies `physical-device-evidence`.

## Real Vim/Neovim/tmux smoke session protocol

This is the protocol each owning slice executes and records. It is **not yet
executed anywhere**: no adapter exists to drive it, and this slice's authoring
environment has no tmux or product build to run it against. Execute it against
real terminals once the platform adapter lands, and record every observation
with the exact command, exact versions, and the branch head SHA.

For each platform surface (desktop xterm pane, browser terminal, Ink-owned
pane, iOS terminal, and each nested inside tmux):

1. Record the environment: Vim and Neovim versions (`vim --version`,
   `nvim --version`), tmux version, OS, keyboard layout, and the exact product
   build/head SHA under test.
2. Start a real Vim/Neovim session in the terminal surface. Verify:
   insert/normal transitions (`i`, `Esc`, `a`, `o`), a user mapping, a recorded
   macro (`q`/`@`), terminal mouse mode, and scrollback — all keys reach the
   editor unchanged while Vim mode is disabled and while it is enabled outside
   chrome mode.
3. With Vim mode enabled, enter chrome mode with the trigger and leave with
   `Esc`; assert the editor session shows no stray input: no synthesized
   escape byte, no replayed navigation keys.
4. Nest the same session inside tmux (outer and inner panes) and repeat step 2;
   confirm tmux prefix handling is unaffected and byte passthrough remains
   exact.
5. Capture a deterministic transcript (terminal typescript or recorded byte
   log) as the artifact, and reference it — with the head SHA — in the
   manifest item's `evidence`. Artifacts must be bounded and free of secrets,
   personal paths, and unrestricted output.
6. Record any surface where the protocol cannot run as `unavailable` with a
   `gap` naming the exact reason and tracking location.

## Accessibility checks

Per platform, in addition to `accessibility-announcements` in the shared floor:

- Keyboard-only traversal: every flow reachable before the feature remains
  reachable, with native Tab/Shift-Tab order intact.
- Screen reader: the `CHROME` indicator, pending sequence, focused semantic
  target, and mode transitions are announced concisely; tooling: VoiceOver +
  Accessibility Inspector (desktop/iOS), NVDA or VoiceOver with aria-snapshot
  assertions (web), the TUI's screen-reader semantics harness (Ink).
- Reduced motion: animated focus travel is disabled under reduced-motion
  preferences without changing focus semantics.
- Touch: touch behavior is unchanged; Vim adds keyboard behavior and never
  hides touch controls (iOS and web).
- Escape hatch: `Esc` always offers a bounded path back to passthrough/native
  interaction, including when focus restoration falls back.

## Performance checks

- Budget: p95 dispatch under 8 ms for a single semantic action; bounded macro
  and replay execution without blocking a UI frame longer than 33.4 ms (two
  frames at 60 Hz).
- Method: a deterministic harness with warm caches, a stated input workload,
  and recorded sample counts; measure on the platform's real surface (not a
  mock) and record the machine/device class with the result.
- Regressions are `fail` items, not notes. Unmeasured platforms stay
  `not-run`; never copy another platform's numbers.

## Recording physical-device proof gaps

Some proof can only exist on physical hardware (for example external-keyboard
behavior on a physical iPhone). The contract for gaps:

- Status vocabulary is bounded: `pass` (executed, evidence recorded), `fail`
  (executed, did not meet the requirement — blocks the slice), `not-run`
  (executable on this surface but not yet executed), `unavailable` (cannot be
  executed on this surface/host — for example no physical device or no macOS
  toolchain in CI).
- Every `fail`, `not-run`, and `unavailable` item carries a non-empty `gap`
  note naming the concrete reason and where it is tracked. The validator
  rejects a missing gap, and rejects any `pass` that declares a gap.
- Evidence for `pass` names the exact command, the observed result, and the
  source SHA or artifact it is tied to — never maintainer memory, unbounded
  logs, or screenshots without provenance.
- Physical-device entries record device class and OS version only; never
  serial numbers, account identifiers, personal paths, or other protected
  data.
- Gaps are recorded in three places: the platform's manifest item `gap`, the
  platform working record, and the slice's PR thread. A gap is closed only by
  replacing the status with `pass` and real evidence — never by deleting it.

## Final cumulative review requirements

The cumulative slice (#227) is complete only when all of the following hold;
until then it remains open regardless of this document landing:

- Every platform manifest validates via `validateAcceptanceManifest()` with
  all required items `pass` (or an explicitly approved `unavailable` with a
  recorded gap), and all four platforms declare the same fixture version.
- The full repository gate and each platform's gates pass on the hosts that
  can satisfy them; platforms whose gates cannot run locally carry explicit
  gaps rather than claims.
- Real Vim/Neovim/tmux smoke evidence is recorded per platform per the
  protocol above.
- Documentation (this matrix, user-facing docs, and in-product mode-aware
  help) is current, matches the shipped command catalog, and claims no
  `.vimrc`/plugin compatibility.
- Independent specification review (against the approved design) and an
  independent cumulative code-quality review approve the whole Vim train
  (#223–#226 plus this slice).
- No branch is merged and no worktree is removed without explicit
  maintainer authorization.

## Filling the manifest per platform

Platform slices copy the unstarted manifest shape and fill their own platform
entry; the validator enforces the rest:

```ts
import {
  createUnstartedAcceptanceManifest,
  validateAcceptanceManifest,
  type VimAcceptanceManifest,
} from '../src/vim/acceptanceManifest.js';

const manifest = createUnstartedAcceptanceManifest(); // every item not-run with a gap
const filled: VimAcceptanceManifest = {
  ...manifest,
  platforms: {
    ...manifest.platforms,
    desktop: {
      ...manifest.platforms.desktop,
      items: manifest.platforms.desktop.items.map((item) =>
        item.id === 'terminal-byte-passthrough'
          ? { id: item.id, status: 'pass', evidence: '<exact command>; <observed result>; <head sha or artifact>' }
          : item,
      ),
    },
  },
};
validateAcceptanceManifest(filled); // throws on any contract violation
```

The gate runs with:

```bash
npx pnpm exec vitest --run __tests__/vimAcceptanceManifest.test.ts
```

A platform slice that needs a new item id extends
`REQUIRED_VIM_ACCEPTANCE_ITEMS` and this document in the same reviewed change;
the doc-coverage test fails if the document and the catalog diverge.
