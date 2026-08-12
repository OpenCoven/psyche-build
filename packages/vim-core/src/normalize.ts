import type { KeyboardEventLike, NormalizedKey } from './types.js';

const keyAliases: Readonly<Record<string, string>> = {
  Esc: 'Escape',
  Spacebar: ' ',
};

/** Converts only the cross-platform keyboard fields used by the semantic core. */
export function normalizeKeyboardEvent(event: KeyboardEventLike): NormalizedKey {
  const aliasedKey = keyAliases[event.key] ?? event.key;
  const key = aliasedKey.length === 1 ? aliasedKey.toLowerCase() : aliasedKey;

  return {
    key,
    ctrl: event.ctrlKey === true,
    alt: event.altKey === true,
    shift: event.shiftKey === true,
    meta: event.metaKey === true,
  };
}
