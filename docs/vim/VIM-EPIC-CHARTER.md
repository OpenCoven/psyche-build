# Vim Epic Charter — one versioned semantic contract across Psyche

**Epic:** OpenCoven/psyche-build#222 (Bead `psyche-no8`, P2)
**Canonical outcome:** OpenCoven/psyche-build#246
**Disposition:** post-release (deferred until after the v0.0.1 macOS release baseline and publication gate)
**Design source:** [docs/superpowers/specs/2026-08-12-comprehensive-vim-support-design.md](../superpowers/specs/2026-08-12-comprehensive-vim-support-design.md) (approved design)
**Executable contract:** [src/vim/semanticContract.ts](../../src/vim/semanticContract.ts) (`VIM_SEMANTIC_CONTRACT_VERSION = 1`, fixture version `vim/v1`)
**Charter status:** delivered by the #222 epic-contract slice; slices #223–#226 own the implementations and #227 owns cross-platform acceptance.

---

## Objective

Deliver terminal-safe Vim input, practical embedded-editor parity, and explicit `F6`
chrome navigation across desktop, browser/web, the Ink TUI, and iOS hardware and
software keyboards — using **one versioned semantic contract** so no platform
re-implements Vim semantics in parallel.

The feature covers three distinct interaction domains:

1. **Terminal Vim/Neovim input fidelity** — terminal bytes stay opaque; Psyche never
   inspects, interprets, or duplicates a terminal process's Vim state.
2. **Practical Vim editing in Psyche's embedded file editor** — practical parity, not
   Neovim plugins, Lua, `.vimrc`, or unrestricted Ex scripting; edits are applied
   through the editor's own transactional paths.
3. **App-wide navigation through an explicit chrome mode** — `F6` (configurable)
   enters chrome mode; `Esc` leaves it and restores the previously focused surface.

Desktop is the reference implementation; browser/web, Ink, and iOS implement the same
contract version and pass the same conformance fixtures.

## Invariants

These hold across every slice and platform. They are enforced in code by
`src/vim/semanticContract.ts` where marked executable.

1. **Opt-in (executable).** Vim support is disabled by default; enabling requires an
   explicit user action. While disabled — and in the `disabled`/`passthrough` contexts
   generally — every event classifies as terminal passthrough and no semantic op is
   reachable. Disabling immediately resets pending sequences, exits chrome/editor
   command state, and never sends pending keys elsewhere. Existing shortcuts are
   unchanged while the feature is off.
2. **Terminal passthrough is byte-exact outside explicit chrome mode (executable).**
   Outside chrome mode, printable input, `Esc`, control chords, Alt/meta sequences,
   function keys, bracketed paste, IME committed text, mouse mode, and arbitrary byte
   sequences reach the focused surface unmodified. `validateOpFixture` rejects any
   fixture whose `passthroughBytes` are not byte-identical to `input.bytes`, and
   `chromeModeGuard` classifies **every** event as `terminal-passthrough` while chrome
   mode is inactive — including keys that are chrome bindings. Entering and leaving
   chrome mode must not synthesize terminal input.
3. **Chrome-scoped ops are reachable only inside explicit chrome mode (executable).**
   `chromeModeGuard` never returns a chrome op unless the chrome-mode state is active;
   `assertChromeOpReachable` fails closed for executors. While chrome mode is active,
   unmapped keys are consumed and reported without side effects — a pending or
   unsupported chrome sequence never falls through into a PTY or text input.
4. **Host-owned consequential actions stay routed through typed authority paths —
   never editor shortcuts (executable).** Persistence ops (`save-request`,
   `close-request`, `save-close-request`) carry `route: 'host-authority'` and are
   rejected by the validator with anything else. Chrome `guarded-close` is a request;
   saves, closes, quits, merges, and lifecycle actions keep flowing through the host's
   existing confirmation, receipt, revocation, idempotency, and recovery paths. Chrome
   mode cannot bypass authorization, lifecycle, close, save, or merge gates.
5. **Fail-closed bounded payloads (executable).** `validateOpFixture` /
   `validateOpFixtures` reject unknown fields at any level, unknown
   contexts/dispositions/op kinds/op names/Ex commands, unbounded counts, patterns,
   args, messages, registers, and oversized fixture sets, and reject duplicate fixture
   ids or duplicate (context, normalized-key) cases. Unknown or malformed Ex commands
   never execute shell code.
6. **Fixture-version drift fails the gate.** Fixtures declare `vim/v1`; an adapter
   meeting any other version fails conformance instead of silently accepting drift.
   The same version string is pinned by #227's
   `src/vim/acceptanceManifest.ts` (`VIM_ACCEPTANCE_FIXTURE_VERSION`).
7. **Accessibility floor.** Native Tab/Shift-Tab traversal, native text editing,
   dialogs, and screen-reader semantics stay authoritative unless chrome mode was
   explicitly entered; `Esc` always offers a bounded path back to passthrough; chrome
   and editor indicators expose concise accessible labels; touch behavior never
   regresses.
8. **Protected data.** Fixtures, diagnostics, and acceptance records carry bounded
   enumerated payloads only — never raw unrestricted terminal output, pasted text,
   editor contents, register contents, search terms, macros, or Ex command text
   beyond the bounded fields the contract defines.

## Contract surfaces and ownership

| Surface | Path | Owner |
| --- | --- | --- |
| This charter (objective, invariants, slice map, disposition) | `docs/vim/VIM-EPIC-CHARTER.md` | #222 epic-contract slice (this document) |
| Versioned semantic contract, strict op-fixture validator, chrome-mode guard | `src/vim/semanticContract.ts` | #222 epic-contract slice |
| Executable state machine, conformance fixture documents (`protocol-fixtures/vim/v1/`), settings schema, desktop reference adapter, embedded-editor core | `packages/psyche-vim-core/**`, `protocol-fixtures/vim/v1/**`, desktop adapter (per slice plan) | #223 (`psyche-no8.1`) |
| Browser/web adapter parity (Vue terminal + dashboard, `/api/keys` unchanged) | web adapter (per slice plan) | #224 (`psyche-no8.2`) |
| Ink TUI adapter parity (top of existing input precedence chain) | Ink adapter (per slice plan) | #225 (`psyche-no8.3`) |
| iOS Swift conformance adapter, hardware `F6` command, accessible software Chrome key | iOS adapter (per slice plan) | #226 (`psyche-no8.4`) |
| Cross-platform acceptance manifest, acceptance matrix, docs, physical-device gap record | `src/vim/acceptanceManifest.ts`, `docs/vim/ACCEPTANCE-MATRIX.md` | #227 (`psyche-no8.5`) |

Contract governance: changing the semantic-op vocabulary, contexts, dispositions,
payload bounds, or guard semantics requires bumping `VIM_SEMANTIC_CONTRACT_VERSION`
(or the fixture version) with reviewed changes across the validators, the
`protocol-fixtures/vim/v1/` documents, and the acceptance manifest — never a silent
drift.

## Slice map (acceptance criteria quoted from the beads; statuses as of 2026-08-30)

| # | Bead | Scope | Acceptance criteria (from the bead) | Current status |
| --- | --- | --- | --- | --- |
| [#223](https://github.com/OpenCoven/psyche-build/issues/223) | `psyche-no8.1` | Shared contract + desktop reference: versioned semantic core, fixtures, settings, terminal-safe desktop chrome adapter, practical CodeMirror Vim editor, desktop acceptance coverage | Shared core and desktop adapter implement the approved contract; terminal passthrough is byte-exact outside chrome mode; embedded editor practical-parity matrix passes; desktop accessibility and browser smoke pass; independent reviews approve | **In progress** (blocked in the mirrored graph). Task 1 approved (commits `44b2b84`, `83eae3d`; Vim contract 18/18; core/root typechecks; independent spec review approved). Task 2 quality gate blocked after spec approval with recorded findings (unbounded count crash, unsafe/unbounded search and Ex input, Unicode committed-text/search boundary defects, stale marks, non-atomic multi-range port, replay state leaks, incomplete approved editor/Ex surface); architecture decision recorded before Task 3 (retain `createEditorMachine` facade, split editor core modules, atomic multi-change transactions, bounded committed-text/search/replay/Ex paths, semantic capability actions where host-owned) |
| [#224](https://github.com/OpenCoven/psyche-build/issues/224) | `psyche-no8.2` | Browser/web parity: apply the shared contract to the Vue browser terminal and dashboard without replacing `/api/keys` or native input behavior | Web adapter passes shared fixtures, preserves `/api/keys` bytes outside chrome mode, supports chrome navigation and accessible settings/help, and passes browser behavior tests and independent reviews | **Not started** |
| [#225](https://github.com/OpenCoven/psyche-build/issues/225) | `psyche-no8.3` | Ink TUI parity: integrate the shared contract at the top of the existing Ink input precedence chain, reusing current pane/project/popup/lifecycle actions | Ink adapter passes shared fixtures; disabled behavior is unchanged; `F6` chrome mode, search, navigation, guarded actions, help, persistence, and accessibility copy pass behavior tests and independent reviews | **Not started** |
| [#226](https://github.com/OpenCoven/psyche-build/issues/226) | `psyche-no8.4` | iOS keyboard parity: Swift conformance adapter, `F6` hardware command, accessible software Chrome key, settings, semantic action routing; `PtyTerminal.sendInput` and `XtermWebView` preserved | Swift adapter passes v1 fixtures; terminal transport remains unchanged; hardware and software chrome triggers, navigation, settings, focus restoration, and accessibility pass XCTest/XCUITest; physical keyboard proof is recorded or left explicit; independent reviews approve | **Not started** |
| [#227](https://github.com/OpenCoven/psyche-build/issues/227) | `psyche-no8.5` | Cross-platform acceptance and documentation: run shared and platform matrices, real Vim/Neovim smoke sessions, accessibility and performance checks, document the opt-in contract, record physical-device proof gaps | Desktop, web, Ink, and iOS agree on one fixture version; full repository and platform gates pass; Vim/Neovim/tmux smoke evidence is recorded; docs and mode-aware help are current; proof gaps are explicit; final cumulative reviews approve | **Manifest contract delivered**: `src/vim/acceptanceManifest.ts` (v1, fail-closed validator, required per-platform item catalog) plus `docs/vim/ACCEPTANCE-MATRIX.md` exist on branch `psyche/issue-227-vim-acceptance-docs`, not yet merged to `main`. Execution of the acceptance matrix remains open until the platform slices above complete |

**Acceptance order.** The beads' mirrored dependency edges are currently inverted
(each slice lists its *successor* as "blocked by"), which the 2026-08-30 backlog
audit recorded on #222. The acceptance plan requires the dependency-ordered sequence

```
#223 (shared contract + desktop) → #224 (web) → #225 (Ink) → #226 (iOS) → #227 (cross-platform acceptance)
```

with #227 executed only after its platform prerequisites. Repairing the Beads edge
directions is a Beads-source change handled through the supported synchronizer
(`.beads/README.md`), not by hand-editing mirror bodies.

## Completion gates (per platform slice)

A platform slice is complete only when it: passes all shared fixtures applicable to
it; keeps the existing shortcut and terminal transport suites green; passes its
real-surface smoke test; passes accessibility assertions; documents unsupported
capabilities and proof gaps; and passes independent specification and code-quality
reviews. Cross-platform parity requires desktop, web, Ink, and iOS on the same
contract version. Physical iOS hardware-keyboard evidence remains an explicit proof
gap until executed on available hardware.

## Disposition

This epic family is **post-release** work, deferred until after the v0.0.1 macOS
release baseline and publication gate. The canonical outcome is
[OpenCoven/psyche-build#246](https://github.com/OpenCoven/psyche-build/issues/246);
earlier broad prose references for this Vim family are historical/superseded, and
gh-246 stays the source of truth for the remaining post-release track. This charter
describes the contract the slices must satisfy; it is not evidence that any
behavior has shipped.
