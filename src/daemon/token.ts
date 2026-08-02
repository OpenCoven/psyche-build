import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const TOKEN_DIR = path.join(homedir(), '.config', 'psyche');
const TOKEN_FILE = path.join(TOKEN_DIR, 'token');

export async function readOrCreateToken(): Promise<string> {
  try {
    const existing = (await readFile(TOKEN_FILE, 'utf8')).trim();
    if (existing.length >= 32) return existing;
  } catch {
    // fall through to create
  }
  const token = randomBytes(32).toString('hex');
  await mkdir(TOKEN_DIR, { recursive: true, mode: 0o700 });
  await writeFile(TOKEN_FILE, token + '\n', { mode: 0o600 });
  await chmod(TOKEN_FILE, 0o600);
  return token;
}

export function tokenFilePath(): string {
  return TOKEN_FILE;
}
