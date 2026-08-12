export type VimContext = 'disabled' | 'passthrough' | 'chrome-normal' | 'chrome-search' | 'editor';

export type VimDisposition = 'passthrough' | 'pending' | 'action' | 'unsupported';

export interface NormalizedKey {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export interface VimResult {
  disposition: VimDisposition;
  context: VimContext;
  pending: string;
  actions: readonly VimAction[];
}

export type VimAction =
  | { type: 'chrome.enter' | 'chrome.exit' | 'focus.first' | 'focus.last' | 'focus.activate' }
  | { type: 'focus.move'; direction: 'left' | 'down' | 'up' | 'right' }
  | { type: 'pane.focus'; direction: 'left' | 'down' | 'up' | 'right' }
  | { type: 'pane.cycle' | 'pane.equalize' | 'pane.split-horizontal' | 'pane.split-vertical' }
  | { type: 'pane.resize'; direction: 'grow' | 'shrink' | 'narrow' | 'widen' }
  | { type: 'search.open' | 'search.next' | 'search.previous' | 'target.close' | 'target.refresh' | 'help.open' };

export interface KeyboardEventLike {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly metaKey?: boolean;
}

export interface VimInputResult extends VimResult {
  /** Present exclusively when the adapter must pass the original event through. */
  readonly event?: KeyboardEventLike;
}
