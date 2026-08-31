import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const FORBIDDEN_RELEASE_MARKERS = [
  'main-runtime-render-stress',
  'allow-diagnostics-spawn-fixture',
  'allow-diagnostics-cycle-window',
  'diagnostics_spawn_fixture',
  'diagnostics_cycle_window',
];

function fail(message) {
  console.error(`release diagnostics contract failed: ${message}`);
  process.exit(1);
}

function targetDirectory() {
  const argumentIndex = process.argv.indexOf('--target-dir');
  const value = argumentIndex >= 0 ? process.argv[argumentIndex + 1] : undefined;
  if (!value || value.startsWith('--')) {
    fail('expected --target-dir <cargo target directory>');
  }
  return resolve(value);
}

function readJson(path, label) {
  if (!existsSync(path)) fail(`missing ${label}: ${path}`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`invalid ${label} ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function releaseCapabilitiesPath(targetDir) {
  const buildDirectory = join(targetDir, 'release', 'build');
  if (!existsSync(buildDirectory)) fail(`missing Cargo release build directory: ${buildDirectory}`);
  const candidates = readdirSync(buildDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('psyche-build-tauri-'))
    .map((entry) => join(buildDirectory, entry.name, 'out', 'capabilities.json'))
    .filter((path) => existsSync(path));
  if (candidates.length === 0) {
    fail('cargo build did not produce generated release capabilities');
  }
  return candidates.sort((left, right) => (
    statSync(left).mtimeMs - statSync(right).mtimeMs
  )).at(-1);
}

function binaryPath(targetDir) {
  const releaseDirectory = join(targetDir, 'release');
  const candidates = ['psyche-build-tauri', 'psyche-build-tauri.exe']
    .map((name) => join(releaseDirectory, name))
    .filter((path) => existsSync(path));
  if (candidates.length === 0) fail('cargo build did not produce the release binary');
  return candidates[0];
}

const targetDir = targetDirectory();
const capabilitiesPath = releaseCapabilitiesPath(targetDir);
const capabilities = readJson(capabilitiesPath, 'generated capabilities');
const capabilitiesText = JSON.stringify(capabilities);
const forbiddenCapabilityMarker = FORBIDDEN_RELEASE_MARKERS.find((marker) => (
  capabilitiesText.includes(marker)
));
if (forbiddenCapabilityMarker) {
  fail(`release capabilities contain debug-only marker ${forbiddenCapabilityMarker}`);
}

const diagnosticsCapability = capabilities['main-runtime-diagnostics'];
if (!diagnosticsCapability || !Array.isArray(diagnosticsCapability.permissions)) {
  fail('release capabilities omitted main-runtime-diagnostics');
}
for (const permission of ['allow-runtime-diagnostics', 'allow-runtime-process-metrics']) {
  if (!diagnosticsCapability.permissions.includes(permission)) {
    fail(`release diagnostics capability omitted ${permission}`);
  }
}

const permissionFilesPath = join(dirname(capabilitiesPath), 'app-manifest', '__app__-permission-files');
const permissionFiles = readJson(permissionFilesPath, 'generated release app-manifest permission list');
if (!Array.isArray(permissionFiles)) fail('generated permission list is not an array');
const forbiddenPermissionFile = permissionFiles.find((path) => (
  FORBIDDEN_RELEASE_MARKERS.some((marker) => String(path).includes(marker))
));
if (forbiddenPermissionFile) {
  fail(`release app manifest contains debug-only permission ${forbiddenPermissionFile}`);
}

const binary = readFileSync(binaryPath(targetDir));
const forbiddenBinaryMarker = FORBIDDEN_RELEASE_MARKERS.find((marker) => (
  binary.includes(Buffer.from(marker))
));
if (forbiddenBinaryMarker) {
  fail(`release binary contains debug-only marker ${forbiddenBinaryMarker}`);
}

console.log(`verified release diagnostics contract from ${capabilitiesPath}`);
