export { createChromeMachine, type ChromeMachine, type ChromeMachineOptions } from './chrome-machine.js';
export { validateChromeFixtures, validateVimFixtures, type VimFixtureDocument, type VimFixtureTrace } from './fixtures.js';
export { normalizeKeyboardEvent } from './normalize.js';
export type {
  KeyboardEventLike,
  NormalizedKey,
  VimAction,
  VimContext,
  VimDisposition,
  VimInputResult,
  VimResult,
} from './types.js';
