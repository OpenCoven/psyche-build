import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import * as fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  buildPromptReadAndDeleteSnippet,
  cleanupPromptFilesForSlug,
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
