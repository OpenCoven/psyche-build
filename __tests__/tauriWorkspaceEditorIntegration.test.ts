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

function extractFunctionSource(source: string, name: string) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const syncStart = source.indexOf(`function ${name}(`);
  const start = asyncStart === -1 ? syncStart : asyncStart;
  if (start === -1) throw new Error(`missing function ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated async function ${name}`);
}

function compileFunction<T extends (...args: never[]) => unknown>(
  source: string,
  dependencies: Record<string, unknown>
) {
  const names = Object.keys(dependencies);
  const values = Object.values(dependencies);
  return Function(...names, `"use strict"; return (${source});`)(...values) as T;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

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
      /<script src="\.\/editor\.bundle\.js" defer><\/script>\s*<script src="\.\/sessions\.bundle\.js" defer><\/script>\s*<script src="\.\/main\.js" defer><\/script>/
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
      'reconcileFileSave',
      'shouldRenderFileSaveChrome',
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

  it('provides one accessible virtualized read-only unified diff surface', async () => {
    expect(indexHtml).toContain('id="diff-editor-host"');
    expect(indexHtml).toContain('id="diff-metadata"');
    expect(indexHtml).toContain('id="diff-truncation"');
    expect(indexHtml).not.toContain('<pre class="diff-body" id="diff-body">');

    expect(editorEntry).toMatch(/export function createDiffViewer\s*\(/);
    expect(editorEntry).toMatch(/export function createDiffViewerState\s*\(/);
    expect(editorEntry).toContain('EditorView.editable.of(false)');
    expect(editorEntry).toContain('EditorState.readOnly.of(true)');
    expect(editorEntry).toMatch(
      /EditorView\.contentAttributes\.of\(\{[\s\S]*'aria-label': 'Unified diff viewer',[\s\S]*'aria-readonly': 'true',[\s\S]*tabindex: '0'/
    );
    expect(editorEntry).toContain('ViewPlugin.fromClass');
    expect(editorEntry).toContain('view.visibleRanges');
    expect(editorEntry).toContain('update.viewportChanged');
    expect(extractFunctionSource(editorEntry, 'createDiffViewerState')).not.toContain('basicSetup');

    const editorModule = await import(
      pathToFileURL(join(webRoot, 'editor/editor-entry.js')).href
    );
    const diffState = editorModule.createDiffViewerState({
      text: '@@ -1 +1 @@\n-old\n+new',
      cspNonce: 'test-nonce',
    });
    const stateModule = await import(
      pathToFileURL(requireFromTauri.resolve('@codemirror/state')).href
    );
    const viewModule = await import(
      pathToFileURL(requireFromTauri.resolve('@codemirror/view')).href
    );

    expect(diffState.facet(stateModule.EditorState.readOnly)).toBe(true);
    expect(diffState.facet(viewModule.EditorView.editable)).toBe(false);
    expect(diffState.facet(viewModule.EditorView.contentAttributes)).toContainEqual({
      'aria-label': 'Unified diff viewer',
      'aria-readonly': 'true',
      tabindex: '0',
    });
    expect(editorModule.diffClass('@@ -1 +1 @@')).toBe('cm-diff-hunk');
    expect(editorModule.diffClass('+++ b/file')).toBe('cm-diff-meta');
    expect(editorModule.diffClass('--- a/file')).toBe('cm-diff-meta');
    expect(editorModule.diffClass('+added')).toBe('cm-diff-add');
    expect(editorModule.diffClass('-deleted')).toBe('cm-diff-delete');
  });

  it('coordinates structured diff responses with exact cache and request identity', () => {
    expect(mainJs).toContain('window.PsycheCodeEditor.createLruCache(6)');
    expect(mainJs).toContain('window.PsycheCodeEditor.createRequestGate()');
    expect(mainJs).toMatch(/function diffCacheKey\(projectId, path, staged\)/);
    expect(mainJs).toContain('projectId + "\\0" + path + "\\0" + (staged ? "staged" : "unstaged")');
    expect(mainJs).toContain('key.startsWith(projectId + "\\0")');
    expect(mainJs).toMatch(/diffCache\.get\(key\)[\s\S]*invoke\("git_diff"/);
    expect(mainJs).toContain('diffRequestGate.isCurrent(generation)');
    expect(mainJs).toContain('selectedDiffKey === key');
    expect(mainJs).toContain('result.truncated');
    expect(mainJs).toContain('result.lines');
    expect(mainJs).toContain('result.bytes');
    expect(mainJs).not.toContain('diffBodyEl');
    expect(mainJs).not.toContain('colourDiff(');
    expect(extractFunctionSource(mainJs, 'invalidateProjectDiffs')).toContain(
      'diffCache.deleteWhere(function (key) { return key.startsWith(projectId + "\\0"); })'
    );
    expect(extractFunctionSource(mainJs, 'refreshDiffs')).toMatch(
      /invalidateProjectDiffs\(project\.id\)[\s\S]*renderDiffsPanel\(\)/
    );
    expect(extractFunctionSource(mainJs, 'renderDiffsPanel')).toMatch(
      /if \(!panelIsVisible\("diffs"\)\) return;/
    );
    expect(extractFunctionSource(mainJs, 'performFileSave')).toMatch(
      /invalidateProjectDiffs\(project\.id\);[\s\S]*if \(panelIsVisible\("diffs"\)\) renderDiffsPanel\(\);/
    );
  });

  it('suspends pending diffs on collapse and refreshes the active panel on reopen', () => {
    expect(extractFunctionSource(mainJs, 'applyLayout')).toMatch(
      /handlePanelLayoutTransition\(previousLayout, layout\)/
    );
    const transitions: string[] = [];
    const handlePanelLayoutTransition = compileFunction<
      (previous: string, next: string) => void
    >(extractFunctionSource(mainJs, 'handlePanelLayoutTransition'), {
      currentPanel: () => 'diffs',
      suspendDiffRequests: () => { transitions.push('suspend'); },
      renderPanel: (panel: string) => { transitions.push(`render:${panel}`); },
    });

    handlePanelLayoutTransition('split', 'terminal');
    handlePanelLayoutTransition('terminal', 'split');

    expect(transitions).toEqual(['suspend', 'render:diffs']);
  });

  it('does not render hidden panels and clears stale diff summaries on status errors', async () => {
    const panelIsVisible = compileFunction<(panel: string) => boolean>(
      extractFunctionSource(mainJs, 'panelIsVisible'),
      { currentLayout: () => 'terminal', currentPanel: () => 'diffs' },
    );
    expect(panelIsVisible('diffs')).toBe(false);

    const summary = { textContent: '3 changed' };
    const messages: string[] = [];
    const renderDiffsPanel = compileFunction<() => Promise<void>>(
      extractFunctionSource(mainJs, 'renderDiffsPanel'),
      {
        diffFilesEl: {},
        panelIsVisible: () => true,
        activeProject: () => ({ id: 'p1', root: '/repo' }),
        diffPanelRequestGate: { next: () => 1, isCurrent: () => true },
        diffRequestGate: { next: () => 1 },
        resetDiffDetail: (message: string) => { messages.push(message); },
        diffsSummaryEl: summary,
        invoke: async () => { throw new Error('status unavailable'); },
        panelMessage: () => undefined,
        clearDiffSelection: () => undefined,
        currentPanel: () => 'diffs',
        currentLayout: () => 'split',
      },
    );

    await renderDiffsPanel();
    expect(messages).toEqual(['Loading changes…']);
    expect(summary.textContent).toBe('error');
  });

  it('serves cached diffs without invoking and ignores stale results and errors', async () => {
    const source = extractFunctionSource(mainJs, 'showDiff');
    const project = { id: 'p1', root: '/repo' };
    const entry = { path: 'src/a.ts', staged: false, unstaged: true };
    const result = { text: '+cached', bytes: 7, lines: 1, truncated: false };
    const renderCalls: unknown[] = [];
    let invokeCalls = 0;
    const common = {
      diffEditorHostEl: {},
      activeProject: () => project,
      currentPanel: () => 'diffs',
      currentLayout: () => 'split',
      panelIsVisible: () => true,
      stagedDiffFor: () => false,
      diffCacheKey: () => 'p1\0src/a.ts\0unstaged',
      diffRequestGate: { next: () => 1 },
      selectedDiffPath: null,
      selectedDiffKey: null,
      diffFilesEl: {
        parentNode: { classList: { add: () => undefined } },
        children: [],
      },
    };
    const cachedShowDiff = compileFunction<
      (owner: typeof project, target: typeof entry) => Promise<void>
    >(source, {
      ...common,
      diffCache: { get: () => result, set: () => undefined },
      currentDiffRequestMatches: () => true,
      renderDiffResult: (value: unknown) => { renderCalls.push(value); },
      resetDiffDetail: () => undefined,
      invoke: async () => { invokeCalls += 1; return result; },
    });

    await cachedShowDiff(project, entry);
    expect(invokeCalls).toBe(0);
    expect(renderCalls).toEqual([result]);

    const stale = deferred<typeof result>();
    const staleRenders: unknown[] = [];
    let cacheWrites = 0;
    const staleShowDiff = compileFunction<
      (owner: typeof project, target: typeof entry) => Promise<void>
    >(source, {
      ...common,
      diffCache: {
        get: () => undefined,
        set: () => { cacheWrites += 1; },
      },
      currentDiffRequestMatches: () => false,
      renderDiffResult: (value: unknown) => { staleRenders.push(value); },
      resetDiffDetail: () => undefined,
      invoke: () => stale.promise,
    });
    const staleRequest = staleShowDiff(project, entry);
    stale.resolve(result);
    await staleRequest;
    expect(cacheWrites).toBe(0);
    expect(staleRenders).toEqual([]);

    let resets = 0;
    const staleErrorShowDiff = compileFunction<
      (owner: typeof project, target: typeof entry) => Promise<void>
    >(source, {
      ...common,
      diffCache: { get: () => undefined, set: () => undefined },
      currentDiffRequestMatches: () => false,
      renderDiffResult: () => undefined,
      resetDiffDetail: () => { resets += 1; },
      invoke: async () => { throw new Error('old request'); },
    });
    await staleErrorShowDiff(project, entry);
    expect(resets).toBe(1);
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
      'savePromise',
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
    expect(mainJs).toMatch(/function saveFile\(file\)/);
    expect(mainJs).toMatch(/async function performFileSave\(file\)/);
    expect(mainJs).toMatch(
      /invoke\("fs_write_text",\s*\{\s*root:\s*file\.workspaceRoot\s*\|\|\s*project\.root,\s*path:\s*file\.path,\s*text:\s*file\.text,\s*expectedText:\s*file\.originalText,?\s*\}\)/
    );
    expect(mainJs).toContain('window.PsycheCodeEditor.reconcileFileSave(');
    expect(mainJs).toMatch(/backendSucceeded: true,[\s\S]*canContinue: saveOutcome\.canContinue/);
    expect(
      mainJs.match(/window\.PsycheCodeEditor\.shouldRenderFileSaveChrome\(/g)
    ).toHaveLength(4);
    expect(mainJs).toMatch(
      /file\.saving = true;[\s\S]*shouldRenderFileSaveChrome\(state\.activeFileId, file\.id\)[\s\S]*renderFileChrome\(file\)[\s\S]*try \{/
    );
    expect(mainJs).toMatch(
      /if \(!project\) \{[\s\S]*file\.saveError = "Project is no longer open\.";[\s\S]*shouldRenderFileSaveChrome\(state\.activeFileId, file\.id\)[\s\S]*renderFileChrome\(file\)[\s\S]*return false;/
    );
    expect(mainJs).toMatch(
      /catch \(error\) \{[\s\S]*shouldRenderFileSaveChrome\(state\.activeFileId, file\.id\)[\s\S]*renderFileChrome\(file\)[\s\S]*return false;/
    );
    expect(mainJs).toContain('invalidateProjectDiffs(project.id)');
    expect(mainJs).toMatch(/panelIsVisible\("diffs"\)[\s\S]*renderDiffsPanel\(\)/);
    expect(mainJs).toMatch(/currentPanel\(\) === "git"[\s\S]*renderGitPanel\(\)/);
    expect(mainJs).toMatch(/fileSaveEl\.addEventListener\("click", function \(\) \{[\s\S]*saveFile\(findOpenFile\(state\.activeFileId\)\)/);
    expect(extractFunctionSource(mainJs, 'handleExplicitFileSave')).toMatch(
      /event\.preventDefault\(\)[\s\S]*saveFile\(findOpenFile\(state\.activeFileId\)\)/
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

  it('provides one accessible native decision dialog for dirty and conflict flows', () => {
    expect(indexHtml.match(/<dialog\b/g)).toHaveLength(1);
    expect(indexHtml).toMatch(/<dialog[^>]*id="dirty-file-dialog"[^>]*>/);
    for (const id of [
      'dirty-file-title',
      'dirty-file-message',
      'dirty-file-save',
      'dirty-file-discard',
      'dirty-file-cancel',
      'dirty-file-reload',
      'dirty-file-keep-editing',
    ]) {
      expect(indexHtml).toContain(`id="${id}"`);
    }
    expect(mainJs).toMatch(/function showFileDecision\s*\(\{ mode, file \}\)/);
    expect(mainJs).toContain('dirtyFileDialogEl.showModal()');
    expect(mainJs).toMatch(/event\.key === "Escape"[\s\S]*event\.preventDefault\(\)/);
    expect(mainJs).toMatch(/event\.target === dirtyFileDialogEl/);
    expect(stylesCss).toMatch(/\.file-decision-dialog::backdrop\s*\{/);
  });

  it('guards dirty files with save, discard, and cancel semantics', async () => {
    const source = extractFunctionSource(mainJs, 'guardDirtyFile');
    const decisions = ['cancel', 'discard', 'save'];
    const saved: string[] = [];
    const discarded: string[] = [];
    let focusCount = 0;
    const guardDirtyFile = compileFunction<
      (file: { name: string; dirty: boolean }) => Promise<boolean>
    >(source, {
      showFileDecision: async () => decisions.shift(),
      saveFile: async (file: { name: string; dirty: boolean }) => {
        saved.push(file.name);
        file.dirty = false;
        return { backendSucceeded: true, canContinue: true };
      },
      discardFile: (file: { name: string; dirty: boolean }) => {
        discarded.push(file.name);
        file.dirty = false;
      },
      restoreFileEditorFocus: () => { focusCount += 1; },
    });
    const clean = { name: 'clean', dirty: false };
    const cancel = { name: 'cancel', dirty: true };
    const discard = { name: 'discard', dirty: true };
    const save = { name: 'save', dirty: true };

    await expect(guardDirtyFile(clean)).resolves.toBe(true);
    await expect(guardDirtyFile(cancel)).resolves.toBe(false);
    await expect(guardDirtyFile(discard)).resolves.toBe(true);
    await expect(guardDirtyFile(save)).resolves.toBe(true);
    expect(discarded).toEqual(['discard']);
    expect(saved).toEqual(['save']);
    expect(focusCount).toBe(1);
  });

  it('guards multiple dirty files in deterministic order and stops on failure', async () => {
    const source = extractFunctionSource(mainJs, 'guardDirtyFiles');
    const visited: string[] = [];
    const guardDirtyFiles = compileFunction<
      (files: Array<{ name: string }>) => Promise<boolean>
    >(source, {
      guardDirtyFile: async (file: { name: string }) => {
        visited.push(file.name);
        return file.name !== 'second';
      },
    });

    await expect(guardDirtyFiles([
      { name: 'first' }, { name: 'second' }, { name: 'third' },
    ])).resolves.toBe(false);
    expect(visited).toEqual(['first', 'second']);
  });

  it('reveals an inactive dirty file when an ordered batch save fails', async () => {
    const active = { id: 'active', name: 'active.ts', dirty: true };
    const inactive = { id: 'inactive', name: 'inactive.ts', dirty: true };
    const visibleState = { activeFileId: active.id, fileViewVisible: true };
    const visited: string[] = [];
    const guardDirtyFile = compileFunction<
      (file: typeof active) => Promise<boolean>
    >(extractFunctionSource(mainJs, 'guardDirtyFile'), {
      showFileDecision: async () => 'save',
      saveFile: async (file: typeof active) => {
        visited.push(file.id);
        if (file.id === active.id) {
          file.dirty = false;
          return { backendSucceeded: true, canContinue: true };
        }
        return { backendSucceeded: false, canContinue: false };
      },
      discardFile: () => undefined,
      revealFileForDecision: (file: typeof active) => {
        visibleState.activeFileId = file.id;
        visibleState.fileViewVisible = true;
      },
      restoreFileEditorFocus: () => undefined,
    });
    const guardDirtyFiles = compileFunction<
      (files: Array<typeof active>) => Promise<boolean>
    >(extractFunctionSource(mainJs, 'guardDirtyFiles'), { guardDirtyFile });

    await expect(guardDirtyFiles([active, inactive])).resolves.toBe(false);
    expect(visited).toEqual(['active', 'inactive']);
    expect(visibleState).toEqual({ activeFileId: inactive.id, fileViewVisible: true });
    expect(inactive.dirty).toBe(true);
  });

  it('reveals the actual failed-save editor from a stored browser-only layout', () => {
    const project = {
      id: 'p2',
      lastActiveThreadId: 't2',
      layout: { mode: 'browser', side: 'right' },
    };
    const file = { id: 'inactive', projectId: project.id, dirty: true };
    const state = {
      activeProjectId: 'p1',
      activeThreadId: 't1',
      activeFileId: 'active',
      threads: [{ id: 't2', projectId: project.id }],
    };
    let visibleLayout = 'terminal';
    let editorVisible = false;
    const liveLayoutCalls: Array<{ layout: string; options: unknown }> = [];
    const revealFileForDecision = compileFunction<
      (target: typeof file) => boolean
    >(extractFunctionSource(mainJs, 'revealFileForDecision'), {
      findOpenFile: () => file,
      findProject: () => project,
      state,
      terminalHost: {
        children: [{
          dataset: { threadId: 't2' },
          classList: { toggle: () => undefined },
        }],
      },
      restoreProjectLayout: () => { visibleLayout = project.layout.mode; },
      applyLayout: (layout: string, options: unknown) => {
        visibleLayout = layout;
        liveLayoutCalls.push({ layout, options });
      },
      currentSide: () => project.layout.side,
      loadAgentSkills: () => undefined,
      syncProjectBrowser: () => undefined,
      saveWorkspaceSoon: () => undefined,
      activateFileTabNow: (id: string) => {
        state.activeFileId = id;
        editorVisible = visibleLayout !== 'browser';
      },
      refreshSidebar: () => undefined,
    });

    expect(revealFileForDecision(file)).toBe(true);
    expect(state).toMatchObject({
      activeProjectId: project.id,
      activeThreadId: 't2',
      activeFileId: file.id,
    });
    expect(editorVisible).toBe(true);
    expect(visibleLayout).toBe('terminal');
    expect(project.layout.mode).toBe('browser');
    expect(liveLayoutCalls).toEqual([{
      layout: 'terminal',
      options: { side: 'right', persist: false },
    }]);
  });

  it('gates explicit save while any guarded file decision is pending', async () => {
    const source = extractFunctionSource(mainJs, 'handleExplicitFileSave');
    for (const blockers of [
      { fileDecisionInFlight: Promise.resolve('save'), fileNavigationInFlight: false, closeRequestInFlight: false },
      { fileDecisionInFlight: null, fileNavigationInFlight: true, closeRequestInFlight: false },
      { fileDecisionInFlight: null, fileNavigationInFlight: false, closeRequestInFlight: true },
    ]) {
      let prevented = 0;
      let saveCalls = 0;
      const handleExplicitFileSave = compileFunction<
        (event: { preventDefault(): void }) => Promise<boolean>
      >(source, {
        ...blockers,
        saveFile: async () => { saveCalls += 1; return true; },
        findOpenFile: () => ({ id: 'active', dirty: true }),
        state: { activeFileId: 'active' },
      });

      await expect(handleExplicitFileSave({
        preventDefault: () => { prevented += 1; },
      })).resolves.toBe(false);
      expect(prevented).toBe(1);
      expect(saveCalls).toBe(0);
    }
    expect(mainJs).toMatch(
      /String\(e\.key\)\.toLowerCase\(\) === "s"[\s\S]*await handleExplicitFileSave\(e\)/
    );
  });

  it('does not close a clean-looking file tab until its pending write settles', async () => {
    const write = deferred<{ backendSucceeded: boolean; canContinue: boolean }>();
    const file = { id: 'f1', projectId: 'p1', dirty: false, savePromise: write.promise };
    const state = { activeFileId: file.id, activeProjectId: 'p1', openFiles: [file] };
    let dirtyDecisions = 0;
    const guardDirtyFile = compileFunction<
      (target: typeof file) => Promise<boolean>
    >(extractFunctionSource(mainJs, 'guardDirtyFile'), {
      showFileDecision: async () => { dirtyDecisions += 1; return 'discard'; },
      saveFile: async () => ({ backendSucceeded: true, canContinue: true }),
      discardFile: () => undefined,
      revealFileForDecision: () => undefined,
      restoreFileEditorFocus: () => undefined,
    });
    const closeFileTab = compileFunction<
      (id: string) => Promise<boolean>
    >(extractFunctionSource(mainJs, 'closeFileTab'), {
      findOpenFile: () => file,
      fileNavigationInFlight: false,
      fileDecisionInFlight: null,
      guardDirtyFile,
      projectFiles: () => state.openFiles,
      state,
      refreshTabs: () => undefined,
      activateFileTabNow: () => undefined,
      fileViewEl: { hidden: false },
      terminalHost: { hidden: true },
      requestAnimationFrame: () => undefined,
      fitActiveTerm: () => undefined,
    });

    const closing = closeFileTab(file.id);
    await Promise.resolve();
    expect(state.openFiles).toEqual([file]);
    expect(dirtyDecisions).toBe(0);
    write.resolve({ backendSucceeded: true, canContinue: true });
    await expect(closing).resolves.toBe(true);
    expect(state.openFiles).toEqual([]);
  });

  it('does not remove a project until every pending file write settles', async () => {
    const write = deferred<{ backendSucceeded: boolean; canContinue: boolean }>();
    const file = { id: 'f1', projectId: 'p1', dirty: false, savePromise: write.promise };
    const project = { id: 'p1' };
    const state = {
      activeFileId: null,
      activeProjectId: project.id,
      activeThreadId: null,
      openFiles: [file],
      projects: [project],
      threads: [],
    };
    const guardDirtyFile = compileFunction<
      (target: typeof file) => Promise<boolean>
    >(extractFunctionSource(mainJs, 'guardDirtyFile'), {
      showFileDecision: async () => 'cancel',
      saveFile: async () => ({ backendSucceeded: true, canContinue: true }),
      discardFile: () => undefined,
      revealFileForDecision: () => undefined,
      restoreFileEditorFocus: () => undefined,
    });
    const guardDirtyFiles = compileFunction<
      (files: Array<typeof file>) => Promise<boolean>
    >(extractFunctionSource(mainJs, 'guardDirtyFiles'), { guardDirtyFile });
    const removeProject = compileFunction<
      (id: string) => Promise<boolean>
    >(extractFunctionSource(mainJs, 'removeProject'), {
      findProject: () => project,
      state,
      fileNavigationInFlight: false,
      fileDecisionInFlight: null,
      guardDirtyFiles,
      closeThread: () => undefined,
      fileViewEl: { hidden: true },
      terminalHost: { hidden: false, children: [] },
      setActiveProject: async () => true,
      setStatus: () => undefined,
      refreshTabs: () => undefined,
      syncProjectBrowser: () => undefined,
      saveWorkspaceSoon: () => undefined,
      invalidateCovenDiscovery: () => undefined,
      requestCovenRefresh: () => undefined,
    });

    const removing = removeProject(project.id);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(state.projects).toEqual([project]);
    write.resolve({ backendSucceeded: true, canContinue: true });
    await expect(removing).resolves.toBe(true);
    expect(state.projects).toEqual([]);
  });

  it('does not destroy the window until pending writes settle', async () => {
    const write = deferred<{ backendSucceeded: boolean; canContinue: boolean }>();
    const file = { id: 'f1', dirty: false, savePromise: write.promise };
    let destroyCalls = 0;
    let prevented = 0;
    const guardDirtyFile = compileFunction<
      (target: typeof file) => Promise<boolean>
    >(extractFunctionSource(mainJs, 'guardDirtyFile'), {
      showFileDecision: async () => 'cancel',
      saveFile: async () => ({ backendSucceeded: true, canContinue: true }),
      discardFile: () => undefined,
      revealFileForDecision: () => undefined,
      restoreFileEditorFocus: () => undefined,
    });
    const guardDirtyFiles = compileFunction<
      (files: Array<typeof file>) => Promise<boolean>
    >(extractFunctionSource(mainJs, 'guardDirtyFiles'), { guardDirtyFile });
    const handleWindowCloseRequested = compileFunction<
      (event: { preventDefault(): void }) => Promise<void>
    >(extractFunctionSource(mainJs, 'handleWindowCloseRequested'), {
      destroyingWindow: false,
      closeRequestInFlight: false,
      fileDecisionInFlight: null,
      fileNavigationInFlight: false,
      guardDirtyFiles,
      state: { openFiles: [file] },
      saveWorkspaceNow: () => undefined,
      currentWindow: { destroy: async () => { destroyCalls += 1; } },
      setStatus: () => undefined,
      restoreFileEditorFocus: () => undefined,
    });

    const closing = handleWindowCloseRequested({ preventDefault: () => { prevented += 1; } });
    await Promise.resolve();
    expect(prevented).toBe(1);
    expect(destroyCalls).toBe(0);
    write.resolve({ backendSucceeded: true, canContinue: true });
    await closing;
    expect(destroyCalls).toBe(1);
  });

  it('rebases an edit back to the old baseline after pending save and prompts again', async () => {
    const write = deferred<{ backendSucceeded: boolean; canContinue: boolean }>();
    const decisions: string[] = [];
    const file = { id: 'f1', dirty: false, savePromise: write.promise };
    const guardDirtyFile = compileFunction<
      (target: typeof file) => Promise<boolean>
    >(extractFunctionSource(mainJs, 'guardDirtyFile'), {
      showFileDecision: async ({ mode }: { mode: string }) => {
        decisions.push(mode);
        return 'cancel';
      },
      saveFile: async () => ({ backendSucceeded: true, canContinue: false }),
      discardFile: () => undefined,
      revealFileForDecision: () => undefined,
      restoreFileEditorFocus: () => undefined,
    });

    const guarding = guardDirtyFile(file);
    await Promise.resolve();
    expect(decisions).toEqual([]);
    file.dirty = true;
    write.resolve({ backendSucceeded: true, canContinue: false });
    await expect(guarding).resolves.toBe(false);
    expect(decisions).toEqual(['dirty']);
  });

  it('waits for an existing save operation selected from the dirty decision', async () => {
    const write = deferred<{ backendSucceeded: boolean; canContinue: boolean }>();
    const file = { id: 'f1', dirty: true, saving: false, savePromise: null as Promise<unknown> | null };
    let performCalls = 0;
    const saveFile = compileFunction<
      (target: typeof file) => Promise<{ backendSucceeded: boolean; canContinue: boolean }>
    >(extractFunctionSource(mainJs, 'saveFile'), {
      performFileSave: () => { performCalls += 1; return Promise.resolve({ backendSucceeded: true, canContinue: true }); },
    });
    const guardDirtyFile = compileFunction<
      (target: typeof file) => Promise<boolean>
    >(extractFunctionSource(mainJs, 'guardDirtyFile'), {
      showFileDecision: async () => {
        file.saving = true;
        file.savePromise = write.promise;
        return 'save';
      },
      saveFile,
      discardFile: () => undefined,
      revealFileForDecision: () => undefined,
      restoreFileEditorFocus: () => undefined,
    });

    var settled = false;
    const guarding = guardDirtyFile(file).then(function (result) { settled = true; return result; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(performCalls).toBe(0);
    file.dirty = false;
    write.resolve({ backendSucceeded: true, canContinue: true });
    await expect(guarding).resolves.toBe(true);
  });

  it('shares one save promise and cannot clear a newer tracked operation', async () => {
    const firstWrite = deferred<{ backendSucceeded: boolean; canContinue: boolean }>();
    const newerWrite = deferred<{ backendSucceeded: boolean; canContinue: boolean }>();
    const file = {
      id: 'f1', dirty: true, saving: false,
      savePromise: null as Promise<unknown> | null,
    };
    const saveFile = compileFunction<
      (target: typeof file) => Promise<{ backendSucceeded: boolean; canContinue: boolean }>
    >(extractFunctionSource(mainJs, 'saveFile'), {
      isEditableFile: () => true,
      performFileSave: () => firstWrite.promise,
    });

    const first = saveFile(file);
    expect(saveFile(file)).toBe(first);
    file.savePromise = newerWrite.promise;
    firstWrite.resolve({ backendSucceeded: true, canContinue: true });
    await first;
    expect(file.savePromise).toBe(newerWrite.promise);
  });

  it('awaits pending conflict mode before considering a dirty decision', async () => {
    const backend = deferred<void>();
    const conflictDecision = deferred<void>();
    const modes: string[] = [];
    const file = { id: 'f1', dirty: false, savePromise: null as Promise<unknown> | null };
    file.savePromise = (async function () {
      await backend.promise;
      modes.push('conflict');
      await conflictDecision.promise;
      return { backendSucceeded: false, canContinue: false };
    })();
    const guardDirtyFile = compileFunction<
      (target: typeof file) => Promise<boolean>
    >(extractFunctionSource(mainJs, 'guardDirtyFile'), {
      showFileDecision: async () => { modes.push('dirty'); return 'cancel'; },
      saveFile: async () => ({ backendSucceeded: true, canContinue: true }),
      discardFile: () => undefined,
      revealFileForDecision: () => undefined,
      restoreFileEditorFocus: () => undefined,
    });

    let settled = false;
    const guarding = guardDirtyFile(file).then(function (result) { settled = true; return result; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(modes).toEqual([]);
    backend.resolve();
    await Promise.resolve();
    expect(modes).toEqual(['conflict']);
    conflictDecision.resolve();
    await expect(guarding).resolves.toBe(false);
    expect(modes).toEqual(['conflict']);
  });

  it('reloads disk text into a clean file while preserving its selection', async () => {
    const source = extractFunctionSource(mainJs, 'reloadFile');
    const selections: unknown[] = [];
    const file = {
      id: 'f1', projectId: 'p1', path: '/repo/a.ts', text: 'editor',
      originalText: 'old', dirty: true, saving: false, error: 'old error',
      saveError: 'conflict', saveState: 'error', conflict: true,
      truncated: false, binary: false, size: 6,
      selection: { anchor: 50, head: 50 },
    };
    const reloadFile = compileFunction<(target: typeof file) => Promise<boolean>>(source, {
      findProject: () => ({ root: '/repo' }),
      invoke: async () => ({ text: 'disk', truncated: false, binary: false, size: 4 }),
      window: { PsycheCodeEditor: { createFileBuffer: (text: string) => ({
        text, originalText: text, dirty: false,
      }) } },
      state: { activeFileId: 'f1' },
      renderFileView: (options: unknown) => { selections.push(options); },
      refreshTabs: () => undefined,
      restoreFileEditorFocus: () => undefined,
    });

    await expect(reloadFile(file)).resolves.toBe(true);
    expect(file).toMatchObject({
      text: 'disk', originalText: 'disk', dirty: false, saving: false,
      error: null, saveError: null, saveState: 'clean', conflict: false,
      selection: { anchor: 50, head: 50 },
    });
    expect(selections).toEqual([{ reload: true }]);
  });

  it('guards navigation, project removal, and native window close before mutation', () => {
    for (const name of ['activateFileTab', 'closeFileTab', 'removeProject', 'showTerminalView']) {
      expect(mainJs).toMatch(new RegExp(`async function ${name}\\(`));
    }
    const activateFileTabSource = extractFunctionSource(mainJs, 'activateFileTab');
    expect(activateFileTabSource).toMatch(/await guardDirtyFile\(/);
    expect(activateFileTabSource).toMatch(/if \(!canActivate\) return false;[\s\S]*activateFileTabNow\(id\)/);
    expect(mainJs).toMatch(/function activateFileTabNow\(id\)[\s\S]*state\.activeFileId = id/);
    expect(extractFunctionSource(mainJs, 'closeFileTab')).toMatch(
      /await guardDirtyFile\(file\)[\s\S]*if \(!canClose\) return false;[\s\S]*state\.openFiles =/
    );
    expect(extractFunctionSource(mainJs, 'removeProject')).toMatch(
      /await guardDirtyFiles\([\s\S]*if \(!canRemove\) return false;[\s\S]*state\.projects =/
    );
    expect(extractFunctionSource(mainJs, 'showTerminalView')).toMatch(
      /await guardDirtyFile\([\s\S]*if \(!canShowTerminal\) return false;[\s\S]*state\.activeFileId = null/
    );
    expect(mainJs).toContain('window.__TAURI__.window.getCurrentWindow()');
    expect(mainJs).toContain('onCloseRequested');
    expect(mainJs).toMatch(/event\.preventDefault\(\)[\s\S]*await guardDirtyFiles\(state\.openFiles\.slice\(\)\)[\s\S]*currentWindow\.destroy\(\)/);
    expect(mainJs).toMatch(/closeRequestInFlight/);
    expect(mainJs).toMatch(/destroyingWindow/);
    expect(mainJs).not.toMatch(/currentWindow\.close\(\)/);
  });

  it('offers reload or keep editing after a save conflict without continuing navigation', () => {
    expect(mainJs).toMatch(/async function reloadFile\(file\)/);
    expect(mainJs).toMatch(/invoke\("fs_read_text", \{ root: file\.workspaceRoot \|\| project\.root, path: file\.path \}\)/);
    expect(mainJs).toMatch(/file\.saveError\.includes\("changed on disk"\)[\s\S]*showFileDecision\(\{ mode: "conflict", file: file \}\)/);
    expect(mainJs).toMatch(/conflictChoice === "reload"[\s\S]*await reloadFile\(file\)[\s\S]*return false/);
    expect(mainJs).toMatch(
      /catch \(error\) \{[\s\S]*revealFileForDecision\(file\)[\s\S]*showFileDecision\(\{ mode: "conflict", file: file \}\)/
    );
  });
});
