import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Proves a built cockpit starts in a clean, disposable project.
 *
 * Excluded from `pnpm test` and run by `pnpm smoke`, because it needs tmux and
 * a production build. It deliberately creates no worktree pane, launches no
 * agent binary, calls no Coven, and touches no network — the focused suites
 * cover those. What is left is the one thing nothing else checks: that
 * `dist/index.js`, the entry point the packaged CLI actually uses, comes up at
 * all. `pnpm smoke:pack` separately proves the packaged tarball installs and
 * exports the public control-token subpath; a package can pack correctly and
 * still fail to launch.
 */

const CHECKOUT = process.cwd();
const ENTRY = path.join(CHECKOUT, 'dist', 'index.js');
// Unique per run so concurrent runs cannot adopt each other's server, and so a
// crashed run leaves a name the next one will not collide with.
const SOCKET = `psyche-smoke-${process.pid}-${Date.now().toString(36)}`;

function tmux(args: string[], options: { env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync('tmux', ['-L', SOCKET, ...args], {
    encoding: 'utf-8',
    env: options.env ?? process.env,
  });
}

function sessionExists(name: string): boolean {
  try {
    tmux(['has-session', '-t', name]);
    return true;
  } catch {
    return false;
  }
}

function capturePane(name: string): string {
  try {
    return tmux(['capture-pane', '-p', '-t', name]);
  } catch (error) {
    return `<could not capture pane: ${error instanceof Error ? error.message : String(error)}>`;
  }
}

async function waitFor(
  predicate: () => boolean,
  { timeoutMs, label }: { timeoutMs: number; label: string },
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

/** The name the cockpit derives for a project root, mirrored from src/index.ts. */
function expectedSessionName(projectRoot: string): string {
  const projectName = path.basename(projectRoot);
  const hash = createHash('md5').update(projectRoot).digest('hex').substring(0, 8);
  return `psyche-${`${projectName}-${hash}`.replace(/\./g, '-')}`;
}

describe('built cockpit smoke test', () => {
  it('starts in a disposable project and leaves nothing behind', async () => {
    // Fail rather than skip. This is the only assertion the smoke command
    // makes, so skipping it would report success while checking nothing.
    try {
      execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    } catch {
      throw new Error('pnpm smoke requires tmux on PATH.');
    }
    if (!fs.existsSync(ENTRY)) {
      throw new Error(`No build at ${ENTRY}. Run "pnpm run build" first (pnpm smoke does this).`);
    }

    // Canonicalized because macOS resolves /tmp to /private/tmp, and the
    // cockpit records the real path in its config.
    const scratch = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'psyche-smoke-'));
    let socketPath = '';
    const repo = path.join(scratch, 'disposable-project');
    // A HOME of its own, so the cockpit cannot read or write the developer's
    // real settings, tmux config, or runtime state.
    const home = path.join(scratch, 'home');
    let session = '';

    try {
      fs.mkdirSync(repo);
      fs.mkdirSync(home);

      const git = (args: string[]) =>
        execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: 'pipe' });
      git(['init', '-q']);
      git(['config', 'user.email', 'smoke@example.invalid']);
      git(['config', 'user.name', 'Smoke Test']);
      git(['config', 'commit.gpgsign', 'false']);
      fs.writeFileSync(path.join(repo, 'README.md'), '# disposable\n');
      git(['add', 'README.md']);
      git(['commit', '-q', '-m', 'initial']);

      const realRepo = fs.realpathSync.native(repo);
      session = expectedSessionName(realRepo);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        // Without this the cockpit may take a dev-only path.
        PSYCHE_DEV: undefined,
        // Keep Ink from deciding it is non-interactive and bailing early.
        TERM: 'xterm-256color',
        CI: undefined,
      };
      delete env.PSYCHE_DEV;
      delete env.CI;
      delete env.TMUX;

      // -f /dev/null: the developer's tmux.conf must not influence this.
      tmux(
        [
          '-f',
          '/dev/null',
          'new-session',
          '-d',
          '-s',
          session,
          '-c',
          realRepo,
          '-x',
          '200',
          '-y',
          '50',
          process.execPath,
          ENTRY,
        ],
        { env },
      );

      socketPath = tmux(['display-message', '-p', '#{socket_path}']).trim();

      // A disposable HOME has no tmux config, so first-run onboarding offers to
      // create one and blocks until answered. Declining is what keeps this a
      // startup check rather than a config-writing one — and it means the test
      // also proves the offer appears on a clean machine.
      try {
        await waitFor(() => capturePane(session).includes('Set up recommended tmux defaults?'), {
          timeoutMs: 20_000,
          label: 'the tmux onboarding prompt',
        });
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n`
            + `--- cockpit pane ---\n${capturePane(session)}`,
        );
      }
      tmux(['send-keys', '-t', session, 'n']);

      const configPath = path.join(realRepo, '.psyche', 'psyche.config.json');
      try {
        await waitFor(() => fs.existsSync(configPath), {
          timeoutMs: 20_000,
          label: `${configPath} to be written`,
        });
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n`
            + `--- cockpit pane ---\n${capturePane(session)}`,
        );
      }

      // The file can be observed mid-write; settle on parseable content.
      let config: Record<string, unknown> = {};
      await waitFor(
        () => {
          try {
            config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            return typeof config.projectName === 'string';
          } catch {
            return false;
          }
        },
        { timeoutMs: 10_000, label: 'the config to contain a projectName' },
      );

      // It identified the disposable project, not the developer's checkout.
      expect(config.projectName).toBe(path.basename(realRepo));
      expect(config.projectRoot).toBe(realRepo);
      expect(config.panes).toEqual([]);

      // Nothing was written into the temporary HOME's psyche state either.
      expect(fs.existsSync(path.join(home, '.psyche', 'psyche.config.json'))).toBe(false);

      // Quit the way a user does: the cockpit exits cleanly on SIGINT, and the
      // session ends with its only pane's process.
      tmux(['send-keys', '-t', session, 'C-c']);
      await waitFor(() => !sessionExists(session), {
        timeoutMs: 15_000,
        label: `tmux session ${session} to end after quit`,
      });
    } finally {
      try {
        // stdio ignored: a clean run has already ended the session, so tmux
        // writes "no server running" to stderr. That is the success path, and
        // printing it makes a passing run look like a failing one.
        execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' });
      } catch {
        // Already gone, which is the expected path.
      }
      // Killing the server does not unlink its socket, and the name is unique
      // per run, so without this every run leaves a dead file behind. The path
      // is captured from tmux while the server is alive rather than guessed:
      // tmux uses /tmp/tmux-<uid>, which is not os.tmpdir() on macOS.
      if (socketPath) {
        fs.rmSync(socketPath, { force: true });
      }
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});
