import { readFile } from 'node:fs/promises';

/**
 * A recovery file the running version cannot interpret.
 *
 * Recovery state is the one genuinely multi-version surface on disk: a newer
 * Psyche, or a crash during a write, can leave a file this version does not
 * understand. Quarantining names that file for an operator instead of throwing
 * a whole listing away, while the destructive-cleanup gates keep failing closed
 * on it. Only fields that can be salvaged without trusting the payload are
 * carried: the declared version, and a bounded pane slug that still looks like
 * a slug. Nothing derived from the payload's bytes — a parser message included,
 * since those quote the input — ever reaches the operator.
 */
export interface QuarantinedRecoveryFile {
  path: string;
  reason: string;
  version?: number;
  slug?: string;
}

const SALVAGEABLE_SLUG = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Slugs are generated from short branch-like names; anything longer is not one. */
const MAX_SALVAGED_SLUG_LENGTH = 64;

export type RecoveryFileRead =
  | { parsed: unknown; quarantined?: undefined }
  | { parsed?: undefined; quarantined: QuarantinedRecoveryFile };

/**
 * Reads one recovery file, separating an I/O failure from a parse failure so
 * the operator is not told a permissions denial was corrupt JSON.
 */
export async function readRecoveryFile(filePath: string): Promise<RecoveryFileRead> {
  let contents: string;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      quarantined: {
        path: filePath,
        reason: `could not be read${code ? `: ${code}` : ''}`,
      },
    };
  }
  try {
    return { parsed: JSON.parse(contents) as unknown };
  } catch {
    // The parser's message quotes the input, so only the outcome is reported.
    return {
      quarantined: { path: filePath, reason: 'could not be parsed as JSON' },
    };
  }
}

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
  return typeof candidate === 'string'
    && candidate.length <= MAX_SALVAGED_SLUG_LENGTH
    && SALVAGEABLE_SLUG.test(candidate)
    ? candidate
    : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}
