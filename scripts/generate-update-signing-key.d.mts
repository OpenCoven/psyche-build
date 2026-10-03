import type { PublicKeyEntry } from './update-manifest.mjs';

export function generateSigningKey(
  outPath: string,
  options?: {
    env?: Record<string, string | undefined>;
    fileOps?: Partial<{
      openSync: typeof import('node:fs').openSync;
      fchmodSync: typeof import('node:fs').fchmodSync;
      writeSync: (fd: number, buffer: Uint8Array, offset: number, length: number) => number;
      fstatSync: (fd: number) => { mode: number; size: number };
      closeSync: typeof import('node:fs').closeSync;
      unlinkSync: typeof import('node:fs').unlinkSync;
    }>;
  },
): PublicKeyEntry;
export function main(
  argv?: string[],
  options?: { io?: { stdout: (text: string) => void; stderr: (text: string) => void } },
): number;
