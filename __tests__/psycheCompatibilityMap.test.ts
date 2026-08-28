import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const map = readFileSync(resolve(root, 'docs/PSYCHE-COMPATIBILITY-MAP.md'), 'utf8');

describe('Psyche compatibility mapping', () => {
  it('keeps the mapping explicitly pre-conformance and release-gated', () => {
    expect(map).toMatch(/not.*protocol-conformance claim/i);
    expect(map).toContain('OpenCoven/psyche#11');
    expect(map).toContain('OpenCoven/psyche#12');
    expect(map).toMatch(/must not claim Psyche protocol conformance/i);
  });

  it('classifies every state category required by issue 253', () => {
    for (const domain of [
      'Task correlation',
      'Lane surface',
      'Pane identity',
      'Worktree identity',
      'Provider session',
      'Capability lease',
      'Approval',
      'Action identity',
      'Receipt/outcome',
      'Cancellation / interruption',
      'Persistence',
      'Recovery',
      'Beads / GitHub issue',
    ]) {
      expect(map, `missing ${domain}`).toContain(`| ${domain} |`);
    }
  });

  it('forbids product and tracker references from becoming canonical identity', () => {
    const forbidden = [
      'pane id',
      'filesystem path',
      'worktree',
      'branch',
      'provider session',
      'Bead',
      'GitHub issue',
      'UI selection',
    ];

    for (const term of forbidden) {
      expect(map.toLowerCase()).toContain(term.toLowerCase());
    }

    expect(map).toMatch(/never sufficient evidence of canonical identity, authority, completion, or recovery/i);
    expect(map).toMatch(/Never use tracker identity as runtime task\/action\/receipt identity/i);
  });

  it('preserves current authority and evidence invariants through adapters', () => {
    for (const invariant of [
      'One mutation authority',
      'Capability scope is explicit',
      'Approval is an intent-bound record',
      'Receipts come from the authoritative effect path',
      'Recovery cannot fork identity',
    ]) {
      expect(map).toContain(invariant);
    }

    expect(map).toContain('idempotency');
    expect(map).toContain('revocation');
    expect(map).toContain('fail closed');
    expect(map).toContain('quarantined');
  });

  it('requires additive reversible migration and blocks guessed protocol types', () => {
    expect(map).toMatch(/migration should remain additive and reversible/i);
    expect(map).toMatch(/must not be implemented by guessing types in Psyche Build/i);
    expect(map).toMatch(/new protocol correlation fields are additive and optional/i);
    expect(map).toMatch(/disabling the adapter returns to the previous local authority path without replaying effects/i);
  });

  it('defines an offline bounded canary without retroactively changing v0.0.1 support', () => {
    expect(map).toMatch(/first canary must be offline and credential-free/i);
    expect(map).toContain('artifactDigest');
    expect(map).toContain('consumerSha');
    expect(map).toMatch(/unknown major\/profile/i);
    expect(map).toMatch(/authority widening/i);
    expect(map).toMatch(/duplicate\/retry/i);
    expect(map).toMatch(/ambiguity\/fence/i);
    expect(map).toMatch(/does not retroactively make `v0\.0\.1` unsupported/i);
  });
});
