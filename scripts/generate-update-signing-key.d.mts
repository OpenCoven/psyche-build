import type { PublicKeyEntry } from './update-manifest.mjs';

export function generateSigningKey(outPath: string): PublicKeyEntry;
export function main(
  argv?: string[],
  options?: { io?: { stdout: (text: string) => void; stderr: (text: string) => void } },
): number;
