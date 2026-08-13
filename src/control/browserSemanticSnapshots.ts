import { createCanonicalElementSemantics, type CanonicalElementSemantics } from './policy.js';
import type { SemanticSnapshot } from './types.js';

const MAX_SNAPSHOTS = 128;
const MAX_NODES = 2_000;

export class BrowserSemanticSnapshotRegistry {
  private readonly snapshots = new Map<string, SemanticSnapshot>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  store(value: unknown, tabId: string, generation: number): SemanticSnapshot {
    const snapshot = requireSnapshot(value, tabId, generation, this.now());
    this.invalidateTab(tabId, generation);
    this.snapshots.delete(snapshot.id);
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
      submit: node.role === 'button' || node.role === 'form',
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const snapshot = value as Partial<SemanticSnapshot>;
  const allowed = ['schema', 'id', 'tabId', 'generation', 'url', 'title', 'loading', 'viewport', 'capturedAt', 'nodes', 'truncated', 'opaqueFrames', 'expiresAt', 'screenshot'];
  if (Object.keys(snapshot).some((key) => !allowed.includes(key)) || snapshot.schema !== 'psyche.browser.snapshot/v1'
    || snapshot.tabId !== tabId || snapshot.generation !== generation || typeof snapshot.id !== 'string'
    || !Array.isArray(snapshot.nodes) || snapshot.nodes.length > MAX_NODES
    || !Number.isFinite(Date.parse(snapshot.expiresAt ?? '')) || Date.parse(snapshot.expiresAt ?? '') <= now.getTime()) throw invalid();
  return Object.freeze({ ...snapshot, nodes: Object.freeze([...snapshot.nodes]) }) as SemanticSnapshot;
}

function invalid(): Error & { code: string } {
  return Object.assign(new Error('canonical semantic snapshot is malformed'), { code: 'snapshot_invalid' });
}
