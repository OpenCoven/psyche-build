import { describe, expect, it } from 'vitest';

import {
  confirmationCopy,
  describePaneStatus,
  MAX_CONFIRMATION_FIELD_LENGTH,
  MAX_SUMMARY_FIELD_LENGTH,
  MAX_SUMMARY_LENGTH,
  motionTraitsFor,
  MOTION_SEMANTICS_CONTRACT_ID,
  MOTION_SEMANTICS_CONTRACT_VERSION,
  MOTION_TRAIT_CLASSES,
  MOTION_TRANSITION_KINDS,
  PANE_STATUS_DESCRIPTORS,
  PANE_STATUS_TOKENS,
  paneStatusText,
  summaryForPaneProjectHost,
  type ConfirmationActionKind,
  type MotionTransitionKind,
  type MotionTrait,
  type PaneStatusToken,
} from '../src/a11y/motionSemantics.js';

// Status must never be conveyed by color words — asserted against every piece
// of required copy below (contract §2.4).
const COLOR_VOCABULARY = /green|amber|red|blue|violet|purple|tint|colou?r/i;

const OVERSIZE = 'x'.repeat(MAX_SUMMARY_FIELD_LENGTH + 1);

describe('motionSemantics contract version', () => {
  it('is v1 with a stable contract identifier', () => {
    expect(MOTION_SEMANTICS_CONTRACT_VERSION).toBe(1);
    expect(MOTION_SEMANTICS_CONTRACT_ID).toBe('psyche.mobile.a11y.motion-semantics.v1');
  });
});

describe('pane status tokens carry required textual equivalents', () => {
  const TOKEN_TABLE: readonly PaneStatusToken[] = PANE_STATUS_TOKENS;

  it('describes every token with non-empty, non-color text and summary phrase', () => {
    expect.hasAssertions();
    for (const token of TOKEN_TABLE) {
      const descriptor = describePaneStatus(token);
      expect(descriptor.text.trim().length).toBeGreaterThan(0);
      expect(descriptor.summaryPhrase.trim().length).toBeGreaterThan(0);
      expect(descriptor.text).not.toMatch(COLOR_VOCABULARY);
      expect(descriptor.summaryPhrase).not.toMatch(COLOR_VOCABULARY);
      expect(['attention', 'active', 'neutral', 'degraded']).toContain(descriptor.severity);
    }
  });

  it('keeps the token union and descriptor table aligned in both directions', () => {
    const descriptorTokens = Object.keys(PANE_STATUS_DESCRIPTORS);
    expect(descriptorTokens.sort()).toEqual([...TOKEN_TABLE].sort());
  });

  it.each(TOKEN_TABLE)('token %s has a standalone textual equivalent', (token) => {
    expect(paneStatusText(token)).toBe(PANE_STATUS_DESCRIPTORS[token].text);
  });

  it('fails closed on unknown tokens', () => {
    expect(() => describePaneStatus('flabbergasted' as PaneStatusToken)).toThrow(TypeError);
  });
});

describe('summaryForPaneProjectHost', () => {
  const BASE_INPUT = {
    paneTitle: 'api-server',
    status: 'needs-you' as PaneStatusToken,
    projectName: 'psyche',
    hostName: 'lan-box',
    worktreeName: 'wt/212',
    branchName: 'feat/a11y',
  };

  it.each(PANE_STATUS_TOKENS)(
    'includes pane, status, project, worktree, branch, and host identity for status %s',
    (status) => {
      const summary = summaryForPaneProjectHost({ ...BASE_INPUT, status });
      const phrase = PANE_STATUS_DESCRIPTORS[status].summaryPhrase;

      expect(summary.label).toContain('Pane "api-server"');
      expect(summary.label).toContain(phrase);
      expect(summary.label).toContain('project "psyche"');
      expect(summary.label).toContain('worktree "wt/212"');
      expect(summary.label).toContain('branch "feat/a11y"');
      expect(summary.label).toContain('host "lan-box"');
      expect(summary.label).not.toMatch(COLOR_VOCABULARY);
      expect(summary.statusText).toBe(phrase);
      expect(summary.parts.map((part) => part.kind)).toEqual([
        'pane',
        'status',
        'project',
        'worktree',
        'branch',
        'host',
      ]);
    }
  );

  it('announces selected state first for the focused pane', () => {
    const summary = summaryForPaneProjectHost({ ...BASE_INPUT, isFocused: true });
    expect(summary.isFocused).toBe(true);
    expect(summary.label.startsWith('Selected; ')).toBe(true);
    expect(summary.parts[0]).toEqual({ kind: 'selected', text: 'Selected' });
    // Contract §4.4: selection never masks degraded state.
    const degraded = summaryForPaneProjectHost({
      ...BASE_INPUT,
      status: 'stale',
      isFocused: true,
    });
    expect(degraded.label).toContain('may be out of date');
    expect(degraded.label.startsWith('Selected; ')).toBe(true);
  });

  it('omits worktree and branch parts only when the caller has none', () => {
    const minimal = summaryForPaneProjectHost({
      paneTitle: 'api-server',
      status: 'running',
      projectName: 'psyche',
      hostName: 'lan-box',
    });
    expect(minimal.parts.map((part) => part.kind)).toEqual([
      'pane',
      'status',
      'project',
      'host',
    ]);
    expect(minimal.label).toContain('host "lan-box"');
  });

  it('is deterministic for identical input', () => {
    const a = summaryForPaneProjectHost(BASE_INPUT);
    const b = summaryForPaneProjectHost(BASE_INPUT);
    expect(a.label).toBe(b.label);
    expect(a.parts).toEqual(b.parts);
  });

  it('normalizes whitespace instead of emitting ragged labels', () => {
    const summary = summaryForPaneProjectHost({
      ...BASE_INPUT,
      paneTitle: '  api\n  server \t two  ',
    });
    expect(summary.label).toContain('Pane "api server two"');
  });

  it('rejects empty, whitespace-only, non-string, and oversize inputs', () => {
    expect(() => summaryForPaneProjectHost({ ...BASE_INPUT, paneTitle: '' })).toThrow(
      /paneTitle must not be empty/
    );
    expect(() => summaryForPaneProjectHost({ ...BASE_INPUT, projectName: '   ' })).toThrow(
      /projectName must not be empty/
    );
    expect(() => summaryForPaneProjectHost({ ...BASE_INPUT, hostName: '\n\t' })).toThrow(
      /hostName must not be empty/
    );
    expect(() =>
      summaryForPaneProjectHost({ ...BASE_INPUT, branchName: '' })
    ).toThrow(/branchName must not be empty/);
    expect(() =>
      summaryForPaneProjectHost({ ...BASE_INPUT, paneTitle: 42 as unknown as string })
    ).toThrow(TypeError);
    expect(() => summaryForPaneProjectHost({ ...BASE_INPUT, hostName: OVERSIZE })).toThrow(
      /hostName length .+ exceeds maximum/
    );
  });

  it('fails closed instead of truncating an oversized combined label', () => {
    const long = 'n'.repeat(MAX_SUMMARY_FIELD_LENGTH);
    expect(() =>
      summaryForPaneProjectHost({
        paneTitle: long,
        status: 'running',
        projectName: long,
        hostName: long,
      })
    ).toThrow(RangeError);
    expect(() =>
      summaryForPaneProjectHost({
        paneTitle: 'short',
        status: 'running',
        projectName: 'psyche',
        hostName: 'lan-box',
      })
    ).not.toThrow();
    expect(MAX_SUMMARY_LENGTH).toBe(280);
  });
});

describe('motionTraitsFor', () => {
  const EXPECTED_BASE_TRAITS: Record<MotionTransitionKind, readonly MotionTrait[]> = {
    'pane-selection': ['matched-geometry'],
    'pane-focus-change': ['move-transition'],
    'pane-open': ['slide-transition', 'opacity-crossfade'],
    'pane-close': ['slide-transition', 'opacity-crossfade'],
    'action-sheet-present': ['slide-transition', 'spring-animation'],
    'action-sheet-dismiss': ['opacity-crossfade'],
    'summary-refresh': ['opacity-crossfade'],
    'attention-pulse': ['pulse-animation'],
    'activity-progress': ['activity-indicator'],
  };

  it('classifies every trait; an unclassified transition is a contract violation', () => {
    expect.hasAssertions();
    for (const kind of MOTION_TRANSITION_KINDS) {
      const traits = EXPECTED_BASE_TRAITS[kind];
      expect(traits.length).toBeGreaterThan(0);
      for (const trait of traits) {
        expect(MOTION_TRAIT_CLASSES[trait]).toBeDefined();
      }
    }
  });

  it.each(MOTION_TRANSITION_KINDS)(
    'returns the v1 base traits for %s when motion is allowed',
    (kind) => {
      const plan = motionTraitsFor(kind);
      expect(plan.kind).toBe(kind);
      expect(plan.traits).toEqual(EXPECTED_BASE_TRAITS[kind]);
      expect(plan.reduceMotionStripped).toEqual([]);
      expect(plan.rendersInstantStateChange).toBe(false);
    }
  );

  it.each(MOTION_TRANSITION_KINDS)(
    'strips matched-geometry and nonessential transitions for %s under Reduce Motion',
    (kind) => {
      const plan = motionTraitsFor(kind, { reduceMotion: true });
      const strippedClasses = plan.reduceMotionStripped.map(
        (trait) => MOTION_TRAIT_CLASSES[trait]
      );
      // Only matched-geometry and nonessential-transition classes are removed.
      for (const traitClass of strippedClasses) {
        expect(['matched-geometry', 'nonessential-transition']).toContain(traitClass);
      }
      for (const trait of plan.traits) {
        expect(['essential-state', 'non-motion']).toContain(MOTION_TRAIT_CLASSES[trait]);
      }
      // Everything stripped must have been in the base table, nothing invented.
      const base = EXPECTED_BASE_TRAITS[kind];
      for (const trait of plan.reduceMotionStripped) {
        expect(base).toContain(trait);
      }
      expect(plan.rendersInstantStateChange).toBe(plan.traits.length === 0);
    }
  );

  it('renders instant state changes when every trait is stripped', () => {
    const selection = motionTraitsFor('pane-selection', { reduceMotion: true });
    expect(selection.traits).toEqual([]);
    expect(selection.reduceMotionStripped).toEqual(['matched-geometry']);
    expect(selection.rendersInstantStateChange).toBe(true);
  });

  it('retains the essential activity indicator under Reduce Motion', () => {
    const plan = motionTraitsFor('activity-progress', { reduceMotion: true });
    expect(plan.traits).toEqual(['activity-indicator']);
    expect(plan.reduceMotionStripped).toEqual([]);
    expect(plan.rendersInstantStateChange).toBe(false);
  });

  it('treats reduceMotion as off unless explicitly true', () => {
    expect(motionTraitsFor('pane-open', {}).traits).toEqual(['slide-transition', 'opacity-crossfade']);
    expect(motionTraitsFor('pane-open', { reduceMotion: false }).traits).toEqual([
      'slide-transition',
      'opacity-crossfade',
    ]);
  });

  it('fails closed on unknown transition kinds', () => {
    expect(() => motionTraitsFor('spin-to-win' as MotionTransitionKind)).toThrow(TypeError);
  });
});

describe('confirmationCopy', () => {
  const BASE_SCOPE = {
    hostName: 'lan-box',
    projectName: 'psyche',
    paneTitle: 'api-server',
    worktreeName: 'wt/212',
    branchName: 'feat/a11y',
  };

  it.each(['stop-pane', 'close-pane'] as const)(
    '%s copy is consequence-first and states worktree/branch survival',
    (action) => {
      const copy = confirmationCopy(action, BASE_SCOPE);
      const firstSentence = copy.detail.slice(0, copy.detail.indexOf('.'));

      expect(firstSentence).toContain(`pane "${BASE_SCOPE.paneTitle}"`);
      expect(firstSentence).toContain(`host "${BASE_SCOPE.hostName}"`);
      expect(firstSentence.toLowerCase()).toContain('now');
      expect(copy.detail.indexOf('This')).toBe(0);
      expect(copy.detail).toContain(`project "${BASE_SCOPE.projectName}"`);
      expect(copy.detail).toContain(`worktree "${BASE_SCOPE.worktreeName}"`);
      expect(copy.detail).toContain(`branch "${BASE_SCOPE.branchName}"`);
      expect(copy.detail).toMatch(/worktree and branch survive/);
      expect(copy.namesWorktreeAndBranchSurvival).toBe(true);
      expect(copy.destructive).toBe(true);
      expect(copy.confirmLabel).toBe(action === 'stop-pane' ? 'Stop pane' : 'Close pane');
      expect(copy.cancelLabel).toBe('Cancel');
      expect(copy.title).toBe(
        `${action === 'stop-pane' ? 'Stop pane' : 'Close pane'} "${BASE_SCOPE.paneTitle}"?`
      );
      expect(copy.detail).not.toMatch(COLOR_VOCABULARY);
    }
  );

  it('send-input copy names the delivery consequence without a survival claim', () => {
    const copy = confirmationCopy('send-input', BASE_SCOPE);
    expect(copy.destructive).toBe(false);
    expect(copy.namesWorktreeAndBranchSurvival).toBe(false);
    expect(copy.detail.startsWith('This sends your input to pane "api-server" on host "lan-box" now')).toBe(true);
    expect(copy.detail).not.toMatch(/survive/);
    expect(copy.confirmLabel).toBe('Send input');
  });

  it('honors a validated consequence override in the first position', () => {
    const override = 'This stops the recovery run before it can write receipts.';
    const copy = confirmationCopy('stop-pane', { ...BASE_SCOPE, consequenceOverride: override });
    expect(copy.detail.indexOf(override)).toBe(0);
    expect(copy.detail).toContain(`pane "${BASE_SCOPE.paneTitle}"`);
    expect(copy.detail).toMatch(/worktree and branch survive/);
  });

  it('rejects empty, whitespace-only, oversize, and non-string scope fields', () => {
    expect(() => confirmationCopy('stop-pane', { ...BASE_SCOPE, hostName: '' })).toThrow(
      /hostName must not be empty/
    );
    expect(() => confirmationCopy('close-pane', { ...BASE_SCOPE, paneTitle: ' \n ' })).toThrow(
      /paneTitle must not be empty/
    );
    expect(() =>
      confirmationCopy('send-input', { ...BASE_SCOPE, projectName: 'y'.repeat(MAX_CONFIRMATION_FIELD_LENGTH + 1) })
    ).toThrow(/projectName length .+ exceeds maximum/);
    expect(() =>
      confirmationCopy('stop-pane', {
        ...BASE_SCOPE,
        consequenceOverride: '',
      })
    ).toThrow(/consequenceOverride must not be empty/);
    expect(() =>
      confirmationCopy('stop-pane', {
        ...BASE_SCOPE,
        consequenceOverride: 'z'.repeat(MAX_CONFIRMATION_FIELD_LENGTH + 1),
      })
    ).toThrow(/consequenceOverride length .+ exceeds maximum/);
    expect(() =>
      confirmationCopy('stop-pane', { ...BASE_SCOPE, hostName: 7 as unknown as string })
    ).toThrow(TypeError);
    expect(() =>
      confirmationCopy('detonate-pane' as ConfirmationActionKind, BASE_SCOPE)
    ).toThrow(TypeError);
    expect(MAX_CONFIRMATION_FIELD_LENGTH).toBe(120);
  });
});
