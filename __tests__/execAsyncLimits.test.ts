import { describe, it, expect } from 'vitest';
import { execAsync, DEFAULT_MAX_BYTES } from '../src/utils/execAsync.js';

/** Emits `count` bytes on stdout without depending on a POSIX shell. */
function emitBytes(count: number): string {
  return `node -e "process.stdout.write('x'.repeat(${count}))"`;
}

describe('execAsync output bounds', () => {
  it('returns output that fits under the cap', async () => {
    const output = await execAsync(emitBytes(1024), { maxBytes: 64 * 1024 });
    expect(output).toHaveLength(1024);
  });

  it('rejects rather than truncating when output exceeds the cap', async () => {
    await expect(
      execAsync(emitBytes(256 * 1024), { maxBytes: 8 * 1024 }),
    ).rejects.toThrow(/exceeded 8192 bytes/);
  });

  it('resolves empty on overflow when silent', async () => {
    const output = await execAsync(emitBytes(256 * 1024), {
      maxBytes: 8 * 1024,
      silent: true,
    });
    expect(output).toBe('');
  });

  it('defaults to a bounded cap rather than unlimited buffering', () => {
    expect(DEFAULT_MAX_BYTES).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_MAX_BYTES)).toBe(true);
  });

  it('preserves multi-byte characters split across stdout chunks', async () => {
    // A long run of 3-byte characters is large enough for Node to deliver it in
    // more than one chunk, so a per-chunk toString() would corrupt the seams.
    const command = `node -e "process.stdout.write('あ'.repeat(200000))"`;
    const output = await execAsync(command, { maxBytes: 4 * 1024 * 1024 });
    expect(output).toHaveLength(200000);
    expect(output).not.toContain('�');
  });
});
