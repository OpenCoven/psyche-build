import { describe, expect, it, vi } from 'vitest';
import {
  EXEC_BULK_MAX_BYTES,
  EXEC_MAX_BYTES_CODE,
  isExecBufferOverflow,
} from '../src/utils/execBuffers.js';
import { execAsync } from '../src/utils/execAsync.js';
import { capturePaneSync } from '../src/daemon/panes.js';

function overflowError(): Error & { code: string } {
  return Object.assign(new Error('spawnSync /bin/sh ENOBUFS'), { code: 'ENOBUFS' });
}

describe('isExecBufferOverflow', () => {
  it('recognises execSync ENOBUFS', () => {
    expect(isExecBufferOverflow(overflowError())).toBe(true);
  });

  it('recognises the maxBuffer message on platforms without the code', () => {
    expect(isExecBufferOverflow(new Error('maxBuffer length exceeded'))).toBe(true);
  });

  it('recognises the execAsync overflow rejection', () => {
    const error = Object.assign(new Error('Command exceeded 8192 bytes of output: x'), {
      code: EXEC_MAX_BYTES_CODE,
    });
    expect(isExecBufferOverflow(error)).toBe(true);
  });

  it('does not treat an ordinary failure as an overflow', () => {
    expect(isExecBufferOverflow(new Error("can't find pane: %9"))).toBe(false);
    expect(isExecBufferOverflow(undefined)).toBe(false);
    expect(isExecBufferOverflow('ENOBUFS')).toBe(false);
  });
});

describe('execAsync overflow tagging', () => {
  it('tags its overflow rejection so callers can classify it', async () => {
    const command = `node -e "process.stdout.write('x'.repeat(200000))"`;
    await expect(execAsync(command, { maxBytes: 1024 })).rejects.toMatchObject({
      code: EXEC_MAX_BYTES_CODE,
    });
  });

  it('leaves an ordinary command failure untagged', async () => {
    const command = `node -e "process.exit(3)"`;
    await expect(execAsync(command)).rejects.not.toMatchObject({
      code: EXEC_MAX_BYTES_CODE,
    });
  });
});

describe('capturePaneSync', () => {
  it('raises the ceiling above the 1MB default', () => {
    const run = vi.fn((_command: string, _maxBuffer: number) => Buffer.from('screen'));

    capturePaneSync('%1', run);

    expect(run.mock.calls[0][1]).toBe(EXEC_BULK_MAX_BYTES);
    expect(run.mock.calls[0][1]).toBeGreaterThan(1024 * 1024);
  });

  it('falls back to a bounded window instead of returning nothing on overflow', () => {
    const run = vi.fn((command: string, _maxBuffer: number) => {
      // `-S - -t` is the unbounded form; the retry uses `-S -<lines>`.
      if (command.includes('-S - -t')) throw overflowError();
      return Buffer.from('tail of the scrollback');
    });

    const captured = capturePaneSync('%1', run);

    expect(captured.toString()).toBe('tail of the scrollback');
    expect(run).toHaveBeenCalledTimes(2);
    // The retry asks for a bounded number of lines rather than everything.
    expect(run.mock.calls[1][0]).toMatch(/-S -\d+/);
  });

  it('returns empty for a failure that is not an overflow', () => {
    const run = vi.fn((_command: string, _maxBuffer: number): Buffer => {
      throw new Error("can't find pane: %9");
    });

    expect(capturePaneSync('%9', run).length).toBe(0);
    // No pointless retry when the pane simply is not there.
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('returns empty when even the bounded retry fails', () => {
    const run = vi.fn((_command: string, _maxBuffer: number): Buffer => {
      throw overflowError();
    });

    expect(capturePaneSync('%1', run).length).toBe(0);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
