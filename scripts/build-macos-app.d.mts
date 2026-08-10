import type { ChildProcess, SpawnOptions } from 'node:child_process';

export type BuildChannel = 'stable' | 'dev';

export interface StableBuildOptions {
  channel: 'stable';
  ref: string;
}

export interface DevBuildOptions {
  channel: 'dev';
}

export type ParsedBuildArguments = StableBuildOptions | DevBuildOptions;

export interface BuildChannelConfig {
  productName: string;
  bundleIdentifier: string;
  appName: string;
}

export interface BundleIdentity {
  name: string;
  identifier: string;
  executableName?: string | null;
}

export interface TauriWindowConfig {
  label?: string;
  title?: string;
  [key: string]: unknown;
}

export interface TauriConfig {
  productName: string;
  identifier: string;
  app: {
    windows: TauriWindowConfig[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type BuildCommand = [command: string, args: string[], cwd: string];

export interface SmokeLaunchOverrides {
  executableName: string;
  args?: readonly string[];
  smokeMs?: number;
  termTimeoutMs?: number;
  spawnProcess?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions & {
      env: NodeJS.ProcessEnv;
      stdio: ['ignore', 'pipe', 'pipe'];
    },
  ) => ChildProcess;
  sleep?: (ms: number) => Promise<void>;
  makeTemporaryHome?: () => string | Promise<string>;
  removeTemporaryHome?: (homePath: string) => void | Promise<void>;
}

export function parseBuildArguments(argv: readonly string[]): ParsedBuildArguments;
export function channelConfig(channel: BuildChannel): BuildChannelConfig;
export function createDevTauriConfig(production: TauriConfig): TauriConfig;
export function findCandidateApp(bundleDir: string, expectedAppName: string): Promise<string>;
export function assertBundleIdentity(
  appPath: string,
  identity: BundleIdentity,
  expectedChannelConfig: BuildChannelConfig,
): void;
export function smokeLaunchBundle(
  appPath: string,
  overrides: SmokeLaunchOverrides,
): Promise<void>;
export function buildCommandsFor(
  channel: 'stable',
  options?: { devConfigPath?: string },
): BuildCommand[];
export function buildCommandsFor(
  channel: 'dev',
  options: { devConfigPath: string },
): BuildCommand[];
