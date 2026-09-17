#!/usr/bin/env tsx
/**
 * Runs the opt-in application-restart recovery scenario and prints one
 * bounded, sanitized evidence report to stdout.
 *
 * Kept out of `pnpm recovery:harness`, and therefore out of the required
 * Quality check, because it launches the real cockpit twice: it costs tens of
 * seconds and depends on first-run prompt text. That is a flake surface a
 * required check should not carry, so an operator runs this deliberately —
 * the same shape as `PSYCHE_AGENT_CHECK_IOS` for the iOS simulator gate.
 *
 * Exits non-zero when any invariant fails, so retained evidence still gates.
 */

import {
  optInRecoveryScenarioIds,
  runRecoveryHarness,
} from '../src/diagnostics/recoveryHarness.js';

const report = await runRecoveryHarness(optInRecoveryScenarioIds());
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.outcome === 'passed' ? 0 : 1;
