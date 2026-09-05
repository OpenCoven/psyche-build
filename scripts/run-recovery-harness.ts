#!/usr/bin/env tsx
/**
 * Runs the disposable recovery harness and prints one bounded, sanitized
 * evidence report to stdout. Exits non-zero when any scenario invariant fails,
 * so the command can gate retained acceptance evidence for #199.
 *
 * The report carries enumerated identifiers, booleans, and content digests
 * only; it is safe to attach to a public outcome without a redaction pass.
 */

import { runRecoveryHarness } from '../src/diagnostics/recoveryHarness.js';

const report = await runRecoveryHarness();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.outcome === 'passed' ? 0 : 1;
