import { constants, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 65_536;
const MAX_RUN_MS = 600_000;
const PANES = [1, 6, 12, 24];
const invalid = (finding = 'invalid_export') => ({
  status: 'invalid', findings: [finding], scenarios: [],
});

function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value)
    && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function sample(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => key === 'cpuPercent' || key === 'rssBytes')
    && (!Object.hasOwn(value, 'cpuPercent') || number(value.cpuPercent))
    && (!Object.hasOwn(value, 'rssBytes')
      || (number(value.rssBytes) && Number.isSafeInteger(value.rssBytes)));
}

// This checks the current export, not physical acceleration or acceptance.
export function validateGpuStressEvidence(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) return invalid();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return invalid();
  }
  if (!exact(value, ['startedAt', 'finishedAt', 'scenarios'])
    || !number(value.startedAt) || !number(value.finishedAt)
    || value.finishedAt <= value.startedAt
    || value.finishedAt - value.startedAt > MAX_RUN_MS
    || !Array.isArray(value.scenarios) || value.scenarios.length !== PANES.length) return invalid();

  const scenarios = [];
  let previousEnd = value.startedAt;
  for (const [index, scenario] of value.scenarios.entries()) {
    if (!exact(scenario, ['paneCount', 'startedAt', 'finishedAt', 'contextLossSupported', 'metrics'])
      || scenario.paneCount !== PANES[index]
      || !number(scenario.startedAt) || !number(scenario.finishedAt)
      || scenario.startedAt < previousEnd || scenario.finishedAt > value.finishedAt
      || scenario.finishedAt <= scenario.startedAt
      || typeof scenario.contextLossSupported !== 'boolean'
      || !exact(scenario.metrics, ['beforeMeasurement', 'afterMeasurement'])
      || !sample(scenario.metrics.beforeMeasurement)
      || !sample(scenario.metrics.afterMeasurement)) return invalid();
    previousEnd = scenario.finishedAt;
    const after = scenario.metrics.afterMeasurement;
    scenarios.push({
      paneCount: scenario.paneCount,
      cpu: Object.hasOwn(after, 'cpuPercent') ? 'measured' : 'not_measured',
      rss: Object.hasOwn(after, 'rssBytes') ? 'measured' : 'not_measured',
      contextLoss: scenario.contextLossSupported ? 'requested' : 'unsupported',
    });
  }
  return {
    status: 'incomplete',
    findings: [
      'frame_not_measured', 'input_to_next_paint_not_measured',
      'queue_not_measured', 'ipc_not_measured', 'throughput_not_measured',
      'physical_acceleration_unverified', 'physical_recovery_unverified',
    ],
    scenarios,
  };
}

function readBoundedFile(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    return length > MAX_BYTES ? null : buffer.subarray(0, length).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let report;
  if (process.argv.length !== 3) {
    report = invalid('invalid_arguments');
  } else {
    let text;
    try {
      text = readBoundedFile(process.argv[2]);
    } catch {
      // Never emit filesystem errors: they can contain operator paths.
      report = invalid('input_unavailable');
    }
    if (!report) report = validateGpuStressEvidence(text);
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.status === 'invalid' ? 2 : 1;
}
