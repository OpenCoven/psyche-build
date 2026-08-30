import { describe, expect, it } from 'vitest';

import {
  availabilityFor,
  confirmationCopy,
  confirmationRequiredFor,
  CONFIRMATION_PRESENTATION_ORDER,
  describePaneAction,
  describePaneActionFeedback,
  feedbackLineFor,
  isPaneActionId,
  MAX_ACTION_FIELD_LENGTH,
  MAX_AVAILABILITY_REASON_LENGTH,
  MAX_CONFIRMATION_DETAIL_LENGTH,
  MAX_CONFIRMATION_FIELD_LENGTH,
  MAX_FEEDBACK_DETAIL_LENGTH,
  PANE_ACTION_CATALOG,
  PANE_ACTION_CATALOG_ID,
  PANE_ACTION_CATALOG_VERSION,
  PANE_ACTION_DESTRUCTIVE_IDS,
  PANE_ACTION_FEEDBACK_DESCRIPTORS,
  PANE_ACTION_FEEDBACK_STATES,
  PANE_ACTION_IDS,
  type PaneActionId,
  type PaneActionScope,
} from '../src/mobile/paneActionCatalog.js';

// Required copy never encodes meaning in color words or emoji (contract §4.5).
const COLOR_VOCABULARY = /green|amber|red|blue|violet|purple|tint|colou?r/i;
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

const OVERSIZE_FIELD = 'x'.repeat(MAX_CONFIRMATION_FIELD_LENGTH + 1);

/** The destructive subset of the v1 ids, derived from the exported set. */
type DestructiveActionId = (typeof PANE_ACTION_DESTRUCTIVE_IDS)[number];

const BASE_SCOPE: PaneActionScope = {
  paneTitle: 'api-server',
  projectName: 'psyche',
  hostName: 'lan-box',
  worktreeName: 'wt/218',
  branchName: 'feat/pane-actions',
};

describe('paneActionCatalog contract version', () => {
  it('is v1 with a stable contract identifier', () => {
    expect(PANE_ACTION_CATALOG_VERSION).toBe(1);
    expect(PANE_ACTION_CATALOG_ID).toBe('psyche.mobile.pane-action-catalog.v1');
  });
});

describe('v1 action catalog', () => {
  it('offers exactly the seven v1 actions in contract order', () => {
    expect.hasAssertions();
    expect([...PANE_ACTION_IDS]).toEqual([
      'merge',
      'create-pr',
      'stop',
      'close',
      'rename',
      'files',
      'rituals',
    ]);
  });

  it('keeps the id union and descriptor table aligned in both directions', () => {
    expect(Object.keys(PANE_ACTION_CATALOG).sort()).toEqual([...PANE_ACTION_IDS].sort());
  });

  it('gives every action a non-empty, non-color, emoji-free title and consequence summary', () => {
    expect.hasAssertions();
    for (const id of PANE_ACTION_IDS) {
      const descriptor = describePaneAction(id);
      expect(descriptor.menuTitle.trim().length).toBeGreaterThan(0);
      expect(descriptor.consequenceSummary.trim().length).toBeGreaterThan(0);
      expect(descriptor.menuTitle).not.toMatch(COLOR_VOCABULARY);
      expect(descriptor.menuTitle).not.toMatch(EMOJI);
      expect(descriptor.consequenceSummary).not.toMatch(COLOR_VOCABULARY);
      expect(descriptor.consequenceSummary).not.toMatch(EMOJI);
      expect(descriptor.menuTitle.length).toBeLessThanOrEqual(MAX_ACTION_FIELD_LENGTH);
      expect(descriptor.consequenceSummary.length).toBeLessThanOrEqual(MAX_ACTION_FIELD_LENGTH);
      for (const scope of descriptor.touches) {
        expect(['host', 'project', 'pane', 'worktree', 'branch']).toContain(scope);
      }
    }
  });

  it('gives every action a unique menu title', () => {
    const titles = PANE_ACTION_IDS.map((id) => PANE_ACTION_CATALOG[id].menuTitle);
    expect(new Set(titles).size).toBe(PANE_ACTION_IDS.length);
  });

  it('carries the trailing ellipsis exactly when the action opens a follow-up flow', () => {
    expect.hasAssertions();
    for (const id of PANE_ACTION_IDS) {
      const descriptor = describePaneAction(id);
      if (descriptor.opensFollowUpFlow) {
        expect(descriptor.menuTitle.endsWith('…')).toBe(true);
      } else {
        expect(descriptor.menuTitle.endsWith('…')).toBe(false);
      }
    }
  });

  it('routes cleanup through the single close action id', () => {
    expect.hasAssertions();
    expect(PANE_ACTION_IDS).toContain('close');
    expect(PANE_ACTION_IDS).not.toContain('cleanup');
    expect(isPaneActionId('cleanup')).toBe(false);
  });
});

describe('confirmationRequiredFor (destructive set)', () => {
  it('requires confirmation for every destructive action: merge, stop, close', () => {
    expect.hasAssertions();
    for (const id of PANE_ACTION_IDS) {
      const requires = confirmationRequiredFor(id);
      if (PANE_ACTION_DESTRUCTIVE_IDS.includes(id as DestructiveActionId)) {
        expect(requires).toBe(true);
      } else {
        expect(requires).toBe(false);
      }
    }
  });

  it('has exactly the v1 destructive set merge, stop, close', () => {
    expect([...PANE_ACTION_DESTRUCTIVE_IDS].sort()).toEqual(['close', 'merge', 'stop']);
  });

  it('matches the descriptor table', () => {
    expect.hasAssertions();
    for (const id of PANE_ACTION_IDS) {
      expect(confirmationRequiredFor(id)).toBe(PANE_ACTION_CATALOG[id].destructive);
    }
  });

  it('fails closed on unknown actions', () => {
    expect(() => confirmationRequiredFor('cleanup' as PaneActionId)).toThrow(TypeError);
  });
});

describe('confirmationCopy', () => {
  it('builds copy for exactly the destructive set and rejects non-destructive actions', () => {
    expect.hasAssertions();
    for (const id of PANE_ACTION_IDS) {
      if (PANE_ACTION_DESTRUCTIVE_IDS.includes(id as DestructiveActionId)) {
        const copy = confirmationCopy(id as DestructiveActionId, BASE_SCOPE);
        expect(copy.action).toBe(id);
        expect(copy.destructive).toBe(true);
      } else {
        expect(() => confirmationCopy(id, BASE_SCOPE)).toThrow(/not destructive/);
      }
    }
  });

  it.each(['merge', 'stop', 'close'] as const)(
    'reads the consequence first, then scope, then disposition for %s',
    (action) => {
      const copy = confirmationCopy(action, BASE_SCOPE);
      expect(copy.detail.startsWith(copy.consequenceSentence)).toBe(true);
      expect(copy.detail).toContain(copy.scopeSentence);
      expect(copy.detail).toContain(copy.dispositionSentence);
      expect(copy.detail.indexOf(copy.scopeSentence)).toBeGreaterThan(
        copy.detail.indexOf(copy.consequenceSentence)
      );
      expect(copy.detail.indexOf(copy.dispositionSentence)).toBeGreaterThan(
        copy.detail.indexOf(copy.scopeSentence)
      );
      expect(copy.presentationOrder).toEqual(CONFIRMATION_PRESENTATION_ORDER);
      expect(copy.presentationOrder[0]).toBe('consequence');
      expect(copy.presentationOrder[copy.presentationOrder.length - 2]).toBe('confirm-button');
      expect(copy.presentationOrder[copy.presentationOrder.length - 1]).toBe('cancel-button');
    }
  );

  it.each(['merge', 'stop', 'close'] as const)(
    'names the exact scope (pane, project, worktree, branch, host) for %s',
    (action) => {
      const copy = confirmationCopy(action, BASE_SCOPE);
      expect(copy.scopeSentence).toContain('pane "api-server"');
      expect(copy.scopeSentence).toContain('project "psyche"');
      expect(copy.scopeSentence).toContain('worktree "wt/218"');
      expect(copy.scopeSentence).toContain('branch "feat/pane-actions"');
      expect(copy.scopeSentence).toContain('host "lan-box"');
    }
  );

  it.each(['merge', 'stop', 'close'] as const)(
    'omits worktree and branch from scope only when the caller has none (%s)',
    (action) => {
      const copy = confirmationCopy(action, {
        paneTitle: 'api-server',
        projectName: 'psyche',
        hostName: 'lan-box',
      });
      expect(copy.scopeSentence).toContain('pane "api-server"');
      expect(copy.scopeSentence).toContain('project "psyche"');
      expect(copy.scopeSentence).toContain('host "lan-box"');
      expect(copy.scopeSentence).not.toContain('worktree');
      expect(copy.scopeSentence).not.toContain('branch');
    }
  );

  it('names the merge target branch when the caller knows it', () => {
    const copy = confirmationCopy('merge', {
      ...BASE_SCOPE,
      mergeTargetBranchName: 'main',
    });
    expect(copy.consequenceSentence).toContain('into branch "main"');
    expect(copy.consequenceSentence).toContain('branch "feat/pane-actions"');
    expect(copy.dispositionSentence).toContain('branch "main"');
  });

  it('defers merge target selection to the host when the caller does not know it', () => {
    const copy = confirmationCopy('merge', BASE_SCOPE);
    expect(copy.consequenceSentence).toContain(
      'the host validates the merge and selects the target branch'
    );
    expect(copy.consequenceSentence).toContain('branch "feat/pane-actions"');

    const noBranch = confirmationCopy('merge', {
      paneTitle: 'api-server',
      projectName: 'psyche',
      hostName: 'lan-box',
    });
    expect(noBranch.consequenceSentence).toContain("the pane's branch");
  });

  it('uses a verb-first confirm label, a plain Cancel, and a title naming action and pane', () => {
    const stop = confirmationCopy('stop', BASE_SCOPE);
    expect(stop.confirmLabel).toBe('Stop Pane');
    expect(stop.title).toBe('Stop Pane "api-server"?');
    expect(stop.cancelLabel).toBe('Cancel');

    const merge = confirmationCopy('merge', { ...BASE_SCOPE, mergeTargetBranchName: 'main' });
    expect(merge.confirmLabel).toBe('Merge Branch');
    expect(merge.title).toBe('Merge Branch "api-server"?');

    const close = confirmationCopy('close', BASE_SCOPE);
    expect(close.confirmLabel).toBe('Close and Clean Up');
    expect(close.title).toBe('Close and Clean Up "api-server"?');
  });

  it('never relies on color vocabulary or emoji in any copy field', () => {
    expect.hasAssertions();
    for (const action of PANE_ACTION_DESTRUCTIVE_IDS) {
      const copy = confirmationCopy(action, BASE_SCOPE);
      for (const text of [
        copy.title,
        copy.detail,
        copy.consequenceSentence,
        copy.scopeSentence,
        copy.dispositionSentence,
        copy.confirmLabel,
        copy.cancelLabel,
      ]) {
        expect(text).not.toMatch(COLOR_VOCABULARY);
        expect(text).not.toMatch(EMOJI);
      }
    }
  });

  it('is deterministic for identical input', () => {
    const a = confirmationCopy('stop', BASE_SCOPE);
    const b = confirmationCopy('stop', BASE_SCOPE);
    expect(a).toEqual(b);
  });

  it('normalizes whitespace instead of emitting ragged copy', () => {
    const copy = confirmationCopy('stop', {
      ...BASE_SCOPE,
      paneTitle: '  api\n  server \t two  ',
    });
    expect(copy.title).toBe('Stop Pane "api server two"?');
    expect(copy.scopeSentence).toContain('pane "api server two"');
  });

  it('rejects empty, whitespace-only, non-string, and oversize fields', () => {
    expect(() => confirmationCopy('stop', { ...BASE_SCOPE, paneTitle: '' })).toThrow(
      /paneTitle must not be empty/
    );
    expect(() => confirmationCopy('stop', { ...BASE_SCOPE, projectName: '   ' })).toThrow(
      /projectName must not be empty/
    );
    expect(() => confirmationCopy('stop', { ...BASE_SCOPE, hostName: '\n\t' })).toThrow(
      /hostName must not be empty/
    );
    expect(() => confirmationCopy('stop', { ...BASE_SCOPE, branchName: '' })).toThrow(
      /branchName must not be empty/
    );
    expect(() =>
      confirmationCopy('stop', { ...BASE_SCOPE, worktreeName: 42 as unknown as string })
    ).toThrow(TypeError);
    expect(() => confirmationCopy('stop', { ...BASE_SCOPE, hostName: OVERSIZE_FIELD })).toThrow(
      /hostName length .+ exceeds maximum/
    );
  });

  it('fails closed instead of truncating an oversized combined detail', () => {
    const wide: PaneActionScope = {
      paneTitle: 'p'.repeat(MAX_CONFIRMATION_FIELD_LENGTH),
      projectName: 'j'.repeat(MAX_CONFIRMATION_FIELD_LENGTH),
      hostName: 'h'.repeat(MAX_CONFIRMATION_FIELD_LENGTH),
      worktreeName: 'w'.repeat(MAX_CONFIRMATION_FIELD_LENGTH),
      branchName: 'b'.repeat(MAX_CONFIRMATION_FIELD_LENGTH),
    };
    expect(() => confirmationCopy('close', wide)).toThrow(
      /combined confirmation detail length .+ exceeds maximum/
    );
    expect(MAX_CONFIRMATION_DETAIL_LENGTH).toBe(600);
  });

  it('fails closed on unknown actions', () => {
    expect(() => confirmationCopy('cleanup' as PaneActionId, BASE_SCOPE)).toThrow(TypeError);
  });
});

describe('availabilityFor (stale and already-running actions are disabled)', () => {
  const CLEAN_CONTEXT = { hostReachable: true, isStale: false } as const;

  it('offers every action on a fresh, idle pane with a reachable host', () => {
    expect.hasAssertions();
    for (const id of PANE_ACTION_IDS) {
      const availability = availabilityFor(id, CLEAN_CONTEXT);
      expect(availability.available).toBe(true);
      expect(availability.disabled).toBe(false);
      expect(availability.disabledReasonToken).toBeUndefined();
      expect(availability.disabledReason).toBeUndefined();
    }
  });

  it('disables every action on a stale pane with a reason naming the action', () => {
    expect.hasAssertions();
    for (const id of PANE_ACTION_IDS) {
      const availability = availabilityFor(id, { ...CLEAN_CONTEXT, isStale: true });
      expect(availability.available).toBe(false);
      expect(availability.disabled).toBe(true);
      expect(availability.disabledReasonToken).toBe('stale-context');
      const reason = availability.disabledReason ?? '';
      expect(reason).toContain(PANE_ACTION_CATALOG[id].menuTitle);
      expect(reason).toContain('stale');
      expect(reason).not.toMatch(COLOR_VOCABULARY);
      expect(reason.length).toBeLessThanOrEqual(MAX_AVAILABILITY_REASON_LENGTH);
    }
  });

  it('disables an already-running action with an already-running reason', () => {
    const availability = availabilityFor('stop', { ...CLEAN_CONTEXT, runningAction: 'stop' });
    expect(availability.available).toBe(false);
    expect(availability.disabledReasonToken).toBe('action-already-running');
    const reason = availability.disabledReason ?? '';
    expect(reason).toContain('already running');
    expect(reason).toContain('Stop Pane');
  });

  it('disables every other action while one is running, naming the running action', () => {
    expect.hasAssertions();
    for (const id of PANE_ACTION_IDS) {
      const availability = availabilityFor(id, { ...CLEAN_CONTEXT, runningAction: 'merge' });
      expect(availability.available).toBe(false);
      const reason = availability.disabledReason ?? '';
      if (id === 'merge') {
        expect(availability.disabledReasonToken).toBe('action-already-running');
      } else {
        expect(availability.disabledReasonToken).toBe('another-action-running');
        expect(reason).toContain('Merge…');
        expect(reason).toContain(PANE_ACTION_CATALOG[id].menuTitle);
      }
      expect(reason).not.toMatch(COLOR_VOCABULARY);
    }
  });

  it('disables every action when the host is unreachable', () => {
    expect.hasAssertions();
    for (const id of PANE_ACTION_IDS) {
      const availability = availabilityFor(id, { ...CLEAN_CONTEXT, hostReachable: false });
      expect(availability.available).toBe(false);
      expect(availability.disabledReasonToken).toBe('host-unreachable');
      const reason = availability.disabledReason ?? '';
      expect(reason).toContain(PANE_ACTION_CATALOG[id].menuTitle);
    }
  });

  it('applies the documented precedence: host unreachable, then running, then stale', () => {
    const unreachableAndRunning = availabilityFor('stop', {
      isStale: true,
      runningAction: 'merge',
      hostReachable: false,
    });
    expect(unreachableAndRunning.disabledReasonToken).toBe('host-unreachable');

    const runningAndStale = availabilityFor('stop', { isStale: true, runningAction: 'merge' });
    expect(runningAndStale.disabledReasonToken).toBe('another-action-running');

    const runningSameAndStale = availabilityFor('merge', {
      isStale: true,
      runningAction: 'merge',
    });
    expect(runningSameAndStale.disabledReasonToken).toBe('action-already-running');
  });

  it('fails closed on unknown actions and unknown running actions', () => {
    expect(() => availabilityFor('cleanup' as PaneActionId, CLEAN_CONTEXT)).toThrow(TypeError);
    expect(() =>
      availabilityFor('stop', { ...CLEAN_CONTEXT, runningAction: 'explode' as PaneActionId })
    ).toThrow(TypeError);
  });
});

describe('stop vs close and clean up: visual and semantic distinctness', () => {
  const stopDescriptor = PANE_ACTION_CATALOG.stop;
  const closeDescriptor = PANE_ACTION_CATALOG.close;

  it('uses different action ids', () => {
    expect(stopDescriptor.id).not.toBe(closeDescriptor.id);
    expect(stopDescriptor.id).toBe('stop');
    expect(closeDescriptor.id).toBe('close');
  });

  it('uses different menu titles', () => {
    expect(stopDescriptor.menuTitle).toBe('Stop Pane');
    expect(closeDescriptor.menuTitle).toBe('Close and Clean Up…');
    expect(stopDescriptor.menuTitle).not.toBe(closeDescriptor.menuTitle);
  });

  it('uses different consequence summaries and confirmation consequence sentences', () => {
    const stopCopy = confirmationCopy('stop', BASE_SCOPE);
    const closeCopy = confirmationCopy('close', BASE_SCOPE);
    expect(stopDescriptor.consequenceSummary).not.toBe(closeDescriptor.consequenceSummary);
    expect(stopCopy.consequenceSentence).not.toBe(closeCopy.consequenceSentence);
    expect(stopCopy.dispositionSentence).not.toBe(closeCopy.dispositionSentence);
    expect(closeCopy.consequenceSentence).toContain('removes the pane from the cockpit');
    expect(closeCopy.consequenceSentence).toContain('host cleanup choices');
  });

  it('encodes different survival semantics in the type and the copy', () => {
    expect(stopDescriptor.survival).toBe('session-ends-pane-retained');
    expect(closeDescriptor.survival).toBe('session-ends-pane-removed');
    const stopCopy = confirmationCopy('stop', BASE_SCOPE);
    const closeCopy = confirmationCopy('close', BASE_SCOPE);
    expect(stopCopy.dispositionSentence).toContain('can be restarted');
    expect(closeCopy.dispositionSentence).toContain('unless the host cleanup choices');
    expect(stopCopy.dispositionSentence).not.toBe(closeCopy.dispositionSentence);
  });

  it('states in both copies that the worktree and branch survive the pane action', () => {
    const stopCopy = confirmationCopy('stop', BASE_SCOPE);
    const closeCopy = confirmationCopy('close', BASE_SCOPE);
    expect(stopCopy.dispositionSentence).toContain('The worktree and branch survive');
    expect(closeCopy.dispositionSentence).toContain('The worktree and branch are kept');
  });

  it('presents close and clean up with the same destructive guard as stop', () => {
    expect(confirmationRequiredFor('stop')).toBe(true);
    expect(confirmationRequiredFor('close')).toBe(true);
    expect(() => confirmationCopy('stop', BASE_SCOPE)).not.toThrow();
    expect(() => confirmationCopy('close', BASE_SCOPE)).not.toThrow();
  });
});

describe('result, error, and progress feedback states', () => {
  it('is a bounded v1 vocabulary with required text for every state', () => {
    expect([...PANE_ACTION_FEEDBACK_STATES]).toEqual(['in-progress', 'succeeded', 'failed']);
    expect(Object.keys(PANE_ACTION_FEEDBACK_DESCRIPTORS).sort()).toEqual(
      [...PANE_ACTION_FEEDBACK_STATES].sort()
    );
    expect.hasAssertions();
    for (const state of PANE_ACTION_FEEDBACK_STATES) {
      const descriptor = describePaneActionFeedback(state);
      expect(descriptor.text.trim().length).toBeGreaterThan(0);
      expect(descriptor.summaryPhrase.trim().length).toBeGreaterThan(0);
      expect(descriptor.text).not.toMatch(COLOR_VOCABULARY);
      expect(descriptor.summaryPhrase).not.toMatch(COLOR_VOCABULARY);
    }
  });

  it('builds feedback lines that always name the action', () => {
    expect(feedbackLineFor('stop', 'in-progress')).toBe('"Stop Pane" is in progress');
    expect(feedbackLineFor('merge', 'succeeded')).toBe('"Merge…" completed');
    expect(feedbackLineFor('create-pr', 'succeeded', { detail: 'https://example.invalid/pr/1' }))
      .toBe('"Create Pull Request…" completed: https://example.invalid/pr/1');
    expect(feedbackLineFor('merge', 'failed', { detail: 'host rejected the merge target' }))
      .toBe('"Merge…" failed: host rejected the merge target');
  });

  it('passes host detail through normalized, never truncated away', () => {
    const line = feedbackLineFor('stop', 'failed', { detail: '  host said:\n  session gone  ' });
    expect(line).toBe('"Stop Pane" failed: host said: session gone');
  });

  it('fails closed on oversize detail', () => {
    expect(() =>
      feedbackLineFor('stop', 'failed', { detail: 'x'.repeat(MAX_FEEDBACK_DETAIL_LENGTH + 1) })
    ).toThrow(/detail length .+ exceeds maximum/);
    expect(MAX_FEEDBACK_DETAIL_LENGTH).toBe(400);
  });

  it('fails closed on unknown states', () => {
    expect(() => describePaneActionFeedback('retrying' as 'in-progress')).toThrow(TypeError);
    expect(() => feedbackLineFor('stop', 'queued' as 'in-progress')).toThrow(TypeError);
  });
});

describe('unknown action rejection', () => {
  it('rejects unknown ids everywhere a PaneActionId is required', () => {
    const unknown = 'detonate' as PaneActionId;
    expect(isPaneActionId('detonate')).toBe(false);
    expect(isPaneActionId(42)).toBe(false);
    expect(() => describePaneAction(unknown)).toThrow(/unknown pane action/);
    expect(() => confirmationRequiredFor(unknown)).toThrow(/unknown pane action/);
    expect(() => confirmationCopy(unknown, BASE_SCOPE)).toThrow(/unknown pane action/);
    expect(() => availabilityFor(unknown, {})).toThrow(/unknown pane action/);
    expect(() => feedbackLineFor(unknown, 'in-progress')).toThrow(/unknown pane action/);
  });

  it('accepts exactly the v1 ids through the narrowing guard', () => {
    expect.hasAssertions();
    for (const id of PANE_ACTION_IDS) {
      expect(isPaneActionId(id)).toBe(true);
    }
  });
});
