import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const webRoot = join(repoRoot, 'native/macos/psyche-build-tauri/web');
const indexHtml = readFileSync(join(webRoot, 'index.html'), 'utf8');
const mainJs = readFileSync(join(webRoot, 'main.js'), 'utf8');
const stylesCss = readFileSync(join(webRoot, 'styles.css'), 'utf8');

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function functionSource(source: string, name: string) {
  const match = new RegExp(
    `(?:async\\s+)?function\\s+${escapeRegExp(name)}\\s*\\(`,
  ).exec(source);
  if (!match || match.index === undefined) throw new Error(`missing function ${name}`);

  const bodyStart = source.indexOf('{', match.index + match[0].length);
  if (bodyStart === -1) throw new Error(`missing body for ${name}`);

  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }

  throw new Error(`unterminated function ${name}`);
}

function listenerSource(source: string, eventName: string) {
  const start = source.indexOf(`commandInput.addEventListener("${eventName}"`);
  if (start === -1) throw new Error(`missing command input ${eventName} listener`);
  const end = source.indexOf('\n  });', start);
  if (end === -1) throw new Error(`unterminated command input ${eventName} listener`);
  return source.slice(start, end + 6);
}

function ruleBlock(source: string, selector: string) {
  const match = source.match(
    new RegExp(`(^|\\n)${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`, 's'),
  );
  return match?.[2] ?? '';
}

function keydownHarness(value: string) {
  let handler: ((event: {
    key: string;
    preventDefault: () => void;
    stopPropagation: () => void;
  }) => void) | undefined;
  const commandInput = {
    value,
    addEventListener(name: string, listener: typeof handler) {
      if (name === 'keydown') handler = listener;
    },
    focus() {},
  };
  Function(
    'commandInput',
    'renderPalette',
    'runPalettePick',
    'hidePalette',
    'syncComposerChrome',
    'runCommand',
    `"use strict";
      var paletteVisible = true;
      var paletteFiltered = [{ kind: "session", cmd: "pick" }];
      var paletteIndex = 0;
      ${listenerSource(mainJs, 'keydown')}
    `,
  )(
    commandInput,
    () => {},
    () => {},
    () => {},
    () => {},
    () => {},
  );
  if (!handler) throw new Error('keydown listener was not registered');

  return {
    press(key: string) {
      let defaultPrevented = false;
      let propagationStopped = false;
      handler!({
        key,
        preventDefault() { defaultPrevented = true; },
        stopPropagation() { propagationStopped = true; },
      });
      return { defaultPrevented, propagationStopped };
    },
  };
}

describe('Tauri composer session search palette', () => {
  it('exposes the composer palette as an accessible listbox above the composer', () => {
    expect(indexHtml).toMatch(
      /id="command-input"[\s\S]*?aria-controls="palette"[\s\S]*?aria-autocomplete="list"[\s\S]*?aria-expanded="false"/,
    );
    expect(indexHtml).toMatch(
      /<div class="palette" id="palette" role="listbox" aria-label="Composer suggestions" hidden><\/div>/,
    );

    const palette = ruleBlock(stylesCss, '.palette');
    expect(palette).toMatch(/position:\s*absolute;/);
    expect(palette).toMatch(/right:\s*0;/);
    expect(palette).toMatch(/bottom:\s*calc\(100%\s*\+\s*8px\);/);
    expect(palette).toMatch(/left:\s*0;/);
    expect(palette).toMatch(/max-height:\s*min\(360px,\s*45vh\);/);
    expect(palette).toMatch(/overflow:\s*auto;/);
    expect(ruleBlock(stylesCss, '.palette-item.palette-session')).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*auto\)\s+minmax\(0,\s*1fr\)\s+auto;/,
    );
    expect(ruleBlock(stylesCss, '.palette-empty')).toMatch(/text-align:\s*center;/);
  });

  it('builds ordered session entries through the shared sidebar model and active filter', () => {
    expect(mainJs).toContain('var PALETTE_SIGILS = "/!%?";');
    const buildEntries = functionSource(mainJs, 'buildSessionSearchEntries');

    expect(buildEntries).toContain('PsycheSessions.buildSidebarProjectModel({');
    expect(buildEntries).toContain('PsycheSessions.flattenSidebarSearchResults(projectModels)');
    expect(buildEntries).toContain('filter: sessionTypeFilter');
    expect(buildEntries).toContain('query: query');
    expect(buildEntries).toContain('covenSessionAssignments()');
    expect(buildEntries).toContain('!thread.hidden && !isDormantThread(thread)');
    expect(buildEntries).toContain('projectModel.visibleCount === 0');
    for (const field of [
      'cmd: result.title',
      'badge: result.status.label',
      'hint: "↵"',
      'kind: "session"',
      'group: "Sessions"',
      'sessionSource: result.source',
      'sessionId: result.id',
      'selectionKey: result.selectionKey',
      'projectId: result.projectId',
    ]) {
      expect(buildEntries).toContain(field);
    }
  });

  it('keeps explicit session searches open and renders accessible results or empty state', () => {
    const openPalette = functionSource(mainJs, 'openPalette');
    const hidePalette = functionSource(mainJs, 'hidePalette');
    const renderPalette = functionSource(mainJs, 'renderPalette');

    expect(openPalette).toContain('commandInput.value.charAt(0)');
    expect(openPalette).toMatch(/if\s*\(sigil === "\?"\)/);
    expect(openPalette).toContain('buildSessionSearchEntries(rest)');
    expect(openPalette).toMatch(/paletteFiltered\.length === 0 && sigil !== "\?"/);
    expect(openPalette).toContain('Math.max(0, paletteFiltered.length - 1)');
    expect(openPalette).toContain('commandInput.setAttribute("aria-expanded", "true")');
    expect(hidePalette).toContain('commandInput.setAttribute("aria-expanded", "false")');
    expect(hidePalette).toContain('commandInput.removeAttribute("aria-activedescendant")');

    expect(renderPalette).toContain('"No matching sessions"');
    expect(renderPalette).toContain('empty.className = "palette-empty"');
    expect(renderPalette).toContain('div.id = "palette-option-" + idx');
    expect(renderPalette).toContain('div.setAttribute("role", "option")');
    expect(renderPalette).toContain('div.setAttribute("aria-selected"');
    expect(renderPalette).toContain('" palette-session"');
    expect(renderPalette).toContain('commandInput.setAttribute("aria-activedescendant", div.id)');
  });

  it('activates session picks only after live local or Coven revalidation', () => {
    const activate = functionSource(mainJs, 'runSessionSearchPick');
    const pick = functionSource(mainJs, 'runPalettePick');

    expect(activate.match(/Session is no longer available/g)).toHaveLength(3);
    expect(activate).toContain('var project = findProject(pick.projectId)');
    expect(activate).toContain('pick.sessionSource === "psyche"');
    expect(activate).toContain('thread.projectId !== project.id');
    expect(activate).toContain('thread.hidden');
    expect(activate).toContain('isDormantThread(thread)');
    expect(activate).toContain('await setActiveProject(project.id)');
    expect(activate).toContain('settings.selectedSessionKey = pick.selectionKey');
    expect(activate).toContain('saveSettings()');
    expect(activate).toContain('applySetScopeForThread(thread)');
    expect(activate).toContain('await focusThread(thread.id)');
    expect(activate).toContain('covenSessionsForProject(project).find');
    expect(activate).toContain('candidate.id === pick.sessionId');
    expect(activate).toContain('await openCovenSession(project, session)');

    expect(pick).toMatch(/^async function runPalettePick/);
    expect(pick).toContain('pick.kind === "session"');
    expect(pick).toContain('await runSessionSearchPick(pick)');
    expect(pick).toContain('} finally {');
    expect(pick).toContain('if (selected)');
    expect(pick).toContain('commandInput.focus()');
  });

  it('guards empty palette navigation and prevents session queries reaching a PTY', () => {
    const input = listenerSource(mainJs, 'input');
    const keydown = listenerSource(mainJs, 'keydown');
    const runCommand = functionSource(mainJs, 'runCommand');

    expect(input).toContain('commandInput.value.charAt(0)');
    expect(keydown).toContain('var sessionSearchOpen = commandInput.value.charAt(0) === "?";');
    expect(keydown).toMatch(/e\.key === "ArrowDown"[\s\S]*paletteFiltered\.length > 0/);
    expect(keydown).toMatch(/e\.key === "ArrowUp"[\s\S]*paletteFiltered\.length > 0/);
    expect(keydown).toMatch(
      /e\.key === "Enter"[\s\S]*sessionSearchOpen[\s\S]*e\.stopPropagation\(\)[\s\S]*e\.preventDefault\(\)[\s\S]*return;/,
    );
    expect(keydown).toMatch(
      /e\.key === "Tab"[\s\S]*sessionSearchOpen[\s\S]*e\.stopPropagation\(\)[\s\S]*e\.preventDefault\(\)[\s\S]*return;/,
    );
    expect(keydown).toMatch(
      /e\.key === "Escape"[\s\S]*sessionSearchOpen[\s\S]*commandInput\.value = ""[\s\S]*e\.stopPropagation\(\)[\s\S]*hidePalette\(\)[\s\S]*syncComposerChrome\(\)[\s\S]*commandInput\.focus\(\)/,
    );
    expect(runCommand).toMatch(
      /if\s*\(trimmed\.charAt\(0\) === "\?"\)\s*\{[\s\S]*commandInput\.value = trimmed;[\s\S]*openPalette\(trimmed, true\);[\s\S]*syncComposerChrome\(\);[\s\S]*return;/,
    );
  });

  it('stops every captured search key without changing non-search palette propagation', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape']) {
      const searchEvent = keydownHarness('? session').press(key);
      expect(searchEvent.defaultPrevented, key).toBe(true);
      expect(searchEvent.propagationStopped, key).toBe(true);

      const commandEvent = keydownHarness('/command').press(key);
      expect(commandEvent.propagationStopped, key).toBe(false);
    }
  });

  it('announces live result counts and returns focus after session activation', () => {
    const syncComposerChrome = functionSource(mainJs, 'syncComposerChrome');
    const runPalettePick = functionSource(mainJs, 'runPalettePick');

    expect(syncComposerChrome).toContain('rawValue.charAt(0) === "?"');
    expect(syncComposerChrome).toContain('"Search sessions, "');
    expect(syncComposerChrome).toContain('paletteFiltered.length');
    expect(syncComposerChrome).toContain('composerSendEl.hidden = sessionSearchOpen || value.length === 0');
    expect(syncComposerChrome).toContain('composerMicEl.hidden = rawValue.length > 0');
    expect(runPalettePick).toContain('syncComposerChrome()');
    expect(runPalettePick).toContain('commandInput.focus()');
  });
});
