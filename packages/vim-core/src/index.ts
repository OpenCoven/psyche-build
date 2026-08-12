export { createChromeMachine, type ChromeMachine, type ChromeMachineOptions } from './chrome-machine.js';
export { validateChromeFixtures, validateVimFixtures, type VimFixtureDocument, type VimFixtureTrace } from './fixtures.js';
export { normalizeKeyboardEvent } from './normalize.js';
export { createEditorMachine, EDITOR_LIMITS } from './editor-machine.js';
export type {
  EditorAction,
  EditorDocumentPort,
  EditorInput,
  EditorMachine,
  EditorMachineOptions,
  EditorMode,
  EditorRegister,
  EditorResult,
  EditorSearchState,
  EditorSelection,
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
