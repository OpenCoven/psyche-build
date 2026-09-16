import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { collectRecoveryListing } from './recoveryReport.js';
import type { SupportBundleInput, SupportCollector } from './supportBundle.js';

export interface SupportCollectorContext {
  readonly projectRoot: string;
  readonly releaseVersion: string;
  readonly platform: string;
  readonly architecture: string;
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
  return createHash('sha256').update(path.resolve(projectRoot), 'utf8').digest('hex');
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
      collect: async (): Promise<SupportBundleInput> => {
        const listing = await collectRecoveryListing(context.projectRoot);
        const blocked = listing.markers.length > 0 || listing.quarantined.length > 0;
        return {
          persistence: {
            projectConfig: await describeProjectConfig(context.projectRoot),
            recoveryMarkers: listing.markers.length,
            quarantinedRecoveryFiles: listing.quarantined.length,
            recoveryRequired: blocked,
          },
          // Outstanding recovery state is exactly the condition an operator
          // collects a bundle to explain, so it sets the bundle's status.
          ...(blocked ? { status: 'recovery_required' as const } : {}),
        };
      },
    },
  ];
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
