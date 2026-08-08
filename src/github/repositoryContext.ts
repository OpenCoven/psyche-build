import {
  compareText,
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

interface ParsedRemoteUrl {
  diagnosticUrl: string;
  normalizedUrl: string;
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

    rawRemotes.push({ name: remoteName, url: remoteUrl.diagnosticUrl });

    const normalized = normalizeGitHubRemote(remoteName, remoteUrl.normalizedUrl);
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
    return remoteName && isValidRemoteName(remoteName) ? remoteName : null;
  } catch {
    return null;
  }
}

async function readRemoteUrl(
  worktreePath: string,
  remoteName: string,
  runner: ReadOnlyCommandRunner,
): Promise<ParsedRemoteUrl | null> {
  try {
    const result = await runner.run('git', ['remote', 'get-url', '--', remoteName], {
      cwd: worktreePath,
      allowFailure: true,
    });

    if (result.exitCode !== 0) {
      return null;
    }

    const normalizedUrl = parseRemoteUrlOutput(result.stdout);
    if (normalizedUrl === null) {
      return null;
    }

    return {
      diagnosticUrl: sanitizeDiagnosticRemoteUrl(normalizedUrl),
      normalizedUrl,
    };
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

  if (ASCII_WHITESPACE_OR_CONTROL.test(value)) {
    throw new Error(REPOSITORY_CONTEXT_ERROR);
  }

  return value;
}

function parseOptionalValue(stdout: string): string | null {
  const value = stripSingleTrailingLineTerminator(stdout);
  if (!value || ASCII_WHITESPACE_OR_CONTROL.test(value)) {
    return null;
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
  if (isValidGitScpDiagnostic(remoteUrl)) {
    return remoteUrl;
  }

  const sanitizedSchemeUrl = sanitizeSchemeRemoteUrl(remoteUrl);
  if (sanitizedSchemeUrl !== null) {
    return sanitizedSchemeUrl;
  }

  if (looksCredentialBearing(remoteUrl)) {
    return REDACTED_REMOTE_URL;
  }

  return remoteUrl;
}

function isValidGitScpDiagnostic(remoteUrl: string): boolean {
  return /^git@[^:/\\@[\]\s?#]+:[^?#]+$/u.test(remoteUrl);
}

function sanitizeSchemeRemoteUrl(remoteUrl: string): string | null {
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/iu.exec(remoteUrl);
  if (!schemeMatch) {
    return null;
  }

  const scheme = schemeMatch[1].toLowerCase();
  if (!remoteUrl.startsWith(`${scheme}://`)) {
    return isNetworkScheme(scheme) && remoteUrl.includes('@') ? REDACTED_REMOTE_URL : null;
  }

  const rawParts = extractSchemeUrlParts(remoteUrl);
  if (rawParts === null) {
    return isNetworkScheme(scheme) && remoteUrl.includes('@') ? REDACTED_REMOTE_URL : null;
  }

  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch {
    return rawParts.authority.includes('@') ? REDACTED_REMOTE_URL : null;
  }

  if (
    url.protocol === 'ssh:'
    && rawParts.authority.startsWith('git@')
    && !url.password
    && rawParts.authority.indexOf('@') === rawParts.authority.lastIndexOf('@')
  ) {
    return remoteUrl;
  }

  if (rawParts.authority.includes('@') || url.username || url.password) {
    return `${url.protocol}//${url.host}${rawParts.suffix}`;
  }

  return remoteUrl;
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

function looksCredentialBearing(remoteUrl: string): boolean {
  return (
    remoteUrl.startsWith('*')
    || /^[^/\s@]+:[^/\s@]+@/u.test(remoteUrl)
    || /^[^/\s@]+@[^/\s@:]+@/u.test(remoteUrl)
    || (/^[^/\s@]+@[^/\s:]+:/u.test(remoteUrl) && !remoteUrl.startsWith('git@'))
    || (/^[^/\s@]+@[^/\s@]+/u.test(remoteUrl) && !remoteUrl.startsWith('git@'))
  );
}

function isNetworkScheme(scheme: string): boolean {
  return scheme === 'http' || scheme === 'https' || scheme === 'ssh' || scheme === 'git';
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
