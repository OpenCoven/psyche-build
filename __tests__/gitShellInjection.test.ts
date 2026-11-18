import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initializeHooksDirectory } from '../src/utils/hooks.js';
import {
  completeMerge,
  mergeMainIntoWorktree,
  mergeWorktreeIntoMain,
} from '../src/utils/mergeExecution.js';

/**
 * These tests run real Git against a throwaway repository. Each one hands the
 * code under test a value that is legal where it comes from (a Git ref name, a
 * commit message, a directory name) but that a shell would execute. The
 * payload touches a marker file, so the marker existing means a shell
 * evaluated attacker-controlled text.
 */

const MARKER_ENV = 'PSYCHE_SHELL_INJECTION_MARKER';
// `$(…)` is expanded inside double quotes, and `${IFS}` stands in for the
// space a ref name cannot contain.
const SUBSTITUTION = `$(touch\${IFS}$${MARKER_ENV})`;

let sandbox: string;
let repo: string;
let marker: string;
let previousMarker: string | undefined;

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function commitFile(name: string, content: string, message: string): void {
  fs.writeFileSync(path.join(repo, name), content);
  git(['add', '--', name]);
  git(['commit', '-m', message]);
}

beforeEach(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'psyche-shell-injection-')));
  repo = path.join(sandbox, 'repo');
  marker = path.join(sandbox, 'INJECTED');
  previousMarker = process.env[MARKER_ENV];
  process.env[MARKER_ENV] = marker;

  fs.mkdirSync(repo);
  git(['init', '--initial-branch=main']);
  git(['config', 'user.name', 'Psyche Test']);
  git(['config', 'user.email', 'psyche-test@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  commitFile('base.txt', 'base\n', 'base');
});

afterEach(() => {
  if (previousMarker === undefined) {
    delete process.env[MARKER_ENV];
  } else {
    process.env[MARKER_ENV] = previousMarker;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('merge execution never evaluates Git data in a shell', () => {
  it('merges a branch whose legal ref name contains a command substitution', () => {
    const hostileBranch = `topic-${SUBSTITUTION}`;
    git(['check-ref-format', '--branch', hostileBranch]);
    git(['checkout', '-b', hostileBranch]);
    commitFile('topic.txt', 'topic\n', 'topic work');
    git(['checkout', 'main']);

    const result = mergeWorktreeIntoMain(repo, hostileBranch);

    expect(fs.existsSync(marker)).toBe(false);
    expect(result).toEqual({ success: true });
    expect(fs.existsSync(path.join(repo, 'topic.txt'))).toBe(true);
  });

  it('merges a main branch whose legal ref name contains a command substitution', () => {
    const hostileMain = `trunk-${SUBSTITUTION}`;
    git(['checkout', '-b', hostileMain]);
    commitFile('trunk.txt', 'trunk\n', 'trunk work');
    git(['checkout', '-b', 'feature', 'main']);

    const result = mergeMainIntoWorktree(repo, hostileMain);

    expect(fs.existsSync(marker)).toBe(false);
    expect(result).toEqual({ success: true });
    expect(fs.existsSync(path.join(repo, 'trunk.txt'))).toBe(true);
  });

  it('does not read a branch name that starts with a dash as a Git option', () => {
    git(['checkout', '-b', 'feature']);
    commitFile('feature.txt', 'feature\n', 'feature work');
    git(['checkout', 'main']);

    // Git must look `--no-commit` up as a revision and fail to find it. Read
    // as an option, it would change how the merge runs instead.
    const result = mergeWorktreeIntoMain(repo, '--no-commit');

    expect(result.success).toBe(false);
    expect(result.error).toContain('not something we can merge');
    expect(git(['status', '--porcelain'])).toBe('');
  });

  it('records a hostile merge-completion message verbatim', () => {
    const hostileMessage = `resolve "$(touch $${MARKER_ENV})" \`touch $${MARKER_ENV}\` \\`;
    fs.writeFileSync(path.join(repo, 'resolved.txt'), 'resolved\n');
    git(['add', '--', 'resolved.txt']);

    const result = completeMerge(repo, hostileMessage);

    expect(fs.existsSync(marker)).toBe(false);
    expect(result).toEqual({ success: true });
    expect(git(['log', '-1', '--format=%B'])).toBe(hostileMessage);
  });
});

describe('hooks directory initialization never evaluates a path in a shell', () => {
  it('marks the examples executable under a project path that contains a command substitution', () => {
    const hostileRoot = path.join(sandbox, `project-$(touch $${MARKER_ENV})`);
    fs.mkdirSync(hostileRoot);

    initializeHooksDirectory(hostileRoot);

    expect(fs.existsSync(marker)).toBe(false);
    const examplesDir = path.join(hostileRoot, '.psyche-hooks', 'examples');
    const examples = fs.readdirSync(examplesDir);
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      const mode = fs.statSync(path.join(examplesDir, example)).mode;
      expect(mode & 0o111, `${example} is executable`).not.toBe(0);
    }
  });
});
