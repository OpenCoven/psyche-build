/**
 * Application restart observation for the #199 recovery harness.
 *
 * #199 lists application restart first, and no scenario has covered it: the
 * restart-adjacent scenarios reopen the control journal or construct a
 * restarted owner epoch in process. This one launches the real cockpit,
 * completes first-run onboarding, quits it the way a person does, relaunches
 * it, and asserts the workspace comes back without duplicating the projects,
 * panes, tmux sessions, or worktrees it restored.
 *
 * It is deliberately **not** part of the default harness run. Two real
 * application launches cost tens of seconds and depend on onboarding prompt
 * text, which is a flake surface no required check should carry. It is opt-in
 * through `pnpm recovery:restart`, the same shape as `PSYCHE_AGENT_CHECK_IOS`.
 *
 * Safety, learned the hard way: the cockpit adopts its working directory as
 * the project root. A launch whose cwd is the repository checkout will adopt
 * the checkout and rewrite its `.psyche` state. {@link assertDisposableRoot}
 * refuses to launch anywhere at or beneath this checkout, so that failure mode
 * is impossible rather than merely avoided by convention.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

/** Raised when the host cannot run the cockpit, so nothing was observed. */
export class RecoveryRestartUnavailableError extends Error {
  constructor(reason: string) {
    super(`Application restart could not be observed: ${reason}`);
  }
}

const POLL_INTERVAL_MS = 250;
const STARTUP_TIMEOUT_MS = 90_000;
/**
 * The cockpit confirms on one Ctrl+C and exits on the next, but the interface
 * can consume a press, so the quit retries within a bound instead of assuming
 * a fixed count. The window stays under the cockpit's three-second confirm
 * timeout so consecutive presses land in the same confirmation.
 */
const QUIT_PRESS_LIMIT = 5;
const QUIT_CONFIRM_WINDOW_MS = 2_000;
const TMUX_TIMEOUT_MS = 5_000;
/** A managed worktree seeded before the first launch, for the restart to find. */
const SEEDED_WORKTREE_BRANCH = 'seeded';
/** Bounded wait for the cockpit to finish creating its terminal pane. */
/** Teardown must outlive the cockpit, or disposal races its last writes. */
const RESTORE_SETTLE_TIMEOUT_MS = 30_000;
const TEARDOWN_TIMEOUT_MS = 10_000;
const TEARDOWN_SETTLE_MS = 500;

export interface ApplicationRestartObservation {
  /** Setup control: the first launch reached a persisted workspace. */
  readonly firstRunReachedWorkspace: boolean;
  /**
   * Setup control: a worktree-pane record was seeded before the restart.
   * Without it the restart has nothing to restore and the duplication checks
   * compare zero against zero.
   */
  readonly paneCreatedBeforeQuit: boolean;
  /** A normal quit ended the cockpit process. */
  readonly quitEndedCockpitProcess: boolean;
  /**
   * Whether the managed tmux session outlived the quit. Recorded, deliberately
   * not asserted: it depends on whether managed panes exist. A cockpit whose
   * own pane is the last one takes the session with it — which is exactly what
   * `pnpm smoke` documents and relies on — while one with live panes leaves
   * them running. This fixture creates no panes, so either is correct and the
   * restart must handle both.
   */
  readonly sessionSurvivedQuit: boolean;
  /**
   * The cockpit is running again against a readable workspace. The persisted
   * config outlives the quit, so its readability alone proves nothing.
   */
  readonly restartRestoredWorkspace: boolean;
  /** The restored project identity is the one that was persisted. */
  readonly projectIdentityStable: boolean;
  /** Restart did not duplicate the projects it restored. */
  readonly noDuplicateProjects: boolean;
  /** Restart did not duplicate the panes it restored. */
  readonly noDuplicatePanes: boolean;
  /** Exactly one cockpit session for this project exists after the restart. */
  readonly noDuplicateSessions: boolean;
  /** Restart did not duplicate or discard managed worktrees. */
  readonly noDuplicateWorktrees: boolean;
  /**
   * Every pane that existed before the quit is still present by identity, so
   * the restart adopted them rather than recreating them. Load-bearing only
   * because the fixture creates a real pane first.
   */
  readonly noDuplicateManagedPanes: boolean;
  /** Exactly one cockpit process is running after the restart, not two. */
  readonly noDuplicateLivePanes: boolean;
  /** The only copy of uncommitted work in the project is byte-identical. */
  readonly workPreserved: boolean;
}

/**
 * Refuses any project root at or beneath this checkout.
 *
 * The cockpit adopts its working directory as its project and rewrites that
 * project's `.psyche` state on startup. Launching it against the checkout
 * would mutate the developer's real workspace, so this is a hard guard rather
 * than a comment: exported for its own test.
 */
export function assertDisposableRoot(projectRoot: string, checkoutRoot: string): void {
  const relative = path.relative(path.resolve(checkoutRoot), path.resolve(projectRoot));
  const insideCheckout = relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  if (insideCheckout) {
    throw new RecoveryRestartUnavailableError(
      'the project root is inside the repository checkout, which the cockpit would rewrite',
    );
  }
}

/** The session name the cockpit derives for a project root. */
export function cockpitSessionName(projectRoot: string): string {
  const projectName = path.basename(projectRoot);
  const hash = createHash('md5').update(projectRoot).digest('hex').slice(0, 8);
  return `psyche-${`${projectName}-${hash}`.replace(/\./g, '-')}`;
}

interface PersistedWorkspace {
  readonly projectRoot: unknown;
  readonly projectName: unknown;
  readonly paneCount: number;
  readonly sidebarProjectCount: number;
}

/**
 * Launches, quits and relaunches the real cockpit under `root`, which must be
 * a disposable directory outside this checkout. The caller owns `root`.
 */
export async function observeApplicationRestart(
  root: string,
): Promise<ApplicationRestartObservation> {
  const checkoutRoot = fileURLToPath(new URL('../../', import.meta.url));
  const projectRoot = path.join(root, 'project');
  assertDisposableRoot(projectRoot, checkoutRoot);

  const home = path.join(root, 'home');
  const socketPath = path.join(root, 'cockpit.sock');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(home, { recursive: true });

  const entry = resolveCockpitEntry(checkoutRoot);
  const session = cockpitSessionName(projectRoot);
  const configPath = path.join(projectRoot, '.psyche', 'psyche.config.json');
  const workPath = path.join(projectRoot, 'uncommitted-work.txt');
  const workBefore = 'the only copy of restart work\n';

  buildDisposableRepository(projectRoot);
  await writeFile(workPath, workBefore, 'utf8');

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    LC_ALL: 'C',
    // Ink bails out of an interactive render without a terminal type.
    TERM: 'xterm-256color',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };

  try {
    // First run: onboarding, then a persisted workspace.
    launchCockpit({ socketPath, session, projectRoot, entry, env });
    const firstRunReachedWorkspace = await driveFirstRun(socketPath, session, configPath);
    if (!firstRunReachedWorkspace) {
      return unobserved(firstRunReachedWorkspace);
    }
    // A real pane, so the restart has something to restore rather than an
    // empty workspace. `t` creates a plain terminal pane through the same
    // transactional path as any other, and needs no agent CLI and no popup.
    const worktreesBefore = listManagedWorktrees(projectRoot);
    // Identities, not a count. A restart that killed these panes and made new
    // ones would keep the count steady while destroying the processes running
    // in them, which is exactly the loss this is meant to catch.

    // Quit the way a person does. The cockpit shows a confirmation on the
    // first Ctrl+C and exits on the second.
    // Quit the way a person does, and keep confirming until it exits.
    //
    // The press count is not fixed. The cockpit confirms on one Ctrl+C and
    // exits on the next, but immediately after a pane is created the first
    // press is consumed by the interface and a third is needed. Assuming two
    // leaves the cockpit running, which a relaunch then turns into a second
    // concurrent cockpit. Bounded so a cockpit that genuinely refuses to quit
    // still fails the invariant rather than looping.
    let quitEndedCockpitProcess = false;
    for (let attempt = 0; attempt < QUIT_PRESS_LIMIT && !quitEndedCockpitProcess; attempt += 1) {
      sendQuit(socketPath, session);
      quitEndedCockpitProcess = await waitFor(
        () => cockpitPane(socketPath, session) === undefined,
        QUIT_CONFIRM_WINDOW_MS,
      );
    }
    // The managed session and its pane processes must outlive the cockpit;
    // that is what a restart is expected to find and restore.
    const sessionSurvivedQuit = sessionExists(socketPath, session);

    // Seed a worktree-pane record into the persisted workspace, so the restart
    // has something to restore rather than an empty one.
    //
    // Written rather than created through the interface deliberately: the
    // product has no non-interactive path that creates a worktree pane, and
    // driving the cockpit's own shortcuts is unreliable — it gates them on
    // pane focus and ignores them while loading. This is the persisted format
    // a restart actually reads, which is what #196 asks about.
    const paneSeeded = await seedWorktreePaneRecord(configPath, projectRoot);
    const seededWorkspace = await readPersistedWorkspace(configPath);

    // Restart into the surviving session, which is what relaunching the
    // cockpit against the same project does.
    // A relaunch that cannot start is a failed restart, not a lost run: the
    // observations already made must survive it as evidence. Which form the
    // relaunch takes follows from whether the session outlived the quit.
    let relaunched = true;
    try {
      if (sessionSurvivedQuit) {
        relaunchCockpit({ socketPath, session, projectRoot, entry, env });
      } else {
        launchCockpit({ socketPath, session, projectRoot, entry, env });
      }
    } catch {
      relaunched = false;
    }
    // The persisted config survives the quit, so its mere readability proves
    // nothing about the relaunch. Restoration requires the cockpit process to
    // be running again against a readable workspace.
    const restartRestoredWorkspace = relaunched && await waitFor(
      async () => cockpitPane(socketPath, session) !== undefined
        && (await readPersistedWorkspace(configPath)) !== undefined,
      STARTUP_TIMEOUT_MS,
    );
    // Restoration is asynchronous: the cockpit rewrites its config and
    // recreates the seeded pane after it comes up. Wait for the restored pane
    // to be live rather than sampling once and racing it.
    const restoredPaneLive = await waitFor(
      () => countPanes(socketPath, session) > 1,
      RESTORE_SETTLE_TIMEOUT_MS,
    );
    await delay(1_000);
    const after = await readPersistedWorkspace(configPath);
    const worktreesAfter = listManagedWorktrees(projectRoot);

    return {
      firstRunReachedWorkspace,
      paneCreatedBeforeQuit: paneSeeded,
      quitEndedCockpitProcess,
      sessionSurvivedQuit,
      restartRestoredWorkspace,
      projectIdentityStable: seededWorkspace !== undefined && after !== undefined
        && after.projectRoot === seededWorkspace.projectRoot
        && after.projectName === seededWorkspace.projectName,
      noDuplicateProjects: seededWorkspace !== undefined && after !== undefined
        && after.sidebarProjectCount === seededWorkspace.sidebarProjectCount,
      // Load-bearing because a record was seeded: the restart must restore the
      // one pane, not two, and not none.
      noDuplicatePanes: seededWorkspace !== undefined && after !== undefined
        && seededWorkspace.paneCount === 1 && after.paneCount === 1,
      noDuplicateSessions: countSessions(socketPath, session) === 1,
      // At most the relaunch's own window is added. A restart that recreated
      // the panes it was supposed to adopt would exceed this.
      // The restored pane is live, so the record was adopted rather than left
      // pointing at nothing.
      noDuplicateManagedPanes: restoredPaneLive,
      noDuplicateWorktrees: worktreesAfter === worktreesBefore,
      // The restart did not leave a second cockpit running alongside its own.
      noDuplicateLivePanes: countCockpitPanes(socketPath, session) === 1,
  workPreserved: await readFileOrUndefined(workPath) === workBefore,
    };
  } finally {
    try {
      tmux(socketPath, 'kill-server');
    } catch {
      // A server that already exited is the intended end state.
    }
    // The caller disposes this workspace by removing it. A cockpit still
    // exiting keeps writing into it, and the removal then fails with
    // ENOTEMPTY, losing the run's evidence to a teardown race.
    await waitFor(() => countCockpitPanes(socketPath, session) === 0, TEARDOWN_TIMEOUT_MS);
    await delay(TEARDOWN_SETTLE_MS);
  }
}

function unobserved(firstRunReachedWorkspace: boolean): ApplicationRestartObservation {
  return {
    firstRunReachedWorkspace,
    paneCreatedBeforeQuit: false,
    quitEndedCockpitProcess: false,
    sessionSurvivedQuit: false,
    restartRestoredWorkspace: false,
    projectIdentityStable: false,
    noDuplicateProjects: false,
    noDuplicatePanes: false,
    noDuplicateSessions: false,
    noDuplicateWorktrees: false,
    noDuplicateManagedPanes: false,
    noDuplicateLivePanes: false,
    workPreserved: false,
  };
}

/**
 * Prefers the built entry point and falls back to source, the same way the
 * cleanup supervisor resolves its child. A clean checkout that has not run
 * `pnpm build` still observes a restart.
 */
function resolveCockpitEntry(checkoutRoot: string): { argv: string[] } {
  const compiled = path.join(checkoutRoot, 'dist', 'index.js');
  if (existsSync(compiled)) {
    return { argv: [process.execPath, compiled] };
  }
  const source = path.join(checkoutRoot, 'src', 'index.ts');
  const loader = path.join(checkoutRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs');
  if (!existsSync(source) || !existsSync(loader)) {
    throw new RecoveryRestartUnavailableError('no built or source cockpit entry point was found');
  }
  return { argv: [process.execPath, '--import', loader, source] };
}

function buildDisposableRepository(projectRoot: string): void {
  const git = (...args: string[]): void => {
    try {
      execFileSync('git', args, {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 10_000,
      });
    } catch {
      throw new RecoveryRestartUnavailableError('the disposable repository could not be created');
    }
  };
  git('init', '--quiet');
  git('config', 'user.email', 'recovery@example.invalid');
  git('config', 'user.name', 'Recovery Harness');
  git('config', 'commit.gpgsign', 'false');
  git('commit', '--allow-empty', '--quiet', '-m', 'fixture');
  // A managed worktree the restart must find and neither duplicate nor prune.
  // Without one the worktree comparison comes down to zero against zero.
  git(
    'worktree', 'add', '--quiet', '-b', SEEDED_WORKTREE_BRANCH,
    path.join(projectRoot, '.psyche', 'worktrees', SEEDED_WORKTREE_BRANCH),
  );
}

function launchCockpit(options: {
  socketPath: string;
  session: string;
  projectRoot: string;
  entry: { argv: string[] };
  env: NodeJS.ProcessEnv;
}): void {
  try {
    execFileSync(
      'tmux',
      [
        '-S', options.socketPath,
        // The developer's tmux.conf must not influence the observation.
        '-f', '/dev/null',
        'new-session', '-d',
        '-s', options.session,
        // The cockpit adopts this directory as its project root.
        '-c', options.projectRoot,
        '-x', '200', '-y', '50',
        ...options.entry.argv,
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: TMUX_TIMEOUT_MS,
        env: options.env,
      },
    );
  } catch {
    throw new RecoveryRestartUnavailableError('the cockpit could not be launched under tmux');
  }
}

/**
 * Declines both first-run prompts and waits for the persisted workspace.
 *
 * A disposable HOME has no tmux config and no provider key, so the cockpit
 * offers to write one and then to configure a provider. Declining keeps this
 * an observation of startup and restart rather than of configuration writing.
 */
async function driveFirstRun(
  socketPath: string,
  session: string,
  configPath: string,
): Promise<boolean> {
  const prompts: Array<{ text: string; keys: string[] }> = [
    { text: 'Set up recommended tmux defaults?', keys: ['n'] },
    { text: 'OPENROUTER_API_KEY is not set.', keys: ['n', 'Enter'] },
  ];
  for (const prompt of prompts) {
    const reached = await waitFor(
      () => existsSync(configPath) || capturePane(socketPath, session).includes(prompt.text),
      STARTUP_TIMEOUT_MS,
    );
    if (!reached) return false;
    if (existsSync(configPath)) break;
    tmux(socketPath, 'send-keys', '-t', session, ...prompt.keys);
  }
  return waitFor(
    async () => (await readPersistedWorkspace(configPath)) !== undefined,
    STARTUP_TIMEOUT_MS,
  );
}

async function readPersistedWorkspace(
  configPath: string,
): Promise<PersistedWorkspace | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record.projectRoot !== 'string') return undefined;
    return {
      projectRoot: record.projectRoot,
      projectName: record.projectName,
      paneCount: Array.isArray(record.panes) ? record.panes.length : -1,
      sidebarProjectCount: Array.isArray(record.sidebarProjects)
        ? record.sidebarProjects.length
        : -1,
    };
  } catch {
    // A config observed mid-write is not yet a restored workspace.
    return undefined;
  }
}

/** Managed worktree directory names, as a stable comparable summary. */
function listManagedWorktrees(projectRoot: string): string {
  try {
    return execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: TMUX_TIMEOUT_MS,
    })
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .sort()
      .join('\n');
  } catch {
    return 'unavailable';
  }
}

/**
 * The pane running the cockpit, identified by its process rather than by
 * position: the cockpit creates managed panes of its own, and after it exits
 * one of those becomes the active pane.
 *
 * Scoped to the whole session with `-s`. Without it tmux lists only the
 * current window's panes, and a cockpit relaunched into its own window is
 * invisible — which reads as a restart that never came back.
 */
function cockpitPane(socketPath: string, session: string): string | undefined {
  try {
    return tmux(socketPath, 'list-panes', '-s', '-t', session, '-F', '#{pane_id} #{pane_current_command}')
      .split('\n')
      .find((line) => / node$| tsx$/.test(line))
      ?.split(' ')[0];
  } catch {
    return undefined;
  }
}

/** Sends one quit keystroke, tolerating a pane that has already closed. */
function sendQuit(socketPath: string, session: string): void {
  try {
    tmux(socketPath, 'send-keys', '-t', cockpitPane(socketPath, session) ?? session, 'C-c');
  } catch {
    // The cockpit is already gone, which the process check below records.
  }
}

async function readFileOrUndefined(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Writes one worktree-pane record into the persisted workspace, pointing at
 * the seeded worktree and at a tmux pane id that no longer exists — which is
 * exactly the state a restart finds after its panes died with the old server.
 */
async function seedWorktreePaneRecord(
  configPath: string,
  projectRoot: string,
): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return false;
    const record = parsed as Record<string, unknown>;
    record.panes = [{
      id: '1',
      slug: SEEDED_WORKTREE_BRANCH,
      prompt: '',
      paneId: '%99',
      branchName: SEEDED_WORKTREE_BRANCH,
      type: 'worktree',
      worktreePath: path.join(projectRoot, '.psyche', 'worktrees', SEEDED_WORKTREE_BRANCH),
      projectRoot,
    }];
    await writeFile(configPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** How many cockpit processes are running in the session. */
function countCockpitPanes(socketPath: string, session: string): number {
  try {
    return tmux(socketPath, 'list-panes', '-s', '-t', session, '-F', '#{pane_id} #{pane_current_command}')
      .split('\n')
      .filter((line) => / node$| tsx$/.test(line))
      .length;
  } catch {
    return 0;
  }
}

function countPanes(socketPath: string, session: string): number {
  try {
    return tmux(socketPath, 'list-panes', '-s', '-t', session, '-F', '#{pane_id}')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .length;
  } catch {
    return 0;
  }
}

/**
 * Restarts the cockpit inside the session that survived the quit, which is
 * what relaunching it against the same project does. A second `new-session`
 * would fail on the duplicate name and prove nothing about restoration.
 */
function relaunchCockpit(options: {
  socketPath: string;
  session: string;
  projectRoot: string;
  entry: { argv: string[] };
  env: NodeJS.ProcessEnv;
}): void {
  try {
    execFileSync(
      'tmux',
      [
        '-S', options.socketPath,
        'new-window', '-d',
        '-t', `${options.session}:`,
        '-c', options.projectRoot,
        ...options.entry.argv,
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: TMUX_TIMEOUT_MS,
        env: options.env,
      },
    );
  } catch {
    throw new RecoveryRestartUnavailableError('the cockpit could not be relaunched under tmux');
  }
}

function sessionExists(socketPath: string, session: string): boolean {
  try {
    tmux(socketPath, 'has-session', '-t', session);
    return true;
  } catch {
    return false;
  }
}

function countSessions(socketPath: string, session: string): number {
  try {
    return tmux(socketPath, 'list-sessions', '-F', '#{session_name}')
      .split('\n')
      .filter((name) => name.trim() === session)
      .length;
  } catch {
    return 0;
  }
}

function capturePane(socketPath: string, session: string): string {
  try {
    return tmux(socketPath, 'capture-pane', '-p', '-t', session);
  } catch {
    return '';
  }
}

function tmux(socketPath: string, ...args: string[]): string {
  return execFileSync('tmux', ['-S', socketPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: TMUX_TIMEOUT_MS,
  }).trim();
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await delay(POLL_INTERVAL_MS);
  }
  return false;
}
