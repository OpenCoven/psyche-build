import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, statSync } from 'fs';
import * as fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  launchMergeConflictAgent,
  type MergeConflictAgentLaunchDeps,
} from '../src/utils/mergeConflictAgentLaunch.js';
import { getPromptsDir } from '../src/utils/promptStore.js';

const PROMPT = `Fix conflicts in a.ts; don't "break" \`it\` $HOME 'quoted' SENTINEL-PROMPT-7f3a`;

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'psyche-merge-launch-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

interface ExecCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly promptFileAtExec: { readonly content: string; readonly mode: number } | null;
}

/** Records each exec without running anything; never launches a real agent. */
function recordingExec(failFor: ReadonlySet<string> = new Set()) {
  const calls: ExecCall[] = [];
  const execFileSync = vi.fn((file: string, args: readonly string[], _options: { cwd: string; stdio: 'inherit' }) => {
    const line = args[args.length - 1] ?? '';
    const match = /PSYCHE_PROMPT_FILE='([^']+)'/u.exec(line);
    const promptPath = match?.[1];
    calls.push({
      file,
      args: [...args],
      promptFileAtExec: promptPath && existsSync(promptPath)
        ? { content: readFileSync(promptPath, 'utf-8'), mode: statSync(promptPath).mode & 0o777 }
        : null,
    });
    const agent = line.split('; ').pop()?.split(' ')[0] ?? '';
    if (failFor.has(agent)) throw new Error(`${agent} exited 1`);
    return Buffer.alloc(0);
  });
  return { calls, execFileSync };
}

function expectPromptNeverInArgv(execFileSync: ReturnType<typeof vi.fn>): void {
  expect(execFileSync).toHaveBeenCalled();
  for (const call of execFileSync.mock.calls) {
    const serialized = JSON.stringify(call.slice(0, 2));
    expect(serialized).not.toContain('SENTINEL-PROMPT-7f3a');
    expect(serialized).not.toContain('Fix conflicts');
  }
}

describe('launchMergeConflictAgent', () => {
  it('delivers the prompt through a 0600 read-and-delete file, never argv', async () => {
    const cwd = await tempRoot();
    const { calls, execFileSync } = recordingExec();
    const reportSkipped = vi.fn();

    const result = await launchMergeConflictAgent({
      prompt: PROMPT,
      cwd,
      slug: 'feature-x-merge',
      permissionMode: 'acceptEdits',
      deps: { execFileSync, reportSkipped } satisfies MergeConflictAgentLaunchDeps,
    });

    expect(result).toEqual({ launchedAgent: 'claude', initialPromptSkipped: null });
    expectPromptNeverInArgv(execFileSync);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.file).toBe('/bin/sh');
    expect(call.args[0]).toBe('-c');
    expect(call.args[1]).toMatch(/^PSYCHE_PROMPT_FILE='[^']+'; PSYCHE_PROMPT_CONTENT="\$\(cat /u);
    expect(call.args[1]).toContain('rm -f "$PSYCHE_PROMPT_FILE"; claude --permission-mode acceptEdits "$PSYCHE_PROMPT_CONTENT"');
    expect(call.promptFileAtExec).toEqual({ content: PROMPT, mode: 0o600 });
    expect(execFileSync.mock.calls[0][2]).toMatchObject({ cwd, stdio: 'inherit' });
    expect(reportSkipped).not.toHaveBeenCalled();
    // Removed even though the (recorded) shell never ran the snippet.
    expect(await fs.readdir(getPromptsDir(cwd))).toEqual([]);
  });

  it('falls back to opencode with a fresh prompt file when claude fails', async () => {
    const cwd = await tempRoot();
    const { calls, execFileSync } = recordingExec(new Set(['claude']));

    const result = await launchMergeConflictAgent({
      prompt: PROMPT,
      cwd,
      slug: 'feature-x-merge',
      deps: { execFileSync, reportSkipped: vi.fn() },
    });

    expect(result).toEqual({ launchedAgent: 'opencode', initialPromptSkipped: null });
    expectPromptNeverInArgv(execFileSync);
    expect(calls).toHaveLength(2);
    expect(calls[1].args[1]).toContain('opencode --prompt "$PSYCHE_PROMPT_CONTENT"');
    expect(calls[1].promptFileAtExec).toEqual({ content: PROMPT, mode: 0o600 });
    expect(await fs.readdir(getPromptsDir(cwd))).toEqual([]);
  });

  it('launches bare and reports prompt_file_unwritable when the file cannot be written', async () => {
    const cwd = await tempRoot();
    const { calls, execFileSync } = recordingExec();
    const reportSkipped = vi.fn();

    const result = await launchMergeConflictAgent({
      prompt: PROMPT,
      cwd,
      slug: 'feature-x-merge',
      permissionMode: 'plan',
      deps: {
        execFileSync,
        reportSkipped,
        writePromptFile: async () => {
          throw new Error('EACCES');
        },
      },
    });

    expect(result).toEqual({ launchedAgent: 'claude', initialPromptSkipped: 'prompt_file_unwritable' });
    expectPromptNeverInArgv(execFileSync);
    expect(calls[0].args).toEqual(['-c', 'claude --permission-mode plan']);
    expect(reportSkipped).toHaveBeenCalledTimes(1);
    expect(reportSkipped).toHaveBeenCalledWith('claude', 'prompt_file_unwritable');
  });

  it('writes no prompt file and launches bare when the shell has no known dialect', async () => {
    const cwd = await tempRoot();
    const { calls, execFileSync } = recordingExec();
    const reportSkipped = vi.fn();
    const writePromptFile = vi.fn();

    const result = await launchMergeConflictAgent({
      prompt: PROMPT,
      cwd,
      slug: 'feature-x-merge',
      shellPath: '/usr/local/bin/nu',
      deps: { execFileSync, reportSkipped, writePromptFile },
    });

    expect(result).toEqual({ launchedAgent: 'claude', initialPromptSkipped: 'unrecognized_shell' });
    expectPromptNeverInArgv(execFileSync);
    expect(writePromptFile).not.toHaveBeenCalled();
    expect(calls[0]).toMatchObject({ file: '/usr/local/bin/nu', args: ['-c', 'claude'] });
    expect(reportSkipped).toHaveBeenCalledWith('claude', 'unrecognized_shell');
  });

  it('reports no launch when every agent fails, and leaves no prompt file behind', async () => {
    const cwd = await tempRoot();
    const { execFileSync } = recordingExec(new Set(['claude', 'opencode']));

    const result = await launchMergeConflictAgent({
      prompt: PROMPT,
      cwd,
      slug: 'feature-x-merge',
      deps: { execFileSync, reportSkipped: vi.fn() },
    });

    expect(result.launchedAgent).toBeNull();
    expectPromptNeverInArgv(execFileSync);
    expect(await fs.readdir(getPromptsDir(cwd))).toEqual([]);
  });
});

describe('MergePane agent launch', () => {
  // The component must hand the prompt to the file transport, never build a
  // command line around it (#518).
  it('routes the conflict prompt through launchMergeConflictAgent', () => {
    const source = readFileSync(
      path.join(__dirname, '..', 'src', 'components', 'panes', 'MergePane.tsx'),
      'utf-8',
    );
    expect(source).toContain('launchMergeConflictAgent(');
    expect(source).not.toMatch(/escapedPrompt/u);
    expect(source).not.toMatch(/exec(?:File)?Sync\(\s*[`'"](?:claude|opencode)/u);
  });
});
