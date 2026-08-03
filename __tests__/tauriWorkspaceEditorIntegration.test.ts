import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const tauriRoot = join(repoRoot, 'native/macos/psyche-build-tauri');
const webRoot = join(tauriRoot, 'web');
const indexHtml = readFileSync(join(webRoot, 'index.html'), 'utf8');
const editorEntry = readFileSync(join(webRoot, 'editor/editor-entry.js'), 'utf8');
const mainJs = readFileSync(join(webRoot, 'main.js'), 'utf8');
const stylesCss = readFileSync(join(webRoot, 'styles.css'), 'utf8');
const tauriConfig = readFileSync(join(tauriRoot, 'src-tauri/tauri.conf.json'), 'utf8');
const tauriPackage = JSON.parse(
  readFileSync(join(tauriRoot, 'package.json'), 'utf8')
) as { dependencies: Record<string, string> };
const requireFromTauri = createRequire(join(tauriRoot, 'package.json'));

describe('native CodeMirror workspace editor surface', () => {
  it('provides the approved accessible file editor shell', () => {
    for (const id of [
      'file-editor-host',
      'file-save',
      'file-language',
      'file-status',
      'file-view-path',
      'file-view-meta',
      'file-read-only-message',
      'file-cursor',
    ]) {
      expect(indexHtml).toContain(`id="${id}"`);
    }

    expect(indexHtml).not.toContain('<pre class="file-view-body" id="file-view-body">');
    expect(indexHtml).toMatch(
      /<script src="\.\/editor\.bundle\.js" defer><\/script>\s*<script src="\.\/main\.js" defer><\/script>/
    );
    expect(indexHtml).toMatch(/id="file-save"[^>]*type="button"[^>]*disabled/);
    expect(indexHtml).toMatch(/id="file-read-only-message"[^>]*role="status"[^>]*hidden/);
  });

  it('provides Tauri a dynamic style nonce source without weakening CSP', () => {
    expect(indexHtml).toContain('<style id="codemirror-nonce-source"></style>');
    expect(indexHtml).not.toMatch(/id="codemirror-nonce-source"[^>]+nonce=/);
    expect(editorEntry).toContain(
      "document.getElementById('codemirror-nonce-source').nonce"
    );
    expect(editorEntry).toContain('EditorView.cspNonce.of(cspNonce)');
    expect(tauriConfig).not.toContain("'unsafe-inline'");
    expect(tauriConfig).not.toMatch(/'nonce-[^']+'/);
  });

  it('uses only pinned local CodeMirror language packages', () => {
    for (const dependency of [
      '@codemirror/lang-css',
      '@codemirror/lang-html',
      '@codemirror/lang-javascript',
      '@codemirror/lang-json',
      '@codemirror/lang-markdown',
      '@codemirror/lang-python',
      '@codemirror/lang-rust',
      '@codemirror/lang-xml',
      '@codemirror/lang-yaml',
      '@codemirror/language',
      '@codemirror/legacy-modes',
      '@codemirror/commands',
      '@codemirror/state',
      '@codemirror/view',
      'codemirror',
    ]) {
      expect(tauriPackage.dependencies[dependency]).toMatch(/^\d+\.\d+\.\d+$/);
    }

    expect(editorEntry).toMatch(/from ['"]codemirror['"]/);
    expect(editorEntry).toMatch(/from ['"]@codemirror\/state['"]/);
    expect(editorEntry).toMatch(/from ['"]@codemirror\/view['"]/);
    expect(editorEntry).toMatch(/from ['"]@codemirror\/language['"]/);
    for (const languagePackage of [
      'lang-css',
      'lang-html',
      'lang-javascript',
      'lang-json',
      'lang-markdown',
      'lang-python',
      'lang-rust',
      'lang-xml',
      'lang-yaml',
    ]) {
      expect(editorEntry).toContain(`from '@codemirror/${languagePackage}'`);
    }
    expect(editorEntry).toContain("from '@codemirror/legacy-modes/mode/shell'");
    expect(editorEntry).toContain("from '@codemirror/legacy-modes/mode/toml'");
  });

  it('overrides the default token colors with a dark workspace highlight style', () => {
    expect(tauriPackage.dependencies['@lezer/highlight']).toBe('1.2.3');
    expect(editorEntry).toMatch(
      /import \{[^}]*HighlightStyle[^}]*syntaxHighlighting[^}]*\} from '@codemirror\/language'/
    );
    expect(editorEntry).toContain("import { tags } from '@lezer/highlight'");
    expect(editorEntry).toContain('const workspaceHighlightStyle = HighlightStyle.define([');
    expect(editorEntry).toContain("{ tag: tags.keyword, color: '#cbb8ff' }");
    expect(editorEntry).toContain(
      "{ tag: [tags.name, tags.variableName, tags.propertyName], color: '#f5f2fb' }"
    );
    expect(editorEntry).toContain(
      "{ tag: tags.function(tags.variableName), color: '#8bd5ff' }"
    );
    expect(editorEntry).toContain(
      "{ tag: [tags.typeName, tags.className], color: '#d6b4ff' }"
    );
    expect(editorEntry).toContain(
      "{ tag: [tags.string, tags.character, tags.attributeValue], color: '#8fe3b0' }"
    );
    expect(editorEntry).toContain(
      "{ tag: [tags.number, tags.bool, tags.null], color: '#f5c978' }"
    );
    expect(editorEntry).toContain(
      "{ tag: [tags.comment, tags.lineComment, tags.blockComment], color: '#8f899f' }"
    );
    expect(editorEntry).toContain(
      "{ tag: [tags.operator, tags.punctuation, tags.bracket], color: '#c8c2d8' }"
    );
    expect(editorEntry).toMatch(
      /basicSetup,\s*syntaxHighlighting\(workspaceHighlightStyle\),/
    );
  });

  it('maps every approved language with a plain-text fallback', () => {
    for (const languageId of [
      'javascript',
      'typescript',
      'jsx',
      'tsx',
      'json',
      'html',
      'xml',
      'css',
      'markdown',
      'python',
      'rust',
      'yaml',
      'shell',
      'toml',
    ]) {
      expect(editorEntry).toContain(`case '${languageId}':`);
    }

    expect(editorEntry).toContain('javascript({ typescript: true, jsx: true })');
    expect(editorEntry).toContain('StreamLanguage.define(shell)');
    expect(editorEntry).toContain('StreamLanguage.define(toml)');
    expect(editorEntry).toMatch(/default:\s*return \[\];/);
  });

  it('starts every loaded document with isolated undo history', async () => {
    expect(tauriPackage.dependencies['@codemirror/commands']).toBe('6.10.4');

    const editorModule = await import(
      pathToFileURL(join(webRoot, 'editor/editor-entry.js')).href
    );
    const commandsModule = await import(
      pathToFileURL(requireFromTauri.resolve('@codemirror/commands')).href
    );
    const stateA = editorModule.createFileEditorState({
      text: 'alpha',
      languageId: 'plain',
      readOnly: false,
      cspNonce: 'test-nonce',
    });
    const editedA = stateA.update({
      changes: { from: stateA.doc.length, insert: ' edited' },
    }).state;

    expect(commandsModule.undoDepth(editedA)).toBe(1);

    const stateB = editorModule.createFileEditorState({
      text: 'bravo',
      languageId: 'plain',
      readOnly: false,
      cspNonce: 'test-nonce',
    });

    expect(stateB.doc.toString()).toBe('bravo');
    expect(commandsModule.undoDepth(stateB)).toBe(0);
  });

  it('restores each document selection independently and clamps stale offsets', async () => {
    const editorModule = await import(
      pathToFileURL(join(webRoot, 'editor/editor-entry.js')).href
    );
    const stateA = editorModule.createFileEditorState({
      text: 'alpha',
      languageId: 'plain',
      selection: { anchor: 1, head: 4 },
      cspNonce: 'test-nonce',
    });
    const editedA = stateA.update({
      changes: { from: stateA.doc.length, insert: ' edited' },
      selection: { anchor: 2, head: 9 },
    }).state;
    const savedSelectionA = {
      anchor: editedA.selection.main.anchor,
      head: editedA.selection.main.head,
    };

    const stateB = editorModule.createFileEditorState({
      text: 'bravo',
      languageId: 'plain',
      selection: { anchor: 5, head: 5 },
      cspNonce: 'test-nonce',
    });
    const restoredA = editorModule.createFileEditorState({
      text: editedA.doc.toString(),
      languageId: 'plain',
      selection: savedSelectionA,
      cspNonce: 'test-nonce',
    });
    const clamped = editorModule.createFileEditorState({
      text: 'tiny',
      languageId: 'plain',
      selection: { anchor: -10, head: 100 },
      cspNonce: 'test-nonce',
    });
    const defaulted = editorModule.createFileEditorState({
      text: 'plain',
      languageId: 'plain',
      cspNonce: 'test-nonce',
    });
    const invalid = editorModule.createFileEditorState({
      text: 'plain',
      languageId: 'plain',
      selection: { anchor: Number.NaN, head: Number.POSITIVE_INFINITY },
      cspNonce: 'test-nonce',
    });

    expect(stateB.selection.main).toMatchObject({ anchor: 5, head: 5 });
    expect(restoredA.selection.main).toMatchObject(savedSelectionA);
    expect(clamped.selection.main).toMatchObject({ anchor: 0, head: 4 });
    expect(defaulted.selection.main).toMatchObject({ anchor: 0, head: 0 });
    expect(invalid.selection.main).toMatchObject({ anchor: 0, head: 0 });
  });

  it('exports the model and guarded editor bridge API', () => {
    for (const modelApi of [
      'createFileBuffer',
      'createLruCache',
      'createRequestGate',
      'languageForPath',
      'markFileSaved',
      'updateFileBuffer',
    ]) {
      expect(editorEntry).toMatch(new RegExp(`\\b${modelApi},`));
    }

    expect(editorEntry).toMatch(/export function createFileEditor\s*\(/);
    expect(editorEntry).toMatch(/export function createFileEditorState\s*\(/);
    expect(editorEntry).toContain('basicSetup');
    expect(editorEntry).toContain('EditorView.editable.of(!readOnly)');
    expect(editorEntry).toContain('EditorState.readOnly.of(readOnly)');
    expect(editorEntry).toContain(
      "EditorView.contentAttributes.of({ 'aria-label': 'File editor' })"
    );
    expect(editorEntry).toContain('EditorView.updateListener.of');
    expect(editorEntry).toMatch(/if \(update\.docChanged\) \{/);
    expect(editorEntry).toMatch(/update\.selectionSet\s*\|\|\s*update\.docChanged/);
    expect(editorEntry).toContain('line: line.number');
    expect(editorEntry).toContain('column: head - line.from + 1');
    expect(editorEntry).toMatch(/return \{\s*setDocument,\s*getText,\s*focus,\s*destroy,?\s*\}/);
    expect(editorEntry).toMatch(
      /view\.setState\(\s*createFileEditorState\(\{[\s\S]*text,[\s\S]*languageId,[\s\S]*readOnly,/
    );
    expect(editorEntry).toContain('selectionPayload(view.state)');
    expect(editorEntry).toContain('anchor: main.anchor');
    expect(editorEntry).toContain('head: main.head');
  });

  it('gives CodeMirror one bounded scroll surface using the workspace palette', () => {
    expect(stylesCss).toMatch(
      /\.file-view\s*\{[\s\S]*grid-template-rows:\s*auto auto minmax\(0, 1fr\) auto;/
    );
    expect(stylesCss).toMatch(/\.file-editor-host\s*\{[\s\S]*overflow:\s*hidden;/);
    expect(stylesCss).toMatch(/\.file-editor-host \.cm-editor\s*\{[\s\S]*height:\s*100%;/);
    expect(stylesCss).toMatch(/\.file-editor-host \.cm-scroller\s*\{[\s\S]*overflow:\s*auto;/);
    expect(stylesCss).toMatch(/\.file-editor-host \.cm-content\s*\{[\s\S]*font-family:\s*var\(--font-mono\);/);
    expect(stylesCss).toMatch(/\.file-editor-host \.cm-gutters\s*\{[\s\S]*var\(--surface/);
    expect(stylesCss).toMatch(/\.file-editor-host \.cm-selectionBackground[\s\S]*var\(--accent/);
    expect(stylesCss).toContain('.file-view[hidden]');
  });

  it('stores editable file state and wires one editor to the active file only', () => {
    for (const field of [
      'originalText',
      'dirty',
      'saving',
      'languageId',
      'cursor',
      'selection',
    ]) {
      expect(mainJs).toMatch(new RegExp(`\\b${field}:`));
    }

    expect(mainJs).toMatch(
      /var fileEditor = window\.PsycheCodeEditor\.createFileEditor\(\{/
    );
    expect(mainJs.match(/createFileEditor\(\{/g)).toHaveLength(1);
    expect(mainJs).toMatch(
      /onChange:\s*function \(text\) \{[\s\S]*findOpenFile\(state\.activeFileId\)[\s\S]*updateFileBuffer\(file, text\)/
    );
    expect(mainJs).toMatch(
      /onSelectionChange:\s*function \(position\) \{[\s\S]*file\.selection = \{ anchor: position\.anchor, head: position\.head \}[\s\S]*file\.cursor = \{ line: position\.line, column: position\.column \}/
    );
    expect(mainJs).not.toContain('fileViewBodyEl');
    expect(mainJs).toMatch(
      /if \(loadedEditorFileId !== file\.id \|\| options\.reload\) \{[\s\S]*fileEditor\.setDocument\(\{/
    );
    expect(mainJs).toMatch(
      /readOnly:\s*!isEditableFile\(file\)/
    );
    expect(mainJs).toMatch(/selection:\s*file\.selection/);
  });

  it('saves the active dirty file explicitly and refreshes project Git data', () => {
    expect(mainJs).toMatch(/async function saveFile\(file\)/);
    expect(mainJs).toMatch(
      /invoke\("fs_write_text",\s*\{\s*root:\s*project\.root,\s*path:\s*file\.path,\s*text:\s*file\.text,\s*expectedText:\s*file\.originalText,?\s*\}\)/
    );
    expect(mainJs).toMatch(/Object\.assign\(file, window\.PsycheCodeEditor\.markFileSaved\(file, saved\.text\)/);
    expect(mainJs).toContain('invalidateProjectDiffs(project.id)');
    expect(mainJs).toMatch(/currentPanel\(\) === "diffs"[\s\S]*renderDiffsPanel\(\)/);
    expect(mainJs).toMatch(/currentPanel\(\) === "git"[\s\S]*renderGitPanel\(\)/);
    expect(mainJs).toMatch(/fileSaveEl\.addEventListener\("click", function \(\) \{[\s\S]*saveFile\(findOpenFile\(state\.activeFileId\)\)/);
    expect(mainJs).toMatch(
      /String\(e\.key\)\.toLowerCase\(\) === "s"[\s\S]*saveFile\(findOpenFile\(state\.activeFileId\)\)[\s\S]*e\.preventDefault\(\)/
    );
  });

  it('renders dirty, saving, saved, error, and read-only file chrome', () => {
    expect(mainJs).toMatch(/class="[^"]*\bdirty-dot\b[^"]*"/);
    expect(mainJs).toMatch(/fileDirtyEl\.hidden = !file\.dirty/);
    expect(mainJs).toMatch(/fileSaveEl\.disabled = !isEditableFile\(file\) \|\| !file\.dirty \|\| file\.saving/);
    for (const status of ['Modified', 'Saving…', 'Saved', 'Save failed:']) {
      expect(mainJs).toContain(status);
    }
    expect(mainJs).toMatch(/fileReadOnlyMessageEl\.hidden = editable/);
  });
});
