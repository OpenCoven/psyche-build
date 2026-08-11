/**
 * Emits the JSON the Swift suite reads from the typed fixture source.
 *
 * The TypeScript side compile-checks protocol-fixtures/fixtures.ts; Swift can
 * only read JSON. This keeps the two in step, and the contract test fails if
 * the checked-in JSON drifts from the source.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLIENT_FIXTURES,
  MOBILE_CONTROL_FIXTURES,
  SERVER_FIXTURES,
  WORKSPACE_SNAPSHOT_FIXTURE,
} from '../protocol-fixtures/fixtures.js';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../protocol-fixtures');

/** Stable output: keys sorted at every level so the diff is meaningful. */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortDeep((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function serialize(fixtures: unknown): string {
  return `${JSON.stringify(sortDeep(fixtures), null, 2)}\n`;
}

export const OUTPUTS = [
  ['client-messages.json', CLIENT_FIXTURES],
  ['mobile-control.json', MOBILE_CONTROL_FIXTURES],
  ['server-messages.json', SERVER_FIXTURES],
  ['workspace-snapshot.json', WORKSPACE_SNAPSHOT_FIXTURE],
] as const;

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [file, fixtures] of OUTPUTS) {
    fs.writeFileSync(path.join(DIR, file), serialize(fixtures));
    console.log(`wrote protocol-fixtures/${file}`);
  }
}
