import { describe, expect, it } from 'vitest';
import { summarizeDurableEffectWarnings } from '../src/utils/durableEffectWarnings.js';
import { summarizeOrchestrationWarnings } from '../src/orchestration/warnings.js';
import type { OrchestrationLaneResult } from '../src/orchestration/types.js';

const skipped = {
  code: 'initial_prompt_skipped' as const,
  message: 'opencode was launched without its initial prompt: the pane\'s shell could not be read. Paste the prompt into the agent once it starts.',
};

describe('initial_prompt_skipped warnings (#508)', () => {
  it('is not described as needing recovery', () => {
    const summary = summarizeDurableEffectWarnings([skipped]);
    expect(summary).toBe(`Pane created, but ${skipped.message}`);
    expect(summary).not.toContain('recovery');
  });

  it('still reports recovery when another warning is present', () => {
    const summary = summarizeDurableEffectWarnings([
      skipped,
      { code: 'effect_unknown', message: 'launch command dispatch failed' },
    ]);
    expect(summary).toContain('recovery is required');
    expect(summary).toContain('launch command dispatch failed');
  });

  it('summarizes an orchestration lane without its prompt', () => {
    const lane = {
      id: 'lane-1',
      status: 'completed',
      startedAt: 0,
      completedAt: 0,
      warnings: [skipped],
    } as unknown as OrchestrationLaneResult;
    const summary = summarizeOrchestrationWarnings([lane]);
    expect(summary).toMatch(/^Pane launched without its initial prompt: /u);
    expect(summary!.length).toBeLessThanOrEqual(512);
  });
});
