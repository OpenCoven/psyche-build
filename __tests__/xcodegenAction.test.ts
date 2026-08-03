import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const actionPath = path.resolve('.github/actions/setup-xcodegen/action.yml');

function actionSource(): string {
  try {
    return readFileSync(actionPath, 'utf8');
  } catch {
    return '';
  }
}

describe('pinned XcodeGen setup action', () => {
  it('owns the single pinned version and checksum source of truth', () => {
    const action = actionSource();

    expect(action).toContain('using: composite');
    expect(action.match(/XCODEGEN_VERSION="2\.45\.4"/g)).toHaveLength(1);
    expect(action.match(/090ec29491aad50aec10631bf6e62253fed733c50f3aab0f5ffc86bc170bdbef/g))
      .toHaveLength(1);
    expect(action).toContain(
      'https://github.com/yonaskolb/XcodeGen/releases/download/${XCODEGEN_VERSION}/xcodegen.zip',
    );
  });

  it('checks the archive before installing only the verified binary onto PATH', () => {
    const action = actionSource();
    const checksumIndex = action.indexOf('shasum -a 256 -c -');
    const installIndex = action.indexOf('install -m 0755');

    expect(action).toContain('set -euo pipefail');
    expect(checksumIndex).toBeGreaterThan(0);
    expect(installIndex).toBeGreaterThan(checksumIndex);
    expect(action).toContain('find "$RUNNER_TEMP/xcodegen" -type f -name xcodegen -print -quit');
    expect(action).toContain('echo "$RUNNER_TEMP/bin" >> "$GITHUB_PATH"');
    expect(action).not.toContain('sudo');
  });
});
