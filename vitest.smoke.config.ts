import { defineConfig } from 'vitest/config';

/**
 * Config for `pnpm smoke`, separate from the unit suite's.
 *
 * The smoke test is excluded in vitest.config.ts because it needs tmux and a
 * production build. Naming the file on the command line does not defeat that —
 * vitest applies `exclude` to explicit paths too, so `vitest --run <path>`
 * reports "No test files found". A second config that simply does not exclude
 * it is the honest way to run it.
 */
export default defineConfig({
  test: {
    // Every run gets a throwaway home so no test can write a developer's real
    // settings, credentials, or dotfiles (see __tests__/setup/sandboxHome.global.ts).
    globalSetup: ['./__tests__/setup/sandboxHome.global.ts'],
    setupFiles: ['./__tests__/setup/sandboxHome.worker.ts'],
    include: ['__tests__/psyche.smoke.test.ts'],
    // Starting a cockpit, waiting for it to write config, and waiting for it to
    // exit is slower than any unit test; the test sets its own 30s budget.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
