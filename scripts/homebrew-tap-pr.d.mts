import type { CaskRelease } from './render-homebrew-cask.mjs';

export const TAP_OWNER: string;
export const TAP_REPO: string;
export const TAP_BASE: string;

export interface GitHubApi {
  request(
    method: string,
    path: string,
    body?: unknown,
    options?: { allowNotFound?: boolean },
  ): Promise<any>;
}

export interface OpenedTapPullRequest {
  result: 'open' | 'already-current';
  branch: string;
  prNumber: number | null;
  prUrl: string | null;
}

export class GitHubApiError extends Error {
  status: number;
  constructor(method: string, path: string, status: number, detail?: string);
}

export function tapBranchName(version: string): string;
export function createGitHubApi(
  token: string,
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>,
): GitHubApi;
export function openHomebrewTapPullRequest(
  api: GitHubApi,
  release: CaskRelease,
  log?: (message: string) => void,
): Promise<OpenedTapPullRequest>;
export function verifyHomebrewTapPullRequest(
  api: GitHubApi,
  release: CaskRelease,
  opened: { result: string | undefined; prNumber: number | null },
): Promise<{ verified: string }>;
