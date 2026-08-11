import {
  buildDevAppSnapshot,
  channelConfig,
  installBundleTransactional,
  publishBuildChannel,
  runCli,
  runCommand,
  runDevBuildSnapshotUnlocked,
  runMacosBuild,
  validateBuildProvenance,
} from '../scripts/build-macos-app.mjs';
import type {
  BuildProvenance,
  CommandOptions,
  DevBuildSnapshotInput,
  DevBuildSnapshotRequest,
  DevBuildProvenance,
  RunCliDependencies,
  RunMacosBuildDependencies,
  StableBuildProvenance,
} from '../scripts/build-macos-app.mjs';

const candidate = '/Applications/Psyche Build Dev.app';
const devChannel = channelConfig('dev');

void installBundleTransactional(candidate, devChannel, {
  validateInstalledBundle: async () => {},
});

// @ts-expect-error install overrides are required
void installBundleTransactional(candidate, devChannel);

// @ts-expect-error validateInstalledBundle is required
void installBundleTransactional(candidate, devChannel, {});

const baseProvenance = {
  commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  dirty: false,
  builtAt: '2026-08-10T18:00:00.000Z',
  installedPath: '/Users/test/Applications/Psyche Build.app',
  productName: 'Psyche Build',
  bundleIdentifier: 'dev.opencoven.psyche',
};

const stableProvenance: StableBuildProvenance = {
  ...baseProvenance,
  channel: 'stable',
  requestedRef: 'release/v1.2.3',
};

const devProvenance: DevBuildProvenance = {
  ...baseProvenance,
  channel: 'dev',
  installedPath: '/Users/test/Applications/Psyche Build Dev.app',
  productName: 'Psyche Build Dev',
  bundleIdentifier: 'dev.opencoven.psyche.dev',
};

const provenanceRecords: BuildProvenance[] = [stableProvenance, devProvenance];
void provenanceRecords;
validateBuildProvenance(devProvenance);
void publishBuildChannel(candidate, devChannel, devProvenance, {
  homeDir: '/Users/test',
  execute: async () => ({
    stdout: '/Users/test/Applications/Psyche Build Dev.app\n',
    stderr: '',
  }),
});

// @ts-expect-error stable provenance requires requestedRef
const stableWithoutRequestedRef: StableBuildProvenance = {
  ...baseProvenance,
  channel: 'stable',
};
void stableWithoutRequestedRef;

const devWithRequestedRef: DevBuildProvenance = {
  ...baseProvenance,
  channel: 'dev',
  installedPath: '/Users/test/Applications/Psyche Build Dev.app',
  productName: 'Psyche Build Dev',
  bundleIdentifier: 'dev.opencoven.psyche.dev',
  // @ts-expect-error dev provenance forbids requestedRef
  requestedRef: 'HEAD',
};
void devWithRequestedRef;

const commandOptions: CommandOptions = {
  cwd: '/workspace/psyche-build',
  stage: 'resolve current commit',
};
void runCommand('git', ['rev-parse', 'HEAD'], commandOptions);

const devSnapshotRequest: DevBuildSnapshotRequest = {
  sourceRoot: '/workspace/psyche-build',
  tempRoot: '/workspace/.build-temp/dev',
  devConfigPath: '/workspace/.build-temp/dev/tauri.dev.json',
};
const devSnapshotInput: DevBuildSnapshotInput = {
  ...devSnapshotRequest,
  snapshotPath:
    '/workspace/.build-temp/dev/.dev-build.snapshot-id/Psyche Build Dev.app',
};
void buildDevAppSnapshot(devSnapshotRequest, {
  execute: async () => ({
    stdout: JSON.stringify({
      snapshotPath: devSnapshotInput.snapshotPath,
      identity: {
        name: 'Psyche Build Dev',
        identifier: 'dev.opencoven.psyche.dev',
        executable: 'psyche-build-dev',
      },
    }),
    stderr: '',
  }),
});
void runDevBuildSnapshotUnlocked(devSnapshotInput, {
  execute: async () => ({ stdout: '', stderr: '' }),
});

const buildDependencies: RunMacosBuildDependencies = {
  execute: async () => ({ stdout: '', stderr: '' }),
  buildDevAppSnapshot: async () => ({
    snapshotPath: devSnapshotInput.snapshotPath,
    identity: {
      name: 'Psyche Build Dev',
      identifier: 'dev.opencoven.psyche.dev',
      executable: 'psyche-build-dev',
    },
  }),
  publishBuildChannel: async (_candidatePath, _channelConfig, record) => {
    const typedRecord: BuildProvenance = record;
    void typedRecord;
    return record.installedPath;
  },
};
void runMacosBuild({ channel: 'dev' }, buildDependencies);

// @ts-expect-error stable builds require a ref
void runMacosBuild({ channel: 'stable' }, buildDependencies);

// @ts-expect-error dev builds forbid a ref
void runMacosBuild({ channel: 'dev', ref: 'HEAD' }, buildDependencies);

const cliDependencies: RunCliDependencies = {
  runBuild: async (options, dependencies) => runMacosBuild(options, dependencies),
  stdout: (_line) => {},
  stderr: (_line) => {},
};
void runCli(['dev'], cliDependencies);
