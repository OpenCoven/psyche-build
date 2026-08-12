import type { KeyboardEventLike } from '../types.js';

export type EditorMode =
  | 'normal'
  | 'insert'
  | 'replace'
  | 'visual-character'
  | 'visual-line'
  | 'visual-block'
  | 'command-line'
  | 'search';

export interface EditorTextInput {
  readonly kind: 'text';
  readonly text: string;
  readonly source?: 'composition' | 'beforeinput';
}

export interface EditorPasteInput {
  readonly kind: 'paste';
  readonly text: string;
}

export type EditorInput = string | KeyboardEventLike | EditorTextInput | EditorPasteInput;
export type EditorSelection = { anchor: number; head: number };

export interface EditorChange {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

export interface EditorTransaction {
  /** Sorted, non-overlapping changes in pre-transaction coordinates. */
  readonly changes: readonly EditorChange[];
  /** Selections in post-transaction coordinates. */
  readonly selections: readonly EditorSelection[];
  readonly history: 'join' | 'new';
}

export type EditorCapabilityCommand =
  | 'save'
  | 'save-all'
  | 'close'
  | 'force-close'
  | 'next-buffer'
  | 'previous-buffer';

export interface EditorDocumentPort {
  text(): string;
  selections(): readonly EditorSelection[];
  /** The adapter must apply all changes and selections atomically or leave the document unchanged. */
  apply(transaction: EditorTransaction): void;
  command(action: EditorCapabilityCommand, argument?: string): Promise<boolean>;
}

export type EditorAction =
  | { type: 'mode'; mode: EditorMode }
  | { type: 'status'; level: 'info' | 'error'; message: string }
  | { type: 'search'; query: string; direction: 'forward' | 'backward'; active: boolean }
  | { type: 'option'; name: string; enabled: boolean }
  | { type: 'mark.set-global'; mark: string; reference: EditorGlobalMarkReference }
  | { type: 'mark.jump-global'; mark: string; reference: EditorGlobalMarkReference; linewise: boolean }
  | { type: 'command'; command: EditorCapabilityCommand; success: boolean };

export interface EditorGlobalMarkReference {
  readonly buffer: string;
  readonly position: number;
}

export interface EditorGlobalMarkStore {
  get(mark: string): EditorGlobalMarkReference | undefined;
  set(mark: string, reference: EditorGlobalMarkReference): void;
}

export interface EditorRegister {
  readonly text: string;
  readonly linewise: boolean;
}

export interface EditorSearchState {
  readonly pattern: string;
  readonly direction: 'forward' | 'backward';
  readonly highlight: boolean;
  readonly wholeWord?: boolean;
}

export interface EditorResult {
  readonly mode: EditorMode;
  readonly pending: string;
  readonly count: number | undefined;
  readonly actions: readonly EditorAction[];
  readonly search?: EditorSearchState;
}

export interface EditorMachine {
  readonly limits: typeof import('./limits.js').EDITOR_LIMITS;
  handle(input: EditorInput): Promise<EditorResult>;
  executeEx(command: string): Promise<EditorResult>;
  snapshot(): EditorResult;
  register(name: string): EditorRegister | undefined;
  setRegister(name: string, text: string, linewise?: boolean): boolean;
  mark(name: string): number | undefined;
  exHistory(): readonly string[];
}

export interface EditorMachineOptions {
  readonly clipboardRegisters?: boolean;
  readonly bufferId?: string;
  readonly globalMarks?: EditorGlobalMarkStore;
  readonly ignoreCase?: boolean;
  readonly smartCase?: boolean;
}
