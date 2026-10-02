import * as fs from 'fs/promises';
import type { Dirent } from 'fs';
import { randomBytes } from 'crypto';
import path from 'path';
import type { PaneShellDialect } from './paneShellDialect.js';

const PROMPTS_SUBDIR = 'prompts';
const PROMPT_FILE_EXTENSION = '.txt';
const MAX_SLUG_PREFIX_LENGTH = 64;

function sanitizeSlugForFilename(slug: string): string {
  const normalized = slug
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!normalized) {
    return 'pane';
  }

  return normalized.slice(0, MAX_SLUG_PREFIX_LENGTH);
}

/** Unpredictable, so a planted file cannot anticipate the next prompt path. */
function randomSuffix(): string {
  return randomBytes(6).toString('hex');
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * fish single quotes treat `\\` and `\'` as escapes, so both must be escaped;
 * the POSIX `'\''` form would leave a trailing backslash able to eat the
 * closing quote.
 */
export function fishQuote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function getPromptsDir(projectRoot: string): string {
  return path.join(projectRoot, '.psyche', PROMPTS_SUBDIR);
}

/**
 * Creates `promptPath` exclusively with mode 0600 and writes the prompt.
 * `wx` (O_CREAT | O_EXCL) refuses anything already at the path, including a
 * symlink, dangling or not, so a planted link can never redirect the prompt.
 */
export async function createPromptFileExclusive(
  promptPath: string,
  prompt: string,
): Promise<void> {
  await fs.writeFile(promptPath, prompt, {
    encoding: 'utf-8',
    mode: 0o600,
    flag: 'wx',
  });
}

export async function writePromptFile(
  projectRoot: string,
  slug: string,
  prompt: string
): Promise<string> {
  const promptsDir = getPromptsDir(projectRoot);
  await fs.mkdir(promptsDir, { recursive: true, mode: 0o700 });

  const safeSlug = sanitizeSlugForFilename(slug);
  const filename = `${safeSlug}--${Date.now()}-${randomSuffix()}${PROMPT_FILE_EXTENSION}`;
  const promptPath = path.join(promptsDir, filename);

  await createPromptFileExclusive(promptPath, prompt);

  return promptPath;
}

export async function deletePromptFile(promptPath: string): Promise<void> {
  try {
    await fs.rm(promptPath, { force: true });
  } catch {
    // Best-effort cleanup
  }
}

export async function cleanupPromptFilesForSlug(
  projectRoot: string,
  slug: string
): Promise<number> {
  const promptsDir = getPromptsDir(projectRoot);
  const safeSlug = sanitizeSlugForFilename(slug);
  const filenamePrefix = `${safeSlug}--`;

  let entries: Dirent[];
  try {
    entries = await fs.readdir(promptsDir, { withFileTypes: true, encoding: 'utf-8' });
  } catch {
    return 0;
  }

  const removals = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(filenamePrefix))
    .map(async (entry) => {
      try {
        await fs.rm(path.join(promptsDir, entry.name), { force: true });
        return 1;
      } catch {
        return 0;
      }
    });

  const results = await Promise.all(removals);
  return results.reduce((sum, value) => sum + value, 0 as number);
}

/**
 * Shell line that reads the prompt file into `$PSYCHE_PROMPT_CONTENT` and
 * deletes the file, so the prompt never appears on the typed line or in argv
 * of the typing process. The dialect is the pane's own shell
 * (`resolvePaneShell`), never Psyche's `$SHELL`: tmux's `default-shell` can
 * differ (#508). A pane with no known dialect must not receive this line.
 */
export function buildPromptReadAndDeleteSnippet(
  promptPath: string,
  dialect: PaneShellDialect,
): string {
  if (dialect === 'fish') {
    return `set PSYCHE_PROMPT_FILE ${fishQuote(promptPath)}; set PSYCHE_PROMPT_CONTENT "$(cat "$PSYCHE_PROMPT_FILE" 2>/dev/null || true)"; rm -f "$PSYCHE_PROMPT_FILE"`;
  }
  return `PSYCHE_PROMPT_FILE=${shellQuote(promptPath)}; PSYCHE_PROMPT_CONTENT="$(cat "$PSYCHE_PROMPT_FILE" 2>/dev/null || true)"; rm -f "$PSYCHE_PROMPT_FILE"`;
}
