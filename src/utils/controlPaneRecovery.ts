import { spawnSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { SIDEBAR_WIDTH } from './layoutManager.js';
import { atomicWriteJson } from './atomicWrite.js';
import { withPanesConfigFileWriteLock } from './panesConfigQueue.js';

interface RecoveryConfig {
  controlPaneId?: string;
  controlPaneSize?: number;
  projectRoot?: string;
  lastUpdated?: string;
  [key: string]: unknown;
}

interface TmuxResult {
  ok: boolean;
  stdout: string;
}

interface PaneRow {
  paneId: string;
  paneTitle: string;
}

function runTmux(args: string[]): TmuxResult {
  const result = spawnSync('tmux', args, {
    encoding: 'utf-8',
    stdio: 'pipe',
  });

  return {
    ok: result.status === 0,
    stdout: (result.stdout || '').trim(),
  };
}

function getSessionOption(sessionName: string, optionName: string): string | undefined {
  const result = runTmux(['show-options', '-v', '-t', sessionName, optionName]);
  if (!result.ok || !result.stdout) {
    return undefined;
  }
  return result.stdout;
}

async function readConfig(configPath: string): Promise<RecoveryConfig | null> {
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed) || !parsed || typeof parsed !== 'object') {
      return null;
    }

    return parsed as RecoveryConfig;
  } catch {
    return null;
  }
}

async function saveRecoveredControlPane(
  configPath: string,
  controlPaneId: string
): Promise<void> {
  await withPanesConfigFileWriteLock(configPath, async () => {
    const config = await readConfig(configPath);
    if (!config) {
      return;
    }

    config.controlPaneId = controlPaneId;
    config.controlPaneSize = getSidebarWidth(config);
    config.lastUpdated = new Date().toISOString();
    await atomicWriteJson(configPath, config);
  });
}

function parsePaneRows(output: string): PaneRow[] {
  if (!output) return [];

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [paneId, paneTitle] = line.split('\t');
      return {
        paneId,
        paneTitle: paneTitle || '',
      };
    })
    .filter((pane) => pane.paneId.startsWith('%'));
}

function getSidebarWidth(config: RecoveryConfig): number {
  return typeof config.controlPaneSize === 'number' && config.controlPaneSize > 0
    ? config.controlPaneSize
    : SIDEBAR_WIDTH;
}

function resolveDistIndexPath(): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'index.js'
  );
}

async function recoverControlPaneIfNeeded(): Promise<void> {
  let decodedSession = '';
  if (process.env.PSYCHE_RECOVERY_SESSION_B64) {
    try {
      decodedSession = Buffer.from(
        process.env.PSYCHE_RECOVERY_SESSION_B64,
        'base64'
      ).toString('utf-8');
    } catch {
      decodedSession = '';
    }
  }

  const resolvedSessionFromTmux = runTmux(['display-message', '-p', '#S']);
  const sessionName = decodedSession
    || process.env.PSYCHE_RECOVERY_SESSION
    || (resolvedSessionFromTmux.ok ? resolvedSessionFromTmux.stdout : '')
    || '';

  const exitedPaneIdRaw = process.env.PSYCHE_RECOVERY_EXITED_PANE || '';
  const exitedPaneId = exitedPaneIdRaw.startsWith('#{') ? '' : exitedPaneIdRaw;

  if (!sessionName) {
    return;
  }

  const configPath = getSessionOption(sessionName, '@psyche_config_path');
  if (!configPath) {
    return;
  }

  const config = await readConfig(configPath);
  if (!config) {
    return;
  }

  const controlPaneId = typeof config.controlPaneId === 'string'
    ? config.controlPaneId
    : '';
  if (!controlPaneId) {
    return;
  }
  const sidebarWidth = getSidebarWidth(config);

  const paneList = runTmux([
    'list-panes',
    '-t',
    sessionName,
    '-F',
    '#{pane_id}\t#{pane_title}',
  ]);
  if (!paneList.ok) {
    return;
  }

  const panes = parsePaneRows(paneList.stdout);
  if (panes.length === 0) {
    return;
  }

  const controlStillExists = panes.some((pane) => pane.paneId === controlPaneId);
  if (controlStillExists) {
    return;
  }

  // Only recover from this hook when the exited pane is the tracked control pane.
  if (exitedPaneId && exitedPaneId !== controlPaneId) {
    return;
  }

  // If psyche already exists in another pane, just update config ownership.
  const existingPsychePane = panes.find((pane) => pane.paneTitle === 'psyche');
  if (existingPsychePane) {
    await saveRecoveredControlPane(configPath, existingPsychePane.paneId);
    return;
  }

  const projectRootFromOption = getSessionOption(sessionName, '@psyche_project_root');
  const projectRoot = projectRootFromOption
    || (typeof config.projectRoot === 'string' ? config.projectRoot : '')
    || path.dirname(path.dirname(configPath));

  const anchorPaneId = panes[0]?.paneId;
  if (!anchorPaneId) {
    return;
  }

  // Recreate a left sidebar pane and launch psyche there.
  const splitResult = runTmux([
    'split-window',
    '-b',
    '-h',
    '-t',
    anchorPaneId,
    '-l',
    String(sidebarWidth),
    '-c',
    projectRoot,
    '-P',
    '-F',
    '#{pane_id}',
  ]);
  if (!splitResult.ok || !splitResult.stdout) {
    return;
  }

  const newControlPaneId = splitResult.stdout.trim();
  runTmux(['select-pane', '-t', newControlPaneId, '-T', 'psyche']);
  runTmux(['send-keys', '-t', newControlPaneId, `node "${resolveDistIndexPath()}"`, 'Enter']);

  await saveRecoveredControlPane(configPath, newControlPaneId);
}

void recoverControlPaneIfNeeded();
