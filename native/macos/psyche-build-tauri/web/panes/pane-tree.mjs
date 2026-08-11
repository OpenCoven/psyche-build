// Splits carry an orientation so the canvas can tile in both directions.
// "column" stacks its children vertically (first on top) and is the default:
// layouts persisted before orientation existed omit the field entirely, and
// every one of them was a vertical stack.
const COLUMN = "column";
const ROW = "row";

// Where a pane lands relative to the leaf it is dropped on. `before` places the
// moved pane in the split's `first` slot, which is the top one for a column and
// the left one for a row.
const PLACEMENTS = {
  above: { orientation: COLUMN, before: true },
  below: { orientation: COLUMN, before: false },
  left: { orientation: ROW, before: true },
  right: { orientation: ROW, before: false },
};

export function splitOrientation(node) {
  return node && node.orientation === ROW ? ROW : COLUMN;
}

export function createLeaf(id, threadId) {
  return { type: "leaf", id, threadId };
}

export function leafIds(root) {
  if (!root) return [];
  if (root.type === "leaf") return [root.id];
  return [...leafIds(root.first), ...leafIds(root.second)];
}

export function findLeafById(root, id) {
  if (!root) return null;
  if (root.type === "leaf") return root.id === id ? root : null;
  return findLeafById(root.first, id) || findLeafById(root.second, id);
}

export function findLeafByThreadId(root, threadId) {
  if (!root) return null;
  if (root.type === "leaf") return root.threadId === threadId ? root : null;
  return (
    findLeafByThreadId(root.first, threadId) ||
    findLeafByThreadId(root.second, threadId)
  );
}

export function insertRelative(root, targetLeafId, leaf, splitId, position) {
  const placement = PLACEMENTS[position];
  if (!placement) return root;
  if (!root) return leaf;
  if (root.type === "leaf") {
    if (root.id !== targetLeafId) return root;
    return {
      type: "split",
      id: splitId,
      orientation: placement.orientation,
      ratio: 0.5,
      first: placement.before ? leaf : root,
      second: placement.before ? root : leaf,
    };
  }

  const first = insertRelative(root.first, targetLeafId, leaf, splitId, position);
  if (first !== root.first) return { ...root, first };

  const second = insertRelative(root.second, targetLeafId, leaf, splitId, position);
  return second === root.second ? root : { ...root, second };
}

export function insertBelow(root, targetLeafId, leaf, splitId) {
  return insertRelative(root, targetLeafId, leaf, splitId, "below");
}

function removeLeafNode(root, targetLeafId) {
  if (root.type === "leaf") return root.id === targetLeafId ? null : root;

  const first = removeLeafNode(root.first, targetLeafId);
  if (!first) return root.second;
  if (first !== root.first) return { ...root, first };

  const second = removeLeafNode(root.second, targetLeafId);
  if (!second) return root.first;
  return second === root.second ? root : { ...root, second };
}

export function removeLeaf(root, targetLeafId) {
  if (!root) return { root: null, nextLeafId: null };

  const orderedIds = leafIds(root);
  const targetIndex = orderedIds.indexOf(targetLeafId);
  if (targetIndex === -1) {
    return { root, nextLeafId: orderedIds[0] || null };
  }

  const nextRoot = removeLeafNode(root, targetLeafId);
  const remainingIds = leafIds(nextRoot);
  return {
    root: nextRoot,
    nextLeafId:
      remainingIds[targetIndex] || remainingIds[targetIndex - 1] || null,
  };
}

/**
 * Re-tile `leafId` next to `targetLeafId`. The pane is pruned from its old
 * position first, so dropping the last pane of a branch collapses that branch
 * instead of leaving an empty slot behind. Returns the original root unchanged
 * for every no-op — same leaf, unknown leaf, or a bad position — so callers can
 * compare by identity to decide whether anything moved.
 */
export function moveLeaf(root, leafId, targetLeafId, position, splitId) {
  if (!root || leafId === targetLeafId || !PLACEMENTS[position]) return root;

  const moving = findLeafById(root, leafId);
  if (!moving || !findLeafById(root, targetLeafId)) return root;

  const pruned = removeLeafNode(root, leafId);
  // A single-pane canvas has nowhere to move to, and pruning the target's only
  // sibling would leave the drop with no anchor.
  if (!pruned || !findLeafById(pruned, targetLeafId)) return root;

  return insertRelative(pruned, targetLeafId, { ...moving }, splitId, position);
}

/**
 * Keep only the leaves whose threadId is in `threadIds`, collapsing any split
 * left holding a single child. Used to scope the canvas to a focus set without
 * touching the tiled tree — the panes that drop out are still in the layout,
 * they are simply not drawn.
 *
 * Returns null when nothing survives, so the caller can tell "this set is
 * empty" from "this set is everything".
 */
export function retainThreads(root, threadIds) {
  if (!root) return null;
  const keep = threadIds instanceof Set ? threadIds : new Set(threadIds || []);
  if (root.type === "leaf") return keep.has(root.threadId) ? root : null;

  const first = retainThreads(root.first, keep);
  const second = retainThreads(root.second, keep);
  if (!first) return second;
  if (!second) return first;
  if (first === root.first && second === root.second) return root;
  return { ...root, first, second };
}

/**
 * Re-tile the whole canvas around one pane. `orientation` is the axis of the
 * top-level split, so ROW gives the pane a full column with the others stacked
 * beside it, and COLUMN gives it a full row with the others lined up below.
 *
 * The result is a *derived* tree — the caller keeps its tiled root untouched
 * and rebuilds this one whenever the membership or the spanned pane changes.
 * That is why the split ids are deterministic (`<idPrefix>-0`, `-1`, …): a
 * rebuild has to land on the same ids or every divider would lose its ratio.
 *
 * Returns the original root when there is nothing to span — no pane, an
 * unknown pane, or a canvas of one.
 */
export function spanLayout(root, leafId, orientation, idPrefix) {
  if (!root) return root;
  const target = findLeafById(root, leafId);
  if (!target) return root;

  const others = leafIds(root)
    .filter((id) => id !== leafId)
    .map((id) => findLeafById(root, id))
    .filter(Boolean);
  if (!others.length) return root;

  const primaryAxis = orientation === ROW ? ROW : COLUMN;
  // The others stack along the opposite axis: a pane holding a full column
  // leaves a column beside it, which is filled top to bottom.
  const crossAxis = primaryAxis === ROW ? COLUMN : ROW;
  const prefix = idPrefix || "span";

  // Right-leaning chain with descending ratios, so n panes end up n equal
  // shares rather than halving away to nothing.
  let rest = { ...others[others.length - 1] };
  for (let index = others.length - 2; index >= 0; index -= 1) {
    const remaining = others.length - index;
    rest = {
      type: "split",
      id: `${prefix}-${index}`,
      orientation: crossAxis,
      ratio: 1 / remaining,
      first: { ...others[index] },
      second: rest,
    };
  }

  return {
    type: "split",
    id: `${prefix}-main`,
    orientation: primaryAxis,
    ratio: 0.5,
    first: { ...target },
    second: rest,
  };
}

function nonNegativeFinite(value) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function clampedRatio(value) {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

// A split consumes space along its own axis and shares it across the other, so
// the minimum for an axis sums the children that stack along it and takes the
// larger of the children that sit beside it.
function minimumSize(root, minimums, axis) {
  if (!root) return 0;
  if (root.type === "leaf") {
    return nonNegativeFinite(axis === "width" ? minimums.width : minimums.height);
  }

  const first = minimumSize(root.first, minimums, axis);
  const second = minimumSize(root.second, minimums, axis);
  const splitAxis = splitOrientation(root) === ROW ? "width" : "height";
  return splitAxis === axis
    ? first + nonNegativeFinite(minimums.separator) + second
    : Math.max(first, second);
}

export function canFit(root, rect, minimums) {
  return (
    !root ||
    (rect.width >= minimumSize(root, minimums, "width") &&
      rect.height >= minimumSize(root, minimums, "height"))
  );
}

export function resizeSplit(root, splitId, ratio) {
  if (!root || root.type === "leaf") return root;
  if (root.id === splitId) {
    return { ...root, ratio: Math.min(1, Math.max(0, ratio)) };
  }

  const first = resizeSplit(root.first, splitId, ratio);
  if (first !== root.first) return { ...root, first };

  const second = resizeSplit(root.second, splitId, ratio);
  return second === root.second ? root : { ...root, second };
}

export function layoutRects(root, rect, minimums) {
  const leaves = [];
  const splits = [];

  function visit(node, x, y, nodeWidth, nodeHeight) {
    const safeWidth = nonNegativeFinite(nodeWidth);
    const safeHeight = nonNegativeFinite(nodeHeight);
    if (node.type === "leaf") {
      leaves.push({
        leafId: node.id,
        threadId: node.threadId,
        x,
        y,
        width: safeWidth,
        height: safeHeight,
      });
      return;
    }

    const horizontal = splitOrientation(node) === ROW;
    const axis = horizontal ? "width" : "height";
    const total = horizontal ? safeWidth : safeHeight;
    const separator = Math.min(total, nonNegativeFinite(minimums.separator));
    const available = total - separator;
    const minimumFirst = minimumSize(node.first, minimums, axis);
    const maximumFirst = available - minimumSize(node.second, minimums, axis);
    const requestedFirst = Math.round(available * clampedRatio(node.ratio));
    const firstSize =
      maximumFirst >= minimumFirst
        ? Math.min(maximumFirst, Math.max(minimumFirst, requestedFirst))
        : requestedFirst;
    const secondSize = available - firstSize;

    splits.push({
      splitId: node.id,
      orientation: horizontal ? ROW : COLUMN,
      x: horizontal ? x + firstSize : x,
      y: horizontal ? y : y + firstSize,
      width: horizontal ? separator : safeWidth,
      height: horizontal ? safeHeight : separator,
      ratio: available > 0 ? firstSize / available : 0,
    });

    if (horizontal) {
      visit(node.first, x, y, firstSize, safeHeight);
      visit(node.second, x + firstSize + separator, y, secondSize, safeHeight);
    } else {
      visit(node.first, x, y, safeWidth, firstSize);
      visit(node.second, x, y + firstSize + separator, safeWidth, secondSize);
    }
  }

  if (root) visit(root, rect.x, rect.y, rect.width, rect.height);
  return { leaves, splits };
}
