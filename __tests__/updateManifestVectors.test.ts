import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { VECTORS_PATH, buildVectors, testKeyIds } from '../scripts/generate-update-manifest-vectors.mjs';
import { parseKeysFile } from '../scripts/update-manifest.mjs';

// The Rust verifier (src-tauri/src/update_manifest.rs) is tested against these
// vectors; this test keeps the checked-in copy identical to what the Node
// reference produces today.
describe('update manifest cross-implementation vectors', () => {
  it('are byte-identical to a fresh generation', () => {
    expect(readFileSync(VECTORS_PATH, 'utf8')).toBe(buildVectors());
  });

  it('never use a release key, and the release keys never trust a test key', () => {
    const trusted = parseKeysFile(readFileSync(path.join(process.cwd(), 'release/update-manifest-keys.json'), 'utf8'));
    const ids = new Set(testKeyIds());
    expect(ids.size).toBe(3);
    for (const slot of [trusted.current, trusted.next]) {
      if (slot) expect(ids.has(slot.keyId)).toBe(false);
    }
  });

  it('cover acceptance, next-key acceptance, and every verifier reason the app can meet', () => {
    const vectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as {
      cases: { name: string; expect: { outcome: string; slot?: string } }[];
    };
    const outcomes = new Set(vectors.cases.map((entry) => entry.expect.outcome));
    for (const outcome of [
      'ok',
      'signature_malformed',
      'unknown_key_id',
      'signature_invalid',
      'manifest_malformed',
      'manifest_not_canonical',
      'manifest_not_yet_valid',
      'manifest_expired',
    ]) {
      expect(outcomes.has(outcome)).toBe(true);
    }
    expect(vectors.cases.some((entry) => entry.expect.slot === 'next')).toBe(true);
    // Intentional Rust differences are explicit and few (see update_manifest.rs).
    const divergent = (vectors.cases as { name: string; rust_expect?: unknown }[])
      .filter((entry) => entry.rust_expect !== undefined)
      .map((entry) => entry.name);
    expect(divergent).toEqual(['deep_non_canonical_document']);
  });
});
