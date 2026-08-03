import { execFile } from 'node:child_process';
import {
  generateKeyPairSync,
  verify as verifySignature,
} from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAppStoreConnectClient,
  createAppStoreConnectToken,
  findExactBuild,
  normalizeTestFlightNotes,
  reuseExitCode,
  upsertBetaBuildLocalization,
  waitAndLocalize,
  waitForBuild,
} from '../scripts/app-store-connect.mjs';

const BUNDLE_ID = 'ai.opencoven.psyche-ios';
const VERSION = '0.0.1';
const BUILD_NUMBER = '1';
const RELEASE_SHA = '0123456789abcdef0123456789abcdef01234567';
const TOKEN = 'header.payload.signature';
const API_ROOT = 'https://api.appstoreconnect.apple.com';
const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

type JsonApiResource = {
  type: string;
  id: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: JsonApiResource | JsonApiResource[] | null }>;
};

type FetchCall = { url: URL; init: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function appResource(overrides: Partial<JsonApiResource> = {}): JsonApiResource {
  return {
    type: 'apps',
    id: 'app-1',
    attributes: { bundleId: BUNDLE_ID, name: 'Psyche Build' },
    ...overrides,
  };
}

function versionResource(overrides: Partial<JsonApiResource> = {}): JsonApiResource {
  return {
    type: 'preReleaseVersions',
    id: 'version-1',
    attributes: { version: VERSION, platform: 'IOS' },
    relationships: { app: { data: { type: 'apps', id: 'app-1' } } },
    ...overrides,
  };
}

function buildResource(
  processingState = 'VALID',
  overrides: Partial<JsonApiResource> = {},
): JsonApiResource {
  return {
    type: 'builds',
    id: 'build-1',
    attributes: { version: BUILD_NUMBER, processingState },
    relationships: {
      app: { data: { type: 'apps', id: 'app-1' } },
      preReleaseVersion: {
        data: { type: 'preReleaseVersions', id: 'version-1' },
      },
    },
    ...overrides,
  };
}

function localizationResource(
  locale = 'en-US',
  whatsNew = 'Existing notes.',
  overrides: Partial<JsonApiResource> = {},
): JsonApiResource {
  return {
    type: 'betaBuildLocalizations',
    id: `localization-${locale}`,
    attributes: { locale, whatsNew },
    relationships: { build: { data: { type: 'builds', id: 'build-1' } } },
    ...overrides,
  };
}

function identityFetch(options: {
  apps?: readonly JsonApiResource[];
  versions?: readonly JsonApiResource[];
  versionIncluded?: readonly JsonApiResource[];
  omitVersionIncluded?: boolean;
  builds?: readonly JsonApiResource[] | (() => readonly JsonApiResource[]);
  buildIncluded?: readonly JsonApiResource[];
  omitBuildIncluded?: boolean;
  localization?: readonly JsonApiResource[];
  calls?: FetchCall[];
} = {}): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    options.calls?.push({ url, init });

    if (url.pathname === '/v1/apps') {
      return jsonResponse({ data: options.apps ?? [appResource()] });
    }
    if (url.pathname === '/v1/preReleaseVersions') {
      return jsonResponse({
        data: options.versions ?? [versionResource()],
        ...(options.omitVersionIncluded
          ? {}
          : { included: options.versionIncluded ?? [appResource()] }),
      });
    }
    if (url.pathname === '/v1/builds') {
      const builds = typeof options.builds === 'function' ? options.builds() : options.builds;
      return jsonResponse({
        data: builds ?? [buildResource()],
        ...(options.omitBuildIncluded
          ? {}
          : {
              included: options.buildIncluded ?? [appResource(), versionResource()],
            }),
      });
    }
    if (url.pathname === '/v1/builds/build-1/betaBuildLocalizations') {
      return jsonResponse({ data: options.localization ?? [] });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  }) as typeof fetch;
}

function clientWith(fetchImpl: typeof fetch, timing: {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
} = {}) {
  return createAppStoreConnectClient({
    fetch: fetchImpl,
    getToken: () => TOKEN,
    ...timing,
  });
}

async function capturedError(action: () => unknown | Promise<unknown>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('Expected action to fail');
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('App Store Connect token', () => {
  it('creates a short-lived, URL-safe ES256 JWT with a raw P1363 signature', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    const now = 1_786_000_000_789;

    const token = createAppStoreConnectToken({
      keyId: 'KEY123',
      issuerId: 'issuer-123',
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      now: () => now,
    });

    const [encodedHeader, encodedClaims, encodedSignature] = token.split('.');
    expect(token.split('.')).toHaveLength(3);
    expect(
      [encodedHeader, encodedClaims, encodedSignature].every((part) =>
        /^[A-Za-z0-9_-]+$/.test(part),
      ),
    ).toBe(true);
    expect(JSON.parse(Buffer.from(encodedHeader, 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'KEY123',
      typ: 'JWT',
    });

    const claims = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString()) as {
      iss: string;
      iat: number;
      exp: number;
      aud: string;
    };
    expect(claims).toMatchObject({
      iss: 'issuer-123',
      iat: Math.floor(now / 1_000),
      aud: 'appstoreconnect-v1',
    });
    expect(claims.exp).toBeGreaterThan(claims.iat);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(20 * 60);

    const signature = Buffer.from(encodedSignature, 'base64url');
    expect(signature).toHaveLength(64);
    expect(
      verifySignature(
        'sha256',
        Buffer.from(`${encodedHeader}.${encodedClaims}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        signature,
      ),
    ).toBe(true);
  });

  it('refreshes a valid JWT per request across 19 minutes without exposing old or new tokens', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const wallClockStart = 1_786_000_000_000;
    let monotonicNow = 0;
    let failLocalization = false;
    const authorizationValues: string[] = [];
    const baseFetch = identityFetch({
      builds: () => [buildResource(monotonicNow < 20 * 60_000 ? 'PROCESSING' : 'VALID')],
    });
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const authorization = new Headers(init.headers).get('authorization') ?? '';
      authorizationValues.push(authorization.replace(/^Bearer /, ''));
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (failLocalization && url.pathname.endsWith('/betaBuildLocalizations')) {
        return new Response(
          `REMOTE_DETAIL old=${authorizationValues[0]} new=${authorizationValues.at(-1)}`,
          { status: 503 },
        );
      }
      return baseFetch(input, init);
    }) as typeof fetch;
    const client = createAppStoreConnectClient({
      fetch: fetchImpl,
      getToken: async () =>
        createAppStoreConnectToken({
          keyId: 'KEY123',
          issuerId: 'issuer-123',
          privateKey: privateKeyPem,
          now: () => wallClockStart + monotonicNow,
        }),
      now: () => monotonicNow,
      sleep: async (milliseconds) => {
        monotonicNow += milliseconds;
      },
      redactValues: [privateKeyPem],
    });

    await expect(
      waitForBuild(client, {
        bundleId: BUNDLE_ID,
        version: VERSION,
        buildNumber: BUILD_NUMBER,
        timeoutMs: 45 * 60_000,
        pollIntervalMs: 10 * 60_000,
      }),
    ).resolves.toMatchObject({ processingState: 'VALID' });

    const firstToken = authorizationValues[0];
    const latestBuildToken = authorizationValues.at(-1) ?? '';
    const firstClaims = JSON.parse(
      Buffer.from(firstToken.split('.')[1], 'base64url').toString(),
    ) as { iat: number; exp: number };
    const latestClaims = JSON.parse(
      Buffer.from(latestBuildToken.split('.')[1], 'base64url').toString(),
    ) as { iat: number; exp: number };
    expect(monotonicNow).toBe(20 * 60_000);
    expect(latestClaims.iat).toBeGreaterThan(firstClaims.iat);
    expect(latestClaims.exp).toBeGreaterThan((wallClockStart + monotonicNow) / 1_000);

    failLocalization = true;
    const error = await capturedError(() =>
      upsertBetaBuildLocalization(client, {
        buildId: 'build-1',
        locale: 'en-US',
        whatsNew: 'Notes',
      }),
    );
    const newestToken = authorizationValues.at(-1) ?? '';
    expect(newestToken).not.toBe(firstToken);
    expect(error.message).toMatch(/GET.*betaBuildLocalizations.*503/i);
    expect(error.message).not.toContain(firstToken);
    expect(error.message).not.toContain(newestToken);
    expect(error.message).not.toContain('REMOTE_DETAIL');
  });
});

describe('exact release identity lookup', () => {
  it('uses Apple filters and returns only the exact iOS app, version, and build', async () => {
    const calls: FetchCall[] = [];
    const client = clientWith(identityFetch({ calls }));

    const build = await findExactBuild(client, {
      bundleId: BUNDLE_ID,
      version: VERSION,
      buildNumber: BUILD_NUMBER,
    });

    expect(build).toMatchObject({
      type: 'builds',
      id: 'build-1',
      attributes: { version: BUILD_NUMBER, processingState: 'VALID' },
    });
    expect(calls.map(({ url }) => url.pathname)).toEqual([
      '/v1/apps',
      '/v1/preReleaseVersions',
      '/v1/builds',
    ]);
    expect(calls[0].url.searchParams.get('filter[bundleId]')).toBe(BUNDLE_ID);
    expect(calls[1].url.searchParams.get('filter[app]')).toBe('app-1');
    expect(calls[1].url.searchParams.get('filter[version]')).toBe(VERSION);
    expect(calls[1].url.searchParams.get('filter[platform]')).toBe('IOS');
    expect(calls[1].url.searchParams.get('include')).toBe('app');
    expect(calls[1].url.searchParams.get('fields[apps]')).toBe('bundleId');
    expect(calls[2].url.searchParams.get('filter[preReleaseVersion]')).toBe('version-1');
    expect(calls[2].url.searchParams.get('filter[version]')).toBe(BUILD_NUMBER);
    expect(calls[2].url.searchParams.get('include')).toBe('app,preReleaseVersion');
    expect(calls[2].url.searchParams.get('fields[apps]')).toBe('bundleId');
    expect(calls[2].url.searchParams.get('fields[preReleaseVersions]')).toBe(
      'version,platform,app',
    );
    expect(calls.every(({ init }) => new Headers(init.headers).get('authorization') === `Bearer ${TOKEN}`)).toBe(true);
  });

  it.each([
    ['zero apps', { apps: [] }, /exactly one app/i],
    ['multiple apps', { apps: [appResource(), appResource({ id: 'app-2' })] }, /exactly one app/i],
    ['zero versions', { versions: [] }, /exactly one iOS prerelease version/i],
    [
      'multiple versions',
      { versions: [versionResource(), versionResource({ id: 'version-2' })] },
      /exactly one iOS prerelease version/i,
    ],
    ['zero builds', { builds: [] }, /exactly one build/i],
    [
      'multiple builds',
      { builds: [buildResource(), buildResource('VALID', { id: 'build-2' })] },
      /exactly one build/i,
    ],
  ] as const)('rejects %s', async (_label, options, expected) => {
    await expect(
      findExactBuild(clientWith(identityFetch(options)), {
        bundleId: BUNDLE_ID,
        version: VERSION,
        buildNumber: BUILD_NUMBER,
      }),
    ).rejects.toThrow(expected);
  });

  it.each([
    [
      'a mismatched app bundle ID',
      { apps: [appResource({ attributes: { bundleId: 'not.psyche' } })] },
      /identity mismatch/i,
    ],
    [
      'a mismatched prerelease platform',
      { versions: [versionResource({ attributes: { version: VERSION, platform: 'MAC_OS' } })] },
      /identity mismatch/i,
    ],
    [
      'a mismatched prerelease app relationship',
      {
        versions: [
          versionResource({ relationships: { app: { data: { type: 'apps', id: 'app-other' } } } }),
        ],
      },
      /identity mismatch/i,
    ],
    [
      'a mismatched build number',
      { builds: [buildResource('VALID', { attributes: { version: '2', processingState: 'VALID' } })] },
      /identity mismatch/i,
    ],
    [
      'a mismatched build prerelease relationship',
      {
        builds: [
          buildResource('VALID', {
            relationships: {
              app: { data: { type: 'apps', id: 'app-1' } },
              preReleaseVersion: {
                data: { type: 'preReleaseVersions', id: 'version-other' },
              },
            },
          }),
        ],
      },
      /identity mismatch/i,
    ],
  ] as const)('rejects %s returned despite exact filters', async (_label, options, expected) => {
    await expect(
      findExactBuild(clientWith(identityFetch(options)), {
        bundleId: BUNDLE_ID,
        version: VERSION,
        buildNumber: BUILD_NUMBER,
      }),
    ).rejects.toThrow(expected);
  });

  it.each([
    ['a missing included app collection', { omitVersionIncluded: true }],
    ['zero included apps', { versionIncluded: [] }],
    [
      'duplicate included apps',
      { versionIncluded: [appResource(), appResource()] },
    ],
    ['an included app type mismatch', { versionIncluded: [versionResource()] }],
    [
      'an included app relationship ID mismatch',
      { versionIncluded: [appResource({ id: 'app-other' })] },
    ],
    [
      'an included app bundle mismatch',
      {
        versionIncluded: [
          appResource({ attributes: { bundleId: 'not.psyche', name: 'Other' } }),
        ],
      },
    ],
  ] as const)('rejects prerelease lookup with %s', async (_label, options) => {
    await expect(
      findExactBuild(clientWith(identityFetch(options)), {
        bundleId: BUNDLE_ID,
        version: VERSION,
        buildNumber: BUILD_NUMBER,
      }),
    ).rejects.toThrow(/included.*identity mismatch/i);
  });

  it.each([
    ['a missing included collection', { omitBuildIncluded: true }],
    ['zero included resources', { buildIncluded: [] }],
    [
      'a duplicate included app',
      { buildIncluded: [appResource(), appResource(), versionResource()] },
    ],
    [
      'an included resource type mismatch',
      { buildIncluded: [appResource(), buildResource()] },
    ],
    [
      'an included app relationship ID mismatch',
      {
        buildIncluded: [appResource({ id: 'app-other' }), versionResource()],
      },
    ],
    [
      'an included app bundle mismatch',
      {
        buildIncluded: [
          appResource({ attributes: { bundleId: 'not.psyche' } }),
          versionResource(),
        ],
      },
    ],
    [
      'an included prerelease relationship ID mismatch',
      {
        buildIncluded: [appResource(), versionResource({ id: 'version-other' })],
      },
    ],
    [
      'an included prerelease version mismatch',
      {
        buildIncluded: [
          appResource(),
          versionResource({ attributes: { version: '0.0.2', platform: 'IOS' } }),
        ],
      },
    ],
    [
      'an included prerelease platform mismatch',
      {
        buildIncluded: [
          appResource(),
          versionResource({ attributes: { version: VERSION, platform: 'MAC_OS' } }),
        ],
      },
    ],
    [
      'an included prerelease app relationship mismatch',
      {
        buildIncluded: [
          appResource(),
          versionResource({
            relationships: {
              app: { data: { type: 'apps', id: 'app-other' } },
            },
          }),
        ],
      },
    ],
  ] as const)('rejects build lookup with %s', async (_label, options) => {
    await expect(
      findExactBuild(clientWith(identityFetch(options)), {
        bundleId: BUNDLE_ID,
        version: VERSION,
        buildNumber: BUILD_NUMBER,
      }),
    ).rejects.toThrow(/included.*identity mismatch/i);
  });
});

describe('build processing polling', () => {
  it('polls PROCESSING until VALID with injected time and sleep', async () => {
    let now = 0;
    let buildRequest = 0;
    const sleeps: number[] = [];
    const client = clientWith(
      identityFetch({
        builds: () => [buildResource(buildRequest++ === 0 ? 'PROCESSING' : 'VALID')],
      }),
      {
        now: () => now,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
          now += milliseconds;
        },
      },
    );

    await expect(
      waitForBuild(client, {
        bundleId: BUNDLE_ID,
        version: VERSION,
        buildNumber: BUILD_NUMBER,
        timeoutMs: 45 * 60_000,
      }),
    ).resolves.toMatchObject({ processingState: 'VALID' });
    expect(sleeps).toEqual([30_000]);
  });

  it.each(['FAILED', 'INVALID'])('fails immediately for %s', async (processingState) => {
    let sleepCount = 0;
    const client = clientWith(identityFetch({ builds: [buildResource(processingState)] }), {
      now: () => 0,
      sleep: async () => {
        sleepCount += 1;
      },
    });

    await expect(
      waitForBuild(client, {
        bundleId: BUNDLE_ID,
        version: VERSION,
        buildNumber: BUILD_NUMBER,
      }),
    ).rejects.toThrow(new RegExp(processingState));
    expect(sleepCount).toBe(0);
  });

  it('enforces the 45-minute timeout without sleeping past the deadline', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const client = clientWith(identityFetch({ builds: [buildResource('PROCESSING')] }), {
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });

    await expect(
      waitForBuild(client, {
        bundleId: BUNDLE_ID,
        version: VERSION,
        buildNumber: BUILD_NUMBER,
        timeoutMs: 45 * 60_000,
      }),
    ).rejects.toThrow(/timed out.*2700000/i);
    expect(now).toBe(45 * 60_000);
    expect(sleeps.reduce((total, value) => total + value, 0)).toBe(45 * 60_000);
  });

  it('aborts and rejects an unresolved fetch at the operation deadline even if transport ignores the signal', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let requestSignal: AbortSignal | undefined;
    const privateKey = 'PRIVATE_KEY_SENTINEL';
    const client = createAppStoreConnectClient({
      fetch: ((_: string | URL | Request, init: RequestInit = {}) => {
        requestSignal = init.signal ?? undefined;
        return new Promise<Response>(() => {});
      }) as typeof fetch,
      getToken: () => TOKEN,
      redactValues: [privateKey],
      now: () => Date.now(),
    });
    const outcome = Promise.race([
      capturedError(() =>
        waitForBuild(client, {
          bundleId: BUNDLE_ID,
          version: VERSION,
          buildNumber: BUILD_NUMBER,
          timeoutMs: 1_000,
        }),
      ),
      new Promise<'safety-timeout'>((resolve) => setTimeout(() => resolve('safety-timeout'), 1_001)),
    ]);

    await vi.advanceTimersByTimeAsync(1_001);
    const result = await outcome;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/timed out|deadline|aborted/i);
    expect((result as Error).message).not.toContain(TOKEN);
    expect((result as Error).message).not.toContain(privateKey);
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts an unresolved localization body read at the shared operation deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let requestSignal: AbortSignal | undefined;
    const response = new Response('', { status: 200 });
    Object.defineProperty(response, 'text', {
      value: () => new Promise<string>(() => {}),
    });
    const baseFetch = identityFetch();
    const client = createAppStoreConnectClient({
      fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
        if (url.pathname.endsWith('/betaBuildLocalizations')) {
          requestSignal = init.signal ?? undefined;
          return response;
        }
        return baseFetch(input, init);
      }) as typeof fetch,
      getToken: () => TOKEN,
      now: () => Date.now(),
    });
    const outcome = Promise.race([
      capturedError(() =>
        waitAndLocalize(client, {
          bundleId: BUNDLE_ID,
          version: VERSION,
          buildNumber: BUILD_NUMBER,
          locale: 'en-US',
          notes: 'Notes',
          releaseSha: RELEASE_SHA,
          timeoutMs: 1_000,
        }),
      ),
      new Promise<'safety-timeout'>((resolve) => setTimeout(() => resolve('safety-timeout'), 1_001)),
    ]);

    await vi.advanceTimersByTimeAsync(1_001);
    const result = await outcome;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/timed out|deadline|aborted/i);
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start a localization mutation when the list body completes at the deadline', async () => {
    let now = 0;
    const calls: FetchCall[] = [];
    const baseFetch = identityFetch({ calls });
    const existing = localizationResource('en-US', 'Old notes');
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.pathname.endsWith('/betaBuildLocalizations')) {
        calls.push({ url, init });
        const response = jsonResponse({ data: [existing] });
        Object.defineProperty(response, 'text', {
          value: async () => {
            now = 1_000;
            return JSON.stringify({ data: [existing] });
          },
        });
        return response;
      }
      return baseFetch(input, init);
    }) as typeof fetch;
    const client = clientWith(fetchImpl, { now: () => now });

    await expect(
      waitAndLocalize(client, {
        bundleId: BUNDLE_ID,
        version: VERSION,
        buildNumber: BUILD_NUMBER,
        locale: 'en-US',
        notes: 'Notes',
        releaseSha: RELEASE_SHA,
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/timed out|deadline|aborted/i);
    expect(calls.map(({ init }) => init.method ?? 'GET')).toEqual([
      'GET',
      'GET',
      'GET',
      'GET',
    ]);
  });

  it('does not start another lookup at the exact deadline', async () => {
    let now = 0;
    let buildRequest = 0;
    const calls: FetchCall[] = [];
    const client = clientWith(
      identityFetch({
        calls,
        builds: () => [buildResource(buildRequest++ === 0 ? 'PROCESSING' : 'VALID')],
      }),
      {
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      },
    );

    await expect(
      waitForBuild(client, {
        bundleId: BUNDLE_ID,
        version: VERSION,
        buildNumber: BUILD_NUMBER,
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow(/timed out/i);
    expect(now).toBe(30_000);
    expect(buildRequest).toBe(1);
    expect(calls).toHaveLength(3);
  });

  it('rejects a VALID lookup result that completes after the deadline', async () => {
    let now = 0;
    const baseFetch = identityFetch();
    const advancingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await baseFetch(input, init);
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.pathname === '/v1/builds') now = 1_001;
      return response;
    }) as typeof fetch;
    const client = clientWith(advancingFetch, {
      now: () => now,
      sleep: async () => {},
    });

    await expect(
      waitForBuild(client, {
        bundleId: BUNDLE_ID,
        version: VERSION,
        buildNumber: BUILD_NUMBER,
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/timed out/i);
    expect(now).toBe(1_001);
  });

  it('caps a one-interval timeout and performs only the initial lookup', async () => {
    let now = 0;
    let buildRequest = 0;
    const sleeps: number[] = [];
    const client = clientWith(
      identityFetch({
        builds: () => {
          buildRequest += 1;
          return [buildResource('PROCESSING')];
        },
      }),
      {
        now: () => now,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
          now += milliseconds;
        },
      },
    );

    await expect(
      waitForBuild(client, {
        bundleId: BUNDLE_ID,
        version: VERSION,
        buildNumber: BUILD_NUMBER,
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/timed out/i);
    expect(sleeps).toEqual([1_000]);
    expect(buildRequest).toBe(1);
  });
});

describe('TestFlight notes and beta build localization', () => {
  it('normalizes exactly one final source-commit line and enforces 4,000 characters', () => {
    const line = `Source commit: ${RELEASE_SHA}`;
    const notes = normalizeTestFlightNotes(
      `Try launch and reconnect.\n\nSource commit: ${'f'.repeat(40)}\n`,
      RELEASE_SHA,
    );

    expect(notes).toBe(`Try launch and reconnect.\n\n${line}`);
    expect(notes.match(/^Source commit: /gm)).toHaveLength(1);
    expect(notes.endsWith(line)).toBe(true);
    expect(
      normalizeTestFlightNotes('x'.repeat(4_000 - line.length - 2), RELEASE_SHA),
    ).toHaveLength(4_000);
    expect(() =>
      normalizeTestFlightNotes('x'.repeat(4_000 - line.length - 1), RELEASE_SHA),
    ).toThrow(/4,000/);
    expect(() => normalizeTestFlightNotes('notes', 'not-a-sha')).toThrow(/40-hex/i);
  });

  it('counts astral Unicode characters as one code point at the 4,000-character boundary', () => {
    const provenance = `Source commit: ${RELEASE_SHA}`;
    const reservedCodePoints = [...`\n\n${provenance}`].length;
    const exact = normalizeTestFlightNotes(
      '🫠'.repeat(4_000 - reservedCodePoints),
      RELEASE_SHA,
    );

    expect([...exact]).toHaveLength(4_000);
    expect(() =>
      normalizeTestFlightNotes('🫠'.repeat(4_001 - reservedCodePoints), RELEASE_SHA),
    ).toThrow(/4,000/);
  });

  it('uses the same Unicode code-point limit for direct localization writes', async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      calls.push({ url, init });
      if (url.pathname.endsWith('/betaBuildLocalizations') && init.method === 'GET') {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === '/v1/betaBuildLocalizations' && init.method === 'POST') {
        const body = JSON.parse(String(init.body)) as {
          data: { attributes: { locale: string; whatsNew: string } };
        };
        return jsonResponse({
          data: localizationResource(
            body.data.attributes.locale,
            body.data.attributes.whatsNew,
            { id: 'localization-1' },
          ),
        }, 201);
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    }) as typeof fetch;
    const client = clientWith(fetchImpl);

    await expect(
      upsertBetaBuildLocalization(client, {
        buildId: 'build-1',
        locale: 'en-US',
        whatsNew: '🫠'.repeat(4_000),
      }),
    ).resolves.toMatchObject({ id: 'localization-1' });
    const callCount = calls.length;
    await expect(
      upsertBetaBuildLocalization(client, {
        buildId: 'build-1',
        locale: 'en-US',
        whatsNew: '🫠'.repeat(4_001),
      }),
    ).rejects.toThrow(/4,000/);
    expect(calls).toHaveLength(callCount);
  });

  it('creates an en-US beta build localization when none exists', async () => {
    const calls: FetchCall[] = [];
    const whatsNew = normalizeTestFlightNotes('Try the release.', RELEASE_SHA);
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      calls.push({ url, init });
      if (url.pathname === '/v1/builds/build-1/betaBuildLocalizations') {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === '/v1/betaBuildLocalizations' && init.method === 'POST') {
        return jsonResponse(
          {
            data: {
              type: 'betaBuildLocalizations',
              id: 'localization-1',
              attributes: { locale: 'en-US', whatsNew },
            },
          },
          201,
        );
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    }) as typeof fetch;

    const localization = await upsertBetaBuildLocalization(clientWith(fetchImpl), {
      buildId: 'build-1',
      locale: 'en-US',
      whatsNew,
    });

    expect(localization.whatsNew).toContain(`Source commit: ${RELEASE_SHA}`);
    expect(calls.map(({ init }) => init.method ?? 'GET')).toEqual(['GET', 'POST']);
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      data: {
        type: 'betaBuildLocalizations',
        attributes: { locale: 'en-US', whatsNew },
        relationships: { build: { data: { type: 'builds', id: 'build-1' } } },
      },
    });
  });

  it('updates the exact existing en-US beta build localization', async () => {
    const calls: FetchCall[] = [];
    const whatsNew = normalizeTestFlightNotes('Updated testing instructions.', RELEASE_SHA);
    const existing = {
      type: 'betaBuildLocalizations',
      id: 'localization-1',
      attributes: { locale: 'en-US', whatsNew: 'Old notes' },
      relationships: { build: { data: { type: 'builds', id: 'build-1' } } },
    } satisfies JsonApiResource;
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      calls.push({ url, init });
      if (url.pathname === '/v1/builds/build-1/betaBuildLocalizations') {
        return jsonResponse({ data: [existing] });
      }
      if (url.pathname === '/v1/betaBuildLocalizations/localization-1' && init.method === 'PATCH') {
        return jsonResponse({
          data: { ...existing, attributes: { locale: 'en-US', whatsNew } },
        });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    }) as typeof fetch;

    await expect(
      upsertBetaBuildLocalization(clientWith(fetchImpl), {
        buildId: 'build-1',
        locale: 'en-US',
        whatsNew,
      }),
    ).resolves.toMatchObject({ id: 'localization-1', whatsNew });
    expect(calls.map(({ init }) => init.method ?? 'GET')).toEqual(['GET', 'PATCH']);
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      data: {
        type: 'betaBuildLocalizations',
        id: 'localization-1',
        attributes: { whatsNew },
      },
    });
  });

  it.each([
    [
      'a wrong resource type on a nonmatching row',
      [
        localizationResource('en-US', 'Old notes'),
        localizationResource('fr-FR', 'French notes', { type: 'builds' }),
      ],
    ],
    [
      'a malformed nonmatching row',
      [
        localizationResource('en-US', 'Old notes'),
        localizationResource('fr-FR', 'French notes', { id: undefined as unknown as string }),
      ],
    ],
    [
      'missing localization attributes',
      [
        localizationResource('en-US', 'Old notes'),
        localizationResource('fr-FR', 'French notes', { attributes: undefined }),
      ],
    ],
    [
      'a non-string locale on any row',
      [
        localizationResource('en-US', 'Old notes'),
        localizationResource('fr-FR', 'French notes', {
          attributes: { locale: 123, whatsNew: 'French notes' },
        }),
      ],
    ],
    [
      'a non-string whatsNew on any row',
      [
        localizationResource('en-US', 'Old notes'),
        localizationResource('fr-FR', 'French notes', {
          attributes: { locale: 'fr-FR', whatsNew: 123 },
        }),
      ],
    ],
    [
      'a target localization linked to another build',
      [
        localizationResource('en-US', 'Old notes', {
          relationships: { build: { data: { type: 'builds', id: 'build-other' } } },
        }),
      ],
    ],
    [
      'a malformed build relationship',
      [
        localizationResource('en-US', 'Old notes', {
          relationships: {
            build: { data: { type: 'betaBuildLocalizations', id: 'build-1' } },
          },
        }),
      ],
    ],
  ] as const)('rejects %s before POST or PATCH', async (_label, resources) => {
    const calls: FetchCall[] = [];
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      calls.push({ url, init });
      if (url.pathname === '/v1/builds/build-1/betaBuildLocalizations') {
        return jsonResponse({ data: resources });
      }
      throw new Error(`Unexpected mutation: ${init.method ?? 'GET'} ${url.pathname}`);
    }) as typeof fetch;

    await expect(
      upsertBetaBuildLocalization(clientWith(fetchImpl), {
        buildId: 'build-1',
        locale: 'en-US',
        whatsNew: 'New notes',
      }),
    ).rejects.toThrow(/identity mismatch|invalid/i);
    expect(calls.map(({ init }) => init.method ?? 'GET')).toEqual(['GET']);
  });

  it('waits for a normal upload and writes notes with release provenance', async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      calls.push({ url, init });
      if (url.pathname === '/v1/apps') return jsonResponse({ data: [appResource()] });
      if (url.pathname === '/v1/preReleaseVersions') {
        return jsonResponse({ data: [versionResource()], included: [appResource()] });
      }
      if (url.pathname === '/v1/builds') {
        return jsonResponse({
          data: [buildResource()],
          included: [appResource(), versionResource()],
        });
      }
      if (url.pathname === '/v1/builds/build-1/betaBuildLocalizations') {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === '/v1/betaBuildLocalizations' && init.method === 'POST') {
        const body = JSON.parse(String(init.body)) as {
          data: { attributes: { locale: string; whatsNew: string } };
        };
        return jsonResponse({
          data: {
            type: 'betaBuildLocalizations',
            id: 'localization-1',
            attributes: body.data.attributes,
          },
        }, 201);
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    }) as typeof fetch;

    const { localization } = await waitAndLocalize(clientWith(fetchImpl), {
      bundleId: BUNDLE_ID,
      version: VERSION,
      buildNumber: BUILD_NUMBER,
      locale: 'en-US',
      notes: 'Exercise launch and reconnect.',
      releaseSha: RELEASE_SHA,
    });

    expect(localization.whatsNew).toContain(`Source commit: ${RELEASE_SHA}`);
    expect(calls.some(({ init }) => init.method === 'POST')).toBe(true);
  });
});

describe('fail-closed reuse mode', () => {
  it('returns a distinct upload-safe exit code only when the exact version or build is absent', async () => {
    for (const options of [{ versions: [] }, { builds: [] }]) {
      const error = await capturedError(() =>
        waitAndLocalize(clientWith(identityFetch(options)), {
          bundleId: BUNDLE_ID,
          version: VERSION,
          buildNumber: BUILD_NUMBER,
          locale: 'en-US',
          notes: 'Retry notes.',
          releaseSha: RELEASE_SHA,
          reuseExisting: true,
        }),
      );
      expect(reuseExitCode(error)).toBe(2);
    }

    for (const options of [
      { apps: [] },
      { versions: [versionResource(), versionResource({ id: 'version-2' })] },
      { builds: [buildResource(), buildResource('VALID', { id: 'build-2' })] },
    ]) {
      const error = await capturedError(() =>
        waitAndLocalize(clientWith(identityFetch(options)), {
          bundleId: BUNDLE_ID,
          version: VERSION,
          buildNumber: BUILD_NUMBER,
          locale: 'en-US',
          notes: 'Retry notes.',
          releaseSha: RELEASE_SHA,
          reuseExisting: true,
        }),
      );
      expect(reuseExitCode(error)).toBe(1);
    }
    expect(reuseExitCode(new Error('transport failure'))).toBe(1);
  });

  it('reuses an exact VALID build only when existing provenance matches, without mutation', async () => {
    const calls: FetchCall[] = [];
    const whatsNew = `Existing test notes.\n\nSource commit: ${RELEASE_SHA}`;
    const localization = {
      type: 'betaBuildLocalizations',
      id: 'localization-1',
      attributes: { locale: 'en-US', whatsNew },
      relationships: { build: { data: { type: 'builds', id: 'build-1' } } },
    } satisfies JsonApiResource;
    const client = clientWith(identityFetch({ calls, localization: [localization] }));

    await expect(
      waitAndLocalize(client, {
        bundleId: BUNDLE_ID,
        version: VERSION,
        buildNumber: BUILD_NUMBER,
        locale: 'en-US',
        notes: 'Unused retry notes.',
        releaseSha: RELEASE_SHA,
        reuseExisting: true,
      }),
    ).resolves.toMatchObject({
      reused: true,
      build: { id: 'build-1', processingState: 'VALID' },
      localization: { id: 'localization-1', whatsNew },
    });
    expect(calls.every(({ init }) => (init.method ?? 'GET') === 'GET')).toBe(true);
  });

  it.each([
    ['missing localization', []],
    [
      'missing provenance',
      [
        {
          type: 'betaBuildLocalizations',
          id: 'localization-1',
          attributes: { locale: 'en-US', whatsNew: 'No source here.' },
          relationships: { build: { data: { type: 'builds', id: 'build-1' } } },
        },
      ],
    ],
    [
      'mismatched provenance',
      [
        {
          type: 'betaBuildLocalizations',
          id: 'localization-1',
          attributes: {
            locale: 'en-US',
            whatsNew: `Source commit: ${'f'.repeat(40)}`,
          },
          relationships: { build: { data: { type: 'builds', id: 'build-1' } } },
        },
      ],
    ],
    [
      'ambiguous provenance',
      [
        {
          type: 'betaBuildLocalizations',
          id: 'localization-1',
          attributes: {
            locale: 'en-US',
            whatsNew: `Source commit: ${RELEASE_SHA}\nSource commit: ${RELEASE_SHA}`,
          },
          relationships: { build: { data: { type: 'builds', id: 'build-1' } } },
        },
      ],
    ],
  ] as const)('rejects %s without mutation', async (_label, localization) => {
    const calls: FetchCall[] = [];
    const client = clientWith(identityFetch({ calls, localization: [...localization] }));

    await expect(
      waitAndLocalize(client, {
        bundleId: BUNDLE_ID,
        version: VERSION,
        buildNumber: BUILD_NUMBER,
        locale: 'en-US',
        notes: 'Retry notes.',
        releaseSha: RELEASE_SHA,
        reuseExisting: true,
      }),
    ).rejects.toThrow(/provenance|localization/i);
    expect(calls.every(({ init }) => (init.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('rejects a non-VALID existing build without mutation', async () => {
    const calls: FetchCall[] = [];
    const client = clientWith(identityFetch({ calls, builds: [buildResource('PROCESSING')] }));

    await expect(
      waitAndLocalize(client, {
        bundleId: BUNDLE_ID,
        version: VERSION,
        buildNumber: BUILD_NUMBER,
        locale: 'en-US',
        notes: 'Retry notes.',
        releaseSha: RELEASE_SHA,
        reuseExisting: true,
      }),
    ).rejects.toThrow(/VALID/);
    expect(calls.every(({ init }) => (init.method ?? 'GET') === 'GET')).toBe(true);
  });
});

describe('secret redaction and CLI contract', () => {
  it('does not surface untrusted non-2xx response body text', async () => {
    const privateKey = 'PRIVATE_KEY_SENTINEL';
    const errorFetch = (async () =>
      new Response(`REMOTE_DETAIL Authorization: Bearer ${TOKEN}; key=${privateKey}`, {
        status: 403,
      })) as typeof fetch;
    const client = createAppStoreConnectClient({
      fetch: errorFetch,
      getToken: () => TOKEN,
      redactValues: [privateKey],
    });

    const apiError = await capturedError(() =>
      findExactBuild(client, {
        bundleId: BUNDLE_ID,
        version: VERSION,
        buildNumber: BUILD_NUMBER,
      }),
    );
    expect(apiError.message).toMatch(/GET.*\/v1\/apps.*403/i);
    expect(apiError.message).not.toContain(TOKEN);
    expect(apiError.message).not.toContain(privateKey);
    expect(apiError.message).not.toContain('REMOTE_DETAIL');
  });

  it('does not surface untrusted fetch rejection messages', async () => {
    const privateKey = 'PRIVATE_KEY_SENTINEL';
    const transportClient = createAppStoreConnectClient({
      fetch: (async () => {
        throw new Error(`REMOTE_TRANSPORT Bearer ${TOKEN} ${privateKey}`);
      }) as typeof fetch,
      getToken: () => TOKEN,
      redactValues: [privateKey],
    });
    const transportError = await capturedError(() =>
      findExactBuild(transportClient, {
        bundleId: BUNDLE_ID,
        version: VERSION,
        buildNumber: BUILD_NUMBER,
      }),
    );
    expect(transportError.message).toMatch(/GET.*\/v1\/apps.*request failed/i);
    expect(transportError.message).not.toContain(TOKEN);
    expect(transportError.message).not.toContain(privateKey);
    expect(transportError.message).not.toContain('REMOTE_TRANSPORT');
  });

  it('does not surface response body-read failures', async () => {
    const privateKey = 'PRIVATE_KEY_SENTINEL';
    const client = createAppStoreConnectClient({
      fetch: (async () => {
        const response = new Response('', { status: 502 });
        Object.defineProperty(response, 'text', {
          value: async () => {
            throw new Error(`REMOTE_BODY_READ Bearer ${TOKEN} ${privateKey}`);
          },
        });
        return response;
      }) as typeof fetch,
      getToken: () => TOKEN,
      redactValues: [privateKey],
    });

    const error = await capturedError(() =>
      findExactBuild(client, {
        bundleId: BUNDLE_ID,
        version: VERSION,
        buildNumber: BUILD_NUMBER,
      }),
    );
    expect(error.message).toMatch(/GET.*\/v1\/apps.*response body/i);
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain(privateKey);
    expect(error.message).not.toContain('REMOTE_BODY_READ');
  });

  it('never copies secret-shaped response attributes into polling diagnostics', async () => {
    const privateKey = 'PRIVATE_KEY_SENTINEL';
    const client = createAppStoreConnectClient({
      fetch: identityFetch({
        builds: [
          buildResource(TOKEN, {
            id: privateKey,
          }),
        ],
      }),
      getToken: () => TOKEN,
      redactValues: [privateKey],
      now: () => 0,
      sleep: async () => {},
    });

    const error = await capturedError(() =>
      waitForBuild(client, {
        bundleId: BUNDLE_ID,
        version: VERSION,
        buildNumber: BUILD_NUMBER,
      }),
    );
    expect(error.message).toMatch(/unexpected processing state/i);
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain(privateKey);
  });

  it.each(['0', '2701'])('rejects a %s-second CLI timeout before credentials or network', async (timeoutSeconds) => {
    const result = await capturedError(() =>
      execFileAsync(process.execPath, [
        path.resolve('scripts/app-store-connect.mjs'),
        'wait-and-localize',
        '--bundle-id',
        BUNDLE_ID,
        '--version',
        VERSION,
        '--build-number',
        BUILD_NUMBER,
        '--locale',
        'en-US',
        '--notes-file',
        '/does/not/matter',
        '--release-sha',
        RELEASE_SHA,
        '--timeout-seconds',
        timeoutSeconds,
      ]),
    );
    const diagnostic = `${result.message}\n${String((result as Error & { stderr?: string }).stderr ?? '')}`;
    expect(diagnostic).toContain('Usage:');
    expect(diagnostic).not.toMatch(/fetch|network/i);
  });

  it('accepts the exact 2,700-second CLI maximum and reports credential errors safely', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-asc-'));
    temporaryRoots.push(root);
    const privateKey = 'PRIVATE_KEY_SENTINEL_DO_NOT_PRINT';
    const privateKeyPath = path.join(root, 'AuthKey.p8');
    const notesPath = path.join(root, 'notes.txt');
    await writeFile(privateKeyPath, privateKey);
    await writeFile(notesPath, 'Test launch.');

    const result = await capturedError(() =>
      execFileAsync(
        process.execPath,
        [
          path.resolve('scripts/app-store-connect.mjs'),
          'wait-and-localize',
          '--bundle-id',
          BUNDLE_ID,
          '--version',
          VERSION,
          '--build-number',
          BUILD_NUMBER,
          '--locale',
          'en-US',
          '--notes-file',
          notesPath,
          '--release-sha',
          RELEASE_SHA,
          '--timeout-seconds',
          '2700',
        ],
        {
          env: {
            ...process.env,
            APP_STORE_CONNECT_KEY_ID: 'SECRET_KEY_ID',
            APP_STORE_CONNECT_ISSUER_ID: 'SECRET_ISSUER_ID',
            APP_STORE_CONNECT_PRIVATE_KEY_PATH: privateKeyPath,
          },
        },
      ),
    );
    const diagnostic = `${result.message}\n${String((result as Error & { stderr?: string }).stderr ?? '')}`;
    expect(diagnostic).toMatch(/create App Store Connect token/i);
    expect(diagnostic).not.toContain(privateKey);
    expect(diagnostic).not.toContain(TOKEN);
    expect(diagnostic).not.toContain('SECRET_KEY_ID');
    expect(diagnostic).not.toContain('SECRET_ISSUER_ID');
  });

  it('ships the exact operator script without adding a release dependency', async () => {
    const packageJson = JSON.parse(await readFile(path.resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['release:testflight']).toBe(
      'node scripts/app-store-connect.mjs wait-and-localize',
    );
  });
});
