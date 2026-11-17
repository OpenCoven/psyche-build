#!/usr/bin/env node
// #510: fixed repetitions are observations, never retries used to erase failure.
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const cases = [
  'PsycheCoreTests/ConnectionManagerTests/testDisconnectDuringReadyHostSelectionCannotLeaveReadinessLive',
  'PsycheCoreTests/ConnectionManagerTests/testDisconnectAfterReadyHostSelectionFinalizesKeepsTheNewHost',
  'PsycheCoreTests/ControlRequestClientTests/testCorrelatesAResponseBackToItsCaller',
  'PsycheAppUITests/PsycheAppUITests/testADraftStaysWithItsOwnPane',
  'PsycheAppUITests/PsycheAppUITests/testComposerAndKeyRowAreAvailableOnAnOpenPane',
  'PsycheAppUITests/PsycheAppUITests/testRenamingAPaneUsesTheRemoteActionSheet',
];
const destination = 'platform=iOS Simulator,OS=26.2,name=iPhone 16 Pro';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const normalize = (id) => String(id).replace(/\(\)$/, '');

function integer(value, maximum, error) {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > maximum) throw new Error(error);
  return Number(value);
}

function plan(directory, iterations, budgetSeconds) {
  const base = ['-project', 'native/ios/Psyche.xcodeproj', '-scheme', 'PsycheApp', '-destination', destination, '-derivedDataPath', join(directory, 'derived-data')];
  return {
    iterations, budgetSeconds, cases,
    build: { command: 'xcodebuild', args: ['build-for-testing', ...base, '-resultBundlePath', join(directory, 'bundles', 'build.xcresult'), 'CODE_SIGNING_ALLOWED=NO'] },
    phases: ['fresh', 'reused'].map((mode) => ({
      mode, command: 'xcodebuild',
      args: ['test-without-building', ...base, '-parallel-testing-enabled', 'NO', '-test-iterations', String(iterations), '-test-repetition-relaunch-enabled', mode === 'fresh' ? 'YES' : 'NO', ...cases.map((id) => `-only-testing:${id}`), '-resultBundlePath', join(directory, 'bundles', `${mode}.xcresult`), 'CODE_SIGNING_ALLOWED=NO'],
    })),
  };
}

function failures(node) {
  const result = [];
  if (node.nodeType === 'Failure Message' || node.nodeType === 'Test Case Run' && node.result === 'Failed') result.push({ sha256: sha256(String(node.name ?? 'unknown_failure')) });
  for (const child of node.children ?? []) result.push(...failures(child));
  return result;
}

function summarize(document, requested) {
  if (!Array.isArray(document.testNodes)) throw new Error('invalid_result_tree');
  const rows = cases.map((id) => ({ id, passed: 0, failed: 0, skipped: 0, unknown: 0, missing: requested, executions: [] }));
  const accountingErrors = [];
  const seen = new Set();
  function visit(node) {
    if (node.nodeType === 'Test Case') {
      const id = normalize(node.nodeIdentifier);
      const row = rows.find((entry) => normalize(entry.id.split('/').slice(1).join('/')) === id);
      if (!row) { accountingErrors.push('unexpected_test_case'); return; }
      if (seen.has(row.id)) { accountingErrors.push('duplicate_test_case'); return; }
      seen.add(row.id);
      const repetitions = [];
      function collect(current) {
        if (current.nodeType === 'Repetition') { repetitions.push(current); return; }
        for (const child of current.children ?? []) collect(child);
      }
      collect(node);
      const identities = new Set();
      for (const execution of repetitions.length ? repetitions : [node]) {
        const identity = repetitions.length ? execution.nodeIdentifier : '1';
        if (!identity || identities.has(identity)) { accountingErrors.push('invalid_repetition_identity'); continue; }
        identities.add(identity);
        const result = ['Passed', 'Failed', 'Skipped'].includes(execution.result) ? execution.result : 'unknown';
        row[{ Passed: 'passed', Failed: 'failed', Skipped: 'skipped', unknown: 'unknown' }[result]] += 1;
        row.executions.push({ ordinal: row.executions.length + 1, result, failures: failures(execution) });
      }
      row.missing = Math.max(0, requested - row.executions.length);
      if (row.executions.length > requested) accountingErrors.push('excess_executions');
      if (!['Passed', 'Failed', 'Skipped'].includes(node.result)) accountingErrors.push('unknown_aggregate_result');
      else if (node.result === 'Passed' && row.failed > 0 || node.result === 'Failed' && row.failed === 0 || node.result === 'Skipped' && row.passed + row.failed > 0) accountingErrors.push('contradictory_aggregate_result');
      return;
    }
    for (const child of node.children ?? []) visit(child);
  }
  for (const node of document.testNodes) visit(node);
  const complete = !accountingErrors.length && rows.every((row) => row.missing === 0 && row.skipped === 0 && row.unknown === 0);
  return { cases: rows, accountingErrors, complete, clean: complete && rows.every((row) => row.failed === 0) };
}

function textCommand(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('metadata_command_failed');
  return result.stdout.trim();
}

function save(directory, report) {
  const file = join(directory, 'summary.json');
  writeFileSync(`${file}.tmp`, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

async function execute(command, args, log, deadline) {
  if (Date.now() >= deadline) return { exitCode: null, signal: null, timedOut: true, started: false };
  const fd = openSync(log, 'wx');
  const started = Date.now();
  return await new Promise((resolveResult) => {
    const child = spawn(command, args, { detached: true, stdio: ['ignore', fd, fd] });
    let timedOut = false;
    let forceTimer;
    const kill = (signal) => { try { process.kill(-child.pid, signal); } catch { child.kill(signal); } };
    const timer = setTimeout(() => {
      timedOut = true;
      kill('SIGINT');
      forceTimer = setTimeout(() => kill('SIGKILL'), 20000);
    }, Math.max(1, deadline - Date.now()));
    child.once('error', () => {});
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      closeSync(fd);
      resolveResult({ exitCode: code, signal, timedOut, started: true, durationSeconds: Math.ceil((Date.now() - started) / 1000) });
    });
  });
}

function bundleDigest(directory) {
  const hash = createHash('sha256');
  let bytes = 0;
  let files = 0;
  function visit(relative) {
    for (const name of readdirSync(join(directory, relative)).sort()) {
      const item = join(relative, name);
      const file = join(directory, item);
      if (statSync(file).isDirectory()) visit(item);
      else {
        const size = statSync(file).size;
        hash.update(`${item}\0${size}\0`);
        const fd = openSync(file, 'r');
        const buffer = Buffer.alloc(1024 * 1024);
        try { let length; while ((length = readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, length)); }
        finally { closeSync(fd); }
        bytes += size;
        files += 1;
      }
    }
  }
  visit('');
  return { sha256: hash.digest('hex'), bytes, files };
}

function diagnostics(file) {
  // Keep bounded compiler locations and fingerprints. The original diagnostic is
  // available in the fixture-only xcresult, never in this public JSON summary.
  const fd = openSync(file, 'r');
  const size = statSync(file).size;
  const buffer = Buffer.alloc(Math.min(size, 65536));
  try { readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length)); }
  finally { closeSync(fd); }
  const entries = [];
  for (const line of buffer.toString('utf8').split('\n')) {
    if (!/(?:^|: )(?:error|fatal error):/.test(line) && !/^xcodebuild: error:/.test(line)) continue;
    const location = line.match(/(?:^|\/)(native\/ios\/[A-Za-z0-9_./ -]+\.swift):(\d+):(\d+):/);
    entries.push({ kind: 'build_error', ...(location ? { file: location[1], line: Number(location[2]), column: Number(location[3]) } : {}), sha256: sha256(line) });
    if (entries.length === 20) break;
  }
  return { entries, diagnosticTextOmitted: true, inspectedTailBytes: buffer.length };
}

async function main() {
  const [command, input, arg = '25', seconds = '12600'] = process.argv.slice(2);
  if (!input) throw new Error('missing_input');
  if (command === 'diagnostics') return console.log(JSON.stringify(diagnostics(input)));
  if (command === 'summarize') return console.log(JSON.stringify(summarize(JSON.parse(readFileSync(input, 'utf8')), integer(arg, 25, 'invalid_iterations'))));
  const directory = resolve(input);
  if (command === 'plan') return console.log(JSON.stringify(plan(directory, integer(arg, 25, 'invalid_iterations'), integer(seconds, 12600, 'invalid_budget'))));
  if (command === 'build') {
    if (existsSync(directory)) throw new Error('output_already_exists');
    const configuration = plan(directory, integer(arg, 25, 'invalid_iterations'), integer(seconds, 12600, 'invalid_budget'));
    const sourceSha = textCommand('git', ['rev-parse', 'HEAD']);
    if (!/^[a-f0-9]{40}$/.test(sourceSha) || process.env.SOURCE_SHA && sourceSha !== process.env.SOURCE_SHA) throw new Error('source_identity_mismatch');
    const version = textCommand('xcodebuild', ['-version']);
    if (version !== 'Xcode 26.2\nBuild version 17C52') throw new Error('wrong_xcode');
    const devices = JSON.parse(textCommand('xcrun', ['simctl', 'list', 'devices', 'available', '--json']));
    if (!devices.devices?.['com.apple.CoreSimulator.SimRuntime.iOS-26-2']?.some((device) => device.name === 'iPhone 16 Pro' && device.isAvailable)) throw new Error('pinned_simulator_missing');
    mkdirSync(join(directory, 'bundles'), { recursive: true });
    mkdirSync(join(directory, 'private-logs'));
    const report = { schemaVersion: 1, sourceSha, startedAt: new Date().toISOString(), budgetSeconds: configuration.budgetSeconds, requestedPerPhase: configuration.iterations, toolchain: { xcode: '26.2', build: '17C52', simulator: 'iPhone 16 Pro', os: '26.2' }, build: { outcome: 'incomplete' }, phases: [] };
    save(directory, report);
    const result = await execute(configuration.build.command, configuration.build.args, join(directory, 'private-logs', 'build.log'), Date.parse(report.startedAt) + report.budgetSeconds * 1000);
    report.build = { ...result, outcome: result.timedOut ? 'incomplete' : result.exitCode === 0 ? 'succeeded' : 'infrastructure_failure' };
    if (existsSync(join(directory, 'private-logs', 'build.log'))) report.build.diagnostics = diagnostics(join(directory, 'private-logs', 'build.log'));
    if (existsSync(join(directory, 'bundles', 'build.xcresult'))) report.build.bundle = { path: 'bundles/build.xcresult', ...bundleDigest(join(directory, 'bundles', 'build.xcresult')) };
    save(directory, report);
    console.log(JSON.stringify({ sourceSha, build: report.build }));
    process.exitCode = report.build.outcome === 'succeeded' ? 0 : 1;
    return;
  }
  const report = JSON.parse(readFileSync(join(directory, 'summary.json'), 'utf8'));
  if (report.sourceSha !== textCommand('git', ['rev-parse', 'HEAD'])) throw new Error('source_identity_mismatch');
  if (command === 'measure') {
    if (!['fresh', 'reused'].includes(arg) || report.phases.some((phase) => phase.mode === arg)) throw new Error('invalid_or_repeated_phase');
    if (report.build.outcome !== 'succeeded') throw new Error('build_not_successful');
    const configuration = plan(directory, report.requestedPerPhase, report.budgetSeconds).phases.find((phase) => phase.mode === arg);
    const phase = { mode: arg, outcome: 'incomplete', observations: summarize({ testNodes: [] }, report.requestedPerPhase) };
    report.phases.push(phase);
    save(directory, report);
    const result = await execute(configuration.command, configuration.args, join(directory, 'private-logs', `${arg}.log`), Date.parse(report.startedAt) + report.budgetSeconds * 1000);
    Object.assign(phase, result);
    const bundle = join(directory, 'bundles', `${arg}.xcresult`);
    if (result.started) try {
      const tree = JSON.parse(textCommand('xcrun', ['xcresulttool', 'get', 'test-results', 'tests', '--path', bundle, '--compact']));
      phase.observations = summarize(tree, report.requestedPerPhase);
      phase.bundle = { path: `bundles/${arg}.xcresult`, ...bundleDigest(bundle) };
      phase.outcome = result.timedOut ? 'incomplete' : phase.observations.cases.some((row) => row.failed) ? 'test_failure' : result.exitCode !== 0 ? 'infrastructure_failure' : phase.observations.clean ? 'succeeded' : 'incomplete';
    } catch { phase.outcome = result.timedOut ? 'incomplete' : 'infrastructure_failure'; phase.resultError = 'result_bundle_unreadable'; }
    save(directory, report);
    console.log(JSON.stringify({ mode: arg, outcome: phase.outcome, counts: phase.observations.cases.map(({ id, passed, failed, skipped, unknown, missing }) => ({ id, passed, failed, skipped, unknown, missing })) }));
    process.exitCode = phase.outcome === 'succeeded' ? 0 : 1;
    return;
  }
  if (command === 'finalize') {
    report.complete = report.build.outcome === 'succeeded' && report.phases.length === 2 && report.phases.every((phase) => ['succeeded', 'test_failure'].includes(phase.outcome) && phase.observations.complete);
    report.clean = report.complete && report.phases.every((phase) => phase.outcome === 'succeeded');
    report.finishedAt = new Date().toISOString();
    save(directory, report);
    console.log(JSON.stringify({ sourceSha: report.sourceSha, complete: report.complete, clean: report.clean }));
    process.exitCode = report.clean ? 0 : 1;
    return;
  }
  throw new Error('unknown_command');
}

main().catch((error) => {
  const allowed = ['invalid_iterations', 'invalid_budget', 'invalid_result_tree', 'missing_input', 'output_already_exists', 'source_identity_mismatch', 'wrong_xcode', 'pinned_simulator_missing', 'invalid_or_repeated_phase', 'build_not_successful', 'metadata_command_failed', 'unknown_command'];
  console.error(allowed.includes(error.message) ? error.message : 'qualification_error');
  process.exitCode = 64;
});
