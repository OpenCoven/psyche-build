export const CASK_UPGRADE_COMMAND: 'brew upgrade --cask psyche-build';

export type UpdateCheckState =
  | 'idle' | 'disabled' | 'off' | 'checking' | 'unreachable' | 'oversize'
  | 'invalid_signature' | 'unknown_key' | 'non_canonical' | 'malformed'
  | 'not_yet_valid' | 'expired' | 'not_newer' | 'available';

export interface UpdateStatus {
  state: UpdateCheckState | string;
  running_version?: string;
  checks_supported?: boolean;
  checks_enabled?: boolean;
  last_check?: string | null;
  install_source?: 'homebrew_cask' | 'dmg' | 'unknown' | string;
  skipped?: boolean;
  dismissed?: boolean;
  available?: {
    version: string;
    tag: string;
    release_url: string;
    arch?: string | null;
    dmg_file?: string | null;
    dmg_sha256?: string | null;
  } | null;
  upgraded_from?: string | null;
}

export interface UpdateBannerModel {
  version: string;
  runningVersion: string;
  showCask: boolean;
  showDmg: boolean;
  releaseUrl: string;
  arch: string | null;
  sha256: string | null;
}

export interface UpdateBannerHandlers {
  copy(text: string): unknown;
  openRelease(url: string): unknown;
  skip(version: string): unknown;
  dismiss(): unknown;
}

export function bannerModel(status: UpdateStatus | null | undefined): UpdateBannerModel | null;
export function renderUpdateBanner(
  container: any,
  model: UpdateBannerModel | null,
  handlers: UpdateBannerHandlers,
  doc?: any,
): boolean;
export function createUpdateBannerController(options: {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  listen?: ((event: string, callback: () => void) => unknown) | null;
  container: any;
  checksToggle?: any;
  checksRow?: any;
  writeText?: ((text: string) => Promise<unknown>) | null;
  openUrl?: ((url: string) => Promise<unknown>) | null;
  announce?: (message: string) => void;
  restoreFocus?: () => void;
}): {
  refresh(): Promise<UpdateStatus | null>;
  handlers: UpdateBannerHandlers;
  readonly status: UpdateStatus | null;
  dispose(): void;
};
