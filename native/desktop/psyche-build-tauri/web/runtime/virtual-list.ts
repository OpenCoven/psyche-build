export const VIRTUAL_LIST_THRESHOLD = 200;
export const VIRTUAL_LIST_OVERSCAN = 8;

export interface VirtualWindow {
  start: number;
  end: number;
  before: number;
  after: number;
}

export interface VirtualGroup {
  beforeCount: number;
  visibleStart: number;
  visibleEnd: number;
  afterCount: number;
}

export interface VirtualWindowOptions {
  count: number;
  rowHeight: number | ((index: number) => number);
  viewportHeight: number;
  scrollTop: number;
  overscan?: number;
  activeIndex?: number;
}

export interface VirtualItem<T, K> {
  index: number;
  key: K;
  item: T;
}

export interface VirtualItemsOptions<T, K>
  extends Omit<VirtualWindowOptions, 'count'> {
  getKey: (item: T, index: number) => K;
}

export interface VirtualItemsResult<T, K> extends VirtualWindow {
  items: Array<VirtualItem<T, K>>;
}

function boundedInteger(value: number, fallback = 0): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function estimatedHeight(
  rowHeight: VirtualWindowOptions['rowHeight'],
  index: number,
): number {
  const value = typeof rowHeight === 'function' ? rowHeight(index) : rowHeight;
  return Number.isFinite(value) && value > 0 ? value : 1;
}

export function shouldVirtualize(count: number): boolean {
  return boundedInteger(count) > VIRTUAL_LIST_THRESHOLD;
}

export function computeVirtualGroup(
  groupStart: number,
  groupCount: number,
  window: Pick<VirtualWindow, 'start' | 'end'>,
): VirtualGroup {
  const start = boundedInteger(groupStart);
  const count = boundedInteger(groupCount);
  const groupEnd = start + count;
  const visibleStart = Math.max(start, Math.min(groupEnd, window.start));
  const visibleEnd = Math.max(visibleStart, Math.min(groupEnd, window.end));
  if (visibleStart === visibleEnd) {
    return groupEnd <= window.start
      ? { beforeCount: count, visibleStart: groupEnd, visibleEnd: groupEnd, afterCount: 0 }
      : { beforeCount: 0, visibleStart: start, visibleEnd: start, afterCount: count };
  }
  return {
    beforeCount: visibleStart - start,
    visibleStart,
    visibleEnd,
    afterCount: groupEnd - visibleEnd,
  };
}

export function computeVirtualWindow(options: VirtualWindowOptions): VirtualWindow {
  const count = boundedInteger(options.count);
  if (count === 0) return { start: 0, end: 0, before: 0, after: 0 };

  const viewportHeight = Math.max(0, Number(options.viewportHeight) || 0);
  let totalHeight: number;
  let visibleStart: number;
  let visibleEnd: number;
  let offsetAt: (index: number) => number;

  if (typeof options.rowHeight === 'number') {
    const rowHeight = estimatedHeight(options.rowHeight, 0);
    totalHeight = count * rowHeight;
    const scrollTop = Math.min(
      Math.max(0, Number(options.scrollTop) || 0),
      Math.max(0, totalHeight - viewportHeight),
    );
    const viewportEnd = scrollTop + viewportHeight;
    visibleStart = Math.min(count - 1, Math.floor(scrollTop / rowHeight));
    visibleEnd = Math.min(
      count,
      Math.max(visibleStart + 1, Math.ceil(viewportEnd / rowHeight)),
    );
    offsetAt = (index) => index * rowHeight;
  } else {
    const offsets = new Array<number>(count + 1);
    offsets[0] = 0;
    for (let index = 0; index < count; index += 1) {
      offsets[index + 1] = offsets[index] + estimatedHeight(options.rowHeight, index);
    }

    totalHeight = offsets[count];
    const scrollTop = Math.min(
      Math.max(0, Number(options.scrollTop) || 0),
      Math.max(0, totalHeight - viewportHeight),
    );
    const viewportEnd = scrollTop + viewportHeight;
    visibleStart = count - 1;
    for (let index = 0; index < count; index += 1) {
      if (offsets[index + 1] > scrollTop) {
        visibleStart = index;
        break;
      }
    }
    visibleEnd = Math.min(count, visibleStart + 1);
    while (visibleEnd < count && offsets[visibleEnd] < viewportEnd) {
      visibleEnd += 1;
    }
    offsetAt = (index) => offsets[index];
  }

  const overscan = boundedInteger(options.overscan ?? VIRTUAL_LIST_OVERSCAN);
  let start = Math.max(0, visibleStart - overscan);
  let end = Math.min(count, visibleEnd + overscan);
  const activeIndex = options.activeIndex;
  if (Number.isInteger(activeIndex) && activeIndex! >= 0 && activeIndex! < count) {
    if (activeIndex! < start || activeIndex! >= end) {
      const windowLength = end - start;
      start = Math.max(0, Math.min(activeIndex! - overscan, count - windowLength));
      end = Math.min(count, start + windowLength);
    }
  }

  return {
    start,
    end,
    before: offsetAt(start),
    after: totalHeight - offsetAt(end),
  };
}

export function virtualizeItems<T, K>(
  items: readonly T[],
  options: VirtualItemsOptions<T, K>,
): VirtualItemsResult<T, K> {
  const window = computeVirtualWindow({ ...options, count: items.length });
  return {
    ...window,
    items: items.slice(window.start, window.end).map((item, offset) => {
      const index = window.start + offset;
      return { item, index, key: options.getKey(item, index) };
    }),
  };
}
