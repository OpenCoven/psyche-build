import { createCanonicalElementSemantics, type CanonicalElementSemantics } from './policy.js';
import type { SemanticSnapshot } from './types.js';

const MAX_SNAPSHOTS = 128;
const MAX_NODES = 2_000;

export class BrowserSemanticSnapshotRegistry {
  private readonly snapshots = new Map<string, SemanticSnapshot>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  store(value: unknown, tabId: string, generation: number): SemanticSnapshot {
    const snapshot = requireSnapshot(value, tabId, generation, this.now());
    this.invalidateTab(tabId);
    this.snapshots.set(snapshot.id, snapshot);
    while (this.snapshots.size > MAX_SNAPSHOTS) {
      const oldest = this.snapshots.keys().next().value as string | undefined;
      if (!oldest) break;
      this.snapshots.delete(oldest);
    }
    return snapshot;
  }

  resolve(input: { tabId: string; generation: number; snapshotId: string; elementRef: string }): CanonicalElementSemantics {
    const snapshot = this.snapshots.get(input.snapshotId);
    if (!snapshot || snapshot.tabId !== input.tabId || snapshot.generation !== input.generation
      || Date.parse(snapshot.expiresAt) <= this.now().getTime()) {
      if (snapshot) this.snapshots.delete(snapshot.id);
      throw Object.assign(new Error('semantic snapshot is missing or stale'), { code: 'snapshot_missing' });
    }
    const node = snapshot.nodes.find((candidate) => candidate.ref === input.elementRef);
    if (!node) throw Object.assign(new Error('semantic element reference is missing'), { code: 'ref_missing' });
    return createCanonicalElementSemantics({
      role: node.role,
      submit: node.state?.submit === true,
      secret: node.value?.secret === true,
    });
  }

  invalidateTab(tabId: string, keepGeneration?: number): void {
    for (const [id, snapshot] of this.snapshots) {
      if (snapshot.tabId === tabId && (keepGeneration === undefined || snapshot.generation !== keepGeneration)) {
        this.snapshots.delete(id);
      }
    }
  }
}

function requireSnapshot(value: unknown, tabId: string, generation: number, now: Date): SemanticSnapshot {
  if (!plain(value)) throw invalid();
  const snapshot = value as Record<string, unknown>;
  const allowed = ['schema', 'id', 'tabId', 'generation', 'url', 'title', 'loading', 'viewport', 'capturedAt', 'nodes', 'truncated', 'opaqueFrames', 'expiresAt', 'screenshot'];
  exactKeys(snapshot, allowed);
  if (snapshot.schema !== 'psyche.browser.snapshot/v1' || snapshot.tabId !== tabId
    || snapshot.generation !== generation || !boundedString(snapshot.id, 256)
    || !boundedString(snapshot.url, 2_048) || !boundedString(snapshot.title, 512)
    || typeof snapshot.loading !== 'boolean' || !plain(snapshot.viewport)
    || !boundedString(snapshot.capturedAt, 64) || !Array.isArray(snapshot.nodes)
    || snapshot.nodes.length > MAX_NODES || typeof snapshot.truncated !== 'boolean'
    || !Number.isInteger(snapshot.opaqueFrames) || (snapshot.opaqueFrames as number) < 0
    || !boundedString(snapshot.expiresAt, 64)
    || !Number.isFinite(Date.parse(snapshot.expiresAt as string))
    || Date.parse(snapshot.expiresAt as string) <= now.getTime()) throw invalid();
  exactKeys(snapshot.viewport, ['width', 'height']);
  const viewport = snapshot.viewport as Record<string, unknown>;
  if (!finiteRange(viewport.width, 0, 100_000) || !finiteRange(viewport.height, 0, 100_000)) throw invalid();
  const refs = new Set<string>();
  const nodes = snapshot.nodes.map((node) => copyNode(node, refs));
  let screenshot: Readonly<{ pngBase64: string; width: number; height: number }> | undefined;
  if (snapshot.screenshot !== undefined) {
    if (!plain(snapshot.screenshot)) throw invalid();
    exactKeys(snapshot.screenshot, ['pngBase64', 'width', 'height']);
    const encoded = snapshot.screenshot.pngBase64;
    const width = snapshot.screenshot.width;
    const height = snapshot.screenshot.height;
    if (!boundedString(encoded, 4 * 1024 * 1024) || encoded.length === 0 || encoded.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded as string)
      || !Number.isInteger(width) || !Number.isInteger(height)
      || !finiteRange(width, 1, 8192) || !finiteRange(height, 1, 8192)
      || (width as number) * (height as number) > 16 * 1024 * 1024) throw invalid();
    screenshot = Object.freeze({ pngBase64: encoded as string, width: width as number, height: height as number });
  }
  return Object.freeze({
    schema: 'psyche.browser.snapshot/v1',
    id: snapshot.id,
    tabId,
    generation,
    url: snapshot.url,
    title: snapshot.title,
    loading: snapshot.loading,
    viewport: Object.freeze({ width: viewport.width, height: viewport.height }),
    capturedAt: snapshot.capturedAt,
    nodes: Object.freeze(nodes),
    truncated: snapshot.truncated,
    opaqueFrames: snapshot.opaqueFrames,
    expiresAt: snapshot.expiresAt,
    ...(screenshot ? { screenshot } : {}),
  }) as SemanticSnapshot;
}

function copyNode(value: unknown, refs: Set<string>): SemanticSnapshot['nodes'][number] {
  if (!plain(value)) throw invalid();
  exactKeys(value, ['ref', 'role', 'name', 'state', 'value', 'bounds', 'actions', 'children']);
  if (!boundedString(value.ref, 64) || refs.has(value.ref as string)
    || !boundedString(value.role, 64) || !boundedString(value.name, 512)) throw invalid();
  refs.add(value.ref as string);
  const node: Record<string, unknown> = { ref: value.ref, role: value.role, name: value.name };
  if (value.state !== undefined) {
    if (!plain(value.state)) throw invalid();
    const state: Record<string, boolean | string | number> = {};
    for (const [key, item] of Object.entries(value.state)) {
      if (!boundedString(key, 64) || !['boolean', 'string', 'number'].includes(typeof item)
        || (typeof item === 'string' && !boundedString(item, 512)) || (typeof item === 'number' && !Number.isFinite(item))) throw invalid();
      state[key] = item as boolean | string | number;
    }
    node.state = Object.freeze(state);
  }
  if (value.value !== undefined) {
    if (!plain(value.value)) throw invalid();
    exactKeys(value.value, ['kind', 'value', 'secret']);
    if (!boundedString(value.value.kind, 64)
      || (value.value.value !== undefined && !boundedString(value.value.value, 512))
      || (value.value.secret !== undefined && typeof value.value.secret !== 'boolean')) throw invalid();
    node.value = Object.freeze({ ...value.value });
  }
  if (value.bounds !== undefined) {
    if (!plain(value.bounds)) throw invalid();
    const bounds = value.bounds;
    exactKeys(bounds, ['x', 'y', 'width', 'height']);
    if (!['x', 'y', 'width', 'height'].every((key) => Number.isFinite(bounds[key]))) throw invalid();
    node.bounds = Object.freeze({ ...bounds });
  }
  for (const key of ['actions', 'children'] as const) {
    if (value[key] !== undefined) {
      if (!Array.isArray(value[key]) || value[key].length > MAX_NODES
        || value[key].some((item) => !boundedString(item, 64))) throw invalid();
      node[key] = Object.freeze([...value[key]]);
    }
  }
  return Object.freeze(node) as unknown as SemanticSnapshot['nodes'][number];
}

function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw invalid();
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function finiteRange(value: unknown, minimum: number, maximum: number): boolean {
  return Number.isFinite(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function invalid(): Error & { code: string } {
  return Object.assign(new Error('canonical semantic snapshot is malformed'), { code: 'snapshot_invalid' });
}
