import { mkdir, mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildCodexAgentSessionReference,
  persistPaneAgentSessionReference,
  readCodexSessionIdFromTranscript,
} from '../src/utils/agentSession.js';

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'psyche-agent-session-'));
}

describe('agent session persistence', () => {
  it('extracts the Codex session id from the transcript metadata line', async () => {
    const dir = await tempDir();
    try {
      const transcriptPath = path.join(dir, 'rollout-2026-04-27T00-00-00-example.jsonl');
      await writeFile(
        transcriptPath,
        `${JSON.stringify({ type: 'session_meta', payload: { id: 'codex-session-123' } })}\n${JSON.stringify({ type: 'message' })}\n`,
        'utf8'
      );

      await expect(readCodexSessionIdFromTranscript(transcriptPath)).resolves.toBe('codex-session-123');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('builds a Codex agent session reference from hook data', async () => {
    const dir = await tempDir();
    try {
      const transcriptPath = path.join(dir, 'rollout-2026-04-27T00-00-00-example.jsonl');
      await writeFile(
        transcriptPath,
        `${JSON.stringify({ payload: { id: 'codex-session-456' } })}\n`,
        'utf8'
      );

      const reference = await buildCodexAgentSessionReference({
        transcriptPath,
        cwd: '/repo/.psyche/worktrees/example',
        turnId: 'turn-1',
        source: 'codex-stop-hook',
        timestamp: Date.parse('2026-04-27T06:37:00.000Z'),
      });

      expect(reference).toEqual({
        agent: 'codex',
        id: 'codex-session-456',
        transcriptPath,
        cwd: '/repo/.psyche/worktrees/example',
        lastTurnId: 'turn-1',
        source: 'codex-stop-hook',
        updatedAt: '2026-04-27T06:37:00.000Z',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('persists the Codex agent session reference inside the psyche config pane', async () => {
    const dir = await tempDir();
    try {
      const projectRoot = path.join(dir, 'project');
      const configPath = path.join(projectRoot, '.psyche', 'psyche.config.json');
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({
          projectName: 'repo',
          projectRoot,
          panes: [
            { id: 'psyche-1', slug: 'feature-a', prompt: 'hi', paneId: '%1', agent: 'codex' },
          ],
          settings: {},
          lastUpdated: '2026-04-27T00:00:00.000Z',
        }, null, 2),
        'utf8'
      );

      await persistPaneAgentSessionReference(configPath, 'psyche-1', {
        agent: 'codex',
        id: 'codex-session-789',
        transcriptPath: '/tmp/codex-session.jsonl',
        updatedAt: '2026-04-27T06:37:00.000Z',
      });

      const saved = JSON.parse(await readFile(configPath, 'utf8'));
      expect(saved.panes[0].agentSession).toEqual({
        agent: 'codex',
        id: 'codex-session-789',
        transcriptPath: '/tmp/codex-session.jsonl',
        updatedAt: '2026-04-27T06:37:00.000Z',
      });
      expect(saved.lastUpdated).not.toBe('2026-04-27T00:00:00.000Z');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
