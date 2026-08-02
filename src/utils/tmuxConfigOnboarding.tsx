import { execSync } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import React, { useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';
import { LogService } from '../services/LogService.js';
import { COLORS } from '../theme/colors.js';
import {
  hasPsycheManagedTmuxConfigBlock,
  PSYCHE_TMUX_CONFIG_VERSION,
  writePsycheManagedTmuxConfig,
  type TmuxPresetTheme,
} from './tmuxManagedConfig.js';

export { buildRecommendedTmuxConfig } from './tmuxManagedConfig.js';

type OnboardingOutcome = 'existing-config' | 'install-dark' | 'install-light' | 'skip';

interface OnboardingState {
  tmuxConfigOnboarding?: {
    completed: boolean;
    completedAt: string;
    outcome: OnboardingOutcome;
    configPath?: string;
    managedBlockVersion?: number;
  };
}

const ONBOARDING_STATE_RELATIVE_PATH = path.join('.psyche', 'onboarding.json');

/**
 * Candidate config locations used by tmux on modern systems.
 * We only offer onboarding when none of these contain a meaningful config.
 */
export function getTmuxConfigCandidatePaths(homeDir: string): string[] {
  return [
    path.join(homeDir, '.tmux.conf'),
    path.join(homeDir, '.config', 'tmux', 'tmux.conf'),
  ];
}

/**
 * Returns true if the user already has tmux configuration in a known location.
 * A non-empty file is treated as "configured" to avoid overwriting user intent.
 */
export async function hasMeaningfulTmuxConfig(homeDir: string): Promise<boolean> {
  const candidatePaths = getTmuxConfigCandidatePaths(homeDir);

  for (const configPath of candidatePaths) {
    try {
      const stats = await fs.stat(configPath);
      if (stats.isFile() && stats.size > 0) {
        return true;
      }
    } catch {
      // Expected when config file does not exist
    }
  }

  return false;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function readOnboardingState(statePath: string): Promise<OnboardingState> {
  try {
    const raw = await fs.readFile(statePath, 'utf-8');
    const parsed = JSON.parse(raw) as OnboardingState;
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch {
    // Expected when state file does not exist
  }

  return {};
}

async function writeOnboardingState(
  homeDir: string,
  outcome: OnboardingOutcome,
  configPath?: string,
  managedBlockVersion?: number,
  completedAt = new Date()
): Promise<void> {
  const statePath = path.join(homeDir, ONBOARDING_STATE_RELATIVE_PATH);
  const currentState = await readOnboardingState(statePath);
  const nextState: OnboardingState = {
    ...currentState,
    tmuxConfigOnboarding: {
      completed: true,
      completedAt: completedAt.toISOString(),
      outcome,
      ...(configPath ? { configPath } : {}),
      ...(managedBlockVersion ? { managedBlockVersion } : {}),
    },
  };

  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(nextState, null, 2), 'utf-8');
}

function sourceTmuxConfig(configPath: string): void {
  try {
    execSync(`tmux source-file ${shellQuote(configPath)}`, { stdio: 'pipe' });
  } catch {
    // Best effort only - server may not be running yet
  }
}

interface TmuxConfigOnboardingRuntime {
  homeDir?: string;
  isInteractive?: boolean;
  now?: Date;
  promptForSetup?: (hasExistingConfig: boolean) => Promise<OnboardingOutcome>;
  sourceConfig?: (configPath: string) => void;
}

function promptForTmuxConfigSetup(hasExistingConfig: boolean): Promise<OnboardingOutcome> {
  return new Promise((resolve) => {
    let resolved = false;

    const settle = (outcome: OnboardingOutcome): void => {
      if (resolved) {
        return;
      }
      resolved = true;
      resolve(outcome);
    };

    const app = render(
      <TmuxConfigOnboardingPrompt
        hasExistingConfig={hasExistingConfig}
        onComplete={settle}
      />,
      { exitOnCtrlC: false }
    );

    app.waitUntilExit()
      .then(() => settle('skip'))
      .catch(() => settle('skip'));
  });
}

interface TmuxConfigOnboardingPromptProps {
  hasExistingConfig: boolean;
  onComplete: (outcome: OnboardingOutcome) => void;
}

const TmuxConfigOnboardingPrompt: React.FC<TmuxConfigOnboardingPromptProps> = ({
  hasExistingConfig,
  onComplete,
}) => {
  const { exit } = useApp();
  const [offerIndex, setOfferIndex] = useState(0);

  const finish = (outcome: OnboardingOutcome) => {
    onComplete(outcome);
    exit();
  };

  useInput((input, key) => {
    if (key.ctrl && input.toLowerCase() === 'c') {
      finish('skip');
      return;
    }

    if (input.toLowerCase() === 'y') {
      finish('install-dark');
      return;
    }

    if (input.toLowerCase() === 'n' || key.escape) {
      finish('skip');
      return;
    }

    if (key.upArrow || key.leftArrow) {
      setOfferIndex(prev => Math.max(0, prev - 1));
      return;
    }

    if (key.downArrow || key.rightArrow) {
      setOfferIndex(prev => Math.min(1, prev + 1));
      return;
    }

    if (key.return) {
      finish(offerIndex === 0 ? 'install-dark' : 'skip');
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={COLORS.accent} paddingX={1} marginTop={1}>
      <Text bold color={COLORS.accent}>Welcome to psyche</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>psyche uses tmux panes to run agents and terminals side by side.</Text>
        <Text dimColor>
          {hasExistingConfig
            ? 'Your tmux config will be preserved; psyche will add only its marked block.'
            : 'No tmux config was found; psyche can create one with its marked block.'}
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text>psyche works best with a few tmux settings for pane borders, navigation, and clipboard behavior.</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Set up recommended tmux defaults?</Text>
        <Box marginTop={1} flexDirection="column">
          <Text color={offerIndex === 0 ? COLORS.accent : 'white'} bold={offerIndex === 0}>
            {offerIndex === 0 ? '> ' : '  '}Set up defaults (recommended)
          </Text>
          <Text color={offerIndex === 1 ? COLORS.warning : 'white'} bold={offerIndex === 1}>
            {offerIndex === 1 ? '> ' : '  '}Skip for now
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>up/down to navigate | Enter to select | y/n shortcuts</Text>
        </Box>
      </Box>
    </Box>
  );
};

/**
 * First-run onboarding for tmux config presets.
 * - If a psyche-managed block already exists, mark onboarding complete.
 * - If user config exists without the block, offer to append only the managed block.
 * - If no config exists, ask once and optionally create the managed block.
 */
export async function runTmuxConfigOnboardingIfNeeded(
  runtime: TmuxConfigOnboardingRuntime = {}
): Promise<void> {
  const logger = LogService.getInstance();

  try {
    const homeDir = runtime.homeDir || process.env.HOME || os.homedir();
    if (!homeDir) {
      return;
    }

    const statePath = path.join(homeDir, ONBOARDING_STATE_RELATIVE_PATH);
    const onboardingState = await readOnboardingState(statePath);

    if (onboardingState.tmuxConfigOnboarding?.completed) {
      return;
    }

    const candidatePaths = getTmuxConfigCandidatePaths(homeDir);
    const existingConfigContents = await Promise.all(
      candidatePaths.map(async (configPath) => {
        try {
          return await fs.readFile(configPath, 'utf-8');
        } catch {
          return '';
        }
      })
    );
    const hasTmuxConfig = existingConfigContents.some((content) => content.trim().length > 0);
    const hasManagedBlock = existingConfigContents.some(hasPsycheManagedTmuxConfigBlock);
    if (hasManagedBlock) {
      await writeOnboardingState(
        homeDir,
        'existing-config',
        candidatePaths[existingConfigContents.findIndex(hasPsycheManagedTmuxConfigBlock)],
        PSYCHE_TMUX_CONFIG_VERSION,
        runtime.now
      );
      return;
    }

    const isInteractive = runtime.isInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!isInteractive) {
      logger.debug(
        'Skipping tmux onboarding prompt because terminal is non-interactive',
        'onboarding'
      );
      return;
    }

    const prompt = runtime.promptForSetup || promptForTmuxConfigSetup;
    const outcome = await prompt(hasTmuxConfig);
    if (outcome === 'install-dark' || outcome === 'install-light') {
      const theme: TmuxPresetTheme = outcome === 'install-dark' ? 'dark' : 'light';
      const result = await writePsycheManagedTmuxConfig(homeDir, theme);
      const sourceConfig = runtime.sourceConfig || sourceTmuxConfig;
      sourceConfig(result.configPath);
      await writeOnboardingState(
        homeDir,
        outcome,
        result.configPath,
        result.managedBlockVersion,
        runtime.now
      );
      logger.info(
        `Installed ${theme} tmux defaults at ${result.configPath}`
          + (result.backupPath ? ` (backup: ${result.backupPath})` : ''),
        'onboarding'
      );
      return;
    }

    await writeOnboardingState(homeDir, 'skip', undefined, undefined, runtime.now);
  } catch (error) {
    logger.warn(
      `Tmux onboarding failed: ${error instanceof Error ? error.message : String(error)}`,
      'onboarding'
    );
  }
}
