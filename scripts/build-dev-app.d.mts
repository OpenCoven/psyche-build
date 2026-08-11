import type {
  DevBuildSnapshot,
  DevBuildSnapshotInput,
} from './build-macos-app.mjs';

export interface RunBuildDevAppHelperDependencies {
  runDevBuildSnapshotUnlocked?: (
    input: DevBuildSnapshotInput,
  ) => Promise<DevBuildSnapshot>;
}

export function runBuildDevAppHelper(
  argv: readonly string[],
  deps?: RunBuildDevAppHelperDependencies,
): Promise<DevBuildSnapshot>;
