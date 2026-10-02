import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { RecoveryRestartUnavailableError } from '../src/diagnostics/recoveryApplicationRestart.js';
import {
  CONFINED_AGENT_NAMES,
  decideRelaunch,
  fakeAgentScript,
  FAKE_AGENT_MARKER,
  probeShowsConfinement,
  startAgain,
  tmuxShimScript,
} from '../src/diagnostics/recoveryApplicationRestartLive.js';
import { AGENT_REGISTRY } from '../src/utils/agentLaunch.js';
import {
  optInRecoveryScenarioIds,
  recoveryScenarioIds,
} from '../src/diagnostics/recoveryHarness.js';

const FAKE_BIN = '/tmp/psyche-recovery-abc/harness/fake-bin';

describe('restart scenarios with a crash or a live agent', () => {
  const cleanup: string[] = [];
  afterAll(() => {
    for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
  });

  // The guard that keeps the operator's real agent CLIs from running. It must
  // fail closed on anything but an exact fake-directory resolution.
  describe('agent confinement probe', () => {
    it('accepts names that resolve only into the fake directory or to nothing', () => {
      expect(probeShowsConfinement('ok', FAKE_BIN)).toBe(true);
      expect(probeShowsConfinement(`ok ${FAKE_BIN}/claude`, FAKE_BIN, ['claude'])).toBe(true);
    });

    it('refuses any agent resolved outside the fake directory', () => {
      for (const leaked of [
        `ok ${FAKE_BIN}/claude /Users/someone/.local/bin/opencode`,
        'ok /opt/homebrew/bin/claude',
        // A fake directory prefix is not the fake directory.
        `ok ${FAKE_BIN}-real/claude`,
        // A file of another name inside the fake directory is not a fake agent.
        `ok ${FAKE_BIN}/claude-real`,
      ]) {
        expect(probeShowsConfinement(leaked, FAKE_BIN), leaked).toBe(false);
      }
    });

    it('refuses a missing, malformed or incomplete probe', () => {
      expect(probeShowsConfinement(undefined, FAKE_BIN)).toBe(false);
      expect(probeShowsConfinement('', FAKE_BIN)).toBe(false);
      expect(probeShowsConfinement(`${FAKE_BIN}/claude`, FAKE_BIN)).toBe(false);
      // The live-agent pane must actually reach the fake it is about to run.
      expect(probeShowsConfinement('ok', FAKE_BIN, ['claude'])).toBe(false);
    });
  });

  // The crash injection point lives outside the product, in a PATH shim. Its
  // matching rule decides exactly where the cockpit freezes, so it is run here
  // against a stand-in tmux rather than trusted by inspection.
  describe('tmux shim', () => {
    const setup = () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'psyche-shim-'));
      cleanup.push(dir);
      const realTmux = path.join(dir, 'real-tmux');
      writeFileSync(realTmux, '#!/bin/sh\necho "real:$*"\n');
      chmodSync(realTmux, 0o755);
      const paths = {
        armPath: path.join(dir, 'armed'),
        reachedPath: path.join(dir, 'reached'),
        releasePath: path.join(dir, 'release'),
      };
      const shim = path.join(dir, 'tmux');
      writeFileSync(shim, tmuxShimScript({ realTmux, ...paths }));
      chmodSync(shim, 0o755);
      const run = (...args: string[]) => execFileSync(shim, args, { encoding: 'utf8', timeout: 10_000 }).trim();
      return { ...paths, run };
    };

    it('passes every call through to the real tmux while disarmed', () => {
      const shim = setup();
      expect(shim.run('display-message', '-t', '%1', '-p', '#{pane_current_path}'))
        .toBe('real:display-message -t %1 -p #{pane_current_path}');
      expect(existsSync(shim.reachedPath)).toBe(false);
    });

    it('fires once, on the pane path query only, then disarms', () => {
      const shim = setup();
      writeFileSync(shim.armPath, '');
      // Released up front so the test never blocks.
      writeFileSync(shim.releasePath, '');

      expect(shim.run('display-message', '-t', '%1', '-p', '#{pane_current_command}'))
        .toBe('real:display-message -t %1 -p #{pane_current_command}');
      expect(existsSync(shim.reachedPath)).toBe(false);
      expect(existsSync(shim.armPath)).toBe(true);

      expect(shim.run('display-message', '-t', '%1', '-p', '#{pane_current_path}'))
        .toBe('real:display-message -t %1 -p #{pane_current_path}');
      expect(Number.parseInt(readFileSync(shim.reachedPath, 'utf8'), 10)).toBeGreaterThan(0);
      expect(existsSync(shim.armPath)).toBe(false);
    });
  });

  describe('agent names the probe covers', () => {
    it('includes the launch command of every registered agent', () => {
      for (const entry of Object.values(AGENT_REGISTRY)) {
        expect(CONFINED_AGENT_NAMES, entry.id).toContain(entry.promptCommand.split(' ')[0]);
      }
      for (const name of ['claude', 'opencode', 'coven', 'codex', 'crush']) {
        expect(CONFINED_AGENT_NAMES).toContain(name);
      }
    });

    it('holds only bare command names, so the probe line stays shell-safe', () => {
      for (const name of CONFINED_AGENT_NAMES) {
        expect(name).toMatch(/^[a-z][a-z0-9-]*$/u);
      }
    });
  });

  // An exited private server must never be replaced by a fresh one: the fresh
  // server would not carry the confined default-command, its panes would run a
  // login shell, and the cockpit could type an agent command into it.
  describe('relaunch gate', () => {
    const confined = '/usr/bin/env PATH=/fake:/tools ENV= /bin/sh';
    const host = {
      socketPath: '/tmp/psyche-recovery-x/cockpit.sock',
      session: 'psyche-project-00000000',
      projectRoot: '/tmp/psyche-recovery-x/project',
      entry: { argv: ['node', 'index.js'] },
      env: {},
      defaultCommand: confined,
    };
    const launchers = (state: { session: boolean; serverCommand: string | undefined }) => {
      const calls: string[] = [];
      return {
        calls,
        launchers: {
          relaunch: () => { calls.push('relaunch'); },
          launch: () => { calls.push('launch'); },
          readServerDefaultCommand: () => state.serverCommand,
          hasSession: () => state.session,
        },
      };
    };

    it('refuses whenever the server is gone or its default-command is not the confined one', () => {
      for (const serverDefaultCommand of [undefined, '', '/bin/zsh', `${confined} `]) {
        for (const sessionExists of [true, false]) {
          expect(decideRelaunch({
            sessionExists,
            serverDefaultCommand,
            confinedDefaultCommand: confined,
          })).toBe('refuse');
        }
      }
    });

    it('never launches when the server has exited', () => {
      const { calls, launchers: deps } = launchers({ session: false, serverCommand: undefined });
      expect(() => startAgain(host, deps)).toThrow(RecoveryRestartUnavailableError);
      expect(calls).toEqual([]);
    });

    it('never launches on a server that lost its confinement', () => {
      const { calls, launchers: deps } = launchers({ session: true, serverCommand: '/bin/zsh' });
      expect(() => startAgain(host, deps)).toThrow(RecoveryRestartUnavailableError);
      expect(calls).toEqual([]);
    });

    it('relaunches into the session, or opens one, only on the verified confined server', () => {
      const surviving = launchers({ session: true, serverCommand: confined });
      expect(startAgain(host, surviving.launchers)).toBe(true);
      expect(surviving.calls).toEqual(['relaunch']);

      const sessionGone = launchers({ session: false, serverCommand: confined });
      expect(startAgain(host, sessionGone.launchers)).toBe(true);
      expect(sessionGone.calls).toEqual(['launch']);
    });
  });

  it('records each fake agent launch and stays bounded', () => {
    const script = fakeAgentScript('/tmp/launches.log');
    expect(script).toContain(FAKE_AGENT_MARKER);
    expect(script).toContain(">> '/tmp/launches.log'");
    expect(script).toMatch(/exec \/bin\/sleep \d+\n$/u);
  });

  it('stays out of the default harness run', () => {
    for (const id of ['application-crash-mid-transition', 'application-restart-live-agent'] as const) {
      expect(optInRecoveryScenarioIds()).toContain(id);
      expect(recoveryScenarioIds()).not.toContain(id);
    }
  });
});
