import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TmuxService } from '../src/services/TmuxService.js';

/**
 * These tests drive the real TmuxService against a private tmux server. Each
 * hands the service a value that a shell would execute. The payload touches a
 * marker file, so the marker existing means this process ran attacker text
 * through a shell on the way to tmux.
 *
 * The suite needs a tmux binary and skips without one; the argv shape itself
 * is pinned portably in tmuxServiceSecurity.test.ts.
 */

const hasTmux = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
const MARKER_ENV = 'PSYCHE_TMUX_INJECTION_MARKER';
const TOUCH_MARKER = `touch $${MARKER_ENV}`;

describe.skipIf(!hasTmux)('TmuxService never evaluates its arguments in a shell', () => {
  let sandbox: string;
  let socket: string;
  let marker: string;
  let paneId: string;
  const savedEnv: Record<string, string | undefined> = {};

  const tmux = (...args: string[]): string => execFileSync(
    'tmux',
    ['-S', socket, ...args],
    { encoding: 'utf-8', stdio: 'pipe' },
  ).trim();

  /** The pane runs `cat`, so everything typed into it is echoed back verbatim. */
  const paneText = async (): Promise<string> => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return tmux('capture-pane', '-t', paneId, '-p');
  };

  beforeAll(() => {
    // A short path: a Unix socket path has a small platform limit.
    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-tmux-')));
    socket = path.join(sandbox, 's');
    marker = path.join(sandbox, 'INJECTED');
    execFileSync(
      'tmux',
      ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-x', '200', '-y', '50', '-s', 'main', 'cat'],
      { stdio: 'pipe' },
    );
    const serverPid = tmux('display-message', '-p', '#{pid}');
    paneId = tmux('display-message', '-p', '#{pane_id}');

    for (const name of ['TMUX', 'TMUX_PANE', MARKER_ENV]) {
      savedEnv[name] = process.env[name];
    }
    // tmux finds its server through $TMUX, as it does inside a real session.
    process.env.TMUX = `${socket},${serverPid},0`;
    delete process.env.TMUX_PANE;
    process.env[MARKER_ENV] = marker;
  });

  afterAll(() => {
    try {
      tmux('kill-server');
    } catch {
      // The server is already gone.
    }
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(marker, { force: true });
    tmux('send-keys', '-t', paneId, '-R');
    tmux('clear-history', '-t', paneId);
  });

  afterEach(() => {
    expect(fs.existsSync(marker), 'a shell evaluated a tmux argument').toBe(false);
  });

  const service = () => TmuxService.getInstance();

  it('splits a pane in a directory whose name contains a command substitution', () => {
    const hostileDir = path.join(sandbox, `dir-$(${TOUCH_MARKER})`);
    fs.mkdirSync(hostileDir);

    const newPaneId = service().splitPaneSync({ targetPane: paneId, cwd: hostileDir });

    expect(newPaneId).toMatch(/^%\d+$/);
    expect(tmux('display-message', '-t', newPaneId, '-p', '#{pane_current_path}')).toBe(hostileDir);
    tmux('kill-pane', '-t', newPaneId);
  });

  it('stores a session option value that contains shell syntax', () => {
    const hostileValue = `value; ${TOUCH_MARKER}`;

    service().setSessionOptionSync('main', '@psyche_test', hostileValue);

    expect(tmux('show-options', '-v', '-t', 'main', '@psyche_test')).toBe(hostileValue);
  });

  it('names a window with text that contains a quote and shell syntax', async () => {
    const hostileName = `win'; ${TOUCH_MARKER}; echo '`;

    const windowId = await service().newWindow({ name: hostileName, detached: true });

    expect(windowId).toMatch(/^@\d+$/);
    expect(tmux('display-message', '-t', windowId, '-p', '#{window_name}')).toBe(hostileName);
    tmux('kill-window', '-t', windowId);
  });

  it('reports a layout name that contains shell syntax as a failed layout, not a command', () => {
    expect(service().selectLayoutSync(`tiled'; ${TOUCH_MARKER}; echo '`)).toBe(false);
  });

  it('reads a pane list format that contains a command substitution as a format', () => {
    expect(service().listPanesSync(`#{pane_id}$(${TOUCH_MARKER})`)).toContain(paneId);
  });

  it('types key text that contains shell syntax into the pane instead of running it', async () => {
    await service().sendTmuxKeys(paneId, `first; ${TOUCH_MARKER}`);

    expect(await paneText()).toContain('first;');
  });

  it('types a command that ends in a semicolon whole', async () => {
    await service().sendShellCommand(paneId, 'echo done;');
    await service().sendTmuxKeys(paneId, 'Enter');

    expect(await paneText()).toContain('echo done;');
  });

  it('types a command that ends in an escaped semicolon whole', async () => {
    await service().sendShellCommand(paneId, 'find . -exec true {} \\;');
    await service().sendTmuxKeys(paneId, 'Enter');

    expect(await paneText()).toContain('find . -exec true {} \\;');
  });

  it('does not let typed text that ends in a semicolon start a second tmux command', async () => {
    await service().sendKeys(paneId, ['text;', 'set-option', '-g', '@psyche_pwned', 'yes']);

    expect(service().getGlobalOptionSync('@psyche_pwned')).toBe('');
    expect(await paneText()).toContain('text;');
  });

  it('types text that starts with a dash instead of reading it as a tmux flag', async () => {
    await service().sendKeys(paneId, ['-R dashed', 'Enter']);

    expect(await paneText()).toContain('-R dashed');
  });

  it('stores a pane option value that ends in a semicolon, alone and in a batch', () => {
    expect(service().setPaneOptionSync(paneId, '@psyche_single', 'single;')).toBe(true);
    expect(service().getPaneOptionSync(paneId, '@psyche_single')).toBe('single;');

    expect(service().setPaneOptionsSync([
      { paneId, option: '@psyche_first', value: `first'; ${TOUCH_MARKER};` },
      { paneId, option: '@psyche_second', value: 'second' },
    ])).toBe(true);
    expect(service().getPaneOptionSync(paneId, '@psyche_first')).toBe(`first'; ${TOUCH_MARKER};`);
    expect(service().getPaneOptionSync(paneId, '@psyche_second')).toBe('second');
  });

  it('finds a window by its exact id only', async () => {
    const windowId = tmux('display-message', '-p', '#{window_id}');

    await expect(service().windowExists(windowId)).resolves.toBe(true);
    await expect(service().windowExists(`${windowId}9999`)).resolves.toBe(false);
    // The old `grep -q` treated the id as a pattern and matched any substring.
    await expect(service().windowExists('@')).resolves.toBe(false);
    await expect(service().windowExists('.')).resolves.toBe(false);
  });

  it('counts panes without a shell pipeline', async () => {
    await expect(service().getPaneCount()).resolves.toBe(1);
  });
});
