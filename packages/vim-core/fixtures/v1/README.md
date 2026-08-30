# Vim v1 shared fixture set

Versioned, deterministic conformance fixtures for the shared Vim semantic core
([`@opencoven/psyche-vim-core`](../../src/index.ts)). Desktop, web (browser),
Ink TUI, and iOS adapters replay the **same traces** through their own platform
seam and must produce the same semantic output for each one. This is the
machine-readable half of the conformance requirement `fixture-conformance` in
[`docs/vim/ACCEPTANCE-MATRIX.md`](../../../docs/vim/ACCEPTANCE-MATRIX.md)
(#227 owns that acceptance contract; this directory owns the fixture data).

## Documents

| File | Schema | Covers |
| --- | --- | --- |
| `chrome-navigation.json` | Chrome input contract (`version` + `traces`, no `kind` field) | F6 trigger, `Esc` exit, focus movement (`h`/`j`/`k`/`l`, `g g`, `G`, `Enter`), `Ctrl-w` pane commands, chrome search, target close/refresh, help, disabled passthrough, unsupported-key consumption |
| `motions.json` | Editor contract (`kind: "editor"`) | Character/word/line motions, counts, `f`/`F`/`t`/`T`, `%`, paragraph `{`/`}`, error consumption for failed motions and unsupported modified keys |
| `edits.json` | Editor contract | `dw`, `ciw`, `yy`, `p`, `o`, insert/replace sessions with counts, visual character/line/block deletes, `J`, `>>`, `g~w`, undo through the document port, `.` repeat, committed IME text (Unicode) |
| `search.json` | Editor contract | `/` and `?` with `n`/`N` cycling, `*` whole-word search, error cases (`No previous search`, unsupported/invalid patterns) |
| `ex-commands.json` | Editor contract | `:w`, `:wq`, `:q`, `:%s` (global, first-per-line, confirmed through the port), `:set`, `:b`, line goto, `:noh`, and every rejection (`!`, `\|`, `:g`, filesystem arguments, `:source`, unknown commands) |

## Format

Every document declares `"version": "vim/v1"` — the single shared fixture
version defined by `VIM_FIXTURE_VERSION` in
[`src/fixtureLoader.ts`](../../src/fixtureLoader.ts) and mirrored by
`VIM_ACCEPTANCE_FIXTURE_VERSION` in the #227 acceptance manifest.

### Chrome documents (input contract)

The exact schema validated by `validateVimFixtures` in
[`src/fixtures.ts`](../../src/fixtures.ts): a bounded list of traces, each with
a starting `context`, a `sequence` of normalized key tokens, and the expected
`disposition`, `context`/`pending` state, and semantic `actions`.

### Editor documents (editing contract)

Declared with `"kind": "editor"` and validated by `validateEditorFixtures` in
[`src/fixtureLoader.ts`](../../src/fixtureLoader.ts):

```jsonc
{
  "version": "vim/v1",
  "kind": "editor",
  "traces": [
    {
      "id": "edit-delete-word-dw",
      "document": { "text": "alpha beta gamma", "cursor": 0 },
      "inputs": ["d", "w"],
      "expected": {
        "mode": "normal",
        "pending": "",
        "text": "beta gamma",
        "cursor": 0,
        "actions": [{ "type": "mode", "mode": "normal" }],
        "registers": { "\"": { "text": "alpha ", "linewise": false } },
        "marks": { "[": 0, "]": 0 }
      }
    }
  ]
}
```

- `document` — the starting buffer text and cursor position handed to the
  adapter's document port.
- `inputs` — up to 32 inputs fed to `EditorMachine.handle`, in order. Each
  input is a key name (`"h"`, `"Escape"`, `"Enter"`), a key token object
  (`{ "key": "v", "ctrlKey": true }`), or committed/pasted text
  (`{ "kind": "text", "text": "œ", "source": "composition" }`). Ex commands are
  typed through the real command-line flow (`":"`, `"w"`, `"Enter"`), never a
  side channel.
- `expected` — the state after the final input: `mode`, `pending`, optional
  `count`, final `text` and `cursor`, the exact final-input `actions`, optional
  `search` state, and optional `registers`/`marks`/`selections` assertions read
  back through the machine.

Expectations are exact, including error actions: a trace whose error message,
count limit, or action ordering drifts fails the replay. Editors consume the
fixtures against a document port whose `command()` honors `undo` by restoring
the pre-transaction snapshot — the same contract a real adapter's history
stack implements.

## Consumption contract for adapters

- **Desktop (Tauri)**: the reference adapter. Replays chrome traces through
  `createChromeMachine` and editor traces through `createEditorMachine` wired
  to the CodeMirror-backed document port; see
  [`docs/vim/DESKTOP-REFERENCE-ADAPTER.md`](../../../docs/vim/DESKTOP-REFERENCE-ADAPTER.md).
- **Web (browser)**: replays the same documents against the Vue browser
  terminal and its editor surface (#224). No adapter may maintain a forked
  fixture copy.
- **Ink (TUI)**: replays chrome traces through the shared machine at the top
  of the `useInputHandling` precedence chain (#225).
- **iOS (Swift)**: replays the traces through the Swift contract adapter and
  asserts byte-identical normalized JSON output against the TypeScript
  reference (`swift-fixture-parity`, #226). Swift decodes the same JSON files;
  it never regenerates them.

All platforms load the JSON through `parseVimFixtureDocument` (TypeScript) or
its Swift mirror, which dispatch on the optional `kind` field, reject unknown
versions and fields, and fail closed. Hosts own the IO: tests and Node tools
read the files from this directory, bundled adapters inline them at build time,
and iOS embeds them as decoded resources. Every trace id is unique across the
whole set (enforced by `validateVimFixtureSet`) so acceptance evidence can
reference traces unambiguously.

## Versioning policy

- `vim/v1` is immutable within this directory: additive traces are allowed;
  editing an existing trace's inputs or expectations is a contract change.
- A change that alters what any existing trace expects (machine semantics,
  action shape, error wording) must **bump the version** in one reviewed
  change: move this directory to `fixtures/v2/`, update
  `VIM_FIXTURE_VERSION`, the core validators, the #227
  `VIM_ACCEPTANCE_FIXTURE_VERSION` constant, and every platform manifest
  together. Per-platform version drift is always a defect, never a migration
  state.
- An adapter that is asked for a version it does not implement fails its
  conformance gate; it never silently replays a newer or older set.
- Bounds (trace counts, input counts, text and string lengths, action counts)
  are enforced by the validators, not by convention. Documents exceeding them
  are rejected.
