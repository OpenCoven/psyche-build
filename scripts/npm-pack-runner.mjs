const npmPackDryRunArgs = ['pack', '--dry-run', '--json', '--ignore-scripts'];

export async function executeNpmPackDryRun(
  execFileAsync,
  {
    comSpec = process.env.ComSpec,
    cwd,
    platform = process.platform,
  },
) {
  const isWindows = platform === 'win32';
  const executable = isWindows ? (comSpec || 'cmd.exe') : 'npm';
  const args = isWindows
    ? ['/d', '/s', '/c', 'npm.cmd', ...npmPackDryRunArgs]
    : [...npmPackDryRunArgs];
  const { stdout } = await execFileAsync(
    executable,
    args,
    {
      cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  return stdout;
}
