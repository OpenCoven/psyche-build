import { realpath } from 'node:fs/promises';
import path from 'node:path';

export async function canonicalizeProjectRoot(projectRoot: string): Promise<string> {
  const canonical = await realpath(path.resolve(projectRoot));
  return process.platform === 'darwin'
    ? canonical.normalize('NFC')
    : canonical;
}
