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

export interface BuildProvenanceBase {
  commitSha: string;
  dirty: boolean;
  builtAt: string;
  installedPath: string;
  productName: string;
  bundleIdentifier: string;
}

export interface StableBuildProvenance extends BuildProvenanceBase {
  channel: 'stable';
  requestedRef: string;
}

export interface DevBuildProvenance extends BuildProvenanceBase {
  channel: 'dev';
  requestedRef?: never;
}

export type BuildProvenance = StableBuildProvenance | DevBuildProvenance;

export interface BundleIdentity {
  name: string;
  identifier: string;
  executable: string;
}

export interface DevBuildSnapshotRequest {
  sourceRoot: string;
  tempRoot: string;
  devConfigPath: string;
}

export interface DevBuildSnapshotInput extends DevBuildSnapshotRequest {
  snapshotPath: string;
}

export interface DevBuildSnapshot {
  snapshotPath: string;
  identity: BundleIdentity;
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

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stage?: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface RunCommandError extends Error {
  command: string;
  args: string[];
  cwd: string;
  stage: string;
  exitCode?: number;
  code?: string;
  signal?: NodeJS.Signals;
  stdout: string;
  stderr: string;
}

export type Runner = (
  command: string,
  args: readonly string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

export interface InstallOverrides {
  homeDir?: string;
  copyBundle?: (source: string, destination: string) => void | Promise<void>;
  validateInstalledBundle: (
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
  writeFileText?: (
    filePath: string,
    content: string,
    options?: { exclusive?: boolean },
  ) => void | Promise<void>;
  removePath?: (targetPath: string) => void | Promise<void>;
  randomUUID?: () => string;
  execute?: Runner;
  lockTimeoutSeconds?: number;
}

export interface PublishBuildChannelOverrides {
  homeDir?: string;
  mkdirPath?: (directoryPath: string) => void | Promise<void>;
  writeFileText?: (
    filePath: string,
    content: string,
    options?: { exclusive?: boolean },
  ) => void | Promise<void>;
  removePath?: (targetPath: string) => void | Promise<void>;
  randomUUID?: () => string;
  execute?: Runner;
  lockTimeoutSeconds?: number;
}

export interface BuildDevAppSnapshotOverrides {
  execute?: Runner;
  mkdirPath?: (directoryPath: string) => void | Promise<void>;
  writeFileText?: (
    filePath: string,
    content: string,
    options?: { exclusive?: boolean },
  ) => void | Promise<void>;
  removePath?: (targetPath: string) => void | Promise<void>;
  randomUUID?: () => string;
  lockTimeoutSeconds?: number;
}

export interface RunDevBuildSnapshotUnlockedOverrides {
  execute?: Runner;
  removePath?: (targetPath: string) => void | Promise<void>;
  mkdirPath?: (directoryPath: string) => void | Promise<void>;
  findCandidateApp?: (bundleDir: string, expectedAppName: string) => Promise<string>;
  readBundleIdentity?: (appPath: string, execute?: Runner) => Promise<BundleIdentity>;
}

export interface WriteBuildProvenanceUnlockedOverrides {
  readFileText?: (filePath: string) => string | Promise<string>;
  writeFileText?: (
    filePath: string,
    content: string,
    options?: { exclusive?: boolean },
  ) => void | Promise<void>;
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

export interface StableRunMacosBuildOptions {
  channel: 'stable';
  ref: string;
  repositoryRoot?: string;
}

export interface DevRunMacosBuildOptions {
  channel: 'dev';
  ref?: never;
  repositoryRoot?: string;
}

export type RunMacosBuildOptions = StableRunMacosBuildOptions | DevRunMacosBuildOptions;

export interface RunMacosBuildDependencies {
  execute?: Runner;
  makeTemporaryDirectory?: (prefix: string) => string | Promise<string>;
  removePath?: (targetPath: string) => void | Promise<void>;
  writeDevTauriConfig?: (sourceRoot: string, tempRoot: string) => Promise<string>;
  buildDevAppSnapshot?: (
    input: DevBuildSnapshotRequest,
    overrides?: Pick<BuildDevAppSnapshotOverrides, 'execute'>,
  ) => Promise<DevBuildSnapshot>;
  findCandidateApp?: (bundleDir: string, expectedAppName: string) => Promise<string>;
  readBundleIdentity?: (appPath: string, execute?: Runner) => Promise<BundleIdentity>;
  smokeLaunchBundle?: (
    appPath: string,
    overrides: SmokeLaunchOverrides,
  ) => Promise<void>;
  publishBuildChannel?: (
    candidate: string,
    requestedChannelConfig: BuildChannelConfig,
    record: BuildProvenance,
    overrides?: PublishBuildChannelOverrides,
  ) => Promise<string>;
  now?: () => Date;
  homeDir?: string;
}

export interface StableRunMacosBuildResult extends StableBuildProvenance {}

export interface DevRunMacosBuildResult extends DevBuildProvenance {}

export type RunMacosBuildResult =
  | StableRunMacosBuildResult
  | DevRunMacosBuildResult;

export interface RunCliDependencies {
  runBuild?: (
    options: RunMacosBuildOptions,
    deps?: RunMacosBuildDependencies,
  ) => Promise<RunMacosBuildResult>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export function parseBuildArguments(argv: readonly string[]): ParsedBuildArguments;
export function channelConfig(channel: BuildChannel): BuildChannelConfig;
export function createDevTauriConfig(production: TauriConfig): TauriConfig;
export function runCommand(
  command: string,
  args: readonly string[],
  options?: CommandOptions,
): Promise<CommandResult>;
export function resolveCommit(
  root: string,
  ref: string,
  execute?: Runner,
): Promise<string>;
export function sourceIsDirty(root: string, execute?: Runner): Promise<boolean>;
export function readBundleIdentity(
  appPath: string,
  execute?: Runner,
): Promise<BundleIdentity>;
export function writeDevTauriConfig(
  sourceRoot: string,
  tempRoot: string,
): Promise<string>;
export function buildDevAppSnapshot(
  input: DevBuildSnapshotRequest,
  overrides?: BuildDevAppSnapshotOverrides,
): Promise<DevBuildSnapshot>;
export function runDevBuildSnapshotUnlocked(
  input: DevBuildSnapshotInput,
  overrides?: RunDevBuildSnapshotUnlockedOverrides,
): Promise<DevBuildSnapshot>;
export function findCandidateApp(bundleDir: string, expectedAppName: string): Promise<string>;
export function assertBundleIdentity(
  appPath: string,
  identity: BundleIdentity,
  expectedChannelConfig: BuildChannelConfig,
): void;
export function installBundleTransactional(
  candidate: string,
  requestedChannelConfig: BuildChannelConfig,
  overrides: InstallOverrides,
): Promise<string>;
export function publishBuildChannel(
  candidate: string,
  requestedChannelConfig: BuildChannelConfig,
  record: BuildProvenance,
  overrides?: PublishBuildChannelOverrides,
): Promise<string>;
export function validateBuildProvenance(
  record: unknown,
): asserts record is BuildProvenance;
export function writeBuildProvenance(
  record: BuildProvenance,
  overrides?: WriteBuildProvenanceOverrides,
): Promise<string>;
export function writeBuildProvenanceUnlocked(
  statePath: string,
  record: BuildProvenance,
  overrides?: WriteBuildProvenanceUnlockedOverrides,
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
export function runMacosBuild(
  options: RunMacosBuildOptions,
  deps?: RunMacosBuildDependencies,
): Promise<RunMacosBuildResult>;
export function runCli(
  argv: readonly string[],
  deps?: RunCliDependencies,
): Promise<number>;
