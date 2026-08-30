import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readlineMocks = vi.hoisted(() => {
  const events: string[] = [];
  const question = vi.fn(async () => {
    events.push('question');
    return 'n';
  });
  const close = vi.fn(() => {
    events.push('close');
  });
  const createInterface = vi.fn(() => ({ question, close }));
  return { close, createInterface, events, question };
});

vi.mock('node:readline/promises', () => ({
  createInterface: readlineMocks.createInterface,
}));

vi.mock('../src/utils/tmuxConfigOnboarding.js', () => ({
  runTmuxConfigOnboardingIfNeeded: vi.fn(async () => {}),
}));

import { readOnboardingState } from '../src/utils/openRouterApiKeySetup.js';
import { runOpenRouterApiKeyOnboardingIfNeeded } from '../src/utils/onboarding.js';

describe('interactive onboarding stdin lifecycle', () => {
  let homeDir: string;
  let ref: ReturnType<typeof vi.fn>;
  const originalHome = process.env.HOME;
  const originalApiKey = process.env.OPENROUTER_API_KEY;
  const originalStdinRef = Object.getOwnPropertyDescriptor(process.stdin, 'ref');
  const originalStdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const originalStdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(tmpdir(), 'psyche-onboarding-'));
    process.env.HOME = homeDir;
    delete process.env.OPENROUTER_API_KEY;
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    readlineMocks.events.length = 0;
    readlineMocks.close.mockClear();
    readlineMocks.createInterface.mockClear();
    readlineMocks.question.mockClear();
    ref = vi.fn(() => {
      readlineMocks.events.push('ref');
      return process.stdin;
    });
    Object.defineProperty(process.stdin, 'ref', { configurable: true, value: ref });
  });

  afterEach(() => {
    if (originalStdinRef) {
      Object.defineProperty(process.stdin, 'ref', originalStdinRef);
    } else {
      delete (process.stdin as unknown as { ref?: unknown }).ref;
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalApiKey;
    }
    if (originalStdinTTY) {
      Object.defineProperty(process.stdin, 'isTTY', originalStdinTTY);
    } else {
      delete (process.stdin as unknown as { isTTY?: unknown }).isTTY;
    }
    if (originalStdoutTTY) {
      Object.defineProperty(process.stdout, 'isTTY', originalStdoutTTY);
    } else {
      delete (process.stdout as unknown as { isTTY?: unknown }).isTTY;
    }
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('re-references stdin before handing an interactive prompt to readline', async () => {
    await runOpenRouterApiKeyOnboardingIfNeeded();

    expect(ref).toHaveBeenCalledOnce();
    expect(readlineMocks.events.slice(0, 2)).toEqual(['ref', 'question']);
    expect(readlineMocks.close).toHaveBeenCalledOnce();
    await expect(readOnboardingState(homeDir)).resolves.toMatchObject({
      openRouterApiKeyOnboarding: { completed: true, outcome: 'skip' },
    });
  });
});
