import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  mutateProjectPaneConfig,
  projectConfigSnapshotDirectory,
  projectPaneConfigPath,
  PROJECT_CONFIG_MIGRATIONS,
  PROJECT_CONFIG_SCHEMA_VERSION,
  ProjectPaneConfigError,
  readProjectPaneConfig,
  readProjectPaneConfigWithSchema,
  UNVERSIONED_PROJECT_CONFIG_SCHEMA,
} from '../src/services/ProjectPaneConfig.js';

const directories: string[] = [];

function createProjectRoot(): string {
  const root = mkdtempSync(path.join(process.cwd(), '.psyche-config-schema-'));
  directories.push(root);
  mkdirSync(path.join(root, '.psyche'), { recursive: true });
  return root;
}

function writeConfig(projectRoot: string, config: unknown): string {
  const configPath = projectPaneConfigPath(projectRoot);
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  return configPath;
}

function readConfigFile(projectRoot: string): Record<string, unknown> {
  return JSON.parse(readFileSync(projectPaneConfigPath(projectRoot), 'utf8')) as Record<string, unknown>;
}

function snapshots(projectRoot: string): string[] {
  try {
    return readdirSync(projectConfigSnapshotDirectory(projectRoot)).sort();
  } catch {
    return [];
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('project config schema version is written on every mutation', () => {
  it('stamps the current version when a mutation creates the config', async () => {
    const projectRoot = createProjectRoot();

    await mutateProjectPaneConfig(projectRoot, (config) => {
      config.panes = [];
      return { config, result: undefined };
    });

    expect(readConfigFile(projectRoot).schemaVersion).toBe(PROJECT_CONFIG_SCHEMA_VERSION);
  });

  it('stamps an unversioned config on the first mutation that touches it', async () => {
    const projectRoot = createProjectRoot();
    writeConfig(projectRoot, { projectName: 'legacy', panes: [], settings: {} });

    await mutateProjectPaneConfig(projectRoot, (config) => {
      config.projectName = 'legacy';
      return { config, result: undefined };
    });

    const persisted = readConfigFile(projectRoot);
    expect(persisted.schemaVersion).toBe(PROJECT_CONFIG_SCHEMA_VERSION);
    expect(persisted.projectName).toBe('legacy');
  });

  it('cannot be defeated by a caller handing back a stale version', async () => {
    const projectRoot = createProjectRoot();

    await mutateProjectPaneConfig(projectRoot, (config) => {
      (config as Record<string, unknown>).schemaVersion = 0;
      return { config, result: undefined };
    });

    // The stamp is applied by the single write path, not by the mutator.
    expect(readConfigFile(projectRoot).schemaVersion).toBe(PROJECT_CONFIG_SCHEMA_VERSION);
  });
});

describe('project config read-side version gate', () => {
  it('proceeds without migrating when the version matches', async () => {
    const projectRoot = createProjectRoot();
    writeConfig(projectRoot, {
      schemaVersion: PROJECT_CONFIG_SCHEMA_VERSION,
      projectName: 'current',
      panes: [],
    });

    const read = await readProjectPaneConfigWithSchema(projectRoot);

    expect(read.schemaVersion).toBe(PROJECT_CONFIG_SCHEMA_VERSION);
    expect(read.migrations).toEqual([]);
    expect(read.config.projectName).toBe('current');
  });

  it('reports the named migration that adopted an unversioned config', async () => {
    const projectRoot = createProjectRoot();
    writeConfig(projectRoot, { projectName: 'legacy', panes: [] });

    const read = await readProjectPaneConfigWithSchema(projectRoot);

    // "Old state was adapted" is an assertable event, not a silent default.
    expect(read.schemaVersion).toBe(UNVERSIONED_PROJECT_CONFIG_SCHEMA);
    expect(read.migrations).toEqual(['adopt-unversioned-as-v1']);
    expect(read.config.projectName).toBe('legacy');
  });

  it('refuses a newer schema instead of reading it lossily', async () => {
    const projectRoot = createProjectRoot();
    writeConfig(projectRoot, {
      schemaVersion: PROJECT_CONFIG_SCHEMA_VERSION + 1,
      projectName: 'from-the-future',
      panes: [],
      fieldThisVersionCannotRepresent: { kept: true },
    });

    await expect(readProjectPaneConfig(projectRoot)).rejects.toMatchObject({
      code: 'config_newer_schema',
    });
  });

  it('preserves every field of a newer config it refused', async () => {
    const projectRoot = createProjectRoot();
    const original = {
      schemaVersion: PROJECT_CONFIG_SCHEMA_VERSION + 3,
      projectName: 'from-the-future',
      panes: [],
      fieldThisVersionCannotRepresent: { kept: true },
    };
    writeConfig(projectRoot, original);

    await expect(mutateProjectPaneConfig(projectRoot, (config) => {
      config.panes = [];
      return { config, result: undefined };
    })).rejects.toMatchObject({ code: 'config_newer_schema' });

    expect(readConfigFile(projectRoot)).toEqual(original);
    expect(snapshots(projectRoot)).toEqual([]);
  });

  it('rejects a schemaVersion that is not a usable version number', async () => {
    for (const value of ['1', 1.5, 0, -1, null, {}]) {
      const projectRoot = createProjectRoot();
      writeConfig(projectRoot, { schemaVersion: value, panes: [] });

      await expect(readProjectPaneConfig(projectRoot)).rejects.toMatchObject({
        code: 'config_corrupt',
      });
    }
  });

  it('treats a missing config as current rather than as unversioned', async () => {
    const read = await readProjectPaneConfigWithSchema(createProjectRoot());

    expect(read.schemaVersion).toBe(PROJECT_CONFIG_SCHEMA_VERSION);
    expect(read.migrations).toEqual([]);
    expect(read.config.schemaVersion).toBe(PROJECT_CONFIG_SCHEMA_VERSION);
  });

  it('never rewrites the project during a read', async () => {
    const projectRoot = createProjectRoot();
    const configPath = writeConfig(projectRoot, { projectName: 'legacy', panes: [] });
    const before = readFileSync(configPath, 'utf8');

    await readProjectPaneConfigWithSchema(projectRoot);

    expect(readFileSync(configPath, 'utf8')).toBe(before);
    expect(snapshots(projectRoot)).toEqual([]);
  });
});

describe('project config migration registry', () => {
  it('registers a step reaching the current version from unversioned', () => {
    let version = UNVERSIONED_PROJECT_CONFIG_SCHEMA;
    const visited: string[] = [];
    while (version < PROJECT_CONFIG_SCHEMA_VERSION) {
      const step = PROJECT_CONFIG_MIGRATIONS.find((candidate) => candidate.from === version);
      expect(step, `no migration registered from version ${version}`).toBeDefined();
      expect(step!.to).toBeGreaterThan(version);
      visited.push(step!.name);
      version = step!.to;
    }
    expect(version).toBe(PROJECT_CONFIG_SCHEMA_VERSION);
    expect(new Set(visited).size).toBe(visited.length);
  });

  it('names every registered migration uniquely', () => {
    const names = PROJECT_CONFIG_MIGRATIONS.map((migration) => migration.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });
});

describe('pre-migration snapshot', () => {
  it('preserves the superseded config before the first stamped write', async () => {
    const projectRoot = createProjectRoot();
    const legacy = { projectName: 'legacy', panes: [], settings: { keep: 'this' } };
    writeConfig(projectRoot, legacy);

    await mutateProjectPaneConfig(projectRoot, (config) => {
      config.projectName = 'renamed';
      return { config, result: undefined };
    });

    const retained = snapshots(projectRoot);
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatch(/^psyche\.config\.v0-\d{8}T\d{6}Z\.json$/);
    const snapshotPath = path.join(projectConfigSnapshotDirectory(projectRoot), retained[0]);
    expect(JSON.parse(readFileSync(snapshotPath, 'utf8'))).toEqual(legacy);
    expect(readConfigFile(projectRoot).projectName).toBe('renamed');
  });

  it('writes the snapshot owner-readable only', async () => {
    const projectRoot = createProjectRoot();
    writeConfig(projectRoot, { projectName: 'legacy', panes: [] });

    await mutateProjectPaneConfig(projectRoot, (config) => {
      config.panes = [];
      return { config, result: undefined };
    });

    const retained = snapshots(projectRoot);
    const snapshotPath = path.join(projectConfigSnapshotDirectory(projectRoot), retained[0]);
    expect(statSync(snapshotPath).mode & 0o777).toBe(0o600);
  });

  it('does not snapshot again once the config carries the current version', async () => {
    const projectRoot = createProjectRoot();
    writeConfig(projectRoot, { projectName: 'legacy', panes: [] });

    for (let index = 0; index < 3; index += 1) {
      await mutateProjectPaneConfig(projectRoot, (config) => {
        config.projectName = `rename-${index}`;
        return { config, result: undefined };
      });
    }

    // One superseded version, one snapshot: routine writes do not accumulate.
    expect(snapshots(projectRoot)).toHaveLength(1);
  });

  it('leaves the config unchanged when the snapshot cannot be written', async () => {
    const projectRoot = createProjectRoot();
    const legacy = { projectName: 'legacy', panes: [] };
    const configPath = writeConfig(projectRoot, legacy);
    // A file where the snapshot directory must be, so mkdir fails.
    mkdirSync(path.join(projectRoot, '.psyche', 'runtime'), { recursive: true });
    writeFileSync(path.join(projectRoot, '.psyche', 'runtime', 'config-schema-snapshots'), 'x', 'utf8');

    await expect(mutateProjectPaneConfig(projectRoot, (config) => {
      config.projectName = 'renamed';
      return { config, result: undefined };
    })).rejects.toMatchObject({ code: 'config_snapshot_failed' });

    // "Migration failed" has a defined recovery state: the original, whole.
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(legacy);
  });

  it('does not follow a symlink planted at the snapshot path', async () => {
    const projectRoot = createProjectRoot();
    writeConfig(projectRoot, { projectName: 'legacy', panes: [] });
    const outside = path.join(projectRoot, 'outside.json');
    writeFileSync(outside, 'untouched', 'utf8');
    const directory = projectConfigSnapshotDirectory(projectRoot);
    mkdirSync(directory, { recursive: true });
    // Plant links across the whole second the snapshot could land in.
    const base = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const stampSecond = base.slice(0, 15);
    for (let second = 0; second < 10; second += 1) {
      const candidate = path.join(directory, `psyche.config.v0-${stampSecond}${second}Z.json`);
      try {
        symlinkSync(outside, candidate);
      } catch {
        // Already planted.
      }
    }

    await mutateProjectPaneConfig(projectRoot, (config) => {
      config.projectName = 'renamed';
      return { config, result: undefined };
    }).catch(() => undefined);

    // Either the write was refused or it landed elsewhere; the link target is
    // never written through.
    expect(readFileSync(outside, 'utf8')).toBe('untouched');
  });
});
