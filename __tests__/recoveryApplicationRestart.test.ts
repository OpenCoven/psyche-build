import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assertDisposableRoot,
  cockpitSessionName,
  RecoveryRestartUnavailableError,
} from '../src/diagnostics/recoveryApplicationRestart.js';
import {
  optInRecoveryScenarioIds,
  recoveryScenarioIds,
} from '../src/diagnostics/recoveryHarness.js';

const CHECKOUT = '/repo/psyche-build';

describe('application restart scenario', () => {
  // The cockpit adopts its working directory as its project root and rewrites
  // that project's .psyche state on startup. A launch pointed at the checkout
  // therefore destroys the developer's own workspace, which is why this is a
  // guard rather than a convention.
  it('refuses to launch against the repository checkout', () => {
    for (const unsafe of [
      CHECKOUT,
      `${CHECKOUT}/`,
      path.join(CHECKOUT, 'project'),
      path.join(CHECKOUT, '.worktrees', 'feature', 'project'),
    ]) {
      expect(() => assertDisposableRoot(unsafe, CHECKOUT), unsafe)
        .toThrow(RecoveryRestartUnavailableError);
    }
  });

  it('allows a disposable root outside the checkout', () => {
    for (const safe of [
      '/tmp/psyche-recovery-abc/project',
      '/var/folders/xy/psyche-recovery-abc/project',
      // A sibling whose path merely starts with the checkout string is outside
      // it; a prefix comparison rather than a path comparison would allow one
      // and reject the other.
      `${CHECKOUT}-other/project`,
    ]) {
      expect(() => assertDisposableRoot(safe, CHECKOUT), safe).not.toThrow();
    }
  });

  it('derives the session name the cockpit derives', () => {
    // Mirrors src/index.ts: dots are not legal in a tmux session name.
    expect(cockpitSessionName('/tmp/psyche-recovery-abc/project'))
      .toMatch(/^psyche-project-[a-f0-9]{8}$/u);
    expect(cockpitSessionName('/tmp/some.dotted.name')).not.toContain('.');
  });

  it('stays out of the default harness run', () => {
    // Two real application launches must never gate a required check.
    expect(optInRecoveryScenarioIds()).toContain('application-restart');
    expect(recoveryScenarioIds()).not.toContain('application-restart');
  });
});
