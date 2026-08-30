export interface DiagnosticsLauncherChild {
  on(
    event: 'error',
    listener: (error: Error) => void,
  ): this;
  on(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

export interface DiagnosticsLauncherProcess {
  env: NodeJS.ProcessEnv;
  platform: string;
  pid: number;
  exitCode?: number;
  stderr?: {
    write(chunk: string): unknown;
  };
  kill(pid: number, signal: NodeJS.Signals): unknown;
}

export interface DiagnosticsSpawnOptions {
  env: NodeJS.ProcessEnv;
  shell: boolean;
  stdio: 'inherit';
}

export interface DiagnosticsLaunchOptions {
  spawnImpl?: (
    command: string,
    args: string[],
    options: DiagnosticsSpawnOptions,
  ) => DiagnosticsLauncherChild;
  processApi?: DiagnosticsLauncherProcess;
  platform?: string;
  env?: NodeJS.ProcessEnv;
}

export function launchDiagnostics(
  options?: DiagnosticsLaunchOptions,
): DiagnosticsLauncherChild;
