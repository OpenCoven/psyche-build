import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Vitest 4's fork pool can lose its IPC channel when this suite exercises
    // real child-process and signal behavior. Threads avoid the EPIPE failure,
    // while a bounded worker count keeps the process-heavy tests deterministic.
    pool: 'threads',
    maxWorkers: 4,
    // The smoke test needs tmux and a production build, so it is not part of
    // the portable unit suite. This exclusion applies even to an explicitly
    // named file, so `pnpm smoke` cannot escape it by passing a path — it runs
    // under vitest.smoke.config.ts instead, which does not exclude it.
    exclude: [
      ...configDefaults.exclude,
      '.worktrees/**',
      // Agent tooling (e.g. Claude Code) creates throwaway worktree copies under
      // `.claude/worktrees/**`. Those stale duplicates are gitignored and not part
      // of the suite; excluding them keeps `pnpm test` from picking up outdated
      // copies of real test files, exactly like `.worktrees/**` above.
      '.claude/worktrees/**',
      '.psyche/**',
      '**/psyche.smoke.test.ts',
    ],
    // Several suites shell out to real git (creating worktrees, branches, and
    // repos on disk) rather than mocking it. Vitest's 5s/10s defaults are
    // wall-clock budgets, so under full-suite parallelism those tests flake on
    // machine load rather than on behaviour. These limits still fail a genuinely
    // hung test — just not a merely slow one.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
