import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Runs once in the Vitest main process, before any worker starts.
 *
 * Settings, onboarding state, bridge credentials and other per-user files
 * resolve their paths from the home directory, several of them when their
 * module loads. A test whose fs mock no longer intercepts a write therefore
 * lands in the developer's real home: on 2026-10-02 a run overwrote a real
 * `~/.psyche.global.json`. Pointing HOME and the XDG directories at a
 * throwaway directory here makes that class of leak impossible rather than
 * something each test has to remember.
 *
 * The directory lives under `/tmp` on POSIX so Unix socket paths built from it
 * stay under the platform length limit.
 */
export default function setup(): () => void {
  const realHome = os.homedir();
  const base = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const home = realpathSync(mkdtempSync(path.join(base, 'pth-')));

  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    PSYCHE_TEST_HOME: home,
    PSYCHE_REAL_HOME: realHome,
  });
  // A developer running the suite inside tmux must not have tests address
  // their live tmux server.
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;

  return () => {
    rmSync(home, { recursive: true, force: true });
  };
}
