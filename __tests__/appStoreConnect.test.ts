import { execFile } from 'node:child_process';
import {
  generateKeyPairSync,
  verify as verifySignature,
} from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createAppStoreConnectClient,
  createAppStoreConnectToken,
  findExactBuild,
  normalizeTestFlightNotes,
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

function identityFetch(options: {
  apps?: readonly JsonApiResource[];
  versions?: readonly JsonApiResource[];
  builds?: readonly JsonApiResource[] | (() => readonly JsonApiResource[]);
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
      return jsonResponse({ data: options.versions ?? [versionResource()] });
    }
    if (url.pathname === '/v1/builds') {
      const builds = typeof options.builds === 'function' ? options.builds() : options.builds;
      return jsonResponse({ data: builds ?? [buildResource()] });
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
    token: TOKEN,
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
    expect(calls[2].url.searchParams.get('filter[preReleaseVersion]')).toBe('version-1');
    expect(calls[2].url.searchParams.get('filter[version]')).toBe(BUILD_NUMBER);
    expect(calls[2].url.searchParams.get('include')).toBe('app,preReleaseVersion');
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

  it('waits for a normal upload and writes notes with release provenance', async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      calls.push({ url, init });
      if (url.pathname === '/v1/apps') return jsonResponse({ data: [appResource()] });
      if (url.pathname === '/v1/preReleaseVersions') {
        return jsonResponse({ data: [versionResource()] });
      }
      if (url.pathname === '/v1/builds') return jsonResponse({ data: [buildResource()] });
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
  it('reuses an exact VALID build only when existing provenance matches, without mutation', async () => {
    const calls: FetchCall[] = [];
    const whatsNew = `Existing test notes.\n\nSource commit: ${RELEASE_SHA}`;
    const localization = {
      type: 'betaBuildLocalizations',
      id: 'localization-1',
      attributes: { locale: 'en-US', whatsNew },
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
  it('redacts the bearer token and private key from API and transport errors', async () => {
    const privateKey = 'PRIVATE_KEY_SENTINEL';
    const errorFetch = (async () =>
      jsonResponse(
        {
          errors: [
            {
              code: 'FORBIDDEN',
              detail: `Authorization: Bearer ${TOKEN}; key=${privateKey}`,
            },
          ],
        },
        403,
      )) as typeof fetch;
    const client = createAppStoreConnectClient({
      fetch: errorFetch,
      token: TOKEN,
      redactValues: [privateKey],
    });

    const apiError = await capturedError(() =>
      findExactBuild(client, {
        bundleId: BUNDLE_ID,
        version: VERSION,
        buildNumber: BUILD_NUMBER,
      }),
    );
    expect(apiError.message).not.toContain(TOKEN);
    expect(apiError.message).not.toContain(privateKey);
    expect(apiError.message).toContain('[REDACTED]');

    const transportClient = createAppStoreConnectClient({
      fetch: (async () => {
        throw new Error(`Bearer ${TOKEN} ${privateKey}`);
      }) as typeof fetch,
      token: TOKEN,
      redactValues: [privateKey],
    });
    const transportError = await capturedError(() =>
      findExactBuild(transportClient, {
        bundleId: BUNDLE_ID,
        version: VERSION,
        buildNumber: BUILD_NUMBER,
      }),
    );
    expect(transportError.message).not.toContain(TOKEN);
    expect(transportError.message).not.toContain(privateKey);
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
      token: TOKEN,
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

  it('reports CLI credential errors without echoing key material or a bearer token', async () => {
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
