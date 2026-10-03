import type { PublicKeyEntry } from './update-manifest.mjs';

export function generateSigningKey(
  outPath: string,
  options?: { env?: Record<string, string | undefined> },
): PublicKeyEntry;
export function main(
  argv?: string[],
  options?: { io?: { stdout: (text: string) => void; stderr: (text: string) => void } },
): number;
