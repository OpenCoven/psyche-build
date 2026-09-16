import path from 'node:path';
import {
  collectSupportBundle,
  serializeSupportBundle,
  supportBundleDigest,
  SUPPORT_BUNDLE_LIMITS,
  type SupportBundle,
} from './supportBundle.js';
import {
  createSupportCollectors,
  supportBundleArchitecture,
  supportBundlePlatform,
} from './supportBundleCollectors.js';
import {
  supportBundleDirectory,
  supportBundleFilename,
  writeSupportBundleFile,
  type WrittenSupportBundle,
} from './supportBundleStore.js';

export interface SupportBundleCliOptions {
  projectRoot: string;
  releaseVersion: string;
  platform: string;
  architecture: string;
  /** Print the bundle to stdout instead of writing it into the project. */
  toStdout: boolean;
  outPath?: string;
}

export interface SupportBundleCliResult {
  text: string;
  exitCode: number;
  bundle?: SupportBundle;
  written?: WrittenSupportBundle;
}

export interface SupportBundleCliParse {
  options?: SupportBundleCliOptions;
  error?: string;
}

/**
 * `psyche support-bundle` — the first production surface over the v1 bundle
 * contract, which until now had no collector wiring, persistence, or CLI.
 *
 * The command is read-only with respect to application state. It collects a
 * bounded, redacted snapshot and either writes it into the project's runtime
 * directory or prints it, so an operator can attach evidence to a report
 * without hand-assembling one — or pasting something unredacted.
 */
export function parseSupportBundleArgs(
  argv: readonly string[],
  defaults: { cwd: string; releaseVersion: string; platform: string; architecture: string },
): SupportBundleCliParse {
  let projectRoot = defaults.cwd;
  let toStdout = false;
  let outPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--stdout') {
      toStdout = true;
      continue;
    }
    if (arg === '--project' || arg === '--out') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        return { error: `psyche support-bundle ${arg} requires a path` };
      }
      if (arg === '--project') projectRoot = value;
      else outPath = value;
      index += 1;
      continue;
    }
    return { error: `Unsupported psyche support-bundle option: ${arg}` };
  }

  if (toStdout && outPath) {
    return { error: 'psyche support-bundle cannot combine --stdout with --out' };
  }

  return {
    options: {
      projectRoot: path.resolve(projectRoot),
      releaseVersion: defaults.releaseVersion,
      platform: supportBundlePlatform(defaults.platform),
      architecture: supportBundleArchitecture(defaults.architecture),
      toStdout,
      outPath,
    },
  };
}

export async function runSupportBundle(
  options: SupportBundleCliOptions,
): Promise<SupportBundleCliResult> {
  const bundle = await collectSupportBundle(createSupportCollectors({
    projectRoot: options.projectRoot,
    releaseVersion: options.releaseVersion,
    platform: options.platform,
    architecture: options.architecture,
  }));
  const serialized = serializeSupportBundle(bundle);
  const digest = supportBundleDigest(bundle);

  if (options.toStdout) {
    return { text: serialized, exitCode: 0, bundle };
  }

  // `--out` is a single-file export to a directory this command does not own,
  // so retention is disabled there: pruning an arbitrary directory could remove
  // another project's or another tool's files.
  const target = options.outPath
    ? {
      directory: path.dirname(path.resolve(options.outPath)),
      filename: path.basename(path.resolve(options.outPath)),
      retain: false,
    }
    : {
      directory: supportBundleDirectory(options.projectRoot),
      filename: supportBundleFilename(bundle.generatedAt, digest),
      retain: true,
    };

  let written: WrittenSupportBundle;
  try {
    written = await writeSupportBundleFile({ ...target, serialized });
  } catch (error) {
    return {
      text: [
        `Could not write the support bundle to ${path.join(target.directory, target.filename)}.`,
        `  reason: ${error instanceof Error ? error.message : String(error)}`,
        '  The bundle was collected successfully; rerun with --stdout to capture it.',
      ].join('\n'),
      exitCode: 1,
      bundle,
    };
  }

  return { text: formatSupportBundleSummary(bundle, digest, written), exitCode: 0, bundle, written };
}

export function formatSupportBundleSummary(
  bundle: SupportBundle,
  digest: string,
  written: WrittenSupportBundle,
): string {
  const redaction = bundle.redaction;
  const lines = [
    `Wrote ${written.path}`,
    `  schema: ${bundle.schema} v${bundle.version}`,
    `  status: ${bundle.status}`,
    `  digest: ${digest}`,
    `  size: ${written.bytes} bytes (cap ${SUPPORT_BUNDLE_LIMITS.maxBundleBytes})`,
    `  redacted fields: ${redaction.redactedFields}; omitted fields: ${redaction.omittedFields}`,
  ];
  const categories = Object.entries(redaction.categories)
    .sort(([left], [right]) => left.localeCompare(right));
  if (categories.length > 0) {
    lines.push(`  redaction categories: ${
      categories.map(([name, count]) => `${name}×${count}`).join(', ')
    }`);
  }
  if (bundle.errors.length > 0) {
    lines.push(`  collector errors: ${bundle.errors.map((error) => `${error.collector}/${error.code}`).join(', ')}`);
  }
  if (written.removed.length > 0) {
    lines.push(`  pruned ${written.removed.length} older bundle${written.removed.length === 1 ? '' : 's'}`);
  }
  if (written.retentionFailures > 0) {
    lines.push(
      `  retention left ${written.retentionFailures} candidate${written.retentionFailures === 1 ? '' : 's'} in place`,
      '  Older bundles remain beyond the retention limit; remove them manually if that matters.',
    );
  }
  lines.push(
    '  The bundle is redacted but not public: it identifies your platform, release, and project digest.',
    '  Review it before attaching it to a report.',
  );
  return lines.join('\n');
}
