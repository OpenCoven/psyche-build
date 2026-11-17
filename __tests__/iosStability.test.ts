import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve('scripts/ios-stability.mjs');
const directories: string[] = [];
const caseID = 'ControlRequestClientTests/testCorrelatesAResponseBackToItsCaller()';

function cli(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

function summarize(nodes: unknown[], iterations = 25) {
  const directory = mkdtempSync(join(tmpdir(), 'psyche-ios-stability-'));
  directories.push(directory);
  const file = join(directory, 'tests.json');
  writeFileSync(file, JSON.stringify({ testNodes: nodes }));
  const result = cli('summarize', file, String(iterations));
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

function testCase(children?: unknown[], result = 'Passed') {
  return { nodeType: 'Test Case', nodeIdentifier: caseID, name: 'testCorrelatesAResponseBackToItsCaller()', result, ...(children ? { children } : {}) };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('bounded iOS stability qualification', () => {
  it('plans one build and two fixed repetition phases without retry flags', () => {
    const result = cli('plan', '/qualification', '25', '12600');
    expect(result.status, result.stderr).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan.build.args[0]).toBe('build-for-testing');
    expect(plan.phases).toHaveLength(2);
    for (const [index, phase] of plan.phases.entries()) {
      expect(phase.args[0]).toBe('test-without-building');
      expect(phase.args).toContain('platform=iOS Simulator,OS=26.2,name=iPhone 16 Pro');
      expect(phase.args.filter((arg: string) => arg.startsWith('-only-testing:'))).toHaveLength(6);
      expect(phase.args.slice(phase.args.indexOf('-test-iterations'), phase.args.indexOf('-test-iterations') + 2)).toEqual(['-test-iterations', '25']);
      expect(phase.args.slice(phase.args.indexOf('-test-repetition-relaunch-enabled'), phase.args.indexOf('-test-repetition-relaunch-enabled') + 2)).toEqual(['-test-repetition-relaunch-enabled', index === 0 ? 'YES' : 'NO']);
      expect(phase.args).not.toContain('-retry-tests-on-failure');
      expect(phase.args).not.toContain('-run-tests-until-failure');
      expect(phase.args).not.toContain('-default-test-execution-time-allowance');
    }
  });

  it.each(['0', '26', '-1', 'NaN', '2.5'])('refuses an out-of-bound repetition count %s before launching Xcode', (count) => {
    const result = cli('plan', '/qualification', count, '12600');
    expect(result.status).toBe(64);
    expect(result.stderr).toContain('invalid_iterations');
  });

  it.each(['0', '12601', 'NaN'])('refuses an out-of-bound total duration %s', (seconds) => {
    const result = cli('plan', '/qualification', '25', seconds);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain('invalid_budget');
  });

  it('counts individual repetitions, preserving a failure followed by a pass', () => {
    const result = summarize([{ nodeType: 'Test Plan', children: [testCase([
      { nodeType: 'Repetition', nodeIdentifier: '1', result: 'Failed', children: [{ nodeType: 'Failure Message', name: 'private diagnostic /Users/example' }] },
      { nodeType: 'Repetition', nodeIdentifier: '2', result: 'Passed' },
    ], 'Failed')] }]);
    const row = result.cases.find((entry: { id: string }) => entry.id.includes('testCorrelates'));
    expect(row).toMatchObject({ passed: 1, failed: 1, skipped: 0, unknown: 0, missing: 23 });
    expect(row.executions.map((entry: { result: string }) => entry.result)).toEqual(['Failed', 'Passed']);
    expect(row.executions[0].failures[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain('private diagnostic');
    expect(JSON.stringify(result)).not.toContain('/Users/example');
    expect(result.complete).toBe(false);
  });

  it('does not count a nested failure-message Test Case Run as another execution', () => {
    const result = summarize([testCase([{ nodeType: 'Repetition', nodeIdentifier: '1', result: 'Failed', children: [{ nodeType: 'Test Case Run', result: 'Failed', name: 'failure detail' }] }], 'Failed')], 1);
    const row = result.cases.find((entry: { id: string }) => entry.id.includes('testCorrelates'));
    expect(row.failed).toBe(1);
    expect(row.executions).toHaveLength(1);
  });

  it('counts a non-repeated test once and leaves the other expected executions missing', () => {
    const result = summarize([testCase()]);
    expect(result.cases.find((entry: { id: string }) => entry.id.includes('testCorrelates'))).toMatchObject({ passed: 1, missing: 24 });
    expect(result.cases.filter((entry: { missing: number }) => entry.missing === 25)).toHaveLength(5);
  });

  it('keeps skipped and unknown outcomes distinct from success and missing executions', () => {
    const result = summarize([testCase([
      { nodeType: 'Repetition', nodeIdentifier: '1', result: 'Skipped' },
      { nodeType: 'Repetition', nodeIdentifier: '2', result: 'Expected Failure' },
    ])]);
    expect(result.cases.find((entry: { id: string }) => entry.id.includes('testCorrelates'))).toMatchObject({ passed: 0, failed: 0, skipped: 1, unknown: 1, missing: 23 });
  });

  it('rejects duplicated result identities rather than claiming a larger clean sample', () => {
    const result = summarize([testCase(), testCase()]);
    expect(result.accountingErrors).toContain('duplicate_test_case');
    expect(result.complete).toBe(false);
  });

  it('does not accept an empty result tree as a successful matrix', () => {
    const result = summarize([]);
    expect(result.cases).toHaveLength(6);
    expect(result.cases.every((entry: { missing: number }) => entry.missing === 25)).toBe(true);
    expect(result.complete).toBe(false);
  });

  it('keeps a nonzero command with passing test leaves classified as infrastructure failure', () => {
    const { directory, env } = phaseFixture();
    const result = spawnSync(process.execPath, [script, 'measure', directory, 'fresh'], { env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(1);
    const report = JSON.parse(readFileSync(join(directory, 'summary.json'), 'utf8'));
    expect(report.phases[0]).toMatchObject({ outcome: 'infrastructure_failure', exitCode: 65 });
    expect(report.phases[0].observations.cases.find((entry: { id: string }) => entry.id.includes('testCorrelates')).passed).toBe(1);
    const second = spawnSync(process.execPath, [script, 'measure', directory, 'fresh'], { env, encoding: 'utf8' });
    expect(second.status).toBe(64);
    expect(second.stderr).toContain('invalid_or_repeated_phase');
    expect(readFileSync(join(directory, 'summary.json'), 'utf8')).toBe(JSON.stringify(report, null, 2) + '\n');
  });

  it('does not read result leaves when the wall budget prevented command execution', () => {
    const { directory, env } = phaseFixture('2000-01-01T00:00:00Z');
    const result = spawnSync(process.execPath, [script, 'measure', directory, 'fresh'], { env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(1);
    const report = JSON.parse(readFileSync(join(directory, 'summary.json'), 'utf8'));
    expect(report.phases[0]).toMatchObject({ outcome: 'incomplete', started: false });
    expect(report.phases[0].observations.cases.every((entry: { passed: number; missing: number }) => entry.passed === 0 && entry.missing === 1)).toBe(true);
  });
});

function phaseFixture(startedAt = new Date().toISOString()) {
  const directory = mkdtempSync(join(tmpdir(), 'psyche-ios-phase-'));
  directories.push(directory);
  mkdirSync(join(directory, 'private-logs'));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(directory, 'summary.json'), JSON.stringify({ sourceSha: head, startedAt, budgetSeconds: 60, requestedPerPhase: 1, build: { outcome: 'succeeded' }, phases: [] }));
  const tree = { testNodes: [testCase()] };
  writeFileSync(join(directory, 'tree.json'), JSON.stringify(tree));
  writeFileSync(join(bin, 'xcrun'), '#!/usr/bin/env node\nprocess.stdout.write(require("node:fs").readFileSync(process.env.RESULT_TREE));\n');
  writeFileSync(join(bin, 'xcodebuild'), '#!/usr/bin/env node\nconst fs=require("node:fs");const p=process.argv[process.argv.indexOf("-resultBundlePath")+1];fs.mkdirSync(p,{recursive:true});fs.writeFileSync(p+"/data","fixture");process.exit(65);\n');
  chmodSync(join(bin, 'xcrun'), 0o755);
  chmodSync(join(bin, 'xcodebuild'), 0o755);
  return { directory, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RESULT_TREE: join(directory, 'tree.json') } };
}
