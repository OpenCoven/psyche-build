/**
 * A recovery file the running version cannot interpret.
 *
 * Recovery state is the one genuinely multi-version surface on disk: a newer
 * Psyche, or a crash during a write, can leave a file this version does not
 * understand. Quarantining names that file for an operator instead of throwing
 * a whole listing away, while the destructive-cleanup gates keep failing closed
 * on it. Only fields that can be salvaged without trusting the payload are
 * carried: the declared version, and a pane slug that still looks like a slug.
 */
export interface QuarantinedRecoveryFile {
  path: string;
  reason: string;
  version?: number;
  slug?: string;
}

const SALVAGEABLE_SLUG = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function quarantineEntry(
  filePath: string,
  parsed: unknown,
  subject: string,
): QuarantinedRecoveryFile {
  const version = salvageVersion(parsed);
  const slug = salvageSlug(parsed);
  return {
    path: filePath,
    reason: version === undefined
      ? `does not match the supported ${subject} schema`
      : `unrecognized ${subject} version ${version}`,
    ...(version === undefined ? {} : { version }),
    ...(slug === undefined ? {} : { slug }),
  };
}

function salvageVersion(parsed: unknown): number | undefined {
  const version = record(parsed)?.version;
  return typeof version === 'number' && Number.isFinite(version) ? version : undefined;
}

function salvageSlug(parsed: unknown): string | undefined {
  const root = record(parsed);
  const candidate = root?.slug ?? record(root?.pane)?.slug;
  return typeof candidate === 'string' && SALVAGEABLE_SLUG.test(candidate)
    ? candidate
    : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}
