import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { normalizeOperatorArchitecture, REQUIRED_OBSERVATIONS } from './validate-operator-acceptance.mjs';

const TOOLS = ['node', 'pnpm', 'git', 'tmux'];
const TOOL_STATUSES = ['available', 'missing', 'probe_failed', 'not_observed'];

export function parsePreflightArguments(args) {
  if (args.length > 3 || args.some(arg => typeof arg !== 'string' || arg.length > 32)) {
    throw new Error('invalid_arguments');
  }
  const values = args[0] === '--' ? args.slice(1) : args;
  if (values.length === 0) return undefined;
  if (values.length !== 2 || values[0] !== '--artifact-arch') throw new Error('invalid_arguments');
  const architecture = normalizeOperatorArchitecture(values[1]);
  if (architecture === 'unknown') throw new Error('invalid_arguments');
  return architecture;
}

export function probeTool(tool, run = spawnSync) {
  if (!TOOLS.includes(tool)) throw new Error('invalid_tool');
  // No login shell, startup environment, tool execution, or retained command output.
  if ((process.env.PATH?.length ?? 0) > 32768) return 'probe_failed';
  const result = run('/bin/sh', ['-c', `command -v ${tool} >/dev/null 2>&1`], {
    env: { PATH: process.env.PATH ?? '' },
    timeout: 1000,
    killSignal: 'SIGKILL',
    maxBuffer: 1024,
    stdio: 'ignore',
  });
  if (result.error || result.signal || result.status === null) return 'probe_failed';
  return result.status === 0 ? 'available' : result.status === 1 ? 'missing' : 'probe_failed';
}

export function collectOperatorPreflight({
  platform = process.platform,
  architecture = process.arch,
  artifactArchitecture,
  checkTool = probeTool,
} = {}) {
  const hostArchitecture = normalizeOperatorArchitecture(architecture);
  const artifact = normalizeOperatorArchitecture(artifactArchitecture);
  if (artifactArchitecture !== undefined && artifact === 'unknown') throw new Error('invalid_arguments');
  const supported = platform === 'darwin';
  const tools = Object.fromEntries(TOOLS.map(tool => {
    const status = supported ? checkTool(tool) : 'not_observed';
    if (!TOOL_STATUSES.includes(status)) throw new Error('invalid_probe_result');
    return [tool, status];
  }));
  const compatibility = artifact === 'unknown' || hostArchitecture === 'unknown'
    ? 'not_observed' : artifact === hostArchitecture ? 'matches' : 'mismatch';
  const setupBlockers = [
    ...(!supported ? ['unsupported_host'] : []),
    ...(hostArchitecture === 'unknown' ? ['unknown_host_architecture'] : []),
    ...(compatibility === 'mismatch' ? ['artifact_architecture_mismatch'] : []),
    ...TOOLS.filter(tool => ['missing', 'probe_failed'].includes(tools[tool]))
      .map(tool => `${tool}_${tools[tool]}`),
  ];
  return {
    schemaVersion: 1,
    acceptance: 'not_observed',
    host: { platform: supported ? 'macos' : 'unsupported', architecture: hostArchitecture },
    artifact: {
      architecture: artifact,
      source: artifactArchitecture === undefined ? 'not_observed' : 'operator_declared',
      compatibility,
    },
    tools,
    uiAutomationPermission: 'unknown',
    disposableContext: 'unverified',
    setupBlockers,
    requiredOperatorChecks: ['verify_artifact_identity_and_architecture', 'verify_ui_automation_permission',
      'establish_disposable_user_and_repository'],
    productScenarios: [...REQUIRED_OBSERVATIONS].map(id => ({ id, status: 'not_observed' })),
    limits: { toolCount: 4, timeoutMsPerTool: 1000, maxBufferBytesPerTool: 1024,
      retainedSubprocessOutputBytes: 0, fileReadBytes: 0, maxPathCharacters: 32768 },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let artifactArchitecture;
  try {
    artifactArchitecture = parsePreflightArguments(process.argv.slice(2));
  } catch {
    process.stderr.write('operator-preflight: invalid_arguments\n');
    process.exit(64);
  }
  const report = collectOperatorPreflight({ artifactArchitecture });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.setupBlockers.length ? 1 : 0;
}
