import { describe, expect, it } from 'vitest';
import { partitionRecoveryIssues, retirementNotice } from '../scripts/beads-project-sync/recovery.mjs';

const issue = (number: number, beadId = 'psyche-i7c', author = 'BunsDev') => ({
  number, author, repository: 'OpenCoven/psyche-build',
  body: `<!-- psyche-bead-sync:v1 bead-id=${beadId} -->`,
  state: 'open',
});

describe('incident 420 recovery identity', () => {
  it('keeps the original regardless of inventory order and retains the alias for reconciliation', () => {
    const original = issue(208);
    const alias = issue(395);
    expect(partitionRecoveryIssues([alias, original])).toEqual({
      canonical: [original], aliases: [{ issue: alias, beadId: 'psyche-i7c', survivor: 208 }],
    });
  });

  it.each([
    [issue(395)],
    [issue(208), issue(395, 'psyche-no8')],
    [issue(208, 'psyche-i7c', 'stranger'), issue(395)],
    [issue(208), issue(395, 'psyche-i7c', 'stranger')],
    [issue(208), issue(395), issue(999)],
    [issue(208), { ...issue(395), repository: 'other/repo' }],
    [issue(208, 'wrong')],
    [issue(208, 'psyche-i7c', 'stranger')],
  ])('fails closed on incomplete, mismatched, unknown, or untrusted pairs', (...issues) => {
    expect(() => partitionRecoveryIssues(issues)).toThrow();
  });

  it('recognizes a crash after marking but before closing without promoting the alias', () => {
    const alias = { ...issue(395), body: issue(395).body + retirementNotice('psyche-i7c', 208, 395) };
    expect(partitionRecoveryIssues([alias, issue(208)]).aliases).toHaveLength(1);
    expect(partitionRecoveryIssues([{ ...alias, state: 'closed' }, issue(208)]).canonical)
      .toEqual([issue(208)]);
  });

  it('does not permit a forged retirement marker on an unknown issue', () => {
    expect(() => partitionRecoveryIssues([
      issue(208), { ...issue(999), body: issue(999).body + retirementNotice('psyche-i7c', 208, 395) },
    ])).toThrow();
  });
});
