export interface DurableEffectWarning {
  code: 'effect_unknown' | 'pane_cleanup_repair_required';
  message: string;
  recoveryId?: string;
  projectRoot?: string;
  markerId?: string;
}

export function attachDurableEffectWarning(
  target: { recoveryWarnings?: readonly DurableEffectWarning[] },
  warning: DurableEffectWarning,
): void {
  Object.defineProperty(target, 'recoveryWarnings', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: [...(target.recoveryWarnings || []), warning],
  });
}

export function summarizeDurableEffectWarnings(
  warnings: readonly DurableEffectWarning[] | undefined,
  subject = 'Pane created',
): string | undefined {
  if (!warnings?.length) {
    return undefined;
  }
  const cleanup = warnings.find((warning) => (
    warning.code === 'pane_cleanup_repair_required'
    && warning.markerId
  ));
  if (cleanup?.markerId) {
    return `${subject}, but recovery marker ${cleanup.markerId} requires repair. ${
      cleanup.projectRoot
        ? `After verification, run psyche recover --project "${cleanup.projectRoot}" --acknowledge ${cleanup.markerId}.`
        : 'Acknowledge it with psyche recover after verification.'
    }`.slice(0, 512);
  }
  const details = Array.from(new Set(
    warnings.map((warning) => warning.message.replace(/[\r\n\0]/g, ' ').trim()),
  )).filter(Boolean);
  return `${subject}, but recovery is required: ${details.join('; ')}`.slice(0, 512);
}
