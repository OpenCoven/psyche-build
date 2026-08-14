import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const tauriRoot = join(repoRoot, 'native/desktop/psyche-build-tauri');
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
  const paramsStart = source.indexOf('(', start);
  let paramsDepth = 0;
  let bodyStart = -1;
  for (let index = paramsStart; index < source.length; index += 1) {
    if (source[index] === '(') paramsDepth += 1;
    if (source[index] === ')') paramsDepth -= 1;
    if (paramsDepth === 0) {
      bodyStart = source.indexOf('{', index);
      break;
    }
  }
  if (bodyStart === -1) throw new Error(`missing function body ${name}`);
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
    const requiredScripts = [
      './editor.bundle.js',
      './diffs.bundle.js',
      './sessions.bundle.js',
      './panes.bundle.js',
      './input.bundle.js',
      './status.bundle.js',
      './workspace.bundle.js',
      './main.js',
    ];
    const scriptPositions = requiredScripts.map((script) => {
      const marker = `<script src="${script}" defer></script>`;
      return { script, index: indexHtml.indexOf(marker) };
    });

    for (const { script, index } of scriptPositions) {
      expect(index, `${script} should be present in native index order`).toBeGreaterThanOrEqual(0);
    }
    for (let position = 1; position < scriptPositions.length; position += 1) {
      expect(
        scriptPositions[position - 1].index,
        `${scriptPositions[position - 1].script} should load before ${scriptPositions[position].script}`
      ).toBeLessThan(scriptPositions[position].index);
    }
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

  it('renders diffs from the shared model rather than a CodeMirror document', async () => {
    // The unified CodeMirror diff surface was retired: split and stacked are two
    // renderings of one parsed model, which a read-only editor cannot express.
    expect(indexHtml).toContain('id="diff-rows"');
    expect(indexHtml).toContain('id="diff-metadata"');
    expect(indexHtml).toContain('id="diff-truncation"');
    expect(indexHtml).not.toContain('id="diff-editor-host"');

    // Its implementation is gone too, not merely unreferenced.
    expect(editorEntry).not.toContain('createDiffViewer');
    expect(editorEntry).not.toContain('diffClass');
    expect(editorEntry).not.toContain('workspaceDiffTheme');
    // The file editor it shared a module with is untouched.
    expect(editorEntry).toMatch(/export function createFileEditor\s*\(/);
  });

  it('coordinates structured diff responses with exact cache and request identity', () => {
    expect(mainJs).toContain('window.PsycheCodeEditor.createLruCache(6)');
    expect(mainJs).toContain('window.PsycheCodeEditor.createRequestGate()');
    expect(mainJs).toMatch(/function diffCacheKey\(projectId, workspaceRoot, path, staged, context\)/);
    expect(mainJs).toContain('projectId + "\\0" + workspaceRoot + "\\0" + path + "\\0" +');
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
      /invalidateProjectDiffs\(project\.id\)[\s\S]*renderGitSurface\(\{ force: true \}\)/
    );
    expect(extractFunctionSource(mainJs, 'renderGitSurface')).toContain('gitPaneIsVisible(project)');
    expect(extractFunctionSource(mainJs, 'performFileSave')).toMatch(
      /invalidateProjectDiffs\(project\.id\);[\s\S]*gitPaneIsVisible\(project\)[\s\S]*renderGitSurface\(\{ force: true \}\);/
    );
  });

  it('resets stale badges and summaries at refresh start and status errors', () => {
    expect(extractFunctionSource(mainJs, 'renderGitSurface')).toContain('setGitChangesCount(0)');
    expect(extractFunctionSource(mainJs, 'renderGitSurfaceError')).toContain('diffsSummaryEl.textContent = "error"');
    expect(extractFunctionSource(mainJs, 'renderGitSurfaceError')).toContain('clearDiffSelection("")');
  });

  it('serves cached diffs without invoking and ignores stale results and errors', async () => {
    const source = extractFunctionSource(mainJs, 'showDiff');
    const project = { id: 'p1', root: '/repo' };
    const entry = { path: 'src/a.ts', staged: false, unstaged: true };
    const result = { text: '+cached', bytes: 7, lines: 1, truncated: false };
    const renderCalls: unknown[] = [];
    let invokeCalls = 0;
    const common = {
      diffRowsEl: { replaceChildren: () => undefined },
      activeProject: () => project,
      gitPaneIsVisible: () => true,
      activeWorkspaceRoot: (owner: typeof project) => owner.root,
      stagedDiffFor: () => false,
      diffCacheKey: () => 'p1\0src/a.ts\0unstaged\0default',
      diffContext: null,
      shownDiffTarget: null,
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
      // tab strip · toolbar · path · editor · status
      /\.file-view\s*\{[\s\S]*grid-template-rows:\s*auto auto auto minmax\(0, 1fr\) auto;/
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
    expect(mainJs).toMatch(/gitPaneIsVisible\(project\)[\s\S]*renderGitSurface\(\)/);
    expect(mainJs).toMatch(/fileSaveEl\.addEventListener\("click", function \(\) \{[\s\S]*saveFile\(findOpenFile\(state\.activeFileId\)\)/);
    expect(extractFunctionSource(mainJs, 'handleExplicitFileSave')).toMatch(
      /filesPaneHasCanvasFocus\(\)[\s\S]*event\.preventDefault\(\)[\s\S]*saveFile\(findOpenFile\(state\.activeFileId\)\)/
    );
  });

  it('renders dirty, saving, saved, error, and read-only file chrome', () => {
    expect(mainJs).toMatch(/dot\.className = "dot dirty-dot"/);
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

  it('stops dirty-dialog Escape before it returns from the Files pane', () => {
    expect(extractFunctionSource(mainJs, 'showFileDecision')).toMatch(
      /event\.key === "Escape"[\s\S]*event\.preventDefault\(\);[\s\S]*event\.stopPropagation\(\);[\s\S]*settle\(fallback\)/
    );
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

  it('reveals the actual failed-save editor without restoring retired dock layout', () => {
    const previousProject = {
      id: 'p1',
      selectedWorktreePath: '/old-repo',
    };
    const project = {
      id: 'p2',
      lastActiveThreadId: 't2',
      selectedWorktreePath: '/repo',
    };
    const file = { id: 'inactive', projectId: project.id, dirty: true };
    const state = {
      activeProjectId: 'p1',
      activeThreadId: 't1',
      activeFileId: 'active',
      threads: [{
        id: 't2', kind: 'shell', projectId: project.id,
        worktreePath: '/repo', hidden: false,
      }],
    };
    let editorVisible = false;
    let generation = 1;
    const activeProject = () => state.activeProjectId === project.id ? project : previousProject;
    const activeWorkspaceRoot = (value: typeof project | typeof previousProject) =>
      value.selectedWorktreePath;
    const requestMatches = compileFunction<(
      projectId: string,
      workspaceRoot: string,
      candidate: number,
    ) => boolean>(extractFunctionSource(mainJs, 'gitPanelRequestMatches'), {
      activeProject,
      activeWorkspaceRoot,
      gitPanelRequestGate: { isCurrent: (candidate: number) => candidate === generation },
      gitPaneIsVisible: () => true,
    });
    const revealFileForDecision = compileFunction<
      (target: typeof file) => boolean
    >(extractFunctionSource(mainJs, 'revealFileForDecision'), {
      findOpenFile: () => file,
      findProject: () => project,
      state,
      activeWorkspaceRoot,
      terminalHost: {
        children: [{
          dataset: { threadId: 't2' },
          classList: { toggle: () => undefined },
        }],
      },
      renderPaneWorkspace: () => undefined,
      renderGitSurface: () => { generation += 1; return true; },
      clearPassiveCovenPaneFocus: () => undefined,
      loadAgentSkills: () => undefined,
      syncProjectBrowser: () => undefined,
      saveWorkspaceSoon: () => undefined,
      activateFileTabNow: (id: string) => {
        state.activeFileId = id;
        editorVisible = true;
      },
      refreshSidebar: () => undefined,
    });

    const previousGeneration = generation;
    expect(revealFileForDecision(file)).toBe(true);
    expect(state).toMatchObject({
      activeProjectId: project.id,
      activeThreadId: 't2',
      activeFileId: file.id,
    });
    expect(editorVisible).toBe(true);
    expect(generation).toBe(previousGeneration + 1);
    expect(requestMatches(previousProject.id, '/old-repo', previousGeneration)).toBe(false);
    expect(requestMatches(project.id, '/repo', generation)).toBe(true);
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
        filesPaneHasCanvasFocus: () => true,
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
      /function routeFilesShortcut\(e\)[\s\S]*key === "s"[\s\S]*handleExplicitFileSave\(e\)/
    );
  });

  it('leaves Files shortcuts and dirty guards alone while a terminal owns focus', async () => {
    let dirtyGuards = 0;
    let prevented = 0;
    let saves = 0;
    let closes = 0;
    let returns = 0;
    const showTerminalView = compileFunction<() => Promise<boolean>>(
      extractFunctionSource(mainJs, 'showTerminalView'),
      {
        filesPaneHasCanvasFocus: () => false,
        clearPassiveCovenPaneFocus: () => undefined,
        activePaneLayout: () => null,
        renderPaneMinimap: () => undefined,
        refreshTabs: () => undefined,
        requestAnimationFrame: () => undefined,
        scheduleTerminalPaneFits: () => undefined,
        guardDirtyFile: () => { dirtyGuards += 1; return false; },
      },
    );
    const routeFilesShortcut = compileFunction<
      (event: Record<string, unknown>) => boolean
    >(extractFunctionSource(mainJs, 'routeFilesShortcut'), {
      filesPaneHasCanvasFocus: () => false,
      handleExplicitFileSave: () => { saves += 1; },
      closeFileTab: () => { closes += 1; },
      returnFromFileFocus: () => { returns += 1; },
      state: { activeFileId: 'dirty-file' },
      switchTab: () => undefined,
      projectFiles: () => [{ id: 'dirty-file' }],
      activateFileTab: () => undefined,
    });

    await expect(showTerminalView()).resolves.toBe(true);
    for (const key of ['Escape', 'w', 's']) {
      expect(routeFilesShortcut({
        key, metaKey: key !== 'Escape', ctrlKey: false,
        preventDefault: () => { prevented += 1; },
      })).toBe(false);
    }
    expect({ dirtyGuards, prevented, saves, closes, returns }).toEqual({
      dirtyGuards: 0, prevented: 0, saves: 0, closes: 0, returns: 0,
    });
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
      clearFileFocusPresentation: () => undefined,
      clearPassiveCovenPaneFocus: () => undefined,
      renderPaneWorkspace: () => undefined,
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
      renderPaneWorkspace: () => undefined,
      setActiveProject: async () => true,
      setStatus: () => undefined,
      refreshTabs: () => undefined,
      syncProjectBrowser: () => undefined,
      saveWorkspaceSoon: () => undefined,
      PsycheSessions: {
        invalidateCovenRequests: (discovery: unknown) => discovery,
      },
      covenDiscovery: {},
      startCovenPolling: () => undefined,
      syncPaneMetricsVisibility: () => true,
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

  it('activates files without hiding their owning canvas pane and preserves the return pane', () => {
    const state = {
      activeFileId: null as string | null,
      activeThreadId: 'thread-a',
    };
    const fileFocus = { returnThreadId: null as string | null };
    const minimapCalls: Array<{ layout: unknown; fileId: string }> = [];
    let ptyVisibilitySyncs = 0;
    const layout = { root: { type: 'leaf', id: 'leaf-a', threadId: 'thread-a' } };
    const fileViewEl = { hidden: true };
    const terminalHost = { hidden: false };
    const filesPane = {
      id: 'files-a', kind: 'files', projectId: 'project-a', workspaceRoot: '/worktree',
      pane: { hidden: false },
    };
    const focused: string[] = [];
    const enterFileFocus = compileFunction<
      (file: { id: string; projectId: string; workspaceRoot: string }) => void
    >(extractFunctionSource(mainJs, 'enterFileFocus'), {
      state,
      fileFocus,
      fileViewEl,
      terminalHost,
      filesPanes: new Map([['project-a\0/worktree', filesPane]]),
      filesPaneKey: () => 'project-a\0/worktree',
      focusCanvasSurface: (surface: { id: string }) => { focused.push(surface.id); },
      syncPaneMetricsVisibility: () => true,
      syncAllPtyVisibility: () => { ptyVisibilitySyncs += 1; },
      activePaneLayout: () => layout,
      renderPaneMinimap: (value: unknown, file: { id: string }) => {
        minimapCalls.push({ layout: value, fileId: file.id });
      },
    });

    enterFileFocus({
      id: 'file-a', projectId: 'project-a', workspaceRoot: '/worktree',
    });
    expect(fileFocus.returnThreadId).toBe('thread-a');
    expect(state.activeFileId).toBe('file-a');
    expect(fileViewEl.hidden).toBe(false);
    expect(terminalHost.hidden).toBe(false);
    expect(filesPane.pane.hidden).toBe(false);
    expect(focused).toEqual(['files-a']);

    state.activeThreadId = 'thread-b';
    enterFileFocus({
      id: 'file-b', projectId: 'project-a', workspaceRoot: '/worktree',
    });
    expect(fileFocus.returnThreadId).toBe('thread-a');
    expect(state.activeFileId).toBe('file-b');
    expect(minimapCalls).toEqual([
      { layout, fileId: 'file-a' },
      { layout, fileId: 'file-b' },
    ]);
    expect(ptyVisibilitySyncs).toBe(2);

    expect(extractFunctionSource(mainJs, 'enterFileFocus')).not.toMatch(
      /applyLayout|data\.layout|sidebar/
    );
  });

  it('does not prompt to transfer canvas focus away from a dirty mounted file', async () => {
    const state = { activeFileId: 'file-a' };
    const fileFocus = { returnThreadId: 'thread-a' };
    let dirtyGuards = 0;
    const showTerminalView = compileFunction<() => Promise<boolean>>(
      extractFunctionSource(mainJs, 'showTerminalView'),
      {
        state,
        filesPaneHasCanvasFocus: () => true,
        guardDirtyFile: async () => { dirtyGuards += 1; return false; },
        clearPassiveCovenPaneFocus: () => undefined,
        activePaneLayout: () => null,
        renderPaneMinimap: () => undefined,
        refreshTabs: () => undefined,
        requestAnimationFrame: () => undefined,
        scheduleTerminalPaneFits: () => undefined,
      },
    );

    await expect(showTerminalView()).resolves.toBe(true);
    expect(state.activeFileId).toBe('file-a');
    expect(fileFocus.returnThreadId).toBe('thread-a');
    expect(dirtyGuards).toBe(0);
  });

  it('focuses another canvas pane without hiding the mounted file view', async () => {
    const calls: string[] = [];
    const layout = { root: { type: 'leaf', id: 'leaf-a', threadId: 'thread-a' } };
    const state = { activeFileId: 'file-a' };
    const fileViewEl = { hidden: false };
    const terminalHost = { hidden: false };
    const showTerminalView = compileFunction<() => Promise<boolean>>(
      extractFunctionSource(mainJs, 'showTerminalView'),
      {
        state,
        filesPaneHasCanvasFocus: () => true,
        fileNavigationInFlight: false,
        fileDecisionInFlight: null,
        guardDirtyFile: async () => true,
        findOpenFile: () => ({ id: 'file-a', dirty: false }),
        clearPassiveCovenPaneFocus: () => undefined,
        activePaneLayout: () => layout,
        renderPaneMinimap: (value: unknown, file: unknown) => {
          expect(value).toBe(layout);
          expect(file).toBeNull();
          calls.push('minimap');
        },
        refreshTabs: () => { calls.push('tabs'); },
        requestAnimationFrame: (callback: () => void) => callback(),
        scheduleTerminalPaneFits: () => { calls.push('fit'); },
      },
    );

    await expect(showTerminalView()).resolves.toBe(true);
    expect(state.activeFileId).toBe('file-a');
    expect(fileViewEl.hidden).toBe(false);
    expect(terminalHost.hidden).toBe(false);
    expect(calls).toEqual(['minimap', 'tabs', 'fit']);
  });

  it('routes Escape through focused Files before pane maximize', () => {
    expect(mainJs).toMatch(
      /document\.addEventListener\("keydown", async function \(event\)[\s\S]*if \(routeFilesShortcut\(event\)\)[\s\S]*if \(!typing && exitPaneMaximize\(\)\)/
    );
    expect(extractFunctionSource(mainJs, 'renderPaneMinimap')).toMatch(
      /await returnFromFileFocus\(item\.thread\.id, true\)/
    );
  });

  it('documents Escape as the way back from the Files pane', () => {
    expect(mainJs).toContain('["Return from the Files pane", "esc"]');
    expect(mainJs).not.toContain('fullscreen file');
  });

  it('restores the pane workspace after the last active file closes', async () => {
    const file = { id: 'f1', projectId: 'p1', dirty: false, savePromise: null };
    const state = { activeFileId: file.id as string | null, activeProjectId: 'p1', openFiles: [file] };
    let cleared = 0;
    let rendered = 0;
    const closeFileTab = compileFunction<
      (id: string) => Promise<boolean>
    >(extractFunctionSource(mainJs, 'closeFileTab'), {
      findOpenFile: () => file,
      fileNavigationInFlight: false,
      fileDecisionInFlight: null,
      guardDirtyFile: async () => true,
      projectFiles: () => state.openFiles,
      state,
      refreshTabs: () => undefined,
      activateFileTabNow: () => undefined,
      clearFileFocusPresentation: () => {
        cleared += 1;
        state.activeFileId = null;
      },
      clearPassiveCovenPaneFocus: () => undefined,
      renderPaneWorkspace: () => { rendered += 1; },
    });

    await expect(closeFileTab(file.id)).resolves.toBe(true);
    expect(state.openFiles).toEqual([]);
    expect(state.activeFileId).toBeNull();
    expect({ cleared, rendered }).toEqual({ cleared: 1, rendered: 1 });
  });

  it('fills the dedicated Files pane instead of using the fullscreen overlay grid', () => {
    expect(stylesCss).not.toContain('.terminal-area.is-file-focused .file-view');
    expect(stylesCss).toMatch(
      /\.terminal-pane\.is-files\s*\{[^}]*grid-template-rows:\s*var\(--pane-head-h\)\s+minmax\(0,\s*1fr\)/
    );
    expect(stylesCss).toMatch(
      /\.files-pane-body\s*\{[^}]*min-width:\s*0;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/
    );
  });

  it('guards destructive file, project, and native window close boundaries before mutation', () => {
    for (const name of ['activateFileTab', 'closeFileTab', 'removeProject', 'showTerminalView']) {
      expect(mainJs).toMatch(new RegExp(`async function ${name}\\(`));
    }
    const activateFileTabSource = extractFunctionSource(mainJs, 'activateFileTab');
    expect(activateFileTabSource).not.toMatch(/guardDirtyFile\(/);
    expect(activateFileTabSource).toMatch(/return activateFileTabNow\(id\)/);
    expect(extractFunctionSource(mainJs, 'activateFileTabNow')).toMatch(/enterFileFocus\(file\)/);
    expect(extractFunctionSource(mainJs, 'closeFileTab')).toMatch(
      /await guardDirtyFile\(file\)[\s\S]*if \(!canClose\) return false;[\s\S]*state\.openFiles =/
    );
    expect(extractFunctionSource(mainJs, 'removeProject')).toMatch(
      /await guardDirtyFiles\([\s\S]*if \(!canRemove\) return false;[\s\S]*state\.projects =/
    );
    expect(extractFunctionSource(mainJs, 'showTerminalView')).not.toMatch(
      /guardDirtyFile\(|clearFileFocusPresentation\(\)|fileViewEl\.hidden|terminalHost\.hidden/
    );
    expect(extractFunctionSource(mainJs, 'setActiveProject')).not.toMatch(/guardActiveFileBoundary/);
    expect(extractFunctionSource(mainJs, 'activateProjectWorktree')).not.toMatch(/guardActiveFileBoundary/);
    expect(extractFunctionSource(mainJs, 'addProject')).not.toMatch(/guardActiveFileBoundary/);
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
