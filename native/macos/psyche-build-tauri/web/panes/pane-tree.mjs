const MIN_WIDTH = 320;
const MIN_HEIGHT = 120;
const SEPARATOR_SIZE = 6;

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

export function insertBelow(root, targetLeafId, leaf, splitId) {
  if (!root) return root;
  if (root.type === "leaf") {
    if (root.id !== targetLeafId) return root;
    return {
      type: "split",
      id: splitId,
      ratio: 0.5,
      first: root,
      second: leaf,
    };
  }

  const first = insertBelow(root.first, targetLeafId, leaf, splitId);
  if (first !== root.first) return { ...root, first };

  const second = insertBelow(root.second, targetLeafId, leaf, splitId);
  return second === root.second ? root : { ...root, second };
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

function minimumHeight(root) {
  if (root.type === "leaf") return MIN_HEIGHT;
  return minimumHeight(root.first) + SEPARATOR_SIZE + minimumHeight(root.second);
}

export function canFit(root, width, height) {
  return !root || (width >= MIN_WIDTH && height >= minimumHeight(root));
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

export function layoutRects(root, width, height) {
  const leaves = [];
  const splits = [];

  function visit(node, x, y, nodeWidth, nodeHeight) {
    if (node.type === "leaf") {
      leaves.push({ id: node.id, x, y, width: nodeWidth, height: nodeHeight });
      return;
    }

    const availableHeight = nodeHeight - SEPARATOR_SIZE;
    const minimumFirst = minimumHeight(node.first);
    const maximumFirst = availableHeight - minimumHeight(node.second);
    const requestedFirst = Math.round(availableHeight * node.ratio);
    const firstHeight = Math.min(
      maximumFirst,
      Math.max(minimumFirst, requestedFirst),
    );
    const secondY = y + firstHeight + SEPARATOR_SIZE;
    const secondHeight = availableHeight - firstHeight;

    splits.push({
      id: node.id,
      x,
      y: y + firstHeight,
      width: nodeWidth,
      height: SEPARATOR_SIZE,
      ratio: firstHeight / availableHeight,
    });
    visit(node.first, x, y, nodeWidth, firstHeight);
    visit(node.second, x, secondY, nodeWidth, secondHeight);
  }

  if (root) visit(root, 0, 0, width, height);
  return { leaves, splits };
}
