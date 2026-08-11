import {
  compareText,
  hasUnsafeUnicodeTextCharacter,
  isValidGitRemoteName,
  normalizeGitHubRemote,
  orderGitHubRemotes,
  type GitHubRemote,
} from './remotes.js';

export interface ReadOnlyCommandRunner {
  run(
    command: string,
    args: readonly string[],
    options: { cwd: string; allowFailure?: boolean },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface RawGitRemote {
  name: string;
  url: string;
}

export interface RepositoryContext {
  worktreePath: string;
  branch: string | null;
  upstreamRemote: string | null;
  rawRemotes: readonly RawGitRemote[];
  remotes: readonly GitHubRemote[];
}

const ASCII_CONTROL = /[\u0000-\u001f\u007f]/;
const ASCII_WHITESPACE_OR_CONTROL = /[\u0000-\u0020\u007f]/;
const ASCII_EDGE_WHITESPACE = /^[\u0009-\u000d\u0020]|[\u0009-\u000d\u0020]$/u;
const REDACTED_REMOTE_URL = '<redacted-remote-url>';
const REPOSITORY_CONTEXT_ERROR = 'unable to read Git repository context';

export async function readRepositoryContext(
  worktreePath: string,
  runner: ReadOnlyCommandRunner,
): Promise<RepositoryContext> {
  if (!isValidWorktreePath(worktreePath)) {
    throw new Error(REPOSITORY_CONTEXT_ERROR);
  }

  const branch = await readCurrentBranch(worktreePath, runner);
  const upstreamRemote = branch ? await readBranchRemote(worktreePath, branch, runner) : null;
  const remoteNames = await readRemoteNames(worktreePath, runner);

  const rawRemotes: RawGitRemote[] = [];
  const normalizedRemotes: GitHubRemote[] = [];

  for (const remoteName of remoteNames) {
    const remoteUrl = await readRemoteUrl(worktreePath, remoteName, runner);
    if (remoteUrl === null) {
      continue;
    }

    const normalized = normalizeGitHubRemote(remoteName, remoteUrl);
    rawRemotes.push({
      name: remoteName,
      url: summarizeDiagnosticRemoteUrl(remoteUrl, normalized),
    });

    if (normalized) {
      normalizedRemotes.push(normalized);
    }
  }

  return {
    worktreePath,
    branch,
    upstreamRemote,
    rawRemotes: orderNamedEntries(rawRemotes, upstreamRemote),
    remotes: orderGitHubRemotes(normalizedRemotes, upstreamRemote),
  };
}

function isValidWorktreePath(worktreePath: string): boolean {
  return typeof worktreePath === 'string' && worktreePath.length > 0 && !worktreePath.includes('\0');
}

async function readCurrentBranch(
  worktreePath: string,
  runner: ReadOnlyCommandRunner,
): Promise<string | null> {
  const stdout = await runRequiredGitCommand(worktreePath, runner, ['branch', '--show-current']);
  const branch = parseRequiredValue(stdout);

  if (branch === null) {
    return null;
  }

  return branch;
}

async function readRemoteNames(
  worktreePath: string,
  runner: ReadOnlyCommandRunner,
): Promise<string[]> {
  const stdout = await runRequiredGitCommand(worktreePath, runner, ['remote']);
  const remoteNames: string[] = [];
  const seen = new Set<string>();

  for (const line of splitGitOutputLines(stdout)) {
    if (!line) {
      continue;
    }

    if (!isValidRemoteName(line)) {
      throw new Error(REPOSITORY_CONTEXT_ERROR);
    }

    if (!seen.has(line)) {
      seen.add(line);
      remoteNames.push(line);
    }
  }

  return remoteNames;
}

async function readBranchRemote(
  worktreePath: string,
  branch: string,
  runner: ReadOnlyCommandRunner,
): Promise<string | null> {
  try {
    const result = await runner.run('git', ['config', `branch.${branch}.remote`], {
      cwd: worktreePath,
      allowFailure: true,
    });

    if (result.exitCode !== 0) {
      return null;
    }

    const remoteName = parseOptionalValue(result.stdout);
    if (remoteName === null) {
      return null;
    }

    if (!isValidRemoteName(remoteName)) {
      throw new Error(REPOSITORY_CONTEXT_ERROR);
    }

    return remoteName;
  } catch (error) {
    if (error instanceof Error && error.message === REPOSITORY_CONTEXT_ERROR) {
      throw error;
    }

    return null;
  }
}

async function readRemoteUrl(
  worktreePath: string,
  remoteName: string,
  runner: ReadOnlyCommandRunner,
): Promise<string | null> {
  try {
    const result = await runner.run('git', ['remote', 'get-url', '--', remoteName], {
      cwd: worktreePath,
      allowFailure: true,
    });

    if (result.exitCode !== 0) {
      return null;
    }

    return parseRemoteUrlOutput(result.stdout);
  } catch {
    return null;
  }
}

async function runRequiredGitCommand(
  worktreePath: string,
  runner: ReadOnlyCommandRunner,
  args: readonly string[],
): Promise<string> {
  try {
    const result = await runner.run('git', args, { cwd: worktreePath });
    if (result.exitCode !== 0) {
      throw new Error('git read failed');
    }

    return result.stdout;
  } catch {
    throw new Error(REPOSITORY_CONTEXT_ERROR);
  }
}

function isValidRemoteName(name: string): boolean {
  return isValidGitRemoteName(name);
}

function parseRequiredValue(stdout: string): string | null {
  const value = stripSingleTrailingLineTerminator(stdout);
  if (!value) {
    return null;
  }

  if (hasInvalidGitDerivedName(value)) {
    throw new Error(REPOSITORY_CONTEXT_ERROR);
  }

  return value;
}

function parseOptionalValue(stdout: string): string | null {
  const value = stripSingleTrailingLineTerminator(stdout);
  if (!value) {
    return null;
  }

  if (hasInvalidGitDerivedName(value)) {
    throw new Error(REPOSITORY_CONTEXT_ERROR);
  }

  return value;
}

function parseRemoteUrlOutput(stdout: string): string | null {
  const value = stripSingleTrailingLineTerminator(stdout);
  if (!value || ASCII_EDGE_WHITESPACE.test(value) || ASCII_CONTROL.test(value)) {
    return null;
  }

  return value;
}

function splitGitOutputLines(stdout: string): string[] {
  return stdout.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

function stripSingleTrailingLineTerminator(value: string): string {
  if (value.endsWith('\r\n')) {
    return value.slice(0, -2);
  }

  if (value.endsWith('\n')) {
    return value.slice(0, -1);
  }

  return value;
}

function sanitizeDiagnosticRemoteUrl(remoteUrl: string): string {
  if (isNestedHelperRemote(remoteUrl) || isExplicitlySecretBearing(remoteUrl)) {
    return REDACTED_REMOTE_URL;
  }

  const scpDiagnostic = sanitizeScpDiagnostic(remoteUrl);
  if (scpDiagnostic !== null) {
    return scpDiagnostic;
  }

  const sanitizedFileUrl = sanitizeFileDiagnostic(remoteUrl);
  if (sanitizedFileUrl !== null) {
    return sanitizedFileUrl;
  }

  const sanitizedSchemeUrl = sanitizeNetworkSchemeDiagnostic(remoteUrl);
  if (sanitizedSchemeUrl !== null) {
    return sanitizedSchemeUrl;
  }

  if (
    remoteUrl.includes('?')
    || remoteUrl.includes('#')
    || looksCredentialBearing(remoteUrl)
    || looksLikeUnsupportedScp(remoteUrl)
  ) {
    return REDACTED_REMOTE_URL;
  }

  return REDACTED_REMOTE_URL;
}

function summarizeDiagnosticRemoteUrl(
  remoteUrl: string,
  normalized: GitHubRemote | null,
): string {
  if (
    isNestedHelperRemote(remoteUrl)
    || isExplicitlySecretBearing(remoteUrl)
    || hasUnsafeUrlUserinfoOrAuthority(remoteUrl)
  ) {
    return REDACTED_REMOTE_URL;
  }

  if (normalized) {
    const normalizedSummary = summarizeNormalizedRemoteUrl(remoteUrl, normalized.repository.host);
    if (normalizedSummary !== null) {
      return normalizedSummary;
    }
  }

  return sanitizeDiagnosticRemoteUrl(remoteUrl);
}

function summarizeNormalizedRemoteUrl(remoteUrl: string, canonicalHost: string): string | null {
  if (remoteUrl.toLowerCase().startsWith('https://')) {
    return `https://${canonicalHost}/<redacted-path>`;
  }

  if (remoteUrl.toLowerCase().startsWith('ssh://')) {
    return `ssh://git@${canonicalHost}/<redacted-path>`;
  }

  if (remoteUrl.startsWith('git@')) {
    return `git@${canonicalHost}:<redacted-path>`;
  }

  return null;
}

function sanitizeScpDiagnostic(remoteUrl: string): string | null {
  const match = /^git@([^:/\\@[\]\s?#]+):([^?#]+)$/u.exec(remoteUrl);
  if (!match) {
    return /^[^/\s@]+@[^/\s:]+:/u.test(remoteUrl) ? REDACTED_REMOTE_URL : null;
  }

  const canonicalHost = canonicalizeDiagnosticHost(match[1]);
  if (!canonicalHost) {
    return REDACTED_REMOTE_URL;
  }

  return `git@${canonicalHost}:<redacted-path>`;
}

function sanitizeFileDiagnostic(remoteUrl: string): string | null {
  if (!remoteUrl.toLowerCase().startsWith('file:')) {
    return null;
  }

  if (!remoteUrl.startsWith('file://')) {
    return REDACTED_REMOTE_URL;
  }

  const rawParts = extractSchemeUrlParts(remoteUrl);
  if (rawParts === null || rawParts.authority !== '') {
    return REDACTED_REMOTE_URL;
  }

  const rawPath = extractRawPathFromSchemeSuffix(rawParts.suffix);
  if (!rawPath || !isSafeRawFilePath(rawPath)) {
    return REDACTED_REMOTE_URL;
  }

  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch {
    return REDACTED_REMOTE_URL;
  }

  if (url.protocol !== 'file:' || url.username || url.password || url.host) {
    return REDACTED_REMOTE_URL;
  }

  return `file://${serializeSafeFilePath(rawPath)}`;
}

function sanitizeNetworkSchemeDiagnostic(remoteUrl: string): string | null {
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/iu.exec(remoteUrl);
  if (!schemeMatch) {
    return null;
  }

  const scheme = schemeMatch[1].toLowerCase();
  if (!isNetworkScheme(scheme)) {
    return null;
  }

  if (hasUnsafeUrlUserinfoOrAuthority(remoteUrl)) {
    return REDACTED_REMOTE_URL;
  }

  if (!remoteUrl.startsWith(`${scheme}://`)) {
    return REDACTED_REMOTE_URL;
  }

  const rawParts = extractSchemeUrlParts(remoteUrl);
  if (rawParts === null) {
    return REDACTED_REMOTE_URL;
  }

  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch {
    return REDACTED_REMOTE_URL;
  }

  const canonicalHost = canonicalizeDiagnosticHost(rawParts.authority.includes('@')
    ? rawParts.authority.slice(rawParts.authority.lastIndexOf('@') + 1)
    : rawParts.authority);

  if (!canonicalHost || !url.host) {
    return REDACTED_REMOTE_URL;
  }

  if (
    remoteUrl.includes('@')
    && (
      !rawParts.authority.includes('@')
      || hasAtOutsideAuthority(remoteUrl, scheme)
      || hasAtOutsideAuthority(serializeSanitizedUrl(url), scheme)
    )
  ) {
    return REDACTED_REMOTE_URL;
  }

  if (remoteUrl.includes('?') || remoteUrl.includes('#') || isExplicitlySecretBearing(remoteUrl)) {
    return REDACTED_REMOTE_URL;
  }

  if (scheme === 'ssh') {
    return `ssh://git@${canonicalHost}/<redacted-path>`;
  }

  return `${scheme}://${canonicalHost}/<redacted-path>`;
}

function extractSchemeUrlParts(remoteUrl: string): { authority: string; suffix: string } | null {
  const schemeIndex = remoteUrl.indexOf('://');
  if (schemeIndex < 0) {
    return null;
  }

  const pathStart = remoteUrl.indexOf('/', schemeIndex + 3);
  if (pathStart < 0) {
    return {
      authority: remoteUrl.slice(schemeIndex + 3),
      suffix: '',
    };
  }

  return {
    authority: remoteUrl.slice(schemeIndex + 3, pathStart),
    suffix: remoteUrl.slice(pathStart),
  };
}

function extractRawPathFromSchemeSuffix(suffix: string): string | null {
  const queryIndex = suffix.indexOf('?');
  const fragmentIndex = suffix.indexOf('#');
  let pathEnd = suffix.length;

  if (queryIndex >= 0) {
    pathEnd = queryIndex;
  }

  if (fragmentIndex >= 0 && fragmentIndex < pathEnd) {
    pathEnd = fragmentIndex;
  }

  return suffix.slice(0, pathEnd);
}

function serializeSanitizedUrl(url: URL): string {
  const sanitized = new URL(url.toString());
  sanitized.username = '';
  sanitized.password = '';
  return `${sanitized.protocol}//${sanitized.host}${sanitized.pathname}${sanitized.search}${sanitized.hash}`;
}

function hasUnsafeUrlUserinfoOrAuthority(remoteUrl: string): boolean {
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/iu.exec(remoteUrl);
  if (!schemeMatch) {
    return false;
  }

  const scheme = schemeMatch[1].toLowerCase();
  if (!isNetworkScheme(scheme) || !remoteUrl.startsWith(`${scheme}://`)) {
    return false;
  }

  const rawParts = extractSchemeUrlParts(remoteUrl);
  if (rawParts === null) {
    return false;
  }

  const authority = rawParts.authority;
  if (authority.includes('*') || authority.includes('%') || hasUnsafeUnicodeTextCharacter(authority)) {
    return true;
  }

  const atIndex = authority.indexOf('@');
  if (atIndex < 0) {
    return false;
  }

  if (scheme !== 'ssh') {
    return true;
  }

  if (atIndex !== authority.lastIndexOf('@')) {
    return true;
  }

  return authority.slice(0, atIndex) !== 'git';
}

function isSafeRawFilePath(rawPath: string): boolean {
  if (!rawPath.startsWith('/') || rawPath.startsWith('//')) {
    return false;
  }

  const rawSegments = rawPath.split('/').slice(1);
  for (const rawSegment of rawSegments) {
    if (!isSafeRawFileSegment(rawSegment)) {
      return false;
    }
  }

  return true;
}

function isSafeRawFileSegment(rawSegment: string): boolean {
  if (rawSegment === '.' || rawSegment === '..') {
    return false;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(rawSegment);
  } catch {
    return false;
  }

  if (
    decoded === '.'
    || decoded === '..'
    || decoded.includes('/')
    || decoded.includes('\\')
    || hasUnsafeUnicodeTextCharacter(decoded)
  ) {
    return false;
  }

  return true;
}

function serializeSafeFilePath(rawPath: string): string {
  return rawPath;
}

function hasInvalidGitDerivedName(value: string): boolean {
  return ASCII_WHITESPACE_OR_CONTROL.test(value) || hasUnsafeUnicodeTextCharacter(value);
}

function hasAtOutsideAuthority(value: string, scheme: string): boolean {
  const schemePrefix = `${scheme}://`;
  if (!value.startsWith(schemePrefix)) {
    return value.includes('@');
  }

  const remainder = value.slice(schemePrefix.length);
  const slashIndex = remainder.search(/[/?#]/u);
  const suffix = slashIndex < 0 ? '' : remainder.slice(slashIndex);
  return suffix.includes('@');
}

function looksCredentialBearing(remoteUrl: string): boolean {
  return (
    remoteUrl.startsWith('*')
    || /^[^/\s@]+:[^/\s@]+@/u.test(remoteUrl)
    || /^[^/\s@]+@[^/\s@:]+@/u.test(remoteUrl)
    || (/^[^/\s@]+@[^/\s:]+:/u.test(remoteUrl) && !remoteUrl.startsWith('git@'))
    || (/^[^/\s@]+@[^/\s@]+/u.test(remoteUrl) && !remoteUrl.startsWith('git@'))
  );
}

function looksLikeUnsupportedScp(remoteUrl: string): boolean {
  if (remoteUrl.includes('://')) {
    return false;
  }

  if (remoteUrl.startsWith('git@')) {
    return true;
  }

  const colonIndex = remoteUrl.indexOf(':');
  if (colonIndex <= 0 || colonIndex === remoteUrl.length - 1) {
    return false;
  }

  const prefix = remoteUrl.slice(0, colonIndex);
  if (
    prefix.includes('/')
    || prefix.includes('\\')
    || prefix.includes('?')
    || prefix.includes('#')
    || ASCII_EDGE_WHITESPACE.test(prefix)
    || !prefix.includes('.')
  ) {
    return false;
  }

  return canonicalizeDiagnosticHost(prefix) !== null;
}

function isExplicitlySecretBearing(remoteUrl: string): boolean {
  const normalized = remoteUrl.toLowerCase();
  return (
    normalized.includes('access_token')
    || normalized.includes('token=')
    || normalized.includes('password=')
    || normalized.includes('secret=')
    || normalized.includes('key=')
    || /gh[pousr]_[a-z0-9_]+/iu.test(remoteUrl)
  );
}

function isNestedHelperRemote(remoteUrl: string): boolean {
  return /^[a-z][a-z0-9+.-]*::/iu.test(remoteUrl);
}

function isNetworkScheme(scheme: string): boolean {
  return scheme === 'http' || scheme === 'https' || scheme === 'ssh' || scheme === 'git';
}

function canonicalizeDiagnosticHost(rawHost: string): string | null {
  if (rawHost.includes('%') || hasUnsafeUnicodeTextCharacter(rawHost)) {
    return null;
  }

  const withoutPort = rawHost.startsWith('[')
    ? rawHost
    : rawHost.replace(/:\d+$/u, '');

  try {
    const url = new URL(`https://${withoutPort}/`);
    const hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
    if (!hostname || !/^[a-z0-9.-]+$/u.test(hostname)) {
      return null;
    }

    const labels = hostname.split('.');
    if (labels.some((label) =>
      label.length < 1
      || label.length > 63
      || label.startsWith('-')
      || label.endsWith('-')
    )) {
      return null;
    }

    return hostname;
  } catch {
    return null;
  }
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
