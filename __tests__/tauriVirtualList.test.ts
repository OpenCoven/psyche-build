import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  computeVirtualWindow,
  computeVirtualGroup,
  shouldVirtualize,
  virtualizeItems,
} from '../native/desktop/psyche-build-tauri/web/runtime/virtual-list';

const root = join(import.meta.dirname, '..');
const mainJs = readFileSync(join(
  root,
  'native/desktop/psyche-build-tauri/web/main.js',
), 'utf8');
const terminalController = readFileSync(join(
  root,
  'native/desktop/psyche-build-tauri/web/runtime/terminal-pane-controller.ts',
), 'utf8');
const stylesCss = readFileSync(join(
  root,
  'native/desktop/psyche-build-tauri/web/styles.css',
), 'utf8');
const statusControllerSource = readFileSync(join(
  root,
  'native/desktop/psyche-build-tauri/web/status/status-controller.mjs',
), 'utf8');

describe('desktop collection virtualization', () => {
  it('computes the planned fixed-height viewport with eight rows of overscan', () => {
    expect(computeVirtualWindow({
      count: 1_000,
      rowHeight: 28,
      viewportHeight: 280,
      scrollTop: 2_800,
      overscan: 8,
    })).toEqual({ start: 92, end: 118, before: 2_576, after: 24_696 });
  });

  it('keeps exactly 200 rows unvirtualized and virtualizes 201 rows', () => {
    expect(shouldVirtualize(200)).toBe(false);
    expect(shouldVirtualize(201)).toBe(true);
  });

  it('returns an empty bounded window for an empty collection', () => {
    expect(computeVirtualWindow({
      count: 0,
      rowHeight: 28,
      viewportHeight: 280,
      scrollTop: 200,
      overscan: 8,
    })).toEqual({ start: 0, end: 0, before: 0, after: 0 });
  });

  it('clamps invalid dimensions and scroll offsets to the collection bounds', () => {
    expect(computeVirtualWindow({
      count: 3,
      rowHeight: 20,
      viewportHeight: -10,
      scrollTop: 9_999,
      overscan: -4,
    })).toEqual({ start: 2, end: 3, before: 40, after: 0 });
  });

  it('includes a distant active row without expanding the rendered window', () => {
    expect(computeVirtualWindow({
      count: 1_000,
      rowHeight: 28,
      viewportHeight: 280,
      scrollTop: 2_800,
      overscan: 8,
      activeIndex: 7,
    })).toEqual({ start: 0, end: 26, before: 0, after: 27_272 });
    expect(computeVirtualWindow({
      count: 10_000,
      rowHeight: 28,
      viewportHeight: 280,
      scrollTop: 0,
      overscan: 8,
      activeIndex: 9_999,
    }).end - computeVirtualWindow({
      count: 10_000,
      rowHeight: 28,
      viewportHeight: 280,
      scrollTop: 0,
      overscan: 8,
      activeIndex: 9_999,
    }).start).toBe(18);
  });

  it('computes a fixed-height window in constant space for collections larger than array limits', () => {
    expect(computeVirtualWindow({
      count: 5_000_000_000,
      rowHeight: 28,
      viewportHeight: 280,
      scrollTop: 2_800,
      overscan: 8,
      activeIndex: 4_999_999_999,
    })).toEqual({
      start: 4_999_999_974,
      end: 5_000_000_000,
      before: 139_999_999_272,
      after: 0,
    });
  });

  it('keeps fixed-height window semantics identical to the variable-height path', () => {
    const cases = [
      { count: 1, viewportHeight: 0, scrollTop: 0, overscan: 0 },
      { count: 25, viewportHeight: 56, scrollTop: 28, overscan: 2 },
      { count: 25, viewportHeight: 57, scrollTop: 29, overscan: 2 },
      { count: 25, viewportHeight: 280, scrollTop: 9_999, overscan: 8 },
      { count: 25, viewportHeight: 56, scrollTop: 28, overscan: 2, activeIndex: 24 },
    ];

    for (const options of cases) {
      expect(computeVirtualWindow({ ...options, rowHeight: 28 })).toEqual(
        computeVirtualWindow({ ...options, rowHeight: () => 28 }),
      );
    }
  });

  it('does not retain a stale active row after focus preservation ends', () => {
    const focused = computeVirtualWindow({
      count: 10_000,
      rowHeight: 28,
      viewportHeight: 280,
      scrollTop: 0,
      overscan: 8,
      activeIndex: 9_999,
    });
    const scrolled = computeVirtualWindow({
      count: 10_000,
      rowHeight: 28,
      viewportHeight: 280,
      scrollTop: 2_800,
      overscan: 8,
    });
    expect(focused.end - focused.start).toBe(18);
    expect(scrolled).toMatchObject({ start: 92, end: 118 });
  });

  it('keeps caller-provided keys stable when the visible window changes', () => {
    const items = Array.from({ length: 240 }, (_, index) => ({
      id: `session-${index}`,
      label: `Session ${index}`,
    }));
    const first = virtualizeItems(items, {
      rowHeight: 28,
      viewportHeight: 280,
      scrollTop: 0,
      overscan: 8,
      getKey: (item) => item.id,
    });
    const second = virtualizeItems(items, {
      rowHeight: 28,
      viewportHeight: 280,
      scrollTop: 280,
      overscan: 8,
      getKey: (item) => item.id,
    });

    const shared = first.items.filter(({ key }) =>
      second.items.some((candidate) => candidate.key === key));
    expect(shared.length).toBeGreaterThan(0);
    expect(shared.every(({ item, key }) => item.id === key)).toBe(true);
  });

  it('bounds a 201-item collection and accounts for every omitted row', () => {
    const items = Array.from({ length: 201 }, (_, index) => ({ id: `process-${index}` }));
    const result = virtualizeItems(items, {
      rowHeight: 28,
      viewportHeight: 280,
      scrollTop: 2_800,
      overscan: 8,
      getKey: (item) => item.id,
    });

    expect(shouldVirtualize(items.length)).toBe(true);
    expect(result.items).toHaveLength(26);
    expect(result.before + result.items.length * 28 + result.after).toBe(201 * 28);
  });

  it('partitions omitted rows inside their owning hierarchical group', () => {
    const window = { start: 92, end: 118, before: 2_576, after: 24_696 };
    expect(computeVirtualGroup(80, 30, window)).toEqual({
      beforeCount: 12,
      visibleStart: 92,
      visibleEnd: 110,
      afterCount: 0,
    });
    expect(computeVirtualGroup(110, 30, window)).toEqual({
      beforeCount: 0,
      visibleStart: 110,
      visibleEnd: 118,
      afterCount: 22,
    });
    expect(computeVirtualGroup(140, 10, window)).toEqual({
      beforeCount: 0,
      visibleStart: 140,
      visibleEnd: 140,
      afterCount: 10,
    });
  });

  it('uses estimated variable file-row heights for spacers and visibility', () => {
    const heights = [20, 40, 24, 60, 20, 32];
    expect(computeVirtualWindow({
      count: heights.length,
      rowHeight: (index) => heights[index],
      viewportHeight: 50,
      scrollTop: 61,
      overscan: 0,
    })).toEqual({ start: 2, end: 4, before: 60, after: 52 });
  });

  it('renders session and file collections through stable keyed windows and spacers', () => {
    expect(mainJs).toContain('virtualRuntime.shouldVirtualize(sessionRows.length)');
    expect(mainJs).toContain('virtualRuntime.virtualizeItems(sessionRows');
    expect(mainJs).toContain('getKey: function (item) { return item.key; }');
    expect(mainJs).toContain('ptyRuntime.shouldVirtualize(fileRows.length)');
    expect(mainJs).toContain('ptyRuntime.virtualizeItems(fileRows');
    expect(mainJs).toContain('getKey: function (item) { return item.entry ? item.entry.path : item.key; }');
    expect(mainJs).toContain('spacer.className = "virtual-list-spacer virtual-list-spacer-" + position');
    expect(mainJs).toContain('createVirtualListSpacer("before"');
    expect(mainJs).toContain('createVirtualListSpacer("after"');
    expect(mainJs).toContain('row.dataset.virtualKey =');
  });

  it('coalesces collection scroll rendering and retains the active stable key', () => {
    expect(mainJs).toContain('terminalFrameScheduler.schedule("collection:sessions"');
    expect(mainJs).toContain('terminalFrameScheduler.schedule("collection:files"');
    expect(mainJs).toContain('preserveFocus: false');
    expect(mainJs).toContain('activeIndex: sessionActiveIndex');
    expect(mainJs).toContain('activeIndex: fileActiveIndex');
    expect(mainJs).toContain('virtualState.focusKey = "";');
  });

  it('restores focus after scroll only when the stable row remains mounted', () => {
    expect(mainJs).toContain('restoreFocusKey: sessionScrollFocusKey');
    expect(mainJs).toContain('restoreProjectFilesId: sessionScrollProjectFilesId');
    expect(mainJs).toContain('restoreFocusKey: fileScrollFocusKey');
    expect(mainJs).toContain('var requestedRestoreKey = options && options.restoreFocusKey');
    expect(mainJs).toContain('var requestedProjectFilesId = options && options.restoreProjectFilesId');
    expect(mainJs).toContain('var restoreFileFocusKey = options && options.restoreFocusKey');
    expect(mainJs).toContain('var replacementProjectFilesButton = !requestedRestoreKey && activeProjectFilesId');
    expect(mainJs).toContain(
      'if (!replacementProjectFilesButton &&\n' +
      '          shouldRestoreTreeFocus && (!requestedRestoreKey || requestedFocusItem)) {',
    );
    expect(mainJs).toContain('if (replacementProjectFilesButton) replacementProjectFilesButton.focus();');
  });

  it('maps session scroll coordinates through measured category structure', () => {
    const start = mainJs.indexOf('function sessionVirtualScrollTop(');
    const end = mainJs.indexOf('\n  function refreshSidebar(', start);
    expect(start).toBeGreaterThan(-1);
    const source = mainJs.slice(start, end);
    const categories = [
      { dataset: { virtualRowStart: '0', virtualRowCount: '100' }, firstElementChild: { offsetHeight: 20 }, getBoundingClientRect: () => ({ top: -4_400, bottom: 80 }) },
      { dataset: { virtualRowStart: '100', virtualRowCount: '30' }, firstElementChild: { offsetHeight: 20 }, getBoundingClientRect: () => ({ top: 80, bottom: 1_420 }) },
    ];
    const sessionListEl = {
      scrollTop: 4_600,
      getBoundingClientRect: () => ({ top: 100 }),
      querySelectorAll: () => categories,
    };
    const helper = new Function(
      'sessionListEl',
      `${source}; return sessionVirtualScrollTop;`,
    )(sessionListEl) as (height: number) => number;

    expect(helper(44)).toBe(4_400);
    const rendererStart = mainJs.indexOf('function renderSessionList(');
    const rendererEnd = mainJs.indexOf('\n  function applyProjectAppearance(', rendererStart);
    const renderer = mainJs.slice(rendererStart, rendererEnd);
    expect(renderer.indexOf('sessionVirtualScrollTop(sessionRowHeight)')).toBeGreaterThan(-1);
    expect(renderer.indexOf('sessionVirtualScrollTop(sessionRowHeight)')).toBeLessThan(
      renderer.indexOf('sessionListEl.replaceChildren()'),
    );
  });

  it('maps a distant logical session target through accumulated header geometry before focusing', () => {
    const helpersStart = mainJs.indexOf('function sessionVirtualScrollTop(');
    const helpersEnd = mainJs.indexOf('\n  function refreshSidebar(', helpersStart);
    const helpersSource = mainJs.slice(helpersStart, helpersEnd);
    expect(helpersSource).toContain('function sessionOuterScrollTopForRow(');

    let scrollTop = 0;
    const listTop = 100;
    const categories = [
      { start: 0, count: 200, physicalTop: 400, labelHeight: 24 },
      { start: 200, count: 100, physicalTop: 12_000, labelHeight: 20 },
    ].map((category) => ({
      dataset: {
        virtualRowStart: String(category.start),
        virtualRowCount: String(category.count),
      },
      firstElementChild: { offsetHeight: category.labelHeight },
      getBoundingClientRect: () => ({
        top: listTop + category.physicalTop - scrollTop,
        bottom: listTop + category.physicalTop - scrollTop
          + category.labelHeight + category.count * 44,
      }),
    }));
    const targetKey = 'row-250';
    let mounted: Array<{ dataset: { treeKey: string }; focus: () => void }> = [];
    let focused = false;
    const sessionListEl = {
      clientHeight: 440,
      get scrollTop() { return scrollTop; },
      set scrollTop(value: number) { scrollTop = value; },
      getBoundingClientRect: () => ({ top: listTop }),
      querySelectorAll: () => categories,
      __psycheVirtualState: {
        rowIndexes: new Map([[targetKey, 250]]),
        rowHeight: 44,
        focusKey: '',
      },
    };
    const helpers = new Function(
      'sessionListEl',
      `${helpersSource}; return { sessionVirtualScrollTop, sessionOuterScrollTopForRow };`,
    )(sessionListEl) as {
      sessionVirtualScrollTop: (height: number) => number;
      sessionOuterScrollTopForRow: (index: number, height: number) => number;
    };
    const focusStart = mainJs.indexOf('function focusLogicalSessionTreeKey(');
    const focusEnd = mainJs.indexOf('\n  function parentSessionTreeItem(', focusStart);
    const focusSource = mainJs.slice(focusStart, focusEnd);
    const focusLogical = new Function(
      'visibleSessionTreeItems',
      'focusSessionTreeItem',
      'sessionOuterScrollTopForRow',
      'sessionListEl',
      'renderSessionList',
      `${focusSource}; return focusLogicalSessionTreeKey;`,
    )(
      () => mounted,
      (item: { focus: () => void }) => { item.focus(); return true; },
      helpers.sessionOuterScrollTopForRow,
      sessionListEl,
      () => {
        const window = computeVirtualWindow({
          count: 300,
          rowHeight: 44,
          viewportHeight: sessionListEl.clientHeight,
          scrollTop: helpers.sessionVirtualScrollTop(44),
          overscan: 8,
        });
        mounted = window.start <= 250 && window.end > 250
          ? [{ dataset: { treeKey: targetKey }, focus: () => { focused = true; } }]
          : [];
        const target = mounted.find((item) => item.dataset.treeKey === targetKey);
        if (target) target.focus();
      },
    ) as (key: string) => boolean;

    expect(focusLogical(targetKey)).toBe(true);
    expect(scrollTop).toBe(14_220);
    expect(mounted).toHaveLength(1);
    expect(focused).toBe(true);
  });

  it('uses logical session keys to traverse across an unmounted boundary', () => {
    const source = mainJs.slice(
      mainJs.indexOf('function handleSessionTreeKeydown('),
      mainJs.indexOf('\n  function restoreSessionTreeFocus(', mainJs.indexOf('function handleSessionTreeKeydown(')),
    );
    const logicalKeys = ['project', 'branch', ...Array.from({ length: 201 }, (_, i) => `row-${i}`)];
    const current = { dataset: { treeKey: 'row-25', treeItem: 'session' }, matches: () => true };
    const focused: string[] = [];
    const handler = new Function(
      'visibleSessionTreeItems',
      'focusSessionTreeItem',
      'focusLogicalSessionTreeKey',
      'sessionListEl',
      'document',
      'findProject',
      'openSessionContextMenu',
      'projectAppearanceContextActions',
      'toggleSessionTreeDisclosure',
      'parentSessionTreeItem',
      'firstChildSessionTreeItem',
      'activateSessionTreeItem',
      `let sessionTreeFocusKey = ''; ${source}; return handleSessionTreeKeydown;`,
    )(
      () => [current],
      () => true,
      (key: string) => { focused.push(key); return true; },
      { __psycheVirtualState: { virtualized: true, logicalKeys } },
      { activeElement: current },
      () => null,
      () => undefined,
      () => [],
      () => false,
      () => null,
      () => null,
      () => false,
    ) as (event: Record<string, unknown>) => void;
    const preventDefault = () => undefined;

    handler({ target: current, key: 'ArrowDown', preventDefault });
    expect(focused).toEqual(['row-26']);
  });

  it('resolves an unmounted first child for virtualized ArrowRight navigation', () => {
    const source = mainJs.slice(
      mainJs.indexOf('function handleSessionTreeKeydown('),
      mainJs.indexOf('\n  function restoreSessionTreeFocus(', mainJs.indexOf('function handleSessionTreeKeydown(')),
    );
    const branch = {
      dataset: { treeKey: 'branch', treeItem: 'branch' },
      matches: () => true,
      getAttribute: () => 'true',
    };
    const focused: string[] = [];
    const handler = new Function(
      'visibleSessionTreeItems', 'focusSessionTreeItem', 'focusLogicalSessionTreeKey',
      'sessionListEl', 'document', 'findProject', 'openSessionContextMenu',
      'projectAppearanceContextActions', 'toggleSessionTreeDisclosure',
      'parentSessionTreeItem', 'firstChildSessionTreeItem', 'activateSessionTreeItem',
      `let sessionTreeFocusKey = ''; ${source}; return handleSessionTreeKeydown;`,
    )(
      () => [branch], () => true,
      (key: string) => { focused.push(key); return true; },
      { __psycheVirtualState: {
        virtualized: true,
        logicalKeys: ['branch', 'row-0'],
        childKeys: new Map([['branch', 'row-0']]),
      } },
      { activeElement: branch }, () => null, () => undefined, () => [],
      () => false, () => null, () => null, () => false,
    ) as (event: Record<string, unknown>) => void;

    handler({ target: branch, key: 'ArrowRight', preventDefault: () => undefined });
    expect(focused).toEqual(['row-0']);
  });

  it('uses stable file keys to traverse across an unmounted boundary', () => {
    const start = mainJs.indexOf('function handleVirtualFileTreeKeydown(');
    const end = mainJs.indexOf('\n  if (fileTreeEl) {', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const source = mainJs.slice(start, end);
    const current = { dataset: { virtualKey: '/repo/file-25' } };
    const focused: string[] = [];
    const rows = Array.from({ length: 201 }, (_, i) => ({ key: `/repo/file-${i}` }));
    const handler = new Function(
      'renderedFileRows',
      'focusLogicalFileRow',
      'document',
      `${source}; return handleVirtualFileTreeKeydown;`,
    )(
      rows,
      (key: string) => { focused.push(key); return true; },
      { activeElement: current },
    ) as (event: Record<string, unknown>) => void;

    handler({ target: current, key: 'ArrowDown', preventDefault: () => undefined });
    expect(focused).toEqual(['/repo/file-26']);
  });

  it('renders file errors as stable keyboard-focusable virtual rows', () => {
    const start = mainJs.indexOf('function renderFileRows(');
    const end = mainJs.indexOf('\n  function focusLogicalFileRow(', start);
    const source = mainJs.slice(start, end);

    expect(source).toContain('error.dataset.virtualKey = fileRow.key;');
    expect(source).toContain('error.tabIndex = 0;');
    expect(source).toContain('error.className = "panel-error file-row-error";');
    expect(stylesCss).toMatch(
      /\.file-row-error\s*\{[\s\S]*?height:\s*var\(--file-row-h\)[\s\S]*?max-height:\s*var\(--file-row-h\)[\s\S]*?white-space:\s*nowrap[\s\S]*?overflow:\s*hidden/,
    );
  });

  it('keeps terminal history owned by xterm with a ten-thousand-line bound', () => {
    expect(terminalController).toContain('scrollback: 10_000');
    expect(mainJs).not.toContain('virtualizeItems(terminal');
  });

  it('documents diagnostics as a bounded snapshot rather than an absent list surface', () => {
    expect(statusControllerSource).toContain(
      'Diagnostics are a bounded text snapshot, not a row collection',
    );
  });

  it('ties session and file estimates to enforced CSS row geometry', () => {
    expect(stylesCss).toMatch(/--session-row-h:\s*44px;/);
    expect(stylesCss).toMatch(/--file-row-h:\s*26px;/);
    expect(stylesCss).toMatch(/\.session-row\s*\{[\s\S]*?min-height:\s*var\(--session-row-h\)/);
    expect(stylesCss).toMatch(/\.file-row\s*\{[\s\S]*?min-height:\s*var\(--file-row-h\)/);
    expect(mainJs).toContain('collectionRowHeight(sessionListEl, "--session-row-h", 44)');
    expect(mainJs).toContain('collectionRowHeight(fileTreeEl, "--file-row-h", 26)');
    expect(mainJs).toContain('rowHeight: sessionRowHeight');
    expect(mainJs).toContain('rowHeight: fileRowHeight');
    expect(mainJs).not.toContain('categoryBeforeCount * 28');
    expect(mainJs).not.toContain('categoryAfterCount * 28');
    expect(stylesCss).toMatch(/--status-detail-row-h:\s*68px;/);
    expect(stylesCss).toMatch(
      /\.status-agent-row,[\s\S]*?min-height:\s*calc\(var\(--status-detail-row-h\) - 8px\)/,
    );
    expect(stylesCss).toMatch(
      /\.status-agent-row,[\s\S]*?height:\s*calc\(var\(--status-detail-row-h\) - 8px\)[\s\S]*?max-height:\s*calc\(var\(--status-detail-row-h\) - 8px\)[\s\S]*?overflow:\s*hidden/,
    );
    expect(statusControllerSource).toContain('const STATUS_DETAIL_ROW_HEIGHT = 68;');
  });
});
