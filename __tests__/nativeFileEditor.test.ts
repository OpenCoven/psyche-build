import { EditorView } from '../native/desktop/psyche-build-tauri/node_modules/@codemirror/view/dist/index.js';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Native browser entry is exercised directly but has no declaration file.
import { createFileEditorState } from '../native/desktop/psyche-build-tauri/web/editor/editor-entry.js';

describe('native file editor', () => {
  it('wraps long lines', () => {
    const state = createFileEditorState({ text: 'a'.repeat(10_000) });

    expect(state.facet(EditorView.contentAttributes)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ class: expect.stringContaining('cm-lineWrapping') }),
      ]),
    );
  });
});
