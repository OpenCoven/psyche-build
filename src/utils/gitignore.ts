import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';

export const PSYCHE_RUNTIME_GITIGNORE_ENTRY = '.psyche*';
const PSYCHE_RUNTIME_IGNORE_CHECK_PATHS = ['.psyche/', '.psyche-hooks/'] as const;

function normalizeGitignoreEntry(entry: string): string {
  return entry.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

function gitignoreHasEntry(content: string, entry: string): boolean {
  const normalizedEntry = normalizeGitignoreEntry(entry);

  return content.split('\n').some((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) {
      return false;
    }

    const normalizedLine = normalizeGitignoreEntry(trimmed);
    return normalizedLine === normalizedEntry;
  });
}

function getGitIgnoredEntries(root: string, entries: readonly string[]): Set<string> {
  if (entries.length === 0) {
    return new Set();
  }

  const result = spawnSync('git', ['check-ignore', '--stdin'], {
    cwd: root,
    input: `${entries.join('\n')}\n`,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  });

  if (result.status !== 0 || typeof result.stdout !== 'string') {
    return new Set();
  }

  return new Set(
    result.stdout
      .split('\n')
      .map((line) => normalizeGitignoreEntry(line))
      .filter(Boolean)
  );
}

export interface EnsurePsycheGitignoreResult {
  gitignorePath: string;
  addedEntries: string[];
}

/**
 * Ensure psyche runtime state stays out of pane branches.
 *
 * We still write to .gitignore when the path is not already ignored globally
 * because each new pane runs in a fresh git worktree that will not inherit
 * uncommitted ignore edits from the parent checkout.
 */
export function ensurePsycheRuntimeIgnored(root: string): EnsurePsycheGitignoreResult {
  const gitignorePath = path.join(root, '.gitignore');
  const existingContent = fs.existsSync(gitignorePath)
    ? fs.readFileSync(gitignorePath, 'utf8')
    : '';

  if (gitignoreHasEntry(existingContent, PSYCHE_RUNTIME_GITIGNORE_ENTRY)) {
    return { gitignorePath, addedEntries: [] };
  }

  const ignoredEntries = getGitIgnoredEntries(root, PSYCHE_RUNTIME_IGNORE_CHECK_PATHS);
  const allRuntimePathsAlreadyIgnored = PSYCHE_RUNTIME_IGNORE_CHECK_PATHS.every((entry) =>
    ignoredEntries.has(normalizeGitignoreEntry(entry))
  );

  if (allRuntimePathsAlreadyIgnored) {
    return { gitignorePath, addedEntries: [] };
  }

  const prefix = existingContent.length > 0 && !existingContent.endsWith('\n') ? '\n' : '';
  const newContent = `${existingContent}${prefix}${PSYCHE_RUNTIME_GITIGNORE_ENTRY}\n`;
  fs.writeFileSync(gitignorePath, newContent);

  return { gitignorePath, addedEntries: [PSYCHE_RUNTIME_GITIGNORE_ENTRY] };
}
