import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const webRoot = join(repoRoot, 'native/macos/psyche-build-tauri/web');
const indexHtml = readFileSync(join(webRoot, 'index.html'), 'utf8');
const editorEntry = readFileSync(join(webRoot, 'editor/editor-entry.js'), 'utf8');
const stylesCss = readFileSync(join(webRoot, 'styles.css'), 'utf8');
const tauriPackage = JSON.parse(
  readFileSync(join(repoRoot, 'native/macos/psyche-build-tauri/package.json'), 'utf8')
) as { dependencies: Record<string, string> };

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
    expect(editorEntry).toContain('basicSetup');
    expect(editorEntry).toMatch(/new Compartment\(\)/);
    expect(editorEntry).toContain('EditorView.editable.of(!readOnly)');
    expect(editorEntry).toContain('EditorState.readOnly.of(readOnly)');
    expect(editorEntry).toContain('EditorView.updateListener.of');
    expect(editorEntry).toMatch(/update\.docChanged\s*&&\s*!settingDocument/);
    expect(editorEntry).toMatch(/update\.selectionSet\s*\|\|\s*update\.docChanged/);
    expect(editorEntry).toContain('line: line.number');
    expect(editorEntry).toContain('column: head - line.from + 1');
    expect(editorEntry).toMatch(/return \{\s*setDocument,\s*getText,\s*focus,\s*destroy,?\s*\}/);
    expect(editorEntry).toMatch(/changes:\s*\{\s*from:\s*0,\s*to:\s*view\.state\.doc\.length,\s*insert:\s*text/);
    expect(editorEntry).toMatch(/selection:\s*\{\s*anchor:\s*0\s*\}/);
    expect(editorEntry).toMatch(
      /settingDocument = true;[\s\S]*try \{[\s\S]*view\.dispatch\([\s\S]*finally \{\s*settingDocument = false;/
    );
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
});
