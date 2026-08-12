import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function readPackageJson(): { scripts?: Record<string, string>; engines?: { node?: string } } {
  return JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
}

describe('dev watch tooling', () => {
  it('wires the dev watch package scripts to the watched dist runtime', () => {
    const scripts = readPackageJson().scripts || {};

    expect(scripts).toHaveProperty('dev:watch');
    expect(scripts).toHaveProperty('dev:watch:run');
    expect(scripts['dev:watch']).toContain('pnpm run dev:watch:run');
    expect(scripts['dev:watch:run']).toContain('node scripts/dev-watch-run.js');
    expect(existsSync(path.join(projectRoot, 'scripts', 'dev-watch-run.js'))).toBe(true);
  });

  it('requires a Node version supported by runtime dependencies and Corepack', () => {
    const packageJson = readPackageJson();

    expect(packageJson.engines?.node).toBe('>=20.10.0');
  });

  it('shuts down the dev watch session when either child exits cleanly', () => {
    const runner = readFileSync(path.join(projectRoot, 'scripts', 'dev-watch-run.js'), 'utf-8');

    expect(runner).toContain('shutdown(code || 0)');
    expect(runner).toContain('exited cleanly');
  });

  it('passes the runtime parity guard', () => {
    expect(() => {
      execFileSync(process.execPath, ['scripts/guard-runtime-parity.js'], {
        cwd: projectRoot,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    }).not.toThrow();
  });
});
