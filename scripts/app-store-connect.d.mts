export interface JsonApiResource {
  type: string;
  id: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<
    string,
    { data?: JsonApiResource | JsonApiResource[] | null }
  >;
}

export interface ReleaseIdentity {
  bundleId: string;
  version: string;
  buildNumber: string;
}

export interface ReleaseBuild {
  id: string;
  version: string;
  processingState: string;
}

export interface BetaBuildLocalization {
  id: string;
  locale: string;
  whatsNew: string;
}

export interface AppStoreConnectClient {
  readonly request: (
    pathname: string,
    options?: {
      method?: string;
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      signal?: AbortSignal;
      deadline?: number;
    },
  ) => Promise<unknown>;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

export function createAppStoreConnectToken(options: {
  keyId: string;
  issuerId: string;
  privateKey: string;
  now?: () => number;
}): string;

export function createAppStoreConnectClient(options: {
  fetch?: typeof globalThis.fetch;
  getToken: () => string | Promise<string>;
  baseUrl?: string;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  redactValues?: string[];
}): AppStoreConnectClient;

export function findExactBuild(
  client: AppStoreConnectClient,
  identity: ReleaseIdentity,
  options?: { signal?: AbortSignal; deadline?: number },
): Promise<JsonApiResource>;

export function waitForBuild(
  client: AppStoreConnectClient,
  options: ReleaseIdentity & {
    timeoutMs?: number;
    pollIntervalMs?: number;
  },
): Promise<ReleaseBuild>;

export function normalizeTestFlightNotes(notes: string, releaseSha: string): string;

export function upsertBetaBuildLocalization(
  client: AppStoreConnectClient,
  options: {
    buildId: string;
    locale?: string;
    whatsNew: string;
  },
  requestOptions?: { signal?: AbortSignal; deadline?: number },
): Promise<BetaBuildLocalization>;

export function waitAndLocalize(
  client: AppStoreConnectClient,
  options: ReleaseIdentity & {
    locale?: string;
    notes: string;
    releaseSha: string;
    timeoutMs?: number;
    reuseExisting?: boolean;
  },
): Promise<{
  build: ReleaseBuild;
  localization: BetaBuildLocalization;
  reused: boolean;
}>;
