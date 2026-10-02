import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import * as fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  buildPromptReadAndDeleteSnippet,
  cleanupPromptFilesForSlug,
  createPromptFileExclusive,
  getPromptsDir,
  shellQuote,
  writePromptFile,
} from '../src/utils/promptStore.js';

async function makeTempProjectRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'psyche-prompt-store-'));
}

describe('promptStore', () => {
  it('writes prompt files under .psyche/prompts', async () => {
    const projectRoot = await makeTempProjectRoot();
    const promptPath = await writePromptFile(projectRoot, 'feature/test', 'hello world');

    expect(promptPath.startsWith(getPromptsDir(projectRoot))).toBe(true);

    const written = await fs.readFile(promptPath, 'utf-8');
    expect(written).toBe('hello world');
  });

  it('cleans up only files for the requested slug', async () => {
    const projectRoot = await makeTempProjectRoot();

    const slugAPath = await writePromptFile(projectRoot, 'feature-a', 'a');
    const slugBPath = await writePromptFile(projectRoot, 'feature-b', 'b');

    const removed = await cleanupPromptFilesForSlug(projectRoot, 'feature-a');
    expect(removed).toBe(1);

    await expect(fs.access(slugAPath)).rejects.toThrow();
    await expect(fs.readFile(slugBPath, 'utf-8')).resolves.toBe('b');
  });

  it('builds a shell snippet that reads and deletes the prompt file', () => {
    const quoted = shellQuote(`/tmp/o'clock`);
    expect(quoted).toBe(`'/tmp/o'\\''clock'`);

    const snippet = buildPromptReadAndDeleteSnippet('/tmp/psyche prompt.txt', 'posix');
    expect(snippet).toContain('PSYCHE_PROMPT_FILE=');
    expect(snippet).toContain('cat "$PSYCHE_PROMPT_FILE"');
    expect(snippet).toContain('rm -f "$PSYCHE_PROMPT_FILE"');
  });
});

/** Absolute path of a shell on this host, or null when it is not installed. */
function findShell(name: string): string | null {
  for (const dir of ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin']) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

describe('buildPromptReadAndDeleteSnippet dialects (#508)', () => {
  const savedShell = process.env.SHELL;
  afterEach(() => {
    process.env.SHELL = savedShell;
  });

  // The pane's dialect decides, never Psyche's own $SHELL.
  it('emits POSIX assignments for a posix pane even when $SHELL is fish', () => {
    process.env.SHELL = '/opt/homebrew/bin/fish';
    const snippet = buildPromptReadAndDeleteSnippet('/tmp/p.txt', 'posix');
    expect(snippet.startsWith(`PSYCHE_PROMPT_FILE='/tmp/p.txt'; `)).toBe(true);
    expect(snippet).not.toMatch(/(^|; )set /u);
  });

  it('emits fish `set` for a fish pane even when $SHELL is zsh', () => {
    process.env.SHELL = '/bin/zsh';
    const snippet = buildPromptReadAndDeleteSnippet('/tmp/p.txt', 'fish');
    expect(snippet.startsWith(`set PSYCHE_PROMPT_FILE '/tmp/p.txt'; `)).toBe(true);
    expect(snippet).not.toContain('PSYCHE_PROMPT_FILE=');
  });

  // In fish single quotes, `\\` and `\'` are escapes: a path containing a
  // backslash must have it doubled or the path (or the quoting) breaks.
  it('escapes backslashes and quotes in the path for fish', () => {
    const snippet = buildPromptReadAndDeleteSnippet(`/tmp/a\\b'c\\`, 'fish');
    expect(snippet.startsWith(`set PSYCHE_PROMPT_FILE '/tmp/a\\\\b\\'c\\\\'; `)).toBe(true);
  });

  it('keeps POSIX single-quoting unchanged for backslashes', () => {
    const snippet = buildPromptReadAndDeleteSnippet(`/tmp/a\\b`, 'posix');
    expect(snippet.startsWith(`PSYCHE_PROMPT_FILE='/tmp/a\\b'; `)).toBe(true);
  });

  // Run the real bootstrap (no agent) to prove it reads the prompt and deletes
  // the file in each shell this host has.
  const prompt = `multi-line\n"quoted" $HOME \`tick\` it's ;|&`;
  const posixShells = ['sh', 'bash', 'zsh', 'dash', 'ksh']
    .map((name) => [name, findShell(name)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== null);
  it.each(posixShells)('reads then deletes the prompt file in %s', async (_name, shell) => {
    const projectRoot = await makeTempProjectRoot();
    const promptPath = await writePromptFile(projectRoot, 'dialect', prompt);
    const snippet = buildPromptReadAndDeleteSnippet(promptPath, 'posix');
    const output = execFileSync(shell, ['-c', `${snippet}; printf '%s' "$PSYCHE_PROMPT_CONTENT"`], {
      encoding: 'utf8',
    });
    expect(output).toBe(prompt);
    expect(existsSync(promptPath)).toBe(false);
  });

  const fish = findShell('fish');
  it.skipIf(!fish)('reads then deletes the prompt file in fish', async () => {
    const projectRoot = await makeTempProjectRoot();
    const promptPath = await writePromptFile(projectRoot, 'dialect', prompt);
    const snippet = buildPromptReadAndDeleteSnippet(promptPath, 'fish');
    const output = execFileSync(fish!, ['-c', `${snippet}; printf '%s' "$PSYCHE_PROMPT_CONTENT"`], {
      encoding: 'utf8',
    });
    expect(output).toBe(prompt);
    expect(existsSync(promptPath)).toBe(false);
  });
});

describe('promptStore exclusive creation', () => {
  it('creates the prompt file 0600 inside a 0700 prompts directory', async () => {
    const projectRoot = await makeTempProjectRoot();
    const promptPath = await writePromptFile(projectRoot, 'feature/mode', 'secret');
    expect((await fs.stat(promptPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(getPromptsDir(projectRoot))).mode & 0o777).toBe(0o700);
    expect(path.basename(promptPath)).toMatch(/^feature-mode--\d+-[0-9a-f]{12}\.txt$/u);
  });

  it('refuses a pre-placed symlink at the target instead of following it', async () => {
    const projectRoot = await makeTempProjectRoot();
    const promptsDir = getPromptsDir(projectRoot);
    await fs.mkdir(promptsDir, { recursive: true });
    const victim = path.join(projectRoot, 'victim.txt');
    await fs.writeFile(victim, 'untouched');
    const target = path.join(promptsDir, 'planted.txt');
    await fs.symlink(victim, target);

    await expect(createPromptFileExclusive(target, 'secret')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(victim, 'utf-8')).toBe('untouched');
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
  });

  it('refuses a dangling symlink at the target instead of creating through it', async () => {
    const projectRoot = await makeTempProjectRoot();
    const promptsDir = getPromptsDir(projectRoot);
    await fs.mkdir(promptsDir, { recursive: true });
    const victim = path.join(projectRoot, 'created-through-link.txt');
    const target = path.join(promptsDir, 'dangling.txt');
    await fs.symlink(victim, target);

    await expect(createPromptFileExclusive(target, 'secret')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(existsSync(victim)).toBe(false);
  });

  it('refuses an existing file at the target and leaves it unchanged', async () => {
    const projectRoot = await makeTempProjectRoot();
    const promptsDir = getPromptsDir(projectRoot);
    await fs.mkdir(promptsDir, { recursive: true });
    const target = path.join(promptsDir, 'existing.txt');
    await fs.writeFile(target, 'original', { mode: 0o644 });

    await expect(createPromptFileExclusive(target, 'secret')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(target, 'utf-8')).toBe('original');
  });

  it('creates a fresh target with mode 0600', async () => {
    const projectRoot = await makeTempProjectRoot();
    const promptsDir = getPromptsDir(projectRoot);
    await fs.mkdir(promptsDir, { recursive: true });
    const target = path.join(promptsDir, 'fresh.txt');
    await createPromptFileExclusive(target, 'secret');
    expect(await fs.readFile(target, 'utf-8')).toBe('secret');
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
  });
});
