import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runGitProcess } from '../src/utils/gitProcess.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('runGitProcess', () => {
  it('bounds stderr while preserving its useful tail', async () => {
    const root = mkdtempSync(join(process.cwd(), '.psyche-git-process-'));
    roots.push(root);
    execFileSync('git', ['init', '--quiet'], { cwd: root });

    const result = await runGitProcess([
      '-c',
      `alias.noisy=!node -e "process.stderr.write('x'.repeat(1024) + 'TAIL_MARKER')"`,
      'noisy',
    ], root, { maxStderrBytes: 96 } as never);

    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(96);
    expect(result.stderr).toContain('stderr truncated');
    expect(result.stderr).toContain('TAIL_MARKER');
  });
});
