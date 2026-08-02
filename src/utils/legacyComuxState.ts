import fs from 'node:fs';
import path from 'node:path';

/**
 * Detection for state left behind by comux, the name this tool shipped under
 * before it became Psyche Build.
 *
 * Psyche Build is a clean break: nothing here reads, writes, or migrates the
 * old locations. Their contents are not understood and not carried forward.
 * This module exists purely so the break is *loud* rather than silent — the
 * failure mode it prevents is a user whose `.comux-hooks/` scripts simply stop
 * firing, with no error, because the hook search path no longer includes them.
 */

export interface LegacyComuxFinding {
  /** Absolute path that still exists. */
  path: string;
  /** What the user loses if they do nothing. */
  consequence: string;
}

export interface DetectLegacyComuxStateOptions {
  projectRoot: string;
  homeDir?: string;
  /** Injectable for tests. */
  exists?: (candidate: string) => boolean;
}

const defaultExists = (candidate: string): boolean => {
  try {
    return fs.existsSync(candidate);
  } catch {
    return false;
  }
};

export function detectLegacyComuxState(
  options: DetectLegacyComuxStateOptions,
): LegacyComuxFinding[] {
  const exists = options.exists ?? defaultExists;
  const { projectRoot } = options;
  const homeDir = options.homeDir;

  const candidates: LegacyComuxFinding[] = [
    {
      path: path.join(projectRoot, '.comux-hooks'),
      consequence:
        'lifecycle hooks in here no longer run — Psyche Build reads .psyche-hooks/',
    },
    {
      path: path.join(projectRoot, '.comux'),
      consequence:
        'pane and worktree records in here are not loaded — Psyche Build uses .psyche/',
    },
  ];

  if (homeDir) {
    candidates.push(
      {
        path: path.join(homeDir, '.comux'),
        consequence: 'global hooks and onboarding state are not carried over',
      },
      {
        path: path.join(homeDir, '.comux.global.json'),
        consequence: 'global settings are not carried over',
      },
    );
  }

  // Only report the new location's absence as a problem. If the user has
  // already set up the psyche equivalent, they have migrated and do not need
  // to hear about it again.
  return candidates.filter((candidate) => {
    if (!exists(candidate.path)) return false;
    const replacement = candidate.path === path.join(projectRoot, '.comux')
      ? path.join(projectRoot, '.psyche', 'psyche.config.json')
      : candidate.path.replace(/\.comux/, '.psyche');
    return !exists(replacement);
  });
}

export function formatLegacyComuxWarning(findings: LegacyComuxFinding[]): string {
  if (findings.length === 0) return '';

  const lines = [
    'Found leftover comux state. Psyche Build does not read it.',
    '',
  ];
  for (const finding of findings) {
    lines.push(`  ${finding.path}`);
    lines.push(`    ${finding.consequence}`);
  }
  lines.push('');
  lines.push('To carry hooks forward, rename the directory and the variables inside:');
  lines.push('');
  lines.push('  mv .comux-hooks .psyche-hooks');
  lines.push("  grep -rl COMUX_ .psyche-hooks | xargs sed -i '' 's/COMUX_/PSYCHE_/g'");
  lines.push('');
  lines.push('Everything else can be deleted once you no longer need it.');

  return lines.join('\n');
}
