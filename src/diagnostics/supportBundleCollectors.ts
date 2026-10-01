import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { collectRecoveryListing } from './recoveryReport.js';
import {
  projectPaneConfigPath,
  readProjectPaneConfig,
  type ProjectPaneConfig,
} from '../services/ProjectPaneConfig.js';
import { normalizeCanonicalProjectIdentity } from '../control/projectIdentity.js';
import { canonicalizePathWithExistingAncestor } from '../services/WorktreePath.js';
import type { SupportBundleInput, SupportCollector } from './supportBundle.js';

/**
 * A support bundle must stay bounded and cancellable, but the recovery
 * directories are written by the product and can hold anything. The collector
 * reads at most this many files, none larger than this, and stops on abort.
 */
const MAX_SCANNED_RECOVERY_FILES = 256;
const MAX_RECOVERY_FILE_BYTES = 64 * 1024;

/**
 * A project config larger than this is not parsed at all.
 *
 * `readProjectPaneConfig` reads and parses the whole file with no size bound
 * and no way to interrupt the parse. A bundle is collected precisely when an
 * installation is broken, so it must not be the thing that hangs on a corrupt
 * or absurdly large config. Generous next to a real config — a hundred panes is
 * far under this — and still bounded.
 */
const MAX_PROJECT_CONFIG_BYTES = 1024 * 1024;

/**
 * Executable candidates the provider probe will check before giving up.
 *
 * The product's own `findAgentCommand` resolves an agent by running
 * `$SHELL -i -c "command -v ..."` through `execSync`. That starts an
 * interactive shell per agent, sources the user's rc files, blocks the event
 * loop and cannot be cancelled — exactly what a bundle collected from a broken
 * installation must not do. This probe reads the filesystem instead, so it is
 * bounded, interruptible, and starts nothing.
 */
const MAX_PROVIDER_CANDIDATES = 512;

export interface SupportCollectorContext {
  readonly projectRoot: string;
  readonly releaseVersion: string;
  readonly platform: string;
  readonly architecture: string;
  /**
   * The providers the survey looks for — the agent registry in production.
   * Supplied rather than imported so a test does not report whatever happens
   * to be installed on the machine running it.
   */
  readonly providerDefinitions: readonly ProviderDefinition[];
  /**
   * Directories searched for provider executables, already split. The caller
   * reads the environment; the collector never does, so no environment value
   * can reach the bundle through it.
   */
  readonly providerSearchPath: readonly string[];
}

/**
 * `process.platform` and `process.arch` are not the bundle's vocabulary. A value
 * outside the contract's allowlist is normalized to `unknown` by the sanitizer
 * anyway; mapping here keeps the reason visible instead of silently downgraded.
 */
const PLATFORMS = new Map([
  ['darwin', 'darwin'],
  ['linux', 'linux'],
  ['win32', 'windows'],
  ['freebsd', 'freebsd'],
  ['android', 'android'],
]);

const ARCHITECTURES = new Map([
  ['arm64', 'arm64'],
  ['x64', 'x64'],
  ['ia32', 'x86'],
]);

export function supportBundlePlatform(platform: string): string {
  return PLATFORMS.get(platform) ?? 'unknown';
}

export function supportBundleArchitecture(architecture: string): string {
  return ARCHITECTURES.get(architecture) ?? 'unknown';
}

/**
 * A project identity the bundle can carry without naming the project.
 *
 * The bundle redacts absolute paths, so an operator comparing two bundles needs
 * a stable value that is not the path itself. The digest is one-way and local.
 */
export function projectIdentityDigest(projectRoot: string): string {
  // Canonicalized the way the recovery readers canonicalize a project root, so
  // the same project reached through a symlink digests to one identity instead
  // of one per spelling of its path.
  const canonical = normalizeCanonicalProjectIdentity(
    canonicalizePathWithExistingAncestor(projectRoot),
  );
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * The collectors `psyche support-bundle` runs.
 *
 * Every one is read-only and answers a question an operator actually asks of a
 * stuck project. They report counts and allowlisted states, never paths or
 * contents: a support bundle is evidence about the installation, not a copy of
 * the user's work. Each top-level bundle field is claimed by exactly one
 * collector, because two collectors writing the same field is a collection
 * conflict that drops both.
 */
export function createSupportCollectors(
  context: SupportCollectorContext,
): SupportCollector[] {
  // One bounded read shared by every section that needs the config. Reading it
  // per collector would parse the same unbounded file more than once, which is
  // the opposite of bounded collection.
  let snapshot: Promise<ProjectPaneConfig | undefined> | undefined;
  const projectConfigOnce = (
    signal: AbortSignal,
  ): Promise<ProjectPaneConfig | undefined> => {
    snapshot ??= (async () => {
      signal.throwIfAborted();
      try {
        const { size } = await stat(projectPaneConfigPath(context.projectRoot));
        if (size > MAX_PROJECT_CONFIG_BYTES) return undefined;
      } catch {
        return undefined;
      }
      signal.throwIfAborted();
      try {
        return await readProjectPaneConfig(context.projectRoot);
      } catch {
        // Corrupt, or written by a newer Psyche. Reported as unavailable by
        // each section rather than failing the whole collection.
        return undefined;
      }
    })();
    return snapshot;
  };

  return [
    {
      name: 'provenance',
      collect: async (): Promise<SupportBundleInput> => ({
        provenance: {
          application: 'psyche-build',
          releaseVersion: context.releaseVersion,
          platform: context.platform,
          architecture: context.architecture,
        },
        // Supplied as a digest, not as an identity to be digested: the
        // absolute path never enters the bundle pipeline at all.
        project: { idDigest: projectIdentityDigest(context.projectRoot) },
      }),
    },
    {
      name: 'persistence',
      collect: async (signal): Promise<SupportBundleInput> => {
        const listing = await collectRecoveryListing(context.projectRoot, {
          limit: MAX_SCANNED_RECOVERY_FILES,
          maxFileBytes: MAX_RECOVERY_FILE_BYTES,
          signal,
        });
        const blocked = listing.markers.length > 0 || listing.quarantined.length > 0;
        return {
          persistence: {
            projectConfig: await describeProjectConfig(context.projectRoot),
            recoveryMarkers: listing.markers.length,
            quarantinedRecoveryFiles: listing.quarantined.length,
            recoveryRequired: blocked,
            // A scan that hit its bound reports partial counts; saying so keeps
            // an operator from reading them as the whole directory.
            ...(listing.truncated ? { state: 'partial' } : {}),
          },
          // Outstanding recovery state is exactly the condition an operator
          // collects a bundle to explain, so it sets the bundle's status.
          ...(blocked ? { status: 'recovery_required' as const } : {}),
        };
      },
    },
    {
      name: 'providers',
      collect: async (signal): Promise<SupportBundleInput> => {
        const survey = await surveyInstalledProviders(context.providerDefinitions, {
          pathEntries: context.providerSearchPath,
          signal,
        });
        return {
          providers: {
            // An executable on disk is not a working provider — it may fail at
            // launch, and #199 records that an agent CLI failing inside a live
            // shell still has no product classification. `count: 0` is the
            // actionable signal: nothing this application knows how to launch
            // is installed where the bundle looked.
            count: survey.found,
            items: context.providerDefinitions.length,
            capability: survey.found > 0 ? 'available' : 'missing',
            // A survey that ran out of budget reports a lower bound; saying so
            // keeps an operator from reading `missing` as a checked absence.
            ...(survey.truncated ? { state: 'partial' } : {}),
          },
        };
      },
    },
    {
      name: 'lifecycle',
      collect: async (signal): Promise<SupportBundleInput> => {
        // Pane facts come from persisted state, not from a live tmux probe: a
        // support bundle must not start processes or need a running server to
        // describe the installation it is documenting.
        const config = await projectConfigOnce(signal);
        if (!config) {
          // Unreadable or over the read bound. `persistence` still reports the
          // file as present, so the pair reads "there, unreadable" without
          // failing the whole collection.
          return { lifecycle: { state: 'unavailable' } };
        }
        return {
          lifecycle: {
            panes: Array.isArray(config.panes) ? config.panes.length : 0,
            state: config.paneLayout === undefined ? 'missing' : 'available',
          },
        };
      },
    },
    {
      name: 'updater',
      collect: async (signal): Promise<SupportBundleInput> => {
        const config = await projectConfigOnce(signal);
        if (!config) {
          return { updater: { state: 'unavailable' } };
        }
        const settings = isRecord(config.updateSettings) ? config.updateSettings : {};
        const cachedVersion = settings.cachedCurrentVersion;
        return {
          updater: {
            // `AutoUpdater` defaults an absent section to enabled and gates on
            // an explicit `false`, so anything else is effectively enabled.
            // Reporting `unknown` here would describe the config rather than
            // the behaviour, and the operator needs the behaviour.
            mode: settings.autoUpdateEnabled === false ? 'disabled' : 'enabled',
            // The one place this application compares persisted state against
            // the running version. `stale` means the cached update answer was
            // computed for a different build and no longer describes this one.
            state: typeof cachedVersion !== 'string'
              ? 'unknown'
              : (cachedVersion === context.releaseVersion ? 'current' : 'stale'),
            capability: settings.cachedHasUpdate === true ? 'available' : 'missing',
          },
        };
      },
    },
  ];
}

export interface ProviderDefinition {
  readonly id: string;
  readonly installTestCommand: string;
  readonly commonPaths: readonly string[];
}

export interface ProviderSurvey {
  found: number;
  /** Set when the candidate budget ran out before every provider was checked. */
  truncated: boolean;
}

/**
 * Counts providers whose executable is present, reading the filesystem only.
 *
 * Exported so the counting rules can be tested against synthetic definitions:
 * the real registry bakes absolute paths like `/opt/homebrew/bin/opencode` in
 * at module load, so a test that drove the collector directly would report
 * whatever happens to be installed on the machine running it.
 */
export async function surveyInstalledProviders(
  definitions: readonly ProviderDefinition[],
  options: { pathEntries: readonly string[]; signal?: AbortSignal; budget?: number },
): Promise<ProviderSurvey> {
  let budget = options.budget ?? MAX_PROVIDER_CANDIDATES;
  let found = 0;
  let truncated = false;
  // Only absolute entries: an empty or relative `PATH` entry means "the
  // current directory", which would make the answer depend on where the
  // command was run rather than on the installation.
  // Normalized before de-duplication, so `/usr/bin` and `/usr/bin/` do not
  // each spend budget on the same directory.
  const searchPath = [...new Set(options.pathEntries
    .filter((entry) => entry.length > 0 && path.isAbsolute(entry))
    .map((entry) => path.normalize(entry).replace(/(.)[\\/]+$/, '$1')))];

  for (const definition of definitions) {
    options.signal?.throwIfAborted();
    const binary = providerBinaryName(definition);
    const candidates = [
      ...definition.commonPaths.filter((candidate) => path.isAbsolute(candidate)),
      ...searchPath.map((entry) => path.join(entry, binary)),
    ];
    for (const candidate of candidates) {
      if (budget <= 0) {
        truncated = true;
        break;
      }
      budget -= 1;
      options.signal?.throwIfAborted();
      try {
        await access(candidate, fsConstants.X_OK);
        // A directory is executable too, so `access` alone would count
        // `/usr/local/bin/gemini/` as an installed provider.
        if (!(await stat(candidate)).isFile()) continue;
        found += 1;
        break;
      } catch {
        // Not at this location; try the next candidate.
      }
    }
  }

  return { found, truncated };
}

/**
 * The executable name to look for on `PATH`.
 *
 * A registry id is not always its binary: `coven-code` installs `coven` and
 * `cursor` installs `cursor-agent`. The product records the real name inside
 * `installTestCommand`, so it is read from there and the id is only a fallback.
 */
function providerBinaryName(definition: ProviderDefinition): string {
  const named = /command -v ([A-Za-z0-9._-]+)/.exec(definition.installTestCommand)?.[1];
  // `.` and `..` match the character class but name directories, not binaries.
  return named && named !== '.' && named !== '..' ? named : definition.id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Reports config presence in the bundle's closed value vocabulary rather than
 * inventing words the sanitizer would drop.
 */
async function describeProjectConfig(projectRoot: string): Promise<string> {
  const configPath = path.join(projectRoot, '.psyche', 'psyche.config.json');
  try {
    const stats = await stat(configPath);
    return stats.isFile() ? 'available' : 'unsupported';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable';
  }
}
