#!/usr/bin/env node

import { sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const API_ROOT = 'https://api.appstoreconnect.apple.com';
const DEFAULT_TIMEOUT_MS = 45 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const TOKEN_LIFETIME_SECONDS = 19 * 60;
const MAX_NOTES_LENGTH = 4_000;
const SOURCE_COMMIT_PREFIX = 'Source commit: ';

class ExactLookupError extends Error {
  constructor(resource, count) {
    const descriptions = {
      app: 'app',
      version: 'iOS prerelease version',
      build: 'build',
    };
    super(`Expected exactly one ${descriptions[resource]}; found ${count}`);
    this.name = 'ExactLookupError';
    this.resource = resource;
    this.count = count;
  }
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function asMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function redact(value, secrets) {
  let result = String(value);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) {
      result = result.split(secret).join('[REDACTED]');
    }
  }
  return result.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]');
}

function assertNonEmpty(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`);
  }
}

export function createAppStoreConnectToken({
  keyId,
  issuerId,
  privateKey,
  now = Date.now,
}) {
  assertNonEmpty(keyId, 'App Store Connect key ID');
  assertNonEmpty(issuerId, 'App Store Connect issuer ID');
  assertNonEmpty(privateKey, 'App Store Connect private key');

  const issuedAt = Math.floor(now() / 1_000);
  const encodedHeader = base64url(
    JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }),
  );
  const encodedClaims = base64url(
    JSON.stringify({
      iss: issuerId,
      iat: issuedAt,
      exp: issuedAt + TOKEN_LIFETIME_SECONDS,
      aud: 'appstoreconnect-v1',
    }),
  );
  const signingInput = `${encodedHeader}.${encodedClaims}`;

  try {
    const signature = sign('sha256', Buffer.from(signingInput), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    if (signature.length !== 64) {
      throw new Error('Unexpected ES256 signature size');
    }
    return `${signingInput}.${signature.toString('base64url')}`;
  } catch {
    throw new Error('Unable to create App Store Connect token');
  }
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createAppStoreConnectClient({
  fetch: fetchImpl = globalThis.fetch,
  token,
  baseUrl = API_ROOT,
  now = Date.now,
  sleep = defaultSleep,
  redactValues = [],
}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is required');
  assertNonEmpty(token, 'App Store Connect bearer token');
  const secrets = [token, ...redactValues];

  async function request(pathname, { method = 'GET', query, body } = {}) {
    const url = new URL(pathname, baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers = {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const requestLabel = `${redact(method, secrets)} ${redact(url.pathname, secrets)}`;

    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error(`App Store Connect ${requestLabel} request failed`);
    }

    const status = Number.isInteger(response.status) ? response.status : 'unknown';
    let text;
    try {
      text = await response.text();
    } catch {
      throw new Error(
        `App Store Connect ${requestLabel} response body could not be read (status ${status})`,
      );
    }
    let parsed;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        if (response.ok) {
          throw new Error(`App Store Connect ${requestLabel} response was not valid JSON`);
        }
      }
    }

    if (!response.ok) {
      throw new Error(`App Store Connect ${requestLabel} failed with status ${status}`);
    }
    return parsed;
  }

  return { request, now, sleep };
}

function resourceList(response, label) {
  if (!response || typeof response !== 'object' || !Array.isArray(response.data)) {
    throw new Error(`App Store Connect returned an invalid ${label} response`);
  }
  return response.data;
}

function exactResource(resources, resource) {
  if (resources.length !== 1) throw new ExactLookupError(resource, resources.length);
  return resources[0];
}

function relationshipId(resource, name, expectedType) {
  const linkage = resource?.relationships?.[name]?.data;
  if (
    !linkage ||
    Array.isArray(linkage) ||
    linkage.type !== expectedType ||
    typeof linkage.id !== 'string'
  ) {
    return undefined;
  }
  return linkage.id;
}

function assertResource(resource, type) {
  if (!resource || resource.type !== type || typeof resource.id !== 'string') {
    throw new Error(`App Store Connect ${type} response identity mismatch`);
  }
}

function requiredIncluded(response, expectedTypes) {
  if (
    !response ||
    typeof response !== 'object' ||
    !Array.isArray(response.included) ||
    response.included.length !== expectedTypes.length
  ) {
    throw new Error('App Store Connect included response identity mismatch');
  }

  return expectedTypes.map((type) => {
    const matches = response.included.filter((resource) => resource?.type === type);
    if (matches.length !== 1) {
      throw new Error('App Store Connect included response identity mismatch');
    }
    const [resource] = matches;
    assertResource(resource, type);
    return resource;
  });
}

export async function findExactBuild(client, { bundleId, version, buildNumber }) {
  const appResponse = await client.request('/v1/apps', {
    query: {
      'filter[bundleId]': bundleId,
      'fields[apps]': 'bundleId,name',
      limit: 2,
    },
  });
  const app = exactResource(resourceList(appResponse, 'apps'), 'app');
  assertResource(app, 'apps');
  if (app.attributes?.bundleId !== bundleId) {
    throw new Error('App Store Connect app response identity mismatch');
  }

  const versionResponse = await client.request('/v1/preReleaseVersions', {
    query: {
      'filter[app]': app.id,
      'filter[version]': version,
      'filter[platform]': 'IOS',
      'fields[preReleaseVersions]': 'version,platform,app',
      'fields[apps]': 'bundleId',
      include: 'app',
      limit: 2,
    },
  });
  const prereleaseVersion = exactResource(
    resourceList(versionResponse, 'prerelease versions'),
    'version',
  );
  assertResource(prereleaseVersion, 'preReleaseVersions');
  if (
    prereleaseVersion.attributes?.version !== version ||
    prereleaseVersion.attributes?.platform !== 'IOS' ||
    relationshipId(prereleaseVersion, 'app', 'apps') !== app.id
  ) {
    throw new Error('App Store Connect prerelease version response identity mismatch');
  }
  const [versionIncludedApp] = requiredIncluded(versionResponse, ['apps']);
  if (
    versionIncludedApp.id !== app.id ||
    versionIncludedApp.attributes?.bundleId !== bundleId
  ) {
    throw new Error('App Store Connect included app response identity mismatch');
  }

  const buildResponse = await client.request('/v1/builds', {
    query: {
      'filter[preReleaseVersion]': prereleaseVersion.id,
      'filter[version]': buildNumber,
      'fields[builds]': 'version,processingState,app,preReleaseVersion',
      'fields[apps]': 'bundleId',
      'fields[preReleaseVersions]': 'version,platform,app',
      include: 'app,preReleaseVersion',
      limit: 2,
    },
  });
  const build = exactResource(resourceList(buildResponse, 'builds'), 'build');
  assertResource(build, 'builds');
  if (
    build.attributes?.version !== buildNumber ||
    relationshipId(build, 'app', 'apps') !== app.id ||
    relationshipId(build, 'preReleaseVersion', 'preReleaseVersions') !== prereleaseVersion.id
  ) {
    throw new Error('App Store Connect build response identity mismatch');
  }
  const [buildIncludedApp, buildIncludedVersion] = requiredIncluded(buildResponse, [
    'apps',
    'preReleaseVersions',
  ]);
  if (
    buildIncludedApp.id !== app.id ||
    buildIncludedApp.attributes?.bundleId !== bundleId ||
    buildIncludedVersion.id !== prereleaseVersion.id ||
    buildIncludedVersion.attributes?.version !== version ||
    buildIncludedVersion.attributes?.platform !== 'IOS' ||
    relationshipId(buildIncludedVersion, 'app', 'apps') !== app.id
  ) {
    throw new Error('App Store Connect included build response identity mismatch');
  }
  return build;
}

function publicBuild(resource) {
  return {
    id: resource.id,
    version: resource.attributes?.version,
    processingState: resource.attributes?.processingState,
  };
}

export async function waitForBuild(
  client,
  {
    bundleId,
    version,
    buildNumber,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  },
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('timeoutMs must be a positive number');
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error('pollIntervalMs must be a positive number');
  }

  const startedAt = client.now();
  const deadline = startedAt + timeoutMs;
  let firstLookup = true;
  while (true) {
    let resource;
    let lookupError;
    if (!firstLookup && client.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for App Store Connect build`);
    }
    firstLookup = false;
    try {
      resource = await findExactBuild(client, { bundleId, version, buildNumber });
    } catch (error) {
      lookupError = error;
    }

    if (client.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for App Store Connect build`);
    }
    if (lookupError) {
      if (
        !(lookupError instanceof ExactLookupError) ||
        lookupError.count !== 0 ||
        lookupError.resource === 'app'
      ) {
        throw lookupError;
      }
    }

    if (resource) {
      const build = publicBuild(resource);
      if (build.processingState === 'VALID') return build;
      if (build.processingState === 'FAILED' || build.processingState === 'INVALID') {
        throw new Error(`App Store Connect build entered ${build.processingState}`);
      }
      if (build.processingState !== 'PROCESSING') {
        throw new Error('App Store Connect build has unexpected processing state');
      }
    }

    const remaining = deadline - client.now();
    if (remaining <= 0) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for App Store Connect build`);
    }
    await client.sleep(Math.min(pollIntervalMs, remaining));
  }
}

function assertReleaseSha(releaseSha) {
  if (!/^[0-9a-f]{40}$/i.test(releaseSha)) {
    throw new Error('releaseSha must be a 40-hex commit SHA');
  }
}

export function normalizeTestFlightNotes(notes, releaseSha) {
  assertReleaseSha(releaseSha);
  if (typeof notes !== 'string') throw new Error('TestFlight notes must be a string');
  const sourceLine = `${SOURCE_COMMIT_PREFIX}${releaseSha}`;
  const body = notes
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(SOURCE_COMMIT_PREFIX))
    .join('\n')
    .trim();
  const normalized = body.length > 0 ? `${body}\n\n${sourceLine}` : sourceLine;
  if (normalized.length > MAX_NOTES_LENGTH) {
    throw new Error(`TestFlight notes exceed 4,000 characters after adding provenance`);
  }
  return normalized;
}

function localizationFromResource(resource) {
  assertResource(resource, 'betaBuildLocalizations');
  const { locale, whatsNew } = resource.attributes ?? {};
  if (typeof locale !== 'string' || typeof whatsNew !== 'string') {
    throw new Error('App Store Connect beta localization response identity mismatch');
  }
  return { id: resource.id, locale, whatsNew };
}

async function listBetaBuildLocalizations(client, buildId, locale) {
  const response = await client.request(
    `/v1/builds/${encodeURIComponent(buildId)}/betaBuildLocalizations`,
    {
      query: {
        'fields[betaBuildLocalizations]': 'locale,whatsNew',
        limit: 200,
      },
    },
  );
  const resources = resourceList(response, 'beta build localizations');
  const matches = resources.filter((resource) => resource.attributes?.locale === locale);
  if (matches.length > 1) {
    throw new Error(`Expected at most one ${locale} beta build localization; found ${matches.length}`);
  }
  return matches.map(localizationFromResource);
}

export async function upsertBetaBuildLocalization(
  client,
  { buildId, locale = 'en-US', whatsNew },
) {
  if (typeof whatsNew !== 'string' || whatsNew.length > MAX_NOTES_LENGTH) {
    throw new Error('Beta build localization whatsNew must be at most 4,000 characters');
  }
  const [existing] = await listBetaBuildLocalizations(client, buildId, locale);
  let response;
  if (existing) {
    response = await client.request(
      `/v1/betaBuildLocalizations/${encodeURIComponent(existing.id)}`,
      {
        method: 'PATCH',
        body: {
          data: {
            type: 'betaBuildLocalizations',
            id: existing.id,
            attributes: { whatsNew },
          },
        },
      },
    );
  } else {
    response = await client.request('/v1/betaBuildLocalizations', {
      method: 'POST',
      body: {
        data: {
          type: 'betaBuildLocalizations',
          attributes: { locale, whatsNew },
          relationships: {
            build: { data: { type: 'builds', id: buildId } },
          },
        },
      },
    });
  }

  const localization = localizationFromResource(response?.data);
  if (localization.locale !== locale || localization.whatsNew !== whatsNew) {
    throw new Error('App Store Connect beta localization response identity mismatch');
  }
  return localization;
}

function hasExactProvenance(whatsNew, releaseSha) {
  const sourceLines = whatsNew
    .split(/\r?\n/)
    .filter((line) => line.startsWith(SOURCE_COMMIT_PREFIX));
  return (
    sourceLines.length === 1 &&
    sourceLines[0] === `${SOURCE_COMMIT_PREFIX}${releaseSha}`
  );
}

export async function waitAndLocalize(
  client,
  {
    bundleId,
    version,
    buildNumber,
    locale = 'en-US',
    notes,
    releaseSha,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    reuseExisting = false,
  },
) {
  assertReleaseSha(releaseSha);
  if (reuseExisting) {
    const build = publicBuild(
      await findExactBuild(client, { bundleId, version, buildNumber }),
    );
    if (build.processingState !== 'VALID') {
      throw new Error('Reuse requires an existing VALID App Store Connect build');
    }
    const localizations = await listBetaBuildLocalizations(client, build.id, locale);
    if (localizations.length !== 1) {
      throw new Error(`Reuse requires exactly one existing ${locale} localization with provenance`);
    }
    const [localization] = localizations;
    if (!hasExactProvenance(localization.whatsNew, releaseSha)) {
      throw new Error('Existing beta build localization provenance does not match release SHA');
    }
    return { build, localization, reused: true };
  }

  const build = await waitForBuild(client, {
    bundleId,
    version,
    buildNumber,
    timeoutMs,
  });
  const whatsNew = normalizeTestFlightNotes(notes, releaseSha);
  const localization = await upsertBetaBuildLocalization(client, {
    buildId: build.id,
    locale,
    whatsNew,
  });
  return { build, localization, reused: false };
}

const USAGE = 'Usage: node scripts/app-store-connect.mjs wait-and-localize --bundle-id ID --version VERSION --build-number NUMBER --locale LOCALE --notes-file PATH --release-sha SHA --timeout-seconds SECONDS [--reuse-existing]';

function parseCli(argv) {
  if (argv[0] !== 'wait-and-localize') throw new Error(USAGE);
  const values = {};
  const known = new Map([
    ['--bundle-id', 'bundleId'],
    ['--version', 'version'],
    ['--build-number', 'buildNumber'],
    ['--locale', 'locale'],
    ['--notes-file', 'notesFile'],
    ['--release-sha', 'releaseSha'],
    ['--timeout-seconds', 'timeoutSeconds'],
  ]);

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--reuse-existing') {
      if (values.reuseExisting) throw new Error(USAGE);
      values.reuseExisting = true;
      continue;
    }
    const key = known.get(argument);
    const value = argv[index + 1];
    if (!key || value === undefined || value.startsWith('--') || values[key] !== undefined) {
      throw new Error(USAGE);
    }
    values[key] = value;
    index += 1;
  }

  for (const key of known.values()) {
    if (typeof values[key] !== 'string' || values[key].length === 0) throw new Error(USAGE);
  }
  const timeoutSeconds = Number(values.timeoutSeconds);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error(USAGE);
  return {
    ...values,
    timeoutMs: timeoutSeconds * 1_000,
    reuseExisting: values.reuseExisting === true,
  };
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const keyId = process.env.APP_STORE_CONNECT_KEY_ID;
  const issuerId = process.env.APP_STORE_CONNECT_ISSUER_ID;
  const privateKeyPath = process.env.APP_STORE_CONNECT_PRIVATE_KEY_PATH;
  if (!keyId || !issuerId || !privateKeyPath) {
    throw new Error(
      'APP_STORE_CONNECT_KEY_ID, APP_STORE_CONNECT_ISSUER_ID, and APP_STORE_CONNECT_PRIVATE_KEY_PATH are required',
    );
  }

  let privateKey;
  let notes;
  try {
    [privateKey, notes] = await Promise.all([
      readFile(privateKeyPath, 'utf8'),
      readFile(options.notesFile, 'utf8'),
    ]);
  } catch {
    throw new Error('Unable to read App Store Connect private key or TestFlight notes file');
  }
  const token = createAppStoreConnectToken({ keyId, issuerId, privateKey });
  const client = createAppStoreConnectClient({
    token,
    redactValues: [privateKey],
  });
  const result = await waitAndLocalize(client, {
    bundleId: options.bundleId,
    version: options.version,
    buildNumber: options.buildNumber,
    locale: options.locale,
    notes,
    releaseSha: options.releaseSha,
    timeoutMs: options.timeoutMs,
    reuseExisting: options.reuseExisting,
  });
  console.log(
    `${result.reused ? 'Reused' : 'Verified'} build ${result.build.version}: ${result.build.processingState}; ${result.localization.locale} localization verified`,
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(asMessage(error));
    process.exitCode = 1;
  });
}
