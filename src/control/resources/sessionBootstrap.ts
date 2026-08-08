import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  tmuxSessionExists,
  tmuxSessionNameForRoot,
} from '../../services/tmuxControl.js';
import {
  TMUX_PANE_TITLE_LABEL_FORMAT,
  TMUX_PANE_TITLE_PREFIX_FORMAT,
} from '../../utils/paneTitlePrefix.js';
import { applyTmuxThemeToSession } from '../../utils/welcomePane.js';
import {
  buildRemotePaneActionBindingCommandArgs,
  buildRemotePaneActionCleanupCommandArgs,
  clearRemotePaneActions,
  PSYCHE_CONTROL_PANE_OPTION,
  PSYCHE_CONTROLLER_PID_OPTION,
} from '../../utils/remotePaneActions.js';

export interface BootstrapSessionOptions {
  sessionName?: string;
  projectName?: string;
  configPath?: string;
  controlPaneId?: string;
}

export async function bootstrapSession(
  projectRoot: string,
  options: BootstrapSessionOptions = {},
): Promise<void> {
  const sessionName = options.sessionName ?? tmuxSessionNameForRoot(projectRoot);
  const projectName = options.projectName ?? path.basename(projectRoot);
  const configPath = options.configPath ?? path.join(projectRoot, '.psyche', 'psyche.config.json');

  if (!tmuxSessionExists(sessionName)) {
    execFileSync('tmux', ['new-session', '-d', '-s', sessionName], { stdio: 'pipe' });
  }

  applySessionOptions(sessionName);
  applyTmuxThemeToSession(sessionName, projectRoot);
  publishSessionMetadata(sessionName, projectRoot, projectName, configPath, options.controlPaneId);
  setupRemotePaneActionBindings(sessionName);
  await clearRemotePaneActions(sessionName);
}

function applySessionOptions(sessionName: string): void {
  execFileSync('tmux', ['set-option', '-t', sessionName, 'pane-border-status', 'top'], {
    stdio: 'pipe',
  });
  execFileSync('tmux', [
    'set-option',
    '-t',
    sessionName,
    'pane-border-format',
    ` #{?@psyche_attention,#[bold]![ready] #[default],}${TMUX_PANE_TITLE_PREFIX_FORMAT}${TMUX_PANE_TITLE_LABEL_FORMAT} `,
  ], { stdio: 'pipe' });
  execFileSync('tmux', ['set-option', '-t', sessionName, 'mouse', 'on'], { stdio: 'pipe' });
}

function publishSessionMetadata(
  sessionName: string,
  projectRoot: string,
  projectName: string,
  configPath: string,
  controlPaneId?: string,
): void {
  execFileSync('tmux', ['set-option', '-t', sessionName, '@psyche_project_root', projectRoot], {
    stdio: 'pipe',
  });
  execFileSync('tmux', ['set-option', '-t', sessionName, '@psyche_project_name', projectName], {
    stdio: 'pipe',
  });
  execFileSync('tmux', ['set-option', '-t', sessionName, '@psyche_config_path', configPath], {
    stdio: 'pipe',
  });
  execFileSync('tmux', [
    'set-option',
    '-t',
    sessionName,
    PSYCHE_CONTROLLER_PID_OPTION,
    String(process.pid),
  ], { stdio: 'pipe' });
  if (controlPaneId) {
    execFileSync('tmux', ['set-option', '-t', sessionName, PSYCHE_CONTROL_PANE_OPTION, controlPaneId], {
      stdio: 'pipe',
    });
  }
}

function setupRemotePaneActionBindings(sessionName: string): void {
  for (const args of buildRemotePaneActionCleanupCommandArgs()) {
    execFileSync('tmux', args, { stdio: 'pipe' });
  }
  for (const args of buildRemotePaneActionBindingCommandArgs()) {
    execFileSync('tmux', args, { stdio: 'pipe' });
  }
}
