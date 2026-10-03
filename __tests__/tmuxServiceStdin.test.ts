/**
 * #523 review, finding 2: `load-buffer -` writes the prompt to tmux's stdin.
 * When tmux exits before reading it all, the write fails with EPIPE. Without
 * an 'error' listener on stdin that is an uncaught exception that takes the
 * process down; it must instead reject with a bounded message.
 *
 * `tmux` here is a shim on PATH that exits at once without reading stdin. No
 * real tmux runs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TmuxService } from '../src/services/TmuxService.js';

describe('TmuxService.loadBufferFromStdin when tmux exits early', () => {
  let shimDir: string;
  let savedPath: string | undefined;

  beforeAll(() => {
    shimDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'psyche-tmux-epipe-')));
    fs.writeFileSync(path.join(shimDir, 'tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    savedPath = process.env.PATH;
    process.env.PATH = `${shimDir}:/usr/bin:/bin`;
  });

  afterAll(() => {
    process.env.PATH = savedPath;
    fs.rmSync(shimDir, { recursive: true, force: true });
  });

  it('rejects with a bounded message and raises no uncaught exception', async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => {
      uncaught.push(error);
    };
    process.on('uncaughtException', onUncaught);
    try {
      // Far larger than a pipe buffer, so the write is still in progress
      // when the shim exits.
      const prompt = `zq-secret-${'x'.repeat(4 * 1024 * 1024)}`;
      const error = await TmuxService.getInstance()
        .loadBufferFromStdin('psyche-prompt-epipe', prompt)
        .then(() => null, (e: unknown) => e);

      // Give a late stream error the chance to surface.
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('tmux load-buffer failed');
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });
});
