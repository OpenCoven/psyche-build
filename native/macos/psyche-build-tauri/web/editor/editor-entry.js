import { basicSetup } from 'codemirror';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { StreamLanguage } from '@codemirror/language';
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

export function createFileEditor({ parent, onChange, onSelectionChange }) {
  const handleChange = typeof onChange === 'function' ? onChange : () => {};
  const handleSelectionChange =
    typeof onSelectionChange === 'function' ? onSelectionChange : () => {};
  const languageCompartment = new Compartment();
  const editableCompartment = new Compartment();
  const readOnlyCompartment = new Compartment();
  let settingDocument = false;

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: '',
      extensions: [
        basicSetup,
        workspaceEditorTheme,
        languageCompartment.of([]),
        editableCompartment.of(EditorView.editable.of(true)),
        readOnlyCompartment.of(EditorState.readOnly.of(false)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !settingDocument) {
            handleChange(update.state.doc.toString());
          }

          if (update.selectionSet || update.docChanged) {
            const head = update.state.selection.main.head;
            const line = update.state.doc.lineAt(head);
            handleSelectionChange({
              line: line.number,
              column: head - line.from + 1,
            });
          }
        }),
      ],
    }),
  });

  function setDocument({ text = '', languageId = 'plain', readOnly = false }) {
    settingDocument = true;
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: 0 },
        effects: [
          languageCompartment.reconfigure(extensionForLanguage(languageId)),
          editableCompartment.reconfigure(EditorView.editable.of(!readOnly)),
          readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)),
        ],
      });
    } finally {
      settingDocument = false;
    }
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
