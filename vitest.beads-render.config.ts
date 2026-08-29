import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The sanitizer renderer contains deliberate wall-clock complexity guards.
    // Run that suite alone so its timing ratios are not distorted by the normal
    // four-worker unit pool. CI retries only this isolated suite: a real
    // complexity regression remains reproducible and fails every attempt, while
    // transient shared-runner preemption no longer blocks unrelated changes.
    pool: 'threads',
    maxWorkers: 1,
    retry: process.env.CI ? 2 : 0,
    include: ['__tests__/beadsProjectRender.test.ts'],
    exclude: [
      ...configDefaults.exclude,
      '.worktrees/**',
      '.claude/worktrees/**',
      '.psyche/**',
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
