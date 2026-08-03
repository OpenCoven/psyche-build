import { basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, lineNumbers } from '@codemirror/view';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { toml } from '@codemirror/legacy-modes/mode/toml';

export {
  createFileBuffer,
  createLruCache,
  createRequestGate,
  languageForPath,
  markFileSaved,
  reconcileFileSave,
  shouldRenderFileSaveChrome,
  updateFileBuffer,
} from './workspace-model.mjs';

function extensionForLanguage(id) {
  switch (id) {
    case 'javascript':
    case 'jsx':
      return javascript({ jsx: true });
    case 'typescript':
    case 'tsx':
      return javascript({ typescript: true, jsx: true });
    case 'json':
      return json();
    case 'html':
      return html();
    case 'xml':
      return xml();
    case 'css':
      return css();
    case 'markdown':
      return markdown();
    case 'python':
      return python();
    case 'rust':
      return rust();
    case 'yaml':
      return yaml();
    case 'shell':
      return StreamLanguage.define(shell);
    case 'toml':
      return StreamLanguage.define(toml);
    case 'plain':
    default:
      return [];
  }
}

const workspaceHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: '#cbb8ff' },
  { tag: [tags.name, tags.variableName, tags.propertyName], color: '#f5f2fb' },
  { tag: tags.function(tags.variableName), color: '#8bd5ff' },
  { tag: [tags.typeName, tags.className], color: '#d6b4ff' },
  { tag: [tags.string, tags.character, tags.attributeValue], color: '#8fe3b0' },
  { tag: [tags.number, tags.bool, tags.null], color: '#f5c978' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: '#8f899f' },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: '#c8c2d8' },
], { themeType: 'dark' });

const workspaceEditorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      backgroundColor: 'var(--surface-solid)',
      color: 'var(--text-soft)',
    },
    '&.cm-focused': {
      outline: 'none',
    },
    '.cm-content': {
      caretColor: 'var(--accent)',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--accent)',
    },
    '.cm-activeLine': {
      backgroundColor: 'var(--accent-soft)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'var(--accent-soft)',
      color: 'var(--text-soft)',
    },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      backgroundColor: 'var(--accent-line) !important',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--surface-1)',
      color: 'var(--muted)',
      borderRight: '1px solid var(--border)',
    },
  },
  { dark: true }
);

function normalizeSelection(selection, documentLength) {
  function normalizeOffset(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(documentLength, Math.trunc(value)));
  }

  return {
    anchor: normalizeOffset(selection?.anchor),
    head: normalizeOffset(selection?.head),
  };
}

function selectionPayload(state) {
  const main = state.selection.main;
  const head = main.head;
  const line = state.doc.lineAt(head);
  return {
    anchor: main.anchor,
    head: main.head,
    line: line.number,
    column: head - line.from + 1,
  };
}

export function createFileEditorState({
  text = '',
  languageId = 'plain',
  readOnly = false,
  cspNonce = '',
  selection,
  onChange,
  onSelectionChange,
}) {
  const handleChange = typeof onChange === 'function' ? onChange : () => {};
  const handleSelectionChange =
    typeof onSelectionChange === 'function' ? onSelectionChange : () => {};

  return EditorState.create({
    doc: text,
    selection: normalizeSelection(selection, text.length),
    extensions: [
      basicSetup,
      syntaxHighlighting(workspaceHighlightStyle),
      workspaceEditorTheme,
      extensionForLanguage(languageId),
      EditorView.editable.of(!readOnly),
      EditorState.readOnly.of(readOnly),
      EditorView.cspNonce.of(cspNonce),
      EditorView.contentAttributes.of({ 'aria-label': 'File editor' }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          handleChange(update.state.doc.toString());
        }

        if (update.selectionSet || update.docChanged) {
          handleSelectionChange(selectionPayload(update.state));
        }
      }),
    ],
  });
}

export function createFileEditor({ parent, onChange, onSelectionChange }) {
  const handleChange = typeof onChange === 'function' ? onChange : () => {};
  const handleSelectionChange =
    typeof onSelectionChange === 'function' ? onSelectionChange : () => {};
  const cspNonce = document.getElementById('codemirror-nonce-source').nonce;

  const view = new EditorView({
    parent,
    state: createFileEditorState({
      cspNonce,
      onChange: handleChange,
      onSelectionChange: handleSelectionChange,
    }),
  });

  function setDocument({ text = '', languageId = 'plain', readOnly = false, selection }) {
    view.setState(
      createFileEditorState({
        text,
        languageId,
        readOnly,
        cspNonce,
        selection,
        onChange: handleChange,
        onSelectionChange: handleSelectionChange,
      })
    );
    handleSelectionChange(selectionPayload(view.state));
  }

  function getText() {
    return view.state.doc.toString();
  }

  function focus() {
    view.focus();
  }

  function destroy() {
    view.destroy();
  }

  return { setDocument, getText, focus, destroy };
}

const workspaceDiffTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      backgroundColor: 'var(--surface-solid)',
      color: 'var(--text-soft)',
    },
    '&.cm-focused': {
      outline: 'none',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--surface-1)',
      color: 'var(--muted)',
      borderRight: '1px solid var(--border)',
    },
    '.cm-diff-hunk': {
      backgroundColor: 'var(--accent-soft)',
      color: 'var(--accent)',
    },
    '.cm-diff-meta': {
      color: 'var(--muted)',
    },
    '.cm-diff-add': {
      backgroundColor: 'rgba(80, 200, 140, 0.09)',
      color: 'var(--ok)',
    },
    '.cm-diff-delete': {
      backgroundColor: 'rgba(255, 110, 120, 0.09)',
      color: 'var(--error)',
    },
  },
  { dark: true }
);

export function diffClass(text) {
  if (text.startsWith('@@')) return 'cm-diff-hunk';
  if (/^(?:diff |index |---|\+\+\+)/.test(text)) return 'cm-diff-meta';
  if (text.startsWith('+')) return 'cm-diff-add';
  if (text.startsWith('-')) return 'cm-diff-delete';
  return '';
}

function visibleDiffDecorations(view) {
  const ranges = [];
  const decoratedLines = new Set();

  for (const visible of view.visibleRanges) {
    let line = view.state.doc.lineAt(visible.from);
    while (line.from <= visible.to) {
      if (!decoratedLines.has(line.from)) {
        decoratedLines.add(line.from);
        const className = diffClass(line.text);
        if (className) ranges.push(Decoration.line({ class: className }).range(line.from));
      }
      if (line.to === view.state.doc.length) break;
      line = view.state.doc.lineAt(line.to + 1);
    }
  }

  return Decoration.set(ranges, true);
}

const visibleDiffLines = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = visibleDiffDecorations(view);
    }

    update(update) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = visibleDiffDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
);

export function createDiffViewerState({ text = '', cspNonce = '' } = {}) {
  return EditorState.create({
    doc: text,
    extensions: [
      lineNumbers(),
      workspaceDiffTheme,
      visibleDiffLines,
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      EditorView.cspNonce.of(cspNonce),
      EditorView.contentAttributes.of({ 'aria-label': 'Unified diff viewer' }),
    ],
  });
}

export function createDiffViewer({ parent }) {
  const cspNonce = document.getElementById('codemirror-nonce-source').nonce;
  const view = new EditorView({
    parent,
    state: createDiffViewerState({ cspNonce }),
  });

  function setDiff({ text = '' } = {}) {
    view.setState(createDiffViewerState({ text, cspNonce }));
  }

  function clear() {
    setDiff({ text: '' });
  }

  function destroy() {
    view.destroy();
  }

  return { setDiff, clear, destroy };
}
