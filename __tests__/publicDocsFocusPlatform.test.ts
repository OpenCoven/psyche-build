import { describe, expect, it } from 'vitest';

type ExecFileResult = {
  stdout: string;
};

type ExecuteNpmPackDryRun = (
  execFileAsync: (
    executable: string,
    args: string[],
    options: Record<string, unknown>,
  ) => Promise<ExecFileResult>,
  options: {
    cwd: string;
    platform: NodeJS.Platform;
  },
) => Promise<string>;

async function loadNpmPackRunner(): Promise<{
  executeNpmPackDryRun?: ExecuteNpmPackDryRun;
}> {
  try {
    // @ts-expect-error The public-docs runner is a plain JavaScript module.
    return await import('../scripts/npm-pack-runner.mjs');
  } catch {
    return {};
  }
}

describe('public docs npm pack runner', () => {
  it('uses npm.cmd on Windows without a shell and preserves the non-recursive dry-run arguments', async () => {
    const runner = await loadNpmPackRunner();
    const calls: Array<{
      executable: string;
      args: string[];
      options: Record<string, unknown>;
    }> = [];

    expect(runner.executeNpmPackDryRun).toBeTypeOf('function');
    const stdout = await runner.executeNpmPackDryRun?.(
      async (executable, args, options) => {
        calls.push({ executable, args, options });
        return { stdout: '[]' };
      },
      {
        cwd: 'C:\\psyche-build',
        platform: 'win32',
      },
    );

    expect(stdout).toBe('[]');
    expect(calls).toEqual([
      {
        executable: 'npm.cmd',
        args: ['pack', '--dry-run', '--json', '--ignore-scripts'],
        options: {
          cwd: 'C:\\psyche-build',
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
        },
      },
    ]);
    expect(calls[0]?.options).not.toHaveProperty('shell');
  });

  it('uses npm directly on Unix platforms', async () => {
    const runner = await loadNpmPackRunner();
    const executables: string[] = [];

    expect(runner.executeNpmPackDryRun).toBeTypeOf('function');
    await runner.executeNpmPackDryRun?.(
      async (executable) => {
        executables.push(executable);
        return { stdout: '[]' };
      },
      {
        cwd: '/repo',
        platform: 'linux',
      },
    );

    expect(executables).toEqual(['npm']);
  });
});
