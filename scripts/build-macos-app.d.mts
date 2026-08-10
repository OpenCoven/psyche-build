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

export function parseBuildArguments(argv: readonly string[]): ParsedBuildArguments;
export function channelConfig(channel: BuildChannel): BuildChannelConfig;
export function createDevTauriConfig(production: TauriConfig): TauriConfig;
export function buildCommandsFor(
  channel: 'stable',
  options?: { devConfigPath?: string },
): BuildCommand[];
export function buildCommandsFor(
  channel: 'dev',
  options: { devConfigPath: string },
): BuildCommand[];
