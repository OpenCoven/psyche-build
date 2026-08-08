import type { GitHubRepositoryRef } from './types.js';

export interface GitHubRemote {
  name: string;
  rawUrl: string;
  repository: GitHubRepositoryRef;
}

const ASCII_CONTROL = /[\u0000-\u001f\u007f]/;

export function normalizeGitHubRemote(name: string, rawUrl: string): GitHubRemote | null {
  const normalizedName = normalizeRemoteName(name);
  if (!normalizedName) {
    return null;
  }

  if (!isValidRawUrl(rawUrl)) {
    return null;
  }

  const repository =
    parseHttpsRemote(rawUrl) ?? parseScpLikeSshRemote(rawUrl) ?? parseSshRemote(rawUrl);

  if (!repository) {
    return null;
  }

  return {
    name: normalizedName,
    rawUrl,
    repository,
  };
}

export function orderGitHubRemotes(
  remotes: readonly GitHubRemote[],
  upstreamRemote: string | null,
): GitHubRemote[] {
  return orderNamedEntries(remotes, upstreamRemote);
}

function normalizeRemoteName(name: string): string | null {
  if (ASCII_CONTROL.test(name)) {
    return null;
  }

  const trimmed = name.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed;
}

function isValidRawUrl(rawUrl: string): boolean {
  return rawUrl.length > 0 && rawUrl === rawUrl.trim() && !ASCII_CONTROL.test(rawUrl);
}

function parseHttpsRemote(rawUrl: string): GitHubRepositoryRef | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    return null;
  }

  const host = parsed.host.toLowerCase();
  if (!host || (parsed.port && parsed.hostname.toLowerCase() === 'github.com')) {
    return null;
  }

  const rawPath = extractRawPath(rawUrl);
  if (!rawPath) {
    return null;
  }

  const repositoryPath = parseRepositoryPath(rawPath);
  if (!repositoryPath) {
    return null;
  }

  return buildRepositoryRef(host, repositoryPath.owner, repositoryPath.name);
}

function parseScpLikeSshRemote(rawUrl: string): GitHubRepositoryRef | null {
  const match = /^([^@]+)@([^:/?#\s[\]]+):([^?#]+)$/.exec(rawUrl);
  if (!match) {
    return null;
  }

  const [, username, rawHost, rawPath] = match;
  if (username !== 'git') {
    return null;
  }

  const host = rawHost.toLowerCase();
  if (!host) {
    return null;
  }

  const repositoryPath = parseRepositoryPath(`/${rawPath}`);
  if (!repositoryPath) {
    return null;
  }

  return buildRepositoryRef(host, repositoryPath.owner, repositoryPath.name);
}

function parseSshRemote(rawUrl: string): GitHubRepositoryRef | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (
    parsed.protocol !== 'ssh:'
    || parsed.username !== 'git'
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    return null;
  }

  const host = parsed.host.toLowerCase();
  if (!host || (parsed.port && parsed.hostname.toLowerCase() === 'github.com')) {
    return null;
  }

  const rawPath = extractRawPath(rawUrl);
  if (!rawPath) {
    return null;
  }

  const repositoryPath = parseRepositoryPath(rawPath);
  if (!repositoryPath) {
    return null;
  }

  return buildRepositoryRef(host, repositoryPath.owner, repositoryPath.name);
}

function extractRawPath(rawUrl: string): string | null {
  const protocolIndex = rawUrl.indexOf('//');
  if (protocolIndex < 0) {
    return null;
  }

  const pathStart = rawUrl.indexOf('/', protocolIndex + 2);
  if (pathStart < 0) {
    return null;
  }

  return rawUrl.slice(pathStart);
}

function parseRepositoryPath(rawPath: string): { owner: string; name: string } | null {
  if (!rawPath.startsWith('/')) {
    return null;
  }

  const segments = rawPath.split('/');
  if (segments.length !== 3 || segments[0] !== '') {
    return null;
  }

  const owner = parsePathSegment(segments[1]);
  const name = parseRepositoryNameSegment(segments[2]);
  if (!owner || !name) {
    return null;
  }

  return { owner, name };
}

function parsePathSegment(rawSegment: string): string | null {
  if (!rawSegment) {
    return null;
  }

  const decoded = decodePathSegment(rawSegment);
  if (!decoded || decoded === '.' || decoded === '..') {
    return null;
  }

  return rawSegment;
}

function parseRepositoryNameSegment(rawSegment: string): string | null {
  if (!rawSegment || rawSegment === '.git' || rawSegment.endsWith('.git.git')) {
    return null;
  }

  const withoutGitSuffix = rawSegment.endsWith('.git') ? rawSegment.slice(0, -4) : rawSegment;
  if (!withoutGitSuffix) {
    return null;
  }

  const decoded = decodePathSegment(withoutGitSuffix);
  if (!decoded || decoded === '.' || decoded === '..') {
    return null;
  }

  return withoutGitSuffix;
}

function decodePathSegment(rawSegment: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawSegment);
  } catch {
    return null;
  }

  if (!decoded || decoded.includes('/') || decoded.includes('\\')) {
    return null;
  }

  return decoded;
}

function buildRepositoryRef(host: string, owner: string, name: string): GitHubRepositoryRef {
  return {
    host,
    owner,
    name,
    url: `https://${host}/${owner}/${name}`,
  };
}

function orderNamedEntries<T extends { name: string }>(
  entries: readonly T[],
  upstreamRemote: string | null,
): T[] {
  const deduped = new Map<string, T>();
  for (const entry of entries) {
    if (!deduped.has(entry.name)) {
      deduped.set(entry.name, entry);
    }
  }

  const hasUpstream = upstreamRemote !== null && deduped.has(upstreamRemote);

  return Array.from(deduped.values()).sort((left, right) => {
    const priorityDiff = remotePriority(left.name, upstreamRemote, hasUpstream)
      - remotePriority(right.name, upstreamRemote, hasUpstream);

    if (priorityDiff !== 0) {
      return priorityDiff;
    }

    return left.name.localeCompare(right.name);
  });
}

function remotePriority(name: string, upstreamRemote: string | null, hasUpstream: boolean): number {
  if (hasUpstream && name === upstreamRemote) {
    return 0;
  }

  if (name === 'origin') {
    return hasUpstream && upstreamRemote !== 'origin' ? 1 : 0;
  }

  return 2;
}
