import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { commitChanges, getGitStatus } from '../src/utils/mergeValidation.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

describe('mergeValidation', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it('ignores psyche metadata directories when checking git status', () => {
    vi.mocked(execFileSync).mockReturnValue(
      '?? .psyche/\nM  .psyche/worktrees/feature-a\n'
    );

    const status = getGitStatus('/repo');

    expect(status).toEqual({
      hasChanges: false,
      files: [],
      summary: '',
    });
  });

  it('ignores untracked hook scaffolding but preserves real hook changes', () => {
    vi.mocked(execFileSync).mockReturnValue(
      [
        '?? .psyche-hooks/',
        '?? .psyche-hooks/AGENTS.md',
        '?? .psyche-hooks/examples/pre_merge.example',
        ' M .psyche-hooks/pre_merge',
        '?? .psyche-hooks/custom_hook',
      ].join('\n')
    );

    const status = getGitStatus('/repo');

    expect(status).toEqual({
      hasChanges: true,
      files: [
        '.psyche-hooks/pre_merge',
        '.psyche-hooks/custom_hook',
      ],
      summary: ' M .psyche-hooks/pre_merge\n?? .psyche-hooks/custom_hook',
    });
  });

  it('keeps non-psyche files in the dirty-state result', () => {
    vi.mocked(execFileSync).mockReturnValue(
      ' M src/index.ts\nM package.json\n'
    );

    const status = getGitStatus('/repo');

    expect(status).toEqual({
      hasChanges: true,
      files: ['src/index.ts', 'package.json'],
      summary: 'M src/index.ts\nM package.json',
    });
  });

  it('passes hostile commit messages as one literal git argument', () => {
    const message = 'fix: $(touch sentinel) `backtick` "quoted"; newline\n--leading-dash';

    expect(commitChanges('/repo', message)).toEqual({ success: true });
    expect(execFileSync).toHaveBeenLastCalledWith(
      'git',
      ['commit', '-m', message],
      { cwd: '/repo', stdio: 'pipe' },
    );
  });
});
