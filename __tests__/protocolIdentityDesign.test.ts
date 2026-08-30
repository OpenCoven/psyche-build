import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_STATES,
  ARTIFACT_KINDS,
  ATTEMPT_STATES,
  CONNECTION_HEALTH_STATES,
  RECEIPT_OUTCOMES,
  goldenActionReceipt,
  goldenArtifactRecord,
  goldenExecutionAttempt,
  goldenExecutionBinding,
  goldenExecutionBindingDigest,
  goldenExecutionCorrelation,
  goldenFamiliarIdentitySnapshot,
  goldenRestartResume,
  deriveExecutionBindingDigest,
} from '../src/protocol/identityConvergenceDesign.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const designModulePath = resolve(root, 'src/protocol/identityConvergenceDesign.ts');
const designDocPath = resolve(
  root,
  'docs/superpowers/specs/2026-08-30-psyche-identity-convergence-design.md',
);
const designModule = readFileSync(designModulePath, 'utf8');
const designDoc = readFileSync(designDocPath, 'utf8');

const CONTENT_DIGEST = /^sha256:[0-9a-f]{64}$/;

function listTypeScriptFiles(directory: string): string[] {
  const entries = readdirSync(directory);
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = join(directory, entry);
    if (statSync(entryPath).isDirectory()) {
      files.push(...listTypeScriptFiles(entryPath));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(entryPath);
    }
  }
  return files;
}

describe('psyche identity convergence design artifact', () => {
  it('stays inert: no product file imports the design module', () => {
    const srcRoot = resolve(root, 'src');
    const importers = listTypeScriptFiles(srcRoot).filter((file) => {
      if (file === designModulePath) return false;
      const contents = readFileSync(file, 'utf8');
      return /identityConvergenceDesign/.test(contents);
    });
    expect(
      importers.map((file) => relative(root, file)),
      'product code must not import the design-stage module',
    ).toEqual([]);
  });

  it('keeps the design module free of product imports', () => {
    expect(designModule).not.toMatch(/from '\.\.\//);
  });

  it('keeps the required objects distinct in the golden examples', () => {
    expect(goldenFamiliarIdentitySnapshot.object).toBe('psyche.identity.snapshot.v1');
    expect(goldenExecutionCorrelation.object).toBe('psyche.execution.correlation.v1');
    expect(goldenExecutionAttempt.object).toBe('psyche.execution.attempt.v1');

    // The binding envelope references all three objects as distinct members
    // and carries no lifecycle state of its own.
    expect(goldenExecutionBinding.identity.familiarRoot).toBe(
      goldenFamiliarIdentitySnapshot.familiarRoot,
    );
    expect(goldenExecutionBinding.correlation.task).toBe(goldenExecutionCorrelation.task);
    expect(goldenExecutionBinding.attempt.attempt).toBe(goldenExecutionAttempt.attempt);
    expect(JSON.stringify(goldenExecutionBinding)).not.toContain('psyche.execution.correlation.v1');
  });

  it('proves the exact familiar revision is embodied by the attempt', () => {
    expect(goldenExecutionAttempt.embodiedFamiliar.familiarRoot).toBe(
      goldenFamiliarIdentitySnapshot.familiarRoot,
    );
    expect(goldenExecutionAttempt.embodiedFamiliar.revision).toBe(
      goldenFamiliarIdentitySnapshot.revision,
    );
    expect(goldenExecutionAttempt.embodiedFamiliar.digest).toBe(
      goldenFamiliarIdentitySnapshot.digest,
    );
    expect(goldenExecutionBinding.attempt.embodiedDigest).toBe(
      goldenFamiliarIdentitySnapshot.digest,
    );
  });

  it('derives the binding digest with the domain-separated reference rule', () => {
    expect(goldenExecutionBindingDigest).toMatch(CONTENT_DIGEST);
    expect(goldenExecutionBindingDigest).toBe(
      deriveExecutionBindingDigest(goldenExecutionBinding),
    );

    // Any member substitution changes the digest.
    const widened = {
      ...goldenExecutionBinding,
      attempt: {
        ...goldenExecutionBinding.attempt,
        runtimeSession: 'oc.rtsession.01JGQP3GZZZZPXV2LB34D6P8R9' as const,
      },
    };
    expect(deriveExecutionBindingDigest(widened)).not.toBe(goldenExecutionBindingDigest);
  });

  it('restarts into a fresh generation while preserving identity', () => {
    const { before, after } = goldenRestartResume;
    expect(after.identity).toEqual(before.identity);
    expect(after.correlation).toEqual(before.correlation);
    expect(after.attempt.attempt).not.toBe(before.attempt.attempt);
    expect(after.attempt.runtimeSession).not.toBe(before.attempt.runtimeSession);
    expect(after.attempt.resourceGeneration).toBeGreaterThan(
      before.attempt.resourceGeneration,
    );
    expect(after.attempt.embodiedDigest).toBe(before.attempt.embodiedDigest);
  });

  it('formats every golden reference for its owning namespace', () => {
    for (const ref of [
      goldenFamiliarIdentitySnapshot.familiarRoot,
      goldenFamiliarIdentitySnapshot.principal,
      ...goldenFamiliarIdentitySnapshot.authorization,
      goldenExecutionCorrelation.task,
      ...(goldenExecutionCorrelation.graph ? [goldenExecutionCorrelation.graph] : []),
      ...goldenExecutionCorrelation.lanes,
      ...goldenExecutionCorrelation.delegations,
      ...goldenExecutionCorrelation.actions,
      ...goldenExecutionCorrelation.approvals,
      ...goldenExecutionCorrelation.receipts,
      goldenExecutionAttempt.attempt,
      goldenExecutionAttempt.runtimeSession,
      goldenExecutionAttempt.host,
      goldenActionReceipt.receipt,
      goldenActionReceipt.action,
      ...goldenActionReceipt.evidence,
      goldenArtifactRecord.artifact,
    ]) {
      expect(ref).toMatch(/^oc\.[a-z]+\.[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
    }

    for (const digest of [
      goldenFamiliarIdentitySnapshot.digest,
      goldenExecutionAttempt.embodiedFamiliar.digest,
      goldenActionReceipt.effectDigest,
      goldenArtifactRecord.digest,
      goldenExecutionBindingDigest,
    ]) {
      expect(digest).toMatch(CONTENT_DIGEST);
    }
  });

  it('keeps receipts, artifacts, and lifecycle states honest', () => {
    expect(RECEIPT_OUTCOMES).toContain('unknown');
    expect(ATTEMPT_STATES).toContain('unknown');
    expect(APPROVAL_STATES).toEqual([
      'pending',
      'approved',
      'denied',
      'consumed',
      'expired',
      'revoked',
    ]);
    expect(CONNECTION_HEALTH_STATES).toEqual([
      'fresh',
      'stale',
      'reconciling',
      'degraded',
      'unavailable',
    ]);
    for (const kind of ['patch', 'commit', 'test-result', 'decision', 'release', 'handoff']) {
      expect(ARTIFACT_KINDS).toContain(kind);
    }
    expect(goldenActionReceipt.outcome).toBe('succeeded');
    expect(goldenArtifactRecord.redaction).toBe('redacted');
  });

  it('keeps the design record inside docs/superpowers/specs and pre-conformance', () => {
    expect(designDoc).toMatch(/not.*conformance claim/i);
    expect(designDoc).toContain('OpenCoven/psyche#11');
    expect(designDoc).toContain('OpenCoven/psyche#12');
  });

  it('protects the boundary statements of the design record from drift', () => {
    for (const phrase of [
      'Familiar identity snapshot',
      'Psyche execution correlation',
      'Execution attempt',
      'must not collapse these objects',
      'one canonical owner',
      'stale, reconciling, degraded, and unavailable',
    ]) {
      expect(designDoc, `design record should state: ${phrase}`).toContain(phrase);
    }

    for (const forbidden of [
      'pane id',
      'worktree path',
      'branch name',
      'provider session',
      'Bead',
      'GitHub issue',
      'UI selection',
    ]) {
      expect(
        designDoc.toLowerCase(),
        `design record should bar ${forbidden} from identity`,
      ).toContain(forbidden.toLowerCase());
    }
    expect(designDoc).toMatch(/never[^.]*derived from[^.]*pane/i);
    expect(designDoc).toMatch(/fail closed/i);
    expect(designDoc).toMatch(/additive and reversible/i);
  });
});
