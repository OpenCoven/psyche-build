import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { RecoveryRestartUnavailableError } from '../src/diagnostics/recoveryApplicationRestart.js';
import {
  classifyCrashMidTransition,
  classifyLiveAgentRestart,
  confinedDefaultCommand,
  confinedPathFor,
  CONFINED_AGENT_NAMES,
  probeAgents,
  tmuxDefaultCommandConfig,
  decideRelaunch,
  fakeAgentScript,
  FAKE_AGENT_MARKER,
  orphanReportedExactlyOnce,
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
      expect(probeShowsConfinement(`ok:${FAKE_BIN}/claude`, FAKE_BIN, ['claude'])).toBe(true);
      expect(probeShowsConfinement(`ok:${FAKE_BIN}/claude\n`, FAKE_BIN, ['claude'])).toBe(true);
    });

    it('refuses any agent resolved outside the fake directory', () => {
      for (const leaked of [
        `ok:${FAKE_BIN}/claude:/Users/someone/.local/bin/opencode`,
        'ok:/opt/homebrew/bin/claude',
        // A fake directory prefix is not the fake directory.
        `ok:${FAKE_BIN}-real/claude`,
        // A file of another name inside the fake directory is not a fake agent.
        `ok:${FAKE_BIN}/claude-real`,
        // Two entries run together are not one fake path.
        `ok:${FAKE_BIN}/claude ${FAKE_BIN}/claude`,
      ]) {
        expect(probeShowsConfinement(leaked, FAKE_BIN), leaked).toBe(false);
      }
    });

    it('refuses a missing, malformed or incomplete probe', () => {
      expect(probeShowsConfinement(undefined, FAKE_BIN)).toBe(false);
      expect(probeShowsConfinement('', FAKE_BIN)).toBe(false);
      expect(probeShowsConfinement(`${FAKE_BIN}/claude`, FAKE_BIN)).toBe(false);
      expect(probeShowsConfinement(`ok ${FAKE_BIN}/claude`, FAKE_BIN)).toBe(false);
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

  // A TMPDIR with a space must not split the confined PATH into extra `env`
  // arguments or the probe output into extra entries.
  describe('a disposable root containing a space', () => {
    const tmuxPath = (() => {
      try {
        return execFileSync('/bin/sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim();
      } catch {
        return '';
      }
    })();

    it('refuses directories the confined PATH cannot carry', () => {
      for (const bad of ['/tmp/a:b', '/tmp/a"b', "/tmp/a'b", '/tmp/a$b', '/tmp/a`b', '/tmp/a\\b', 'relative/dir']) {
        expect(() => confinedPathFor([bad, '/usr/bin']), bad).toThrow(RecoveryRestartUnavailableError);
      }
      expect(confinedPathFor(['/tmp/with space/fake-bin', '/usr/bin']))
        .toBe('/tmp/with space/fake-bin:/usr/bin');
    });

    it('keeps a spaced PATH as one value when the default command runs under sh', () => {
      const confinedPath = confinedPathFor(['/tmp/with space/fake-bin', '/usr/bin', '/bin']);
      const printed = execFileSync('/bin/sh', [
        '-c',
        confinedDefaultCommand(confinedPath).replace(/ \/bin\/sh$/u, ' /bin/sh -c \'printf %s "$PATH"\''),
      ], { encoding: 'utf8' });
      expect(printed).toBe(confinedPath);
    });

    it.skipIf(!tmuxPath)('confines a real pane and probes it on a spaced root', async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'psyche space-'));
      cleanup.push(root);
      const fakeBin = path.join(root, 'fake bin');
      const toolBin = path.join(root, 'tool bin');
      mkdirSync(fakeBin);
      mkdirSync(toolBin);
      writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\nexit 0\n');
      chmodSync(path.join(fakeBin, 'claude'), 0o755);
      symlinkSync(tmuxPath, path.join(toolBin, 'tmux'));
      const defaultCommand = confinedDefaultCommand(
        confinedPathFor([fakeBin, toolBin, '/usr/bin', '/bin', '/usr/sbin', '/sbin']),
      );
      const config = path.join(root, 'tmux.conf');
      writeFileSync(config, tmuxDefaultCommandConfig(defaultCommand));
      const socket = path.join(root, 's');
      const env = { PATH: '/usr/bin:/bin', HOME: root, SHELL: '/bin/sh', TERM: 'xterm-256color' };
      execFileSync(tmuxPath, ['-S', socket, '-f', config, 'new-session', '-d', '-s', 'probe'], { env });
      try {
        const tmux = (...args: string[]) => execFileSync(tmuxPath, ['-S', socket, ...args], { encoding: 'utf8' }).trim();
        expect(tmux('show-options', '-g', '-v', 'default-command')).toBe(defaultCommand);
        const pane = tmux('display-message', '-p', '-t', 'probe', '#{pane_id}');
        const probe = await probeAgents(socket, pane);
        expect(probe).toBe(`ok:${fakeBin}/claude`);
        expect(probeShowsConfinement(probe, fakeBin, ['claude'])).toBe(true);
      } finally {
        execFileSync(tmuxPath, ['-S', socket, 'kill-server']);
      }
    });
  });

  // Classification follows what was observed, never just that the first run
  // reached a workspace.
  describe('classification', () => {
    const crash = {
      firstRunReachedWorkspace: true,
      durablePaneSeeded: true,
      transitionInFlightAtKill: true,
      crashEndedCockpit: true,
      restartRestoredWorkspace: true,
      configNotSilentlyOverwritten: true,
      noDuplicatePanes: true,
      noDuplicateWorktrees: true,
      noDuplicateSessions: true,
      noDuplicateCockpits: true,
      workPreserved: true,
      transitionOutcome: 'recovery_required' as const,
      orphanReportedOnce: true,
    };
    const live = {
      firstRunReachedWorkspace: true,
      agentPaneConfined: true,
      agentRunningBeforeQuit: true,
      paneCreatedBeforeQuit: true,
      quitEndedCockpitProcess: true,
      agentSurvivedQuit: true,
      restartRestoredWorkspace: true,
      agentPaneRebound: true,
      agentNotDuplicated: true,
      agentNotOrphaned: true,
      noDuplicateWorktrees: true,
      noDuplicateSessions: true,
      noDuplicateCockpits: true,
      workPreserved: true,
    };

    it('classifies the crash scenario from its setup controls and relaunch', () => {
      expect(classifyCrashMidTransition(crash)).toBe('recovery_required');
      expect(classifyCrashMidTransition({ ...crash, transitionOutcome: 'completed' })).toBe('transition_completed');
      expect(classifyCrashMidTransition({ ...crash, transitionOutcome: 'unsettled' })).toBe('unexpected_error');
      expect(classifyCrashMidTransition({ ...crash, firstRunReachedWorkspace: false })).toBe('restart_unavailable');
      expect(classifyCrashMidTransition({ ...crash, durablePaneSeeded: false })).toBe('injection_ineffective');
      expect(classifyCrashMidTransition({ ...crash, transitionInFlightAtKill: false })).toBe('injection_ineffective');
      expect(classifyCrashMidTransition({ ...crash, restartRestoredWorkspace: false })).toBe('restart_unavailable');
    });

    it('never labels a live-agent run restored unless the relaunch restored it', () => {
      expect(classifyLiveAgentRestart(live)).toBe('workspace_restored');
      expect(classifyLiveAgentRestart({ ...live, restartRestoredWorkspace: false })).toBe('restart_unavailable');
      expect(classifyLiveAgentRestart({ ...live, paneCreatedBeforeQuit: false })).toBe('injection_ineffective');
      expect(classifyLiveAgentRestart({ ...live, agentRunningBeforeQuit: false })).toBe('injection_ineffective');
      expect(classifyLiveAgentRestart({ ...live, firstRunReachedWorkspace: false })).toBe('restart_unavailable');
    });
  });

  // #516: the relaunch re-adopted the orphan on every polling cycle and
  // stacked a marker and a quarantine record each time.
  describe('orphan reported once', () => {
    const marker = (paneId: string) => ({ pane: { id: 'r', paneId, slug: 'shell-2' } });
    const quarantine = (paneId: string) => ({
      state: 'quarantined' as const,
      pane: { id: 'r', paneId },
    });

    it('holds for one marker and one quarantine naming the orphan', () => {
      expect(orphanReportedExactlyOnce(
        '%7',
        'recovery_required',
        [marker('%7'), marker('%1')],
        [quarantine('%7')],
        ['%1'],
      )).toBe(true);
    });

    it('fails when repeated adoption stacked more reports for the same pane', () => {
      expect(orphanReportedExactlyOnce(
        '%7',
        'recovery_required',
        [marker('%7'), marker('%7'), marker('%7')],
        [quarantine('%7'), quarantine('%7'), quarantine('%7')],
        [],
      )).toBe(false);
      expect(orphanReportedExactlyOnce(
        '%7',
        'recovery_required',
        [marker('%7')],
        [quarantine('%7'), { state: 'provisional', pane: { id: 'x', paneId: '%7' } }],
        [],
      )).toBe(false);
    });

    it('fails when the reported orphan was also adopted into the pane config', () => {
      expect(orphanReportedExactlyOnce(
        '%7',
        'recovery_required',
        [marker('%7')],
        [quarantine('%7')],
        ['%1', '%7'],
      )).toBe(false);
    });

    it('fails when a required recovery was never reported', () => {
      expect(orphanReportedExactlyOnce('%7', 'recovery_required', [], [], [])).toBe(false);
    });

    it('requires a settled creation to leave no report, and never holds unsettled', () => {
      expect(orphanReportedExactlyOnce('%7', 'completed', [], [], ['%7'])).toBe(true);
      expect(orphanReportedExactlyOnce('%7', 'rolled_back', [marker('%7')], [], [])).toBe(false);
      expect(orphanReportedExactlyOnce('%7', 'unsettled', [], [], [])).toBe(false);
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
