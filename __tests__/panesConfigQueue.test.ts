import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({
  open: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  default: fsMock,
  ...fsMock,
}));

describe('withPanesConfigFileWriteLock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('removes an abandoned lock before running the queued config writer', async () => {
    fsMock.open
      .mockRejectedValueOnce(Object.assign(new Error('exists'), { code: 'EEXIST' }))
      .mockResolvedValueOnce({ close: vi.fn(async () => {}), writeFile: vi.fn(async () => {}) })
      .mockResolvedValueOnce({ close: vi.fn(async () => {}), writeFile: vi.fn(async () => {}) });
    fsMock.stat
      .mockResolvedValueOnce({ mtimeMs: 0 })
      .mockResolvedValueOnce({ mtimeMs: 0 });
    fsMock.unlink.mockResolvedValue(undefined);

    const { withPanesConfigFileWriteLock } = await import('../src/utils/panesConfigQueue.js');
    const result = await withPanesConfigFileWriteLock(
      '/project/.psyche/psyche.config.json',
      async () => 'saved'
    );

    expect(result).toBe('saved');
    expect(fsMock.stat).toHaveBeenCalledWith('/project/.psyche/psyche.config.json.lock');
    expect(fsMock.unlink).toHaveBeenCalledWith('/project/.psyche/psyche.config.json.lock');
    expect(fsMock.open).toHaveBeenCalledTimes(3);
  });
});
