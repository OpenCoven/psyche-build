/**
 * Replaced-tmux-server identity observation for the #199 recovery harness.
 *
 * A tmux pane ID is only meaningful inside the server generation that
 * allocated it. When the tmux server is replaced, the next server hands out
 * `%0`, `%1`, ... again, so a persisted pane record naming `%0` now names a
 * pane it never owned. Binding that record to the new pane is how a restart
 * sends a kill, a resize, or a command into unrelated state.
 *
 * This module replaces a real tmux server, proves the new one reused the
 * recorded pane ID, and hands the harness what the production rebinding path
 * did with that collision. Nothing under observation is mocked: the identities
 * come from `getCurrentTmuxServerIdentity` talking to a live server, and the
 * title-to-ID map comes from `tmux list-panes` rather than from a fixture.
 */

import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  getCurrentTmuxServerIdentity,
  sameTmuxServerIdentity,
  type TmuxServerIdentity,
} from '../services/TmuxServerIdentity.js';
import { paneTmuxIdentityIsCurrent, rebindPaneByTitle } from '../utils/paneRebinding.js';
import type { PsychePane } from '../types.js';

const TMUX_COMMAND_TIMEOUT_MS = 5_000;

/** Raised when the host cannot run tmux, so the scenario observes nothing. */
export class RecoveryTmuxUnavailableError extends Error {
  constructor() {
    super('Replaced tmux server identity could not be observed: tmux did not run');
  }
}

export interface ReplacedTmuxIdentityObservation {
  /**
   * Positive control on the injection itself. False means the replacement
   * server did not reuse the recorded pane ID, so the collision the scenario
   * exists to observe never happened and the remaining fields prove nothing.
   */
  readonly reusedRecordedPaneId: boolean;
  /** The reused ID is reported as not current, rather than accepted as live. */
  readonly staleIdentityReported: boolean;
  /** The stale record keeps its own ID and generation instead of adopting the reused pane. */
  readonly reusedPaneIdNotAdopted: boolean;
  /** Positive control: a pane that really did move still rebinds to the new generation. */
  readonly livePaneRebound: boolean;
  /** A cross-generation rebind drops background-window bindings from the dead server. */
  readonly backgroundBindingsCleared: boolean;
}

/**
 * Drives one replaced-server collision inside `projectRoot` and returns what
 * the production path decided. The caller owns the disposable workspace.
 */
export async function observeReplacedTmuxIdentity(
  projectRoot: string,
): Promise<ReplacedTmuxIdentityObservation> {
  const tmuxTmpdir = path.join(projectRoot, 'tmux');
  const socketPath = path.join(tmuxTmpdir, `tmux-${process.getuid?.() ?? 0}`, 'default');
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });

  // The production identity call inherits `process.env`. Without this, a
  // harness run started from inside tmux would read — and then kill — the
  // operator's live server instead of the disposable one.
  const savedEnv = {
    TMUX: process.env.TMUX,
    TMUX_PANE: process.env.TMUX_PANE,
    TMUX_TMPDIR: process.env.TMUX_TMPDIR,
  };
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  process.env.TMUX_TMPDIR = tmuxTmpdir;

  try {
    return observeWithIsolatedServer(socketPath);
  } finally {
    try {
      tmux(socketPath, 'kill-server');
    } catch {
      // A server that already exited is the intended end state.
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function observeWithIsolatedServer(socketPath: string): ReplacedTmuxIdentityObservation {
  // Generation one: allocate a pane and record the identity a persisted pane
  // would have carried.
  startIsolatedServer(socketPath);
  const recordedPaneId = tmux(socketPath, 'display-message', '-p', '#{pane_id}');
  const retiredIdentity = getCurrentTmuxServerIdentity(recordedPaneId);
  if (!retiredIdentity) {
    throw new RecoveryTmuxUnavailableError();
  }

  // Generation two: the replacement server restarts pane numbering, so the
  // recorded ID is handed to a pane that record never owned.
  tmux(socketPath, 'kill-server');
  startIsolatedServer(socketPath);
  const panes = listPanes(socketPath);
  const stalePane = panes.find((pane) => pane.paneId === recordedPaneId);
  const movedPane = panes.find((pane) => pane.paneId !== recordedPaneId);
  if (!stalePane || !movedPane) {
    // The replacement server did not hand out the recorded ID again, so the
    // collision never occurred. Reported as an ineffective injection rather
    // than as the product having rejected anything.
    return {
      reusedRecordedPaneId: false,
      staleIdentityReported: false,
      reusedPaneIdNotAdopted: false,
      livePaneRebound: false,
      backgroundBindingsCleared: false,
    };
  }
  tmux(socketPath, 'select-pane', '-t', stalePane.paneId, '-T', STALE_PANE_SLUG);
  tmux(socketPath, 'select-pane', '-t', movedPane.paneId, '-T', MOVED_PANE_SLUG);

  const currentIdentity = getCurrentTmuxServerIdentity(recordedPaneId);
  if (!currentIdentity || sameTmuxServerIdentity(retiredIdentity, currentIdentity)) {
    // The replacement server is indistinguishable from the retired one, so
    // nothing here would prove a generation was detected.
    throw new RecoveryTmuxUnavailableError();
  }

  const live = listPanes(socketPath);
  const allPaneIds = live.map((pane) => pane.paneId);
  const titleToId = new Map(live.map((pane) => [pane.title, pane.paneId] as const));

  // The record a restart would load: the retired generation's pane ID, which
  // the replacement server has now handed to a different pane.
  const staleRecord = paneRecord(STALE_PANE_SLUG, recordedPaneId, retiredIdentity);
  const staleIdentityReported = !paneTmuxIdentityIsCurrent(staleRecord, allPaneIds);
  const afterStale = rebindPaneByTitle(staleRecord, titleToId, allPaneIds);
  const reusedPaneIdNotAdopted = afterStale.paneId === recordedPaneId
    && afterStale.tmuxServerIdentity !== undefined
    && sameTmuxServerIdentity(afterStale.tmuxServerIdentity, retiredIdentity)
    && !paneTmuxIdentityIsCurrent(afterStale, allPaneIds);

  // Positive control. Refusing every rebind would satisfy the invariant above
  // while stranding every pane that legitimately moved, so a record whose
  // title now resolves to a different pane must still rebind.
  const movedRecord: PsychePane = {
    ...paneRecord(MOVED_PANE_SLUG, recordedPaneId, retiredIdentity),
    testWindowId: '@9',
    testPaneId: '%9',
    testTmuxServerIdentity: retiredIdentity,
    devWindowId: '@8',
    devPaneId: '%8',
    devTmuxServerIdentity: retiredIdentity,
  };
  const afterMoved = rebindPaneByTitle(movedRecord, titleToId, allPaneIds);
  const livePaneRebound = afterMoved.paneId === movedPane.paneId
    && afterMoved.tmuxServerIdentity !== undefined
    && sameTmuxServerIdentity(afterMoved.tmuxServerIdentity, currentIdentity);

  // The background windows were allocated by the retired server. Carrying them
  // across is the same reuse defect one level down: a later teardown would
  // send a kill to whatever now holds `%9`.
  const backgroundBindingsCleared = afterMoved.testWindowId === undefined
    && afterMoved.testPaneId === undefined
    && afterMoved.testTmuxServerIdentity === undefined
    && afterMoved.devWindowId === undefined
    && afterMoved.devPaneId === undefined
    && afterMoved.devTmuxServerIdentity === undefined;

  return {
    reusedRecordedPaneId: true,
    staleIdentityReported,
    reusedPaneIdNotAdopted,
    livePaneRebound,
    backgroundBindingsCleared,
  };
}

const STALE_PANE_SLUG = 'harness-retired-pane';
const MOVED_PANE_SLUG = 'harness-moved-pane';

function paneRecord(
  slug: string,
  paneId: string,
  tmuxServerIdentity: TmuxServerIdentity,
): PsychePane {
  return { id: slug, slug, prompt: '', paneId, tmuxServerIdentity };
}

/**
 * A server with two panes and no user configuration. `-f /dev/null` keeps the
 * operator's `tmux.conf` — including any `set -g base-index` — out of the
 * observation.
 */
function startIsolatedServer(socketPath: string): void {
  tmux(socketPath, '-f', '/dev/null', 'new-session', '-d', '-s', 'harness', '-x', '80', '-y', '24', 'sh');
  tmux(socketPath, 'split-window', '-d', '-t', 'harness', 'sh');
}

interface LivePane {
  readonly paneId: string;
  readonly title: string;
}

function listPanes(socketPath: string): readonly LivePane[] {
  return tmux(socketPath, 'list-panes', '-a', '-F', '#{pane_id}\t#{pane_title}')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [paneId, title = ''] = line.split('\t');
      return { paneId, title };
    });
}

function tmux(socketPath: string, ...args: string[]): string {
  try {
    // `-S` pins the server by path, so this cannot reach the default socket
    // even if the isolating environment above were ignored.
    return execFileSync('tmux', ['-S', socketPath, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: TMUX_COMMAND_TIMEOUT_MS,
    }).trim();
  } catch {
    throw new RecoveryTmuxUnavailableError();
  }
}
