import type { GitHubRepositoryRef } from './types.js';

export interface GitHubRemote {
  name: string;
  rawUrl: string;
  repository: GitHubRepositoryRef;
}

const ASCII_CONTROL = /[\u0000-\u001f\u007f]/;
const ASCII_REMOTE_NAME_INVALID = /[\u0000-\u0020\u007f]/;
const AUTHORITY_WHITESPACE_OR_CONTROL = /[\p{White_Space}\p{Control}]/u;
const PATH_WHITESPACE_OR_CONTROL = /[\p{White_Space}\p{Control}]/u;

interface ParsedAuthority {
  explicitPort: string | null;
  userinfo: string | null;
}

interface ParsedUrlRemote {
  authority: ParsedAuthority;
  url: URL;
}

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

export function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

export function isValidGitRemoteName(name: string): boolean {
  return name.length > 0 && !ASCII_REMOTE_NAME_INVALID.test(name);
}

function normalizeRemoteName(name: string): string | null {
  if (!isValidGitRemoteName(name)) {
    return null;
  }

  return name;
}

function isValidRawUrl(rawUrl: string): boolean {
  return rawUrl.length > 0 && rawUrl === rawUrl.trim() && !ASCII_CONTROL.test(rawUrl);
}

function parseHttpsRemote(rawUrl: string): GitHubRepositoryRef | null {
  const parsed = parseUrlRemote(rawUrl, 'https:');
  if (!parsed || parsed.authority.userinfo !== null || parsed.url.username || parsed.url.password) {
    return null;
  }

  const hostname = normalizeCanonicalHostname(parsed.url.hostname);
  if (!isGitHubCliHostname(hostname)) {
    return null;
  }

  const repositoryPath = parseRepositoryPath(parsed.url.pathname);
  if (!repositoryPath) {
    return null;
  }

  if (parsed.authority.explicitPort !== null && parsed.authority.explicitPort !== '443') {
    return null;
  }

  return buildRepositoryRef(hostname, repositoryPath.owner, repositoryPath.name);
}

function parseScpLikeSshRemote(rawUrl: string): GitHubRepositoryRef | null {
  const match = /^git@([^:/\\@[\]\s?#]+):([^?#]+)$/u.exec(rawUrl);
  if (!match) {
    return null;
  }

  const [, rawHost, rawPath] = match;
  const host = canonicalizeScpHost(rawHost);
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
  const parsed = parseUrlRemote(rawUrl, 'ssh:');
  if (!parsed) {
    return null;
  }

  if (
    parsed.authority.userinfo !== 'git'
    || parsed.url.username !== 'git'
    || parsed.url.password
  ) {
    return null;
  }

  const hostname = normalizeCanonicalHostname(parsed.url.hostname);
  if (!isGitHubCliHostname(hostname)) {
    return null;
  }

  const repositoryPath = parseRepositoryPath(parsed.url.pathname);
  if (!repositoryPath) {
    return null;
  }

  if (hostname === 'github.com') {
    if (parsed.authority.explicitPort !== null && parsed.authority.explicitPort !== '22') {
      return null;
    }

    return buildRepositoryRef('github.com', repositoryPath.owner, repositoryPath.name);
  }

  if (hostname === 'ssh.github.com') {
    if (parsed.authority.explicitPort !== '443') {
      return null;
    }

    return buildRepositoryRef('github.com', repositoryPath.owner, repositoryPath.name);
  }

  return buildRepositoryRef(hostname, repositoryPath.owner, repositoryPath.name);
}

function parseUrlRemote(rawUrl: string, protocol: 'https:' | 'ssh:'): ParsedUrlRemote | null {
  if (rawUrl.includes('\\')) {
    return null;
  }

  const rawAuthority = extractRawAuthority(rawUrl);
  if (rawAuthority === null) {
    return null;
  }

  const authority = parseAuthority(rawAuthority);
  if (!authority) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol !== protocol || url.search || url.hash || !url.pathname.startsWith('/')) {
    return null;
  }

  if (!url.hostname) {
    return null;
  }

  return { authority, url };
}

function extractRawAuthority(rawUrl: string): string | null {
  const schemeIndex = rawUrl.indexOf('://');
  if (schemeIndex < 0) {
    return null;
  }

  const pathStart = rawUrl.indexOf('/', schemeIndex + 3);
  if (pathStart < 0) {
    return null;
  }

  return rawUrl.slice(schemeIndex + 3, pathStart);
}

function parseAuthority(rawAuthority: string): ParsedAuthority | null {
  if (!rawAuthority || rawAuthority.includes('%') || AUTHORITY_WHITESPACE_OR_CONTROL.test(rawAuthority)) {
    return null;
  }

  let userinfo: string | null = null;
  let hostAndPort = rawAuthority;

  const atIndex = rawAuthority.indexOf('@');
  if (atIndex >= 0) {
    if (atIndex !== rawAuthority.lastIndexOf('@')) {
      return null;
    }

    userinfo = rawAuthority.slice(0, atIndex);
    hostAndPort = rawAuthority.slice(atIndex + 1);
    if (!userinfo || !hostAndPort) {
      return null;
    }
  }

  const parsedHost = parseHostAndPort(hostAndPort);
  if (!parsedHost) {
    return null;
  }

  return {
    explicitPort: parsedHost.port,
    userinfo,
  };
}

function parseHostAndPort(hostAndPort: string): { host: string; port: string | null } | null {
  if (!hostAndPort || AUTHORITY_WHITESPACE_OR_CONTROL.test(hostAndPort)) {
    return null;
  }

  if (hostAndPort.startsWith('[')) {
    const closingBracket = hostAndPort.indexOf(']');
    if (closingBracket < 0) {
      return null;
    }

    const host = hostAndPort.slice(0, closingBracket + 1);
    const remainder = hostAndPort.slice(closingBracket + 1);
    if (!host || host.includes('@')) {
      return null;
    }

    if (!remainder) {
      return { host, port: null };
    }

    if (!remainder.startsWith(':')) {
      return null;
    }

    const port = remainder.slice(1);
    if (!isCanonicalPort(port)) {
      return null;
    }

    return { host, port };
  }

  if (hostAndPort.includes('[') || hostAndPort.includes(']')) {
    return null;
  }

  const firstColon = hostAndPort.indexOf(':');
  const lastColon = hostAndPort.lastIndexOf(':');
  if (firstColon !== -1 && firstColon !== lastColon) {
    return null;
  }

  if (firstColon < 0) {
    return hostAndPort ? { host: hostAndPort, port: null } : null;
  }

  const host = hostAndPort.slice(0, firstColon);
  const port = hostAndPort.slice(firstColon + 1);
  if (!host || !isCanonicalPort(port)) {
    return null;
  }

  return { host, port };
}

function canonicalizeScpHost(rawHost: string): string | null {
  if (
    !rawHost
    || rawHost.includes('%')
    || rawHost.includes(':')
    || rawHost.includes('/')
    || rawHost.includes('@')
    || rawHost.includes('[')
    || rawHost.includes(']')
    || rawHost.includes('\\')
    || AUTHORITY_WHITESPACE_OR_CONTROL.test(rawHost)
  ) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(`ssh://git@${rawHost}/repo`);
  } catch {
    return null;
  }

  if (url.username !== 'git' || url.password || !url.hostname) {
    return null;
  }

  const hostname = normalizeCanonicalHostname(url.hostname);
  if (!isGitHubCliHostname(hostname) || hostname === 'ssh.github.com') {
    return null;
  }

  return hostname;
}

function isCanonicalPort(rawPort: string): boolean {
  if (!/^[1-9][0-9]*$/u.test(rawPort)) {
    return false;
  }

  const port = Number(rawPort);
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function normalizeCanonicalHostname(hostname: string): string {
  return hostname.toLowerCase();
}

function isGitHubCliHostname(hostname: string): boolean {
  return hostname.length > 0 && !hostname.startsWith('[') && !hostname.includes(':');
}

function parseRepositoryPath(rawPath: string): { owner: string; name: string } | null {
  if (!rawPath.startsWith('/')) {
    return null;
  }

  const segments = rawPath.split('/');
  if (segments.length !== 3 || segments[0] !== '') {
    return null;
  }

  const owner = decodeRepositorySegment(segments[1], false);
  const name = decodeRepositorySegment(segments[2], true);
  if (!owner || !name) {
    return null;
  }

  return { owner, name };
}

function decodeRepositorySegment(rawSegment: string, stripGitSuffix: boolean): string | null {
  if (!rawSegment) {
    return null;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(rawSegment);
  } catch {
    return null;
  }

  if (!decoded || decoded === '.' || decoded === '..' || hasInvalidDecodedPathContent(decoded)) {
    return null;
  }

  if (!stripGitSuffix) {
    return decoded;
  }

  if (decoded === '.git' || decoded.endsWith('.git.git')) {
    return null;
  }

  const withoutGitSuffix = decoded.endsWith('.git') ? decoded.slice(0, -4) : decoded;
  if (!withoutGitSuffix || withoutGitSuffix === '.' || withoutGitSuffix === '..') {
    return null;
  }

  return hasInvalidDecodedPathContent(withoutGitSuffix) ? null : withoutGitSuffix;
}

function hasInvalidDecodedPathContent(value: string): boolean {
  return value.includes('/') || value.includes('\\') || PATH_WHITESPACE_OR_CONTROL.test(value);
}

function buildRepositoryRef(host: string, owner: string, name: string): GitHubRepositoryRef {
  return {
    host,
    owner,
    name,
    url: `https://${host}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
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

    return compareText(left.name, right.name);
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
