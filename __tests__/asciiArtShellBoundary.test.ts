import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ script: '' }));
const service = vi.hoisted(() => ({
  sendKeys: vi.fn(async (..._args: unknown[]) => undefined),
  getPaneCurrentCommand: vi.fn(async () => 'sh'),
}));
vi.mock('../src/services/TmuxService.js', () => ({ TmuxService: { getInstance: () => service } }));
vi.mock('../src/utils/runtimePaths.js', () => ({ resolveDistPath: () => fixture.script }));

beforeEach(() => { vi.clearAllMocks(); });

it.each(['/bin/sh', '/bin/bash', '/bin/zsh'])('launches the intended decorative script through %s with a literal installation path', async (shell) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'art-shell-')));
  const directory = path.join(root, "package-$(touch SIDE_EFFECT)-'quoted\\literal");
  fs.mkdirSync(directory);
  fixture.script = path.join(directory, 'decorative.js');
  fs.writeFileSync(fixture.script, "process.stdout.write('INTENDED_SCRIPT');\n");
  service.getPaneCurrentCommand.mockResolvedValue(path.basename(shell));
  try {
    const { renderAsciiArt } = await import('../src/utils/asciiArt.js');
    await renderAsciiArt({ paneId: '%9', art: [] });
    const keys = service.sendKeys.mock.calls.find(([, value]) => Array.isArray(value) && value.includes('Enter'))?.[1] as string[];
    expect(keys).toBeDefined();
    const output = execFileSync(shell, ['-c', keys[0]], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(fs.existsSync(path.join(root, 'SIDE_EFFECT'))).toBe(false);
    expect(output).toBe('INTENDED_SCRIPT');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('refuses to type a decorative launch into an unsupported pane shell', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'art-unsupported-'));
  fixture.script = path.join(root, 'decorative.js');
  fs.writeFileSync(fixture.script, '');
  service.getPaneCurrentCommand.mockResolvedValue('nu');
  try {
    const { renderAsciiArt } = await import('../src/utils/asciiArt.js');
    await expect(renderAsciiArt({ paneId: '%9', art: [] }))
      .rejects.toThrow('supported pane shell unavailable');
    expect(service.sendKeys.mock.calls.some(([, keys]) => Array.isArray(keys) && keys.includes('Enter'))).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
