import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

const classifier = resolve('scripts/classify-ci-changes.sh');
const workspaces: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function createRepository(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'psyche-ci-classifier-'));
  workspaces.push(cwd);
  git(cwd, 'init', '--quiet');
  git(cwd, 'config', 'user.name', 'CI Test');
  git(cwd, 'config', 'user.email', 'ci@example.test');
  writeFileSync(join(cwd, 'README.md'), 'baseline\n');
  git(cwd, 'add', 'README.md');
  git(cwd, 'commit', '--quiet', '-m', 'baseline');
  return cwd;
}

function commitAll(cwd: string, message: string): string {
  git(cwd, 'add', '--all');
  git(cwd, 'commit', '--quiet', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

function classify(
  cwd: string,
  baseSha: string,
  headSha: string,
  eventName: 'pull_request' | 'push',
): Record<string, string> {
  const output = join(cwd, 'github-output.txt');
  execFileSync('bash', [classifier], {
    cwd,
    env: {
      ...process.env,
      BASE_SHA: baseSha,
      HEAD_SHA: headSha,
      GITHUB_EVENT_NAME: eventName,
      GITHUB_OUTPUT: output,
    },
  });
  return Object.fromEntries(
    readFileSync(output, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split('=')),
  );
}

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

describe('CI change classifier', () => {
  it('classifies both sides of a native-file rename', () => {
    const cwd = createRepository();
    mkdirSync(join(cwd, 'native/ios'), { recursive: true });
    writeFileSync(join(cwd, 'native/ios/Feature.swift'), 'struct Feature {}\n');
    const base = commitAll(cwd, 'add iOS source');
    mkdirSync(join(cwd, 'docs'), { recursive: true });
    renameSync(
      join(cwd, 'native/ios/Feature.swift'),
      join(cwd, 'docs/Feature.swift'),
    );
    const head = commitAll(cwd, 'move iOS source');

    expect(classify(cwd, base, head, 'pull_request')).toMatchObject({
      ios: 'true',
      typescript: 'true',
    });
  });

  it('fails open for an initial multi-commit push', () => {
    const cwd = createRepository();
    mkdirSync(join(cwd, 'native/ios'), { recursive: true });
    writeFileSync(join(cwd, 'native/ios/Feature.swift'), 'struct Feature {}\n');
    commitAll(cwd, 'add iOS source');
    mkdirSync(join(cwd, 'docs'), { recursive: true });
    writeFileSync(join(cwd, 'docs/update.md'), 'docs\n');
    const head = commitAll(cwd, 'add docs');

    expect(classify(cwd, '0'.repeat(40), head, 'push')).toEqual({
      desktop: 'true',
      ios: 'true',
      typescript: 'true',
    });
  });

  it('runs iOS and TypeScript validation for shared protocol fixtures', () => {
    const cwd = createRepository();
    const base = git(cwd, 'rev-parse', 'HEAD');
    mkdirSync(join(cwd, 'protocol-fixtures'), { recursive: true });
    writeFileSync(join(cwd, 'protocol-fixtures/mobile-control.json'), '{}\n');
    const head = commitAll(cwd, 'change protocol fixture');

    expect(classify(cwd, base, head, 'pull_request')).toMatchObject({
      ios: 'true',
      typescript: 'true',
    });
  });

  it('runs desktop and TypeScript validation for Tauri tests', () => {
    const cwd = createRepository();
    const base = git(cwd, 'rev-parse', 'HEAD');
    mkdirSync(join(cwd, '__tests__'), { recursive: true });
    writeFileSync(join(cwd, '__tests__/tauriExample.test.ts'), 'export {};\n');
    const head = commitAll(cwd, 'change Tauri test');

    expect(classify(cwd, base, head, 'pull_request')).toMatchObject({
      desktop: 'true',
      typescript: 'true',
    });
  });
});
