import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';

const panesRoot = join(
  process.cwd(),
  'native/macos/psyche-build-tauri/web/panes',
);
const panes = await import(pathToFileURL(join(panesRoot, 'pane-tree.mjs')).href);
const entry = await import(pathToFileURL(join(panesRoot, 'pane-entry.js')).href);

describe('Tauri physical pane tree', () => {
  const minimums = { width: 320, height: 120, separator: 6 };

  test('exposes every pane-tree API through the browser entrypoint', () => {
    expect(Object.keys(entry).sort()).toEqual([
      'canFit',
      'createLeaf',
      'findLeafById',
      'findLeafByThreadId',
      'insertBelow',
      'layoutRects',
      'leafIds',
      'removeLeaf',
      'resizeSplit',
    ]);
  });

  test('creates terminal leaves', () => {
    expect(panes.createLeaf('leaf-a', 'thread-a')).toEqual({
      type: 'leaf',
      id: 'leaf-a',
      threadId: 'thread-a',
    });
  });

  test('inserts panes below a leaf without mutating the existing tree', () => {
    const leafA = panes.createLeaf('leaf-a', 'thread-a');
    const leafB = panes.createLeaf('leaf-b', 'thread-b');

    expect(panes.insertBelow(null, 'missing', leafA, 'split-unused')).toBe(leafA);

    const firstTree = panes.insertBelow(leafA, 'leaf-a', leafB, 'split-1');

    expect(firstTree).toEqual({
      type: 'split',
      id: 'split-1',
      ratio: 0.5,
      first: leafA,
      second: leafB,
    });
    expect(panes.leafIds(firstTree)).toEqual(['leaf-a', 'leaf-b']);

    const leafC = panes.createLeaf('leaf-c', 'thread-c');
    const nestedTree = panes.insertBelow(firstTree, 'leaf-a', leafC, 'split-2');

    expect(panes.leafIds(nestedTree)).toEqual(['leaf-a', 'leaf-c', 'leaf-b']);
    expect(panes.leafIds(firstTree)).toEqual(['leaf-a', 'leaf-b']);
  });

  test('finds leaves recursively by pane or Coven thread identity', () => {
    const tree = panes.insertBelow(
      panes.createLeaf('leaf-a', 'thread-a'),
      'leaf-a',
      panes.createLeaf('leaf-b', 'thread-b'),
      'split-1',
    );

    expect(panes.findLeafById(tree, 'leaf-b')).toEqual({
      type: 'leaf',
      id: 'leaf-b',
      threadId: 'thread-b',
    });
    expect(panes.findLeafByThreadId(tree, 'thread-a')).toEqual({
      type: 'leaf',
      id: 'leaf-a',
      threadId: 'thread-a',
    });
    expect(panes.findLeafById(tree, 'missing')).toBeNull();
    expect(panes.findLeafByThreadId(tree, 'missing')).toBeNull();
  });

  test('removes leaves, collapses ancestors, and chooses the next ordered leaf', () => {
    const leafA = panes.createLeaf('leaf-a', 'thread-a');
    const leafB = panes.createLeaf('leaf-b', 'thread-b');
    const leafC = panes.createLeaf('leaf-c', 'thread-c');
    const firstTree = panes.insertBelow(leafA, 'leaf-a', leafB, 'split-1');
    const tree = panes.insertBelow(firstTree, 'leaf-b', leafC, 'split-2');

    expect(panes.removeLeaf(tree, 'leaf-b')).toEqual({
      root: {
        type: 'split',
        id: 'split-1',
        ratio: 0.5,
        first: leafA,
        second: leafC,
      },
      nextLeafId: 'leaf-c',
    });
    expect(panes.removeLeaf(leafA, 'leaf-a')).toEqual({
      root: null,
      nextLeafId: null,
    });
    expect(panes.removeLeaf(tree, 'missing')).toEqual({
      root: tree,
      nextLeafId: 'leaf-a',
    });
  });

  test('requires minimum vertical space for every descendant', () => {
    const tree = panes.insertBelow(
      panes.createLeaf('leaf-a', 'thread-a'),
      'leaf-a',
      panes.createLeaf('leaf-b', 'thread-b'),
      'split-1',
    );

    expect(panes.canFit(tree, { x: 0, y: 0, width: 319, height: 246 }, minimums)).toBe(false);
    expect(panes.canFit(tree, { x: 0, y: 0, width: 320, height: 245 }, minimums)).toBe(false);
    expect(panes.canFit(tree, { x: 0, y: 0, width: 320, height: 246 }, minimums)).toBe(true);

    const customMinimums = { width: 400, height: 100, separator: 10 };
    expect(
      panes.canFit(tree, { x: 5, y: 10, width: 400, height: 210 }, customMinimums),
    ).toBe(true);
    expect(
      panes.canFit(tree, { x: 5, y: 10, width: 399, height: 210 }, customMinimums),
    ).toBe(false);
    expect(
      panes.canFit(tree, { x: 5, y: 10, width: 400, height: 209 }, customMinimums),
    ).toBe(false);
  });

  test('resizes a split immutably and clamps its ratio', () => {
    const tree = panes.insertBelow(
      panes.createLeaf('leaf-a', 'thread-a'),
      'leaf-a',
      panes.createLeaf('leaf-b', 'thread-b'),
      'split-1',
    );
    const high = panes.resizeSplit(tree, 'split-1', 2);
    const low = panes.resizeSplit(tree, 'split-1', -1);

    expect(high.ratio).toBe(1);
    expect(low.ratio).toBe(0);
    expect(tree.ratio).toBe(0.5);
  });

  test('lays out panes vertically and clamps ratios to descendant minimums', () => {
    const tree = panes.resizeSplit(
      panes.insertBelow(
        panes.createLeaf('leaf-a', 'thread-a'),
        'leaf-a',
        panes.createLeaf('leaf-b', 'thread-b'),
        'split-1',
      ),
      'split-1',
      0.9,
    );

    expect(
      panes.layoutRects(
        tree,
        { x: 10, y: 20, width: 800, height: 300 },
        minimums,
      ),
    ).toEqual({
      leaves: [
        {
          leafId: 'leaf-a',
          threadId: 'thread-a',
          x: 10,
          y: 20,
          width: 800,
          height: 174,
        },
        {
          leafId: 'leaf-b',
          threadId: 'thread-b',
          x: 10,
          y: 200,
          width: 800,
          height: 120,
        },
      ],
      splits: [
        {
          splitId: 'split-1',
          x: 10,
          y: 194,
          width: 800,
          height: 6,
          ratio: 0.5918367346938775,
        },
      ],
    });
  });

  test('lays out panes with caller-provided minimums', () => {
    const customMinimums = { width: 200, height: 50, separator: 10 };
    const tree = panes.resizeSplit(
      panes.insertBelow(
        panes.createLeaf('leaf-a', 'thread-a'),
        'leaf-a',
        panes.createLeaf('leaf-b', 'thread-b'),
        'split-1',
      ),
      'split-1',
      0.8,
    );

    expect(
      panes.layoutRects(
        tree,
        { x: 3, y: 7, width: 400, height: 150 },
        customMinimums,
      ),
    ).toEqual({
      leaves: [
        {
          leafId: 'leaf-a',
          threadId: 'thread-a',
          x: 3,
          y: 7,
          width: 400,
          height: 90,
        },
        {
          leafId: 'leaf-b',
          threadId: 'thread-b',
          x: 3,
          y: 107,
          width: 400,
          height: 50,
        },
      ],
      splits: [
        {
          splitId: 'split-1',
          x: 3,
          y: 97,
          width: 400,
          height: 10,
          ratio: 90 / 140,
        },
      ],
    });
  });
});
