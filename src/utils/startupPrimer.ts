import fs from 'fs/promises';
import os from 'os';
import path from 'path';

export type StartupPrimerOutcome = 'dismissed' | 'completed-first-action';

interface OnboardingState {
  startupPrimer?: {
    completed: boolean;
    completedAt: string;
    outcome: StartupPrimerOutcome;
  };
}

const ONBOARDING_STATE_RELATIVE_PATH = path.join('.psyche', 'onboarding.json');

async function readOnboardingState(statePath: string): Promise<OnboardingState> {
  try {
    const raw = await fs.readFile(statePath, 'utf-8');
    const parsed = JSON.parse(raw) as OnboardingState;
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch {
    // Expected when onboarding state has not been created yet.
  }

  return {};
}

export async function hasCompletedStartupPrimer(
  homeDir: string = process.env.HOME || os.homedir()
): Promise<boolean> {
  const statePath = path.join(homeDir, ONBOARDING_STATE_RELATIVE_PATH);
  const state = await readOnboardingState(statePath);
  return state.startupPrimer?.completed === true;
}

export async function writeStartupPrimerState(
  outcome: StartupPrimerOutcome,
  homeDir: string = process.env.HOME || os.homedir()
): Promise<void> {
  const statePath = path.join(homeDir, ONBOARDING_STATE_RELATIVE_PATH);
  const currentState = await readOnboardingState(statePath);
  const nextState: OnboardingState = {
    ...currentState,
    startupPrimer: {
      completed: true,
      completedAt: new Date().toISOString(),
      outcome,
    },
  };

  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(nextState, null, 2), 'utf-8');
}
