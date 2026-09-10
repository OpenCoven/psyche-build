// @ts-check

// Owner-approved survivors for incident #420; not a general duplicate-election policy.
export const RECOVERY_PAIRS = Object.freeze([
  ['psyche-i7c', 208, 395],
  ['psyche-i7c.10', 209, 396],
  ['psyche-i7c.10.1', 210, 397],
  ['psyche-i7c.10.2', 211, 398],
  ['psyche-i7c.10.3', 212, 399],
  ['psyche-i7c.10.4', 213, 400],
  ['psyche-i7c.10.5', 214, 401],
  ['psyche-i7c.10.6', 215, 402],
  ['psyche-i7c.11', 216, 403],
  ['psyche-i7c.9', 217, 404],
  ['psyche-i7c.9.2', 218, 405],
  ['psyche-i7c.9.3', 219, 406],
  ['psyche-i7c.9.4', 220, 407],
  ['psyche-i7c.9.5', 221, 408],
  ['psyche-no8', 222, 409],
  ['psyche-no8.1', 223, 410],
  ['psyche-no8.2', 224, 411],
  ['psyche-no8.3', 225, 412],
  ['psyche-no8.4', 226, 413],
  ['psyche-no8.5', 227, 414],
  ['psyche-z7c', 228, 415],
  ['psyche-z7c.4', 229, 416],
  ['psyche-z7c.4.5', 231, 417],
  ['psyche-z7c.4.6', 232, 418],
].map(([beadId, survivor, alias]) => Object.freeze({
  beadId: String(beadId), survivor: Number(survivor), alias: Number(alias),
})));

/** @param {string} beadId @param {number} survivor @param {number} alias */
export function retirementNotice(beadId, survivor, alias) {
  return `\n\n<!-- psyche-bead-retired:420 bead-id=${beadId} survivor=${survivor} alias=${alias} -->\n\nRetired duplicate mirror; canonical Beads mirror: #${survivor}. History is preserved. This retirement does not complete or cancel the Bead.\n`;
}

/**
 * @template {{number: number, body?: string | null, repository?: string | null, author?: string | null}} T
 * @param {readonly T[]} issues
 * @returns {{canonical: T[], aliases: {issue: T, beadId: string, survivor: number}[]}}
 */
export function partitionRecoveryIssues(issues) {
  /** @type {{issue: T, beadId: string, survivor: number}[]} */
  const aliases = [];
  for (const pair of RECOVERY_PAIRS) {
    const members = issues.filter((issue) => issue.number === pair.alias);
    const originals = issues.filter((issue) => issue.number === pair.survivor);
    if (members.length === 0 && originals.length === 0) continue;
    if (members.length > 1 || originals.length !== 1) {
      throw new Error(`Recovery #420 requires exactly one survivor #${pair.survivor} and alias #${pair.alias}`);
    }
    for (const issue of [...originals, ...members]) {
      const marker = `<!-- psyche-bead-sync:v1 bead-id=${pair.beadId} -->`;
      if (issue.repository !== 'OpenCoven/psyche-build'
        || issue.author?.toLowerCase() !== 'bunsdev'
        || !issue.body?.includes(marker)
        || (issue.body.match(/bead-id=/gu) ?? []).length
          !== (issue.body.includes('<!-- psyche-bead-retired:420 ') ? 2 : 1)) {
        throw new Error(`Recovery #420 identity mismatch on issue #${issue.number}`);
      }
      if (issue.body.includes('psyche-bead-retired:')
        && (issue.number !== pair.alias
          || !issue.body.endsWith(retirementNotice(pair.beadId, pair.survivor, pair.alias)))) {
        throw new Error(`Recovery #420 invalid retirement on issue #${issue.number}`);
      }
    }
    if (members[0]) {
      aliases.push({ issue: members[0], beadId: pair.beadId, survivor: pair.survivor });
    }
  }
  const aliasNumbers = new Set(aliases.map(({ issue }) => issue.number));
  const canonical = issues.filter((issue) => !aliasNumbers.has(issue.number));
  for (const issue of canonical) {
    if (issue.body?.includes('psyche-bead-retired:')) {
      throw new Error(`Recovery #420 unexpected retirement on issue #${issue.number}`);
    }
    for (const { beadId } of aliases) {
      const pair = RECOVERY_PAIRS.find((entry) => entry.beadId === beadId);
      if (issue.number !== pair?.survivor
        && issue.body?.includes(`bead-id=${beadId} -->`)) {
        throw new Error(`Recovery #420 unknown duplicate on issue #${issue.number}`);
      }
    }
  }
  return { canonical, aliases };
}
