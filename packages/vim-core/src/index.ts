export { createChromeMachine, type ChromeMachine, type ChromeMachineOptions } from './chrome-machine.js';
export { validateChromeFixtures, validateVimFixtures, type VimFixtureDocument, type VimFixtureTrace } from './fixtures.js';
export { VIM_FIXTURE_VERSION, parseVimFixtureDocument, validateEditorFixtures, validateVimFixtureSet, type ParsedVimFixtureDocument, type VimEditorFixtureDocument, type VimEditorFixtureExpected, type VimEditorFixtureInput, type VimEditorFixtureTrace } from './fixtureLoader.js';
export { normalizeKeyboardEvent } from './normalize.js';
export { createEditorMachine, EDITOR_LIMITS } from './editor-machine.js';
export type {
  EditorAction,
  EditorCapabilityCommand,
  EditorChange,
  EditorDocumentPort,
  EditorGlobalMarkReference,
  EditorGlobalMarkStore,
  EditorInput,
  EditorMachine,
  EditorMachineOptions,
  EditorMode,
  EditorRegister,
  EditorResult,
  EditorSearchState,
  EditorSelection,
  EditorTransaction,
  EditorTextInput,
  EditorPasteInput,
} from './editor-machine.js';
export type {
  KeyboardEventLike,
  NormalizedKey,
  VimAction,
  VimConsumedResult,
  VimContext,
  VimDisposition,
  VimInputResult,
  VimPassthroughResult,
  VimResult,
} from './types.js';
