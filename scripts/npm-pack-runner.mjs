const npmPackDryRunArgs = ['pack', '--dry-run', '--json', '--ignore-scripts'];

export async function executeNpmPackDryRun(
  execFileAsync,
  {
    cwd,
    platform = process.platform,
  },
) {
  const executable = platform === 'win32' ? 'npm.cmd' : 'npm';
  const { stdout } = await execFileAsync(
    executable,
    [...npmPackDryRunArgs],
    {
      cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  return stdout;
}
