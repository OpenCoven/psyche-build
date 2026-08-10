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

export interface BuildProvenance {
  channel: BuildChannel;
  commitSha: string;
  requestedRef?: string;
  dirty: boolean;
  builtAt: string;
  installedPath: string;
  productName: string;
  bundleIdentifier: string;
}

export interface BundleIdentity {
  name: string;
  identifier: string;
  executable?: string | null;
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

export interface InstallOverrides {
  homeDir?: string;
  copyBundle?: (source: string, destination: string) => void | Promise<void>;
  validateInstalledBundle?: (
    appPath: string,
    expectedChannelConfig: BuildChannelConfig,
  ) => void | Promise<void>;
  mkdirPath?: (directoryPath: string) => void | Promise<void>;
  renamePath?: (sourcePath: string, destinationPath: string) => void | Promise<void>;
  removePath?: (targetPath: string) => void | Promise<void>;
  randomUUID?: () => string;
}

export interface WriteBuildProvenanceOverrides {
  homeDir?: string;
  mkdirPath?: (directoryPath: string) => void | Promise<void>;
  readFileText?: (filePath: string) => string | Promise<string>;
  writeFileText?: (filePath: string, content: string) => void | Promise<void>;
  renamePath?: (sourcePath: string, destinationPath: string) => void | Promise<void>;
  removePath?: (targetPath: string) => void | Promise<void>;
  randomUUID?: () => string;
}

export interface SmokeLaunchOverrides {
  executableName: string;
  args?: readonly string[];
  smokeMs?: number;
  termTimeoutMs?: number;
  postKillTimeoutMs?: number;
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
export function installBundleTransactional(
  candidate: string,
  requestedChannelConfig: BuildChannelConfig,
  overrides?: InstallOverrides,
): Promise<string>;
export function writeBuildProvenance(
  record: BuildProvenance,
  overrides?: WriteBuildProvenanceOverrides,
): Promise<string>;
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
