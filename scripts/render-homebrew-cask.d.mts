export interface CaskRelease {
  version: string;
  arm: string;
  intel: string;
}

export interface RenderedCask {
  cask: string;
  changed: boolean;
  previous: CaskRelease;
}

export const CASK_PATH: string;
export function releaseAssetNames(version: string): { arm: string; intel: string };
export function normalizeVersion(value: string): string;
export function parseSha256Sums(text: string, version: string): CaskRelease;
export function readCaskRelease(cask: string): CaskRelease;
export function renderHomebrewCask(currentCask: string, release: CaskRelease): RenderedCask;
