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

  test('exposes pane tree and footer helpers through the browser entrypoint', () => {
    expect(Object.keys(entry).sort()).toEqual([
      'FOOTER_TIERS',
      'canFit',
      'createLeaf',
      'findLeafById',
      'findLeafByThreadId',
      'footerItems',
      'footerTier',
      'formatContext',
      'formatSpend',
      'hiddenFooterKeys',
      'insertBelow',
      'insertRelative',
      'isAgentPaneKind',
      'layoutRects',
      'leafIds',
      'moveLeaf',
      'removeLeaf',
      'resizeSplit',
      'retainThreads',
      'shouldApplyMetricsResponse',
      'spanLayout',
      'splitOrientation',
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
      orientation: 'column',
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
        orientation: 'column',
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
          orientation: 'column',
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
          orientation: 'column',
          x: 3,
          y: 97,
          width: 400,
          height: 10,
          ratio: 90 / 140,
        },
      ],
    });
  });

  test.each([
    {
      height: 245,
      firstHeight: 215,
      separatorHeight: 6,
      secondHeight: 24,
      ratio: 215 / 239,
    },
    {
      height: 100,
      firstHeight: 85,
      separatorHeight: 6,
      secondHeight: 9,
      ratio: 85 / 94,
    },
    { height: 4, firstHeight: 0, separatorHeight: 4, secondHeight: 0, ratio: 0 },
  ])(
    'keeps undersized $height px layouts finite and inside their rect',
    ({ height, firstHeight, separatorHeight, secondHeight, ratio }) => {
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
      const rect = { x: 10, y: 20, width: 800, height };
      const result = panes.layoutRects(tree, rect, minimums);

      expect(result).toEqual({
        leaves: [
          {
            leafId: 'leaf-a',
            threadId: 'thread-a',
            x: 10,
            y: 20,
            width: 800,
            height: firstHeight,
          },
          {
            leafId: 'leaf-b',
            threadId: 'thread-b',
            x: 10,
            y: 20 + firstHeight + separatorHeight,
            width: 800,
            height: secondHeight,
          },
        ],
        splits: [
          {
            splitId: 'split-1',
            orientation: 'column',
            x: 10,
            y: 20 + firstHeight,
            width: 800,
            height: separatorHeight,
            ratio,
          },
        ],
      });

      for (const geometry of [...result.leaves, ...result.splits]) {
        expect(Number.isFinite(geometry.width)).toBe(true);
        expect(Number.isFinite(geometry.height)).toBe(true);
        expect(geometry.width).toBeGreaterThanOrEqual(0);
        expect(geometry.height).toBeGreaterThanOrEqual(0);
        expect(geometry.y + geometry.height).toBeLessThanOrEqual(
          rect.y + rect.height,
        );
      }
      expect(Number.isFinite(result.splits[0].ratio)).toBe(true);
      expect(result.splits[0].ratio).toBeGreaterThanOrEqual(0);
      expect(result.splits[0].ratio).toBeLessThanOrEqual(1);
    },
  );
});

describe('Tauri pane tree 2D tiling', () => {
  const minimums = { width: 320, height: 120, separator: 6 };

  const column = () => panes.insertBelow(
    panes.createLeaf('leaf-a', 'thread-a'),
    'leaf-a',
    panes.createLeaf('leaf-b', 'thread-b'),
    'split-1',
  );

  test('treats a missing orientation as a column, so stored layouts still load', () => {
    expect(panes.splitOrientation({ type: 'split' })).toBe('column');
    expect(panes.splitOrientation({ type: 'split', orientation: 'row' })).toBe('row');
    expect(panes.splitOrientation(null)).toBe('column');

    const legacy = { type: 'split', id: 's', ratio: 0.5, first: panes.createLeaf('a', 't-a'), second: panes.createLeaf('b', 't-b') };
    const laid = panes.layoutRects(legacy, { x: 0, y: 0, width: 800, height: 400 }, minimums);
    expect(laid.splits[0].orientation).toBe('column');
    // Stacked, not side by side: equal widths, different tops.
    expect(laid.leaves.map((leaf: any) => leaf.width)).toEqual([800, 800]);
    expect(laid.leaves[0].y).toBeLessThan(laid.leaves[1].y);
  });

  test('places a pane on any of the four edges', () => {
    const leafA = panes.createLeaf('leaf-a', 'thread-a');
    const leafB = panes.createLeaf('leaf-b', 'thread-b');

    expect(panes.insertRelative(leafA, 'leaf-a', leafB, 's', 'right')).toEqual({
      type: 'split', id: 's', orientation: 'row', ratio: 0.5, first: leafA, second: leafB,
    });
    expect(panes.insertRelative(leafA, 'leaf-a', leafB, 's', 'left')).toEqual({
      type: 'split', id: 's', orientation: 'row', ratio: 0.5, first: leafB, second: leafA,
    });
    expect(panes.insertRelative(leafA, 'leaf-a', leafB, 's', 'above')).toEqual({
      type: 'split', id: 's', orientation: 'column', ratio: 0.5, first: leafB, second: leafA,
    });
    expect(panes.insertRelative(leafA, 'leaf-a', leafB, 's', 'below').first).toBe(leafA);
    expect(panes.insertRelative(leafA, 'leaf-a', leafB, 's', 'sideways')).toBe(leafA);
  });

  test('lays a row split out along the horizontal axis', () => {
    const tree = panes.insertRelative(
      panes.createLeaf('leaf-a', 'thread-a'),
      'leaf-a',
      panes.createLeaf('leaf-b', 'thread-b'),
      'split-1',
      'right',
    );

    const result = panes.layoutRects(tree, { x: 0, y: 0, width: 1000, height: 400 }, minimums);

    expect(result.splits[0]).toEqual({
      splitId: 'split-1', orientation: 'row', x: 497, y: 0, width: 6, height: 400, ratio: 497 / 994,
    });
    // Side by side: full height each, second starts past the separator.
    expect(result.leaves.map((leaf: any) => leaf.height)).toEqual([400, 400]);
    expect(result.leaves[0]).toMatchObject({ x: 0, width: 497 });
    expect(result.leaves[1]).toMatchObject({ x: 503, width: 497 });
  });

  test('sums minimums along the split axis and shares them across it', () => {
    const row = panes.insertRelative(
      panes.createLeaf('leaf-a', 'thread-a'), 'leaf-a',
      panes.createLeaf('leaf-b', 'thread-b'), 'split-1', 'right',
    );

    // Two 320-wide panes plus a 6px separator need 646 across, but only one
    // pane's height down — the mirror of the column case.
    expect(panes.canFit(row, { width: 646, height: 120 }, minimums)).toBe(true);
    expect(panes.canFit(row, { width: 645, height: 120 }, minimums)).toBe(false);
    expect(panes.canFit(column(), { width: 320, height: 246 }, minimums)).toBe(true);
    expect(panes.canFit(column(), { width: 320, height: 245 }, minimums)).toBe(false);
    expect(panes.canFit(null, { width: 0, height: 0 }, minimums)).toBe(true);
  });

  test('moves a pane beside another and collapses the branch it left', () => {
    const tree = panes.insertBelow(column(), 'leaf-b', panes.createLeaf('leaf-c', 'thread-c'), 'split-2');
    expect(panes.leafIds(tree)).toEqual(['leaf-a', 'leaf-b', 'leaf-c']);

    const moved = panes.moveLeaf(tree, 'leaf-c', 'leaf-a', 'left', 'split-3');

    expect(panes.leafIds(moved)).toEqual(['leaf-c', 'leaf-a', 'leaf-b']);
    expect(moved.orientation).toBe('column');
    expect(moved.first).toEqual({
      type: 'split', id: 'split-3', orientation: 'row', ratio: 0.5,
      first: { type: 'leaf', id: 'leaf-c', threadId: 'thread-c' },
      second: { type: 'leaf', id: 'leaf-a', threadId: 'thread-a' },
    });
    // split-2 held only leaf-b once leaf-c left, so it collapsed away.
    expect(JSON.stringify(moved)).not.toContain('split-2');
    expect(panes.leafIds(tree)).toEqual(['leaf-a', 'leaf-b', 'leaf-c']);
  });

  test('returns the same root for every move that cannot happen', () => {
    const tree = column();
    const lone = panes.createLeaf('leaf-a', 'thread-a');

    expect(panes.moveLeaf(tree, 'leaf-a', 'leaf-a', 'left', 's')).toBe(tree);
    expect(panes.moveLeaf(tree, 'leaf-a', 'missing', 'left', 's')).toBe(tree);
    expect(panes.moveLeaf(tree, 'missing', 'leaf-a', 'left', 's')).toBe(tree);
    expect(panes.moveLeaf(tree, 'leaf-a', 'leaf-b', 'nowhere', 's')).toBe(tree);
    expect(panes.moveLeaf(lone, 'leaf-a', 'leaf-a', 'left', 's')).toBe(lone);
    expect(panes.moveLeaf(null, 'leaf-a', 'leaf-b', 'left', 's')).toBe(null);
  });

  describe('retainThreads', () => {
    const trio = () => panes.insertBelow(
      column(), 'leaf-b', panes.createLeaf('leaf-c', 'thread-c'), 'split-2',
    );

    test('keeps the named panes and collapses the splits left holding one child', () => {
      const kept = panes.retainThreads(trio(), ['thread-a', 'thread-c']);

      expect(panes.leafIds(kept)).toEqual(['leaf-a', 'leaf-c']);
      // split-2 lost leaf-b, so it collapses instead of leaving an empty slot.
      expect(JSON.stringify(kept)).not.toContain('split-2');
    });

    test('accepts a Set as readily as an array', () => {
      const kept = panes.retainThreads(trio(), new Set(['thread-b']));

      expect(kept).toMatchObject({ type: 'leaf', id: 'leaf-b' });
    });

    test('returns null when nothing survives, so callers can tell empty from all', () => {
      expect(panes.retainThreads(trio(), [])).toBeNull();
      expect(panes.retainThreads(trio(), ['thread-gone'])).toBeNull();
      expect(panes.retainThreads(null, ['thread-a'])).toBeNull();
    });

    test('returns the same root when every pane is kept', () => {
      const tree = trio();

      expect(panes.retainThreads(tree, ['thread-a', 'thread-b', 'thread-c'])).toBe(tree);
    });

    test('leaves the tiled tree untouched', () => {
      const tree = trio();
      const snapshot = JSON.stringify(tree);

      panes.retainThreads(tree, ['thread-a']);

      expect(JSON.stringify(tree)).toBe(snapshot);
    });

    test('produces a layout the rect maths can place', () => {
      const kept = panes.retainThreads(trio(), ['thread-a', 'thread-c']);
      const result = panes.layoutRects(kept, { x: 0, y: 0, width: 900, height: 600 }, minimums);

      expect(result.leaves).toHaveLength(2);
      for (const geometry of result.leaves) {
        expect(geometry.height).toBeGreaterThanOrEqual(minimums.height);
      }
    });
  });

  describe('spanLayout', () => {
    // Three panes, so there is a genuine "the others" to stack.
    const trio = () => panes.insertBelow(
      column(), 'leaf-b', panes.createLeaf('leaf-c', 'thread-c'), 'split-2',
    );

    test('gives the spanned pane a full column and stacks the rest beside it', () => {
      const spanned = panes.spanLayout(trio(), 'leaf-b', 'row', 'span');

      expect(spanned.orientation).toBe('row');
      expect(spanned.first).toMatchObject({ type: 'leaf', id: 'leaf-b' });
      // The others keep their order and stack along the opposite axis.
      expect(spanned.second.orientation).toBe('column');
      expect(panes.leafIds(spanned.second)).toEqual(['leaf-a', 'leaf-c']);
      expect(panes.leafIds(spanned)).toEqual(['leaf-b', 'leaf-a', 'leaf-c']);
    });

    test('gives the spanned pane a full row and lines the rest up below', () => {
      const spanned = panes.spanLayout(trio(), 'leaf-a', 'column', 'span');

      expect(spanned.orientation).toBe('column');
      expect(spanned.first).toMatchObject({ type: 'leaf', id: 'leaf-a' });
      expect(spanned.second.orientation).toBe('row');
      expect(panes.leafIds(spanned.second)).toEqual(['leaf-b', 'leaf-c']);
    });

    test('splits the remainder into equal shares rather than halving away', () => {
      const four = panes.insertBelow(
        trio(), 'leaf-c', panes.createLeaf('leaf-d', 'thread-d'), 'split-3',
      );
      const spanned = panes.spanLayout(four, 'leaf-a', 'row', 'span');

      // Three others: the first divider gives away 1/3, the next 1/2 of what
      // is left — three equal shares.
      expect(spanned.second.ratio).toBeCloseTo(1 / 3);
      expect(spanned.second.second.ratio).toBeCloseTo(1 / 2);
    });

    test('is deterministic, so a rebuild keeps the ids its dividers resized', () => {
      const first = panes.spanLayout(trio(), 'leaf-b', 'row', 'span');
      const second = panes.spanLayout(trio(), 'leaf-b', 'row', 'span');

      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      expect(first.id).toBe('span-main');
    });

    test('leaves the tiled tree untouched', () => {
      const tree = trio();
      const snapshot = JSON.stringify(tree);

      panes.spanLayout(tree, 'leaf-b', 'row', 'span');

      expect(JSON.stringify(tree)).toBe(snapshot);
    });

    test('returns the original root when there is nothing to span', () => {
      const tree = trio();
      const lone = panes.createLeaf('leaf-a', 'thread-a');

      expect(panes.spanLayout(tree, 'missing', 'row', 'span')).toBe(tree);
      expect(panes.spanLayout(lone, 'leaf-a', 'row', 'span')).toBe(lone);
      expect(panes.spanLayout(null, 'leaf-a', 'row', 'span')).toBe(null);
    });

    test('produces a layout the rect maths can place', () => {
      const spanned = panes.spanLayout(trio(), 'leaf-b', 'row', 'span');
      const rect = { x: 0, y: 0, width: 1200, height: 700 };

      const result = panes.layoutRects(spanned, rect, minimums);

      expect(result.leaves).toHaveLength(3);
      for (const geometry of result.leaves) {
        expect(geometry.width).toBeGreaterThanOrEqual(minimums.width);
        expect(geometry.height).toBeGreaterThanOrEqual(minimums.height);
      }
    });
  });

  test('keeps mixed row-and-column layouts inside their rect', () => {
    const tree = panes.moveLeaf(
      panes.insertBelow(column(), 'leaf-b', panes.createLeaf('leaf-c', 'thread-c'), 'split-2'),
      'leaf-c', 'leaf-a', 'right', 'split-3',
    );
    const rect = { x: 4, y: 9, width: 1200, height: 700 };

    const result = panes.layoutRects(tree, rect, minimums);

    expect(result.leaves).toHaveLength(3);
    for (const geometry of [...result.leaves, ...result.splits]) {
      expect(geometry.x).toBeGreaterThanOrEqual(rect.x);
      expect(geometry.y).toBeGreaterThanOrEqual(rect.y);
      expect(geometry.x + geometry.width).toBeLessThanOrEqual(rect.x + rect.width);
      expect(geometry.y + geometry.height).toBeLessThanOrEqual(rect.y + rect.height);
    }
    expect(result.splits.map((split: any) => split.orientation).sort()).toEqual(['column', 'row']);
  });
});
