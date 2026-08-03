export interface ReleaseVersions {
  packageJson: string;
  nativePackageJson: string;
  cargoToml: string;
  cargoLock: string;
  tauriConfig: string;
}

export function normalizeReleaseTag(value: string): string;
export function readReleaseVersions(root?: string): ReleaseVersions;
export function assertReleaseVersion(root: string, tag: string): string;
export function setReleaseVersion(root: string, value: string): Promise<string>;
