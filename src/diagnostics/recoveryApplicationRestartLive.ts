/**
 * Crash and live-agent restart observations for the #475 recovery harness.
 *
 * {@link observeApplicationRestart} covers a clean quit and relaunch. This
 * module adds the two restart shapes it explicitly leaves out:
 *
 *   1. **Crash mid-transition.** The cockpit is SIGKILLed while a terminal
 *      pane creation is in flight: the crash-safe slug reservation is durable,
 *      the tmux pane has been split, and the pane record is not yet persisted.
 *      The relaunch must leave the config readable (or byte-identical when it
 *      cannot read it), create no duplicate panes or worktrees, and settle the
 *      half-done transition as completed, rolled back, or `recovery_required`.
 *   2. **Restart with a live agent pane.** A pane running a fake agent is
 *      created by the cockpit, the cockpit quits and relaunches, and the pane
 *      and its process must be rebound — not recreated, duplicated, or
 *      orphaned.
 *
 * Both are opt-in, like the clean restart: they launch the real cockpit and
 * cost seconds, so they never run inside the required Quality check.
 *
 * ## Injection point (crash)
 *
 * No product code is changed and no test-only hook exists in the product. The
 * cockpit's PATH resolves `tmux` to a shim in a disposable directory that
 * execs the real binary. While an arm file exists, the first
 * `display-message … #{pane_current_path}` call — the query
 * `createShellPane` makes after the split and before the record is persisted
 * — records that it was reached and blocks. Product code makes that call with
 * `execSync`, so the whole cockpit is frozen at exactly that point and the
 * harness kills it there. The harness then confirms on disk that the
 * transition really was in flight before trusting the observation.
 *
 * The freeze is first-match: any other `pane_current_path` query that runs
 * between arming and the creation's own (untracked-pane detection queries the
 * same thing) consumes it. When that freezes the cockpit before the creation
 * has split its pane, the in-flight check fails and the run reports
 * `injection_ineffective` — honest, but a flake surface.
 *
 * ## Agent confinement (mandatory)
 *
 * A previous harness launched the operator's real agent CLIs because tmux
 * replaced `-e PATH=` with the client PATH. Here:
 *
 *   - the private tmux server (`-S` with a socket in the disposable root) is
 *     started with a config whose `default-command` is
 *     `/usr/bin/env "PATH=<confined>" ENV= /bin/sh`, so every pane — the
 *     harness's and the cockpit's — runs a non-login shell with an explicit
 *     PATH no client environment can override;
 *   - the confined PATH holds a fake-agent directory, a tool directory with
 *     symlinks to exactly `node`, `git` and `tmux`, and the system
 *     directories, never a directory that holds agent CLIs;
 *   - before the cockpit is launched, a canary pane on that server must report
 *     that `command -v` for every agent command in the registry resolves only
 *     into the fake directory or to nothing; the agent pane repeats the probe before
 *     anything is typed into it. Either failure aborts with
 *     {@link RecoveryAgentConfinementError} before any agent command is typed
 *     or any cockpit launched;
 *   - a relaunch only ever runs on that same server, and only while it still
 *     reports the confined `default-command`; if the server has gone, the
 *     relaunch is refused ({@link decideRelaunch}) rather than starting an
 *     unconfined one;
 *   - the server is killed in `finally`, and any fake-agent process still
 *     recorded is killed after it.
 *
 * ## Scope of the live-agent case
 *
 * It proves that a live, cockpit-owned, non-shell (agent worktree) pane record
 * is neither recreated nor duplicated by a restart, and that its process is not
 * orphaned. It does **not** observe the real `[n]` agent-pane creation, the
 * worktree slug reservation that creation makes, the resume/recreate launch
 * path for a dead agent pane, or the product's own title-setting — the harness
 * sets the pane title itself.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  readPaneSlugOwnershipRecords,
  type PaneSlugOwnershipRecord,
} from '../services/PaneSlugRegistry.js';
import type { RecoveryClassification } from './recoveryHarness.js';
import { AGENT_REGISTRY } from '../utils/agentLaunch.js';
import {
  readWorktreeRecoveryMarkers,
  type WorktreeRecoveryMarker,
} from '../services/WorktreeRecoveryMarker.js';
import { PANE_POLLING_INTERVAL } from '../constants/timing.js';
import {
  assertDisposableRoot,
  buildDisposableRepository,
  cockpitPane,
  cockpitSessionName,
  countCockpitPanes,
  countSessions,
  driveFirstRun,
  launchCockpit,
  listManagedWorktrees,
  QUIT_CONFIRM_WINDOW_MS,
  QUIT_PRESS_LIMIT,
  readFileOrUndefined,
  readPersistedWorkspace,
  RecoveryRestartUnavailableError,
  relaunchCockpit,
  resolveCockpitEntry,
  SEEDED_WORKTREE_BRANCH,
  sendQuit,
  sessionExists,
  STARTUP_TIMEOUT_MS,
  TEARDOWN_SETTLE_MS,
  TEARDOWN_TIMEOUT_MS,
  tmux,
  waitFor,
} from './recoveryApplicationRestart.js';

/**
 * Every command the cockpit can type to start an agent, taken from the agent
 * registry so a newly registered agent is probed without editing this file.
 * The confinement probe requires each to resolve only into the fake directory
 * or to nothing.
 *
 * Caveat: agent *detection* (`findAgentCommand`) also accepts absolute
 * `commonPaths`, so the cockpit may believe an agent is installed because, for
 * example, `/opt/homebrew/bin/opencode` exists on the host. Launching still
 * types the bare command into a pane, which no confined pane can resolve to
 * that path, so the belief cannot start the real CLI here.
 */
export const CONFINED_AGENT_NAMES: readonly string[] = [...new Set(
  Object.values(AGENT_REGISTRY)
    .flatMap((entry) => [entry.promptCommand, entry.noPromptCommand])
    .filter((command): command is string => typeof command === 'string')
    .map((command) => command.trim().split(/\s+/u)[0])
    .filter((name) => name.length > 0),
)];
/** Printed by the fake agent; never part of any evidence. */
export const FAKE_AGENT_MARKER = 'PSYCHE-HARNESS-FAKE-AGENT';

const PROBE_OPTION = '@psyche_harness_agents';
const PROBE_TIMEOUT_MS = 5_000;
/**
 * A loaded host (observed: load average ~24) can keep the cockpit loading, and
 * dropping keys, for tens of seconds; these bound the wait without assuming a
 * quiet machine.
 */
const CRASH_REACH_TIMEOUT_MS = 10_000;
const CRASH_PRESS_LIMIT = 6;
const AGENT_START_TIMEOUT_MS = 15_000;
const SETTLE_TIMEOUT_MS = 45_000;
const LAYOUT_SETTLE_MS = 3_000;
/**
 * A relaunch reconciles on its next pane-sync cycle, and worktree panes are
 * only queued for recreation after the initial load. Waiting past one 5s
 * polling interval lets a wrong recreation happen where it can be observed.
 */
const POST_RESTORE_OBSERVATION_MS = 8_000;
/**
 * After the crashed creation settles, keep watching for three more polling
 * cycles: untracked-pane detection runs on each, and #516 stacked another
 * marker and quarantine for the same orphan every time it did.
 */
const ORPHAN_REPORT_OBSERVATION_MS = 3 * PANE_POLLING_INTERVAL + 2_000;
/** Bounds the fake agent and the shim's wait, so nothing outlives a run. */
const FAKE_AGENT_LIFETIME_S = 300;
const SHIM_WAIT_LIMIT_TENTHS = 600;
const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/** Raised when pane PATH confinement could not be proven, so nothing was launched. */
export class RecoveryAgentConfinementError extends Error {
  constructor() {
    super('Restart was not observed: agent CLIs could not be confined to the fake directory');
  }
}

/**
 * Characters a confined directory may not contain. `:` separates PATH entries
 * (and the probe's output); the rest are special inside the double-quoted
 * `PATH=…` word of the default command or the single-quoted tmux config value.
 * A temp root containing one is refused rather than quoted around, so a space
 * — the realistic case — works and nothing exotic can reshape the command.
 */
const UNCONFINABLE_PATH_CHARACTERS = /[:"'`$\\\n\r]/u;

/** Joins confined directories into a PATH, refusing any that cannot be quoted safely. */
export function confinedPathFor(directories: readonly string[]): string {
  for (const directory of directories) {
    if (!path.isAbsolute(directory) || UNCONFINABLE_PATH_CHARACTERS.test(directory)) {
      throw new RecoveryRestartUnavailableError(
        'the disposable root contains characters the confined PATH cannot carry',
      );
    }
  }
  return directories.join(':');
}

/**
 * The pane command every pane on the private server runs. The `PATH=…` word is
 * double-quoted for the `sh -c` tmux runs it through, so a directory with a
 * space stays one PATH value instead of splitting into `env` arguments.
 */
export function confinedDefaultCommand(confinedPath: string): string {
  return `/usr/bin/env "PATH=${confinedPath}" ENV= /bin/sh`;
}

/** The tmux config line; single-quoted, so tmux expands nothing inside it. */
export function tmuxDefaultCommandConfig(defaultCommand: string): string {
  if (defaultCommand.includes("'") || /[\n\r]/u.test(defaultCommand)) {
    throw new RecoveryRestartUnavailableError('the confined default command cannot be quoted for tmux');
  }
  return `set -g default-command '${defaultCommand}'\n`;
}

/**
 * Reads the probe result a pane shell wrote: `ok` followed by every path that
 * `command -v` resolved, joined with `:` — a character no confined directory
 * may contain, so a path with spaces stays one entry. Confined only when each
 * resolved path is the fake agent of that name, and when `requireFake` names
 * are all present.
 */
export function probeShowsConfinement(
  probe: string | undefined,
  fakeBin: string,
  requireFake: readonly string[] = [],
): boolean {
  if (!probe) return false;
  const [head, ...resolved] = probe.replace(/[\r\n]+$/u, '').split(':');
  if (head !== 'ok') return false;
  const allowed = new Set(CONFINED_AGENT_NAMES.map((name) => path.join(fakeBin, name)));
  if (!resolved.every((entry) => allowed.has(entry))) return false;
  return requireFake.every((name) => resolved.includes(path.join(fakeBin, name)));
}

/** The tmux shim body; exported so its matching rule is unit-tested. */
export function tmuxShimScript(options: {
  realTmux: string;
  armPath: string;
  reachedPath: string;
  releasePath: string;
}): string {
  const q = shellQuote;
  return [
    '#!/bin/sh',
    '# Recovery-harness tmux shim: execs the real binary. While armed, the first',
    '# pane_current_path query records that it was reached and blocks, so the',
    '# cockpit is frozen mid-transition at a known point.',
    'case "$*" in',
    "  *display-message*'#{pane_current_path}'*)",
    `    if [ -f ${q(options.armPath)} ] && /bin/rm ${q(options.armPath)} 2>/dev/null; then`,
    `      echo "$$" > ${q(`${options.reachedPath}.tmp`)}`,
    `      /bin/mv ${q(`${options.reachedPath}.tmp`)} ${q(options.reachedPath)}`,
    '      i=0',
    `      while [ ! -f ${q(options.releasePath)} ] && [ "$i" -lt ${SHIM_WAIT_LIMIT_TENTHS} ]; do`,
    '        /bin/sleep 0.1',
    '        i=$((i + 1))',
    '      done',
    '    fi',
    '    ;;',
    'esac',
    `exec ${q(options.realTmux)} "$@"`,
    '',
  ].join('\n');
}

export function fakeAgentScript(launchLog: string): string {
  return [
    '#!/bin/sh',
    `echo "$$" >> ${shellQuote(launchLog)}`,
    `echo ${FAKE_AGENT_MARKER}`,
    `exec /bin/sleep ${FAKE_AGENT_LIFETIME_S}`,
    '',
  ].join('\n');
}

interface ConfinedHost {
  readonly projectRoot: string;
  readonly socketPath: string;
  readonly session: string;
  readonly configPath: string;
  readonly workPath: string;
  readonly workBefore: string;
  readonly fakeBin: string;
  readonly launchLog: string;
  readonly entry: { argv: string[] };
  readonly env: NodeJS.ProcessEnv;
  readonly shim?: { armPath: string; reachedPath: string; releasePath: string };
  /** The confined pane command the private server was started with. */
  readonly defaultCommand: string;
}

async function prepareConfinedHost(
  root: string,
  options: { shimTmux: boolean },
): Promise<ConfinedHost> {
  const checkoutRoot = fileURLToPath(new URL('../../', import.meta.url));
  const projectRoot = path.join(root, 'project');
  assertDisposableRoot(projectRoot, checkoutRoot);

  const home = path.join(root, 'home');
  const harness = path.join(root, 'harness');
  const fakeBin = path.join(harness, 'fake-bin');
  const toolBin = path.join(harness, 'tool-bin');
  const launchLog = path.join(harness, 'agent-launches.log');
  for (const dir of [projectRoot, home, fakeBin, toolBin]) {
    await mkdir(dir, { recursive: true });
  }

  // Exactly one fake agent. The others stay absent so the probe can prove a
  // name resolves to nothing rather than to an installed CLI.
  await writeExecutable(path.join(fakeBin, 'claude'), fakeAgentScript(launchLog));

  const realTmux = resolveHostTool('tmux');
  await symlink(process.execPath, path.join(toolBin, 'node'));
  await symlink(resolveHostTool('git'), path.join(toolBin, 'git'));
  let shim: ConfinedHost['shim'];
  if (options.shimTmux) {
    shim = {
      armPath: path.join(harness, 'crash.armed'),
      reachedPath: path.join(harness, 'crash.reached'),
      releasePath: path.join(harness, 'crash.release'),
    };
    await writeExecutable(path.join(toolBin, 'tmux'), tmuxShimScript({ realTmux, ...shim }));
  } else {
    await symlink(realTmux, path.join(toolBin, 'tmux'));
  }

  const confinedPath = confinedPathFor([fakeBin, toolBin, ...SYSTEM_PATH]);
  const tmuxConfig = path.join(harness, 'tmux.conf');
  // Every pane, including the ones the cockpit splits, runs this. `env` sets
  // PATH explicitly, which tmux's client environment cannot override.
  const defaultCommand = confinedDefaultCommand(confinedPath);
  await writeFile(tmuxConfig, tmuxDefaultCommandConfig(defaultCommand), 'utf8');

  const workPath = path.join(projectRoot, 'uncommitted-work.txt');
  const workBefore = 'the only copy of restart work\n';
  buildDisposableRepository(projectRoot);
  await writeFile(workPath, workBefore, 'utf8');

  const host: ConfinedHost = {
    projectRoot,
    socketPath: path.join(root, 'cockpit.sock'),
    session: cockpitSessionName(projectRoot),
    configPath: path.join(projectRoot, '.psyche', 'psyche.config.json'),
    workPath,
    workBefore,
    fakeBin,
    launchLog,
    entry: resolveCockpitEntry(checkoutRoot),
    defaultCommand,
    env: {
      PATH: confinedPath,
      HOME: home,
      USERPROFILE: home,
      // Agent detection runs `$SHELL -i -c`; a plain sh reads no profile.
      SHELL: '/bin/sh',
      ENV: '',
      LC_ALL: 'C',
      TERM: 'xterm-256color',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    ...(shim ? { shim } : {}),
  };

  // Start the private server on the harness config and prove confinement in
  // a canary pane before the cockpit exists. The config only loads at server
  // start, so this is the launch that must carry it.
  startServer(host, tmuxConfig);
  try {
    const canary = tmux(host.socketPath, 'display-message', '-p', '-t', 'canary', '#{pane_id}');
    if (!probeShowsConfinement(await probeAgents(host.socketPath, canary), fakeBin)) {
      throw new RecoveryAgentConfinementError();
    }
  } catch (error) {
    // The caller never receives this host, so its teardown cannot reach the
    // server: end it here.
    try {
      tmux(host.socketPath, 'kill-server');
    } catch {
      // Already gone.
    }
    throw error instanceof RecoveryAgentConfinementError
      ? error
      : new RecoveryRestartUnavailableError('the canary pane could not be probed');
  }
  return host;
}

/**
 * Asks the cockpit for a terminal pane ([t]) and waits until its record is
 * durable and its pane live. The record therefore carries the cockpit's own
 * pane identity and tmux server generation. Presses are retried because the
 * first-run primer or a loading cockpit can swallow one; a retry happens only
 * while no new record has appeared.
 */
async function createTerminalPaneThroughCockpit(
  host: ConfinedHost,
): Promise<{ paneId: string; recordId: string } | undefined> {
  const recordsBefore = new Set(
    paneRecords(await readFileOrUndefined(host.configPath)).map((record) => record.id),
  );
  let created: { paneId: string; recordId: string } | undefined;
  const findCreated = async (): Promise<boolean> => {
    const record = paneRecords(await readFileOrUndefined(host.configPath))
      .find((candidate) => !recordsBefore.has(candidate.id));
    if (typeof record?.id === 'string' && typeof record.paneId === 'string') {
      created = { paneId: record.paneId, recordId: record.id };
    }
    return created !== undefined;
  };
  for (let attempt = 0; attempt < CRASH_PRESS_LIMIT && !created; attempt += 1) {
    const target = cockpitPane(host.socketPath, host.session);
    if (!target) break;
    tmux(host.socketPath, 'send-keys', '-t', target, 't');
    await waitFor(findCreated, CRASH_REACH_TIMEOUT_MS);
  }
  return created && listPaneIds(host.socketPath, host.session).includes(created.paneId)
    ? created
    : undefined;
}

function startServer(host: ConfinedHost, tmuxConfig: string): void {
  try {
    execFileSync(
      'tmux',
      ['-S', host.socketPath, '-f', tmuxConfig, 'new-session', '-d', '-s', 'canary', '-x', '120', '-y', '30'],
      { stdio: ['ignore', 'ignore', 'ignore'], timeout: 5_000, env: host.env },
    );
  } catch {
    throw new RecoveryRestartUnavailableError('the private tmux server could not be started');
  }
}

/** The canary has served its purpose once the cockpit session holds the server. */
function dropCanary(socketPath: string): void {
  try {
    tmux(socketPath, 'kill-session', '-t', 'canary');
  } catch {
    // Already gone.
  }
}

/**
 * Types a probe into the pane's shell that writes `ok` plus every path
 * `command -v` resolves for the agent names into a pane option. Only shell
 * builtins and `tmux` run; no agent name is ever executed.
 */
export async function probeAgents(socketPath: string, paneId: string): Promise<string | undefined> {
  const names = CONFINED_AGENT_NAMES.join(' ');
  tmux(
    socketPath,
    'send-keys', '-t', paneId,
    `r=ok; for c in ${names}; do p=$(command -v "$c") && r="$r:$p"; done; `
      + `tmux set-option -p -t "$TMUX_PANE" ${PROBE_OPTION} "$r"`,
    'Enter',
  );
  let value: string | undefined;
  await waitFor(() => {
    try {
      value = tmux(socketPath, 'show-options', '-p', '-v', '-t', paneId, PROBE_OPTION) || undefined;
    } catch {
      value = undefined;
    }
    return value !== undefined;
  }, PROBE_TIMEOUT_MS);
  return value;
}

/**
 * A detached session keeps the launch size, and the cockpit's sidebar and
 * welcome panes leave no room to split at 200x50 ("no space for a new pane").
 * A larger window is what an operator's terminal provides.
 */
async function makeRoomForPanes(host: ConfinedHost): Promise<void> {
  // Let the first run finish laying out its welcome pane before resizing.
  await delay(LAYOUT_SETTLE_MS);
  try {
    tmux(host.socketPath, 'resize-window', '-t', host.session, '-x', '320', '-y', '80');
  } catch {
    // The split then fails visibly and the setup control reports it.
  }
  // The cockpit re-lays out its sidebar and welcome panes on resize.
  await delay(1_000);
}

async function quitCockpit(socketPath: string, session: string): Promise<boolean> {
  let quit = false;
  for (let attempt = 0; attempt < QUIT_PRESS_LIMIT && !quit; attempt += 1) {
    sendQuit(socketPath, session);
    quit = await waitFor(() => cockpitPane(socketPath, session) === undefined, QUIT_CONFIRM_WINDOW_MS);
  }
  return quit;
}

export type RelaunchDecision = 'relaunch-into-session' | 'launch-on-confined-server' | 'refuse';

/**
 * Decides how the cockpit may be started again. A new session is only ever
 * opened on the **same** private server, and only when that server still
 * reports the confined `default-command` it was started with. If the server
 * has exited, `launchCockpit` would start a fresh one without the harness
 * config, whose panes run the default login shell — on macOS `path_helper`
 * then adds `/usr/local/bin` and `/etc/paths.d`, and an agent command typed by
 * the cockpit could reach a real CLI. That case is refused, never launched.
 */
export function decideRelaunch(state: {
  sessionExists: boolean;
  /** The live server's global `default-command`, or undefined when no server answers. */
  serverDefaultCommand: string | undefined;
  confinedDefaultCommand: string;
}): RelaunchDecision {
  if (state.serverDefaultCommand !== state.confinedDefaultCommand) return 'refuse';
  return state.sessionExists ? 'relaunch-into-session' : 'launch-on-confined-server';
}

/**
 * Starts the cockpit again on the confined server. Throws
 * {@link RecoveryRestartUnavailableError} rather than launch on a server whose
 * confinement it cannot verify; returns false when an allowed launch failed.
 */
export function startAgain(
  host: Pick<ConfinedHost, 'socketPath' | 'session' | 'projectRoot' | 'entry' | 'env' | 'defaultCommand'>,
  launchers: {
    relaunch: typeof relaunchCockpit;
    launch: typeof launchCockpit;
    readServerDefaultCommand: (socketPath: string) => string | undefined;
    hasSession: typeof sessionExists;
  } = {
    relaunch: relaunchCockpit,
    launch: launchCockpit,
    readServerDefaultCommand: serverDefaultCommand,
    hasSession: sessionExists,
  },
): boolean {
  const options = {
    socketPath: host.socketPath,
    session: host.session,
    projectRoot: host.projectRoot,
    entry: host.entry,
    env: host.env,
  };
  const decision = decideRelaunch({
    sessionExists: launchers.hasSession(host.socketPath, host.session),
    serverDefaultCommand: launchers.readServerDefaultCommand(host.socketPath),
    confinedDefaultCommand: host.defaultCommand,
  });
  if (decision === 'refuse') {
    throw new RecoveryRestartUnavailableError(
      'the private tmux server is gone or no longer confined, so the cockpit was not relaunched',
    );
  }
  try {
    if (decision === 'relaunch-into-session') {
      launchers.relaunch(options);
    } else {
      launchers.launch(options);
    }
    return true;
  } catch {
    return false;
  }
}

function serverDefaultCommand(socketPath: string): string | undefined {
  try {
    return tmux(socketPath, 'show-options', '-g', '-v', 'default-command') || undefined;
  } catch {
    return undefined;
  }
}

async function waitForRestore(host: ConfinedHost): Promise<boolean> {
  return waitFor(
    async () => cockpitPane(host.socketPath, host.session) !== undefined
      && (await readPersistedWorkspace(host.configPath)) !== undefined,
    STARTUP_TIMEOUT_MS,
  );
}

async function teardown(host: ConfinedHost | undefined): Promise<void> {
  if (!host) return;
  if (host.shim) {
    await writeFile(host.shim.releasePath, '', 'utf8').catch(() => undefined);
  }
  try {
    tmux(host.socketPath, 'kill-server');
  } catch {
    // A server that already exited is the intended end state.
  }
  // kill-server hangs up every pane; a fake agent that somehow survived it is
  // still ours to end. Only a process still running the fake's own command is
  // signalled, so a recycled pid is never touched.
  for (const pid of await launchedAgentPids(host.launchLog)) {
    if (processCommand(pid).includes(`sleep ${FAKE_AGENT_LIFETIME_S}`)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
  await waitFor(() => countCockpitPanes(host.socketPath, host.session) === 0, TEARDOWN_TIMEOUT_MS);
  await delay(TEARDOWN_SETTLE_MS);
}

// ---------------------------------------------------------------------------
// Crash mid-transition
// ---------------------------------------------------------------------------

export type CrashTransitionOutcome =
  | 'completed'
  | 'rolled_back'
  | 'recovery_required'
  | 'unsettled';

export interface CrashMidTransitionObservation {
  /** Setup control: the first launch reached a persisted workspace. */
  readonly firstRunReachedWorkspace: boolean;
  /**
   * Setup control: a terminal pane was created and persisted through the
   * cockpit before the crash, so the config has a record whose survival the
   * relaunch must prove.
   */
  readonly durablePaneSeeded: boolean;
  /**
   * Setup control: at kill time the reservation was durable and provisional,
   * the split pane existed, and the config held no record for it — the
   * transition was genuinely in flight.
   */
  readonly transitionInFlightAtKill: boolean;
  /** The SIGKILL ended the cockpit process. */
  readonly crashEndedCockpit: boolean;
  readonly restartRestoredWorkspace: boolean;
  /**
   * The config is readable, names the same project and keeps every pane record
   * it held at the crash — or, when unreadable, its bytes are untouched.
   */
  readonly configNotSilentlyOverwritten: boolean;
  /** No pane record id or tmux pane id is recorded twice. */
  readonly noDuplicatePanes: boolean;
  readonly noDuplicateWorktrees: boolean;
  readonly noDuplicateSessions: boolean;
  readonly noDuplicateCockpits: boolean;
  readonly workPreserved: boolean;
  /** How the restart settled the half-done pane creation. */
  readonly transitionOutcome: CrashTransitionOutcome;
  /**
   * After several polling cycles the orphaned pane is reported exactly once —
   * one recovery marker and one quarantine record naming it — when the outcome
   * is `recovery_required`, and not at all otherwise (#516).
   */
  readonly orphanReportedOnce: boolean;
}

/**
 * Launches the cockpit under `root`, freezes it inside a terminal pane
 * creation, SIGKILLs it, relaunches, and reports how the half-done transition
 * was settled. `root` must be disposable and outside this checkout.
 */
export async function observeCrashMidTransition(
  root: string,
): Promise<CrashMidTransitionObservation> {
  let host: ConfinedHost | undefined;
  try {
    host = await prepareConfinedHost(root, { shimTmux: true });
    const shim = host.shim!;
    launchCockpit({ ...host });
    dropCanary(host.socketPath);
    const firstRunReachedWorkspace = await driveFirstRun(host.socketPath, host.session, host.configPath);
    if (!firstRunReachedWorkspace) return crashUnobserved({ firstRunReachedWorkspace });
    await makeRoomForPanes(host);

    // Seed one durable pane record through the cockpit's own [t] path before
    // arming. Without it the config holds no records at the crash, and the
    // claim that the relaunch kept them would compare an empty set.
    const seeded = await createTerminalPaneThroughCockpit(host);
    if (!seeded) return crashUnobserved({ firstRunReachedWorkspace });
    // Let the seeded creation finish its own pane-path queries before the shim
    // is armed, so they cannot consume the one-shot freeze.
    await delay(LAYOUT_SETTLE_MS);
    // A person presses [t] with the sidebar focused. After the seeded creation
    // a squeezed welcome pane can be the active one, and the cockpit's
    // untargeted split then fails with "no space for a new pane".
    const sidebar = cockpitPane(host.socketPath, host.session);
    if (sidebar) safeTmux(host.socketPath, 'select-pane', '-t', sidebar);

    const worktreesBefore = listManagedWorktrees(host.projectRoot);
    const panesBefore = new Set(listPaneIds(host.socketPath, host.session));

    // Arm the shim and ask for a terminal pane. A press can be swallowed by
    // the first-run primer or while the cockpit is still loading, so retry —
    // but only while no creation has started, so a retry can never start a
    // second one.
    await writeFile(shim.armPath, '', 'utf8');
    let reached = false;
    for (let attempt = 0; attempt < CRASH_PRESS_LIMIT && !reached; attempt += 1) {
      const target = cockpitPane(host.socketPath, host.session);
      if (!target) break;
      tmux(host.socketPath, 'send-keys', '-t', target, 't');
      reached = await waitFor(() => existsSync(shim.reachedPath), CRASH_REACH_TIMEOUT_MS);
      // A durable reservation means a creation started without reaching the
      // shim; pressing again could start a second one.
      const started = (await readPaneSlugOwnershipRecords(host.projectRoot).catch(() => undefined))
        ?.records.some((record) => record.operation === 'terminal-pane');
      if (!reached && started !== false) break;
    }
    if (!reached) return crashUnobserved({ firstRunReachedWorkspace, durablePaneSeeded: true });

    // Confirm on disk that this is the in-flight state the scenario claims.
    const splitPanes = listPaneIds(host.socketPath, host.session).filter((id) => !panesBefore.has(id));
    const reservations = await readPaneSlugOwnershipRecords(host.projectRoot).catch(() => undefined);
    const inFlight = reservations?.records.find((record) => (
      record.state === 'provisional'
      && record.pane.paneId !== undefined
      && splitPanes.includes(record.pane.paneId)
    ));
    const configAtKill = await readFileOrUndefined(host.configPath);
    const recordsAtKill = paneRecords(configAtKill);
    const transitionInFlightAtKill = inFlight !== undefined
      && !recordsAtKill.some((record) => record.paneId === inFlight.pane.paneId);

    // SIGKILL the cockpit itself, then end the frozen shim so it cannot
    // resume a query on the cockpit's behalf after the crash.
    const cockpitPid = cockpitProcessPid(host.socketPath, host.session);
    if (cockpitPid !== undefined) {
      try {
        process.kill(cockpitPid, 'SIGKILL');
      } catch {
        // Recorded by the liveness check below.
      }
    }
    const shimPid = Number.parseInt((await readFileOrUndefined(shim.reachedPath)) ?? '', 10);
    if (Number.isInteger(shimPid) && shimPid > 0) {
      try {
        process.kill(shimPid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    const crashEndedCockpit = cockpitPid !== undefined && await waitFor(
      () => !processAlive(cockpitPid) && cockpitPane(host!.socketPath, host!.session) === undefined,
      TEARDOWN_TIMEOUT_MS,
    );

    const relaunched = startAgain(host);
    const restartRestoredWorkspace = relaunched && await waitForRestore(host);

    // Give reconciliation a bounded window to settle the orphaned creation.
    const orphanPaneId = inFlight?.pane.paneId;
    const settle = async (): Promise<CrashTransitionOutcome> => settleOutcome(host!, inFlight);
    if (restartRestoredWorkspace) {
      await waitFor(async () => (await settle()) !== 'unsettled', SETTLE_TIMEOUT_MS);
      await delay(Math.max(POST_RESTORE_OBSERVATION_MS, ORPHAN_REPORT_OBSERVATION_MS));
    }
    const transitionOutcome = inFlight ? await settle() : 'unsettled';
    const markersAfter = await readWorktreeRecoveryMarkers(host.projectRoot).catch(() => undefined);
    const reservationsAfter = await readPaneSlugOwnershipRecords(host.projectRoot).catch(() => undefined);
    const orphanReportedOnce = orphanPaneId !== undefined
      && markersAfter !== undefined
      && reservationsAfter !== undefined
      && orphanReportedExactlyOnce(
        orphanPaneId,
        transitionOutcome,
        markersAfter.markers,
        reservationsAfter.records,
      );

    const configAfter = await readFileOrUndefined(host.configPath);
    const after = await readPersistedWorkspace(host.configPath);
    const recordsAfter = paneRecords(configAfter);
    // Load-bearing only because a record was seeded: an empty set at the kill
    // would make "kept every record" vacuous, so it fails instead.
    const configNotSilentlyOverwritten = recordsAtKill.length > 0
      && recordsAtKill.some((record) => record.id === seeded.recordId)
      && (after !== undefined
        ? after.projectRoot === host.projectRoot
          && recordsAtKill.every((record) => recordsAfter.some((candidate) => (
            candidate.id === record.id && candidate.paneId === record.paneId
          )))
        : configAfter === configAtKill);

    const ids = recordsAfter.map((record) => record.id);
    const tmuxIds = recordsAfter.map((record) => record.paneId);
    return {
      firstRunReachedWorkspace,
      durablePaneSeeded: true,
      transitionInFlightAtKill,
      crashEndedCockpit,
      restartRestoredWorkspace,
      configNotSilentlyOverwritten,
      noDuplicatePanes: new Set(ids).size === ids.length
        && new Set(tmuxIds).size === tmuxIds.length
        && (orphanPaneId === undefined || tmuxIds.filter((id) => id === orphanPaneId).length <= 1),
      noDuplicateWorktrees: listManagedWorktrees(host.projectRoot) === worktreesBefore,
      noDuplicateSessions: countSessions(host.socketPath, host.session) === 1,
      noDuplicateCockpits: countCockpitPanes(host.socketPath, host.session) === 1,
      workPreserved: await readFileOrUndefined(host.workPath) === host.workBefore,
      transitionOutcome,
      orphanReportedOnce,
    };
  } finally {
    await teardown(host);
  }
}

/**
 * Classifies how the restart left the crashed creation. `recovery_required`
 * wins: a restart-reconciliation marker for this reservation means an
 * operator must act, whatever else happened. Otherwise the creation either
 * completed (one durable record, live pane, reservation settled) or rolled
 * back (pane gone, no record, reservation settled).
 */
async function settleOutcome(
  host: ConfinedHost,
  inFlight: { recoveryId: string; pane: { paneId?: string } } | undefined,
): Promise<CrashTransitionOutcome> {
  if (!inFlight?.pane.paneId) return 'unsettled';
  const paneId = inFlight.pane.paneId;
  const markers = await readWorktreeRecoveryMarkers(host.projectRoot).catch(() => undefined);
  if (markers?.markers.some((marker) => (
    marker.recoveryId === inFlight.recoveryId
    && marker.operation.endsWith('-restart-reconciliation')
  ))) {
    return 'recovery_required';
  }
  const reservations = await readPaneSlugOwnershipRecords(host.projectRoot).catch(() => undefined);
  if (!reservations) return 'unsettled';
  const stillReserved = reservations.records.some((record) => record.recoveryId === inFlight.recoveryId);
  if (stillReserved) return 'unsettled';
  const records = paneRecords(await readFileOrUndefined(host.configPath));
  const recorded = records.filter((record) => record.paneId === paneId).length;
  const alive = listPaneIds(host.socketPath, host.session).includes(paneId);
  if (recorded === 1 && alive) return 'completed';
  if (recorded === 0 && !alive) return 'rolled_back';
  return 'unsettled';
}

/**
 * A `recovery_required` orphan must be named by exactly one recovery marker and
 * one quarantine record however many polling cycles have seen it; a completed
 * or rolled-back creation must leave none. Any other ownership record still
 * naming the pane counts against it.
 */
export function orphanReportedExactlyOnce(
  orphanPaneId: string,
  outcome: CrashTransitionOutcome,
  markers: readonly Pick<WorktreeRecoveryMarker, 'pane'>[],
  records: readonly Pick<PaneSlugOwnershipRecord, 'state' | 'pane'>[],
): boolean {
  const naming = markers.filter((marker) => marker.pane.paneId === orphanPaneId).length;
  const owning = records.filter((record) => record.pane.paneId === orphanPaneId);
  const quarantined = owning.filter((record) => record.state === 'quarantined').length;
  if (outcome === 'recovery_required') {
    return naming === 1 && quarantined === 1 && owning.length === 1;
  }
  if (outcome === 'completed' || outcome === 'rolled_back') {
    return naming === 0 && owning.length === 0;
  }
  return false;
}

function crashUnobserved(
  partial: Partial<CrashMidTransitionObservation>,
): CrashMidTransitionObservation {
  return {
    firstRunReachedWorkspace: false,
    durablePaneSeeded: false,
    transitionInFlightAtKill: false,
    crashEndedCockpit: false,
    restartRestoredWorkspace: false,
    configNotSilentlyOverwritten: false,
    noDuplicatePanes: false,
    noDuplicateWorktrees: false,
    noDuplicateSessions: false,
    noDuplicateCockpits: false,
    workPreserved: false,
    transitionOutcome: 'unsettled',
    orphanReportedOnce: false,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Restart with a live agent pane
// ---------------------------------------------------------------------------

export interface LiveAgentRestartObservation {
  readonly firstRunReachedWorkspace: boolean;
  /** Setup control: the agent pane's own shell proved it was confined. */
  readonly agentPaneConfined: boolean;
  /** Setup control: the fake agent started exactly once and is running. */
  readonly agentRunningBeforeQuit: boolean;
  /** Setup control: the cockpit created and persisted the pane the agent runs in. */
  readonly paneCreatedBeforeQuit: boolean;
  readonly quitEndedCockpitProcess: boolean;
  /** The pane and its agent outlived the cockpit, as live panes must. */
  readonly agentSurvivedQuit: boolean;
  readonly restartRestoredWorkspace: boolean;
  /** Exactly one record keeps the pane's identity and is bound to the live pane. */
  readonly agentPaneRebound: boolean;
  /** The fake agent was launched once in the whole run, never again by the restart. */
  readonly agentNotDuplicated: boolean;
  /** The original agent process is alive and still a child of its pane. */
  readonly agentNotOrphaned: boolean;
  readonly noDuplicateWorktrees: boolean;
  readonly noDuplicateSessions: boolean;
  readonly noDuplicateCockpits: boolean;
  readonly workPreserved: boolean;
}

/**
 * Starts a fake agent in a pane the cockpit created, quits and relaunches the
 * cockpit, and checks the pane and its process were rebound rather than
 * recreated, duplicated or orphaned. `root` must be disposable.
 */
export async function observeLiveAgentRestart(
  root: string,
): Promise<LiveAgentRestartObservation> {
  let host: ConfinedHost | undefined;
  try {
    host = await prepareConfinedHost(root, { shimTmux: false });
    launchCockpit({ ...host });
    dropCanary(host.socketPath);
    const firstRunReachedWorkspace = await driveFirstRun(host.socketPath, host.session, host.configPath);
    if (!firstRunReachedWorkspace) return liveUnobserved({ firstRunReachedWorkspace });
    await makeRoomForPanes(host);

    const worktreePath = path.join(host.projectRoot, '.psyche', 'worktrees', SEEDED_WORKTREE_BRANCH);
    const worktreesBefore = listManagedWorktrees(host.projectRoot);
    // The cockpit creates the pane through its own transactional path ([t]),
    // so the record carries the cockpit's real pane identity and tmux server
    // generation. Its shell is the server's confined default command.
    const created = await createTerminalPaneThroughCockpit(host);
    const agentPane = created?.paneId;
    const paneRecordId = created?.recordId;
    const paneCreatedBeforeQuit = created !== undefined;
    if (!agentPane || !paneCreatedBeforeQuit) {
      return liveUnobserved({ firstRunReachedWorkspace, paneCreatedBeforeQuit });
    }

    // Mandatory: the pane's own shell must resolve the agent names only into
    // the fake directory before anything is typed into it. Nothing has been
    // typed into this pane yet.
    const agentPaneConfined = probeShowsConfinement(
      await probeAgents(host.socketPath, agentPane),
      host.fakeBin,
      ['claude'],
    );
    if (!agentPaneConfined) throw new RecoveryAgentConfinementError();

    tmux(host.socketPath, 'send-keys', '-t', agentPane, `cd ${shellQuote(worktreePath)} && claude`, 'Enter');
    const agentRunningBeforeQuit = await waitFor(
      async () => (await launchedAgentPids(host!.launchLog)).length === 1
        && paneCommand(host!.socketPath, agentPane!) === 'sleep'
        && safeTmux(host!.socketPath, 'capture-pane', '-p', '-t', agentPane!).includes(FAKE_AGENT_MARKER),
      AGENT_START_TIMEOUT_MS,
    );
    const [agentPid] = await launchedAgentPids(host.launchLog);
    if (!agentRunningBeforeQuit || agentPid === undefined) {
      return liveUnobserved({
        firstRunReachedWorkspace,
        paneCreatedBeforeQuit,
        agentPaneConfined,
        agentRunningBeforeQuit,
      });
    }

    const quitEndedCockpitProcess = await quitCockpit(host.socketPath, host.session);
    const agentSurvivedQuit = listPaneIds(host.socketPath, host.session).includes(agentPane)
      && processAlive(agentPid);

    // Give the cockpit's record the shape an agent worktree pane has. Written
    // rather than created through the interface because the agent-pane flow
    // needs a tmux popup, which a detached harness session cannot drive. The
    // id, pane id and tmux server identity are the cockpit's own, so the
    // restart sees a live agent pane it previously owned — the case where a
    // wrong "recreate" would start a second agent.
    await promoteToAgentWorktreePane(host.configPath, paneRecordId!, worktreePath);
    try {
      tmux(host.socketPath, 'select-pane', '-t', agentPane, '-T', SEEDED_WORKTREE_BRANCH);
    } catch {
      // The title is a rebinding hint only; the pane id is still current.
    }

    const relaunched = startAgain(host);
    const restartRestoredWorkspace = relaunched && await waitForRestore(host);
    if (restartRestoredWorkspace) await delay(POST_RESTORE_OBSERVATION_MS);

    const records = paneRecords(await readFileOrUndefined(host.configPath));
    const withId = records.filter((record) => record.id === paneRecordId);
    const livePanes = listPaneIds(host.socketPath, host.session);
    const panePid = Number.parseInt(
      safeTmux(host.socketPath, 'display-message', '-p', '-t', agentPane, '#{pane_pid}'),
      10,
    );
    return {
      firstRunReachedWorkspace,
      agentPaneConfined,
      agentRunningBeforeQuit,
      paneCreatedBeforeQuit,
      quitEndedCockpitProcess,
      agentSurvivedQuit,
      restartRestoredWorkspace,
      agentPaneRebound: withId.length === 1
        && withId[0].paneId === agentPane
        && livePanes.includes(agentPane)
        && records.filter((record) => record.paneId === agentPane).length === 1,
      agentNotDuplicated: (await launchedAgentPids(host.launchLog)).length === 1
        && livePanes.filter((id) => paneCommand(host!.socketPath, id) === 'sleep').length === 1,
      agentNotOrphaned: processAlive(agentPid) && parentPid(agentPid) === panePid,
      noDuplicateWorktrees: listManagedWorktrees(host.projectRoot) === worktreesBefore,
      noDuplicateSessions: countSessions(host.socketPath, host.session) === 1,
      noDuplicateCockpits: countCockpitPanes(host.socketPath, host.session) === 1,
      workPreserved: await readFileOrUndefined(host.workPath) === host.workBefore,
    };
  } finally {
    await teardown(host);
  }
}

function liveUnobserved(
  partial: Partial<LiveAgentRestartObservation>,
): LiveAgentRestartObservation {
  return {
    firstRunReachedWorkspace: false,
    agentPaneConfined: false,
    agentRunningBeforeQuit: false,
    paneCreatedBeforeQuit: false,
    quitEndedCockpitProcess: false,
    agentSurvivedQuit: false,
    restartRestoredWorkspace: false,
    agentPaneRebound: false,
    agentNotDuplicated: false,
    agentNotOrphaned: false,
    noDuplicateWorktrees: false,
    noDuplicateSessions: false,
    noDuplicateCockpits: false,
    workPreserved: false,
    ...partial,
  };
}

async function promoteToAgentWorktreePane(
  configPath: string,
  paneRecordId: string,
  worktreePath: string,
): Promise<void> {
  const record = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  const panes = Array.isArray(record.panes) ? record.panes as Array<Record<string, unknown>> : [];
  for (const pane of panes) {
    if (pane.id !== paneRecordId) continue;
    pane.type = 'worktree';
    pane.agent = 'claude';
    pane.slug = SEEDED_WORKTREE_BRANCH;
    pane.branchName = SEEDED_WORKTREE_BRANCH;
    pane.worktreePath = worktreePath;
    pane.prompt = '';
    delete pane.shellType;
  }
  await writeFile(configPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function paneRecords(config: string | undefined): Array<{ id: unknown; paneId: unknown }> {
  if (config === undefined) return [];
  try {
    const parsed = JSON.parse(config) as { panes?: unknown };
    return Array.isArray(parsed.panes)
      ? parsed.panes.filter((pane): pane is { id: unknown; paneId: unknown } => (
        typeof pane === 'object' && pane !== null
      ))
      : [];
  } catch {
    return [];
  }
}

function listPaneIds(socketPath: string, session: string): string[] {
  return safeTmux(socketPath, 'list-panes', '-s', '-t', session, '-F', '#{pane_id}')
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

function paneCommand(socketPath: string, paneId: string): string {
  return safeTmux(socketPath, 'display-message', '-p', '-t', paneId, '#{pane_current_command}');
}

/** The cockpit's own process: its pane's process, which runs node directly. */
function cockpitProcessPid(socketPath: string, session: string): number | undefined {
  const pane = cockpitPane(socketPath, session);
  if (!pane) return undefined;
  const pid = Number.parseInt(safeTmux(socketPath, 'display-message', '-p', '-t', pane, '#{pane_pid}'), 10);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return /node|tsx/u.test(processCommand(pid)) ? pid : undefined;
}

function safeTmux(socketPath: string, ...args: string[]): string {
  try {
    return tmux(socketPath, ...args);
  } catch {
    return '';
  }
}

async function launchedAgentPids(launchLog: string): Promise<number[]> {
  const content = await readFileOrUndefined(launchLog);
  if (!content) return [];
  return content
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processCommand(pid: number): string {
  return psField(pid, 'command=');
}

function parentPid(pid: number): number {
  return Number.parseInt(psField(pid, 'ppid='), 10);
}

function psField(pid: number, field: string): string {
  try {
    return execFileSync('/bin/ps', ['-o', field, '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
  } catch {
    return '';
  }
}

function resolveHostTool(tool: string): string {
  try {
    const resolved = execFileSync('/bin/sh', ['-c', `command -v ${tool}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
    if (!resolved.startsWith('/')) throw new Error('not a path');
    return resolved;
  } catch {
    throw new RecoveryRestartUnavailableError(`${tool} is not installed`);
  }
}

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content, 'utf8');
  await chmod(filePath, 0o755);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const CRASH_OUTCOME_CLASSIFICATION: Readonly<Record<CrashTransitionOutcome, RecoveryClassification>> = {
  completed: 'transition_completed',
  rolled_back: 'transition_rolled_back',
  recovery_required: 'recovery_required',
  unsettled: 'unexpected_error',
};

/**
 * Classifies from what was observed, in order: no first workspace or no
 * restored relaunch is an unavailable restart; no seeded record or no
 * in-flight transition is an ineffective injection; only then does the
 * settled outcome name the result.
 */
export function classifyCrashMidTransition(
  observed: CrashMidTransitionObservation,
): RecoveryClassification {
  if (!observed.firstRunReachedWorkspace) return 'restart_unavailable';
  if (!observed.durablePaneSeeded || !observed.transitionInFlightAtKill) return 'injection_ineffective';
  if (!observed.restartRestoredWorkspace) return 'restart_unavailable';
  return CRASH_OUTCOME_CLASSIFICATION[observed.transitionOutcome];
}

/**
 * `workspace_restored` only when the agent was running before the quit and
 * the relaunch actually restored the workspace; an early return or a failed
 * relaunch never carries that label.
 */
export function classifyLiveAgentRestart(
  observed: LiveAgentRestartObservation,
): RecoveryClassification {
  if (!observed.firstRunReachedWorkspace) return 'restart_unavailable';
  if (!observed.paneCreatedBeforeQuit || !observed.agentRunningBeforeQuit) return 'injection_ineffective';
  if (!observed.restartRestoredWorkspace) return 'restart_unavailable';
  return 'workspace_restored';
}
