// @ts-check

/**
 * @typedef {0 | 1 | 2 | 3 | 4} CanonicalTargetPriority
 */

/**
 * @typedef {{
 *   issue: number,
 *   title: string,
 *   priority: CanonicalTargetPriority,
 * }} CanonicalTarget
 */

/**
 * @typedef {Readonly<Record<string, CanonicalTarget>>} CanonicalTargets
 */

/**
 * @typedef {{
 *   id: string,
 *   status: string,
 *   priority: number,
 *   externalRef?: string | null,
 * }} CanonicalOutcomeBead
 */

/**
 * @typedef {{
 *   mappedActiveCount: number,
 *   unmappedActiveBeadIds: readonly string[],
 *   unknownTargetBeadIds: readonly string[],
 *   priorityMismatchBeadIds: readonly string[],
 * }} CanonicalOutcomeValidation
 */

export const CANONICAL_OUTCOME_REF_PATTERN = /^gh-([1-9]\d*)$/u;
export const CANONICAL_OUTCOME_DIAGNOSTIC_ID_LIMIT = 50;

/**
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * @param {unknown} value
 * @param {string} context
 * @param {{allowNull?: boolean}} [options]
 * @returns {string | null}
 */
export function normalizeCanonicalOutcomeRef(value, context, options = {}) {
  if (value == null && options.allowNull === true) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`${context} must be a canonical GitHub outcome reference`);
  }
  const match = value.match(CANONICAL_OUTCOME_REF_PATTERN);
  const issue = match == null ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(issue) || issue <= 0) {
    throw new Error(`${context} must match "gh-<positive integer>"`);
  }
  return `gh-${issue}`;
}

/**
 * @param {string} reference
 * @returns {number}
 */
export function canonicalOutcomeIssueNumber(reference) {
  const normalized = /** @type {string} */ (normalizeCanonicalOutcomeRef(
    reference,
    'Canonical GitHub outcome reference',
  ));
  return Number(normalized.slice(3));
}

/**
 * @param {readonly string[]} values
 * @returns {readonly string[]}
 */
function boundedSortedIds(values) {
  return Object.freeze(
    [...values].sort(compareStrings).slice(0, CANONICAL_OUTCOME_DIAGNOSTIC_ID_LIMIT),
  );
}

export class CanonicalOutcomeValidationError extends Error {
  /**
   * @param {string} message
   * @param {CanonicalOutcomeValidation} diagnostics
   */
  constructor(message, diagnostics) {
    super(message);
    this.name = 'CanonicalOutcomeValidationError';
    this.diagnostics = diagnostics;
  }
}

/**
 * @param {readonly CanonicalOutcomeBead[]} beads
 * @param {CanonicalTargets} canonicalTargets
 * @returns {CanonicalOutcomeValidation}
 */
export function validateCanonicalOutcomes(beads, canonicalTargets) {
  if (!Array.isArray(beads)) {
    throw new Error('Canonical outcome validation expected a Beads inventory array');
  }
  if (
    typeof canonicalTargets !== 'object'
    || canonicalTargets == null
    || Array.isArray(canonicalTargets)
  ) {
    throw new Error('Canonical outcome validation expected canonicalTargets');
  }

  let mappedActiveCount = 0;
  const unmapped = [];
  const unknown = [];
  const mismatches = [];
  const reasons = [];

  for (const bead of beads) {
    if (bead.status === 'closed') {
      continue;
    }
    if (bead.externalRef == null) {
      unmapped.push(bead.id);
      reasons.push(`${bead.id} is active but has no external_ref`);
      continue;
    }

    const reference = /** @type {string} */ (normalizeCanonicalOutcomeRef(
      bead.externalRef,
      `Bead "${bead.id}" external_ref`,
    ));
    const target = canonicalTargets[reference];
    if (target == null) {
      unknown.push(bead.id);
      reasons.push(`${bead.id} uses unknown canonical target ${reference}`);
      continue;
    }

    mappedActiveCount += 1;
    if (bead.priority !== target.priority) {
      mismatches.push(bead.id);
      reasons.push(
        `${bead.id} priority P${bead.priority} does not match ${reference} priority P${target.priority}`,
      );
    }
  }

  const diagnostics = Object.freeze({
    mappedActiveCount,
    unmappedActiveBeadIds: boundedSortedIds(unmapped),
    unknownTargetBeadIds: boundedSortedIds(unknown),
    priorityMismatchBeadIds: boundedSortedIds(mismatches),
  });

  if (reasons.length > 0) {
    const boundedReasons = reasons
      .sort(compareStrings)
      .slice(0, CANONICAL_OUTCOME_DIAGNOSTIC_ID_LIMIT);
    const omitted = reasons.length - boundedReasons.length;
    throw new CanonicalOutcomeValidationError(
      `Invalid canonical Beads outcomes: ${boundedReasons.join('; ')}${
        omitted > 0 ? `; ${omitted} additional validation failures omitted` : ''
      }`,
      diagnostics,
    );
  }

  return diagnostics;
}
