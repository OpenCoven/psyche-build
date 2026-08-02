import { spawnSync } from 'child_process';
import chalk from 'chalk';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import {
  compareVersions,
  parseVersion,
} from './systemCheck.js';
import {
  getAgentDefinitions,
  type AgentRegistryEntry,
} from './agentLaunch.js';
import {
  getTmuxConfigCandidatePaths,
} from './tmuxConfigOnboarding.js';
import {
  hasPsycheManagedTmuxConfigBlock,
  writePsycheManagedTmuxConfig,
} from './tmuxManagedConfig.js';
import { buildTmuxSessionThemeOptions } from './tmuxThemeOptions.js';
import {
  buildRemotePaneActionBindingCommandArgs,
  buildRemotePaneActionCleanupCommandArgs,
  PSYCHE_CONTROL_PANE_OPTION,
  PSYCHE_CONTROLLER_PID_OPTION,
} from './remotePaneActions.js';
import {
  TMUX_PANE_TITLE_LABEL_FORMAT,
  TMUX_PANE_TITLE_PREFIX_FORMAT,
} from './paneTitlePrefix.js';
import {
  syncPsycheThemeFromSettings,
} from '../theme/colors.js';
import type { PsycheThemeName } from '../types.js';

export type TmuxDoctorSeverity = 'ok' | 'warning' | 'error';

export interface TmuxDoctorCheck {
  id: string;
  label: string;
  severity: TmuxDoctorSeverity;
  message: string;
  fix?: string;
  fixed?: boolean;
}

export interface TmuxDoctorResult {
  canRun: boolean;
  usable: boolean;
  healthy: boolean;
  fixed: boolean;
  checks: TmuxDoctorCheck[];
  configPath?: string;
  backupPath?: string;
  sessionName?: string;
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface LiveSessionRepairCommand {
  args: string[];
  checkId?: string;
}

interface LiveSessionFixResult {
  fixedAny: boolean;
  fixedCheckIds: Set<string>;
}

interface DetectedAgentCommand {
  name: string;
  command: string;
}

export interface TmuxDoctorRuntime {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  run?: (command: string, args: string[]) => CommandResult;
  projectRoot?: string;
  themeName?: PsycheThemeName;
  findAgentCommand?: (definition: AgentRegistryEntry) => string | null;
}

interface ResolvedTmuxDoctorRuntime {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  run: (command: string, args: string[]) => CommandResult;
  themeName: PsycheThemeName;
  findAgentCommand?: (definition: AgentRegistryEntry) => string | null;
}

export interface RunTmuxDoctorOptions {
  fix?: boolean;
  runtime?: TmuxDoctorRuntime;
}

function buildExpectedSessionOptions(
  themeName: PsycheThemeName
): Array<readonly [option: string, value: string]> {
  return [
    ['pane-border-status', 'top'],
    ['pane-border-format', ` #{?@psyche_attention,#[bold]![ready] #[default],}${TMUX_PANE_TITLE_PREFIX_FORMAT}${TMUX_PANE_TITLE_LABEL_FORMAT} `],
    ...buildTmuxSessionThemeOptions(themeName),
  ];
}

function defaultRun(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, { encoding: 'utf-8', stdio: 'pipe' });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function resolveDoctorTheme(runtime?: TmuxDoctorRuntime): PsycheThemeName {
  return runtime?.themeName || syncPsycheThemeFromSettings(runtime?.projectRoot || process.cwd());
}

function getRuntime(options?: RunTmuxDoctorOptions): ResolvedTmuxDoctorRuntime {
  return {
    homeDir: options?.runtime?.homeDir || process.env.HOME || os.homedir(),
    env: options?.runtime?.env || process.env,
    run: options?.runtime?.run || defaultRun,
    themeName: resolveDoctorTheme(options?.runtime),
    findAgentCommand: options?.runtime?.findAgentCommand,
  };
}

function checkOption(
  id: string,
  label: string,
  actual: string | null,
  expected: string,
  fix?: string
): TmuxDoctorCheck {
  if (actual === expected) {
    return {
      id,
      label,
      severity: 'ok',
      message: `${label} is configured`,
    };
  }

  return {
    id,
    label,
    severity: 'warning',
    message: `${label} is ${actual || 'unset'}; expected ${expected}`,
    fix,
  };
}

function runTmux(runtime: ResolvedTmuxDoctorRuntime, args: string[]): CommandResult {
  try {
    return runtime.run('tmux', args);
  } catch (error: any) {
    return {
      status: 1,
      stdout: '',
      stderr: error?.message || String(error),
    };
  }
}

function readTmuxOption(
  runtime: ResolvedTmuxDoctorRuntime,
  args: string[]
): string | null {
  const result = runTmux(runtime, args);
  if (result.status !== 0) {
    return null;
  }

  return result.stdout.trim() || null;
}

function runTmuxCommandBatch(
  runtime: ResolvedTmuxDoctorRuntime,
  commands: string[][]
): CommandResult {
  if (commands.length === 0) {
    return { status: 0, stdout: '', stderr: '' };
  }

  const args = commands.flatMap((commandArgs, index) =>
    index < commands.length - 1 ? [...commandArgs, ';'] : commandArgs
  );

  return runTmux(runtime, args);
}

function checkVersionWithRuntime(
  runtime: ResolvedTmuxDoctorRuntime,
  command: string,
  args: string[],
  pattern: RegExp,
  minVersion: string,
  missingMessage: string,
  label: string
): TmuxDoctorCheck {
  const result = runtime.run(command, args);
  if (result.status !== 0) {
    return {
      id: `${label}-version`,
      label,
      severity: 'error',
      message: missingMessage,
      fix: `Install ${label} ${minVersion} or newer`,
    };
  }

  const rawVersion = result.stdout.trim();
  const match = rawVersion.match(pattern);
  if (!match) {
    return {
      id: `${label}-version`,
      label,
      severity: 'error',
      message: `Could not parse ${label} version: ${rawVersion}`,
      fix: `Install ${label} ${minVersion} or newer`,
    };
  }

  const installedVersion = match[1];
  const valid = compareVersions(parseVersion(installedVersion), parseVersion(minVersion)) >= 0;
  return {
    id: `${label}-version`,
    label,
    severity: valid ? 'ok' : 'error',
    message: valid
      ? `${label} ${installedVersion} is installed`
      : `${label} version ${installedVersion} is below minimum required version ${minVersion}`,
    fix: valid ? undefined : `Install ${label} ${minVersion} or newer`,
  };
}

function detectAgentCommand(
  runtime: ResolvedTmuxDoctorRuntime,
  definition: AgentRegistryEntry
): string {
  if (runtime.findAgentCommand) {
    return runtime.findAgentCommand(definition) || '';
  }

  const shell = runtime.env.SHELL || process.env.SHELL || '/bin/sh';
  const result = runtime.run(shell, ['-i', '-c', definition.installTestCommand]);
  const command = result.status === 0 ? result.stdout.trim().split('\n')[0] : '';
  if (command) {
    return command;
  }

  for (const candidate of definition.commonPaths) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return '';
}

function detectSupportedAgentCommands(runtime: ResolvedTmuxDoctorRuntime): DetectedAgentCommand[] {
  const detected: DetectedAgentCommand[] = [];

  for (const definition of getAgentDefinitions()) {
    const command = detectAgentCommand(runtime, definition);

    if (command) {
      detected.push({
        name: definition.name,
        command,
      });
    }
  }

  return detected;
}

function buildAgentCliCheck(runtime: ResolvedTmuxDoctorRuntime): TmuxDoctorCheck {
  const supportedAgents = getAgentDefinitions();
  const detectedAgents = detectSupportedAgentCommands(runtime);

  if (detectedAgents.length > 0) {
    const detectedSummary = detectedAgents
      .map((agent) => `${agent.name} (${agent.command})`)
      .join(', ');

    return {
      id: 'agent-cli-guidance',
      label: 'agent CLIs',
      severity: 'ok',
      message: `Detected ${detectedSummary}`,
    };
  }

  const defaultEnabled = supportedAgents
    .filter((agent) => agent.defaultEnabled)
    .map((agent) => agent.name)
    .join(', ');
  const supported = supportedAgents.map((agent) => agent.name).join(', ');

  return {
    id: 'agent-cli-guidance',
    label: 'agent CLIs',
    severity: 'warning',
    message: `No supported agent CLI detected. psyche can still open plain terminal panes; install one of the default agents (${defaultEnabled}) or enable another supported CLI in settings.`,
    fix: `Supported agent CLIs: ${supported}`,
  };
}

function buildCovenGuidanceCheck(): TmuxDoctorCheck {
  return {
    id: 'coven-guidance',
    label: 'Coven integration',
    severity: 'ok',
    message: 'Coven is optional. Without it, psyche still manages tmux panes, git worktrees, agents, merge, and PR flows; with a local Coven daemon, psyche can also list, open, and launch scoped Coven harness sessions.',
  };
}

async function readConfigContents(homeDir: string): Promise<Array<{ path: string; content: string }>> {
  const paths = getTmuxConfigCandidatePaths(homeDir);
  return Promise.all(paths.map(async (configPath) => {
    try {
      return {
        path: configPath,
        content: await fs.readFile(configPath, 'utf-8'),
      };
    } catch {
      return {
        path: configPath,
        content: '',
      };
    }
  }));
}

function applyLiveSessionFixes(
  runtime: ResolvedTmuxDoctorRuntime,
  sessionName: string,
  expectedSessionOptions: Array<readonly [option: string, value: string]>
): LiveSessionFixResult {
  const result: LiveSessionFixResult = {
    fixedAny: false,
    fixedCheckIds: new Set(),
  };
  const commands: LiveSessionRepairCommand[] = [
    { args: ['set-option', '-g', 'mouse', 'on'], checkId: 'tmux-mouse' },
    { args: ['set-option', '-gq', 'extended-keys', 'on'], checkId: 'tmux-extended-keys' },
    { args: ['set-option', '-q', '-t', sessionName, 'set-clipboard', 'on'], checkId: 'tmux-clipboard' },
    { args: ['set-option', '-q', '-t', sessionName, 'allow-passthrough', 'all'], checkId: 'tmux-passthrough' },
    { args: ['set-option', '-q', '-ag', '-t', sessionName, 'update-environment', 'TERM_PROGRAM'] },
    { args: ['set-option', '-q', '-ag', '-t', sessionName, 'terminal-overrides', ',xterm-256color:Ms=\\E]52;c;%p2%s\\007'] },
  ];

  for (const [option, value] of expectedSessionOptions) {
    commands.push({
      args: ['set-option', '-q', '-t', sessionName, option, value],
      checkId: `tmux-${option}`,
    });
  }

  for (const command of commands) {
    const commandResult = runTmux(runtime, command.args);
    if (commandResult.status === 0) {
      result.fixedAny = true;
      if (command.checkId) {
        result.fixedCheckIds.add(command.checkId);
      }
    }
  }

  try {
    runTmuxCommandBatch(runtime, buildRemotePaneActionCleanupCommandArgs());
    const setupResult = runTmuxCommandBatch(runtime, buildRemotePaneActionBindingCommandArgs());
    result.fixedAny = setupResult.status === 0 || result.fixedAny;
  } catch {
    // Binding repair is best-effort only.
  }

  return result;
}

export async function runTmuxDoctor(
  options: RunTmuxDoctorOptions = {}
): Promise<TmuxDoctorResult> {
  const runtime = getRuntime(options);
  const expectedSessionOptions = buildExpectedSessionOptions(runtime.themeName);
  const checks: TmuxDoctorCheck[] = [];
  let fixed = false;
  let configPath: string | undefined;
  let backupPath: string | undefined;

  checks.push(checkVersionWithRuntime(
    runtime,
    'tmux',
    ['-V'],
    /tmux\s+([\d.]+)/,
    '3.0',
    'tmux is not installed or not in PATH',
    'tmux'
  ));

  checks.push(checkVersionWithRuntime(
    runtime,
    'git',
    ['--version'],
    /git version\s+([\d.]+)/,
    '2.20',
    'git is not installed or not in PATH',
    'git'
  ));

  checks.push(buildAgentCliCheck(runtime));
  checks.push(buildCovenGuidanceCheck());

  const configContents = await readConfigContents(runtime.homeDir);
  const managedConfig = configContents.find((entry) => hasPsycheManagedTmuxConfigBlock(entry.content));
  const existingConfig = configContents.find((entry) => entry.content.trim().length > 0);

  if (managedConfig) {
    configPath = managedConfig.path;
    checks.push({
      id: 'tmux-managed-config',
      label: 'tmux config',
      severity: 'ok',
      message: `psyche managed config block found in ${managedConfig.path}`,
    });
  } else {
    checks.push({
      id: 'tmux-managed-config',
      label: 'tmux config',
      severity: 'warning',
      message: existingConfig
        ? `Recommended psyche tmux config block is not installed in ${existingConfig.path}`
        : 'Recommended psyche tmux config block is not installed yet',
      fix: 'Run psyche doctor --fix to add the recommended psyche tmux config block',
    });

    if (options.fix) {
      const writeResult = await writePsycheManagedTmuxConfig(runtime.homeDir, 'dark');
      configPath = writeResult.configPath;
      backupPath = writeResult.backupPath;
      fixed = writeResult.changed || fixed;
      runTmux(runtime, ['source-file', writeResult.configPath]);
      checks[checks.length - 1] = {
        ...checks[checks.length - 1],
        severity: 'ok',
        message: `psyche managed config block ${writeResult.action} at ${writeResult.configPath}`,
        fixed: writeResult.changed,
      };
    }
  }

  const sessionName = runtime.env.TMUX
    ? readTmuxOption(runtime, ['display-message', '-p', '#S'])
    : null;

  if (!sessionName) {
    checks.push({
      id: 'tmux-live-session',
      label: 'tmux live session',
      severity: 'ok',
      message: 'Not inside tmux; live session checks skipped',
    });
  } else {
    checks.push({
      id: 'tmux-live-session',
      label: 'tmux live session',
      severity: 'ok',
      message: `Inspecting live session ${sessionName}`,
    });

    const mouse = readTmuxOption(runtime, ['show-options', '-gv', 'mouse']);
    checks.push(checkOption(
      'tmux-mouse',
      'tmux mouse',
      mouse,
      'on',
      'Run psyche doctor --fix to enable mouse mode'
    ));

    const setClipboard = readTmuxOption(runtime, ['show-options', '-v', '-t', sessionName, 'set-clipboard']);
    checks.push(checkOption(
      'tmux-clipboard',
      'tmux clipboard',
      setClipboard,
      'on',
      'Run psyche doctor --fix to enable tmux clipboard passthrough'
    ));

    const allowPassthrough = readTmuxOption(runtime, ['show-options', '-v', '-t', sessionName, 'allow-passthrough']);
    checks.push(checkOption(
      'tmux-passthrough',
      'tmux passthrough',
      allowPassthrough,
      'all',
      'Run psyche doctor --fix to enable tmux passthrough'
    ));

    const extendedKeys = readTmuxOption(runtime, ['show-options', '-gv', 'extended-keys']);
    checks.push(checkOption(
      'tmux-extended-keys',
      'tmux extended keys',
      extendedKeys,
      'on',
      'Run psyche doctor --fix to enable extended keys'
    ));

    for (const [option, expected] of expectedSessionOptions) {
      const actual = readTmuxOption(runtime, ['show-options', '-v', '-t', sessionName, option]);
      checks.push(checkOption(
        `tmux-${option}`,
        option,
        actual,
        expected,
        'Run psyche doctor --fix to apply psyche session styling'
      ));
    }

    if (sessionName.startsWith('psyche-')) {
      const controllerPid = readTmuxOption(runtime, ['show-options', '-v', '-t', sessionName, PSYCHE_CONTROLLER_PID_OPTION]);
      const controlPane = readTmuxOption(runtime, ['show-options', '-v', '-t', sessionName, PSYCHE_CONTROL_PANE_OPTION]);
      checks.push({
        id: 'psyche-session-options',
        label: 'psyche session metadata',
        severity: controllerPid && controlPane ? 'ok' : 'warning',
        message: controllerPid && controlPane
          ? 'psyche controller metadata is present'
          : 'psyche controller metadata is missing; remote pane shortcuts may not work until psyche is running',
      });
    }

    if (options.fix) {
      const liveFix = applyLiveSessionFixes(runtime, sessionName, expectedSessionOptions);
      fixed = liveFix.fixedAny || fixed;
      if (liveFix.fixedCheckIds.size > 0) {
        for (const check of checks) {
          if (
            check.severity === 'warning'
            && liveFix.fixedCheckIds.has(check.id)
          ) {
            check.severity = 'ok';
            check.message = `${check.label} repair command applied`;
            check.fixed = true;
          }
        }
      }
    }
  }

  const hasErrors = checks.some((check) => check.severity === 'error');
  const hasWarnings = checks.some((check) => check.severity === 'warning');

  return {
    canRun: !hasErrors,
    usable: !hasErrors,
    healthy: !hasErrors && !hasWarnings,
    fixed,
    checks,
    configPath,
    backupPath,
    sessionName: sessionName || undefined,
  };
}

export function getTmuxDoctorExitCode(result: TmuxDoctorResult): number {
  return result.canRun ? 0 : 1;
}

export function formatTmuxDoctorText(result: TmuxDoctorResult): string {
  const lines = [
    chalk.hex('#a78bfa').bold('psyche doctor'),
    '',
    ...result.checks.map((check) => {
      const marker = check.severity === 'ok'
        ? chalk.green('ok')
        : check.severity === 'warning'
          ? chalk.yellow('warn')
          : chalk.red('error');
      const fixed = check.fixed ? chalk.green(' fixed') : '';
      return `${marker} ${check.label}: ${check.message}${fixed}`;
    }),
  ];

  if (result.backupPath) {
    lines.push('', chalk.yellow(`Backup written: ${result.backupPath}`));
  }

  if (!result.healthy && result.usable && !result.fixed) {
    lines.push('', chalk.yellow('psyche can run; recommended setup warnings remain.'));
    lines.push(chalk.yellow('Run psyche doctor --fix to apply safe repairs.'));
  } else if (!result.healthy && result.usable && result.fixed) {
    lines.push('', chalk.yellow('psyche can run. Some warnings remain because they require psyche to be running in this session.'));
  }

  return lines.join('\n');
}

export function formatTmuxDoctorJson(result: TmuxDoctorResult): string {
  return JSON.stringify(result, null, 2);
}
