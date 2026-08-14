import { realpath } from 'node:fs/promises';
import path from 'node:path';

/** Match Node realpath identity across native callers without changing path casing. */
export function normalizeCanonicalProjectIdentity(
  canonical: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'darwin') return canonical.normalize('NFC');
  if (platform === 'win32') {
    if (canonical.startsWith('\\\\?\\UNC\\')) return `\\\\${canonical.slice(8)}`;
    if (canonical.startsWith('\\\\?\\')) return canonical.slice(4);
  }
  return canonical;
}

export async function canonicalizeProjectRoot(projectRoot: string): Promise<string> {
  const canonical = await realpath(path.resolve(projectRoot));
  return normalizeCanonicalProjectIdentity(canonical);
}
