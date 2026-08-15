import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
  exports?: Record<string, unknown>;
  files?: string[];
  scripts?: Record<string, string>;
};

describe('control task token package surface', () => {
  it('pins the real prepack and pack-smoke contract for the published subpath', () => {
    expect(packageJson.files).toContain('dist/**/*');
    expect(packageJson.scripts?.prepack).toBe('pnpm run build');
    expect(packageJson.scripts?.prepublishOnly).toBeUndefined();
    expect(packageJson.scripts?.['smoke:pack']).toBe('node scripts/smoke-pack-install.js');
    expect(packageJson.exports?.['./control-task-tokens']).toEqual({
      import: './dist/control-task-tokens.js',
      types: './dist/control-task-tokens.d.ts',
    });
  });

  it('documents the supported specifier and trust boundary for launchers', () => {
    for (const docPath of [
      path.join(repoRoot, 'README.md'),
      path.join(repoRoot, 'docs', 'AGENT-SURFACE-CONTROL.md'),
    ]) {
      const text = readFileSync(docPath, 'utf8');
      expect(text).toContain('psyche-build/control-task-tokens');
      expect(text).toMatch(/issueControlTaskCredential/i);
      expect(text).toMatch(/revokeControlTaskCredential/i);
      expect(text).toMatch(/one active subject per task|one-active-token-per-task/i);
      expect(text).toMatch(/operator\/agent root secret material/i);
      expect(text).toMatch(/untrusted agents/i);
      expect(text).toMatch(/malicious repository contents|sibling project paths/i);
      expect(text).toMatch(/same-user code execution|process memory/i);
    }

    expect(readFileSync(path.join(repoRoot, 'README.md'), 'utf8')).not.toContain(
      'credential-store helpers in `src/control/credentials.ts`',
    );
  });
});
