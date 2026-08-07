import { describe, expect, it } from 'vitest';
import {
  MAX_PR_BODY_PREVIEW,
  parseGitHubAccount,
  parsePullRequestOverview,
  parseRepositoryPermissions,
  type PullRequestOverviewResult,
} from '../src/github/types.js';

const repository = {
  host: 'github.com',
  owner: 'OpenCoven',
  name: 'psyche-build',
  url: 'https://github.com/OpenCoven/psyche-build',
} as const;

const permissions = {
  admin: false,
  maintain: true,
  pull: true,
  push: true,
  triage: true,
} as const;

const passingCheck = {
  bucket: 'pass',
  link: 'https://github.com/OpenCoven/psyche-build/actions/runs/1',
  name: 'test',
  state: 'SUCCESS',
  workflow: 'CI',
} as const;

describe('GitHub domain validation', () => {
  it('normalizes an authenticated account without accepting a token', () => {
    const account = parseGitHubAccount({
      login: 'BunsDev',
      id: 123,
      url: 'https://github.com/BunsDev',
      token: 'secret',
    }, 'GitHub.COM');

    expect(account).toEqual({
      host: 'github.com',
      login: 'BunsDev',
      id: '123',
      source: 'gh',
    });
    expect(account).not.toHaveProperty('token');
  });

  it('parses a bounded pull request overview', () => {
    const overview = parsePullRequestOverview({
      number: 184,
      url: 'https://github.com/OpenCoven/psyche-build/pull/184',
      title: 'Add branch-associated PR overview',
      body: 'A'.repeat(4_500),
      state: 'OPEN',
      isDraft: false,
      author: { login: 'BunsDev' },
      baseRefName: 'main',
      headRefName: 'feat/pr-overview',
      labels: [{ name: 'feature', color: '8250df' }],
      assignees: [{ login: 'BunsDev' }],
      reviewRequests: [{ login: 'reviewer' }],
      reviewDecision: 'REVIEW_REQUIRED',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
      additions: 214,
      deletions: 38,
      changedFiles: 6,
      commits: [{ oid: 'abc' }, { oid: 'def' }],
      updatedAt: '2026-08-06T18:00:00Z',
    }, repository, permissions, [passingCheck], [passingCheck], '2026-08-06T18:01:00Z');

    expect(overview.repository).toEqual(repository);
    expect(overview.viewerPermissions).toEqual(permissions);
    expect(overview.bodyPreview).toHaveLength(MAX_PR_BODY_PREVIEW);
    expect(overview.commitCount).toBe(2);
    expect(overview.viewerPermissions?.push).toBe(true);
    expect(overview.checks).toEqual({
      total: 1,
      pending: 0,
      passed: 1,
      failed: 0,
      skipped: 0,
      cancelled: 0,
      required: { total: 1, pending: 0, passed: 1, failed: 0 },
      optional: { total: 0, pending: 0, passed: 0, failed: 0 },
    });
  });

  it('rejects malformed provider values instead of partially rendering them', () => {
    expect(() => parsePullRequestOverview(
      {
        number: '184',
        url: 'not-a-url',
      },
      repository,
      null,
      [],
      [],
      '2026-08-06T18:01:00Z',
    )).toThrowError(new Error('invalid pull request overview'));
  });

  it('keeps every terminal query state discriminated', () => {
    const result: PullRequestOverviewResult = {
      requestId: 'req-1',
      projectId: '/repo',
      worktreePath: '/repo/.worktrees/pr',
      selectionGeneration: 7,
      observedAt: '2026-08-06T18:01:00Z',
      state: { kind: 'providerUnavailable', installMessage: 'brew install gh' },
    };

    expect(result.state.kind).toBe('providerUnavailable');
  });

  it('maps check buckets and separates required checks by stable identity', () => {
    const overview = parsePullRequestOverview({
      number: 185,
      url: 'https://github.com/OpenCoven/psyche-build/pull/185',
      title: 'Summarize checks',
      body: '',
      state: 'OPEN',
      isDraft: true,
      author: { login: 'BunsDev' },
      baseRefName: 'main',
      headRefName: 'feat/checks',
      labels: [],
      assignees: [],
      reviewRequests: [],
      reviewDecision: null,
      mergeable: 'UNKNOWN',
      mergeStateStatus: null,
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      commits: [],
      updatedAt: '2026-08-06T18:00:00Z',
    }, repository, null, [
      {
        bucket: 'pending',
        link: 'https://github.com/OpenCoven/psyche-build/actions/runs/10',
        name: 'lint',
        state: 'PENDING',
        workflow: 'CI',
      },
      {
        bucket: 'pass',
        link: 'https://github.com/OpenCoven/psyche-build/actions/runs/11',
        name: 'test',
        state: 'SUCCESS',
        workflow: 'CI',
      },
      {
        bucket: 'fail',
        link: 'https://github.com/OpenCoven/psyche-build/actions/runs/12',
        name: 'build',
        state: 'FAILURE',
        workflow: 'CI',
      },
      {
        bucket: 'skipping',
        link: 'https://github.com/OpenCoven/psyche-build/actions/runs/13',
        name: 'docs',
        state: 'SKIPPED',
        workflow: 'Docs',
      },
      {
        bucket: 'cancel',
        link: 'https://github.com/OpenCoven/psyche-build/actions/runs/14',
        name: 'deploy',
        state: 'CANCELLED',
        workflow: 'Release',
      },
    ], [
      {
        bucket: 'pending',
        link: 'https://github.com/OpenCoven/psyche-build/actions/runs/10',
        name: 'lint',
        state: 'PENDING',
        workflow: 'CI',
      },
      {
        bucket: 'skipping',
        link: 'https://github.com/OpenCoven/psyche-build/actions/runs/13',
        name: 'docs',
        state: 'SKIPPED',
        workflow: 'Docs',
      },
      {
        bucket: 'pass',
        link: 'https://github.com/OpenCoven/psyche-build/actions/runs/999',
        name: 'test',
        state: 'SUCCESS',
        workflow: 'CI',
      },
    ], '2026-08-06T18:01:00Z');

    expect(overview.checks).toEqual({
      total: 5,
      pending: 1,
      passed: 1,
      failed: 1,
      skipped: 1,
      cancelled: 1,
      required: { total: 2, pending: 1, passed: 0, failed: 0 },
      optional: { total: 3, pending: 0, passed: 1, failed: 1 },
    });
  });

  it('parses repository permissions and rejects malformed permission payloads', () => {
    expect(parseRepositoryPermissions(permissions)).toEqual(permissions);
    expect(parseRepositoryPermissions(null)).toBeNull();
    expect(parseRepositoryPermissions(undefined)).toBeNull();
    expect(() => parseRepositoryPermissions({
      admin: false,
      maintain: true,
      pull: true,
      push: 'yes',
      triage: true,
    })).toThrowError(new Error('invalid repository permissions'));
  });
});
